import {
  createSystem,
  Entity,
  PanelUI,
  PanelDocument,
  eq,
  VisibilityState,
  UIKitDocument,
  UIKit,
} from "@iwsdk/core";
import * as THREE from "three";
import { rainToys } from "./vrRainButton.js";

// Render UI on top of splats using AlwaysDepth + high renderOrder.
// depthWrite stays true so the IWSDK laser pointer depth-tests correctly
// against the panel surface (depthTest=false would break it).

const UI_RENDER_ORDER = 10_000;
const APPLIED_FLAG = "__uiDepthConfigApplied";

function configureUIMaterial(material: THREE.Material | null | undefined) {
  if (!material) return;
  material.depthTest = true;
  material.depthWrite = true;
  material.depthFunc = THREE.AlwaysDepth;

  // Use texture alpha for images (e.g. logo) so transparent pixels don’t show black
  if (material instanceof THREE.MeshBasicMaterial && material.map) {
    material.transparent = true;
    material.alphaTest = 0.01;
  }
}

function applyRenderOrderToObject(object3D: THREE.Object3D) {
  object3D.traverse((obj) => {
    obj.renderOrder = UI_RENDER_ORDER;

    if (obj instanceof THREE.Mesh) {
      if (obj.userData[APPLIED_FLAG]) return;
      obj.userData[APPLIED_FLAG] = true;

      if (Array.isArray(obj.material)) {
        obj.material.forEach((m) => configureUIMaterial(m));
      } else {
        configureUIMaterial(obj.material);
      }

      // Re-apply every render in case IWSDK replaces materials
      const originalOnBeforeRender = obj.onBeforeRender;
      obj.onBeforeRender = function (
        renderer,
        scene,
        camera,
        geometry,
        material,
        group,
      ) {
        configureUIMaterial(material as THREE.Material);
        if (typeof originalOnBeforeRender === "function") {
          originalOnBeforeRender.call(
            this,
            renderer,
            scene,
            camera,
            geometry,
            material,
            group,
          );
        }
      };
    }
  });
}

/**
 * Force an entity's UI meshes to render on top of Gaussian Splats.
 * Retries for up to 10 frames since IWSDK may not have built the
 * panel meshes yet at qualify time.
 */
export function makeEntityRenderOnTop(entity: Entity): void {
  let attempts = 0;

  const tryApply = () => {
    if (entity.object3D) {
      applyRenderOrderToObject(entity.object3D);
      return;
    }
    if (++attempts < 10) {
      requestAnimationFrame(tryApply);
    } else {
      console.warn(
        `[Panel] makeEntityRenderOnTop: entity ${entity.index} had no object3D after 10 frames.`,
      );
    }
  };

  tryApply();
}

