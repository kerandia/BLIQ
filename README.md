# BLIQ

**Voice in → orchestrated agents → finished work out.**

Hackathon prototype: a voice agent (ElevenLabs) captures a messy work request, then a
multi-agent pipeline built on the [Cursor SDK](https://cursor.com/docs/sdk/typescript)
(planner → parallel workers → reviewer) turns it into a finished deliverable. Progress
streams live to the dashboard and the voice agent reports it conversationally.

```
🎙️ Browser (ElevenLabs voice agent, client tools)
        │  start_job / check_job
        ▼
🖥️ server (Express)
        │
        ▼
🤖 Cursor SDK orchestration
   planner ──► worker 1 ┐
           ──► worker 2 ├──► reviewer ──► FINISHED.md + spoken summary
           ──► worker 3 ┘
```

## Setup

Requires **Node 22.13+**.

```bash
npm install
cp .env.example .env   # fill in CURSOR_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID
```

### ElevenLabs agent configuration

Create an agent at [elevenlabs.io/app/agents](https://elevenlabs.io/app/agents) and add two
**client tools** (Agent → Tools → Add tool → Client):

| Tool | Parameters | Description for the LLM |
|------|-----------|--------------------------|
| `start_job` | `prompt` (string) | Start turning the user's messy request into finished work. Pass the full request, cleaned up, as `prompt`. |
| `check_job` | `job_id` (string) | Check progress of a running job and report it to the user. |

Suggested first message / system prompt: the agent interviews the user about what they need,
calls `start_job` once the request is clear, then periodically calls `check_job` and narrates
progress.

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
