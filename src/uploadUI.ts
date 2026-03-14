import { World } from "@iwsdk/core";
import { uploadImageAndSpawn } from "./objectLoader.js";

const DEFAULT_API_BASE = "http://localhost:8000";

function getApiBase(): string {
  const params = new URLSearchParams(window.location.search);
  return (
    params.get("api") ||
    (import.meta as any).env?.VITE_YUME_API_BASE ||
    DEFAULT_API_BASE
  );
}

/**
 * Create the upload UI overlay: a "+" button that opens the camera/gallery
 * and kicks off the Meshy image-to-3D pipeline.
 */
export function createUploadUI(world: World, worldId: string): void {
  const apiBase = getApiBase();

  // Container
  const container = document.createElement("div");
  container.id = "upload-ui";
  container.innerHTML = `
    <button id="upload-btn" title="Add 3D object from photo">+</button>
    <input id="upload-input" type="file" accept="image/*" capture="environment" style="display:none" />
    <div id="upload-status" style="display:none"></div>
    <button id="upload-retry" style="display:none">Retry</button>
  `;
  document.body.appendChild(container);

  // Styles
  const style = document.createElement("style");
  style.textContent = `
    #upload-ui {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 10000;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    #upload-btn {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      border: none;
      background: #7b2ff2;
      color: #fbbf24;
      font-size: 28px;
      font-weight: bold;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(123, 47, 242, 0.4);
      transition: transform 0.15s, background 0.15s;
    }
    #upload-btn:hover {
      transform: scale(1.1);
      background: #6a1de0;
    }
    #upload-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
    }
    #upload-status {
      background: rgba(13, 2, 33, 0.9);
      color: #fbbf24;
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 14px;
      max-width: 260px;
      text-align: right;
    }
    #upload-retry {
      background: #7b2ff2;
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 14px;
      cursor: pointer;
    }
    #upload-retry:hover {
      background: #6a1de0;
    }
  `;
  document.head.appendChild(style);

  const btn = document.getElementById("upload-btn") as HTMLButtonElement;
  const input = document.getElementById("upload-input") as HTMLInputElement;
  const statusEl = document.getElementById("upload-status") as HTMLDivElement;
  const retryBtn = document.getElementById("upload-retry") as HTMLButtonElement;

  let lastFile: File | null = null;

  function showStatus(msg: string) {
    statusEl.textContent = msg;
    statusEl.style.display = "block";
  }

  function hideStatus() {
    statusEl.style.display = "none";
  }

  function showRetry() {
    retryBtn.style.display = "block";
  }

  function hideRetry() {
    retryBtn.style.display = "none";
  }

  async function processFile(file: File) {
    lastFile = file;
    btn.disabled = true;
    hideRetry();

    try {
      await uploadImageAndSpawn(world, file, worldId, apiBase, showStatus);
      showStatus("Object placed! Grab it to move.");
      setTimeout(hideStatus, 4000);
    } catch (err: any) {
      console.error("[uploadUI] Failed:", err);
      showStatus(`Failed: ${err.message || "Unknown error"}`);
      showRetry();
    } finally {
      btn.disabled = false;
    }
  }

  btn.addEventListener("click", () => {
    input.value = "";
    input.click();
  });

  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) processFile(file);
  });

  retryBtn.addEventListener("click", () => {
    if (lastFile) processFile(lastFile);
  });
}
