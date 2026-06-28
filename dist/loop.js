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
/** Run up to `maxIterations` rounds, stopping early when an iteration returns
 * `done` or when the signal aborts. Never throws on its own — surfaces the
 * caller's thrown errors. */
export async function runLoop(opts) {
    let last = null;
    for (let iteration = 1; iteration <= opts.maxIterations; iteration++) {
        if (opts.signal?.aborted)
            return { iterations: iteration - 1, outcome: "cancelled", last };
        last = await opts.iterate({ iteration, maxIterations: opts.maxIterations, signal: opts.signal });
        await opts.onIteration?.(iteration, last);
        if (last.done)
            return { iterations: iteration, outcome: last.reason ?? "done", last };
        if (opts.signal?.aborted)
            return { iterations: iteration, outcome: "cancelled", last };
    }
    return { iterations: opts.maxIterations, outcome: "exhausted", last };
}
