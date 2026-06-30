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
  feed, served at `GET /api/served` (SSE). So a cold-started provider's own page shows
  what it's running. `feed` / `served(name, handler)` are exported for manual use.
- **workbench UI kit** — served at `/_gaws/agent-ui.{js,css}`. Import it from your page
  (`import { createRunBars, createAskPanel, openSSE, jobDedup, persistFields, markdown } from
  "./_gaws/agent-ui.js"`) for per-run status bars + a detail modal, an "Ask" slide-in chat
  panel, minimal markdown, cross-stream job dedup, and Setup persistence — no build step.
  `createAskPanel({ subtitle, body })` builds a right-edge Q&A drawer that streams a
  resumable claude turn; its endpoint streams `<<<STATUS>>>` frames + a final
  `<<<ASKRESULT>>>` line (see the function header for the contract).

## Surface

- `createAgent(opts)` → Hono app with `/healthz`, `/meta`, `/config`, `/api/served`
  (feed), `/_gaws/*` (UI kit), static assets, SIGTERM, and your sync/job service routes
  (job routes run via the job host).
- `hub` / `HubClient`: `discover`, `invoke`, `submitJob`, `runJob`, `getJob`,
  `streamJob`, `cancelJob`, `jobResult`, `busPublish`, `busPull`, `storeGet`, `storePut`.
- `runClaude`, `claudeArgv`, `claudeEventToLogs`, `cleanModel`, `cleanEffort`,
  `summarize`, `MODELS`, `EFFORTS`; `feed`, `served`; `log`, `runLoop`.
- `z`, `toJsonSchema` (zod 4 → JSON Schema for manifest descriptors).

Reads `HUB_URL` / `BUS_URL` / `STORE_URL` / `BUS_TOKEN` / `GAWS_HUB_INSTANCE` /
`AGENT_NAME` / `PORT` from the environment — never hardcode hostnames.