export class PanelSystem extends createSystem({
  sensaiPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, "config", "./ui/sensai.json")],
  },
}) {
  init() {
    // replayExisting: true so we run setup for entities that already qualified
    // (e.g. when PanelDocument loads before or in the same tick as init).
    this.queries.sensaiPanel.subscribe("qualify", (entity) => {
      makeEntityRenderOnTop(entity);

      const document = PanelDocument.data.document[
        entity.index
      ] as UIKitDocument;
      if (!document) return;

      const xrButton = document.getElementById("xr-button") as UIKit.Text;
      let xrSupported = false;

      const updateButtonText = (visibilityState: VisibilityState) => {
        if (!xrSupported) {
          xrButton.setProperties({ text: "View World" });
          return;
        }

        xrButton.setProperties({
          text:
            visibilityState === VisibilityState.NonImmersive
              ? "Enter XR"
              : "Exit to Browser",
        });
      };

      const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

      // Keep the panel in non-XR mode when immersive sessions are unavailable.
      const xrCheck = navigator.xr
        ? navigator.xr
            .isSessionSupported("immersive-vr")
            .catch(() => false)
        : Promise.resolve(false);

      xrCheck.then((supported) => {
        xrSupported = !!supported;
        updateButtonText(this.world.visibilityState.value);

        // No XR support: the 3D panel can't receive input
        // (IWSDK UIKit buttons need XR controller rays or IWER).
        // On localhost IWER handles it; elsewhere hide panel + show DOM button.
        const isLocalhost = globalThis.location.hostname === "localhost"
          || globalThis.location.hostname === "127.0.0.1";

        if (!xrSupported && !isLocalhost) {
          // Aggressively hide the 3D panel — IWSDK may re-enable it
          const forceHide = () => {
            if (entity.object3D) {
              entity.object3D.visible = false;
              entity.object3D.scale.set(0, 0, 0);
            }
          };
          forceHide();
          // Retry for 30 frames in case IWSDK rebuilds/re-shows the panel
          let hideAttempts = 0;
          const keepHidden = () => {
            forceHide();
            if (++hideAttempts < 30) requestAnimationFrame(keepHidden);
          };
          requestAnimationFrame(keepHidden);

          const domBtn = globalThis.document.createElement("button");
          domBtn.textContent = "View World";
          domBtn.style.cssText = `
            position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
            z-index:10002; padding:18px 56px; border:none; border-radius:14px;
            background:#fbbf24; color:#1a1a2e; font-size:22px; font-weight:700;
            cursor:pointer; font-family:-apple-system,sans-serif;
            box-shadow:0 4px 24px rgba(0,0,0,0.5);
          `;
          globalThis.document.body.appendChild(domBtn);

          domBtn.addEventListener("click", () => {
            domBtn.remove();
          });
        }
      });

      xrButton.addEventListener("click", async () => {
        if (!xrSupported) {
          // Hide the panel so the user can view the 3D scene
          if (entity.object3D) entity.object3D.visible = false;
          return;
        }

        if (this.world.visibilityState.value === VisibilityState.NonImmersive) {
          try {
            await this.world.launchXR();
          } catch (err) {
            console.warn("[Panel] XR not available on this device:", err);
          }
        } else {
          this.world.exitXR();
        }
      });

      this.world.visibilityState.subscribe((visibilityState) => {
        updateButtonText(visibilityState);
      });

      // Rain button
      const rainButton = document.getElementById("rain-button") as UIKit.Text;
      if (rainButton) {
        let lastRain = 0;
        rainButton.addEventListener("click", () => {
          const now = Date.now();
          if (now - lastRain < 8000) return;
          lastRain = now;
          rainButton.setProperties({ text: "Raining!" });
          rainToys(this.world, 15);
          setTimeout(() => rainButton.setProperties({ text: "Rain Toys" }), 3000);
        });
      }

      // World switch button
      const worldButton = document.getElementById("world-button") as UIKit.Text;
      if (worldButton) {
        const worlds = [
          { name: "Disney Castle", url: "./splats/disney_castle.spz", autoFit: false, position: [0, 0, 0], walls: false },
          { name: "Yume World", url: "./splats/world_500k_edit_6_4.splat", autoFit: false, position: [0, 0, 0], walls: false },
        ];
        let currentWorldIndex = 0;
        let switching = false;

        worldButton.setProperties({ text: `World: ${worlds[0].name}` });

        worldButton.addEventListener("click", () => {
          if (switching) return;
          switching = true;
          currentWorldIndex = (currentWorldIndex + 1) % worlds.length;
          const next = worlds[currentWorldIndex];
          worldButton.setProperties({ text: "Loading..." });
          globalThis.dispatchEvent(
            new CustomEvent("switch-world", {
              detail: { splatUrl: next.url, autoFit: next.autoFit, position: next.position, walls: next.walls },
            }),
          );
          // Listen for completion
          const onDone = () => {
            switching = false;
            worldButton.setProperties({ text: `World: ${next.name}` });
            globalThis.removeEventListener("switch-world-done", onDone);
          };
          globalThis.addEventListener("switch-world-done", onDone);
        });
      }
    }, true);
  }
}
