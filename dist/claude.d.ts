import { type Level } from "./log.js";
export declare const MODELS: Set<string>;
export declare const EFFORTS: Set<string>;
export declare const cleanModel: (m: string, fb?: string) => string;
export declare const cleanEffort: (e: string) => string;
export declare function claudeArgv(prompt: string, model: string, effort: string): string[];
export declare const summarize: (x: unknown) => string;
export interface ClaudeLogEntry {
    level: Level;
    event: string;
    msg: string;
    data?: Record<string, unknown>;
}
export declare function claudeEventToLogs(ev: any): ClaudeLogEntry[];
export interface ClaudeInput {
    task?: string;
    model?: string;
    effort?: string;
}
/** Sink for runClaude's output — a JobContext satisfies it; all fields optional. */
export interface ClaudeEmit {
    jobId?: string;
    signal?: AbortSignal;
    progress?: (data: unknown, message?: string) => unknown;
    log?: (line: string) => unknown;
}
/** Live snapshot of a claude run (drives the UI status bar). */
export interface ClaudeSummary {
    session: string | null;
    model: string;
    turns: number;
    toolCalls: number;
    tools: string[];
    tokensIn: number;
    tokensOut: number;
    costUsd: number | null;
    text: string;
    activity: string;
    state: string;
    isError: boolean;
    error?: string;
}
export interface RunClaudeOptions {
    /** Task used when `input.task` is empty. */
    defaultTask?: string;
    /** CLI binary (default "claude"). */
    bin?: string;
    /** Override the argv (e.g. codex/crawler variants); receives the cleaned prompt/model/effort. */
    argv?: (prompt: string, model: string, effort: string) => string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /** Max prompt length (default 4000). */
    maxTask?: number;
    /** Extend the status snapshot with extra fields (e.g. builder's phase/step). */
    status?: (summary: ClaudeSummary) => Record<string, unknown>;
}
export declare function runClaude(input: ClaudeInput, emit?: ClaudeEmit, opts?: RunClaudeOptions): Promise<ClaudeSummary>;
