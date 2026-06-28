import type { JobContext } from "./jobhost.js";
export interface FeedEntry {
    at: number;
    job?: string;
    service?: string;
    kind: "start" | "progress" | "log" | "done" | string;
    msg?: string;
    data?: unknown;
    state?: string;
    [k: string]: unknown;
}
export declare const feed: {
    push(entry: Omit<FeedEntry, "at">): FeedEntry;
    recent(n?: number): FeedEntry[];
    subscribe(cb: (e: FeedEntry) => void): () => void;
};
/** A job handler (input + JobContext) — what `served` wraps. */
type Handler = (input: unknown, ctx: JobContext) => Promise<unknown> | unknown;
export declare function served(service: string, handler: Handler): Handler;
export {};
