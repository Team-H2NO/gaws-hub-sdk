// Unit checks for the SDK's pure/reusable bits (node:test, no framework). Imports
// the built dist (what consumers get). Run: npm test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanModel, cleanEffort, claudeArgv, claudeEventToLogs, summarize, feed, served, runClaude, HubClient, startJob, hub, renderPrompt } from "../dist/index.js";

test("cleanModel / cleanEffort fall back sensibly", () => {
  assert.equal(cleanModel("opus"), "opus");
  assert.equal(cleanModel("bogus"), "sonnet");     // unknown → default
  assert.equal(cleanEffort("high"), "high");
  assert.equal(cleanEffort("bogus"), "");          // unknown → no --effort
});

test("claudeArgv wires model + effort (ultracode is a setting)", () => {
  const a = claudeArgv("hi", "opus", "high");
  assert.ok(a.includes("--output-format") && a.includes("stream-json") && a.includes("--verbose"));
  assert.ok(a.includes("--dangerously-skip-permissions"));
  assert.deepEqual([a[a.indexOf("--model") + 1], a[a.indexOf("--effort") + 1]], ["opus", "high"]);
  const b = claudeArgv("hi", "sonnet", "ultracode");
  assert.ok(b.includes("--settings") && !b.includes("--effort"));
});

test("claudeEventToLogs maps the events we surface (§15)", () => {
  assert.deepEqual(claudeEventToLogs({ type: "system", subtype: "init", session_id: "s1", model: "opus" })[0].event, "claude.session");
  const tu = claudeEventToLogs({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { cmd: "ls" } }] } });
  assert.equal(tu[0].event, "claude.tool_use");
  assert.match(tu[0].msg, /Bash/);
  assert.equal(claudeEventToLogs({ type: "result", is_error: false, num_turns: 3 })[0].event, "claude.result");
  assert.deepEqual(claudeEventToLogs({ type: "noise" }), []);
});

test("summarize bounds + collapses whitespace", () => {
  assert.equal(summarize("a   b\nc"), "a b c");
  assert.ok(summarize("x".repeat(500)).length <= 160);
  assert.equal(summarize({ a: 1 }), '{"a":1}');
});

test("feed: bounded ring buffer + delivers to subscribers", () => {
  const got = [];
  const unsub = feed.subscribe((e) => got.push(e.n));
  for (let n = 0; n < 500; n++) feed.push({ kind: "log", n });   // overflow MAX (300)
  unsub();
  feed.push({ kind: "log", n: 999 });                            // not delivered after unsub
  assert.ok(!got.includes(999));
  assert.equal(got.length, 500);                                 // every push reached the live subscriber
  const recent = feed.recent(100);
  assert.equal(recent.length, 100);                              // bounded read
  assert.ok(recent.every((e) => typeof e.at === "number"));      // stamped
  assert.equal(recent.at(-1).n, 999);                            // newest kept
});

test("served: pushes start/progress/done to the feed + forwards to ctx", async () => {
  const seen = [];
  const unsub = feed.subscribe((e) => { if (e.service === "t") seen.push(e.kind); });
  const fwd = [];
  const ctx = { jobId: "j1", signal: new AbortController().signal,
    progress: (d, m) => { fwd.push(["progress", m]); }, log: (l) => { fwd.push(["log", l]); } };
  const handler = served("t", async (input, c) => { await c.progress({ x: 1 }, "halfway"); return { ok: true }; });
  const r = await handler({}, ctx);
  unsub();
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(seen, ["start", "progress", "done"]);
  assert.deepEqual(fwd, [["progress", "halfway"]]);              // forwarded to the real ctx
});

test("served: re-throws so the job host still reports failed", async () => {
  const seen = [];
  const unsub = feed.subscribe((e) => { if (e.service === "boom") seen.push([e.kind, e.state]); });
  const ctx = { jobId: "j2", signal: new AbortController().signal, progress: () => {}, log: () => {} };
  const handler = served("boom", async () => { throw new Error("nope"); });
  await assert.rejects(handler({}, ctx), /nope/);
  unsub();
  assert.deepEqual(seen, [["start", undefined], ["done", "failed"]]);
});

// Drive runClaude against a FAKE `claude` (a node script emitting stream-json), so
// the stream-json → summary/status/§15 parsing is checked hermetically — no real
// claude, no API cost. This is the exact parser the template's run-claude relied on.
test("runClaude: parses stream-json into summary + live status (fake bin)", async () => {
  const FAKE = [
    `console.log(JSON.stringify({type:"system",subtype:"init",session_id:"sess-1",model:"sonnet"}));`,
    `console.log(JSON.stringify({type:"assistant",message:{content:[{type:"tool_use",name:"Bash",input:{cmd:"ls"}}],usage:{input_tokens:10,output_tokens:5}}}));`,
    `console.log(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"all done"}],usage:{input_tokens:12,output_tokens:8}}}));`,
    `console.log(JSON.stringify({type:"result",is_error:false,num_turns:2,total_cost_usd:0.01,usage:{input_tokens:12,output_tokens:20}}));`,
  ].join("\n");
  const progress = [];
  const emit = { jobId: "jc", signal: new AbortController().signal, progress: (d, m) => { progress.push({ d, m }); }, log: () => {} };
  const summary = await runClaude({ task: "ignored" }, emit, { bin: "node", argv: () => ["-e", FAKE] });

  assert.equal(summary.session, "sess-1");
  assert.equal(summary.model, "sonnet");
  assert.equal(summary.toolCalls, 1);
  assert.deepEqual(summary.tools, ["Bash"]);
  assert.equal(summary.text, "all done");
  assert.equal(summary.turns, 2);
  assert.equal(summary.tokensIn, 12);
  assert.equal(summary.tokensOut, 20);
  assert.equal(summary.costUsd, 0.01);
  assert.equal(summary.state, "done");
  assert.equal(summary.isError, false);

  // first progress is the immediate status bar; events carry a live `status` snapshot
  assert.equal(progress[0].d.event, "claude.status");
  const events = progress.map((p) => p.d.event);
  assert.ok(events.includes("claude.session") && events.includes("claude.tool_use") && events.includes("claude.result"));
  assert.ok(progress.every((p) => p.d.status && typeof p.d.status.elapsedMs === "number"));
  const last = progress.at(-1).d.status;            // result event's snapshot carries the final text
  assert.equal(last.state, "done");
  assert.equal(last.text, "all done");
});

