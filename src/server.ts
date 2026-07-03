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
import { log } from "./log.js";
import { storeCtx, type StoreCtx } from "./client.js";
import { startJob, type JobContext } from "./jobhost.js";
import { served, feed } from "./feed.js";
import { toJsonSchema } from "./schema.js";

/** Anything with a zod-style `.safeParse` (kept duck-typed to avoid a hard zod dep). */
interface Validator {
  safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: unknown };
}

export interface SyncContext {
  /** The calling instance id, if the hub stamped one. */
  caller?: string;
  /** Stash a large result in the store and return `{ storeKey }` instead (§11). */
  store: StoreCtx;
}

export interface SyncService {
  name: string;
  kind: "sync";
  path: string;
  method?: string;
  request?: Validator;
  /** Optional zod schema of the response (emitted into the manifest descriptor). */
  result?: Validator;
  /**
   * Per-service sync ceiling (ms), overriding `GAWS_SYNC_CEILING_MS` (§14). For a
   * legitimately-slow-but-BOUNDED sync service — e.g. an LLM Q&A turn — set a higher
   * bound (e.g. 120_000) instead of forcing `kind:job`. Truly unbounded/batch work
   * still belongs in a job (for progress/cancel).
   */
  ceiling?: number;
  /** Per-service inline-response byte ceiling (§11), overriding `GAWS_MAX_INLINE_BYTES`. */
  maxInlineBytes?: number;
  handler: (input: unknown, ctx: SyncContext) => Promise<unknown> | unknown;
}

export interface JobService {
  name: string;
  kind: "job";
  path: string;
  request?: Validator;
  /** Optional zod schema of the result (emitted into the manifest descriptor). */
  result?: Validator;
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

  // GAWS_DESCRIBE=1: print the resolved services[] (the manifest's source of truth)
  // and exit WITHOUT binding a port. `gaws-manifest` runs this and writes the block
  // into manifest.yaml; the `services-match` compliance rule diffs it against the
  // committed manifest so no drift can ship (§4.1 / L2).
  // Exactly "1" — a bare truthiness check would fire on GAWS_DESCRIBE=0/false
  // (every non-empty string is truthy), exiting a container that must serve.
  if (process.env.GAWS_DESCRIBE === "1") {
    const out = services.map((s) => ({
      name: s.name,
      kind: s.kind,
      path: s.path,
      method: s.kind === "sync" ? ((s as SyncService).method ?? "POST").toUpperCase() : "POST",
      request: s.request ? toJsonSchema(s.request) : undefined,
      result: s.result ? toJsonSchema(s.result) : undefined,
    }));
    process.stdout.write(JSON.stringify({ services: out }, null, 2) + "\n");
    process.exit(0);
  }

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
        const body = await readBody(c);
        if (!body.ok) return c.json({ error: "malformed JSON body" }, 400);
        const checked = validate(svc.request, body.value);
        if (!checked.ok) return c.json({ error: checked.error }, 400);
        const ctx: SyncContext = { caller: c.req.header("x-gaws-caller-instance"), store: storeCtx };
        const ceilingMs = svc.ceiling ?? env.syncCeilingMs;
        const maxBytes = svc.maxInlineBytes ?? env.maxInlineBytes;
        try {
          // §14 sync ceiling: a sync handler must respond within the ceiling; past
          // it the caller gets 504 (declare kind:job) and we flag a contract.violation.
          const raced = await withCeiling(ceilingMs, () => svc.handler(checked.value, ctx));
          if (!raced.ok) {
            log.event("contract.violation", "sync exceeded ceiling; declare kind:job", {
              service: svc.name, kind: "sync", ceilingMs,
            });
            return c.json({ error: "sync service exceeded ceiling; declare kind:job (or raise its ceiling)" }, 504);
          }
          const out = (raced.value ?? {}) as Record<string, unknown>;
          // §11 inline ceiling: a large response must go via the store, not inline JSON.
          const bytes = Buffer.byteLength(JSON.stringify(out));
          if (bytes > maxBytes) {
            log.event("contract.violation", "response exceeds inline ceiling; use the store", {
              service: svc.name, bytes, ceilingBytes: maxBytes,
            });
            return c.json({ error: "response too large; put it in the store and return {storeKey}", bytes }, 413);
          }
          return c.json(out);
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
        const body = await readBody(c);
        if (!body.ok) return c.json({ error: "malformed JSON body" }, 400);
        const checked = validate(svc.request, body.value);
        if (!checked.ok) return c.json({ error: checked.error }, 400);
        const corr = c.req.header("x-gaws-correlation") || undefined;
        void startJob(jobId, checked.value, handler, svc.name, corr);
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

// Distinguish an EMPTY body (valid → {}) from a MALFORMED one (garbage → 400).
// The old code caught both to {}, so garbage silently validated as an empty object.
async function readBody(c: { req: { text: () => Promise<string> } }): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const t = await c.req.text();
  if (!t.trim()) return { ok: true, value: {} }; // empty OR whitespace-only → {} (a stray \n is not "malformed")
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch {
    return { ok: false };
  }
}

const CEILING_TIMEOUT = Symbol("ceiling-timeout");

// Race `fn` against `ms`. Returns {ok:false} on timeout (the handler keeps running —
// JS can't cancel it — but the response is bounded). The timer is always cleared so
// a fast handler doesn't leave a pending timer keeping the event loop alive.
async function withCeiling<T>(ms: number, fn: () => Promise<T> | T): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof CEILING_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(CEILING_TIMEOUT), ms);
  });
  try {
    const r = await Promise.race([Promise.resolve().then(fn), timeout]);
    return r === CEILING_TIMEOUT ? { ok: false } : { ok: true, value: r as T };
  } finally {
    clearTimeout(timer);
  }
}

function validate(schema: Validator | undefined, input: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!schema) return { ok: true, value: input };
  const r = schema.safeParse(input);
  // safeParse success ⇒ r.data is authoritative (a transform may yield null/undefined
  // deliberately); `?? input` would discard that and hand the handler the raw input.
  if (r.success) return { ok: true, value: r.data };
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
