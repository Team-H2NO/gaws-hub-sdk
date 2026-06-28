export type JobState = "queued" | "starting" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
export interface JobResult {
    output?: unknown;
    error?: {
        code: string;
        message: string;
    };
}
export interface Job {
    id: string;
    service: string;
    version: number;
    state: JobState;
    done: boolean;
    inputs: unknown;
    metadata?: Record<string, unknown>;
    result?: JobResult;
    owner?: string;
    worker_id?: string;
    created_at: number;
    started_at?: number;
    terminal_at?: number;
    last_heartbeat_at?: number;
    cancel_requested?: boolean;
}
export interface JobEvent {
    id: number;
    ts: number;
    kind: "progress" | "log" | "heartbeat" | "state" | "done" | string;
    message?: string;
    data?: unknown;
}
export interface ProviderInfo {
    type: string;
    instances: {
        id: string;
        inFlight: number;
        busy: boolean;
    }[];
    canColdStart: boolean;
    pool: {
        min: number;
        max: number;
    };
}
export interface ServiceInfo {
    name: string;
    version: number;
    kind: "sync" | "job";
    summary?: string | null;
    concurrency?: number | null;
    providers: ProviderInfo[];
    available: boolean;
}
