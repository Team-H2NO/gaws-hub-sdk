// feed.ts — feed of the jobs THIS instance is *serving* (the provider side). The
// job host reports a dispatched job's progress to the hub + stdout, but nothing
// reaches this instance's own UI — so when the hub dispatches a job to a cold-started
// sibling, opening that instance's page shows a blank log. This feed closes that
// gap: `served()` pushes lifecycle/progress here, and createAgent streams it at
// `GET /api/served` so a provider always shows what it is running.
//
// The ring is ALSO persisted to a bounded JSONL under the instance's writable dir
// (§7.9), so a restarted provider (same state volume) reloads its backlog instead
// of showing a blank log exactly when a re-attaching UI wants history.
// ponytail: the feed is a per-instance UI hint, not a source of truth — the
// authoritative job history is the hub's durable log (04). Backfilling a *fresh*
// cold-start from the hub is skipped on purpose: a fresh instance gets a NEW id, so
// `?worker=<self>` returns nothing, and its own jobs stream in via served() as they
// run; the disk ring covers the real gap (this instance's own restart).
import { appendFileSync, writeFileSync, readFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { env } from "./env.js";
const MAX = 300;
const SCHEMA_VERSION = 1;
const FILE = join(env.stateDir, "feed.jsonl");
const HEADER = JSON.stringify({ schema_version: SCHEMA_VERSION });
// Compact (rewrite header + last MAX) once appends since the last rewrite exceed
// this, so the on-disk file stays bounded without a full rewrite on every push.
const COMPACT_AT = MAX * 4;
let diskOk = true; // flips false and stays there once disk becomes unwritable
let laidDown = false; // has THIS process rewritten the file to header+ring yet?
let sinceCompact = 0; // appended lines since the last header+compaction rewrite
// Load the persisted ring. Migrate forward; an unknown NEWER schema_version is a
// logged refusal (start empty) — AND we stop writing (diskOk=false) so a rolled-back
// binary never OVERWRITES the newer-schema file (00 invariant 1: no silent drop, and
// not a destructive one either). A torn/bad line is skipped, not fatal.
function load() {
    let raw;
    try {
        raw = readFileSync(FILE, "utf8");
    }
    catch {
        return []; // NotFound / unreadable → greenfield empty ring
    }
    const lines = raw.split("\n").filter((l) => l.trim());
    if (!lines.length)
        return [];
    let start = 0;
    try {
        const hdr = JSON.parse(lines[0]);
        if (typeof hdr.schema_version === "number") {
            if (hdr.schema_version > SCHEMA_VERSION) {
                console.error(`[feed] on-disk schema_version ${hdr.schema_version} > ${SCHEMA_VERSION}; not reading OR writing ${FILE} (preserving forward-written data)`);
                diskOk = false; // do not clobber a newer-schema file
                return [];
            }
            start = 1; // header consumed
        }
    }
    catch { /* first line isn't a header — treat every line as an entry */ }
    const out = [];
    for (const l of lines.slice(start)) {
        try {
            out.push(JSON.parse(l));
        }
        catch { /* skip a torn/bad line */ }
    }
    return out.slice(-MAX);
}
function ensureDir() {
    try {
        mkdirSync(env.stateDir, { recursive: true });
        return true;
    }
    catch {
        diskOk = false;
        return false;
    }
}
// Rewrite the file atomically: header + the current ring. Bounds the file at MAX+1.
function compact() {
    if (!diskOk || !ensureDir())
        return;
    try {
        const tmp = `${FILE}.${process.pid}.tmp`;
        writeFileSync(tmp, [HEADER, ...buf.map((e) => JSON.stringify(e))].join("\n") + "\n");
        renameSync(tmp, FILE);
        sinceCompact = 0;
    }
    catch {
        diskOk = false;
    }
}
function persist(entry) {
    if (!diskOk)
        return;
    // FIRST write of THIS process → rewrite the whole file to header+ring, bounding it
    // to MAX+1 lines at every restart (a low-traffic/crash-looping provider otherwise
    // appends its whole session forever). Afterwards append, compacting periodically.
    if (!laidDown) {
        laidDown = true;
        compact();
        return;
    }
    if (++sinceCompact >= COMPACT_AT) {
        compact();
        return;
    } // compact resets sinceCompact
    // mkdir on the append path too: a /tmp cleaner may have removed the dir mid-run.
    if (!ensureDir())
        return;
    try {
        appendFileSync(FILE, JSON.stringify(entry) + "\n");
    }
    catch {
        diskOk = false;
    }
}
const buf = load();
const subs = new Set();
export const feed = {
    push(entry) {
        const e = { at: Date.now(), ...entry };
        buf.push(e);
        if (buf.length > MAX)
            buf.shift(); // bound memory
        persist(e); // bound disk
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
