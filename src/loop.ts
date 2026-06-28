// loop.ts — a small, general iteration runner for agents that converge over rounds
// (the generate→build→eval→decide shape, generalized). The caller supplies one
// `iterate` callback (which composes whatever stages it needs) and returns whether
// it's done; runLoop handles the counter, the abort check, and termination.
//
//   const out = await runLoop({
//     maxIterations: 5,
//     signal: ctx.signal,
//     iterate: async ({ iteration }) => {
//       await build(); const score = await evaluate();
//       await ctx.progress({ iteration, score });
//       return score.allPass ? { done: true, reason: "all-pass", score } : { done: false, score };
//     },
//   });
//   // out = { iterations, outcome: "all-pass" | "exhausted" | "cancelled", last }

export interface LoopCtx {
  iteration: number; // 1-based
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
  outcome: string; // reason from a `done` iteration, or "exhausted" | "cancelled"
  last: IterationResult | null;
}

/** Run up to `maxIterations` rounds, stopping early when an iteration returns
 * `done` or when the signal aborts. Never throws on its own — surfaces the
 * caller's thrown errors. */
export async function runLoop(opts: RunLoopOptions): Promise<LoopResult> {
  let last: IterationResult | null = null;
  for (let iteration = 1; iteration <= opts.maxIterations; iteration++) {
    if (opts.signal?.aborted) return { iterations: iteration - 1, outcome: "cancelled", last };
    last = await opts.iterate({ iteration, maxIterations: opts.maxIterations, signal: opts.signal });
    await opts.onIteration?.(iteration, last);
    if (last.done) return { iterations: iteration, outcome: last.reason ?? "done", last };
    if (opts.signal?.aborted) return { iterations: iteration, outcome: "cancelled", last };
  }
  return { iterations: opts.maxIterations, outcome: "exhausted", last };
}
