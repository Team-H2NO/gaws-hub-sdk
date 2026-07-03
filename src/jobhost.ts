// Job host — the worker side of the contract (design §7). On dispatch the hub
// POSTs the service path with `x-gaws-job: <id>`; the SDK acks fast and runs the
// author's handler here, reporting heartbeat/progress/result to the token-gated
// `POST /api/v1/jobs/:id/report`. Cancellation is delivered on each report's
// response (`cancelRequested`), Temporal-style.

import { env } from "./env.js";
import { log } from "./log.js";
import { hub, storeCtx, type StoreCtx } from "./client.js";

// Heartbeat interval AND the cancel-latency floor when the event-stream path is
// unavailable. Lowered from 30s to 10s (§7.9) so a cancel that misses the event
// stream still lands within 10s instead of 30s.
const HEARTBEAT_MS = env.heartbeatMs;

// Jobs currently running on this instance — so presence only resets to "idle"
// when the LAST one finishes (concurrent jobs would otherwise clobber each other).
// ponytail: a single counter; presence is single-valued per instance, so with
// concurrency>1 the activity text shows only the last reporter — fine for a
// best-effort sidebar hint. Per-job activity already lives in the job event stream.
let inFlight = 0;

/** Context handed to a job handler. */
export interface JobContext {
  jobId: string;
  /** Correlation id of the submitting chain — echo on downstream hub calls. */
  corr?: string;
  /** Aborts when the hub reports the job cancelled. */
  signal: AbortSignal;
  /** Emit a progress event (also a heartbeat). `data` shows up in metadata.progress. */
  progress: (data: unknown, message?: string) => Promise<void>;
  /** Emit a log line. */
  log: (line: string) => Promise<void>;
  /** Stash a large result in the store and return a `{ storeKey }` instead (§11). */
  store: StoreCtx;
}

export type JobHandler = (input: unknown, ctx: JobContext) => Promise<unknown> | unknown;

async function report(jobId: string, body: unknown, ac: AbortController): Promise<void> {
  try {
    const r = await fetch(`${env.hubUrl}/api/v1/jobs/${jobId}/report`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.busToken}` },
      body: JSON.stringify(body),
    });
    const j = (await r.json().catch(() => null)) as { cancelRequested?: boolean } | null;
    if (j?.cancelRequested && !ac.signal.aborted) ac.abort();
  } catch {
    // a dropped report is non-fatal; the next heartbeat retries.
  }
}

/**
 * Run a dispatched job to completion, reporting to the hub. Never throws.
 *
 * `service` (the manifest service name) is reported as live **presence** to the
 * hub launcher sidebar over the job's lifecycle — start → each progress → idle —
 * so a cold-started provider shows what it's serving even before its own UI loads
 * (agents-interface §7/§14). Best-effort: a no-op without a BUS_TOKEN.
 */
export async function startJob(jobId: string, input: unknown, handler: JobHandler, service?: string, corr?: string): Promise<void> {
  const ac = new AbortController();
  // Cancel path 1 (fast, ≤~1s): watch the job's own event stream and abort on a
  // `cancel` event the hub emits on POST …/cancel (05 cancellation chain). Cancel
  // path 2 (fallback, ≤HEARTBEAT_MS): the cancelRequested flag on each report's
  // response — still delivered if the event stream is unavailable.
  // ponytail: one extra long-lived SSE connection per running job; jobs are low
  // cardinality per instance, so this is cheap.
  void (async () => {
    try {
      for await (const ev of hub.streamJob(jobId, { signal: ac.signal })) {
        if (ev.kind === "cancel" && !ac.signal.aborted) { ac.abort(); return; }
      }
    } catch { /* stream dropped — the heartbeat report path still delivers cancel */ }
  })();
  // Job-scoped logger: every ctx.log/ctx.progress also lands in Loki under this
  // job id — and under the chain's correlation id (evolution 13 §4), so one
  // Grafana corr= filter returns the whole user→job→claude trace.
  const jlog = log.child({ job: jobId, corr });
  const act = service ?? "service";
  const ctx: JobContext = {
    jobId,
    corr,
    signal: ac.signal,
    store: storeCtx,
    progress: (data, message) => {
      jlog.event("job.progress", message ?? "progress", { data });
      void hub.presence({ activity: message ? `${act} · ${message}` : act });
      return report(jobId, { kind: "progress", data, message }, ac);
    },
    log: (line) => {
      jlog.info(line);
      return report(jobId, { kind: "log", line }, ac);
    },
  };
  const hb = setInterval(() => void report(jobId, { kind: "heartbeat" }, ac), HEARTBEAT_MS);
  jlog.event("job.start", "job started");
  inFlight++;
  void hub.presence({ activity: act });
  try {
    const result = await handler(input, ctx);
    jlog.event("job.succeeded", "job done");
    await report(jobId, { kind: "succeeded", result: result ?? {} }, ac);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    const code = ac.signal.aborted ? "cancelled" : "error";
    jlog.error(message, { event: "job.failed", code });
    await report(jobId, { kind: "failed", error: { code, message } }, ac);
  } finally {
    clearInterval(hb);
    if (--inFlight === 0) void hub.presence({ activity: "idle" });
  }
}
