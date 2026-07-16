import VapiImport from "@vapi-ai/web";
import { assistantConfig } from "./assistantConfig";
import { handleClientToolCall } from "./toolHandlers";

// @vapi-ai/web is CommonJS (`exports.default = Vapi`). Vite's ESM interop
// sometimes hands us the module namespace instead of the constructor —
// unwrap so `new Vapi(...)` always works.
type VapiConstructor = typeof VapiImport;
type VapiInstance = InstanceType<VapiConstructor>;
const Vapi: VapiConstructor =
  ((VapiImport as unknown as { default?: VapiConstructor }).default ??
    VapiImport) as VapiConstructor;

/**
 * Voice layer singleton.
 *
 * Owns the Vapi Web SDK instance, wires every event listener, and exposes
 * the functions the UI layer needs:
 *
 *   startVoice() / stopVoice()  — call lifecycle
 *   updateCarPosition(lat, lng) — GPS contract
 *
 * The UI layer should NOT talk to the raw `vapi` instance; use these
 * exports plus the callbacks in `VoiceCallbacks`.
 */

const VAPI_PUBLIC_KEY = import.meta.env.VITE_VAPI_PUBLIC_KEY as string | undefined;

export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  /** 'partial' while the speaker is mid-sentence, 'final' when committed. */
  type: "partial" | "final";
}

/** Optional hooks the UI layer can register to render voice state. */
export interface VoiceCallbacks {
  onCallStart?: () => void;
  onCallEnd?: () => void;
  /** Assistant audio started playing (use to show a "speaking" indicator). */
  onAssistantSpeechStart?: () => void;
  onAssistantSpeechEnd?: () => void;
  onTranscript?: (entry: TranscriptEntry) => void;
  /** Mic input level 0..1, ~10x/sec. Handy for a waveform. */
  onVolumeLevel?: (level: number) => void;
  onError?: (error: unknown) => void;
}

let vapi: VapiInstance | null = null;
let callbacks: VoiceCallbacks = {};
let callActive = false;

export function isCallActive(): boolean {
  return callActive;
}

/** Register/replace UI callbacks. Safe to call before or during a call. */
export function setVoiceCallbacks(cb: VoiceCallbacks): void {
  callbacks = cb;
}

function getVapi(): VapiInstance {
  if (vapi) return vapi;
  if (!VAPI_PUBLIC_KEY) {
    throw new Error(
      "VITE_VAPI_PUBLIC_KEY is not set. Copy web/.env.example to web/.env and add your Vapi public key.",
    );
  }

  vapi = new Vapi(VAPI_PUBLIC_KEY);

  vapi.on("call-start", () => {
    callActive = true;
    callbacks.onCallStart?.();
  });

  vapi.on("call-end", () => {
    callActive = false;
    callbacks.onCallEnd?.();
  });

  vapi.on("speech-start", () => callbacks.onAssistantSpeechStart?.());
  vapi.on("speech-end", () => callbacks.onAssistantSpeechEnd?.());

  vapi.on("volume-level", (level: number) => callbacks.onVolumeLevel?.(level));

  vapi.on("message", (message: VapiMessage) => {
    switch (message.type) {
      case "transcript":
        callbacks.onTranscript?.({
          role: message.role === "assistant" ? "assistant" : "user",
          text: message.transcript ?? "",
          type: message.transcriptType === "final" ? "final" : "partial",
        });
        break;

      // Client-side tools (no server URL) arrive here. Server tools
      // (find_nearby_restaurants, get_restaurant_info) do NOT — Vapi's
      // backend POSTs those straight to the tool server.
      case "tool-calls":
        for (const toolCall of message.toolCallList ?? []) {
          handleClientToolCall(toolCall);
        }
        break;

      default:
        break;
    }
  });

  vapi.on("error", (error: unknown) => {
    callActive = false;
    console.error("[voice] Vapi error:", error);
    callbacks.onError?.(error);
  });

  return vapi;
}

/** Start a voice session. Resolves once the call is connecting. */
export async function startVoice(): Promise<void> {
  await getVapi().start(assistantConfig);
}

/** End the voice session. */
export async function stopVoice(): Promise<void> {
  await getVapi().stop();
}

/**
 * Mute/unmute the microphone WITHOUT ending the call. Use this when the
 * driver is talking to someone else — an open mic transcribes everything
 * and the assistant may act on overheard speech.
 */
export function setMicMuted(muted: boolean): void {
  if (!vapi || !callActive) return;
  vapi.setMuted(muted);
}

export function isMicMuted(): boolean {
  if (!vapi || !callActive) return false;
  return vapi.isMuted();
}

/**
 * GPS contract: inject current position as a silent system message so the
 * assistant can fill lat/lng on find_nearby_restaurants.
 *
 * Throttle to ~1 call every 2–3 seconds. Safe no-op before the call starts.
 */
export function updateCarPosition(lat: number, lng: number): void {
  if (!vapi || !callActive) return;
  vapi.send({
    type: "add-message",
    message: {
      role: "system",
      content: `User is now at: ${lat.toFixed(6)}, ${lng.toFixed(6)}`,
    },
    triggerResponseEnabled: false,
  });
}

export interface VapiToolCall {
  id: string;
  name?: string;
  arguments?: Record<string, unknown> | string;
  parameters?: Record<string, unknown>;
  function?: { name: string; arguments?: Record<string, unknown> | string };
}

interface VapiMessage {
  type: string;
  role?: string;
  transcript?: string;
  transcriptType?: "partial" | "final";
  toolCallList?: VapiToolCall[];
}
