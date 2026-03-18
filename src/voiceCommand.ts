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
  if (!SpeechRecognition) {
    console.warn("[voiceCommand] Web Speech API not supported in this browser");
    return;
  }

  const DEFAULT_PLUSH_GLB = "./SM_Aligator.glb";
  let cachedPlushGlbUrl: string | null = null;
  let listening = false;
  let listenTimeout: ReturnType<typeof setTimeout> | null = null;

  // Transcript display (hidden, only shown when listening)
  const statusEl = document.createElement("div");
  statusEl.style.cssText = `
    position:fixed; top:16px; left:50%; transform:translateX(-50%);
    background:rgba(13,2,33,0.95); color:#fbbf24;
    border-radius:10px; padding:10px 14px; font-size:13px;
    border:1px solid #7b2ff2; display:none; z-index:10001;
  `;
  document.body.appendChild(statusEl);

  // Dummy micBtn reference (no DOM button, but keep logic intact)
  const micBtn = { style: { background: "" }, innerHTML: "" } as any;

  // --- Voice actions ---
  const actions: VoiceAction[] = [
    {
      keywords: ["rain", "fall", "drop", "shower"],
      cooldown: 5000,
      lastFired: 0,
      handler: async () => {
        const glb = cachedPlushGlbUrl || DEFAULT_PLUSH_GLB;
        statusEl.innerHTML = `🗣 <i>Raining toys!</i>`;
        statusEl.style.display = "block";
        await rainObjects(world, glb, 10);
        setTimeout(() => { statusEl.style.display = "none"; }, 2000);
      },
    },
  ];

  // --- Speech recognition ---
  const recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = "en-US";

  function resetUI() {
    listening = false;
    micBtn.style.background = "#7b2ff2";
    micBtn.innerHTML = `🎤 <span style="font-size:13px;font-weight:600;">Voice</span>`;
    if (listenTimeout) { clearTimeout(listenTimeout); listenTimeout = null; }
    globalThis.dispatchEvent(new CustomEvent("voice-transcript", { detail: "" }));
  }

  function startListening() {
    if (listening) return;
    recognition.start();
    listening = true;
    micBtn.style.background = "#e11d48";
    micBtn.innerHTML = `🔴 <span style="font-size:13px;font-weight:600;">Listening...</span>`;
    statusEl.textContent = "🎙 Say a command...";
    statusEl.style.display = "block";
    globalThis.dispatchEvent(new Event("voice-listening"));
    // Auto-reset after 7s in case recognition never fires onend (e.g. in WebXR)
    listenTimeout = setTimeout(() => resetUI(), 7000);
  }

  function stopListening() {
    if (!listening) return;
    recognition.stop();
    resetUI();
  }

  // Listen for voice toggle from panel button in VR
  globalThis.addEventListener("voice-toggle", () => {
    if (listening) stopListening();
    else startListening();
  });

  recognition.onresult = (event: any) => {
    const transcript: string = event.results[0][0].transcript.toLowerCase();
    console.log("[voiceCommand] Heard:", transcript);
    statusEl.innerHTML = `🗣 <i>"${transcript}"</i>`;
    globalThis.dispatchEvent(new CustomEvent("voice-transcript", { detail: `"${transcript}"` }));
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
    resetUI();
    setTimeout(() => { statusEl.style.display = "none"; }, 3000);
  };


  // --- VR mode: left controller X button (index 4) or A button (index 4) ---
  // Poll gamepad buttons each frame while in XR
  let xrButtonWasPressed = false;

  function pollXRButtons() {
    const session = world.renderer.xr.getSession();
    if (!session) return;

    for (const source of session.inputSources) {
      const gp = source.gamepad;
      if (!gp) continue;

      // Button 4 = X (left) or A (right) on Meta Quest / Pico controllers
      // Button 5 = Y (left) or B (right)
      // We use button 4 (X/A) as the voice trigger
      const btn = gp.buttons[4];
      if (!btn) continue;

      if (btn.pressed && !xrButtonWasPressed) {
        // Button just pressed — start listening
        xrButtonWasPressed = true;
        startListening();
      } else if (!btn.pressed && xrButtonWasPressed) {
        // Button released — stop (recognition will fire onresult)
        xrButtonWasPressed = false;
        // Don't call stopListening() — let it finish naturally
      }
    }
  }

  // Poll XR buttons every frame via onBeforeRender (works in WebXR)
  const pollMesh = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial(),
  );
  pollMesh.visible = false;
  pollMesh.frustumCulled = false;
  pollMesh.onBeforeRender = () => {
    if ((world.renderer as any).xr?.isPresenting) {
      pollXRButtons();
    }
  };
  world.scene.add(pollMesh);

  console.log("[voiceCommand] Initialized — mic button (flat) / X button (VR)");
}
