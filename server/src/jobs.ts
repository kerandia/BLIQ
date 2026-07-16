import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export type JobStatus = "queued" | "planning" | "working" | "reviewing" | "done" | "error";

export interface JobEvent {
  ts: number;
  /** Which orchestration actor emitted this (planner, worker:N, reviewer, system) */
  actor: string;
  kind: "status" | "log" | "result" | "error";
  message: string;
  data?: unknown;
}

export interface Job {
  id: string;
  prompt: string;
  status: JobStatus;
  createdAt: number;
  events: JobEvent[];
  result?: string;
  error?: string;
}

const jobs = new Map<string, Job>();
export const jobBus = new EventEmitter();

export function createJob(prompt: string): Job {
  const job: Job = {
    id: randomUUID(),
    prompt,
    status: "queued",
    createdAt: Date.now(),
    events: [],
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function emitJobEvent(job: Job, event: Omit<JobEvent, "ts">): void {
  const full: JobEvent = { ts: Date.now(), ...event };
  job.events.push(full);
  jobBus.emit(`job:${job.id}`, full);
}

export function setJobStatus(job: Job, status: JobStatus, message?: string): void {
  job.status = status;
  emitJobEvent(job, {
    actor: "system",
    kind: "status",
    message: message ?? `Job is now ${status}`,
    data: { status },
  });
}
