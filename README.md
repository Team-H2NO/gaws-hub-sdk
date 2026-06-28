# @gaws-hub/sdk

TypeScript SDK for building and calling [gaws-hub](https://github.com/) agents:
the **service contract** (sync + job services), the hub-brokered **bus/store**, and
a batteries-included **Hono agent server** with a built-in **job host**.

```bash
npm install github:Team-H2NO/gaws-hub-sdk
```

Stack: TypeScript · Node ≥ 20 (images target Node 24 LTS) · Hono 4 · Zod 4.
`dist/` is committed so the package installs without a build step.

## Provider — declare services, write handlers

```ts
import { createAgent, z } from "@gaws-hub/sdk";

createAgent({
  name: "echo",
  version: "0.1.0",
  services: [
    { name: "echo", kind: "sync", path: "/api/echo",
      handler: (input) => ({ youSent: input }) },

    { name: "slow-echo", kind: "job", path: "/api/slow-echo",
      handler: async (input, ctx) => {
        for (let i = 1; i <= 5 && !ctx.signal.aborted; i++) {
          await ctx.progress({ step: i, of: 5 }, `tick ${i}`);
          await new Promise(r => setTimeout(r, 500));
        }
        return { echoed: input };
      } },
  ],
  static: "./public",
});
```

The matching `manifest.yaml` declares the same `services[]` (so the hub can route
and cold-start). The SDK implements the runtime contract; you write only handlers.

## Consumer — call services by name (the hub routes + cold-starts)

```ts
import { hub } from "@gaws-hub/sdk";

const out  = await hub.invoke("echo", { hi: 1 });               // sync
const job  = await hub.runJob("slow-echo", { hi: 1 }, {         // job + live progress
  onProgress: (e) => console.log(e.kind, e.message ?? e.data),
});
console.log(job.result?.output);

await hub.busPublish("demo", { k: "v" });                       // hub-brokered bus
const msgs = await hub.busPull("demo");
```

You never handle instance ids: `invoke`/`runJob` address by **service name**; the
hub picks a free provider or cold-starts one.

## Surface

- `createAgent(opts)` → Hono app with `/healthz`, `/meta`, `/config`, static assets,
  SIGTERM, and your sync/job service routes (job routes run via the job host).
- `hub` / `HubClient`: `discover`, `invoke`, `submitJob`, `runJob`, `getJob`,
  `streamJob`, `cancelJob`, `jobResult`, `busPublish`, `busPull`, `storeGet`, `storePut`.
- `z`, `toJsonSchema` (zod 4 → JSON Schema for manifest descriptors).

Reads `HUB_URL` / `BUS_URL` / `STORE_URL` / `BUS_TOKEN` / `GAWS_HUB_INSTANCE` /
`AGENT_NAME` / `PORT` from the environment — never hardcode hostnames.
