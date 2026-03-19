
import * as THREE from "three";
import {
  Entity,
  EnvironmentType,
  Interactable,
  LocomotionEnvironment,
  Mesh,
  MeshBasicMaterial,
  PanelUI,
  PhysicsBody,
  PhysicsShape,
  PhysicsShapeType,
  PhysicsState,
  PlaneGeometry,
  ScreenSpace,
  SessionMode,
  VisibilityState,
  World,
} from "@iwsdk/core";
import { PanelSystem } from "./uiPanel.js";
import { GaussianSplatLoader, GaussianSplatLoaderSystem,} from "./gaussianSplatLoader.js";
import { createUploadUI } from "./uploadUI.js";
import { loadExistingObjects, spawnGLBFromUrl, clearSpawnedObjects } from "./objectLoader.js";
import { showCreateWorldUI } from "./createWorldUI.js";
import { fetchWorldAssets, type WorldAssets } from "./worldGenerator.js";
import { DeviceOrientationCamera } from "./deviceOrientationCamera.js";
import { createTouchGrabController } from "./touchGrabController.js";
import { createTouchLocomotion } from "./touchLocomotion.js";
import { GrabPhysicsSystem } from "./grabPhysicsSystem.js";
import { PlayerPushSystem } from "./playerPushSystem.js";
import { createVoiceCommandUI } from "./voiceCommand.js";
import { initPhotoSystem } from "./photoSystem.js";
// rainToys is now triggered from the panel UI button


