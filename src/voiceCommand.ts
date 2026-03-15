import * as THREE from "three";
import { World } from "@iwsdk/core";
import { spawnGLBFromUrl } from "./objectLoader.js";
import { GeminiVoiceSession } from "./geminiVoice.js";

// ---------------------------------------------------------------------------
// Voice command system — uses Gemini Multimodal Live API
// ---------------------------------------------------------------------------

const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY as string;

interface VoiceAction {
  keywords: string[];
  cooldown: number;
  lastFired: number;
  handler: (transcript: string) => void;
}

async function rainObjects(
  world: World,
  glbUrl: string,
  count: number,
  opts: { spread?: number; height?: number; interval?: number } = {},
) {
  const spread = opts.spread ?? 6;
  const height = opts.height ?? 8;
  const interval = opts.interval ?? 300;

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
  _apiBase: string,
): void {
  if (!GEMINI_API_KEY) {
    console.warn("[voiceCommand] GEMINI_API_KEY not set — voice disabled");
    return;
  }

  const DEFAULT_PLUSH_GLB = "./SM_Aligator.glb";
  let cachedPlushGlbUrl: string | null = null;
  let session: GeminiVoiceSession | null = null;

  // --- Status display (visible in both flat + VR via DOM overlay) ---
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

  // --- Mic button (flat/desktop mode) ---
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

  // --- Voice actions ---
  const actions: VoiceAction[] = [
    {
      keywords: ["make it rain"],
      cooldown: 5000,
      lastFired: 0,
      handler: async () => {
        const glb = cachedPlushGlbUrl || DEFAULT_PLUSH_GLB;
        statusEl.textContent = "Make it rain!";
        statusEl.style.display = "block";
        await rainObjects(world, glb, 15);
        statusEl.textContent = "Done!";
        setTimeout(() => { statusEl.style.display = "none"; }, 2000);
      },
    },
    {
      keywords: ["change world"],
      cooldown: 5000,
      lastFired: 0,
      handler: async () => {
        statusEl.textContent = "Changing world...";
        statusEl.style.display = "block";
        globalThis.dispatchEvent(
          new Event("voice-switch-world"),
        );
        setTimeout(() => { statusEl.style.display = "none"; }, 3000);
      },
    },
    {
      keywords: ["plush", "plushie", "teddy", "toy", "stuffed"],
      cooldown: 10000,
      lastFired: 0,
      handler: async (transcript: string) => {
        let count = 10;
        if (/tons|lots|many|so many/.test(transcript)) count = 20;
        if (/\bone\b|single/.test(transcript)) count = 1;
        if (/few|some|couple/.test(transcript)) count = 5;

        const glb = cachedPlushGlbUrl || DEFAULT_PLUSH_GLB;
        statusEl.textContent = `Raining ${count} plushies!`;
        statusEl.style.display = "block";
        await rainObjects(world, glb, count);
        statusEl.textContent = "Done!";
        setTimeout(() => { statusEl.style.display = "none"; }, 2000);
      },
    },
    {
      keywords: ["rain", "fall", "drop", "shower"],
      cooldown: 5000,
      lastFired: 0,
      handler: async () => {
        const glb = cachedPlushGlbUrl || DEFAULT_PLUSH_GLB;
        statusEl.textContent = "Object rain!";
        statusEl.style.display = "block";
        await rainObjects(world, glb, 10);
        statusEl.textContent = "Done!";
        setTimeout(() => { statusEl.style.display = "none"; }, 2000);
      },
    },
  ];

  // --- Handle transcript from Gemini ---
  function handleTranscript(transcript: string) {
    console.log("[voiceCommand] Gemini heard:", transcript);
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
  }

  // --- Start / stop Gemini session ---
  function broadcastMicState(listening: boolean) {
    globalThis.dispatchEvent(
      new CustomEvent("mic-state", { detail: { listening } }),
    );
  }

  function startListening() {
    if (session?.isActive) return;

    session = new GeminiVoiceSession({
      apiKey: GEMINI_API_KEY,
      onTranscript: handleTranscript,
      onListening: () => {
        micBtn.style.background = "#e11d48";
        statusEl.textContent = "Listening (Gemini)...";
        statusEl.style.display = "block";
        broadcastMicState(true);
      },
      onError: (err) => {
        console.warn("[voiceCommand] Gemini error:", err);
        micBtn.style.background = "#7b2ff2";
        statusEl.textContent = `Voice error: ${err}`;
        statusEl.style.display = "block";
        setTimeout(() => { statusEl.style.display = "none"; }, 3000);
        broadcastMicState(false);
      },
      onStopped: () => {
        micBtn.style.background = "#7b2ff2";
        broadcastMicState(false);
      },
    });

    session.start();
  }

  function stopListening() {
    if (!session?.isActive) return;
    session.stop();
    session = null;
    statusEl.textContent = "";
    statusEl.style.display = "none";
  }

  // --- Flat mode: click mic button ---
  micBtn.addEventListener("click", () => {
    if (session?.isActive) stopListening();
    else startListening();
  });

  // --- Panel UI mic button ---
  globalThis.addEventListener("panel-mic-toggle", () => {
    if (session?.isActive) stopListening();
    else startListening();
  });

  // --- VR mode: left controller X button (index 4) ---
  let xrButtonWasPressed = false;

  function pollXRButtons() {
    const xrSession = world.renderer.xr.getSession();
    if (!xrSession) return;

    for (const source of xrSession.inputSources) {
      const gp = source.gamepad;
      if (!gp) continue;

      const btn = gp.buttons[4];
      if (!btn) continue;

      if (btn.pressed && !xrButtonWasPressed) {
        xrButtonWasPressed = true;
        startListening();
      } else if (!btn.pressed && xrButtonWasPressed) {
        xrButtonWasPressed = false;
        stopListening();
      }
    }
  }

  const pollLoop = () => {
    requestAnimationFrame(pollLoop);
    if (world.renderer.xr.isPresenting) {
      pollXRButtons();
    }
  };
  pollLoop();

  console.log("[voiceCommand] Initialized with Gemini Live API — mic button (flat) / X button (VR)");
}
