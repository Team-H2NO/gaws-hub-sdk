// echo — the HUB-CONFORMANCE sample agent (L5). A minimal createAgent server that
// exercises every wire behavior the SDK guarantees: a sync service, a job service
// with progress + a cancel point, a service that breaches the inline ceiling (413),
// and a service that breaches the sync ceiling (504). The conformance driver boots
// this and drives the contract end to end; GAWS_DESCRIBE prints its services[].
//
// Self-references @gaws-hub/sdk (Node package self-reference via the "exports" field),
// so it runs straight from the repo's built dist with no install.
import { createAgent, z } from "@gaws-hub/sdk";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

createAgent({
  name: "echo",
  version: "0.0.1",
  services: [
    // sync: mirrors the input. Cold-start invoke + malformed-body 400 target.
    {
      name: "echo",
      kind: "sync",
      path: "/api/echo",
      request: z.object({ hi: z.any().optional() }).passthrough(),
      handler: (i) => i,
    },
    // sync over the inline ceiling → 413 (the §11 guard).
    {
      name: "big-echo",
      kind: "sync",
      path: "/api/big-echo",
      handler: () => ({ blob: "x".repeat(Number(process.env.ECHO_BLOB_BYTES || 4096)) }),
    },
    // sync past the sync ceiling → 504 (the §14 guard).
    {
      name: "slow-sync",
      kind: "sync",
      path: "/api/slow-sync",
      handler: async () => { await sleep(Number(process.env.ECHO_SLOW_MS || 1000)); return { done: true }; },
    },
    // job: emit N progress ticks then return; ctx.signal aborts on cancel.
    {
      name: "slow-echo",
      kind: "job",
      path: "/api/slow-echo",
      handler: async (input, ctx) => {
        const ticks = Number(input?.ticks ?? 5);
        for (let i = 0; i < ticks; i++) {
          if (ctx.signal.aborted) throw new Error("cancelled");
          await ctx.progress({ i }, `tick ${i + 1}/${ticks}`);
          await sleep(Number(process.env.ECHO_TICK_MS || 200));
        }
        return { output: input, ticks };
      },
    },
  ],
});
