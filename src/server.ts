// createAgent — a batteries-included gaws-hub agent server (Hono on Node).
// Wires /healthz, /meta, /config, static assets, graceful SIGTERM, and — for
// declared services — the runtime contract: sync handlers and the job host.
//
// An author writes only handlers (+ optional zod schemas); the manifest.yaml
// (with the matching `services[]`) is authored alongside and baked into the image.

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { streamSSE } from "hono/streaming";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { env } from "./env.js";
import { startJob, type JobContext } from "./jobhost.js";
import { served, feed } from "./feed.js";

/** Anything with a zod-style `.safeParse` (kept duck-typed to avoid a hard zod dep). */
interface Validator {
  safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: unknown };
}

export interface SyncContext {
  /** The calling instance id, if the hub stamped one. */
  caller?: string;
}

export interface SyncService {
  name: string;
  kind: "sync";
  path: string;
  method?: string;
  request?: Validator;
  handler: (input: unknown, ctx: SyncContext) => Promise<unknown> | unknown;
}

export interface JobService {
  name: string;
  kind: "job";
  path: string;
  request?: Validator;
  handler: (input: unknown, ctx: JobContext) => Promise<unknown> | unknown;
}

export type ServiceDef = SyncService | JobService;

export interface AgentOptions {
  name: string;
  version?: string;
  capabilities?: Record<string, unknown>;
  services?: ServiceDef[];
  /** Extra routes (e.g. an interactive UI API). */
  routes?: (app: Hono) => void;
  /** Static asset dir to serve at `/*` (relative to cwd, e.g. "./public"). */
  static?: string;
  /** Extra fields merged into GET /config. */
  config?: Record<string, unknown>;
  /**
   * Provider-side activity feed (default on). Auto-wraps every `job` handler so its
   * lifecycle/progress also lands in an in-process feed, and serves it at
   * `GET /api/served` (the SSE the workbench UI opens on load, so a cold-started
   * provider always shows what it is running). Set `false` to opt out.
   */
  feed?: boolean;
}

export function createAgent(opts: AgentOptions): Hono {
  const app = new Hono();
  const services = opts.services ?? [];
  const feedOn = opts.feed !== false;

  app.get("/healthz", (c) => c.text("ok"));
  app.get("/meta", (c) =>
    c.json({
      id: env.instance,
      kind: opts.name,
      version: opts.version ?? "0.0.0",
      capabilities: {
        ...(opts.capabilities ?? {}),
        services: services.map((s) => ({ name: s.name, kind: s.kind })),
      },
    }),
  );
  app.get("/config", (c) =>
    c.json({ name: opts.name, version: opts.version ?? "0.0.0", instance: env.instance, ...(opts.config ?? {}) }),
  );

  for (const svc of services) {
    if (svc.kind === "sync") {
      const method = (svc.method ?? "POST").toUpperCase();
      app.on(method, svc.path, async (c) => {
        const input = await readBody(c);
        const checked = validate(svc.request, input);
        if (!checked.ok) return c.json({ error: checked.error }, 400);
        try {
          const out = await svc.handler(checked.value, { caller: c.req.header("x-gaws-caller-instance") });
          return c.json((out ?? {}) as Record<string, unknown>);
        } catch (e) {
          return c.json({ error: String(e instanceof Error ? e.message : e) }, 500);
        }
      });
    } else {
      // Job dispatch: ack fast (202), run detached via the job host. When the feed
      // is on, wrap the handler so its progress also reaches GET /api/served.
      const handler = feedOn ? served(svc.name, svc.handler) : svc.handler;
      app.post(svc.path, async (c) => {
        const jobId = c.req.header("x-gaws-job");
        if (!jobId) return c.json({ error: "missing x-gaws-job (dispatch only via the hub job API)" }, 400);
        const input = await readBody(c);
        const checked = validate(svc.request, input);
        if (!checked.ok) return c.json({ error: checked.error }, 400);
        void startJob(jobId, checked.value, handler);
        return c.json({ accepted: true, jobId }, 202);
      });
    }
  }

  // Provider-side activity feed: stream the local feed (backlog first, then live).
  if (feedOn) {
    app.get("/api/served", (c) =>
      streamSSE(c, async (stream) => {
        const pending = [...feed.recent()];                 // backlog first
        let alive = true;
        const unsub = feed.subscribe((e) => pending.push(e));
        stream.onAbort(() => { alive = false; unsub(); });
        while (alive) {
          while (pending.length) await stream.writeSSE({ event: "served", data: JSON.stringify(pending.shift()) });
          await stream.sleep(300);                           // drain ~3×/s; avoids concurrent writes
        }
        unsub();
      }),
    );
  }

  serveSdkWeb(app); // reusable UI kit at /_gaws/* (status bars, modal, markdown, persistence)
  opts.routes?.(app);
  if (opts.static) app.get("/*", serveStatic({ root: opts.static }));

  const server = serve({ fetch: app.fetch, port: env.port, hostname: "0.0.0.0" }, (info) =>
    console.log(`[${opts.name}] listening on :${info.port} (instance ${env.instance})`),
  );
  const shutdown = () => {
    try {
      (server as { close?: () => void }).close?.();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return app;
}

async function readBody(c: { req: { text: () => Promise<string> } }): Promise<unknown> {
  const t = await c.req.text();
  if (!t) return {};
  try {
    return JSON.parse(t);
  } catch {
    return {};
  }
}

function validate(schema: Validator | undefined, input: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!schema) return { ok: true, value: input };
  const r = schema.safeParse(input);
  if (r.success) return { ok: true, value: r.data ?? input };
  return { ok: false, error: `invalid request: ${JSON.stringify(r.error)}` };
}

const CONTENT_TYPES: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  html: "text/html; charset=utf-8",
  json: "application/json; charset=utf-8",
};

// Serve the SDK's reusable web kit (web/*) at /_gaws/<file>, read once at startup.
// An agent UI imports it relatively (it shares the agent's origin under /a/<id>/),
// so a new agent gets the status-bar/modal/markdown engine without a build step.
function serveSdkWeb(app: Hono): void {
  let dir: string, files: string[];
  try {
    dir = fileURLToPath(new URL("../web/", import.meta.url));
    files = readdirSync(dir);
  } catch {
    return; // no kit shipped (shouldn't happen) — agents can still ship their own UI.
  }
  for (const name of files) {
    let body: string;
    try { body = readFileSync(dir + name, "utf8"); } catch { continue; }
    const ext = name.split(".").pop() || "";
    const ct = CONTENT_TYPES[ext] ?? "application/octet-stream";
    app.get(`/_gaws/${name}`, (c) => c.body(body, 200, { "content-type": ct }));
  }
}
