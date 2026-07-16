/**
 * Thin dashboard glue. Voice logic lives in `./voice` — import from there only.
 */
import {
  startVoice,
  stopVoice,
  setVoiceCallbacks,
  isCallActive,
  setMicMuted,
  onSaveLocation,
  updateCarPosition,
} from "./voice";

const toggleBtn = document.getElementById("toggle") as HTMLButtonElement;
const muteBtn = document.getElementById("mute") as HTMLButtonElement;
const muteHint = document.getElementById("muteHint")!;
const statusEl = document.getElementById("status")!;
const modeEl = document.getElementById("mode")!;
const logEl = document.getElementById("log")!;

function logEvent(actor: string, kind: string, message: string) {
  if (logEl.dataset.empty) {
    logEl.textContent = "";
    delete logEl.dataset.empty;
  }
  const div = document.createElement("div");
  div.className = `evt ${kind}`;
  div.innerHTML = `<span class="actor">[${actor}]</span> ${message}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

const mapPanel = document.getElementById("mapPanel")!;
const mapFrame = document.getElementById("mapFrame") as HTMLIFrameElement;
const routeCard = document.getElementById("routeCard")!;

interface RouteData {
  restaurant: { name: string; rating?: number; ratingCount?: number; address?: string };
  origin: { lat: number; lng: number };
  etaMinutes: number;
  distanceKm: number;
  mapsLink: string;
}

/** Show the route on the dashboard: embedded directions map + result card. */
function showRoute(data: RouteData) {
  const { restaurant, origin, etaMinutes, distanceKm, mapsLink } = data;
  const saddr = `${origin.lat},${origin.lng}`;
  const daddr = encodeURIComponent(`${restaurant.name}, ${restaurant.address ?? ""}`);
  // Keyless Google Maps directions embed — good enough for the prototype;
  // swap for the Maps Embed API iframe if we want an official/production map.
  mapFrame.src = `https://maps.google.com/maps?saddr=${saddr}&daddr=${daddr}&output=embed`;
  routeCard.innerHTML = `
    <div>
      <div class="route-name">${restaurant.name}</div>
      <div class="route-meta">
        ⭐ ${restaurant.rating ?? "?"} (${restaurant.ratingCount ?? "?"} reviews)
        · 🚗 ${etaMinutes} min · ${distanceKm} km
      </div>
    </div>
    <a class="btn-navigate" href="${mapsLink}" target="_blank">Navigate ▸</a>`;
  mapPanel.hidden = false;
  mapPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/** When a job finishes, fetch its structured result and render the map. */
async function onJobDone(jobId: string) {
  const res = await fetch(`/api/jobs/${jobId}`);
  if (!res.ok) return;
  const job = (await res.json()) as { data?: RouteData };
  if (job.data?.mapsLink && job.data.origin) showRoute(job.data);
}

const watchedJobs = new Set<string>();

function watchJob(jobId: string) {
  if (watchedJobs.has(jobId)) return;
  watchedJobs.add(jobId);
  const source = new EventSource(`/api/jobs/${jobId}/stream`);
  source.onmessage = (e) => {
    const evt = JSON.parse(e.data) as {
      actor: string;
      kind: string;
      message: string;
      data?: { status?: string };
    };
    logEvent(evt.actor, evt.kind, evt.message);
    if (evt.kind === "status" && evt.data?.status === "done") void onJobDone(jobId);
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

// ── Mic mute (open mics transcribe everything — mute between questions) ──
let micMuted = false;

function applyMute(muted: boolean) {
  micMuted = muted;
  setMicMuted(muted);
  muteBtn.textContent = muted ? "Unmute mic" : "Mute mic";
  muteBtn.classList.toggle("is-muted", muted);
  modeEl.textContent = muted ? "🔇 muted" : "🎙️ listening";
}

muteBtn.addEventListener("click", () => applyMute(!micMuted));

// Push-to-talk while muted: hold Space to open the mic
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || e.repeat || !micMuted) return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  e.preventDefault();
  setMicMuted(false);
  modeEl.textContent = "🎙️ push-to-talk";
});
document.addEventListener("keyup", (e) => {
  if (e.code !== "Space" || !micMuted) return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  setMicMuted(true);
  modeEl.textContent = "🔇 muted";
});

setVoiceCallbacks({
  onCallStart: () => {
    statusEl.textContent = "connected";
    toggleBtn.textContent = "End voice session";
    toggleBtn.classList.add("live");
    muteBtn.hidden = false;
    muteHint.hidden = false;
    applyMute(false);
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
    micMuted = false;
    muteBtn.hidden = true;
    muteHint.hidden = true;
  },
  onAssistantSpeechStart: () => {
    modeEl.textContent = "🔊 agent speaking";
  },
  onAssistantSpeechEnd: () => {
    modeEl.textContent = micMuted ? "🔇 muted" : "🎙️ listening";
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
