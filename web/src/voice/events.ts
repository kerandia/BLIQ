/**
 * Browser event contract between the VOICE layer and the UI layer.
 *
 * The voice layer dispatches these on `window`. The UI layer (map, saved
 * places panel, etc.) listens for them — it never talks to Vapi directly
 * for these side effects.
 */

/** Fired when the assistant invokes the client-side `save_location` tool. */
export const SAVE_LOCATION_EVENT = "bliq:save-location" as const;

export interface SaveLocationDetail {
  /** Google Places place_id of the location to save. */
  placeId: string;
  /** Human label the driver gave it, e.g. "lunch spot", "Nonna's". */
  label: string;
}

export function dispatchSaveLocation(detail: SaveLocationDetail): void {
  window.dispatchEvent(new CustomEvent<SaveLocationDetail>(SAVE_LOCATION_EVENT, { detail }));
}

/**
 * Convenience subscription helper for the UI layer.
 * Returns an unsubscribe function.
 *
 * @example
 * const off = onSaveLocation(({ placeId, label }) => {
 *   savedPlacesStore.add(placeId, label);
 * });
 */
export function onSaveLocation(handler: (detail: SaveLocationDetail) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<SaveLocationDetail>).detail);
  window.addEventListener(SAVE_LOCATION_EVENT, listener);
  return () => window.removeEventListener(SAVE_LOCATION_EVENT, listener);
}