// ------------------------------------------------------------
// World (IWSDK settings)
// ------------------------------------------------------------
World.create(document.getElementById("scene-container") as HTMLDivElement, {
  assets: {},
  xr: {
    sessionMode: SessionMode.ImmersiveVR,
    offer: "once",
    features: { handTracking: true },
  },
  render: {
    defaultLighting: false,
  },
  features: {
    locomotion: true,
    grabbing: true,
    physics: true,
    sceneUnderstanding: false,
  },
})
  .then(async (world) => {
    world.camera.position.set(0, 1.5, 0);
    world.scene.background = new THREE.Color(0x000000);
    world.scene.add(new THREE.AmbientLight(0xffffff, 1.0));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight.position.set(5, 10, 5);
    world.scene.add(dirLight);

    world
      .registerSystem(PanelSystem)
      .registerSystem(GaussianSplatLoaderSystem)
      .registerSystem(GrabPhysicsSystem)
      //.registerSystem(PlayerPushSystem);


    // ------------------------------------------------------------
    // Gaussian Splat
    // ------------------------------------------------------------
    const splatEntity = world.createTransformEntity();
    splatEntity.addComponent(GaussianSplatLoader, { autoLoad: false });
    initPhotoSystem(world);

    const splatSystem = world.getSystem(GaussianSplatLoaderSystem)!;

    // Play splat animation when entering XR
    world.visibilityState.subscribe((state) => {
      if (state !== VisibilityState.NonImmersive) {
        splatSystem.replayAnimation(splatEntity).catch((err) => {
          console.error("[World] Failed to replay splat animation:", err);
        });
      }
    });

    // Listen for world switch from panel UI
    let worldSwitching = false;
    let loadGeneration = 0; // tracks which load is current; stale loads are discarded

    // 3D loading text shown during world transitions
    const loadCanvas = document.createElement("canvas");
    loadCanvas.width = 512; loadCanvas.height = 128;
    const loadTexture = new THREE.CanvasTexture(loadCanvas);
    loadTexture.colorSpace = THREE.SRGBColorSpace;
    const loadMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1.0, 0.25),
      new THREE.MeshBasicMaterial({ map: loadTexture, transparent: true, depthTest: false }),
    );
    loadMesh.renderOrder = 20000;
    loadMesh.frustumCulled = false;
    loadMesh.visible = false;
    world.scene.add(loadMesh);

    let loadingDotsInterval: ReturnType<typeof setInterval> | null = null;

    function showLoadingText() {
      let dotCount = 0;
      const drawFrame = () => {
        const dotStrs = [".", "..", "..."];
        const dots = dotStrs[dotCount % 3];
        const pad = " ".repeat(3 - (dotCount % 3));
        const ctx = loadCanvas.getContext("2d")!;
        ctx.clearRect(0, 0, 512, 128);
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.beginPath();
        ctx.roundRect(8, 8, 496, 112, 20);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 36px Nunito, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(`Loading world${dots}${pad}`, 256, 64);
        loadTexture.needsUpdate = true;
        dotCount++;
      };
      drawFrame();
      loadingDotsInterval = setInterval(drawFrame, 400);

      // Position in front of camera
      const cam = world.camera;
      const _p = new THREE.Vector3();
      const _q = new THREE.Quaternion();
      cam.getWorldPosition(_p);
      cam.getWorldQuaternion(_q);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(_q);
      loadMesh.position.copy(_p).addScaledVector(fwd, 1.9);
      loadMesh.quaternion.copy(_q);
      loadMesh.visible = true;
    }

    function hideLoadingText() {
      loadMesh.visible = false;
      if (loadingDotsInterval) { clearInterval(loadingDotsInterval); loadingDotsInterval = null; }
    }

    async function switchToWorld(splatUrl: string, autoFit = false, position?: number[]) {
      // Increment generation so any in-progress load becomes stale
      const thisGen = ++loadGeneration;

      showLoadingText("Loading world...");

      clearSpawnedObjects(world.scene);

      // Force-unload whatever is currently loaded (or in-progress)
      try { await splatSystem.unload(splatEntity, { animate: false }); } catch {}

      // Configure new world
      splatEntity.setValue(GaussianSplatLoader, "splatUrl", splatUrl);
      splatEntity.setValue(GaussianSplatLoader, "autoFit", !!autoFit);
      if (splatEntity.object3D) {
        splatEntity.object3D.position.set(
          position?.[0] ?? 0, position?.[1] ?? 0, position?.[2] ?? 0,
        );
        if (splatUrl.endsWith(".splat")) {
          splatEntity.object3D.quaternion.set(1, 0, 0, 0);
        } else {
          splatEntity.object3D.quaternion.set(0, 0, 0, 1);
        }
        splatEntity.object3D.scale.setScalar(1.0);
      }

      await splatSystem.load(splatEntity, { animate: true });

      // If a newer load started while we were loading, remove ourselves (stale)
      if (loadGeneration !== thisGen) {
        try { await splatSystem.unload(splatEntity, { animate: false }); } catch {}
        hideLoadingText();
        return;
      }

      hideLoadingText();

      // Reset player position and rotation to origin after world switch
      const player = (world as any).player as THREE.Object3D | undefined;
      if (player) {
        player.position.set(0, 0, 0);
        player.quaternion.set(0, 0, 0, 1);
      }
    }

    globalThis.addEventListener("switch-world", async (e) => {
      // Force panel hidden during switch
      countdownActive = true;
      if (panelEntity.object3D) panelEntity.object3D.visible = false;
      photoStrip.visible = false;

      const { splatUrl, autoFit, position } = (e as CustomEvent).detail;
      try {
        await switchToWorld(splatUrl, autoFit, position);
      } catch (err) {
        console.error("[World] Failed to switch world:", err);
      }
      globalThis.dispatchEvent(new Event("switch-world-done"));

      // Keep UI hidden after switch — user presses Y to show
      if (panelEntity.object3D) panelEntity.object3D.visible = false;
      photoStrip.visible = false;
    });

    
    // ------------------------------------------------------------
    // Invisible floor for locomotion (must be a Mesh for IWSDK raycasting)
    // ------------------------------------------------------------
    const floorGeometry = new PlaneGeometry(100, 100);
    floorGeometry.rotateX(-Math.PI / 2);
    const floor = new Mesh(floorGeometry, new MeshBasicMaterial());
    floor.visible = false;

    // Defer floor entity creation so locomotor is initialized
    setTimeout(() => { world
      .createTransformEntity(floor)
      .addComponent(LocomotionEnvironment, { type: EnvironmentType.STATIC })
      .addComponent(PhysicsBody, { state: PhysicsState.Static })
      .addComponent(PhysicsShape, {
        shape: PhysicsShapeType.Box,
        dimensions: [100, 0.01, 100],
        friction: 0.8,
        restitution: 0.3,
      });
    }, 100);




    // ------------------------------------------------------------
    // Hologram Sphere (distance-grabbable, translate in place)
    // ------------------------------------------------------------


    // ------------------------------------------------------------
    // Mobile: gyroscope camera + touch grab/locomotion
    // ------------------------------------------------------------
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const hasXR = await navigator.xr
      ?.isSessionSupported("immersive-vr")
      .catch(() => false);

    let orientationCam: DeviceOrientationCamera | null = null;
    let touchGrab: ReturnType<typeof createTouchGrabController> | null = null;
    let touchLoco: ReturnType<typeof createTouchLocomotion> | null = null;

    if (isMobile && !hasXR) {
      // --- Touch grab + locomotion (non-XR mobile only) ---
      const sceneContainer = document.getElementById("scene-container")!;
      touchGrab = createTouchGrabController(world.camera, world.scene, sceneContainer);
      touchLoco = createTouchLocomotion(world.camera, sceneContainer);

      // --- Gyroscope ---
      orientationCam = new DeviceOrientationCamera(world.camera);

      const enableBtn = document.createElement("button");
      enableBtn.textContent = "Enable Gyroscope";
      enableBtn.style.cssText = `
        position:fixed; top:16px; left:50%; transform:translateX(-50%);
        z-index:10001; padding:12px 24px; border:none; border-radius:10px;
        background:#7b2ff2; color:#fbbf24; font-size:16px; font-weight:600;
        cursor:pointer; font-family:Nunito,sans-serif;
      `;
      document.body.appendChild(enableBtn);

      enableBtn.addEventListener("click", async () => {
        const ok = await orientationCam!.enable();
        enableBtn.remove();
        if (!ok) console.warn("[Mobile] Gyroscope permission denied");
      });

      // Pause gyroscope if the user ever enters VR (e.g. via WebXR on a future device)
      world.visibilityState.subscribe((state) => {
        if (orientationCam) {
          orientationCam.active = state === VisibilityState.NonImmersive;
        }
      });

      // Update loop for gyroscope + touch locomotion
      let prevTime = performance.now();
      const animate = () => {
        requestAnimationFrame(animate);
        const now = performance.now();
        const delta = (now - prevTime) / 1000;
        prevTime = now;

        orientationCam?.update();
        touchGrab?.update();
        touchLoco?.update(delta);
      };
      animate();
    }


    // ------------------------------------------------------------
    // Panel UI (centered on screen in desktop, positioned in 3D for XR)
    // ------------------------------------------------------------
    const panelEntity = world
      .createTransformEntity()
      .addComponent(PanelUI, {
        config: "./ui/sensai.json",
        maxHeight: 0.8,
        maxWidth: 1.6,
      })
      .addComponent(Interactable)
      .addComponent(ScreenSpace, {
        top: "30%",
        bottom: "30%",
        left: "30%",
        right: "30%",
        height: "40%",
        width: "40%",
      });
    panelEntity.object3D!.position.set(0, 1.29, -1.9);
    panelEntity.object3D!.visible = false; // hidden until world loads, press Y to show

    // ------------------------------------------------------------
    // Photo thumbnail strip — follows camera independently in XR
    // ------------------------------------------------------------
    const THUMB_W = 0.46, THUMB_H = 0.34;
    const THUMB_GAP = 0.05;
    const ROW_GAP = 0.10; // extra vertical space between the two rows
    const THUMBS_PER_ROW = 3;
    const MAX_THUMBS = 6;
    const totalStripW = THUMBS_PER_ROW * THUMB_W + (THUMBS_PER_ROW - 1) * THUMB_GAP;

    const photoStrip = new THREE.Group();
    photoStrip.visible = false;
    world.scene.add(photoStrip); // independent from panel — no ScreenSpace conflicts

    let thumbIndex = 0;

    const matProps = {
      transparent: true,
      depthTest: true,
      depthWrite: false,
      depthFunc: THREE.AlwaysDepth,
    };

    function addPhotoThumb(dataURL: string) {
      const idx = thumbIndex++;
      const col = idx % THUMBS_PER_ROW;
      const row = Math.floor(idx / THUMBS_PER_ROW);

      const x = -totalStripW / 2 + col * (THUMB_W + THUMB_GAP) + THUMB_W / 2;
      // Row 0 = top, row 1 = bottom
      const y = row === 0 ? (THUMB_H + ROW_GAP) / 2 : -((THUMB_H + ROW_GAP) / 2);

      const group = new THREE.Group();
      group.position.set(x, y, 0);

      // White polaroid frame (slightly larger, sits behind)
      const frame = new THREE.Mesh(
        new THREE.PlaneGeometry(THUMB_W + 0.02, THUMB_H + 0.05),
        new THREE.MeshBasicMaterial({ color: 0xffffff, ...matProps }),
      );
      frame.renderOrder = 10001;
      group.add(frame);

      // Photo — TextureLoader handles async natively, no black-frame race condition
      const texture = new THREE.TextureLoader().load(dataURL);
      texture.colorSpace = THREE.SRGBColorSpace;
      const photo = new THREE.Mesh(
        new THREE.PlaneGeometry(THUMB_W, THUMB_H * 0.82), // photo sits in upper part of polaroid
        new THREE.MeshBasicMaterial({ map: texture, ...matProps }),
      );
      photo.position.set(0, 0.016, 0.001); // shift up slightly, in front of frame
      photo.renderOrder = 10002;
      group.add(photo);

      photoStrip.add(group);
    }

    globalThis.addEventListener("photo-taken", (e) => {
      addPhotoThumb((e as CustomEvent).detail as string);
    });

    // 3-2-1 countdown display — large number floating in front of camera
    const cdCanvas = document.createElement("canvas");
    cdCanvas.width = 256; cdCanvas.height = 256;
    const cdTexture = new THREE.CanvasTexture(cdCanvas);
    const cdMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.6, 0.6),
      new THREE.MeshBasicMaterial({ map: cdTexture, transparent: true, depthTest: false }),
    );
    cdMesh.renderOrder = 20000;
    cdMesh.frustumCulled = false;
    cdMesh.visible = false;
    world.scene.add(cdMesh);

    let cdHideTimer: ReturnType<typeof setTimeout> | null = null;
    globalThis.addEventListener("photo-countdown", (e) => {
      const count = (e as CustomEvent).detail as number;
      const ctx = cdCanvas.getContext("2d")!;
      ctx.clearRect(0, 0, 256, 256);
      // Circle background
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.beginPath();
      ctx.arc(128, 128, 118, 0, Math.PI * 2);
      ctx.fill();
      // Number
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 150px Nunito, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(count), 128, 136);
      cdTexture.needsUpdate = true;

      cdMesh.visible = true;

      if (cdHideTimer) clearTimeout(cdHideTimer);
      cdHideTimer = setTimeout(() => { cdMesh.visible = false; }, 850);
    });

    // Viewfinder frame overlay shown during countdown
    const fCanvas = document.createElement("canvas");
    fCanvas.width = 512; fCanvas.height = 384;
    const fCtx = fCanvas.getContext("2d")!;
    // Draw corner-bracket viewfinder
    const drawFrame = () => {
      fCtx.clearRect(0, 0, 512, 384);
      const W = 512, H = 384, L = 64, T = 10;
      fCtx.strokeStyle = "#ffffff";
      fCtx.lineWidth = T;
      fCtx.lineCap = "round";
      const corners: [number, number, number, number][] = [
        [T/2, T/2, L, 0], [W-T/2, T/2, -L, 0],
        [T/2, H-T/2, L, 0], [W-T/2, H-T/2, -L, 0],
      ];
      corners.forEach(([x, y, dx]) => {
        const dy = y < H / 2 ? L : -L;
        fCtx.beginPath(); fCtx.moveTo(x + dx, y); fCtx.lineTo(x, y); fCtx.lineTo(x, y + dy);
        fCtx.stroke();
      });
    };
    drawFrame();
    const fTexture = new THREE.CanvasTexture(fCanvas);
    const fMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1.8, 1.35), // 4:3 ratio
      new THREE.MeshBasicMaterial({ map: fTexture, transparent: true, depthTest: false }),
    );
    fMesh.renderOrder = 19999;
    fMesh.frustumCulled = false;
    fMesh.visible = false;
    world.scene.add(fMesh);

    let countdownActive = false;

    globalThis.addEventListener("countdown-start", () => {
      if (panelEntity.object3D) panelEntity.object3D.visible = false;
      photoStrip.visible = false;
      countdownActive = true;
      fMesh.visible = true;
    });

    globalThis.addEventListener("hide-ui", () => {
      if (panelEntity.object3D) panelEntity.object3D.visible = false;
      photoStrip.visible = false;
      countdownActive = true;
    });

    // XR celebration message when all 6 photos are taken
    const celebCanvas = document.createElement("canvas");
    celebCanvas.width = 768; celebCanvas.height = 512;
    const celebTexture = new THREE.CanvasTexture(celebCanvas);
    celebTexture.colorSpace = THREE.SRGBColorSpace;
    const celebMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1.4, 0.93),
      new THREE.MeshBasicMaterial({ map: celebTexture, transparent: true, depthTest: false }),
    );
    celebMesh.renderOrder = 20000;
    celebMesh.frustumCulled = false;
    celebMesh.visible = false;
    world.scene.add(celebMesh);

    // Photo strip display — shown briefly after celebration
    const stripCanvas = document.createElement("canvas");
    stripCanvas.width = 960; stripCanvas.height = 800;
    const stripTexture = new THREE.CanvasTexture(stripCanvas);
    stripTexture.colorSpace = THREE.SRGBColorSpace;
    const stripMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1.4, 1.17),
      new THREE.MeshBasicMaterial({ map: stripTexture, transparent: true, depthTest: false }),
    );
    stripMesh.renderOrder = 20000;
    stripMesh.frustumCulled = false;
    stripMesh.visible = false;
    world.scene.add(stripMesh);

    function showPhotoStripDisplay(photos: string[]) {
      const W = 960, H = 800;
      const ctx = stripCanvas.getContext("2d")!;
      ctx.clearRect(0, 0, W, H);

      // Gradient background
      const bg = ctx.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, "rgba(255,248,240,0.94)");
      bg.addColorStop(1, "rgba(240,230,255,0.94)");
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.roundRect(8, 8, W - 16, H - 16, 28);
      ctx.fill();

      // Rainbow border
      const borderGrad = ctx.createLinearGradient(0, 0, W, 0);
      borderGrad.addColorStop(0, "#3aaa35");
      borderGrad.addColorStop(0.33, "#5ba3d9");
      borderGrad.addColorStop(0.66, "#e53935");
      borderGrad.addColorStop(1, "#7b2ff2");
      ctx.strokeStyle = borderGrad;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(8, 8, W - 16, H - 16, 28);
      ctx.stroke();

      // Layout: 3 columns x 2 rows — load logo + measure first image aspect ratio
      const cols = 3, rows = 2;
      const padX = 40;
      const gap = 16;
      const photoInset = 8;
      const labelH = 22;
      const logoH = 180;
      const padYTop = 30 + logoH + 16; // top padding + logo + gap below logo
      const padYBottom = 30;

      // Load YUME logo and first photo to get aspect ratio
      const logoImg = new Image();
      logoImg.src = "/Yume.png";
      const probeImg = new Image();
      probeImg.src = photos[0];

      let logoLoaded = false, probeLoaded = false;
      const onBothReady = () => {
        if (!logoLoaded || !probeLoaded) return;
        const photoAspect = probeImg.naturalWidth / probeImg.naturalHeight;
        const photoW = (W - padX * 2 - gap * (cols - 1) - photoInset * 2 * cols) / cols;
        const photoH = photoW / photoAspect;
        const cellW = photoW + photoInset * 2;
        const cellH = photoH + photoInset + labelH;

        // Draw YUME logo centered at top
        const logoW = logoH * (logoImg.naturalWidth / logoImg.naturalHeight);
        ctx.drawImage(logoImg, (W - logoW) / 2, 28, logoW, logoH);

      let loaded = 0;
      photos.forEach((dataURL, i) => {
        const img = new Image();
        img.onload = () => {
          const col = i % cols;
          const row = Math.floor(i / cols);
          const x = padX + col * (cellW + gap);
          const y = padYTop + row * (cellH + gap);
          const rotations = [-2, 1.5, -1, 2, -1.5, 1];
          const rot = (rotations[i] ?? 0) * Math.PI / 180;

          ctx.save();
          ctx.translate(x + cellW / 2, y + cellH / 2);
          ctx.rotate(rot);

          // Polaroid shadow
          ctx.shadowColor = "rgba(0,0,0,0.15)";
          ctx.shadowBlur = 10;
          ctx.shadowOffsetY = 4;

          // White polaroid frame
          ctx.fillStyle = "#fff";
          ctx.beginPath();
          ctx.roundRect(-cellW / 2, -cellH / 2, cellW, cellH, 4);
          ctx.fill();
          ctx.shadowBlur = 0;

          // Photo inside frame — correct aspect ratio
          ctx.drawImage(img, -cellW / 2 + photoInset, -cellH / 2 + photoInset, photoW, photoH);

          // Label
          ctx.fillStyle = "#7b2ff2";
          ctx.font = "bold 14px Nunito, sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(`#${i + 1}`, 0, cellH / 2 - 6);

          ctx.restore();

          loaded++;
          if (loaded === photos.length) {
            stripTexture.needsUpdate = true;
          }
        };
        img.src = dataURL;
      });
      }; // end onBothReady
      logoImg.onload = () => { logoLoaded = true; onBothReady(); };
      probeImg.onload = () => { probeLoaded = true; onBothReady(); };

      // Position in front of camera (world-space for XR locomotion)
      const cam = world.camera;
      const _sPos = new THREE.Vector3();
      const _sQuat = new THREE.Quaternion();
      cam.getWorldPosition(_sPos);
      cam.getWorldQuaternion(_sQuat);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(_sQuat);
      stripMesh.position.copy(_sPos).addScaledVector(fwd, 1.7);
      stripMesh.quaternion.copy(_sQuat);
      stripMesh.visible = true;
    }

    globalThis.addEventListener("photos-complete", (e) => {
      const photos = (e as CustomEvent).detail as string[];
      const W = 768, H = 512;
      const ctx = celebCanvas.getContext("2d")!;
      ctx.clearRect(0, 0, W, H);

      // Gradient background with rounded corners
      const bg = ctx.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, "rgba(255,248,240,0.94)");
      bg.addColorStop(1, "rgba(240,230,255,0.94)");
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.roundRect(12, 12, W - 24, H - 24, 32);
      ctx.fill();

      // Subtle border with YUME gradient
      const borderGrad = ctx.createLinearGradient(0, 0, W, 0);
      borderGrad.addColorStop(0, "#3aaa35");
      borderGrad.addColorStop(0.33, "#5ba3d9");
      borderGrad.addColorStop(0.66, "#e53935");
      borderGrad.addColorStop(1, "#7b2ff2");
      ctx.strokeStyle = borderGrad;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.roundRect(12, 12, W - 24, H - 24, 32);
      ctx.stroke();

      // Decorative sparkles
      const sparkles = [[120, 80], [650, 90], [100, 420], [670, 400], [384, 60], [200, 130], [580, 130]];
      const sparkleColors = ["#3aaa35", "#5ba3d9", "#e53935", "#7b2ff2", "#f59e0b", "#3aaa35", "#e53935"];
      sparkles.forEach(([x, y], i) => {
        ctx.save();
        ctx.translate(x, y);
        ctx.fillStyle = sparkleColors[i];
        ctx.globalAlpha = 0.6;
        const size = 6 + Math.random() * 6;
        // 4-point star
        ctx.beginPath();
        ctx.moveTo(0, -size);
        ctx.lineTo(size * 0.3, -size * 0.3);
        ctx.lineTo(size, 0);
        ctx.lineTo(size * 0.3, size * 0.3);
        ctx.lineTo(0, size);
        ctx.lineTo(-size * 0.3, size * 0.3);
        ctx.lineTo(-size, 0);
        ctx.lineTo(-size * 0.3, -size * 0.3);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      });

      // Title — each word in a different YUME color
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "bold 52px Nunito, sans-serif";
      const titleGrad = ctx.createLinearGradient(200, 0, 568, 0);
      titleGrad.addColorStop(0, "#3aaa35");
      titleGrad.addColorStop(0.35, "#5ba3d9");
      titleGrad.addColorStop(0.65, "#e53935");
      titleGrad.addColorStop(1, "#7b2ff2");
      ctx.fillStyle = titleGrad;
      ctx.fillText("Dreams Captured!", W / 2, 200);

      // Divider line with gradient
      const divGrad = ctx.createLinearGradient(W * 0.25, 0, W * 0.75, 0);
      divGrad.addColorStop(0, "rgba(123,47,242,0)");
      divGrad.addColorStop(0.5, "rgba(123,47,242,0.4)");
      divGrad.addColorStop(1, "rgba(123,47,242,0)");
      ctx.strokeStyle = divGrad;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(W * 0.2, 250);
      ctx.lineTo(W * 0.8, 250);
      ctx.stroke();

      // Subtitle
      ctx.font = "28px Nunito, sans-serif";
      ctx.fillStyle = "#7b6b8a";
      ctx.fillText("Photos saved to your device", W / 2, 310);

      // YUME logo with rainbow gradient at bottom
      const yumeImg = new Image();
      yumeImg.src = "/Yume_BW.png";
      yumeImg.onload = () => {
        // Draw logo onto a temp canvas, then apply gradient via composite
        const logoH = 70;
        const logoW = logoH * (yumeImg.width / yumeImg.height);
        const logoX = (W - logoW) / 2;
        const logoY = 370 - logoH / 2;

        const tmp = document.createElement("canvas");
        tmp.width = W; tmp.height = H;
        const tctx = tmp.getContext("2d")!;
        tctx.drawImage(yumeImg, logoX, logoY, logoW, logoH);
        // Replace black pixels with rainbow gradient
        tctx.globalCompositeOperation = "source-in";
        const logoGrad = tctx.createLinearGradient(logoX, 0, logoX + logoW, 0);
        logoGrad.addColorStop(0, "#3aaa35");
        logoGrad.addColorStop(0.33, "#5ba3d9");
        logoGrad.addColorStop(0.66, "#e53935");
        logoGrad.addColorStop(1, "#7b2ff2");
        tctx.fillStyle = logoGrad;
        tctx.fillRect(0, 0, W, H);

        ctx.drawImage(tmp, 0, 0);
        celebTexture.needsUpdate = true;
      };

      celebTexture.needsUpdate = true;

      // Position in front of camera (world-space for XR locomotion)
      const cam = world.camera;
      const _cPos = new THREE.Vector3();
      const _cQuat = new THREE.Quaternion();
      cam.getWorldPosition(_cPos);
      cam.getWorldQuaternion(_cQuat);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(_cQuat);
      celebMesh.position.copy(_cPos).addScaledVector(fwd, 1.7);
      celebMesh.quaternion.copy(_cQuat);
      celebMesh.visible = true;

      // Hide UI while celebration shows
      countdownActive = true;

      // After 4 seconds: hide celebration, show photo strip
      setTimeout(() => {
        celebMesh.visible = false;
        showPhotoStripDisplay(photos);

        // After another 5 seconds: hide strip, reset photos, keep UI hidden (press Y)
        setTimeout(() => {
          stripMesh.visible = false;
          globalThis.dispatchEvent(new Event("photos-reset"));
          // countdownActive stays true — press Y to bring UI back
        }, 5000);
      }, 4000);
    });

    // Hide UI during capture so it doesn't appear in the photo
    globalThis.addEventListener("pre-capture", () => {
      // Move entire panel + strip subtree to layer 31 so photo camera can't see them
      if (panelEntity.object3D) {
        panelEntity.object3D.traverse((obj) => { obj.layers.set(31); });
      }
      photoStrip.traverse((obj) => { obj.layers.set(31); });
      countdownActive = false;
      fMesh.visible = false;
    });
    globalThis.addEventListener("post-capture", () => {
      // Restore panel + strip back to layer 0
      if (panelEntity.object3D) {
        panelEntity.object3D.traverse((obj) => { obj.layers.set(0); });
        panelEntity.object3D.visible = panelVisible;
      }
      photoStrip.traverse((obj) => { obj.layers.set(0); });
      photoStrip.visible = thumbIndex > 0;
    });

    // Reset photo system for another round
    globalThis.addEventListener("photos-reset", () => {
      thumbIndex = 0;
      // Remove all thumbnail children from the strip
      while (photoStrip.children.length > 0) {
        photoStrip.remove(photoStrip.children[0]);
      }
      photoStrip.visible = false;
    });

    // In XR: panel + photo strip both follow the player's head each frame
    const _panelFwd  = new THREE.Vector3();
    const _camWorldPos  = new THREE.Vector3();
    const _camWorldQuat = new THREE.Quaternion();
    const _panelPollMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.001, 0.001),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false }),
    );
    _panelPollMesh.frustumCulled = false;
    world.scene.add(_panelPollMesh);
    // Toggle panel visibility with left controller Y button (XR) or H key (browser)
    let menuBtnWasPressed = false;
    let panelVisible = false; // hidden by default, press Y or H to show

    const togglePanel = () => {
      panelVisible = !panelVisible;
      countdownActive = false; // clear any hide-ui / countdown state
      if (panelEntity.object3D) panelEntity.object3D.visible = panelVisible;
      photoStrip.visible = panelVisible && thumbIndex > 0;
    };

    globalThis.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "h" || (e as KeyboardEvent).key === "H") togglePanel();
    });

    _panelPollMesh.onBeforeRender = () => {
      const isXR = (world.renderer as THREE.WebGLRenderer).xr.isPresenting;
      if (!isXR || !panelEntity.object3D) {
        photoStrip.visible = false;
        if (panelEntity.object3D) panelEntity.object3D.visible = !countdownActive && panelVisible;
        return;
      }

      // Keep viewfinder frame, countdown number, and loading text in front of camera
      if (countdownActive || fMesh.visible || cdMesh.visible || loadMesh.visible) {
        const cam = world.camera;
        const _cdPos = new THREE.Vector3();
        const _cdQuat = new THREE.Quaternion();
        cam.getWorldPosition(_cdPos);
        cam.getWorldQuaternion(_cdQuat);
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(_cdQuat);
        const base = _cdPos.clone().addScaledVector(fwd, 1.8);
        fMesh.position.copy(base);
        fMesh.quaternion.copy(_cdQuat);
        if (loadMesh.visible) {
          loadMesh.position.copy(_cdPos).addScaledVector(fwd, 1.9);
          loadMesh.quaternion.copy(_cdQuat);
        }
        cdMesh.position.copy(base);
        cdMesh.quaternion.copy(_cdQuat);
      }

      // Poll left controller menu button to toggle panel
      const session = (world.renderer as THREE.WebGLRenderer).xr.getSession();
      if (session) {
        for (const source of session.inputSources) {
          if (source.handedness === "left" && source.gamepad) {
            const btn = source.gamepad.buttons[5]; // Y button on Meta Quest left controller
            if (btn?.pressed && !menuBtnWasPressed) togglePanel();
            menuBtnWasPressed = btn?.pressed ?? false;
          }
        }
      }

      // Use world-space position/quaternion so scene-level objects are placed correctly
      const cam = world.camera;
      cam.getWorldPosition(_camWorldPos);
      cam.getWorldQuaternion(_camWorldQuat);
      _panelFwd.set(0, 0, -1).applyQuaternion(_camWorldQuat);

      // Panel: 1.5 m ahead, slightly below eye level
      panelEntity.object3D.position
        .copy(_camWorldPos)
        .addScaledVector(_panelFwd, 2.0)
        .setY(_camWorldPos.y + 0.1);
      panelEntity.object3D.quaternion.copy(_camWorldQuat);

      // Photo strip: sit directly below the panel using its computed world position
      const uiVisible = panelVisible && !countdownActive;
      photoStrip.visible = uiVisible && thumbIndex > 0;
      panelEntity.object3D.visible = uiVisible;
      if (uiVisible && thumbIndex > 0) {
        panelEntity.object3D.updateWorldMatrix(true, false);
        const panelWorldY = panelEntity.object3D.getWorldPosition(_camWorldPos.clone()).y;
        photoStrip.position
          .copy(panelEntity.object3D.getWorldPosition(new THREE.Vector3()))
          .setY(panelWorldY - 1.10); // compensated to keep strip at same position
        photoStrip.quaternion.copy(_camWorldQuat);
      }
    };

    // ------------------------------------------------------------
    // World loading / creation flow
    // ------------------------------------------------------------
    const params = new URLSearchParams(window.location.search);
    const worldId = params.get("world_id");
    const apiBase =
      params.get("api") ||
      (import.meta as any).env?.VITE_YUME_API_BASE ||
      "";

    async function loadWorldSplat(assets: WorldAssets) {
      const splatUrl = assets.splatUrl.startsWith("http")
        ? assets.splatUrl
        : `${apiBase}${assets.splatUrl}`;
      splatEntity.setValue(GaussianSplatLoader, "splatUrl", splatUrl);
      if (assets.colliderUrl) {
        const meshUrl = assets.colliderUrl.startsWith("http")
          ? assets.colliderUrl
          : `${apiBase}${assets.colliderUrl}`;
        splatEntity.setValue(GaussianSplatLoader, "meshUrl", meshUrl);
      }
      await splatSystem.load(splatEntity, { animate: true });
    }

    const directSplat = params.get("splat") || "./splats/Yume World (6)_room.spz";

    if (directSplat) {
      // Direct splat URL: load it immediately, skip create UI
      // Fullscreen loading overlay — covers everything including IWSDK ScreenSpace panel
      const loadingOverlay = document.createElement("div");
      loadingOverlay.style.cssText = `
        position:fixed; inset:0; z-index:99999; background:#000;
        display:flex; align-items:center; justify-content:center;
        font-family:Nunito,sans-serif;
      `;
      const loadingLabel = document.createElement("div");
      loadingLabel.textContent = "Loading world.";
      loadingLabel.style.cssText = `color:#fff; font-size:24px; font-weight:700;`;
      loadingOverlay.appendChild(loadingLabel);
      document.body.appendChild(loadingOverlay);
      let overlayDots = 0;
      const overlayDotsInterval = setInterval(() => {
        overlayDots++;
        const d = (overlayDots % 3) + 1;
        loadingLabel.innerHTML = `Loading world${".".repeat(d)}<span style="visibility:hidden">${".".repeat(3 - d)}</span>`;
      }, 400);

      countdownActive = true;
      const defaultPos = directSplat.includes("room") ? [0, 0.94, 0] : directSplat.includes("treehouse") ? [0, 0.14, 0] : undefined;
      switchToWorld(directSplat, false, defaultPos)
        .catch((err) => console.error("[World] Default world load failed:", err))
        .then(async () => {
          clearInterval(overlayDotsInterval);
          loadingOverlay.remove();
          // Load GLB models
          const testGlb = params.get("glb") || "./SM_Aligator.glb";
          if (testGlb) {
            spawnGLBFromUrl(world, testGlb).catch((err) =>
              console.error("[World] Failed to load test GLB:", err),
            );
          }

          // Gothic Fox – placed to the left
          spawnGLBFromUrl(world, "./GothicFox.glb", new THREE.Vector3(-1.5, 0.5, -2)).catch((err) =>
            console.error("[World] Failed to load GothicFox:", err),
          );

          // Cute Fox – placed to the right
          spawnGLBFromUrl(world, "./CuteFox.glb", new THREE.Vector3(1.5, 0.5, -2)).catch((err) =>
            console.error("[World] Failed to load CuteFox:", err),
          );

          // Use existing world_id or create one via test endpoint for Meshy upload
          let splatWorldId: string = worldId || "";
          if (!splatWorldId && apiBase) {
            try {
              const resp = await fetch(`${apiBase}/api/test/create-world`, { method: "POST" });
              if (resp.ok) {
                const data = await resp.json();
                splatWorldId = data.world_id;
                const newParams = new URLSearchParams(window.location.search);
                newParams.set("world_id", splatWorldId);
                history.replaceState(null, "", `${window.location.pathname}?${newParams}`);
              }
            } catch (err) {
              console.warn("[World] Could not create world for Meshy:", err);
            }
          }
          if (splatWorldId) {
            createUploadUI(world, splatWorldId);
            createVoiceCommandUI(world, splatWorldId, apiBase);
            loadExistingObjects(world, splatWorldId, apiBase);
          } else {
            // No backend, still enable voice with local assets
            createVoiceCommandUI(world, "", apiBase);
          }
        })
        .catch((err) => {
          console.error("[World] Failed to load direct splat:", err);
        });
    } else if (worldId) {
      // Existing world: fetch assets and load
      fetchWorldAssets(apiBase, worldId)
        .then((assets) => loadWorldSplat(assets))
        .catch((err) => {
          console.warn("[World] Failed to load world assets, falling back to default splat:", err);
          splatEntity.setValue(GaussianSplatLoader, "splatUrl", "./splats/sensai.spz");
          splatSystem.load(splatEntity, { animate: true });
        })
        .then(() => {
          createUploadUI(world, worldId);
          loadExistingObjects(world, worldId, apiBase);
        });
    } else {
      // No world_id: show create UI
      showCreateWorldUI(apiBase)
        .then(({ worldId: newWorldId, assets }) => {
          // Update URL so refresh goes to the existing-world branch
          const newParams = new URLSearchParams(window.location.search);
          newParams.set("world_id", newWorldId);
          newParams.set("api", apiBase);
          history.replaceState(null, "", `${window.location.pathname}?${newParams}`);

          return loadWorldSplat(assets).then(() => {
            createUploadUI(world, newWorldId);
            loadExistingObjects(world, newWorldId, apiBase);
          });
        })
        .catch((err) => {
          console.error("[World] Create world flow failed:", err);
        });
    }

  })
  .catch((err) => {
    console.error("[World] Failed to create the IWSDK world:", err);
    const container = document.getElementById("scene-container");
  });

  
