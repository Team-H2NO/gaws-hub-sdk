export type Level = "debug" | "info" | "warn" | "error";
/** Ids that scope a unit of work — bind them with `log.child(...)`. */
export interface LogContext {
    /** A model conversation — a `claude -p` session_id. */
    session?: string;
    /** Your own logical unit of work (a build, a run, an iteration). */
    thread?: string;
    /** The hub job id, when serving a `job` service. */
    job?: string;
    /** The hub-minted correlation id joining the whole user→job→claude chain. */
    corr?: string;
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
/** Root logger. Use `log.child({ thread, session, job })` to bind ids for a unit of work. */
export declare const log: Logger;
