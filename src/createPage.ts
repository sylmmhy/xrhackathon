/**
 * Standalone "Create World" page at /create.
 * Shows the drawing/photo-upload UI and redirects to the main viewer
 * once the world is generated.
 */
import { showCreateWorldUI } from "./createWorldUI.js";

const params = new URLSearchParams(window.location.search);
const apiBase =
  params.get("api") ||
  (import.meta as any).env?.VITE_YUME_API_BASE ||
  "";

showCreateWorldUI(apiBase)
  .then(({ worldId, assets }) => {
    // Redirect to the main viewer with the new world
    const viewerParams = new URLSearchParams();
    viewerParams.set("world_id", worldId);
    if (apiBase) viewerParams.set("api", apiBase);
    if (assets.splatUrl) viewerParams.set("splat", assets.splatUrl);
    window.location.href = `/${viewerParams.toString() ? "?" + viewerParams : ""}`;
  })
  .catch((err) => {
    console.error("[CreatePage] Failed:", err);
  });
