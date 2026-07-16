import { Agent } from "@cursor/sdk";
import path from "node:path";
import fs from "node:fs/promises";
import { type Job, emitJobEvent, setJobStatus } from "./jobs.js";

const MODEL = { id: process.env.CURSOR_MODEL ?? "composer-2.5" };
const MAX_WORKERS = Number(process.env.MAX_WORKERS ?? 3);

interface PlannedTask {
  title: string;
  instructions: string;
}

/**
 * Multi-agent orchestration pipeline:
 *   1. Planner agent  — decomposes the messy input into discrete tasks
 *   2. Worker agents  — run in parallel, one per task
 *   3. Reviewer agent — merges and polishes worker output into the finished artifact
 *
 * Each job gets its own workspace directory that the agents share.
 */
export async function runJob(job: Job): Promise<void> {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    setJobStatus(job, "error");
    job.error = "CURSOR_API_KEY is not set";
    emitJobEvent(job, { actor: "system", kind: "error", message: job.error });
    return;
  }

  const workspace = path.resolve("workspaces", job.id);
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "INPUT.md"), job.prompt, "utf8");

  try {
    // ── 1. Plan ────────────────────────────────────────────────────────────
    setJobStatus(job, "planning", "Planner agent is decomposing the request");
    const tasks = await plan(job, apiKey, workspace);
    emitJobEvent(job, {
      actor: "planner",
      kind: "result",
      message: `Planned ${tasks.length} task(s): ${tasks.map((t) => t.title).join("; ")}`,
      data: { tasks },
    });

    // ── 2. Work (parallel fan-out) ─────────────────────────────────────────
    setJobStatus(job, "working", `Spawning ${tasks.length} worker agent(s)`);
    const outputs = await Promise.all(
      tasks.map((task, i) => runWorker(job, apiKey, workspace, task, i)),
    );

    // ── 3. Review / merge ──────────────────────────────────────────────────
    setJobStatus(job, "reviewing", "Reviewer agent is merging and polishing");
    const finished = await review(job, apiKey, workspace, outputs);

    job.result = finished;
    emitJobEvent(job, { actor: "reviewer", kind: "result", message: finished });
    setJobStatus(job, "done", "Finished work is ready");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    job.error = message;
    setJobStatus(job, "error");
    emitJobEvent(job, { actor: "system", kind: "error", message });
  }
}

async function plan(job: Job, apiKey: string, cwd: string): Promise<PlannedTask[]> {
  await using agent = await Agent.create({ apiKey, model: MODEL, local: { cwd } });
  const run = await agent.send(
    `You are the PLANNER in a multi-agent pipeline. Read INPUT.md — it contains a messy, ` +
      `unstructured work request captured from a voice conversation.\n\n` +
      `Decompose it into at most ${MAX_WORKERS} independent tasks that can run in parallel. ` +
      `Respond with ONLY a JSON array (no markdown fences) of objects: ` +
      `[{"title": "...", "instructions": "..."}]. Instructions must be self-contained.`,
  );
  const result = await run.wait();
  if (result.status !== "finished" || !result.result) {
    throw new Error(`Planner failed: ${result.status}`);
  }
  emitJobEvent(job, { actor: "planner", kind: "log", message: "Planner finished" });
  return parseTasks(result.result);
}

async function runWorker(
  job: Job,
  apiKey: string,
  cwd: string,
  task: PlannedTask,
  index: number,
): Promise<string> {
  const actor = `worker:${index + 1}`;
  emitJobEvent(job, { actor, kind: "log", message: `Started: ${task.title}` });

  await using agent = await Agent.create({ apiKey, model: MODEL, local: { cwd } });
  const run = await agent.send(
    `You are WORKER ${index + 1} in a multi-agent pipeline working in a shared workspace.\n` +
      `The original messy request is in INPUT.md.\n\n` +
      `Your task: ${task.title}\n${task.instructions}\n\n` +
      `Write your output to task-${index + 1}.md and end with a one-paragraph summary.`,
  );
  const result = await run.wait();
  if (result.status !== "finished") {
    throw new Error(`${actor} failed with status ${result.status}`);
  }
  emitJobEvent(job, {
    actor,
    kind: "result",
    message: result.result ?? "(no summary)",
    data: { usage: result.usage },
  });
  return result.result ?? "";
}

async function review(
  job: Job,
  apiKey: string,
  cwd: string,
  workerOutputs: string[],
): Promise<string> {
  await using agent = await Agent.create({ apiKey, model: MODEL, local: { cwd } });
  const run = await agent.send(
    `You are the REVIEWER in a multi-agent pipeline. The original request is in INPUT.md ` +
      `and the workers wrote their outputs to task-*.md files.\n\n` +
      `Worker summaries:\n${workerOutputs.map((o, i) => `--- worker ${i + 1} ---\n${o}`).join("\n")}\n\n` +
      `Merge everything into a single polished deliverable in FINISHED.md, ` +
      `then reply with a concise spoken-style summary (2-4 sentences) suitable for a voice ` +
      `agent to read aloud to the user.`,
  );
  const result = await run.wait();
  if (result.status !== "finished" || !result.result) {
    throw new Error(`Reviewer failed: ${result.status}`);
  }
  return result.result;
}

function parseTasks(raw: string): PlannedTask[] {
  // Tolerate markdown fences or prose around the JSON array
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("Planner did not return a JSON array");
  const parsed = JSON.parse(match[0]) as PlannedTask[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Planner returned an empty plan");
  }
  return parsed.slice(0, MAX_WORKERS).map((t) => ({
    title: String(t.title ?? "Untitled task"),
    instructions: String(t.instructions ?? ""),
  }));
}
