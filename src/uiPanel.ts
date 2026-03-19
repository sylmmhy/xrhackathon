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

      // Rain button
      const rainButton = document.getElementById("rain-button") as UIKit.Text;
      if (rainButton) {
        let lastRain = 0;
        rainButton.addEventListener("click", () => {
          const now = Date.now();
          if (now - lastRain < 8000) return;
          lastRain = now;
          rainButton.setProperties({ text: "Raining!" });
          globalThis.dispatchEvent(new Event("hide-ui")); // hide UI while raining
          rainToys(this.world);
          setTimeout(() => rainButton.setProperties({ text: "Rain Toys" }), 3000);
        });
      }

      // Photo button with 3-2-1 countdown
      const photoButton = document.getElementById("photo-button") as UIKit.Text;
      if (photoButton) {
        let photoCount = 0;
        let countingDown = false;

        photoButton.addEventListener("click", () => {
          if (photoCount >= 6 || countingDown) return;
          countingDown = true;

          globalThis.dispatchEvent(new Event("countdown-start"));

          let remaining = 3;
          const tick = () => {
            if (remaining > 0) {
              photoButton.setProperties({ text: `${remaining}` });
              globalThis.dispatchEvent(new CustomEvent("photo-countdown", { detail: remaining }));
              remaining--;
              setTimeout(tick, 1000);
            } else {
              countingDown = false;
              globalThis.dispatchEvent(new Event("take-photo"));
            }
          };
          tick();
        });

        globalThis.addEventListener("photo-count", (e) => {
          photoCount = (e as CustomEvent).detail;
          photoButton.setProperties({ text: photoCount >= 6 ? "Done!" : `Photo ${photoCount}/6` });
        });
      }

      // Next World button — cycles through all worlds in order
      const worldButton = document.getElementById("world-button") as UIKit.Text;
      if (worldButton) {
        const worlds = [
          { name: "Room", url: "./splats/Yume World (6)_room.spz", position: [0, 0.94, 0] },
          { name: "Treehouse", url: "./splats/Yume World (4)_treehouse.spz", position: [0, 0.14, 0] },
          { name: "Disney Castle", url: "./splats/disney_castle.spz" },
        ];
        let currentWorldIndex = 0; // starts on Room (default loaded)

        worldButton.setProperties({ text: "Next World" });

        worldButton.addEventListener("click", () => {
          currentWorldIndex = (currentWorldIndex + 1) % worlds.length;
          const next = worlds[currentWorldIndex];
          worldButton.setProperties({ text: "Loading..." });
          globalThis.dispatchEvent(new Event("hide-ui"));
          globalThis.dispatchEvent(
            new CustomEvent("switch-world", {
              detail: { splatUrl: next.url, autoFit: false, position: (next as any).position ?? [0, 0, 0], walls: false },
            }),
          );
          const onDone = () => {
            worldButton.setProperties({ text: "Next World" });
            globalThis.removeEventListener("switch-world-done", onDone);
          };
          globalThis.addEventListener("switch-world-done", onDone);
        });
      }

    }, true);
  }
}
