# @gaws-hub/sdk

TypeScript SDK for building and calling [gaws-hub](https://github.com/) agents:
the **service contract** (sync + job services), the hub-brokered **bus/store**, and
a batteries-included **Hono agent server** with a built-in **job host**.

```bash
npm install github:Team-H2NO/gaws-hub-sdk
```

Stack: TypeScript · Node ≥ 20 (images target Node 24 LTS) · Hono 4 · Zod 4.
`dist/` is committed so the package installs without a build step.

## Provider — declare services, write handlers

```ts
import { createAgent, z } from "@gaws-hub/sdk";

createAgent({
  name: "echo",
  version: "0.1.0",
  services: [
    { name: "echo", kind: "sync", path: "/api/echo",
      handler: (input) => ({ youSent: input }) },

    { name: "slow-echo", kind: "job", path: "/api/slow-echo",
      handler: async (input, ctx) => {
        for (let i = 1; i <= 5 && !ctx.signal.aborted; i++) {
          await ctx.progress({ step: i, of: 5 }, `tick ${i}`);
          await new Promise(r => setTimeout(r, 500));
        }
        return { echoed: input };
      } },
  ],
  static: "./public",
});
```

The matching `manifest.yaml` declares the same `services[]` (so the hub can route
and cold-start). The SDK implements the runtime contract; you write only handlers.

## Consumer — call services by name (the hub routes + cold-starts)

```ts
import { hub } from "@gaws-hub/sdk";

const out  = await hub.invoke("echo", { hi: 1 });               // sync
const job  = await hub.runJob("slow-echo", { hi: 1 }, {         // job + live progress
  onProgress: (e) => console.log(e.kind, e.message ?? e.data),
});
console.log(job.result?.output);

await hub.busPublish("demo", { k: "v" });                       // hub-brokered bus
const msgs = await hub.busPull("demo");

await hub.presence({ label: "acme-bot", activity: "iter 1/5 · build" }); // sidebar label + live status
```

You never handle instance ids: `invoke`/`runJob` address by **service name**; the
hub picks a free provider or cold-starts one.

## Batteries — the common agent machinery

- **`runClaude(input, ctx, opts?)`** — run `claude -p` and surface its stream-json as
  live job progress, a compact status snapshot (for a UI bar), and §15 structured logs;
  resolves with the final summary. A `run-claude` job handler is one line:
  `handler: (i, ctx) => runClaude(i, ctx, { defaultTask })`. Low-level pieces
  (`claudeArgv`, `claudeEventToLogs`, `cleanModel`, `cleanEffort`, `summarize`,
  `MODELS`, `EFFORTS`) are exported for agents that compose their own loop (per-step
  models, `--max-turns`, the codex binary…); `opts.argv`/`bin`/`status` are the hooks.
  - **Prompts live as files (contract).** Whatever prompt you hand `runClaude`/`claudeArgv`
    must come from a `prompts/*.md` file loaded at call time, not a string literal baked
    into source — one `.md` per step, `{{name}}` placeholders for injected values,
    `--append-system-prompt` text included. This is **§16** of the agent interface
    (`agents-interface.md`); a three-line `fs.readFileSync` + `{{var}}` replace is the
    whole loader.
- **provider-side feed** (default on; opt out with `createAgent({ feed:false })`) —
  auto-wraps every `job` handler so its lifecycle/progress also lands in an in-process
  feed, served at `GET /api/served` (SSE, **replays the running backlog on connect**).
  So a cold-started provider's own page shows what it's running. `feed` /
  `served(name, handler)` are exported for manual use.
- **auto-presence for jobs** — the job host reports **presence** to the hub sidebar
  over each job's lifecycle (start → every `ctx.progress` → `idle`), so a provider
  needs no manual `hub.presence` call. Together with the feed this satisfies the
  contract's "surface what you're serving" rule (agents-interface §14) for free. For a
  *slow `sync`* service, call `hub.presence({activity})` yourself (sync isn't auto-fed).
- **workbench UI kit** — served at `/_gaws/agent-ui.{js,css}`, no build step. Import from
  your page: `import { createRunBars, createAskPanel, openSSE, jobDedup, persistFields,
  markdown } from "./_gaws/agent-ui.js"`. Gives you per-run status bars + a detail modal,
  the **"Ask" slide-in chat panel**, minimal markdown, cross-stream job dedup, and Setup
  persistence.
  - `createAskPanel(opts)` → a right-edge Q&A drawer with open/close/New-Chat/width all
    built in; returns `{ open, close, newChat, syncSubtitle, el }`. You supply only a
    trigger button and a couple of callbacks: `subtitle()` (header label, e.g. the loaded
    repo) and `body(question, sessionId)` (the POST body for a turn — add whatever context
    your endpoint needs). Width is remembered in `localStorage`; the long reply scrolls to
    its **top** so it reads from the start.

    ```js
    const ask = createAskPanel({
      subtitle: () => repo() || "no repo",
      body: (question, sessionId) => ({ repo: repo(), question, sessionId }),
    });
    document.getElementById("askbtn").onclick = ask.open;
    ```

    **Endpoint contract** (`opts.endpoint`, default `api/ask/stream`) — POST a turn, reply
    with a chunked text stream: zero or more `<<<STATUS>>>{…}` lines (one run snapshot each
    → the live banner) then one final `<<<ASKRESULT>>>{"answer"|"error","sessionId"}` line.
    The server owns the session id (first turn mints it, later turns echo it back to
    `--resume` the same chat). `runClaude`'s `<<<STATUS>>>` frames satisfy this directly —
    see the agent-builder's `/api/ask/stream` for a reference implementation.

## Surface

- `createAgent(opts)` → Hono app with `/healthz`, `/meta`, `/config`, `/api/served`
  (feed), `/_gaws/*` (UI kit), static assets, SIGTERM, and your sync/job service routes
  (job routes run via the job host).
- `hub` / `HubClient`: `discover`, `invoke`, `submitJob`, `runJob`, `getJob`,
  `streamJob`, `cancelJob`, `jobResult`, `busPublish`, `busPull`, `storeGet`, `storePut`,
  `presence` (advertise a sidebar label + live activity; best-effort, no-op without a token —
  **call it at every state transition**: set `label` once, then update `activity` alone each
  step, `""` to clear, `"idle"` when a job ends; omit a field to leave it unchanged).
- `runClaude`, `claudeArgv`, `claudeEventToLogs`, `cleanModel`, `cleanEffort`,
  `summarize`, `MODELS`, `EFFORTS`; `feed`, `served`; `log`, `runLoop`.
- `z`, `toJsonSchema` (zod 4 → JSON Schema for manifest descriptors).
- UI kit (browser, served at `/_gaws/agent-ui.{js,css}`): `createRunBars`,
  `createAskPanel`, `openSSE`, `jobDedup`, `persistFields`, `markdown`, `kfmt`, `clock`.
- CLI bins: `hub` (drive the hub HTTP plane), `gaws-manifest` (emit `manifest.yaml` from
  `GAWS_DESCRIBE=1`), `gaws-compliance` / `gaws-conformance` (contract checks), and
  `gaws-mem` — memory `recall` / `save` / `doctor` plus `gaws-mem hook <event>`, the
  **passive memory lane** for Claude Code (agents-interface §16.2;
  `hooks/claude-settings.json` wires SessionStart / UserPromptSubmit / PostToolUse /
  PostToolUseFailure): fenced recall injection with per-session dedup + budget, and
  failure-only `tool.failed` publishing to `sys.observations`. Fail-open, always exits 0.

Reads `HUB_URL` / `BUS_URL` / `STORE_URL` / `BUS_TOKEN` / `GAWS_HUB_INSTANCE` /
`AGENT_NAME` / `PORT` from the environment — never hardcode hostnames.
