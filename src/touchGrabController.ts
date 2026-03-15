import * as THREE from "three";

/**
 * Touch-based raycasting grab controller for mobile browsers.
 * Pure Three.js — no WebXR dependency.
 */
export function createTouchGrabController(
  camera: THREE.Camera,
  scene: THREE.Scene,
  domElement: HTMLElement,
): { update(): void; dispose(): void } {
  const raycaster = new THREE.Raycaster();
  const touchNDC = new THREE.Vector2();

  let dragging: THREE.Object3D | null = null;
  let dragPlane = new THREE.Plane();
  let dragOffset = new THREE.Vector3();
  let originalEmissive: THREE.Color | null = null;
  let highlightMesh: THREE.Mesh | null = null;

  function ndcFromTouch(touch: Touch) {
    const rect = domElement.getBoundingClientRect();
    touchNDC.x = ((touch.clientX - rect.left) / rect.width) * 2 - 1;
    touchNDC.y = -((touch.clientY - rect.top) / rect.height) * 2 + 1;
  }

  /** Find the top-level draggable ancestor (direct child of scene or its parent group). */
  function findGrabbableRoot(hit: THREE.Object3D): THREE.Object3D | null {
    let current: THREE.Object3D | null = hit;
    while (current && current.parent !== scene) {
      current = current.parent;
    }
    return current;
  }

  function setHighlight(obj: THREE.Object3D, on: boolean) {
    obj.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const mat = child.material as THREE.MeshStandardMaterial;
      if (!mat || !("emissive" in mat)) return;

      if (on) {
        if (!highlightMesh) {
          highlightMesh = child;
          originalEmissive = mat.emissive.clone();
        }
        mat.emissive.set(0x442288);
      } else {
        if (originalEmissive) {
          mat.emissive.copy(originalEmissive);
        }
      }
    });

    if (!on) {
      highlightMesh = null;
      originalEmissive = null;
    }
  }

  function onTouchStart(e: TouchEvent) {
    if (dragging) return;
    const touch = e.touches[0];
    ndcFromTouch(touch);

    raycaster.setFromCamera(touchNDC, camera);

    // Collect meshes from scene children (skip grid, floor, etc.)
    const meshes: THREE.Object3D[] = [];
    scene.children.forEach((child) => {
      child.traverse((obj) => {
        if (obj instanceof THREE.Mesh && obj.visible) {
          meshes.push(obj);
        }
      });
    });

    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return;

    const hitObj = hits[0].object;
    const root = findGrabbableRoot(hitObj);
    if (!root) return;

    dragging = root;
    setHighlight(dragging, true);

    // Create a drag plane parallel to the camera, passing through the hit point
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    dragPlane.setFromNormalAndCoplanarPoint(camDir, hits[0].point);

    // Compute offset so the object doesn't snap to the touch point
    const intersectPoint = new THREE.Vector3();
    raycaster.ray.intersectPlane(dragPlane, intersectPoint);
    dragOffset.subVectors(dragging.position, intersectPoint);
  }

  function onTouchMove(e: TouchEvent) {
    if (!dragging) return;
    e.preventDefault(); // prevent scroll while dragging

    const touch = e.touches[0];
    ndcFromTouch(touch);
    raycaster.setFromCamera(touchNDC, camera);

    const intersectPoint = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(dragPlane, intersectPoint)) {
      dragging.position.copy(intersectPoint).add(dragOffset);
    }
  }

  function onTouchEnd(_e: TouchEvent) {
    if (dragging) {
      setHighlight(dragging, false);
      dragging = null;
    }
  }

  domElement.addEventListener("touchstart", onTouchStart, { passive: true });
  domElement.addEventListener("touchmove", onTouchMove, { passive: false });
  domElement.addEventListener("touchend", onTouchEnd, { passive: true });

  return {
    update() {
      // no-op for now; drag is event-driven
    },
    dispose() {
      domElement.removeEventListener("touchstart", onTouchStart);
      domElement.removeEventListener("touchmove", onTouchMove);
      domElement.removeEventListener("touchend", onTouchEnd);
      if (dragging) {
        setHighlight(dragging, false);
        dragging = null;
      }
    },
  };
}
