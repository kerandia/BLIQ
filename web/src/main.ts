/**
 * Thin dashboard glue. Voice logic lives in `./voice` — import from there only.
 */
import {
  startVoice,
  stopVoice,
  setVoiceCallbacks,
  isCallActive,
  onSaveLocation,
  updateCarPosition,
} from "./voice";

const toggleBtn = document.getElementById("toggle") as HTMLButtonElement;
const statusEl = document.getElementById("status")!;
const modeEl = document.getElementById("mode")!;
const logEl = document.getElementById("log")!;

function logEvent(actor: string, kind: string, message: string) {
  const div = document.createElement("div");
  div.className = `evt ${kind}`;
  div.innerHTML = `<span class="actor">[${actor}]</span> ${message}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

const watchedJobs = new Set<string>();

function watchJob(jobId: string) {
  if (watchedJobs.has(jobId)) return;
  watchedJobs.add(jobId);
  const source = new EventSource(`/api/jobs/${jobId}/stream`);
  source.onmessage = (e) => {
    const evt = JSON.parse(e.data) as { actor: string; kind: string; message: string };
    logEvent(evt.actor, evt.kind, evt.message);
  };
  source.onerror = () => source.close();
}

// Voice-started jobs are created server-side (via the Vapi webhook), so the
// browser never learns their ids directly — poll the job list and auto-watch
// anything new.
setInterval(async () => {
  try {
    const res = await fetch("/api/jobs");
    if (!res.ok) return;
    const jobs = (await res.json()) as { id: string }[];
    for (const job of jobs) watchJob(job.id);
  } catch {
    // server not up yet — retry on next tick
  }
}, 3000);

async function getPosition(): Promise<{ lat: number; lng: number }> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(new Error(`geolocation failed: ${err.message}`)),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  });
}

/** Text / demo path: kick the multi-agent trip pipeline without voice. */
async function startTripSearch(query: string): Promise<string> {
  const { lat, lng } = await getPosition();
  updateCarPosition(lat, lng);
  const res = await fetch("/api/navigate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, lat, lng }),
  });
  if (!res.ok) return `Could not start the search: ${await res.text()}`;
  const job = (await res.json()) as { id: string };
  watchJob(job.id);
  return `Job ${job.id} started — watch the live log for scout / critics / concierge.`;
}

setVoiceCallbacks({
  onCallStart: () => {
    statusEl.textContent = "connected";
    toggleBtn.textContent = "End voice session";
    toggleBtn.classList.add("live");
    // Seed GPS once so find_nearby_restaurants has a position.
    void getPosition()
      .then(({ lat, lng }) => updateCarPosition(lat, lng))
      .catch((err) => logEvent("voice", "error", err instanceof Error ? err.message : String(err)));
  },
  onCallEnd: () => {
    statusEl.textContent = "disconnected";
    toggleBtn.textContent = "Start voice session";
    toggleBtn.classList.remove("live");
    modeEl.textContent = "";
  },
  onAssistantSpeechStart: () => {
    modeEl.textContent = "🔊 agent speaking";
  },
  onAssistantSpeechEnd: () => {
    modeEl.textContent = "🎙️ listening";
  },
  onTranscript: ({ role, text, type }) => {
    if (type !== "final" || !text.trim()) return;
    logEvent(role === "assistant" ? "voice-agent" : "you", "log", text);
  },
  onError: (error) => {
    statusEl.textContent = "error";
    logEvent("voice", "error", error instanceof Error ? error.message : String(error));
  },
});

onSaveLocation(({ placeId, label }) => {
  logEvent("voice", "result", `Saved “${label}” (${placeId})`);
});

const textForm = document.getElementById("textForm") as HTMLFormElement;
const cravingInput = document.getElementById("craving") as HTMLInputElement;
textForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const query = cravingInput.value.trim();
  if (!query) return;
  cravingInput.value = "";
  try {
    const reply = await startTripSearch(query);
    logEvent("dashboard", "log", reply);
  } catch (err) {
    logEvent("dashboard", "error", err instanceof Error ? err.message : String(err));
  }
});

toggleBtn.addEventListener("click", async () => {
  try {
    if (isCallActive()) {
      await stopVoice();
    } else {
      statusEl.textContent = "connecting…";
      await startVoice();
    }
  } catch (err) {
    statusEl.textContent = "failed to connect";
    logEvent("voice", "error", err instanceof Error ? err.message : String(err));
  }
});
