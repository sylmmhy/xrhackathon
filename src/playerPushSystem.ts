import * as THREE from "three";
import {
  createSystem,
  PhysicsBody,
  PhysicsManipulation,
  PhysicsState,
} from "@iwsdk/core";

const PUSH_RADIUS = 0.5;
const PUSH_FORCE = 1.2;
const PUSH_UP = 0.3;

/**
 * Detects when the player walks into dynamic physics objects
 * and pushes them away like kicking plush toys.
 */
export class PlayerPushSystem extends createSystem({
  dynamicBodies: {
    required: [PhysicsBody],
  },
}) {
  private playerPos = new THREE.Vector3();
  private prevPlayerPos = new THREE.Vector3();
  private playerVel = new THREE.Vector3();
  private initialized = false;

  update(delta: number) {
    const player = this.world.player;
    if (!player) return;

    this.playerPos.copy(player.position);

    if (!this.initialized) {
      this.prevPlayerPos.copy(this.playerPos);
      this.initialized = true;
      return;
    }

    // Player velocity
    if (delta > 0) {
      this.playerVel
        .subVectors(this.playerPos, this.prevPlayerPos)
        .divideScalar(delta);
    }
    this.prevPlayerPos.copy(this.playerPos);

    const playerSpeed = this.playerVel.length();
    if (playerSpeed < 0.1) return; // not moving, skip

    this.queries.dynamicBodies.entities.forEach((entity) => {
      const state = entity.getValue(PhysicsBody, "state");
      if (state !== PhysicsState.Dynamic) return;

      const obj = entity.object3D;
      if (!obj) return;

      const objPos = new THREE.Vector3();
      obj.getWorldPosition(objPos);

      const diff = new THREE.Vector3().subVectors(objPos, this.playerPos);
      diff.y = 0; // horizontal distance only
      const dist = diff.length();

      if (dist < PUSH_RADIUS && dist > 0.01) {
        // Push direction: away from player
        const pushDir = diff.normalize();
        const force = PUSH_FORCE * Math.min(playerSpeed, 3);

        if (!entity.hasComponent(PhysicsManipulation)) {
          entity.addComponent(PhysicsManipulation, {
            linearVelocity: [
              pushDir.x * force,
              PUSH_UP + Math.random() * 0.3,
              pushDir.z * force,
            ],
            angularVelocity: [
              (Math.random() - 0.5) * 2,
              (Math.random() - 0.5) * 2,
              (Math.random() - 0.5) * 2,
            ],
          });
        }
      }
    });
  }
}
