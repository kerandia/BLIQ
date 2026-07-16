# BLIQ — Agent Instructions

Read `CONTEXT.md` for full project state and team division of work.

## What this is

Hackathon prototype: in-car voice food concierge. ElevenLabs voice agent (browser) →
Express server → Cursor SDK multi-agent pipeline (scout → parallel critics → concierge)
using Google Places (New) + Routes APIs as custom agent tools → spoken recommendation +
Google Maps navigation deep link.

## Layout

- `server/src/index.ts` — Express API. Key endpoints: `POST /api/navigate`, `GET /api/jobs/:id`, `GET /api/jobs/:id/stream` (SSE), `GET /api/eleven/token`
- `server/src/trip.ts` — the food-trip multi-agent pipeline (the heart of the project)
- `server/src/googlemaps.ts` — Places/Routes wrappers + deep-link builder
- `server/src/jobs.ts` — in-memory job store + event bus
- `server/src/orchestrator.ts` — older generic pipeline, unused by the food demo; don't extend it
- `web/src/main.ts` — ElevenLabs voice session, client tools (`find_restaurant_route`, `check_job`), SSE log, text fallback

## Conventions & gotchas

- Node 22.13+, npm workspaces. `npm run dev` runs server (:3001) + web (:5173, proxies `/api`).
- Typecheck before committing: `npm run typecheck`.
- Env: root `.env` (gitignored). Server loads it explicitly from repo root — see top of `server/src/index.ts`. Google key may be named `GOOGLE_MAPS_API_KEY` or `GOOGLE_API_KEY`.
- Agents must reply with bare JSON; parsing is tolerant (`extractJson`) but keep prompts strict.
- Cursor SDK agents get capabilities via `customTools` (see `trip.ts`) — prefer adding tools over having agents shell out.
- Routes API failures must never kill a job — keep the haversine fallback pattern.
- Never commit secrets; `.env.example` is the template.
