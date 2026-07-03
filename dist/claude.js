// claude.ts — run `claude -p` and surface its stream-json as live progress, §15
// structured logs, and a compact status snapshot for a UI. Lifted from the
// agent-template (which mirrored agent-builder); every claude-driving agent needs
// the same argv + stream-json parsing, so it lives here once.
//
//   handler: (input, ctx) => runClaude(input, ctx, { defaultTask: TASK })
//
// `runClaude` is the batteries-included path. The low-level pieces (`claudeArgv`,
// `claudeEventToLogs`, `cleanModel/Effort`, `summarize`) are exported for agents
// that compose their own loop (per-step models, `--max-turns`, the codex binary…).
import { execFile } from "node:child_process";
import { env } from "./env.js";
import { log } from "./log.js";
// model/effort accepted by `claude -p` (mirror agent-builder's sets).
export const MODELS = new Set(["opus", "sonnet", "haiku", "fable"]);
export const EFFORTS = new Set(["ultracode", "max", "xhigh", "high", "medium", "low"]);
export const cleanModel = (m, fb = "sonnet") => (MODELS.has(m) ? m : fb);
export const cleanEffort = (e) => (EFFORTS.has(e) ? e : ""); // "" = no --effort flag
// `claude -p` argv: stream-json (+ --verbose, which -p requires) so we can parse
// tool calls; --dangerously-skip-permissions so headless tool use isn't blocked.
export function claudeArgv(prompt, model, effort) {
    const argv = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"];
    if (model)
        argv.push("--model", model);
    if (effort === "ultracode")
        argv.push("--settings", JSON.stringify({ ultracode: true }));
    else if (effort)
        argv.push("--effort", effort);
    return argv;
}
// one-line summary of an arbitrary value (tool input / result), bounded.
export const summarize = (x) => (typeof x === "string" ? x : JSON.stringify(x == null ? "" : x)).replace(/\s+/g, " ").slice(0, 160);
// stream-json event -> structured log entries (§15: event = "claude.<type>").
// Returns [] for events we don't surface. Pure: the caller tracks session/turns.
export function claudeEventToLogs(ev) {
    switch (ev && ev.type) {
        case "system":
            if (ev.subtype !== "init")
                return [];
            return [{ level: "info", event: "claude.session", msg: `session ${ev.session_id || "?"} model=${ev.model || "?"}`,
                    data: { session: ev.session_id, model: ev.model } }];
        case "assistant": {
            const out = [];
            for (const b of (ev.message && ev.message.content) || []) {
                if (b.type === "text" && b.text && b.text.trim())
                    out.push({ level: "info", event: "claude.text", msg: b.text.trim().slice(0, 2000) });
                else if (b.type === "tool_use")
                    out.push({ level: "info", event: "claude.tool_use", msg: `→ ${b.name}(${summarize(b.input)})`, data: { tool: b.name } });
            }
            return out;
        }
        case "user": {
            const out = [];
            for (const b of (ev.message && ev.message.content) || [])
                if (b.type === "tool_result")
                    out.push({ level: "debug", event: "claude.tool_result", msg: `← ${summarize(b.content)}` });
            return out;
        }
        case "result":
            return [{ level: ev.is_error ? "error" : "info", event: "claude.result",
                    msg: `${ev.is_error ? "error" : "done"} ${Math.round((ev.duration_ms || 0) / 1000)}s (${ev.num_turns ?? "?"} turns)`,
                    data: { turns: ev.num_turns, costUsd: ev.total_cost_usd, isError: !!ev.is_error } }];
        default:
            return [];
    }
}
// Ledger every run's spend (evolution 13 §5.2, D12): in-job → a `usage` block
// on the job report channel; out-of-job (Ask turns, observe loops) → POST
// /api/v1/spend. Fire-and-forget: spending is already done, reporting must
// never fail a run. No agent author writes ledger code.
function postUsage(s, jobId, corr) {
    if (s.costUsd == null && !s.tokensIn && !s.tokensOut)
        return; // nothing to ledger
    const usage = { costUsd: s.costUsd ?? 0, tokensIn: s.tokensIn, tokensOut: s.tokensOut,
        model: s.model || undefined, session: s.session ?? undefined };
    const [url, body] = jobId
        ? [`${env.hubUrl}/api/v1/jobs/${jobId}/report`, { kind: "progress", message: "claude usage", usage }]
        : [`${env.hubUrl}/api/v1/spend`, { ...usage, corr }];
    void fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.busToken}` },
        body: JSON.stringify(body),
    }).catch(() => { });
}
// spawn `claude -p`, parse its stream-json into job progress + §15 structured logs,
// resolving with the final summary. Never rejects except on cancellation.
export function runClaude(input, emit = {}, opts = {}) {
    const model = cleanModel(String(input?.model || "").trim());
    const effort = cleanEffort(String(input?.effort || "").trim());
    const task = String(input?.task || opts.defaultTask || "").slice(0, opts.maxTask ?? 4000);
    const bin = opts.bin ?? "claude";
    const argv = (opts.argv ?? claudeArgv)(task, model, effort);
    return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const summary = { session: null, model, turns: 0, toolCalls: 0, tools: [], tokensIn: 0, tokensOut: 0, costUsd: null, text: "", activity: "starting", state: "running", isError: false };
        // a compact live snapshot for the UI's per-run status bar (mirrors agent-builder).
        const snap = () => {
            const s = { state: summary.state, model: summary.model, session: summary.session, activity: summary.activity,
                toolCalls: summary.toolCalls, turns: summary.turns, tokensIn: summary.tokensIn, tokensOut: summary.tokensOut, costUsd: summary.costUsd, elapsedMs: Date.now() - t0 };
            if (summary.state !== "running")
                s.text = summary.text; // final message for the modal (markdown)
            return opts.status ? { ...s, ...opts.status(summary) } : s;
        };
        let slog = emit.jobId || emit.corr ? log.child({ job: emit.jobId, corr: emit.corr }) : log;
        const child = execFile(bin, argv, { env: opts.env ?? process.env, cwd: opts.cwd, maxBuffer: 64 << 20 });
        const onAbort = () => child.kill("SIGTERM");
        emit.signal?.addEventListener("abort", onAbort, { once: true });
        // wall-clock ceiling (09 §4.2): kill the child and resolve IMMEDIATELY — a
        // grandchild holding stdio must not delay the timeout past the ceiling
        // (`close` waits for all stdio to drain; `resolve` is idempotent if it
        // still fires later).
        let timedOut = false;
        const timer = opts.timeoutMs && opts.timeoutMs > 0
            ? setTimeout(() => {
                timedOut = true;
                child.kill("SIGTERM");
                setTimeout(() => child.kill("SIGKILL"), 5000).unref?.();
                summary.isError = true;
                summary.state = "error";
                summary.error = `claude timed out after ${opts.timeoutMs}ms (wall-clock ceiling, 09 §4.2)`;
                resolve({ ...summary });
            }, opts.timeoutMs)
            : null;
        void emit.progress?.({ event: "claude.status", status: snap() }, "claude starting"); // show the bar immediately
        let buf = "";
        child.stdout?.on("data", (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, i);
                buf = buf.slice(i + 1);
                if (!line.trim())
                    continue;
                let ev;
                try {
                    ev = JSON.parse(line);
                }
                catch {
                    continue;
                }
                if (ev.type === "system" && ev.subtype === "init") {
                    summary.session = ev.session_id || summary.session;
                    summary.activity = "working";
                    slog = log.child({ job: emit.jobId, corr: emit.corr, session: summary.session ?? undefined });
                }
                if (ev.type === "assistant") {
                    summary.turns++;
                    for (const b of ev.message?.content || []) {
                        if (b.type === "tool_use") {
                            summary.toolCalls++;
                            summary.tools.push(b.name);
                            summary.activity = `${b.name}(${summarize(b.input)})`;
                        }
                        else if (b.type === "text" && b.text?.trim()) {
                            summary.text = b.text.trim();
                            summary.activity = summary.text.replace(/\s+/g, " ").slice(0, 80);
                        }
                    }
                    const u = ev.message?.usage;
                    if (u) {
                        if (u.input_tokens != null)
                            summary.tokensIn = u.input_tokens;
                        summary.tokensOut += u.output_tokens || 0;
                    }
                }
                if (ev.type === "result") {
                    summary.costUsd = ev.total_cost_usd ?? summary.costUsd;
                    summary.turns = ev.num_turns ?? summary.turns;
                    summary.isError = !!ev.is_error;
                    if (ev.usage) {
                        if (ev.usage.input_tokens != null)
                            summary.tokensIn = ev.usage.input_tokens;
                        if (ev.usage.output_tokens != null)
                            summary.tokensOut = ev.usage.output_tokens;
                    }
                    summary.state = ev.is_error ? "error" : "done";
                    summary.activity = summary.state;
                }
                for (const e of claudeEventToLogs(ev)) {
                    slog[e.level](e.msg, { event: e.event, ...(e.data || {}) }); // → stdout/Loki
                    void emit.progress?.({ event: e.event, ...(e.data || {}), status: snap() }, e.msg); // → hub job events / UI (+ live status)
                }
            }
        });
        child.stderr?.on("data", (d) => process.stderr.write(d));
        child.on("error", (e) => { if (timer)
            clearTimeout(timer); emit.signal?.removeEventListener("abort", onAbort); resolve({ ...summary, error: `spawn failed: ${e.message} (is the claude CLI installed + credentials mounted?)`, isError: true }); });
        child.on("close", (code) => {
            if (timer)
                clearTimeout(timer);
            emit.signal?.removeEventListener("abort", onAbort);
            postUsage(summary, emit.jobId, emit.corr); // spend already happened — ledger it even on error/cancel
            if (emit.signal?.aborted)
                return reject(new Error("cancelled")); // → job host reports the job cancelled
            if (timedOut) {
                summary.isError = true;
                summary.state = "error";
                summary.error = `claude timed out after ${opts.timeoutMs}ms (wall-clock ceiling, 09 §4.2)`;
            }
            // exited non-zero before producing a result → surface it (don't report a clean success).
            else if (code && !summary.isError) {
                summary.isError = true;
                summary.error = `claude exited ${code} (credentials mounted? egress allowed?)`;
            }
            resolve(summary);
        });
    });
}
