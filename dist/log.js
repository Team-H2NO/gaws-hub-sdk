// Structured stdout logging (agents-interface §15). One JSON object per line to
// stdout; the hub's Alloy -> Loki pipeline tags each line with this instance/agent
// and promotes session/thread/job/event to structured metadata. Only bounded
// fields become indexed Loki labels — never put per-request ids in labels; put
// them in the line (here) and the pipeline does the right thing.
import { env } from "./env.js";
function emit(level, base, msg, fields) {
    const line = {
        ts: new Date().toISOString(),
        level,
        agent: env.agentName,
        instance: env.instance,
        msg,
        ...base,
        ...fields,
    };
    process.stdout.write(JSON.stringify(line) + "\n");
}
function make(base) {
    return {
        debug: (m, f) => emit("debug", base, m, f),
        info: (m, f) => emit("info", base, m, f),
        warn: (m, f) => emit("warn", base, m, f),
        error: (m, f) => emit("error", base, m, f),
        event: (event, m, f) => emit("info", base, m, { event, ...f }),
        child: (ctx) => make({ ...base, ...ctx }),
    };
}
/** Root logger. Use `log.child({ thread, session, job })` to bind ids for a unit of work. */
export const log = make({});
