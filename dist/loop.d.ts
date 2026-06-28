export interface LoopCtx {
    iteration: number;
    maxIterations: number;
    signal?: AbortSignal;
}
export interface IterationResult {
    /** Stop the loop after this iteration. */
    done: boolean;
    /** Why it stopped (becomes the loop outcome when done). */
    reason?: string;
    /** Anything else the caller wants to carry out as `last`. */
    [k: string]: unknown;
}
export interface RunLoopOptions {
    maxIterations: number;
    signal?: AbortSignal;
    /** Run one iteration; compose your stages here. */
    iterate: (ctx: LoopCtx) => Promise<IterationResult>;
    /** Optional per-iteration hook (e.g. progress reporting). */
    onIteration?: (iteration: number, result: IterationResult) => void | Promise<void>;
}
export interface LoopResult {
    iterations: number;
    outcome: string;
    last: IterationResult | null;
}
/** Run up to `maxIterations` rounds, stopping early when an iteration returns
 * `done` or when the signal aborts. Never throws on its own — surfaces the
 * caller's thrown errors. */
export declare function runLoop(opts: RunLoopOptions): Promise<LoopResult>;
