import { Conversation } from "@elevenlabs/client";

const toggleBtn = document.getElementById("toggle") as HTMLButtonElement;
const statusEl = document.getElementById("status")!;
const modeEl = document.getElementById("mode")!;
const logEl = document.getElementById("log")!;

let conversation: Conversation | null = null;

function logEvent(actor: string, kind: string, message: string) {
  const div = document.createElement("div");
  div.className = `evt ${kind}`;
  div.innerHTML = `<span class="actor">[${actor}]</span> ${message}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

/** Subscribe to a job's SSE stream and mirror events into the dashboard. */
function watchJob(jobId: string) {
  const source = new EventSource(`/api/jobs/${jobId}/stream`);
  source.onmessage = (e) => {
    const evt = JSON.parse(e.data) as { actor: string; kind: string; message: string };
    logEvent(evt.actor, evt.kind, evt.message);
  };
  source.onerror = () => source.close();
}

/**
 * Client tools the ElevenLabs agent can call. Register tools with the SAME
 * names ("start_job", "check_job") on the agent in the ElevenLabs dashboard
 * (Agent → Tools → Client tool) so the LLM knows they exist.
 */
const clientTools = {
  start_job: async ({ prompt }: { prompt: string }) => {
    const res = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const job = (await res.json()) as { id: string; status: string };
    watchJob(job.id);
    logEvent("voice", "log", `Started job ${job.id}`);
    return `Job started with id ${job.id}. Poll it with check_job.`;
  },
  check_job: async ({ job_id }: { job_id: string }) => {
    const res = await fetch(`/api/jobs/${job_id}`);
    if (!res.ok) return `No job found with id ${job_id}.`;
    const job = (await res.json()) as {
      status: string;
      result?: string;
      error?: string;
      lastEvents: { actor: string; message: string }[];
    };
    if (job.status === "done") return `Finished! Result: ${job.result}`;
    if (job.status === "error") return `The job failed: ${job.error}`;
    const recent = job.lastEvents.map((e) => `${e.actor}: ${e.message}`).join(" | ");
    return `Status: ${job.status}. Recent activity: ${recent}`;
  },
};

async function start() {
  statusEl.textContent = "connecting…";
  const tokenRes = await fetch("/api/eleven/token");
  const session: Parameters<typeof Conversation.startSession>[0] = tokenRes.ok
    ? { conversationToken: (await tokenRes.json()).token, connectionType: "webrtc" }
    : { agentId: import.meta.env.VITE_ELEVENLABS_AGENT_ID as string, connectionType: "webrtc" };

  conversation = await Conversation.startSession({
    ...session,
    clientTools,
    onConnect: () => {
      statusEl.textContent = "connected";
      toggleBtn.textContent = "End voice session";
      toggleBtn.classList.add("live");
    },
    onDisconnect: () => {
      statusEl.textContent = "disconnected";
      toggleBtn.textContent = "Start voice session";
      toggleBtn.classList.remove("live");
      conversation = null;
    },
    onModeChange: ({ mode }) => {
      modeEl.textContent = mode === "speaking" ? "🔊 agent speaking" : "🎙️ listening";
    },
    onMessage: ({ source, message }) => {
      logEvent(source === "ai" ? "voice-agent" : "you", "log", message);
    },
    onError: (message) => logEvent("voice", "error", String(message)),
  });
}

toggleBtn.addEventListener("click", async () => {
  if (conversation) {
    await conversation.endSession();
  } else {
    await start().catch((err) => {
      statusEl.textContent = "failed to connect";
      logEvent("voice", "error", err instanceof Error ? err.message : String(err));
    });
  }
});
