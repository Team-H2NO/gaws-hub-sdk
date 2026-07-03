import { Hono } from "hono";
import { type StoreCtx } from "./client.js";
import { type JobContext } from "./jobhost.js";
/** Anything with a zod-style `.safeParse` (kept duck-typed to avoid a hard zod dep). */
interface Validator {
    safeParse: (v: unknown) => {
        success: boolean;
        data?: unknown;
        error?: unknown;
    };
}
export interface SyncContext {
    /** The calling instance id, if the hub stamped one. */
    caller?: string;
    /** Stash a large result in the store and return `{ storeKey }` instead (§11). */
    store: StoreCtx;
}
export interface SyncService {
    name: string;
    kind: "sync";
    path: string;
    method?: string;
    request?: Validator;
    /** Optional zod schema of the response (emitted into the manifest descriptor). */
    result?: Validator;
    /**
     * Per-service sync ceiling (ms), overriding `GAWS_SYNC_CEILING_MS` (§14). For a
     * legitimately-slow-but-BOUNDED sync service — e.g. an LLM Q&A turn — set a higher
     * bound (e.g. 120_000) instead of forcing `kind:job`. Truly unbounded/batch work
     * still belongs in a job (for progress/cancel).
     */
    ceiling?: number;
    /** Per-service inline-response byte ceiling (§11), overriding `GAWS_MAX_INLINE_BYTES`. */
    maxInlineBytes?: number;
    handler: (input: unknown, ctx: SyncContext) => Promise<unknown> | unknown;
}
export interface JobService {
    name: string;
    kind: "job";
    path: string;
    request?: Validator;
    /** Optional zod schema of the result (emitted into the manifest descriptor). */
    result?: Validator;
    handler: (input: unknown, ctx: JobContext) => Promise<unknown> | unknown;
}
export type ServiceDef = SyncService | JobService;
export interface AgentOptions {
    name: string;
    version?: string;
    capabilities?: Record<string, unknown>;
    services?: ServiceDef[];
    /** Extra routes (e.g. an interactive UI API). */
    routes?: (app: Hono) => void;
    /** Static asset dir to serve at `/*` (relative to cwd, e.g. "./public"). */
    static?: string;
    /** Extra fields merged into GET /config. */
    config?: Record<string, unknown>;
    /**
     * Provider-side activity feed (default on). Auto-wraps every `job` handler so its
     * lifecycle/progress also lands in an in-process feed, and serves it at
     * `GET /api/served` (the SSE the workbench UI opens on load, so a cold-started
     * provider always shows what it is running). Set `false` to opt out.
     */
    feed?: boolean;
}
export declare function createAgent(opts: AgentOptions): Hono;
export {};
