import { Agent, type SDKCustomTool } from "@cursor/sdk";
import path from "node:path";
import fs from "node:fs/promises";
import { type Job, emitJobEvent, setJobStatus } from "./jobs.js";
import {
  type LatLng,
  type PlaceCandidate,
  searchRestaurants,
  computeDriveEstimate,
  mapsDeepLink,
} from "./googlemaps.js";

const MODEL = { id: process.env.CURSOR_MODEL ?? "composer-2.5" };
const MAX_CANDIDATES = 4;

export interface TripRequest {
  /** What the passenger asked for, verbatim-ish ("good ramen, nothing fancy") */
  query: string;
  origin: LatLng;
}

export interface TripResult {
  restaurant: PlaceCandidate;
  etaMinutes: number;
  distanceKm: number;
  mapsLink: string;
  spokenSummary: string;
  runnersUp: Array<{ name: string; verdict: string }>;
}

interface CriticVerdict {
  placeId: string;
  score: number;
  verdict: string;
}

/**
 * Food-trip pipeline (multi-agent orchestration over Google Maps tools):
 *   1. Scout agent      — interprets the craving, searches Places API via a
 *                         custom tool, shortlists up to 4 candidates
 *   2. Critic agents    — one per candidate, in parallel; each checks the
 *                         detour (Routes API tool) and judges fit
 *   3. Concierge agent  — weighs the verdicts, picks the winner, writes the
 *                         spoken summary for the voice agent
 */
export async function runTripJob(job: Job, request: TripRequest): Promise<void> {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    job.error = "CURSOR_API_KEY is not set";
    setJobStatus(job, "error");
    return;
  }

  // Local agents need a cwd; give each job a scratch dir
  const workspace = path.resolve("workspaces", job.id);
  await fs.mkdir(workspace, { recursive: true });

  try {
    setJobStatus(job, "planning", "Scout agent is searching for restaurants");
    const candidates = await scout(job, apiKey, workspace, request);
    emitJobEvent(job, {
      actor: "scout",
      kind: "result",
      message: `Shortlisted: ${candidates.map((c) => c.name).join(", ")}`,
      data: { candidates },
    });

    setJobStatus(job, "working", `${candidates.length} critic agents are investigating in parallel`);
    const verdicts = await Promise.all(
      candidates.map((candidate, i) => critique(job, apiKey, workspace, request, candidate, i)),
    );

    setJobStatus(job, "reviewing", "Concierge agent is making the final call");
    const result = await conclude(job, apiKey, workspace, request, candidates, verdicts);

    job.result = result.spokenSummary;
    job.data = result;
    setJobStatus(job, "done", "Route is ready");
    emitJobEvent(job, {
      actor: "concierge",
      kind: "result",
      message: result.spokenSummary,
      data: result as unknown as Record<string, unknown>,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    job.error = message;
    setJobStatus(job, "error");
    emitJobEvent(job, { actor: "system", kind: "error", message });
  }
}

async function scout(
  job: Job,
  apiKey: string,
  cwd: string,
  request: TripRequest,
): Promise<PlaceCandidate[]> {
  // Every candidate any search returns, keyed by placeId, so we can hydrate
  // the shortlist the agent picks
  const seen = new Map<string, PlaceCandidate>();

  const searchTool: SDKCustomTool = {
    description:
      "Search for restaurants near the car using Google Places. Returns JSON candidates. " +
      "You may call this multiple times with different queries or radii.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text, e.g. 'best ramen'" },
        radius_meters: { type: "number", description: "Search radius, default 5000" },
        open_now: { type: "boolean", description: "Only places open right now, default true" },
      },
      required: ["query"],
    },
    execute: async (args) => {
      const results = await searchRestaurants(String(args.query), request.origin, {
        radiusMeters: typeof args.radius_meters === "number" ? args.radius_meters : undefined,
        openNow: typeof args.open_now === "boolean" ? args.open_now : undefined,
      });
      for (const r of results) seen.set(r.placeId, r);
      emitJobEvent(job, {
        actor: "scout",
        kind: "log",
        message: `Searched "${args.query}" → ${results.length} places`,
      });
      return JSON.stringify(results);
    },
  };

  await using agent = await Agent.create({
    apiKey,
    model: MODEL,
    local: { cwd, customTools: { search_restaurants: searchTool } },
  });
  const run = await agent.send(
    `You are the SCOUT agent for an in-car food concierge. A passenger said: "${request.query}". ` +
      `The car is at lat ${request.origin.lat}, lng ${request.origin.lng}.\n\n` +
      `Use the search_restaurants tool (multiple calls with different phrasings if useful) to find ` +
      `strong options. Then respond with ONLY a JSON array (no fences) of the ${MAX_CANDIDATES} best ` +
      `candidates to investigate further: [{"placeId": "...", "reason": "..."}]. ` +
      `Prefer well-rated places that match the craving; diversity of options is good.`,
  );
  const result = await run.wait();
  if (result.status !== "finished" || !result.result) {
    throw new Error(`Scout failed: ${result.status}`);
  }
  const picks = extractJson<Array<{ placeId: string }>>(result.result);
  const candidates = picks
    .map((p) => seen.get(p.placeId))
    .filter((c): c is PlaceCandidate => Boolean(c))
    .slice(0, MAX_CANDIDATES);
  if (candidates.length === 0) throw new Error("Scout found no usable candidates");
  return candidates;
}

