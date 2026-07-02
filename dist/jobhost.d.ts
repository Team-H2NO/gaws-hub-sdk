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
}
export type JobHandler = (input: unknown, ctx: JobContext) => Promise<unknown> | unknown;
/**
 * Run a dispatched job to completion, reporting to the hub. Never throws.
 *
 * `service` (the manifest service name) is reported as live **presence** to the
 * hub launcher sidebar over the job's lifecycle — start → each progress → idle —
 * so a cold-started provider shows what it's serving even before its own UI loads
 * (agents-interface §7/§14). Best-effort: a no-op without a BUS_TOKEN.
 */
export declare function startJob(jobId: string, input: unknown, handler: JobHandler, service?: string, corr?: string): Promise<void>;
