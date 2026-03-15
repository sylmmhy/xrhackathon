import * as THREE from "three";
import { World } from "@iwsdk/core";
import { spawnGLBFromUrl } from "./objectLoader.js";

// ---------------------------------------------------------------------------
// Voice command system — uses the browser Web Speech API
// ---------------------------------------------------------------------------

const SpeechRecognition =
  (globalThis as any).SpeechRecognition ||
  (globalThis as any).webkitSpeechRecognition;

interface VoiceAction {
  /** Keywords that trigger this action (any match fires) */
  keywords: string[];
  /** Cooldown in ms to prevent rapid re-fire */
  cooldown: number;
  lastFired: number;
  handler: (transcript: string) => void;
}

/**
 * Rain many copies of a GLB from the sky with physics.
 * The first call to `rainObjects` with a given URL will fetch + cache the GLB.
 * Subsequent copies are cloned from the cache.
 */
async function rainObjects(
  world: World,
  glbUrl: string,
  count: number,
  opts: { spread?: number; height?: number; interval?: number } = {},
) {
  const spread = opts.spread ?? 6;
  const height = opts.height ?? 8;
  const interval = opts.interval ?? 300; // ms between spawns

  const cam = world.camera;
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  forward.y = 0;
  forward.normalize();
  const center = cam.position.clone().addScaledVector(forward, 3);

  for (let i = 0; i < count; i++) {
    const offsetX = (Math.random() - 0.5) * spread;
    const offsetZ = (Math.random() - 0.5) * spread;
    const pos = new THREE.Vector3(
      center.x + offsetX,
      height + Math.random() * 3,
      center.z + offsetZ,
    );

    // spawnGLBFromUrl already adds physics (Dynamic) + grabbable
    spawnGLBFromUrl(world, glbUrl, pos).catch((err) =>
      console.warn("[voiceCommand] Failed to spawn rain object:", err),
    );

    if (interval > 0 && i < count - 1) {
      await new Promise((r) => setTimeout(r, interval));
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createVoiceCommandUI(
  world: World,
  worldId: string,
  apiBase: string,
): void {
  if (!SpeechRecognition) {
    console.warn("[voiceCommand] Web Speech API not supported in this browser");
    return;
  }

  // --- Status display ---
  const statusEl = document.createElement("div");
  statusEl.id = "voice-status";
  statusEl.style.cssText = `
    position:fixed; top:16px; left:50%; transform:translateX(-50%);
    z-index:10001; padding:10px 20px; border-radius:10px;
    background:rgba(13,2,33,0.9); color:#fbbf24;
    font-size:14px; font-family:-apple-system,sans-serif;
    display:none; text-align:center; max-width:80vw;
  `;
  document.body.appendChild(statusEl);

  // --- Mic button ---
  const micBtn = document.createElement("button");
  micBtn.id = "voice-btn";
  micBtn.textContent = "\u{1F3A4}";
  micBtn.style.cssText = `
    position:fixed; bottom:24px; left:24px; z-index:10000;
    width:56px; height:56px; border-radius:50%; border:none;
    background:#7b2ff2; color:#fbbf24; font-size:24px;
    cursor:pointer; box-shadow:0 4px 12px rgba(123,47,242,0.4);
    transition:transform 0.15s, background 0.15s;
  `;
  document.body.appendChild(micBtn);

  // --- Built-in default plush image (a cute teddy bear silhouette) ---
  // Users can say "plush rain" to generate and rain plushies
  const DEFAULT_PLUSH_GLB = "./SM_Aligator.glb";

  // --- Cached GLB URL after first Meshy generation ---
  let cachedPlushGlbUrl: string | null = null;

  // --- Define voice actions ---
  const actions: VoiceAction[] = [
    {
      keywords: ["plush", "plushie", "毛绒", "玩偶", "玩具"],
      cooldown: 10000,
      lastFired: 0,
      handler: async (transcript: string) => {
        // Determine count from transcript
        let count = 10;
        if (/很多很多|tons|lots/.test(transcript)) count = 20;
        if (/一个|one|single/.test(transcript)) count = 1;
        if (/几个|few|some/.test(transcript)) count = 5;

        const glb = cachedPlushGlbUrl || DEFAULT_PLUSH_GLB;
        statusEl.textContent = `Raining ${count} plushies!`;
        statusEl.style.display = "block";
        await rainObjects(world, glb, count);
        statusEl.textContent = "Done!";
        setTimeout(() => { statusEl.style.display = "none"; }, 2000);
      },
    },
    {
      keywords: ["rain", "雨", "下雨", "fall", "掉"],
      cooldown: 5000,
      lastFired: 0,
      handler: async (_transcript: string) => {
        // Rain existing alligator as fallback
        const glb = cachedPlushGlbUrl || DEFAULT_PLUSH_GLB;
        statusEl.textContent = "Object rain!";
        statusEl.style.display = "block";
        await rainObjects(world, glb, 10);
        statusEl.textContent = "Done!";
        setTimeout(() => { statusEl.style.display = "none"; }, 2000);
      },
    },
  ];

  // --- Speech recognition setup ---
  let listening = false;
  const recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = false;
  // Support both Chinese and English
  recognition.lang = "en-US";

  recognition.onresult = (event: any) => {
    const transcript: string = event.results[0][0].transcript.toLowerCase();
    console.log("[voiceCommand] Heard:", transcript);
    statusEl.textContent = `"${transcript}"`;
    statusEl.style.display = "block";

    const now = Date.now();
    let matched = false;
    for (const action of actions) {
      if (now - action.lastFired < action.cooldown) continue;
      if (action.keywords.some((kw) => transcript.includes(kw))) {
        action.lastFired = now;
        action.handler(transcript);
        matched = true;
        break;
      }
    }

    if (!matched) {
      setTimeout(() => { statusEl.style.display = "none"; }, 2000);
    }
  };

  recognition.onerror = (event: any) => {
    console.warn("[voiceCommand] Error:", event.error);
    listening = false;
    micBtn.style.background = "#7b2ff2";
    if (event.error !== "no-speech") {
      statusEl.textContent = `Voice error: ${event.error}`;
      statusEl.style.display = "block";
      setTimeout(() => { statusEl.style.display = "none"; }, 3000);
    }
  };

  recognition.onend = () => {
    listening = false;
    micBtn.style.background = "#7b2ff2";
  };

  micBtn.addEventListener("click", () => {
    if (listening) {
      recognition.stop();
      listening = false;
      micBtn.style.background = "#7b2ff2";
    } else {
      recognition.start();
      listening = true;
      micBtn.style.background = "#e11d48";
      statusEl.textContent = "Listening...";
      statusEl.style.display = "block";
    }
  });
}
