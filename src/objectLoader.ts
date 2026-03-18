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

// Shared blob shadow texture (created once, reused for all objects)
let blobShadowTexture: THREE.Texture | null = null;
function getBlobTexture(): THREE.Texture {
  if (blobShadowTexture) return blobShadowTexture;
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, "rgba(0,0,0,1)");
  gradient.addColorStop(0.3, "rgba(0,0,0,0.7)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  blobShadowTexture = new THREE.CanvasTexture(canvas);
  return blobShadowTexture;
}

// Track all spawned entities + shadows for world-switch cleanup
const spawnedEntities: { destroy(): void }[] = [];
const spawnedShadows: THREE.Mesh[] = [];

export function clearSpawnedObjects(scene: THREE.Scene): void {
  for (const entity of spawnedEntities) {
    try { entity.destroy(); } catch {}
  }
  for (const shadow of spawnedShadows) {
    if (shadow.parent) shadow.parent.remove(shadow);
    shadow.geometry.dispose();
    (shadow.material as THREE.Material).dispose();
  }
  spawnedEntities.length = 0;
  spawnedShadows.length = 0;
}

function attachBlobShadow(model: THREE.Object3D, scene: THREE.Scene, footprint: number): void {
  const MAX_HEIGHT = 0.4;
  const GROUND_Y = 0.06;
  const shadowMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      map: getBlobTexture(),
      transparent: true,
      depthWrite: false,
      depthTest: false,
      opacity: 0,
    }),
  );
  shadowMesh.renderOrder = 2; // render after splat (default 0) so it's visible
  scene.add(shadowMesh);
  spawnedShadows.push(shadowMesh);

  const worldPos = new THREE.Vector3();

  const mat = shadowMesh.material as THREE.MeshBasicMaterial;
  shadowMesh.onBeforeRender = () => {
    model.getWorldPosition(worldPos);
    const height = Math.max(0, worldPos.y);
    const t = Math.min(height / MAX_HEIGHT, 1);
    mat.opacity = (1 - t) * 0.75;
    shadowMesh.scale.setScalar(footprint * (0.7 + t * 0.5));
    shadowMesh.position.set(worldPos.x, GROUND_Y, worldPos.z);
  };
}

/**
 * Load a GLB from URL and spawn it as a grabbable entity in the world.
 * Auto-scales to ~0.5m and places at the given position (default: 2m in front of camera).
 */
export async function spawnGLBFromUrl(
  world: World,
  glbUrl: string,
  position?: THREE.Vector3,
): Promise<void> {
  // Fetch via fetch() then load from blob URL (handles ngrok/CORS)
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
  const model = gltf.scene;

  // Auto-scale to ~1m
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim > 0) {
    const scale = 1.0 / maxDim;
    model.scale.multiplyScalar(scale);
  }

  model.traverse((child) => {
    child.frustumCulled = false;
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

  // Compute bounding box after scaling for physics shape dimensions
  const scaledBox = new THREE.Box3().setFromObject(model);
  const scaledSize = scaledBox.getSize(new THREE.Vector3());

  const entity = world
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

  spawnedEntities.push(entity);

  // Blob shadow: use XZ footprint of the scaled model
  const footprint = Math.max(scaledSize.x, scaledSize.z);
  attachBlobShadow(model, world.scene, footprint);

  console.log("[objectLoader] Spawned GLB:", glbUrl);
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
