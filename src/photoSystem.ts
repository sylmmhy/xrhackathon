import * as THREE from "three";
import { World } from "@iwsdk/core";

const MAX_PHOTOS = 6;


export function initPhotoSystem(world: World): void {
  const photos: string[] = [];

  // Inject flash keyframe once
  const style = document.createElement("style");
  style.textContent = `@keyframes yume-flash { from { opacity:0.9 } to { opacity:0 } }`;
  document.head.appendChild(style);

  function doCapture() {
    if (photos.length >= MAX_PHOTOS) return;

    const renderer = world.renderer as THREE.WebGLRenderer;

    // Hide UI, controllers, ray beam, and cursor so they don't appear in the photo.
    // We use Three.js layers instead of visible=false — this survives IWSDK's own
    // update loop that may re-enable visibility during renderer.render().
    // Camera default layers.mask = 1 (layer 0 only) → objects on layer 31 are skipped.
    if (!captureRetrying) {
      globalThis.dispatchEvent(new Event("pre-capture"));
    }

    const xr = renderer.xr;
    const ctrlGroups = [
      xr.getController(0), xr.getController(1),
      xr.getControllerGrip(0), xr.getControllerGrip(1),
    ];

    const objsOnLayer31: THREE.Object3D[] = [];
    const moveToLayer31 = (obj: THREE.Object3D) => {
      obj.layers.set(31);
      objsOnLayer31.push(obj);
    };

    // Controller groups + all descendants (ray beam CylinderMesh is a child)
    ctrlGroups.forEach((c) => { if (c) c.traverse(moveToLayer31); });

    // IWSDK ray beams live in world.player.raySpaces (separate from Three.js controllers)
    const player = (world as any).player as any;
    if (player?.raySpaces?.left) player.raySpaces.left.traverse(moveToLayer31);
    if (player?.raySpaces?.right) player.raySpaces.right.traverse(moveToLayer31);

    // IWSDK cursor dot, stray lines, blob shadows, and UI panel meshes
    world.scene.traverse((obj) => {
      if (obj.userData.attached ||
          obj instanceof THREE.Line ||
          obj instanceof THREE.LineSegments) {
        moveToLayer31(obj);
      }
      // Blob shadows: depthTest=false planes with transparent material near ground
      if (obj instanceof THREE.Mesh) {
        const mat = obj.material as THREE.MeshBasicMaterial;
        if (mat?.depthTest === false && mat?.depthWrite === false && mat?.transparent === true && mat?.map) {
          moveToLayer31(obj);
        }
        // UI panel meshes: high renderOrder or AlwaysDepth
        if (obj.renderOrder >= 10000 ||
            mat?.depthFunc === THREE.AlwaysDepth) {
          moveToLayer31(obj);
        }
      }
    });

    // Force 4:3 aspect ratio for photo capture
    const PHOTO_W = 1200;
    const PHOTO_H = 900;
    const renderTarget = new THREE.WebGLRenderTarget(PHOTO_W, PHOTO_H);

    // Create a narrower FOV camera for photo capture to reduce wide-angle distortion.
    // Copy world position/rotation from the XR camera so the photo matches what you see.
    const PHOTO_FOV = 50;
    const photoCam = new THREE.PerspectiveCamera(PHOTO_FOV, PHOTO_W / PHOTO_H, 0.1, 1000);
    const cam = world.camera;
    cam.getWorldPosition(photoCam.position);
    cam.getWorldQuaternion(photoCam.quaternion);
    photoCam.updateMatrixWorld();

    // Temporarily disable XR so the XR manager doesn't override our viewport/camera
    const wasXrEnabled = renderer.xr.enabled;
    renderer.xr.enabled = false;

    // Make both splat and toys output raw sRGB so no per-pixel correction is needed:
    // 1. SparkJS: set encodeLinear=false → outputs raw sRGB (no linear conversion)
    // 2. Three.js: set textures to LinearSRGBColorSpace → treats sRGB values as linear
    //    (passes through raw sRGB without converting). Restored after capture.
    const encodeLinearUniforms: { value: boolean }[] = [];
    const textureColorSpaces: { tex: THREE.Texture; cs: string }[] = [];

    world.scene.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of mats) {
        // SparkJS splat materials
        if ((mat as any)?.uniforms?.encodeLinear) {
          encodeLinearUniforms.push((mat as any).uniforms.encodeLinear);
          (mat as any).uniforms.encodeLinear.value = false;
        }
        // Three.js material textures — temporarily set to linear
        if (mat instanceof THREE.MeshBasicMaterial || mat instanceof THREE.MeshStandardMaterial) {
          const tex = mat.map;
          if (tex && tex.colorSpace === THREE.SRGBColorSpace) {
            textureColorSpaces.push({ tex, cs: tex.colorSpace });
            tex.colorSpace = THREE.LinearSRGBColorSpace;
            tex.needsUpdate = true;
          }
        }
      }
    });

    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(renderTarget);
    renderer.setViewport(0, 0, PHOTO_W, PHOTO_H);
    renderer.setScissor(0, 0, PHOTO_W, PHOTO_H);
    renderer.setScissorTest(true);
    renderer.clear();
    renderer.render(world.scene, photoCam);
    renderer.setScissorTest(false);
    renderer.setRenderTarget(prevTarget);

    // Restore everything
    encodeLinearUniforms.forEach((u) => { u.value = true; });
    textureColorSpaces.forEach(({ tex, cs }) => {
      tex.colorSpace = cs as THREE.ColorSpace;
      tex.needsUpdate = true;
    });
    renderer.xr.enabled = wasXrEnabled;

    // Restore all objects back to layer 0 so XR rendering resumes normally
    objsOnLayer31.forEach((obj) => { obj.layers.set(0); });
    globalThis.dispatchEvent(new Event("post-capture"));

    // Read pixels
    const pixels = new Uint8Array(PHOTO_W * PHOTO_H * 4);
    renderer.readRenderTargetPixels(renderTarget, 0, 0, PHOTO_W, PHOTO_H, pixels);
    renderTarget.dispose();

    // Check if capture is black (sample a few pixels in the center)
    let nonBlackCount = 0;
    for (let i = 0; i < 20; i++) {
      const sx = Math.floor(PHOTO_W * 0.3 + Math.random() * PHOTO_W * 0.4);
      const sy = Math.floor(PHOTO_H * 0.3 + Math.random() * PHOTO_H * 0.4);
      const idx = (sy * PHOTO_W + sx) * 4;
      if (pixels[idx] > 2 || pixels[idx + 1] > 2 || pixels[idx + 2] > 2) nonBlackCount++;
    }
    if (nonBlackCount < 3) {
      // Mostly black — retry on next frame (skip pre/post-capture to avoid flicker)
      console.warn("[photoSystem] Black frame detected, retrying...");
      captureRequested = true;
      captureRetrying = true;
      return;
    }
    captureRetrying = false;

    // Both splat (encodeLinear=false) and toys (textures set to linear passthrough)
    // output raw sRGB values — just flip Y, no color conversion needed.
    const offscreen = document.createElement("canvas");
    offscreen.width = PHOTO_W;
    offscreen.height = PHOTO_H;
    const ctx = offscreen.getContext("2d")!;
    const imageData = ctx.createImageData(PHOTO_W, PHOTO_H);
    for (let y = 0; y < PHOTO_H; y++) {
      for (let x = 0; x < PHOTO_W; x++) {
        const src = ((PHOTO_H - 1 - y) * PHOTO_W + x) * 4;
        const dst = (y * PHOTO_W + x) * 4;
        imageData.data[dst]     = pixels[src];
        imageData.data[dst + 1] = pixels[src + 1];
        imageData.data[dst + 2] = pixels[src + 2];
        imageData.data[dst + 3] = pixels[src + 3];
      }
    }
    ctx.putImageData(imageData, 0, 0);
    const dataURL = offscreen.toDataURL("image/jpeg", 0.92);
    photos.push(dataURL);

    showFlash();

    globalThis.dispatchEvent(new CustomEvent("photo-count", { detail: photos.length }));
    globalThis.dispatchEvent(new CustomEvent("photo-taken", { detail: dataURL }));

    if (photos.length >= MAX_PHOTOS) {
      const isXR = (world.renderer as THREE.WebGLRenderer).xr.isPresenting;
      if (isXR) {
        // In XR: auto-download the strip and show a 3D celebration message
        setTimeout(() => {
          downloadStrip(photos);
          globalThis.dispatchEvent(new CustomEvent("photos-complete", { detail: photos.slice() }));
        }, 600);
      } else {
        setTimeout(() => showPolaroidStrip(photos), 600);
      }
    }
  }

  // Capture inside the XR frame via onBeforeRender + microtask.
  // setTimeout runs outside XR frames — on real headsets the WebGL context
  // may not be renderable outside XR frame callbacks, causing black photos.
  // A microtask from onBeforeRender runs AFTER renderer.render() returns
  // (no nested render) but while XR camera matrices are still valid.
  let captureRequested = false;
  let captureRetrying = false; // true when retrying after black frame

  globalThis.addEventListener("take-photo", () => {
    if (photos.length >= MAX_PHOTOS) return;
    captureRequested = true;
    captureRetrying = false;
  });

  const capturePollMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.001, 0.001),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false }),
  );
  capturePollMesh.frustumCulled = false;
  world.scene.add(capturePollMesh);

  capturePollMesh.onBeforeRender = () => {
    if (!captureRequested) return;
    captureRequested = false;
    Promise.resolve().then(() => doCapture());
  };

  // Reset for another round of photos
  globalThis.addEventListener("photos-reset", () => {
    photos.length = 0;
    globalThis.dispatchEvent(new CustomEvent("photo-count", { detail: 0 }));
  });
}

