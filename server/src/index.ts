import dotenv from "dotenv";
// Load the repo-root .env regardless of where the server is launched from
dotenv.config({ path: new URL("../../.env", import.meta.url).pathname });
dotenv.config(); // also allow a local server/.env override
import express from "express";
import cors from "cors";
import { createJob, getJob, listJobs, jobBus, type JobEvent } from "./jobs.js";
import { runJob } from "./orchestrator.js";
import { runTripJob } from "./trip.js";
import { findNearbyRestaurants, getRestaurantInfo } from "./voiceTools.js";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT ?? 3001);

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    cursorKey: Boolean(process.env.CURSOR_API_KEY),
    googleKey: Boolean(process.env.GOOGLE_MAPS_API_KEY ?? process.env.GOOGLE_API_KEY),
    elevenKey: Boolean(process.env.ELEVENLABS_API_KEY),
    elevenAgent: Boolean(process.env.ELEVENLABS_AGENT_ID),
  });
});

/** Start an orchestration job. Called by the voice agent's client tool. */
app.post("/api/jobs", (req, res) => {
  const prompt = String(req.body?.prompt ?? "").trim();
  if (!prompt) {
    res.status(400).json({ error: "prompt is required" });
    return;
  }
  const job = createJob(prompt);
  void runJob(job); // fire and forget; progress flows through the event bus
  res.status(201).json({ id: job.id, status: job.status });
});

/**
 * Start a restaurant-route job. This is the endpoint the voice agent's
 * client tool calls: { query, lat, lng } → { id }.
 */
app.post("/api/navigate", (req, res) => {
  const query = String(req.body?.query ?? "").trim();
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  if (!query || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    res.status(400).json({ error: "query, lat and lng are required" });
    return;
  }
  const job = createJob(query);
  void runTripJob(job, { query, origin: { lat, lng } });
  res.status(201).json({ id: job.id, status: job.status });
});

app.get("/api/jobs", (_req, res) => {
  res.json(
    listJobs().map(({ id, prompt, status, createdAt, result, error }) => ({
      id,
      prompt,
      status,
      createdAt,
      result,
      error,
    })),
  );
});

/** Poll a job — the voice agent uses this to report progress conversationally. */
app.get("/api/jobs/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: "job not found" });
    return;
  }
  const { id, prompt, status, createdAt, result, data, error } = job;
  const lastEvents = job.events.slice(-5);
  res.json({ id, prompt, status, createdAt, result, data, error, lastEvents });
});

/** Live event stream (SSE) for the dashboard UI. */
app.get("/api/jobs/:id/stream", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: "job not found" });
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Replay history so late subscribers see the full timeline
  for (const event of job.events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  const listener = (event: JobEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (event.kind === "status" && ["done", "error"].includes((event.data as { status?: string })?.status ?? "")) {
      res.end();
    }
  };
  jobBus.on(`job:${job.id}`, listener);
  req.on("close", () => jobBus.off(`job:${job.id}`, listener));
});

/**
 * Vapi tool-calls webhook.
 * Vapi's backend POSTs here for server tools (find_nearby_restaurants,
 * get_restaurant_info). Must reply within ~7.5s with:
 *   { results: [{ toolCallId, result | error }] }
 * Always HTTP 200; result/error must be strings; toolCallId must echo.
 * This URL must be publicly reachable (ngrok in local dev).
 */
app.post("/api/tools", async (req, res) => {
  const message = req.body?.message;

  if (message?.type !== "tool-calls" || !Array.isArray(message.toolCallList)) {
    res.status(200).json({});
    return;
  }

  interface IncomingToolCall {
    id: string;
    name?: string;
    arguments?: Record<string, unknown> | string;
    parameters?: Record<string, unknown>;
    function?: { name: string; arguments?: Record<string, unknown> | string };
  }

  const results = await Promise.all(
    (message.toolCallList as IncomingToolCall[]).map(async (toolCall) => {
      const name = toolCall.name ?? toolCall.function?.name ?? "unknown";
      const args = extractToolArguments(toolCall);
      console.log(`[tools] ${name}`, args);

      try {
        const result = await dispatchVoiceTool(name, args);
        return { toolCallId: toolCall.id, result: JSON.stringify(result) };
      } catch (err) {
        console.error(`[tools] ${name} failed:`, err);
        return {
          toolCallId: toolCall.id,
          error: `Tool ${name} failed. Tell the driver you could not get that right now.`,
        };
      }
    }),
  );

  res.status(200).json({ results });
});

async function dispatchVoiceTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "find_nearby_restaurants":
      return findNearbyRestaurants(
        Number(args.lat),
        Number(args.lng),
        args.radius !== undefined ? Number(args.radius) : undefined,
      );
    case "get_restaurant_info":
      return getRestaurantInfo(String(args.place_id));
    // Kicks off the Cursor SDK multi-agent pipeline (scout → critics → concierge).
    // Returns immediately with a job_id — the assistant polls check_route_job.
    case "find_best_restaurant_route": {
      const query = String(args.query ?? "").trim();
      const lat = Number(args.lat);
      const lng = Number(args.lng);
      if (!query || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new Error("query, lat and lng are required");
      }
      const job = createJob(query);
      void runTripJob(job, { query, origin: { lat, lng } });
      return {
        job_id: job.id,
        message:
          "Multi-agent search started: a scout is finding candidates, critics will judge " +
          "each one in parallel, a concierge picks the winner. Takes about two minutes — " +
          "poll check_route_job and keep the driver posted.",
      };
    }
    case "check_route_job": {
      const job = getJob(String(args.job_id ?? ""));
      if (!job) throw new Error("job not found");
      if (job.status === "done") {
        const data = job.data as {
          restaurant?: { name?: string; rating?: number; address?: string };
          etaMinutes?: number;
          distanceKm?: number;
        } | undefined;
        return {
          status: "done",
          spoken_summary: job.result,
          restaurant: data?.restaurant?.name,
          rating: data?.restaurant?.rating,
          eta_minutes: data?.etaMinutes,
          distance_km: data?.distanceKm,
          note: "The route link is already on the driver's dashboard screen.",
        };
      }
      if (job.status === "error") return { status: "error", error: job.error };
      return {
        status: job.status,
        recent_activity: job.events.slice(-3).map((e) => `${e.actor}: ${e.message}`),
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function extractToolArguments(toolCall: {
  arguments?: Record<string, unknown> | string;
  parameters?: Record<string, unknown>;
  function?: { arguments?: Record<string, unknown> | string };
}): Record<string, unknown> {
  const raw = toolCall.arguments ?? toolCall.parameters ?? toolCall.function?.arguments ?? {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return raw;
}

/** Token endpoint so the browser can talk to a private ElevenLabs agent over WebRTC. */
app.get("/api/eleven/token", async (_req, res) => {
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!agentId || !apiKey) {
    res.status(500).json({ error: "ELEVENLABS_AGENT_ID / ELEVENLABS_API_KEY not set" });
    return;
  }
  const response = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${agentId}`,
    { headers: { "xi-api-key": apiKey } },
  );
  if (!response.ok) {
    res.status(502).json({ error: `ElevenLabs token request failed: ${response.status}` });
    return;
  }
  const body = (await response.json()) as { token: string };
  res.json({ token: body.token, agentId });
});

app.listen(PORT, () => {
  console.log(`BLIQ server listening on http://localhost:${PORT}`);
});