async function critique(
  job: Job,
  apiKey: string,
  cwd: string,
  request: TripRequest,
  candidate: PlaceCandidate,
  index: number,
): Promise<CriticVerdict & { eta?: { durationMinutes: number; distanceKm: number } }> {
  const actor = `critic:${index + 1}`;
  emitJobEvent(job, { actor, kind: "log", message: `Investigating ${candidate.name}` });

  let eta: { durationMinutes: number; distanceKm: number } | undefined;
  const etaTool: SDKCustomTool = {
    description: "Get real driving time and distance from the car to this restaurant (traffic-aware).",
    inputSchema: { type: "object", properties: {}, required: [] },
    execute: async () => {
      eta = await computeDriveEstimate(request.origin, candidate.placeId);
      return JSON.stringify(eta);
    },
  };

  await using agent = await Agent.create({
    apiKey,
    model: MODEL,
    local: { cwd, customTools: { get_drive_eta: etaTool } },
  });
  const run = await agent.send(
    `You are CRITIC ${index + 1} for an in-car food concierge. The passenger asked: "${request.query}".\n\n` +
      `Your candidate:\n${JSON.stringify(candidate, null, 2)}\n\n` +
      `Call get_drive_eta to check the real driving detour, then judge the fit: rating vs number of ` +
      `ratings, price, whether it matches the craving, and whether the drive time is reasonable for ` +
      `hungry people in a car. Respond with ONLY JSON (no fences): ` +
      `{"placeId": "${candidate.placeId}", "score": <0-10>, "verdict": "<one punchy sentence>"}`,
  );
  const result = await run.wait();
  if (result.status !== "finished" || !result.result) {
    throw new Error(`${actor} failed: ${result.status}`);
  }
  const verdict = extractJson<CriticVerdict>(result.result);
  emitJobEvent(job, {
    actor,
    kind: "result",
    message: `${candidate.name}: ${verdict.score}/10 — ${verdict.verdict}`,
  });
  return { ...verdict, placeId: candidate.placeId, eta };
}

async function conclude(
  job: Job,
  apiKey: string,
  cwd: string,
  request: TripRequest,
  candidates: PlaceCandidate[],
  verdicts: Array<CriticVerdict & { eta?: { durationMinutes: number; distanceKm: number } }>,
): Promise<TripResult> {
  const dossier = candidates.map((c) => ({
    ...c,
    critic: verdicts.find((v) => v.placeId === c.placeId),
  }));

  await using agent = await Agent.create({ apiKey, model: MODEL, local: { cwd } });
  const run = await agent.send(
    `You are the CONCIERGE making the final call for an in-car food concierge. ` +
      `The passenger asked: "${request.query}".\n\n` +
      `Candidates with critic verdicts and drive times:\n${JSON.stringify(dossier, null, 2)}\n\n` +
      `Pick the single best option. Respond with ONLY JSON (no fences):\n` +
      `{"placeId": "...", "spokenSummary": "<2-3 warm, natural sentences a voice assistant will say ` +
      `while driving: the pick, why, and the drive time>"}`,
  );
  const result = await run.wait();
  if (result.status !== "finished" || !result.result) {
    throw new Error(`Concierge failed: ${result.status}`);
  }
  const pick = extractJson<{ placeId: string; spokenSummary: string }>(result.result);

  const winner = candidates.find((c) => c.placeId === pick.placeId) ?? candidates[0];
  const winnerVerdict = verdicts.find((v) => v.placeId === winner.placeId);
  const eta = winnerVerdict?.eta ?? (await computeDriveEstimate(request.origin, winner.placeId));

  return {
    restaurant: winner,
    etaMinutes: eta.durationMinutes,
    distanceKm: eta.distanceKm,
    mapsLink: mapsDeepLink(request.origin, winner.name, winner.placeId),
    spokenSummary: pick.spokenSummary,
    runnersUp: dossier
      .filter((d) => d.placeId !== winner.placeId)
      .map((d) => ({ name: d.name, verdict: d.critic?.verdict ?? "" })),
  };
}

function extractJson<T>(raw: string): T {
  const match = raw.match(/[\[{][\s\S]*[\]}]/);
  if (!match) throw new Error(`Agent did not return JSON: ${raw.slice(0, 200)}`);
  return JSON.parse(match[0]) as T;
}