function showFlash(): void {
  const flash = document.createElement("div");
  flash.style.cssText = `
    position:fixed; inset:0; background:#fff; z-index:99999;
    pointer-events:none; animation:yume-flash 0.35s ease forwards;
  `;
  document.body.appendChild(flash);
  setTimeout(() => flash.remove(), 400);
}

function showPolaroidStrip(photos: string[]): void {
  const overlay = document.createElement("div");
  overlay.style.cssText = `
    position:fixed; inset:0;
    background:linear-gradient(135deg, rgba(255,248,240,0.96), rgba(240,230,255,0.96));
    z-index:99998; display:flex; flex-direction:column;
    align-items:center; justify-content:center; gap:28px;
    font-family:Nunito,sans-serif;
  `;

  // Use YUME logo as header
  const logo = document.createElement("img");
  logo.src = "/Yume.png";
  logo.style.cssText = `height:60px; object-fit:contain;`;
  overlay.appendChild(logo);

  const subtitle = document.createElement("div");
  subtitle.textContent = "Your Dream Moments";
  subtitle.style.cssText = `
    font-size:20px; font-weight:700; letter-spacing:1px;
    background:linear-gradient(90deg, #3aaa35, #5ba3d9, #e53935, #7b2ff2);
    -webkit-background-clip:text; -webkit-text-fill-color:transparent;
    background-clip:text;
  `;
  overlay.appendChild(subtitle);

  const strip = document.createElement("div");
  strip.style.cssText = `display:flex; gap:16px; align-items:flex-start; flex-wrap:wrap; justify-content:center; max-width:95vw;`;

  const rotations = [-3, 2, -1.5, 3, -2, 1];
  const shadowColors = ["rgba(58,170,53,0.3)", "rgba(91,163,217,0.3)", "rgba(229,57,53,0.3)", "rgba(123,47,242,0.3)", "rgba(58,170,53,0.3)", "rgba(229,57,53,0.3)"];
  photos.forEach((dataURL, i) => {
    const polaroid = document.createElement("div");
    polaroid.style.cssText = `
      background:#fff; padding:8px 8px 28px;
      box-shadow:0 6px 24px ${shadowColors[i] ?? "rgba(0,0,0,0.2)"};
      transform:rotate(${rotations[i] ?? 0}deg);
      flex-shrink:0; border-radius:4px;
    `;
    const img = document.createElement("img");
    img.src = dataURL;
    img.style.cssText = `width:150px; height:110px; object-fit:cover; display:block; border-radius:2px;`;
    polaroid.appendChild(img);

    const label = document.createElement("div");
    label.textContent = `#${i + 1}`;
    label.style.cssText = `text-align:center; color:#7b2ff2; font-size:12px; font-weight:600; margin-top:8px;`;
    polaroid.appendChild(label);

    strip.appendChild(polaroid);
  });

  overlay.appendChild(strip);

  const btnRow = document.createElement("div");
  btnRow.style.cssText = `display:flex; gap:14px; margin-top:8px;`;

  const downloadBtn = document.createElement("button");
  downloadBtn.textContent = "Download";
  downloadBtn.style.cssText = `
    padding:12px 32px; border:none; border-radius:12px;
    background:linear-gradient(135deg, #3aaa35, #5ba3d9);
    color:#fff; font-size:16px; font-weight:700; cursor:pointer;
    font-family:Nunito,sans-serif; box-shadow:0 3px 12px rgba(58,170,53,0.3);
  `;
  downloadBtn.addEventListener("click", () => downloadStrip(photos));

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "Close";
  closeBtn.style.cssText = `
    padding:12px 32px; border:none; border-radius:12px;
    background:linear-gradient(135deg, #e53935, #7b2ff2);
    color:#fff; font-size:16px; font-weight:700; cursor:pointer;
    font-family:Nunito,sans-serif; box-shadow:0 3px 12px rgba(123,47,242,0.3);
  `;
  closeBtn.addEventListener("click", () => overlay.remove());

  btnRow.appendChild(downloadBtn);
  btnRow.appendChild(closeBtn);
  overlay.appendChild(btnRow);
  document.body.appendChild(overlay);
}

