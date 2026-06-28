// feed.ts — in-process feed of the jobs THIS instance is *serving* (the provider
// side). The job host reports a dispatched job's progress to the hub + stdout, but
// nothing reaches this instance's own UI — so when the hub dispatches a job to a
// cold-started sibling, opening that instance's page shows a blank log. This feed
// closes that gap: `served()` pushes lifecycle/progress here, and createAgent
// streams it at `GET /api/served` so a provider always shows what it is running.
// Bounded ring buffer + simple pub/sub. ponytail: in-process only (per instance).
const MAX = 300;
const buf = [];
const subs = new Set();
export const feed = {
    push(entry) {
        const e = { at: Date.now(), ...entry };
        buf.push(e);
        if (buf.length > MAX)
            buf.shift(); // bound memory
        for (const cb of subs) {
            try {
                cb(e);
            }
            catch { /* a bad subscriber can't break the producer */ }
        }
        return e;
    },
    recent(n = 100) { return buf.slice(-n); },
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb); },
};
// Wrap a job handler so its start/progress/log/done also land in the local feed
// (in addition to the hub job-event report + stdout/Loki the SDK already emits).
// Re-throws on failure so the job host still reports `failed` to the hub.
export function served(service, handler) {
    return async (input, ctx) => {
        feed.push({ job: ctx.jobId, service, kind: "start", msg: `${service} started` });
        const fctx = {
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
        }
        catch (e) {
            feed.push({ job: ctx.jobId, service, kind: "done", state: "failed", msg: String(e?.message || e) });
            throw e;
        }
    };
}
