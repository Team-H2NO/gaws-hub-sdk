# Refactor: lift agent-template's reusable features into @gaws-hub/sdk

Date: 2026-06-28 · Scope: **gaws-hub-sdk + gaws-hub-agent-template only** (other agents
are the justification, not in-scope to change).

## Goal

The template carries code that every real agent re-implements. Lift the reusable parts
into the SDK so a new agent writes only its handlers + manifest + a thin UI skin, while
the SDK owns the contract *and* the common machinery. Keep flexibility everywhere except
the strict contract (handlers/manifest). **The template's observable feature set must be
byte-for-behaviour identical after the refactor** — verified interactively against the
existing `gaws-hub-agent-template:latest` image (version `51acfc6`).

## What's duplicated (evidence)

- **`claude -p` runner**: agent-builder, agent-optimizer, crawler, cc, codex each spawn a
  claude-like CLI and parse its output. The template's `run-claude` *explicitly mirrors
  agent-builder*; the model/effort cleaners are **identical** across template + builder +
  optimizer. → SDK.
- **served-feed** (provider-side activity feed so a cold-started provider's own page shows
  what it's running): only the template has it today, but it closes a gap every provider
  has. → SDK (default-on).
- **3-column workbench UI** (per-run status bars + detail modal + minimal markdown + job
  SSE dedup + Setup persistence): every agent ships a `public/index.html`; nobody imports
  the SDK's older `web/job-log.js`/`shell.css`. → SDK web kit, served at `/_gaws/`.

## SDK additions

1. **`src/claude.ts`** — extracted verbatim from the template:
   - `MODELS`, `EFFORTS`, `cleanModel`, `cleanEffort`, `claudeArgv`, `summarize`,
     `claudeEventToLogs` (the low-level pieces, for agents that compose their own loop —
     builder per-step models, crawler `--max-turns`, codex binary, etc.).
   - `runClaude(input, emit, opts?)` — the high-level runner from `server.js`: spawns
     `claude -p`, parses stream-json into a live **status snapshot** + §15 logs + hub job
     progress, returns the final `summary`. `emit` is any `{jobId?, signal?, progress?,
     log?}` (a JobContext satisfies it). `opts`: `{ defaultTask?, bin?, argv?, cwd?, env?,
     maxTask?, status? }` where `status(summary)` lets a caller extend the snapshot.
   - Flexibility: low-level exports + `argv`/`bin`/`status` hooks cover the codex/crawler
     variants without forcing them into one schema.

2. **`src/feed.ts`** — `feed` (bounded ring buffer + pub/sub) and `served(name, handler)`,
   extracted verbatim from the template.

3. **`createAgent` enhancements** (`src/server.ts`):
   - Serve the SDK web kit at `/_gaws/*` (read from the package `web/` dir at startup).
   - **feed default-on** (opt-out `feed:false`): auto-wrap every `job` handler with
     `served(name, …)` and register `GET /api/served` (the SSE the UI opens on load).
   - Everything else (`/healthz`, `/meta`, `/config`, sync/job routes, SIGTERM) unchanged.

4. **`web/agent-ui.js` + `web/agent-ui.css`** — the reusable UI engine: `markdown()`,
   the run-bars+modal widget, `persistFields()`, and an SSE `stream()` helper with
   Last-Event-ID reconnect (folding in the old `job-log.js` idea). Replaces
   `web/job-log.js` + `web/shell.css` (unused by anyone).

## Template after refactor

- `server.js`: handlers only. `run-claude` → `handler: (i, ctx) => runClaude(i, ctx,
  { defaultTask: DEFAULT_TASK })`. No `served()` wrapping, no `/api/served` route (SDK
  provides both). Keeps `pipeline`/`random-artifact` and the `/api/run`·`/api/demo`
  consumer demo (the flexible, agent-specific part).
- `lib.js`: keeps the demo-specific pure helpers (`makeArtifact`, `stepScript`,
  `pickFailStep`). Claude helpers move to the SDK.
- `public/index.html`: thin skin — its own 3-col layout/theme + service cards + ~40 lines
  of button glue, importing the kit from `/_gaws/`. The engine (status bars, modal,
  markdown, persistence, SSE) comes from the SDK.
- `feed.js`: **deleted** (moved to SDK).
- Tests for the moved logic move to the SDK; the template keeps tests for its own helpers.

## Parity acceptance checklist (verified interactively, old image vs refactored)

Endpoints + exact shapes must match: `GET /healthz`→`ok`; `GET /meta`
(`{id,kind,version,capabilities.services[]}`); `GET /config`
(`{name,version,instance,defaultTask}`); `POST /api/random-artifact`
(`{artifact:{id,kind,value,at}, by, caller}`); SSE `GET /api/run?service=…`
(`log`/`done`/`error` events, lines tagged with `job`); SSE `GET /api/demo`
(discover→invoke→runJob→bus steps); SSE `GET /api/served` (`served` events:
`start`/`progress`/`done`, claude `status` snapshots); `POST /api/cancel/:id`. Job
services: `pipeline` (progress `{step,of,in,out}`), `run-claude` (`claude.*` events +
`status` snapshot fields `state,model,session,activity,toolCalls,turns,tokensIn,
tokensOut,costUsd,elapsedMs[,text]`). UI: status bars, detail modal (markdown when done /
live log + Cancel while running), job dedup across the two streams, Setup persistence,
`hub`/`serving` badges. `manifest.yaml` unchanged → identical hub registration.
**`/_gaws/*` is the only new endpoint (additive).**

## Verification method

Build refactored SDK (`npm run build` → `npm pack` → tgz); build a throwaway template
image against the tgz (committed Dockerfile still installs the SDK from GitHub `#main`);
register it as a separate agent type in the running pre-prod hub and exercise every
endpoint/stream A/B against the live `agent-template`. Run unit tests in both repos.

## Deployment note (out of band)

The committed template installs `@gaws-hub/sdk#main`, so production requires the SDK
change to be pushed to GitHub `main` **before** the template is rebuilt for real. That
push affects every agent on `#main` and is left as an explicit, separate step.