function downloadStrip(photos: string[]): void {
  // Determine actual photo aspect ratio from first image before drawing
  const firstImg = new Image();
  firstImg.src = photos[0];
  firstImg.onload = () => {
    const photoAspect = firstImg.naturalWidth / firstImg.naturalHeight;
    _drawStrip(photos, photoAspect);
  };
}

function _drawStrip(photos: string[], photoAspect: number): void {
  const PHOTO_W = 158;
  const PHOTO_H = Math.round(PHOTO_W / photoAspect);
  const PW = PHOTO_W + 18;
  const PH = PHOTO_H + 8 + 6 + 14; // top pad + photo + gap + label+bottom
  const PAD = 16;

  const canvas = document.createElement("canvas");
  canvas.width = photos.length * (PW + PAD) + PAD;
  canvas.height = PH + PAD * 2;
  const ctx = canvas.getContext("2d")!;

  // Soft cream background matching YUME theme
  const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  grad.addColorStop(0, "#fff8f0");
  grad.addColorStop(1, "#f0e6ff");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  let loaded = 0;
  photos.forEach((dataURL, i) => {
    const img = new Image();
    img.onload = () => {
      const x = PAD + i * (PW + PAD);
      const y = PAD;

      ctx.shadowColor = "rgba(0,0,0,0.5)";
      ctx.shadowBlur = 10;
      ctx.fillStyle = "#fff";
      ctx.fillRect(x, y, PW, PH);
      ctx.shadowBlur = 0;

      ctx.drawImage(img, x + (PW - PHOTO_W) / 2, y + 8, PHOTO_W, PHOTO_H);

      ctx.fillStyle = "#7b2ff2";
      ctx.font = "12px Nunito, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`#${i + 1}`, x + PW / 2, y + 8 + PHOTO_H + 16);

      loaded++;
      if (loaded === photos.length) {
        const link = document.createElement("a");
        link.download = "yume-polaroid-strip.png";
        link.href = canvas.toDataURL("image/png");
        link.click();
      }
    };
    img.src = dataURL;
  });
}
