import * as THREE from "three";

/**
 * Virtual joystick for touch-based camera locomotion on mobile.
 * Moves the camera along the XZ plane based on joystick direction.
 */
export function createTouchLocomotion(
  camera: THREE.Camera,
  domElement: HTMLElement,
): { update(delta: number): void; dispose(): void } {
  const JOYSTICK_SIZE = 120;
  const KNOB_SIZE = 50;
  const MAX_OFFSET = (JOYSTICK_SIZE - KNOB_SIZE) / 2;
  const MOVE_SPEED = 1.5; // m/s

  // Direction vector from joystick input (normalized, XZ plane)
  let inputX = 0;
  let inputY = 0;
  let activeTouch: number | null = null;

  // --- DOM ---
  const container = document.createElement("div");
  container.style.cssText = `
    position: fixed; bottom: 32px; left: 32px; z-index: 10001;
    width: ${JOYSTICK_SIZE}px; height: ${JOYSTICK_SIZE}px;
    border-radius: 50%; background: rgba(255,255,255,0.15);
    border: 2px solid rgba(255,255,255,0.3);
    touch-action: none; user-select: none;
    -webkit-user-select: none;
  `;

  const knob = document.createElement("div");
  knob.style.cssText = `
    position: absolute; width: ${KNOB_SIZE}px; height: ${KNOB_SIZE}px;
    border-radius: 50%; background: rgba(255,255,255,0.5);
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    pointer-events: none;
  `;
  container.appendChild(knob);
  document.body.appendChild(container);

  function getCenter() {
    const rect = container.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  function onTouchStart(e: TouchEvent) {
    if (activeTouch !== null) return;
    const touch = e.changedTouches[0];
    activeTouch = touch.identifier;
    updateKnob(touch);
    e.preventDefault();
  }

  function onTouchMove(e: TouchEvent) {
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === activeTouch) {
        updateKnob(e.changedTouches[i]);
        e.preventDefault();
        return;
      }
    }
  }

  function onTouchEnd(e: TouchEvent) {
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === activeTouch) {
        activeTouch = null;
        inputX = 0;
        inputY = 0;
        knob.style.transform = "translate(-50%, -50%)";
        e.preventDefault();
        return;
      }
    }
  }

  function updateKnob(touch: Touch) {
    const center = getCenter();
    let dx = touch.clientX - center.x;
    let dy = touch.clientY - center.y;

    // Clamp to circle
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > MAX_OFFSET) {
      dx = (dx / dist) * MAX_OFFSET;
      dy = (dy / dist) * MAX_OFFSET;
    }

    knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;

    // Normalize to -1..1
    inputX = dx / MAX_OFFSET;
    inputY = dy / MAX_OFFSET; // positive = down on screen = forward in world
  }

  container.addEventListener("touchstart", onTouchStart, { passive: false });
  document.addEventListener("touchmove", onTouchMove, { passive: false });
  document.addEventListener("touchend", onTouchEnd, { passive: false });

  // Temp vectors
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const movement = new THREE.Vector3();

  return {
    update(delta: number) {
      if (inputX === 0 && inputY === 0) return;

      // Camera forward projected onto XZ plane
      camera.getWorldDirection(forward);
      forward.y = 0;
      forward.normalize();

      // Right vector
      right.crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

      // joystick Y negative = forward (screen up), positive = backward
      movement
        .set(0, 0, 0)
        .addScaledVector(forward, -inputY * MOVE_SPEED * delta)
        .addScaledVector(right, inputX * MOVE_SPEED * delta);

      camera.position.add(movement);
    },
    dispose() {
      container.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      container.remove();
    },
  };
}
