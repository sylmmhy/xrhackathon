import * as THREE from "three";
import { World } from "@iwsdk/core";
import { rainToys } from "./vrRainButton.js";

// ---------------------------------------------------------------------------
// Texture helpers
// ---------------------------------------------------------------------------

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function makeButtonTexture(emoji: string, label: string, highlight = false): THREE.CanvasTexture {
  const W = 512, H = 160;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 5;

  ctx.fillStyle = highlight ? "#ffe066" : "#f5ead0";
  roundRect(ctx, 8, 8, W - 16, H - 16, 40);
  ctx.fill();

  ctx.shadowColor = "transparent";

  ctx.strokeStyle = highlight ? "#a07820" : "#c8a855";
  ctx.lineWidth = 8;
  roundRect(ctx, 8, 8, W - 16, H - 16, 40);
  ctx.stroke();

  ctx.font = `${H * 0.52}px Nunito, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#000";
  ctx.fillText(emoji, H * 0.15, H * 0.52);

  ctx.fillStyle = "#3a1c00";
  ctx.font = `bold ${H * 0.35}px Nunito, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.fillText(label, H * 0.75, H * 0.52);

  return new THREE.CanvasTexture(canvas);
}

// ---------------------------------------------------------------------------
// Head-locked HUD menu — always visible in XR, follows camera
// ---------------------------------------------------------------------------

export function initHandMenu(world: World): void {
  const renderer = world.renderer as THREE.WebGLRenderer;
  const raycaster = new THREE.Raycaster();

  const BTN_W = 0.32, BTN_H = 0.10;
  const GAP   = 0.04;

  function makeBtn(): THREE.Mesh {
    return new THREE.Mesh(
      new THREE.PlaneGeometry(BTN_W, BTN_H),
      new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false }),
    );
  }

  const rainBtn  = makeBtn();
  const photoBtn = makeBtn();
  rainBtn.renderOrder = photoBtn.renderOrder = 9999;

  (rainBtn.material  as THREE.MeshBasicMaterial).map = makeButtonTexture("🌧", "Rain Toy");
  (photoBtn.material as THREE.MeshBasicMaterial).map = makeButtonTexture("📷", "Take Photo");

  // Stack vertically, centred on group origin
  rainBtn.position.set(0,  (BTN_H + GAP) / 2, 0);
  photoBtn.position.set(0, -(BTN_H + GAP) / 2, 0);

  const hudGroup = new THREE.Group();
  hudGroup.add(rainBtn, photoBtn);
  hudGroup.visible = false;
  world.scene.add(hudGroup);

  // Right controllers for raycasting
  const c0 = renderer.xr.getController(0);
  const c1 = renderer.xr.getController(1);
  world.scene.add(c0, c1);

  let triggerWasPressed = false;
  let photoCount = 0;

  globalThis.addEventListener("photo-count", (e) => {
    photoCount = (e as CustomEvent).detail;
    const label = photoCount >= 6 ? "Done! 6/6" : "Take Photo";
    (photoBtn.material as THREE.MeshBasicMaterial).map = makeButtonTexture("📷", label);
    (photoBtn.material as THREE.MeshBasicMaterial).needsUpdate = true;
  });

  // HUD distance in front of camera (metres)
  const HUD_DIST = 0.8;
  // Vertical offset: negative = below centre
  const HUD_Y_OFFSET = -0.15;

  const _pos = new THREE.Vector3();
  const _mat = new THREE.Matrix4();
  const _dir = new THREE.Vector3();
  const _fwd = new THREE.Vector3();

  // Must be a visible mesh so onBeforeRender fires (Three.js skips invisible objects).
  const pollMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.001, 0.001),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false }),
  );
  pollMesh.frustumCulled = false;
  world.scene.add(pollMesh);

  pollMesh.onBeforeRender = () => {
    const xr = renderer.xr;
    if (!xr.isPresenting) {
      hudGroup.visible = false;
      return;
    }

    // Position HUD in front of the camera (head-locked)
    const cam = world.camera;
    _fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    hudGroup.position
      .copy(cam.position)
      .addScaledVector(_fwd, HUD_DIST)
      .add(new THREE.Vector3(0, HUD_Y_OFFSET, 0));
    hudGroup.quaternion.copy(cam.quaternion);
    hudGroup.visible = true;

    // Find right controller
    const session = xr.getSession();
    if (!session) return;

    let rightCtrl: THREE.Group | null = null;
    const sources = Array.from(session.inputSources);
    for (let i = 0; i < sources.length && i < 2; i++) {
      if (sources[i].handedness === "right") rightCtrl = i === 0 ? c0 : c1;
    }

    if (!rightCtrl) return;

    // Ray from right controller
    rightCtrl.updateWorldMatrix(true, false);
    _pos.setFromMatrixPosition(rightCtrl.matrixWorld);
    _mat.extractRotation(rightCtrl.matrixWorld);
    _dir.set(0, 0, -1).applyMatrix4(_mat).normalize();
    raycaster.set(_pos, _dir);

    const hits = raycaster.intersectObjects([rainBtn, photoBtn]);
    const hit = hits[0]?.object as THREE.Mesh | undefined;

    // Highlight hovered button
    (rainBtn.material  as THREE.MeshBasicMaterial).map = makeButtonTexture("🌧", "Rain Toy",  hit === rainBtn);
    (photoBtn.material as THREE.MeshBasicMaterial).map = makeButtonTexture("📷",
      photoCount >= 6 ? "Done! 6/6" : "Take Photo", hit === photoBtn);

    // Trigger press
    let triggerPressed = false;
    for (const source of session.inputSources) {
      if (source.handedness === "right" && source.gamepad) {
        triggerPressed = source.gamepad.buttons[0]?.pressed ?? false;
      }
    }

    if (triggerPressed && !triggerWasPressed && hit) {
      triggerWasPressed = true;
      if (hit === rainBtn) {
        rainToys(world);
      } else if (hit === photoBtn && photoCount < 6) {
        globalThis.dispatchEvent(new Event("take-photo"));
      }
    } else if (!triggerPressed) {
      triggerWasPressed = false;
    }
  };
}
