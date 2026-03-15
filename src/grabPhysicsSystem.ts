import * as THREE from "three";
import {
  createSystem,
  DistanceGrabbable,
  PhysicsBody,
  PhysicsManipulation,
  PhysicsState,
  Pressed,
} from "@iwsdk/core";

// Internal Handle component used by IWSDK's GrabSystem
// We import it from the grab internals so we can read the handle state.
// @ts-ignore — not part of the public API surface
import { Handle } from "@iwsdk/core/dist/grab/handles.js";

const VELOCITY_BUFFER_SIZE = 5;
const MAX_THROW_SPEED = 15; // m/s clamp
const THROW_SCALE = 1.3; // amplify throw feel

interface VelocityTracker {
  positions: THREE.Vector3[];
  times: number[];
  wasGrabbed: boolean;
}

/**
 * Monitors entities with PhysicsBody + DistanceGrabbable.
 * While grabbed: switches to Kinematic so the object follows the hand.
 * On release:  switches back to Dynamic and applies throw velocity.
 */
export class GrabPhysicsSystem extends createSystem({
  grabbedPhysics: {
    required: [PhysicsBody, DistanceGrabbable, Handle],
  },
}) {
  private trackers = new Map<number, VelocityTracker>();

  init() {
    this.queries.grabbedPhysics.subscribe(
      "disqualify",
      (entity) => {
        this.trackers.delete(entity.index);
      },
    );
  }

  update(_delta: number) {
    const now = performance.now();

    this.queries.grabbedPhysics.entities.forEach((entity) => {
      const handle = Handle.data.instance[entity.index] as
        | { inputState: Map<number, unknown>; getState(): any }
        | undefined;
      if (!handle) return;

      const isGrabbed = handle.inputState.size > 0;
      const obj = entity.object3D;
      if (!obj) return;

      let tracker = this.trackers.get(entity.index);
      if (!tracker) {
        tracker = { positions: [], times: [], wasGrabbed: false };
        this.trackers.set(entity.index, tracker);
      }

      if (isGrabbed) {
        // --- Grab started ---
        if (!tracker.wasGrabbed) {
          entity.setValue(PhysicsBody, "state", PhysicsState.Kinematic);
          // Tell PhysicsSystem to sync kinematic body to Object3D transform
          if (!entity.hasComponent(Pressed)) {
            entity.addComponent(Pressed);
          }
          tracker.positions.length = 0;
          tracker.times.length = 0;
        }

        // Record position for velocity calculation
        tracker.positions.push(obj.position.clone());
        tracker.times.push(now);
        if (tracker.positions.length > VELOCITY_BUFFER_SIZE) {
          tracker.positions.shift();
          tracker.times.shift();
        }
        tracker.wasGrabbed = true;
      } else if (tracker.wasGrabbed) {
        // --- Just released ---
        if (entity.hasComponent(Pressed)) {
          entity.removeComponent(Pressed);
        }
        entity.setValue(PhysicsBody, "state", PhysicsState.Dynamic);

        // Calculate average velocity from buffered samples
        const velocity = this.computeThrowVelocity(tracker, now);
        if (velocity.lengthSq() > 0.01) {
          entity.addComponent(PhysicsManipulation, {
            linearVelocity: [velocity.x, velocity.y, velocity.z],
            angularVelocity: [
              (Math.random() - 0.5) * 2,
              (Math.random() - 0.5) * 2,
              (Math.random() - 0.5) * 2,
            ],
          });
        }

        tracker.wasGrabbed = false;
        tracker.positions.length = 0;
        tracker.times.length = 0;
      }
    });
  }

  private computeThrowVelocity(
    tracker: VelocityTracker,
    _now: number,
  ): THREE.Vector3 {
    const { positions, times } = tracker;
    if (positions.length < 2) return new THREE.Vector3();

    // Weighted average — more recent samples count more
    const velocity = new THREE.Vector3();
    let totalWeight = 0;

    for (let i = 1; i < positions.length; i++) {
      const dt = (times[i] - times[i - 1]) / 1000; // seconds
      if (dt <= 0) continue;

      const dx = new THREE.Vector3().subVectors(positions[i], positions[i - 1]);
      const v = dx.divideScalar(dt);
      const weight = i; // later samples get higher weight
      velocity.addScaledVector(v, weight);
      totalWeight += weight;
    }

    if (totalWeight > 0) {
      velocity.divideScalar(totalWeight);
    }

    velocity.multiplyScalar(THROW_SCALE);

    // Clamp to max speed
    if (velocity.length() > MAX_THROW_SPEED) {
      velocity.setLength(MAX_THROW_SPEED);
    }

    return velocity;
  }
}