test("startJob: reports service as presence, resets to idle only after the LAST concurrent job", async () => {
  const acts = [];
  const realP = hub.presence;
  const realFetch = globalThis.fetch;
  hub.presence = async (p) => { acts.push(p.activity); };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) }); // swallow job reports
  let release1, release2;
  const gate1 = new Promise((r) => (release1 = r));
  const gate2 = new Promise((r) => (release2 = r));
  try {
    const j1 = startJob("ja", {}, async (i, ctx) => { await ctx.progress({}, "step"); await gate1; }, "build");
    const j2 = startJob("jb", {}, async () => { await gate2; }, "build");
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(acts.includes("build"));            // start → service name as activity
    assert.ok(acts.includes("build · step"));     // progress → service · message
    assert.ok(!acts.includes("idle"));            // nothing idle while jobs run
    release1(); await j1;
    assert.ok(!acts.includes("idle"));            // j2 still in flight → not idle yet
    release2(); await j2;
    assert.equal(acts.filter((a) => a === "idle").length, 1); // idle exactly once, after the last job
  } finally {
    hub.presence = realP;
    globalThis.fetch = realFetch;
  }
});

test("runJob: returns only a TERMINAL job — long-polls past a dropped stream, throws on deadline (§7.9)", async () => {
  const realFetch = globalThis.fetch;
  const jobId = "jT";
  // Build a fetch that: submit → running; /events → 500 (stream drops); then getJob
  // polls running, running, done. runJob must loop the long-poll and return done.
  const mk = (over) => ({ ok: true, status: 200, text: async () => JSON.stringify(over), json: async () => over });
  let pollCalls = 0;
  const client = new HubClient("http://hub:3000", "", "", "tok");
  try {
    globalThis.fetch = async (url) => {
      if (url.endsWith("/jobs")) return mk({ id: jobId, state: "running", done: false });
      if (url.endsWith("/events")) return { ok: false, status: 500, body: null };            // stream drops
      if (url.includes(`/jobs/${jobId}`)) { pollCalls++; return mk({ id: jobId, state: pollCalls >= 3 ? "succeeded" : "running", done: pollCalls >= 3 }); }
      return { ok: false, status: 404, text: async () => "" };
    };
    const job = await client.runJob("svc", {});
    assert.equal(job.done, true);
    assert.equal(job.state, "succeeded");
    assert.ok(pollCalls >= 3);                       // it looped the long-poll, didn't return the first running job
  } finally { globalThis.fetch = realFetch; }

  // deadline path: stream drops, job never terminal → throws (never returns running).
  try {
    globalThis.fetch = async (url) => {
      if (url.endsWith("/jobs")) return mk({ id: jobId, state: "running", done: false });
      if (url.endsWith("/events")) return { ok: false, status: 500, body: null };
      return mk({ id: jobId, state: "running", done: false });   // forever running
    };
    await assert.rejects(client.runJob("svc", {}, { timeoutMs: 1 }), /not terminal before deadline/);
  } finally { globalThis.fetch = realFetch; }
});

test("renderPrompt: loads prompts/<name>.md and substitutes {{vars}} (missing → '')", () => {
  const dir = mkdtempSync(join(tmpdir(), "gaws-prompt-"));
  mkdirSync(join(dir, "prompts"));
  writeFileSync(join(dir, "prompts", "greet.md"), "Hi {{who}}, build {{repo}}. {{missing}}done");
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    assert.equal(renderPrompt("greet", { who: "agent", repo: "x/y" }), "Hi agent, build x/y. done");
    assert.equal(renderPrompt("greet", { who: "a" }), "Hi a, build . done"); // missing repo/missing → ""
  } finally {
    process.chdir(cwd);
  }
});

test("hub.presence: no-ops without a token, POSTs with bearer when set", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 204, text: async () => "" }; };
  try {
    // no token -> never calls fetch
    await new HubClient("http://hub:3000", "", "", "").presence({ label: "x", activity: "y" });
    assert.equal(calls.length, 0);

    // with token -> one POST to /api/presence, bearer header, JSON body
    await new HubClient("http://hub:3000", "", "", "tok123").presence({ label: "acme-bot", activity: "iter 1/5 · build" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://hub:3000/api/presence");
    assert.equal(calls[0].opts.method, "POST");
    assert.equal(calls[0].opts.headers.authorization, "Bearer tok123");
    assert.deepEqual(JSON.parse(calls[0].opts.body), { label: "acme-bot", activity: "iter 1/5 · build" });
  } finally {
    globalThis.fetch = realFetch;
  }
});
