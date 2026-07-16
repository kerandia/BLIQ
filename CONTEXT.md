# BLIQ — Team Context (updated 2026-07-16 evening)

Read this first. It's the single source of truth for where the project stands.

## The idea (pitch)

You're driving and hungry. You *talk* to the car: "find me good ramen, nothing fancy."
A voice agent captures the messy request, a **multi-agent pipeline** (Cursor SDK) scouts
restaurants (Google Places), sends parallel **critic agents** to judge each candidate with
real traffic-aware drive times (Google Routes), and a **concierge agent** picks the winner.
The voice agent reads the recommendation aloud and the route opens in Google Maps.

Hackathon scope check: ✅ voice agent · ✅ Cursor SDK agents · ✅ meaningful multi-agent
orchestration (scout → 4 parallel critics → concierge, all real agents with custom tools) ·
✅ messy work (rambling craving) → finished work (decision + ready-to-drive route).

## Current status

| Piece | Status |
|---|---|
| Backend pipeline (scout/critics/concierge) | ✅ **Verified end-to-end** with real keys — found "Ichisin Ramen Hokkaido", 2 min away, working nav link |
| Google Places + Routes integration | ✅ Working (Routes has haversine fallback if it 403s) |
| Web dashboard with live agent event log (SSE) | ✅ Working |
| Text-input fallback (test pipeline without voice) | ✅ Working |
| **ElevenLabs voice agent** | ❌ **TODO — voice teammate, see below** |
| Route display on dashboard (embedded map / QR) | ❌ TODO — plan agreed, not built (see "Open items") |

## Architecture

```
🎙️ Browser (ElevenLabs voice, client tools)        web/src/main.ts
        │  find_restaurant_route / check_job
        ▼
🖥️ Express server  POST /api/navigate {query,lat,lng}   server/src/index.ts
        ▼
🤖 Cursor SDK orchestration                         server/src/trip.ts
   scout ──(custom tool)──► search_restaurants → Google Places API (New)
     ├─► critic 1..4 (parallel) ──► get_drive_eta → Google Routes API
     └─► concierge → winner + spokenSummary + Google Maps deep link
```

- Jobs are in-memory (`server/src/jobs.ts`), progress streams via SSE (`GET /api/jobs/:id/stream`).
- Full API contract (request/response shapes) is in **README.md → "Backend contract"**.
- `server/src/orchestrator.ts` is an older generic planner/workers/reviewer pipeline (`POST /api/jobs`) — still works, not used by the food demo.

## Setup (each teammate)

```bash
git clone https://github.com/kerandia/BLIQ && cd BLIQ
npm install            # needs Node 22.13+
cp .env.example .env   # then get keys from Serhat (password manager / DM — never commit)
npm run dev            # server :3001 + web :5173
```

Keys currently live and working on Serhat's machine: `CURSOR_API_KEY`, `GOOGLE_API_KEY`
(Places API (New) + Routes API enabled). Alternative: run only the web app locally and
point `/api` at Serhat's server.

**Test without voice:** open http://localhost:5173, type a craving in the text box, allow
location, watch the agents work in the live log.

## Voice teammate — your task

Everything is ready for you; the browser side is already implemented in `web/src/main.ts`.

1. Create an agent at https://elevenlabs.io/app/agents
2. Declare two **client tools** on it (Agent → Tools → Add tool → Client) with EXACTLY these names/params — the README table has the LLM-facing descriptions to paste:
   - `find_restaurant_route(query: string)`
   - `check_job(job_id: string)`
3. System prompt suggestion is in README ("in-car food concierge…"). Key behavior: call
   `find_restaurant_route` once the craving is clear, then poll `check_job` every few
   seconds and narrate progress briefly, then read the final summary aloud.
4. Put `ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID` in `.env`, restart, click
   **Start voice session**, allow mic.

The server already has the WebRTC token endpoint (`GET /api/eleven/token`) for private agents.

## Open items / decisions

- **Route display** (agreed plan, not built): Google Maps **Embed API iframe** on the
  dashboard when the job completes (needs "Maps Embed API" enabled on the Google key)
  + **QR code** of the deep link so a phone can grab the navigation. ~1h total.
- Demo flow target: speak craving → agents visibly working in live log → voice reads pick
  → route map + QR appear.
- Phone demo needs HTTPS (mic + geolocation) — use `ngrok http 5173`; laptop demo is the safe path.
- Team eligibility: prize requires ≥3 members.

## Repo

https://github.com/kerandia/BLIQ (public) — branch `main`. Small commits, push often so we
don't diverge.
