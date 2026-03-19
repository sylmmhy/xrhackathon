import * as THREE from "three";
import { World } from "@iwsdk/core";
import { spawnGLBFromUrl } from "./objectLoader.js";

const TOY_MODELS = ["./SM_Aligator.glb", "./CuteFox.glb", "./GothicFox.glb"];

/**
 * Spawn 2–10 random alligator/fox toys raining from the sky above the player.
 */
export async function rainToys(world: World, maxCount?: number) {
  const limit = maxCount ?? 10;
  const count = Math.min(2 + Math.floor(Math.random() * (limit - 1)), limit);

  const cam = world.camera;
  // Use world-space position/direction so toys rain in front of the player after locomotion
  const camWorldPos = new THREE.Vector3();
  const camWorldQuat = new THREE.Quaternion();
  cam.getWorldPosition(camWorldPos);
  cam.getWorldQuaternion(camWorldQuat);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camWorldQuat);
  const center = camWorldPos.addScaledVector(forward, 2);

  for (let i = 0; i < count; i++) {
    const glbUrl = TOY_MODELS[Math.floor(Math.random() * TOY_MODELS.length)];
    const pos = new THREE.Vector3(
      center.x + (Math.random() - 0.5) * 2,
      center.y + 2 + Math.random() * 2,
      center.z + (Math.random() - 0.5) * 2,
    );
    spawnGLBFromUrl(world, glbUrl, pos).catch((err) =>
      console.warn("[rainToys] spawn failed:", err),
    );
    if (i < count - 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}
