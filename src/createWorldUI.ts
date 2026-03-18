import {
  generateWorld,
  pollWorldStatus,
  type WorldAssets,
} from "./worldGenerator.js";

/**
 * Show a full-screen "Create Your World" overlay with a drawing canvas
 * and photo upload. Returns the generated world assets when complete.
 */
export function showCreateWorldUI(
  apiBase: string,
): Promise<{ worldId: string; assets: WorldAssets }> {
  return new Promise((resolve, reject) => {
    // -- State --
    type Stroke = { points: { x: number; y: number }[]; eraser: boolean };
    let strokes: Stroke[] = [];
    let currentStroke: Stroke | null = null;
    let isEraser = false;
    let hasContent = false;
    let selectedMode = "kids";

    // -- Overlay --
    const overlay = document.createElement("div");
    overlay.id = "create-world-overlay";
    overlay.innerHTML = `
      <div id="cw-card">
        <h1 id="cw-title">Create Your World</h1>

        <canvas id="cw-canvas" width="512" height="512"></canvas>

        <div id="cw-toolbar">
          <button id="cw-clear" title="Clear">Clear</button>
          <button id="cw-undo" title="Undo">Undo</button>
          <button id="cw-eraser" title="Eraser">Eraser</button>
        </div>

        <div id="cw-separator">— or —</div>

        <button id="cw-upload-btn">Upload a Photo</button>
        <input id="cw-upload-input" type="file" accept="image/*" style="display:none" />

        <div id="cw-mode-group">
          <button id="cw-mode-kids" class="cw-mode active" data-mode="kids">Kids</button>
          <button id="cw-mode-filmmaker" class="cw-mode" data-mode="filmmaker">Filmmaker</button>
          <button id="cw-mode-original" class="cw-mode" data-mode="original">Original</button>
          <button id="cw-mode-ai-artist" class="cw-mode" data-mode="ai-artist">AI Artist</button>
        </div>

        <div id="cw-artist-input" style="display:none;width:100%">
          <input id="cw-artist-text" type="text" placeholder="Describe a style or artist (leave blank for auto-detect)" />
        </div>

        <button id="cw-generate" disabled>Generate World</button>

        <div id="cw-progress" style="display:none">
          <div id="cw-stage">Preparing...</div>
          <div id="cw-bar-bg"><div id="cw-bar-fill"></div></div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    // -- Styles --
    const style = document.createElement("style");
    style.textContent = `
      #create-world-overlay {
        position: fixed;
        inset: 0;
        z-index: 20000;
        background: rgba(13, 2, 33, 0.85);
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: Nunito, sans-serif;
      }
      #cw-card {
        background: #1a0a2e;
        border-radius: 16px;
        padding: 24px;
        max-width: 560px;
        width: 90vw;
        max-height: 90vh;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        box-shadow: 0 8px 32px rgba(123, 47, 242, 0.3);
      }
      #cw-title {
        margin: 0;
        color: #fbbf24;
        font-size: 22px;
        font-weight: 700;
      }
      #cw-canvas {
        width: 100%;
        max-width: 512px;
        aspect-ratio: 1;
        border-radius: 8px;
        border: 2px solid #7b2ff2;
        background: #ffffff;
        cursor: crosshair;
        touch-action: none;
      }
      #cw-toolbar {
        display: flex;
        gap: 8px;
      }
      #cw-toolbar button {
        background: #2a1a4e;
        color: #ccc;
        border: 1px solid #7b2ff2;
        padding: 6px 14px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 13px;
      }
      #cw-toolbar button:hover { background: #3a2a5e; }
      #cw-toolbar button.active { background: #7b2ff2; color: #fff; }
      #cw-separator { color: #666; font-size: 13px; }
      #cw-upload-btn {
        background: #2a1a4e;
        color: #fbbf24;
        border: 1px dashed #7b2ff2;
        padding: 10px 20px;
        border-radius: 8px;
        cursor: pointer;
        font-size: 14px;
      }
      #cw-upload-btn:hover { background: #3a2a5e; }
      #cw-mode-group { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
      #cw-artist-text {
        width: 100%;
        padding: 10px 14px;
        border-radius: 8px;
        border: 1px solid #7b2ff2;
        background: #2a1a4e;
        color: #fbbf24;
        font-size: 14px;
        font-family: inherit;
        outline: none;
        box-sizing: border-box;
      }
      #cw-artist-text::placeholder { color: #666; }
      #cw-artist-text:focus { border-color: #fbbf24; }
      .cw-mode {
        background: #2a1a4e;
        color: #ccc;
        border: 1px solid #7b2ff2;
        padding: 8px 20px;
        border-radius: 8px;
        cursor: pointer;
        font-size: 14px;
        transition: background 0.15s;
      }
      .cw-mode:hover { background: #3a2a5e; }
      .cw-mode.active { background: #7b2ff2; color: #fff; }
      #cw-generate {
        background: #7b2ff2;
        color: #fbbf24;
        border: none;
        padding: 12px 32px;
        border-radius: 10px;
        font-size: 16px;
        font-weight: 600;
        cursor: pointer;
        transition: transform 0.15s, opacity 0.15s;
      }
      #cw-generate:hover:not(:disabled) { transform: scale(1.04); }
      #cw-generate:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }
      #cw-progress { width: 100%; text-align: center; }
      #cw-stage { color: #fbbf24; font-size: 14px; margin-bottom: 6px; }
      #cw-bar-bg {
        width: 100%;
        height: 6px;
        background: #2a1a4e;
        border-radius: 3px;
        overflow: hidden;
      }
      #cw-bar-fill {
        height: 100%;
        width: 0%;
        background: linear-gradient(90deg, #7b2ff2, #fbbf24);
        border-radius: 3px;
        transition: width 0.3s;
      }
    `;
    document.head.appendChild(style);

    // -- Elements --
    const canvas = document.getElementById("cw-canvas") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const clearBtn = document.getElementById("cw-clear") as HTMLButtonElement;
    const undoBtn = document.getElementById("cw-undo") as HTMLButtonElement;
    const eraserBtn = document.getElementById("cw-eraser") as HTMLButtonElement;
    const uploadBtn = document.getElementById("cw-upload-btn") as HTMLButtonElement;
    const uploadInput = document.getElementById("cw-upload-input") as HTMLInputElement;
    const modeButtons = overlay.querySelectorAll<HTMLButtonElement>(".cw-mode");
    const generateBtn = document.getElementById("cw-generate") as HTMLButtonElement;
    const progressDiv = document.getElementById("cw-progress") as HTMLDivElement;
    const stageLabel = document.getElementById("cw-stage") as HTMLDivElement;
    const barFill = document.getElementById("cw-bar-fill") as HTMLDivElement;

    // Prevent scene container from receiving pointer events
    const sceneContainer = document.getElementById("scene-container");
    let prevPointerEvents = "";
    if (sceneContainer) {
      prevPointerEvents = sceneContainer.style.pointerEvents;
      sceneContainer.style.pointerEvents = "none";
    }

    // -- Canvas helpers --
    function clearCanvas() {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, 512, 512);
    }
    clearCanvas();

    function canvasCoords(e: PointerEvent) {
      const rect = canvas.getBoundingClientRect();
      return {
        x: ((e.clientX - rect.left) / rect.width) * 512,
        y: ((e.clientY - rect.top) / rect.height) * 512,
      };
    }

    function redraw() {
      clearCanvas();
      for (const stroke of strokes) {
        if (stroke.points.length < 2) continue;
        ctx.beginPath();
        ctx.strokeStyle = stroke.eraser ? "#ffffff" : "#000000";
        ctx.lineWidth = stroke.eraser ? 20 : 3;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
        for (let i = 1; i < stroke.points.length; i++) {
          ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
        }
        ctx.stroke();
      }
      updateHasContent();
    }

    function updateHasContent() {
      hasContent = strokes.length > 0;
      generateBtn.disabled = !hasContent;
    }

    // -- Canvas drawing events --
    canvas.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      const pt = canvasCoords(e);
      currentStroke = { points: [pt], eraser: isEraser };
    });

    canvas.addEventListener("pointermove", (e) => {
      if (!currentStroke) return;
      e.preventDefault();
      const pt = canvasCoords(e);
      currentStroke.points.push(pt);
      // Draw incrementally
      const pts = currentStroke.points;
      if (pts.length >= 2) {
        ctx.beginPath();
        ctx.strokeStyle = currentStroke.eraser ? "#ffffff" : "#000000";
        ctx.lineWidth = currentStroke.eraser ? 20 : 3;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.moveTo(pts[pts.length - 2].x, pts[pts.length - 2].y);
        ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
        ctx.stroke();
      }
    });

    canvas.addEventListener("pointerup", (e) => {
      if (!currentStroke) return;
      e.preventDefault();
      strokes.push(currentStroke);
      currentStroke = null;
      updateHasContent();
    });

    // -- Toolbar --
    clearBtn.addEventListener("click", () => {
      strokes = [];
      currentStroke = null;
      clearCanvas();
      updateHasContent();
    });

    undoBtn.addEventListener("click", () => {
      strokes.pop();
      redraw();
    });

    eraserBtn.addEventListener("click", () => {
      isEraser = !isEraser;
      eraserBtn.classList.toggle("active", isEraser);
    });

    // -- Photo upload --
    uploadBtn.addEventListener("click", () => {
      uploadInput.value = "";
      uploadInput.click();
    });

    uploadInput.addEventListener("change", () => {
      const file = uploadInput.files?.[0];
      if (!file) return;
      const img = new Image();
      img.onload = () => {
        clearCanvas();
        strokes = [];
        // Draw scaled to 512x512
        ctx.drawImage(img, 0, 0, 512, 512);
        hasContent = true;
        generateBtn.disabled = false;
        URL.revokeObjectURL(img.src);
      };
      img.src = URL.createObjectURL(file);
    });

    // -- Mode toggle --
    const artistInputDiv = document.getElementById("cw-artist-input") as HTMLDivElement;
    const artistTextInput = document.getElementById("cw-artist-text") as HTMLInputElement;

    modeButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        modeButtons.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        selectedMode = btn.dataset.mode || "kids";
        // Show artist text input only for ai-artist mode
        artistInputDiv.style.display = selectedMode === "ai-artist" ? "block" : "none";
      });
    });

    // -- Generate --
    generateBtn.addEventListener("click", async () => {
      // Disable all inputs
      generateBtn.disabled = true;
      clearBtn.disabled = true;
      undoBtn.disabled = true;
      eraserBtn.disabled = true;
      uploadBtn.disabled = true;
      canvas.style.pointerEvents = "none";

      progressDiv.style.display = "block";
      stageLabel.textContent = "Uploading drawing...";
      barFill.style.width = "5%";

      try {
        const blob = await new Promise<Blob>((res, rej) => {
          canvas.toBlob(
            (b) => (b ? res(b) : rej(new Error("Failed to capture canvas"))),
            "image/png",
          );
        });

        stageLabel.textContent = "Starting generation...";
        barFill.style.width = "10%";

        const worldId = await generateWorld(apiBase, blob, selectedMode, artistTextInput.value.trim());

        const assets = await pollWorldStatus(apiBase, worldId, (stage, progress) => {
          stageLabel.textContent = stage;
          barFill.style.width = `${Math.max(10, Math.min(95, progress))}%`;
        });

        barFill.style.width = "100%";
        stageLabel.textContent = "Done!";

        // Cleanup
        cleanup();
        resolve({ worldId, assets });
      } catch (err: any) {
        console.error("[createWorldUI] Generation failed:", err);
        stageLabel.textContent = `Failed: ${err.message || "Unknown error"}`;
        barFill.style.width = "0%";

        // Re-enable inputs so user can retry
        generateBtn.disabled = !hasContent;
        clearBtn.disabled = false;
        undoBtn.disabled = false;
        eraserBtn.disabled = false;
        uploadBtn.disabled = false;
        canvas.style.pointerEvents = "";
      }
    });

    function cleanup() {
      overlay.remove();
      style.remove();
      if (sceneContainer) {
        sceneContainer.style.pointerEvents = prevPointerEvents;
      }
    }
  });
}
