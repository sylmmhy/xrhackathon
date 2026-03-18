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

    // Hide UI, controllers, and ray lines so they don't appear in the photo
    globalThis.dispatchEvent(new Event("pre-capture"));

    const xr = renderer.xr;
    const hiddenCtrls = [
      xr.getController(0), xr.getController(1),
      xr.getControllerGrip(0), xr.getControllerGrip(1),
    ];
    hiddenCtrls.forEach((c) => { if (c) c.visible = false; });

    // Also hide any Line objects (IWSDK laser pointer rays)
    const hiddenLines: THREE.Object3D[] = [];
    world.scene.traverse((obj) => {
      if ((obj instanceof THREE.Line || obj instanceof THREE.LineSegments) && obj.visible) {
        obj.visible = false;
        hiddenLines.push(obj);
      }
    });

    const size = renderer.getSize(new THREE.Vector2());
    const renderTarget = new THREE.WebGLRenderTarget(size.x, size.y);

    // Keep XR enabled so Three.js material rendering stays in XR color mode.
    // We redirect to our render target instead of the XR framebuffer.
    // Force SRGBColorSpace so both Three.js materials and SparkJS splat output sRGB.
    const prevOutputCS = renderer.outputColorSpace;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(renderTarget);
    renderer.clear();
    renderer.render(world.scene, world.camera as THREE.Camera);
    renderer.setRenderTarget(prevTarget);

    renderer.outputColorSpace = prevOutputCS;

    // Restore controllers, ray lines, and UI
    hiddenCtrls.forEach((c) => { if (c) c.visible = true; });
    hiddenLines.forEach((obj) => { obj.visible = true; });
    globalThis.dispatchEvent(new Event("post-capture"));

    // Read pixels (WebGL is bottom-to-top, flip Y, convert linear→sRGB)
    const pixels = new Uint8Array(size.x * size.y * 4);
    renderer.readRenderTargetPixels(renderTarget, 0, 0, size.x, size.y, pixels);
    renderTarget.dispose();

    const offscreen = document.createElement("canvas");
    offscreen.width = size.x;
    offscreen.height = size.y;
    const ctx = offscreen.getContext("2d")!;
    const imageData = ctx.createImageData(size.x, size.y);
    for (let y = 0; y < size.y; y++) {
      for (let x = 0; x < size.x; x++) {
        const src = ((size.y - 1 - y) * size.x + x) * 4;
        const dst = (y * size.x + x) * 4;
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
      setTimeout(() => showPolaroidStrip(photos), 600);
    }
  }

  // Defer capture outside the XR render loop to avoid nested renderer.render() calls
  globalThis.addEventListener("take-photo", () => {
    if (photos.length >= MAX_PHOTOS) return;
    setTimeout(doCapture, 100);
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
    position:fixed; inset:0; background:rgba(0,0,0,0.88);
    z-index:99998; display:flex; flex-direction:column;
    align-items:center; justify-content:center; gap:28px;
    font-family:-apple-system,sans-serif;
  `;

  const title = document.createElement("div");
  title.textContent = "Your Dream Moments ✨";
  title.style.cssText = `color:#fbbf24; font-size:22px; font-weight:700;`;
  overlay.appendChild(title);

  const strip = document.createElement("div");
  strip.style.cssText = `display:flex; gap:14px; align-items:flex-start; flex-wrap:wrap; justify-content:center; max-width:95vw;`;

  const rotations = [-3, 2, -1.5, 3, -2, 1];
  photos.forEach((dataURL, i) => {
    const polaroid = document.createElement("div");
    polaroid.style.cssText = `
      background:#fff; padding:8px 8px 28px;
      box-shadow:0 6px 20px rgba(0,0,0,0.6);
      transform:rotate(${rotations[i] ?? 0}deg);
      flex-shrink:0;
    `;
    const img = document.createElement("img");
    img.src = dataURL;
    img.style.cssText = `width:150px; height:110px; object-fit:cover; display:block;`;
    polaroid.appendChild(img);

    const label = document.createElement("div");
    label.textContent = `#${i + 1}`;
    label.style.cssText = `text-align:center; color:#999; font-size:11px; margin-top:6px;`;
    polaroid.appendChild(label);

    strip.appendChild(polaroid);
  });

  overlay.appendChild(strip);

  const btnRow = document.createElement("div");
  btnRow.style.cssText = `display:flex; gap:12px;`;

  const downloadBtn = document.createElement("button");
  downloadBtn.textContent = "⬇ Download";
  downloadBtn.style.cssText = `
    padding:12px 28px; border:none; border-radius:10px;
    background:#fbbf24; color:#0d0221; font-size:16px; font-weight:700; cursor:pointer;
  `;
  downloadBtn.addEventListener("click", () => downloadStrip(photos));

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕ Close";
  closeBtn.style.cssText = `
    padding:12px 28px; border:none; border-radius:10px;
    background:#7b2ff2; color:#fbbf24; font-size:16px; font-weight:700; cursor:pointer;
  `;
  closeBtn.addEventListener("click", () => overlay.remove());

  btnRow.appendChild(downloadBtn);
  btnRow.appendChild(closeBtn);
  overlay.appendChild(btnRow);
  document.body.appendChild(overlay);
}

function downloadStrip(photos: string[]): void {
  const PW = 176;
  const PH = 210;
  const PHOTO_W = 158;
  const PHOTO_H = 116;
  const PAD = 16;

  const canvas = document.createElement("canvas");
  canvas.width = photos.length * (PW + PAD) + PAD;
  canvas.height = PH + PAD * 2;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = "#0d0221";
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

      ctx.fillStyle = "#999";
      ctx.font = "12px -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`#${i + 1}`, x + PW / 2, y + PH - 8);

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
