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
/** Run a dispatched job to completion, reporting to the hub. Never throws. */
export declare function startJob(jobId: string, input: unknown, handler: JobHandler): Promise<void>;
