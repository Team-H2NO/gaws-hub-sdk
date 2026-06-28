// Unit checks for the SDK's pure/reusable bits (node:test, no framework). Imports
// the built dist (what consumers get). Run: npm test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanModel, cleanEffort, claudeArgv, claudeEventToLogs, summarize, feed, served, runClaude } from "../dist/index.js";

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
