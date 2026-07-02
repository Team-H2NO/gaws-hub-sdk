// Job host — the worker side of the contract (design §7). On dispatch the hub
// POSTs the service path with `x-gaws-job: <id>`; the SDK acks fast and runs the
// author's handler here, reporting heartbeat/progress/result to the token-gated
// `POST /api/v1/jobs/:id/report`. Cancellation is delivered on each report's
// response (`cancelRequested`), Temporal-style.
import { env } from "./env.js";
import { log } from "./log.js";
import { hub } from "./client.js";
const HEARTBEAT_MS = 30_000;
// Jobs currently running on this instance — so presence only resets to "idle"
// when the LAST one finishes (concurrent jobs would otherwise clobber each other).
// ponytail: a single counter; presence is single-valued per instance, so with
// concurrency>1 the activity text shows only the last reporter — fine for a
// best-effort sidebar hint. Per-job activity already lives in the job event stream.
let inFlight = 0;
async function report(jobId, body, ac) {
    try {
        const r = await fetch(`${env.hubUrl}/api/v1/jobs/${jobId}/report`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${env.busToken}` },
            body: JSON.stringify(body),
        });
        const j = (await r.json().catch(() => null));
        if (j?.cancelRequested && !ac.signal.aborted)
            ac.abort();
    }
    catch {
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
export async function startJob(jobId, input, handler, service, corr) {
    const ac = new AbortController();
    // Job-scoped logger: every ctx.log/ctx.progress also lands in Loki under this
    // job id — and under the chain's correlation id (evolution 13 §4), so one
    // Grafana corr= filter returns the whole user→job→claude trace.
    const jlog = log.child({ job: jobId, corr });
    const act = service ?? "service";
    const ctx = {
        jobId,
        corr,
        signal: ac.signal,
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
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const code = ac.signal.aborted ? "cancelled" : "error";
        jlog.error(message, { event: "job.failed", code });
        await report(jobId, { kind: "failed", error: { code, message } }, ac);
    }
    finally {
        clearInterval(hb);
        if (--inFlight === 0)
            void hub.presence({ activity: "idle" });
    }
}
