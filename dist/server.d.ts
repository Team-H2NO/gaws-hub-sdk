import { Hono } from "hono";
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
}
export interface SyncService {
    name: string;
    kind: "sync";
    path: string;
    method?: string;
    request?: Validator;
    handler: (input: unknown, ctx: SyncContext) => Promise<unknown> | unknown;
}
export interface JobService {
    name: string;
    kind: "job";
    path: string;
    request?: Validator;
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
}
export declare function createAgent(opts: AgentOptions): Hono;
export {};
