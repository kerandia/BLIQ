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
function getPosition(): Promise<{ lat: number; lng: number }> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(new Error(`geolocation failed: ${err.message}`)),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  });
}

const clientTools = {
  /** "Find me good ramen nearby" → scout/critics/concierge pipeline + route */
  find_restaurant_route: async ({ query }: { query: string }) => {
    const { lat, lng } = await getPosition();
    const res = await fetch("/api/navigate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, lat, lng }),
    });
    if (!res.ok) return `Could not start the search: ${await res.text()}`;
    const job = (await res.json()) as { id: string };
    watchJob(job.id);
    logEvent("voice", "log", `Restaurant search started (job ${job.id})`);
    return (
      `Job ${job.id} started: agents are scouting restaurants and checking routes. ` +
      `Poll with check_job every few seconds and narrate progress to the passenger.`
    );
  },
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
      data?: { mapsLink?: string; etaMinutes?: number; restaurant?: { name?: string } };
      error?: string;
      lastEvents: { actor: string; message: string }[];
    };
    if (job.status === "done") {
      if (job.data?.mapsLink) {
        logEvent("route", "result", `<a href="${job.data.mapsLink}" target="_blank">Open route in Google Maps → ${job.data.restaurant?.name ?? ""}</a>`);
        return `${job.result} The route is on screen — about ${job.data.etaMinutes} minutes away.`;
      }
      return `Finished! Result: ${job.result}`;
    }
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

// Text fallback: exercise the agent pipeline without a voice session
const textForm = document.getElementById("textForm") as HTMLFormElement;
const cravingInput = document.getElementById("craving") as HTMLInputElement;
textForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const query = cravingInput.value.trim();
  if (!query) return;
  cravingInput.value = "";
  try {
    const reply = await clientTools.find_restaurant_route({ query });
    logEvent("dashboard", "log", reply);
  } catch (err) {
    logEvent("dashboard", "error", err instanceof Error ? err.message : String(err));
  }
});

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
