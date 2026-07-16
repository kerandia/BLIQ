import { dispatchSaveLocation } from "./events";
import type { VapiToolCall } from "./vapiClient";

/**
 * Client-side tool dispatch.
 *
 * Only tools WITHOUT a `server.url` in assistantConfig.ts land here
 * (currently just `save_location`). They are one-way side effects: nothing
 * is sent back to the model.
 */
export function handleClientToolCall(toolCall: VapiToolCall): void {
  const name = toolCall.name ?? toolCall.function?.name;
  const args = extractArguments(toolCall);

  switch (name) {
    case "save_location":
      handleSaveLocation(args);
      break;
    default:
      console.warn(`[voice] Unhandled client tool call: ${name}`, args);
  }
}

/**
 * save_location — fire a browser event the UI layer subscribes to via
 * `onSaveLocation` (see events.ts). The UI layer owns persistence.
 */
function handleSaveLocation(args: Record<string, unknown>): void {
  const placeId = String(args.place_id ?? "");
  const label = String(args.label ?? "Saved place");

  if (!placeId) {
    console.warn("[voice] save_location called without a place_id, ignoring", args);
    return;
  }

  console.log(`[voice] save_location → placeId=${placeId} label="${label}"`);
  dispatchSaveLocation({ placeId, label });
}

/** Tool args arrive as an object or a JSON string depending on payload version. */
function extractArguments(toolCall: VapiToolCall): Record<string, unknown> {
  const raw = toolCall.arguments ?? toolCall.parameters ?? toolCall.function?.arguments ?? {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      console.warn("[voice] Could not parse tool call arguments:", raw);
      return {};
    }
  }
  return raw;
}
