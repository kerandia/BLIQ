import type { CreateAssistantDTO } from "@vapi-ai/web/dist/api";

/**
 * Public URL of the tool server (BLIQ Express `/api/tools`).
 * Vapi's backend POSTs tool calls here, so it MUST be reachable from the
 * internet — for local dev, tunnel it (e.g. `ngrok http 3001`) and put the
 * tunnel URL in web/.env as VITE_TOOL_SERVER_URL.
 */
const TOOL_SERVER_URL = import.meta.env.VITE_TOOL_SERVER_URL ?? "http://localhost:3001/api/tools";

const SYSTEM_PROMPT = `You are an in-car voice assistant. The user is driving.

Rules:
- Be concise and calm. Short sentences. No filler, no pleasantries, no emojis.
- Speak only what matters. Never read out raw data like place IDs, latitudes, or longitudes.
- When listing restaurants, say at most 3 options: name, distance or direction if known, and one detail (rating or cuisine). Then stop and let the driver choose.
- When describing a place, give name, rating, whether it's open now, and cuisine. Nothing else unless asked.
- When the driver asks to save a place, call save_location with the place_id and a short label, then confirm in five words or fewer, e.g. "Saved."
- You receive system messages like "User is now at: {lat}, {lng}" as the car moves. Treat the most recent one as the current position. Use it silently for find_nearby_restaurants — never mention coordinates or that you received an update.
- If you don't have a position yet, ask the driver for their area or to enable location.
- If a tool fails, say you couldn't get that right now. Do not speculate.

Recommendations (the main feature):
- When the driver describes a craving or asks for a recommendation ("find me good ramen", "I'm hungry, something cheap"), call find_best_restaurant_route with their request as query plus the current position. This launches a team of AI agents: a scout searches, critics judge each candidate in parallel with live drive times, and a concierge picks the winner.
- It takes about two minutes. Tell the driver the search team is on it. Then call check_route_job every 15-20 seconds; between polls, briefly narrate recent_activity in plain words ("the critics are checking drive times now").
- When status is done, read spoken_summary aloud, then tell the driver the route is on the dashboard screen.
- Use find_nearby_restaurants only for quick factual questions ("what's around here?"), not for recommendations.`;

/**
 * Transient assistant definition, passed to `vapi.start(...)`.
 * No dashboard setup needed — everything lives in code.
 */
export const assistantConfig: CreateAssistantDTO = {
  name: "BLIQ Car Voice",

  firstMessage: "Ready when you are.",
  firstMessageMode: "assistant-speaks-first",

  model: {
    provider: "openai",
    model: "gpt-4o",
    temperature: 0.3,
    messages: [{ role: "system", content: SYSTEM_PROMPT }],
    tools: [
      {
        type: "function",
        function: {
          name: "find_nearby_restaurants",
          description:
            "Find restaurants near the given coordinates. Use the most recent car position from the system messages. Returns a list of places with name, place_id, rating, and distance.",
          parameters: {
            type: "object",
            properties: {
              lat: { type: "number", description: "Latitude of the current car position." },
              lng: { type: "number", description: "Longitude of the current car position." },
              radius: {
                type: "number",
                description: "Search radius in meters. Default 1500 if the driver did not specify.",
              },
            },
            required: ["lat", "lng"],
          },
        },
        server: { url: TOOL_SERVER_URL },
      },
      {
        type: "function",
        function: {
          name: "get_restaurant_info",
          description:
            "Get details for one restaurant by its place_id (from a previous find_nearby_restaurants result): name, rating, opening hours, cuisine.",
          parameters: {
            type: "object",
            properties: {
              place_id: { type: "string", description: "Google Places place_id of the restaurant." },
            },
            required: ["place_id"],
          },
        },
        server: { url: TOOL_SERVER_URL },
      },
      {
        type: "function",
        function: {
          name: "find_best_restaurant_route",
          description:
            "Launch the multi-agent restaurant search (scout + parallel critics + concierge) for a craving or recommendation request. Returns a job_id immediately; poll check_route_job for progress. Use the most recent car position for lat/lng.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description:
                  "The driver's craving in their own words, e.g. 'good ramen, cozy, not too expensive'.",
              },
              lat: { type: "number", description: "Latitude of the current car position." },
              lng: { type: "number", description: "Longitude of the current car position." },
            },
            required: ["query", "lat", "lng"],
          },
        },
        server: { url: TOOL_SERVER_URL },
      },
      {
        type: "function",
        function: {
          name: "check_route_job",
          description:
            "Check progress of a running multi-agent restaurant search. Returns status and recent_activity while running; when done, returns spoken_summary to read aloud plus the winning restaurant and drive time.",
          parameters: {
            type: "object",
            properties: {
              job_id: { type: "string", description: "The job_id from find_best_restaurant_route." },
            },
            required: ["job_id"],
          },
        },
        server: { url: TOOL_SERVER_URL },
      },
      {
        type: "function",
        async: true,
        function: {
          name: "save_location",
          description:
            'Save a restaurant/location for the driver. Fire-and-forget: the UI stores it. Call this when the driver says things like "save that" or "remember this place".',
          parameters: {
            type: "object",
            properties: {
              place_id: { type: "string", description: "Google Places place_id to save." },
              label: {
                type: "string",
                description: 'Short human label for the saved place, e.g. "lunch spot".',
              },
            },
            required: ["place_id", "label"],
          },
        },
      },
    ],
  },

  transcriber: {
    provider: "deepgram",
    model: "nova-3",
    language: "en",
    smartFormat: true,
  },

  voice: {
    provider: "11labs",
    voiceId: "matilda",
    model: "eleven_flash_v2_5",
  },

  startSpeakingPlan: {
    waitSeconds: 0.4,
  },
  stopSpeakingPlan: {
    numWords: 2,
    voiceSeconds: 0.2,
    backoffSeconds: 1,
  },

  clientMessages: [
    "tool-calls",
    "transcript",
    "speech-update",
    "model-output",
    "status-update",
  ] as unknown as CreateAssistantDTO["clientMessages"],
};
