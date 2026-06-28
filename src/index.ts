// @gaws-hub/sdk — build and call gaws-hub agents.
//
//   import { createAgent, hub, z } from "@gaws-hub/sdk";
//
// Provider:
//   createAgent({ name: "echo", services: [
//     { name: "echo", kind: "sync", path: "/api/echo", handler: (i) => i },
//   ]});
//
// Consumer:
//   const out = await hub.invoke("echo", { hi: 1 });
//   const job = await hub.runJob("build", req, { onProgress: e => log(e) });

export { env } from "./env.js";
export { HubClient, hub } from "./client.js";
export type { RunJobOptions } from "./client.js";
export { createAgent } from "./server.js";
export type {
  AgentOptions,
  ServiceDef,
  SyncService,
  JobService,
  SyncContext,
} from "./server.js";
export { startJob } from "./jobhost.js";
export type { JobContext, JobHandler } from "./jobhost.js";
export { runLoop } from "./loop.js";
export type { RunLoopOptions, LoopCtx, IterationResult, LoopResult } from "./loop.js";
export { z, toJsonSchema } from "./schema.js";
export type { Job, JobEvent, JobState, JobResult, ServiceInfo, ProviderInfo } from "./types.js";
