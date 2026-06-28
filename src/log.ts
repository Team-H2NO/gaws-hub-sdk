// Structured stdout logging (agents-interface §15). One JSON object per line to
// stdout; the hub's Alloy -> Loki pipeline tags each line with this instance/agent
// and promotes session/thread/job/event to structured metadata. Only bounded
// fields become indexed Loki labels — never put per-request ids in labels; put
// them in the line (here) and the pipeline does the right thing.

import { env } from "./env.js";

export type Level = "debug" | "info" | "warn" | "error";

/** Ids that scope a unit of work — bind them with `log.child(...)`. */
export interface LogContext {
  /** A model conversation — a `claude -p` session_id. */
  session?: string;
  /** Your own logical unit of work (a build, a run, an iteration). */
  thread?: string;
  /** The hub job id, when serving a `job` service. */
  job?: string;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Log a machine event (sets `event`, e.g. "build.start", "claude.tool_use"). */
  event(event: string, msg: string, fields?: Record<string, unknown>): void;
  /** Bind session/thread/job (and any extra fields) for a unit of work. */
  child(ctx: LogContext & Record<string, unknown>): Logger;
}

function emit(level: Level, base: Record<string, unknown>, msg: string, fields?: Record<string, unknown>): void {
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

function make(base: Record<string, unknown>): Logger {
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
export const log: Logger = make({});
