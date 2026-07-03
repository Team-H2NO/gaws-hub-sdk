export interface RecallContext {
    /** Free text (author/plan boundary). */
    query?: string;
    /** Hub service name the caller is about to run (e.g. "build"). */
    service?: string;
    /** Capability label (e.g. "build", "plan", "decide"). */
    capability?: string;
    /** Target repo URL/slug. */
    repo?: string;
    /** The failing error text — the procedural probe. */
    errorString?: string;
    /** Stores to search; default ["procedural","semantic"]. */
    stores?: string[];
}
export interface RecallSnippet {
    conceptId: string;
    store: "procedural" | "semantic";
    trust: "hub" | "operator" | "agent" | "model" | "external";
    confidence: number;
    score: number;
    title: string;
    text: string;
}
export interface RecallResult {
    hits: number;
    floored: boolean;
    recallId: string;
    snippets: RecallSnippet[];
}
export interface RecallOptions {
    /** Relevance floor [0,1]; below ⇒ dropped (default 0.35, server-side). */
    floor?: number;
    /** Max total characters returned (default 2400). */
    budget?: number;
    /** Max snippets (default 6). */
    k?: number;
    /** The hub job this recall feeds — lets utility tracking attribute the outcome. */
    jobId?: string;
}
/** Coded recall (11 §6): thresholded, provenance-tagged, budgeted. A miss is a
 *  real, EMPTY miss — there is no recent-anyway fallback. Throws when the
 *  memory-recall service is unreachable (callers decide whether that blocks). */
export declare function recall(context: RecallContext, opts?: RecallOptions): Promise<RecallResult>;
/** Render snippets as the delimited, trust-labelled DATA block callers paste
 *  VERBATIM into a prompt (11 §6.3). Returns "" for no snippets. */
export declare function renderRecall(snippets: RecallSnippet[] | undefined | null): string;
