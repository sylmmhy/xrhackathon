// ---------------------------------------------------------------------------
// Gemini Voice Recognition — record audio, send to Gemini API for transcription
// ---------------------------------------------------------------------------

const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

export type GeminiVoiceCallback = (transcript: string) => void;

export class GeminiVoiceSession {
  private apiKey: string;
  private onTranscript: GeminiVoiceCallback;
  private onError: (err: string) => void;
  private onListening: () => void;
  private onStopped: () => void;
  private mediaRecorder: MediaRecorder | null = null;
  private mediaStream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private _isActive = false;
  private stopTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: {
    apiKey: string;
    onTranscript: GeminiVoiceCallback;
    onError?: (err: string) => void;
    onListening?: () => void;
    onStopped?: () => void;
  }) {
    this.apiKey = opts.apiKey;
    this.onTranscript = opts.onTranscript;
    this.onError = opts.onError || (() => {});
    this.onListening = opts.onListening || (() => {});
    this.onStopped = opts.onStopped || (() => {});
  }

  async start() {
    if (this._isActive) return;
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });

      this.chunks = [];
      this.mediaRecorder = new MediaRecorder(this.mediaStream, {
        mimeType: this.getSupportedMimeType(),
      });

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.chunks.push(e.data);
      };

      this.mediaRecorder.onstop = () => {
        this.processAudio();
      };

      this.mediaRecorder.start();
      this._isActive = true;
      this.onListening();

      // Auto-stop after 8 seconds to avoid overly long recordings
      this.stopTimeout = setTimeout(() => this.stop(), 8000);
    } catch (err: any) {
      this.onError(err.message || "Microphone access denied");
      this.cleanup();
    }
  }

  stop() {
    if (!this._isActive) return;
    if (this.stopTimeout) {
      clearTimeout(this.stopTimeout);
      this.stopTimeout = null;
    }
    if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
      this.mediaRecorder.stop();
    }
    this._isActive = false;
  }

  get isActive(): boolean {
    return this._isActive;
  }

  private getSupportedMimeType(): string {
    const types = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return "";
  }

  private async processAudio() {
    const mimeType = this.mediaRecorder?.mimeType || "audio/webm";
    this.cleanup();

    if (this.chunks.length === 0) {
      this.onStopped();
      return;
    }

    const audioBlob = new Blob(this.chunks, { type: mimeType });
    this.chunks = [];

    if (audioBlob.size < 1000) {
      this.onStopped();
      return;
    }

    try {
      const base64 = await this.blobToBase64(audioBlob);
      const transcript = await this.transcribeWithGemini(base64, mimeType);
      if (transcript) {
        this.onTranscript(transcript);
      }
    } catch (err: any) {
      console.warn("[geminiVoice] Transcription error:", err);
      this.onError(err.message || "Transcription failed");
    } finally {
      this.onStopped();
    }
  }

  private async transcribeWithGemini(base64Audio: string, mimeType: string): Promise<string> {
    const resp = await fetch(`${GEMINI_API_URL}?key=${this.apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                inline_data: {
                  mime_type: mimeType.split(";")[0],
                  data: base64Audio,
                },
              },
              {
                text: `You are a voice command classifier for a children's WebXR toy world app. Listen to the audio and determine the user's INTENT. Output ONLY the matching command.

Available commands:
- "make it rain" — trigger when the user wants toys/objects to rain from the sky. This includes ANY of these intents:
  - Wants more toys, more friends, more stuff
  - Says "make it rain", "make it", "make it happen"
  - Asks for many toys, lots of toys, tons of toys
  - Wants more friends, more animals, more plushies
  - Says "I want more", "give me more", "so many toys"
  - Says "rain", "shower", "fall from sky"
  - Any expression of wanting abundance or more objects in the scene

- "drop toy" — trigger when the user wants exactly ONE toy dropped

- "change world" — trigger when the user wants to switch/change the scene or world. Includes:
  - "change the world", "change world", "change"
  - "switch world", "switch scene", "next world"
  - "new world", "different world", "another world"
  - Any expression of wanting to go somewhere else or see a different scene

Output rules:
- Output ONLY the command phrase, nothing else
- If the intent is about wanting more/many things → output: make it rain
- If the intent is about one toy → output: drop toy
- If the intent is about changing/switching the scene → output: change world
- If unclear but sounds like they want something fun → output: make it rain
- If completely unrelated → output: [unrecognized]`,
              },
            ],
          },
        ],
        generation_config: {
          temperature: 0,
          max_output_tokens: 100,
        },
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Gemini API error (${resp.status}): ${err}`);
    }

    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toLowerCase() || "";
    return text === "[unrecognized]" ? "" : text;
  }

  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = reader.result as string;
        // Strip the data:...;base64, prefix
        const base64 = dataUrl.split(",")[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  private cleanup() {
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
    this.mediaRecorder = null;
  }
}
