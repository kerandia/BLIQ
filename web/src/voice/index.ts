/**
 * Public surface of the voice layer. UI code should import from here only.
 */
export {
  startVoice,
  stopVoice,
  updateCarPosition,
  setVoiceCallbacks,
  isCallActive,
} from "./vapiClient";
export type { VoiceCallbacks, TranscriptEntry } from "./vapiClient";
export { onSaveLocation, SAVE_LOCATION_EVENT } from "./events";
export type { SaveLocationDetail } from "./events";
