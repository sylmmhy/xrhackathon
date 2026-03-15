import * as THREE from "three";
import {
  Interactable,
  World,
} from "@iwsdk/core";
import { spawnGLBFromUrl } from "./objectLoader.js";

const DEFAULT_GLB = "./SM_Aligator.glb";
const RAIN_COUNT = 15;
const COOLDOWN_MS = 8000;

async function rainObjects(world: World, count: number) {
  const cam = world.camera;
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  forward.y = 0;
  forward.normalize();
  const center = cam.position.clone().addScaledVector(forward, 3);

  for (let i = 0; i < count; i++) {
    const pos = new THREE.Vector3(
      center.x + (Math.random() - 0.5) * 6,
      8 + Math.random() * 3,
      center.z + (Math.random() - 0.5) * 6,
    );
    spawnGLBFromUrl(world, DEFAULT_GLB, pos).catch((err) =>
      console.warn("[vrRainButton] spawn failed:", err),
    );
    if (i < count - 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

export function createVRRainButton(world: World): void {
  // --- Anchor that follows the camera ---
  const anchor = new THREE.Group();
  world.scene.add(anchor);

  // --- Button mesh ---
  const btnGroup = new THREE.Group();

  // Base sphere
  const sphereMat = new THREE.MeshStandardMaterial({
    color: 0x7b2ff2,
    emissive: 0x7b2ff2,
    emissiveIntensity: 0.4,
    roughness: 0.3,
    metalness: 0.1,
  });
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.08, 32, 32),
    sphereMat,
  );
  btnGroup.add(sphere);

  // Rain drops
  const dropGeo = new THREE.CylinderGeometry(0.006, 0.006, 0.03, 6);
  const dropMat = new THREE.MeshStandardMaterial({
    color: 0xfbbf24,
    emissive: 0xfbbf24,
    emissiveIntensity: 0.6,
  });
  for (const [x, z] of [[-0.02, 0.01], [0, -0.01], [0.02, 0.01]]) {
    const drop = new THREE.Mesh(dropGeo, dropMat);
    drop.position.set(x, -0.02, z);
    btnGroup.add(drop);
  }

  // Cloud puffs
  const cloudMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveIntensity: 0.2,
  });
  for (const [x, y, r] of [[0, 0.04, 0.035], [-0.03, 0.03, 0.028], [0.03, 0.03, 0.028]] as [number, number, number][]) {
    const puff = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 12), cloudMat);
    puff.position.set(x, y, 0);
    btnGroup.add(puff);
  }

  // Offset from anchor: lower-right of view
  btnGroup.position.set(0.35, -0.25, -0.8);

  btnGroup.traverse((child) => {
    child.frustumCulled = false;
  });

  anchor.add(btnGroup);

  // Make it interactable via IWSDK
  const entity = world
    .createTransformEntity(btnGroup)
    .addComponent(Interactable);

  // --- Trigger rain on click (pointerup) ---
  let lastTrigger = 0;

  btnGroup.addEventListener("pointerdown" as any, () => {
    sphereMat.emissiveIntensity = 1.0;
  });

  btnGroup.addEventListener("pointerup" as any, () => {
    sphereMat.emissiveIntensity = 0.4;
    const now = Date.now();
    if (now - lastTrigger > COOLDOWN_MS) {
      lastTrigger = now;
      console.log("[vrRainButton] Triggered rain!");
      rainObjects(world, RAIN_COUNT);
    }
  });

  btnGroup.addEventListener("click" as any, () => {
    sphereMat.emissiveIntensity = 0.4;
    const now = Date.now();
    if (now - lastTrigger > COOLDOWN_MS) {
      lastTrigger = now;
      console.log("[vrRainButton] Triggered rain via click!");
      rainObjects(world, RAIN_COUNT);
    }
  });

  // --- Follow camera every frame ---
  const update = () => {
    requestAnimationFrame(update);
    const cam = world.camera;
    anchor.position.copy(cam.position);
    anchor.quaternion.copy(cam.quaternion);
  };
  update();

  console.log("[vrRainButton] Created — follows camera, lower-right of view");
}
