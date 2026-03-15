
import * as THREE from "three";
import {
  EnvironmentType,
  Interactable,
  LocomotionEnvironment,
  Mesh,
  MeshBasicMaterial,
  PanelUI,
  PlaneGeometry,
  ScreenSpace,
  SessionMode,
  VisibilityState,
  World,
} from "@iwsdk/core";
import { PanelSystem } from "./uiPanel.js";
import { GaussianSplatLoader, GaussianSplatLoaderSystem,} from "./gaussianSplatLoader.js";
import { spawnHologramSphere } from "./interactableExample.js";
import { createUploadUI } from "./uploadUI.js";
import { loadExistingObjects, spawnGLBFromUrl } from "./objectLoader.js";
import { showCreateWorldUI } from "./createWorldUI.js";
import { fetchWorldAssets, type WorldAssets } from "./worldGenerator.js";
import { DeviceOrientationCamera } from "./deviceOrientationCamera.js";
import { createTouchGrabController } from "./touchGrabController.js";
import { createTouchLocomotion } from "./touchLocomotion.js";


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
    physics: false,
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
      .registerSystem(GaussianSplatLoaderSystem);


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

    
    // ------------------------------------------------------------
    // Invisible floor for locomotion (must be a Mesh for IWSDK raycasting)
    // ------------------------------------------------------------
    const floorGeometry = new PlaneGeometry(100, 100);
    floorGeometry.rotateX(-Math.PI / 2);
    const floor = new Mesh(floorGeometry, new MeshBasicMaterial());
    floor.visible = false;
    world
      .createTransformEntity(floor)
      .addComponent(LocomotionEnvironment, { type: EnvironmentType.STATIC });

    const grid = new THREE.GridHelper(100, 100, 0x444444, 0x222222);
    grid.material.transparent = true;
    grid.material.opacity = 0.4;
    world.scene.add(grid);


    // ------------------------------------------------------------
    // Hologram Sphere (distance-grabbable, translate in place)
    // ------------------------------------------------------------
    spawnHologramSphere(world);


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
        cursor:pointer; font-family:-apple-system,sans-serif;
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

    const directSplat = params.get("splat") || "./splats/disney_castle.spz";

    if (directSplat) {
      // Direct splat URL: load it immediately, skip create UI
      splatEntity.setValue(GaussianSplatLoader, "splatUrl", directSplat);
      splatSystem.load(splatEntity, { animate: true })
        .then(async () => {
          // Load GLB model (default: alligator)
          const testGlb = params.get("glb") || "./SM_Aligator.glb";
          if (testGlb) {
            spawnGLBFromUrl(world, testGlb).catch((err) =>
              console.error("[World] Failed to load test GLB:", err),
            );
          }

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
            loadExistingObjects(world, splatWorldId, apiBase);
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

  
