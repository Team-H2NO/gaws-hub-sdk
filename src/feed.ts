// feed.ts — in-process feed of the jobs THIS instance is *serving* (the provider
// side). The job host reports a dispatched job's progress to the hub + stdout, but
// nothing reaches this instance's own UI — so when the hub dispatches a job to a
// cold-started sibling, opening that instance's page shows a blank log. This feed
// closes that gap: `served()` pushes lifecycle/progress here, and createAgent
// streams it at `GET /api/served` so a provider always shows what it is running.
// Bounded ring buffer + simple pub/sub. ponytail: in-process only (per instance).

import type { JobContext } from "./jobhost.js";

export interface FeedEntry {
  at: number;
  job?: string;
  service?: string;
  kind: "start" | "progress" | "log" | "done" | string;
  msg?: string;
  data?: unknown;
  state?: string;
  [k: string]: unknown;
}

const MAX = 300;
const buf: FeedEntry[] = [];
const subs = new Set<(e: FeedEntry) => void>();

export const feed = {
  push(entry: Omit<FeedEntry, "at">): FeedEntry {
    const e = { at: Date.now(), ...entry } as FeedEntry;
    buf.push(e);
    if (buf.length > MAX) buf.shift();                 // bound memory
    for (const cb of subs) { try { cb(e); } catch { /* a bad subscriber can't break the producer */ } }
    return e;
  },
  recent(n = 100): FeedEntry[] { return buf.slice(-n); },
  subscribe(cb: (e: FeedEntry) => void): () => void { subs.add(cb); return () => subs.delete(cb); },
};

/** A job handler (input + JobContext) — what `served` wraps. */
type Handler = (input: unknown, ctx: JobContext) => Promise<unknown> | unknown;

// Wrap a job handler so its start/progress/log/done also land in the local feed
// (in addition to the hub job-event report + stdout/Loki the SDK already emits).
// Re-throws on failure so the job host still reports `failed` to the hub.
export function served(service: string, handler: Handler): Handler {
  return async (input, ctx) => {
    feed.push({ job: ctx.jobId, service, kind: "start", msg: `${service} started` });
    const fctx: JobContext = {
      ...ctx,
      progress: (data, message) => {
        feed.push({ job: ctx.jobId, service, kind: "progress", msg: message ?? "progress", data });
        return ctx.progress(data, message);
      },
      log: (line) => {
        feed.push({ job: ctx.jobId, service, kind: "log", msg: line });
        return ctx.log(line);
      },
    };
    try {
      const r = await handler(input, fctx);
      feed.push({ job: ctx.jobId, service, kind: "done", state: "succeeded", msg: `${service} succeeded` });
      return r;
    } catch (e: any) {
      feed.push({ job: ctx.jobId, service, kind: "done", state: "failed", msg: String(e?.message || e) });
      throw e;
    }
  };
}
