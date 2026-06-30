import type { Job, JobEvent, ServiceInfo } from "./types.js";
export interface RunJobOptions {
    version?: number;
    idempotencyKey?: string;
    onProgress?: (event: JobEvent) => void;
    signal?: AbortSignal;
}
export declare class HubClient {
    private hubUrl;
    private busUrl;
    private storeUrl;
    private token;
    constructor(hubUrl?: string, busUrl?: string, storeUrl?: string, token?: string);
    private auth;
    /** List services across all running/cold-startable providers (optionally one name). */
    discover(name?: string): Promise<ServiceInfo[]>;
    /** Invoke a sync service by name; returns the provider's JSON response. */
    invoke<T = unknown>(name: string, body?: unknown, opts?: {
        version?: number;
    }): Promise<T>;
    /** Submit a job; returns immediately with the Job (state queued/starting/running). */
    submitJob(name: string, inputs?: unknown, opts?: {
        version?: number;
        idempotencyKey?: string;
    }): Promise<Job>;
    getJob(id: string, opts?: {
        wait?: string;
    }): Promise<Job>;
    cancelJob(id: string): Promise<Job>;
    jobResult<T = unknown>(id: string): Promise<T>;
    /** Stream a job's progress events (SSE) until the terminal `done` event. */
    streamJob(id: string, opts?: {
        after?: number;
        signal?: AbortSignal;
    }): AsyncGenerator<JobEvent>;
    /** Submit a job and await its terminal result, streaming progress to `onProgress`. */
    runJob<T = unknown>(name: string, inputs?: unknown, opts?: RunJobOptions): Promise<Job>;
    busPublish(topic: string, msg: unknown): Promise<boolean>;
    busPull<T = unknown>(topic: string): Promise<T[]>;
    storePut(key: string, value: unknown): Promise<boolean>;
    storeGet(key: string): Promise<string | null>;
    /**
     * Advertise this instance's display label / current activity to the hub — shown
     * in the launcher sidebar (label replaces the opaque id; activity replaces the
     * docker status). Identity is the instance's BUS_TOKEN, so it can only set its
     * OWN presence. Pass `""` to clear a field; omit a field to leave it unchanged
     * (so set `label` once, then update `activity` alone on each step).
     *
     * Call it at EVERY state transition — load/save/select, each loop iteration and
     * its phase, answering a query — and `{ activity: "idle" }` when a job ends. A
     * stale activity reads as "stuck"; frequent updates read as "alive".
     *
     * Best-effort: a no-op without a token (local / untrusted runs) and never throws
     * into the caller — presence must not break the agent's real work.
     */
    presence(p: {
        label?: string | null;
        activity?: string | null;
    }): Promise<void>;
}
/** A client wired from the injected environment. */
export declare const hub: HubClient;
