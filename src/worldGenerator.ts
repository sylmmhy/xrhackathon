const POLL_INTERVAL_MS = 3000;

export interface WorldAssets {
  splatUrl: string;
  colliderUrl: string;
  panoramaUrl: string;
  worldId: string;
}

/**
 * POST a drawing to the Yume API to generate a new world.
 * Returns the new world_id.
 */
export async function generateWorld(
  apiBase: string,
  drawing: Blob,
  mode: string,
): Promise<string> {
  const formData = new FormData();
  formData.append("drawing", drawing, "drawing.png");
  formData.append("mode", mode);

  const resp = await fetch(`${apiBase}/api/generate`, {
    method: "POST",
    body: formData,
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Generate failed (${resp.status})`);
  }

  const { world_id } = await resp.json();
  return world_id;
}

/**
 * Poll for world generation status until complete, then fetch asset URLs.
 */
export async function pollWorldStatus(
  apiBase: string,
  worldId: string,
  onProgress?: (stage: string, progress: number) => void,
): Promise<WorldAssets> {
  while (true) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const statusResp = await fetch(`${apiBase}/api/world/${worldId}/status`);
    if (!statusResp.ok) {
      throw new Error(`Status check failed (${statusResp.status})`);
    }

    const data = await statusResp.json();

    if (data.status === "complete") {
      const assets = data.assets || {};
      return {
        splatUrl: assets.splat_url || "",
        colliderUrl: assets.collider_url || "",
        panoramaUrl: assets.panorama_url || "",
        worldId,
      };
    }

    if (data.status === "failed") {
      throw new Error(data.error || "World generation failed");
    }

    const totalStages = data.total_stages || 2;
    const progress = Math.round((data.stage / totalStages) * 100);
    onProgress?.(data.stage_label || "Generating...", progress);
  }
}

/**
 * Fetch assets for an existing world.
 */
export async function fetchWorldAssets(
  apiBase: string,
  worldId: string,
): Promise<WorldAssets> {
  const resp = await fetch(`${apiBase}/api/world/${worldId}/assets`);
  if (!resp.ok) {
    throw new Error(`Assets fetch failed (${resp.status})`);
  }
  const data = await resp.json();
  return {
    splatUrl: data.splat_url || "",
    colliderUrl: data.collider_url || "",
    panoramaUrl: data.panorama_url || "",
    worldId,
  };
}
