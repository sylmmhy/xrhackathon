
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
    initPhotoSystem(world);
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
    globalThis.addEventListener("switch-world", async (e) => {
      clearSpawnedObjects(world.scene);
      const { splatUrl, autoFit, position } = (e as CustomEvent).detail;
      try {
        await splatSystem.unload(splatEntity, { animate: true });
        splatEntity.setValue(GaussianSplatLoader, "splatUrl", splatUrl);
        splatEntity.setValue(GaussianSplatLoader, "autoFit", !!autoFit);
        if (position && splatEntity.object3D) {
          splatEntity.object3D.position.set(position[0], position[1], position[2]);
        } else if (splatEntity.object3D) {
          splatEntity.object3D.position.set(0, 0, 0);
        }
        // Apply orientation fix on parent BEFORE load so it's correct during animation
        if (splatUrl.includes("world_500k") && splatEntity.object3D) {
          splatEntity.object3D.quaternion.set(1, 0, 0, 0);
          splatEntity.object3D.scale.setScalar(1.0);
          splatEntity.object3D.position.y = 0.05;
        } else if (splatEntity.object3D) {
          splatEntity.object3D.quaternion.set(0, 0, 0, 1); // identity
          splatEntity.object3D.scale.setScalar(1.0);
        }
        await splatSystem.load(splatEntity, { animate: true });
      } catch (err) {
        console.error("[World] Failed to switch world:", err);
      }
      globalThis.dispatchEvent(new Event("switch-world-done"));
    });

    
    // ------------------------------------------------------------
    // Invisible floor for locomotion (must be a Mesh for IWSDK raycasting)
    // ------------------------------------------------------------
    const floorGeometry = new PlaneGeometry(100, 100);
    floorGeometry.rotateX(-Math.PI / 2);
    const floor = new Mesh(floorGeometry, new MeshBasicMaterial());
    floor.visible = false;
    world
      .createTransformEntity(floor)
      .addComponent(LocomotionEnvironment, { type: EnvironmentType.STATIC })
      .addComponent(PhysicsBody, { state: PhysicsState.Static })
      .addComponent(PhysicsShape, {
        shape: PhysicsShapeType.Box,
        dimensions: [100, 0.01, 100],
        friction: 0.8,
        restitution: 0.3,
      });




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

    // Hide UI during capture so it doesn't appear in the photo
    globalThis.addEventListener("pre-capture", () => {
      if (panelEntity.object3D) panelEntity.object3D.visible = false;
      photoStrip.visible = false;
      countdownActive = false;
      fMesh.visible = false;
    });
    globalThis.addEventListener("post-capture", () => {
      if (panelEntity.object3D) panelEntity.object3D.visible = panelVisible;
      photoStrip.visible = thumbIndex > 0;
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
    let panelVisible = true;

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

      // Keep viewfinder frame + countdown number in front of camera during countdown
      if (countdownActive || fMesh.visible || cdMesh.visible) {
        const cam = world.camera;
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
        const base = cam.position.clone().addScaledVector(fwd, 1.4);
        fMesh.position.copy(base);
        fMesh.quaternion.copy(cam.quaternion);
        cdMesh.position.copy(base);
        cdMesh.quaternion.copy(cam.quaternion);
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
        .addScaledVector(_panelFwd, 1.5)
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

    const directSplat = params.get("splat") || "./splats/world_500k_edit_6_4.splat";

    if (directSplat) {
      // Direct splat URL: load it immediately, skip create UI
      splatEntity.setValue(GaussianSplatLoader, "splatUrl", directSplat);
      // Apply orientation fix on parent BEFORE load so it's correct during animation
      if (splatEntity.object3D) {
        splatEntity.object3D.quaternion.set(1, 0, 0, 0);
        splatEntity.object3D.scale.setScalar(1.0);
        splatEntity.object3D.position.y = 0.05;
      }
      splatSystem.load(splatEntity, { animate: true })
        .then(async () => {
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
          if (!splatWorldId) {
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

  
