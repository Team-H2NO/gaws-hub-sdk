// createAgent — a batteries-included gaws-hub agent server (Hono on Node).
// Wires /healthz, /meta, /config, static assets, graceful SIGTERM, and — for
// declared services — the runtime contract: sync handlers and the job host.
//
// An author writes only handlers (+ optional zod schemas); the manifest.yaml
// (with the matching `services[]`) is authored alongside and baked into the image.
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { env } from "./env.js";
import { startJob } from "./jobhost.js";
export function createAgent(opts) {
    const app = new Hono();
    const services = opts.services ?? [];
    app.get("/healthz", (c) => c.text("ok"));
    app.get("/meta", (c) => c.json({
        id: env.instance,
        kind: opts.name,
        version: opts.version ?? "0.0.0",
        capabilities: {
            ...(opts.capabilities ?? {}),
            services: services.map((s) => ({ name: s.name, kind: s.kind })),
        },
    }));
    app.get("/config", (c) => c.json({ name: opts.name, version: opts.version ?? "0.0.0", instance: env.instance, ...(opts.config ?? {}) }));
    for (const svc of services) {
        if (svc.kind === "sync") {
            const method = (svc.method ?? "POST").toUpperCase();
            app.on(method, svc.path, async (c) => {
                const input = await readBody(c);
                const checked = validate(svc.request, input);
                if (!checked.ok)
                    return c.json({ error: checked.error }, 400);
                try {
                    const out = await svc.handler(checked.value, { caller: c.req.header("x-gaws-caller-instance") });
                    return c.json((out ?? {}));
                }
                catch (e) {
                    return c.json({ error: String(e instanceof Error ? e.message : e) }, 500);
                }
            });
        }
        else {
            // Job dispatch: ack fast (202), run detached via the job host.
            app.post(svc.path, async (c) => {
                const jobId = c.req.header("x-gaws-job");
                if (!jobId)
                    return c.json({ error: "missing x-gaws-job (dispatch only via the hub job API)" }, 400);
                const input = await readBody(c);
                const checked = validate(svc.request, input);
                if (!checked.ok)
                    return c.json({ error: checked.error }, 400);
                void startJob(jobId, checked.value, svc.handler);
                return c.json({ accepted: true, jobId }, 202);
            });
        }
    }
    opts.routes?.(app);
    if (opts.static)
        app.get("/*", serveStatic({ root: opts.static }));
    const server = serve({ fetch: app.fetch, port: env.port, hostname: "0.0.0.0" }, (info) => console.log(`[${opts.name}] listening on :${info.port} (instance ${env.instance})`));
    const shutdown = () => {
        try {
            server.close?.();
        }
        finally {
            process.exit(0);
        }
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    return app;
}
async function readBody(c) {
    const t = await c.req.text();
    if (!t)
        return {};
    try {
        return JSON.parse(t);
    }
    catch {
        return {};
    }
}
function validate(schema, input) {
    if (!schema)
        return { ok: true, value: input };
    const r = schema.safeParse(input);
    if (r.success)
        return { ok: true, value: r.data ?? input };
    return { ok: false, error: `invalid request: ${JSON.stringify(r.error)}` };
}
