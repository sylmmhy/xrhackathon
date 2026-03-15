import * as THREE from "three";
import {
  DistanceGrabbable,
  Interactable,
  MovementMode,
  PhysicsBody,
  PhysicsShape,
  PhysicsShapeType,
  PhysicsState,
  World,
} from "@iwsdk/core";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const gltfLoader = new GLTFLoader();
const POLL_INTERVAL_MS = 3000;

// GLB cache: fetch + parse once, clone for each spawn
interface CachedGLB {
  scene: THREE.Group;
  scaledSize: THREE.Vector3;
}
const glbCache = new Map<string, Promise<CachedGLB>>();

async function loadAndCacheGLB(glbUrl: string): Promise<CachedGLB> {
  const resp = await fetch(glbUrl, {
    headers: { "ngrok-skip-browser-warning": "true" },
  });
  if (!resp.ok) throw new Error(`GLB fetch failed (${resp.status})`);
  const contentType = resp.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    throw new Error(`GLB fetch returned HTML instead of binary (ngrok interstitial?)`);
  }
  const blob = await resp.blob();
  const blobUrl = URL.createObjectURL(blob);
  const gltf = await gltfLoader.loadAsync(blobUrl);
  URL.revokeObjectURL(blobUrl);
  const scene = gltf.scene;

  // Auto-scale to ~1m
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim > 0) {
    scene.scale.multiplyScalar(1.0 / maxDim);
  }

  // Disable frustum culling
  scene.traverse((child) => { child.frustumCulled = false; });

  // Compute bounding box after scaling for physics shape
  const scaledBox = new THREE.Box3().setFromObject(scene);
  const scaledSize = scaledBox.getSize(new THREE.Vector3());

  console.log("[objectLoader] Cached GLB:", glbUrl);
  return { scene, scaledSize };
}

function getCachedGLB(glbUrl: string): Promise<CachedGLB> {
  let cached = glbCache.get(glbUrl);
  if (!cached) {
    cached = loadAndCacheGLB(glbUrl);
    glbCache.set(glbUrl, cached);
  }
  return cached;
}

/**
 * Load a GLB from URL and spawn it as a grabbable entity in the world.
 * Uses a cache so repeated spawns of the same model skip fetch/parse.
 */
export async function spawnGLBFromUrl(
  world: World,
  glbUrl: string,
  position?: THREE.Vector3,
): Promise<void> {
  const { scene, scaledSize } = await getCachedGLB(glbUrl);
  const model = scene.clone(true);

  // Render toys on top of Gaussian splats (SparkRenderer uses renderOrder -10).
  // A positive renderOrder ensures toys draw after splats; the Z buffer
  // still handles correct occlusion for objects genuinely behind splats.
  model.traverse((child) => {
    child.renderOrder = 100;
  });

  // Default position: 2m in front of camera at eye height
  if (position) {
    model.position.copy(position);
  } else {
    const cam = world.camera;
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    dir.y = 0;
    dir.normalize();
    model.position.copy(cam.position).addScaledVector(dir, 2);
  }

  world
    .createTransformEntity(model)
    .addComponent(Interactable)
    .addComponent(DistanceGrabbable, {
      movementMode: MovementMode.MoveAtSource,
      translate: true,
      rotate: true,
      scale: false,
    })
    .addComponent(PhysicsBody, {
      state: PhysicsState.Dynamic,
      linearDamping: 0.4,
      angularDamping: 0.3,
      gravityFactor: 0.8,
    })
    .addComponent(PhysicsShape, {
      shape: PhysicsShapeType.Box,
      dimensions: [scaledSize.x, scaledSize.y, scaledSize.z],
      density: 0.3,
      friction: 0.5,
      restitution: 0.5,
    });

  console.log("[objectLoader] Spawned GLB (cached):", glbUrl);
}

/**
 * Upload an image to the backend, poll for completion, then spawn the GLB.
 */
export async function uploadImageAndSpawn(
  world: World,
  imageFile: File,
  worldId: string,
  apiBase: string,
  onStatus?: (msg: string) => void,
): Promise<void> {
  onStatus?.("Uploading image...");

  const formData = new FormData();
  formData.append("image", imageFile);

  const createResp = await fetch(`${apiBase}/api/world/${worldId}/objects`, {
    method: "POST",
    body: formData,
  });

  if (!createResp.ok) {
    const err = await createResp.json().catch(() => ({}));
    throw new Error(err.error || `Upload failed (${createResp.status})`);
  }

  const { object_id } = await createResp.json();
  onStatus?.("Generating 3D model...");

  // Poll for completion
  while (true) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const statusResp = await fetch(
      `${apiBase}/api/world/${worldId}/objects/${object_id}/status`,
    );
    if (!statusResp.ok) {
      throw new Error(`Status check failed (${statusResp.status})`);
    }

    const obj = await statusResp.json();

    if (obj.status === "succeeded" && obj.glb_url) {
      onStatus?.("Loading 3D model...");
      const fullGlbUrl = `${apiBase}${obj.glb_url}`;
      await spawnGLBFromUrl(world, fullGlbUrl);
      return;
    }

    if (obj.status === "failed") {
      throw new Error(obj.error || "3D generation failed");
    }

    onStatus?.(`Generating 3D model... ${obj.progress}%`);
  }
}

/**
 * Load all existing objects for a world (for page refresh persistence).
 */
export async function loadExistingObjects(
  world: World,
  worldId: string,
  apiBase: string,
): Promise<void> {
  try {
    const resp = await fetch(`${apiBase}/api/world/${worldId}/objects`);
    if (!resp.ok) return;

    const { objects } = await resp.json();
    if (!objects?.length) return;

    for (const obj of objects) {
      if (obj.status === "succeeded" && obj.glb_url) {
        const fullGlbUrl = `${apiBase}${obj.glb_url}`;
        await spawnGLBFromUrl(world, fullGlbUrl);
      }
    }

    console.log(
      "[objectLoader] Loaded %d existing objects",
      objects.filter((o: { status: string }) => o.status === "succeeded").length,
    );
  } catch (err) {
    console.warn("[objectLoader] Failed to load existing objects:", err);
  }
}
