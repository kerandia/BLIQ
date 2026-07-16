# BLIQ

**"I'm hungry" in the car → the best restaurant nearby + a ready-to-drive route.**

Hackathon prototype: while driving, you ask the voice agent (ElevenLabs) for food. A
multi-agent pipeline built on the [Cursor SDK](https://cursor.com/docs/sdk/typescript)
scouts restaurants via Google Places, sends parallel critic agents to judge each one
(including the real traffic-aware detour via Google Routes), and a concierge agent picks
the winner — returning a spoken summary and a Google Maps navigation deep link.

```
🎙️ Browser (ElevenLabs voice agent, client tools)
        │  find_restaurant_route / check_job
        ▼
🖥️ server (Express)  POST /api/navigate { query, lat, lng }
        │
        ▼
🤖 Cursor SDK orchestration            🌍 custom tools
   scout ──────────────────────────►  search_restaurants (Places API)
     │ shortlist (≤4)
     ├──► critic 1 ┐
     ├──► critic 2 ├── parallel ────►  get_drive_eta (Routes API)
     └──► critic 3 ┘
             │ scored verdicts
             ▼
        concierge ──► winner + spokenSummary + Google Maps deep link
```

## Setup

Requires **Node 22.13+**.

```bash
npm install
cp .env.example .env   # fill in CURSOR_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID
```

### Google Maps setup

Create a key at [console.cloud.google.com/google/maps-apis](https://console.cloud.google.com/google/maps-apis)
and enable **Places API (New)** and **Routes API** on it → `GOOGLE_MAPS_API_KEY`.

### ElevenLabs agent configuration (voice teammate: read this)

Create an agent at [elevenlabs.io/app/agents](https://elevenlabs.io/app/agents) and add two
**client tools** (Agent → Tools → Add tool → Client). The browser implements them in
`web/src/main.ts` — the dashboard config just declares them so the LLM knows they exist:

| Tool | Parameters | Description for the LLM |
|------|-----------|--------------------------|
| `find_restaurant_route` | `query` (string) | Find a great restaurant near the car and build a driving route. Pass the passenger's craving as `query` (cuisine, vibe, budget — whatever they said). Location is added automatically. |
| `check_job` | `job_id` (string) | Check progress of a running search. Call every few seconds and narrate what the agents are doing. When done, read the summary aloud. |

Suggested system prompt: *"You are an in-car food concierge. Chat naturally with the driver
about what they're craving. Once you understand it, call find_restaurant_route with their
request. While agents work, call check_job periodically and narrate progress briefly
('the critics are checking drive times...'). When finished, read the spoken summary and
tell them the route is on screen."*

### Backend contract (for the voice/frontend side)

- `POST /api/navigate` body `{ "query": "cheap good ramen", "lat": 52.36, "lng": 4.90 }` → `201 { "id": "<jobId>" }`
- `GET /api/jobs/:id` → `{ status, result, data, lastEvents }` where `status` ∈ `queued|planning|working|reviewing|done|error`; on `done`, `result` is the spoken summary and `data` is:
  ```json
  {
    "restaurant": { "name": "...", "rating": 4.6, "address": "...", "placeId": "..." },
    "etaMinutes": 12,
    "distanceKm": 4.3,
    "mapsLink": "https://www.google.com/maps/dir/?api=1&...",
    "runnersUp": [{ "name": "...", "verdict": "..." }]
  }
  ```
- `GET /api/jobs/:id/stream` — SSE feed of every agent event (great for the live demo panel)

## Run

```bash
npm run dev
```

- Web UI: http://localhost:5173 (click **Start voice session**, allow the mic)
- API: http://localhost:3001 (`GET /api/health` to verify keys are loaded)

Job artifacts land in `server/workspaces/<job-id>/` (`INPUT.md`, `task-*.md`, `FINISHED.md`).

## Layout

```
server/  Express API + Cursor SDK orchestrator (planner / workers / reviewer)
web/     Vite frontend + ElevenLabs voice session + live SSE event log
```
