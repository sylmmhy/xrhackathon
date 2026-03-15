import * as THREE from "three";
import { World } from "@iwsdk/core";
import { spawnGLBFromUrl } from "./objectLoader.js";

const DEFAULT_GLB = "./SM_Aligator.glb";

/**
 * Spawn `count` toys raining from the sky above the player.
 */
export async function rainToys(
  world: World,
  count: number,
  glbUrl: string = DEFAULT_GLB,
) {
  const cam = world.camera;
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  forward.y = 0;
  forward.normalize();
  const center = cam.position.clone().addScaledVector(forward, 3);

  for (let i = 0; i < count; i++) {
    // Small random spread so they stack like a tower
    const pos = new THREE.Vector3(
      center.x + (Math.random() - 0.5) * 0.5,
      4 + i * 1.2,
      center.z + (Math.random() - 0.5) * 0.5,
    );
    spawnGLBFromUrl(world, glbUrl, pos).catch((err) =>
      console.warn("[rainToys] spawn failed:", err),
    );
    if (i < count - 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}
