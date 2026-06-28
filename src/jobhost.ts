// Job host — the worker side of the contract (design §7). On dispatch the hub
// POSTs the service path with `x-gaws-job: <id>`; the SDK acks fast and runs the
// author's handler here, reporting heartbeat/progress/result to the token-gated
// `POST /api/v1/jobs/:id/report`. Cancellation is delivered on each report's
// response (`cancelRequested`), Temporal-style.

import { env } from "./env.js";

const HEARTBEAT_MS = 30_000;

/** Context handed to a job handler. */
export interface JobContext {
  jobId: string;
  /** Aborts when the hub reports the job cancelled. */
  signal: AbortSignal;
  /** Emit a progress event (also a heartbeat). `data` shows up in metadata.progress. */
  progress: (data: unknown, message?: string) => Promise<void>;
  /** Emit a log line. */
  log: (line: string) => Promise<void>;
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

/** Run a dispatched job to completion, reporting to the hub. Never throws. */
export async function startJob(jobId: string, input: unknown, handler: JobHandler): Promise<void> {
  const ac = new AbortController();
  const ctx: JobContext = {
    jobId,
    signal: ac.signal,
    progress: (data, message) => report(jobId, { kind: "progress", data, message }, ac),
    log: (line) => report(jobId, { kind: "log", line }, ac),
  };
  const hb = setInterval(() => void report(jobId, { kind: "heartbeat" }, ac), HEARTBEAT_MS);
  try {
    const result = await handler(input, ctx);
    await report(jobId, { kind: "succeeded", result: result ?? {} }, ac);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    const code = ac.signal.aborted ? "cancelled" : "error";
    await report(jobId, { kind: "failed", error: { code, message } }, ac);
  } finally {
    clearInterval(hb);
  }
}
