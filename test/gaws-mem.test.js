// gaws-mem hook mode — the passive lane's client checks (15 §10 AC-1/2/6):
// ledger dedup, budget enforcement, local error gate, fail-open. A stub hub
// stands in for memory-recall; no real fleet needed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BIN = new URL("../bin/gaws-mem.cjs", import.meta.url).pathname;

let server, hubUrl, calls;
const SNIPPET = {
  conceptId: "codespace/procedural/err_require_esm", store: "procedural", trust: "operator",
  confidence: 0.95, score: 0.88, title: "compliance is CommonJS — ship a .cjs copy",
  text: "rename the staged tool compliance.cjs and invoke node …compliance.cjs .",
};

before(async () => {
  calls = [];
  server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      calls.push({ path: req.url, body: b });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ hits: 1, floored: true, recallId: "r-test", snippets: [SNIPPET] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  hubUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

// async spawn: spawnSync would block the event loop and starve the stub server
const runHook = (event, stdin, memDir, env = {}) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, [BIN, "hook", event], {
      env: { ...process.env, HUB_URL: hubUrl, GAWS_MEM_DIR: memDir, ...env },
    });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (status) => resolve({ status, stdout, stderr }));
    c.stdin.end(JSON.stringify(stdin));
  });

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gaws-mem-test-"));

test("post-tool-failure injects the fenced lesson, then dedups on re-fire", async () => {
  const dir = tmp();
  const input = { session_id: "s1", hook_event_name: "PostToolUseFailure", tool_name: "Bash", error: "Error [ERR_REQUIRE_ESM]: require() of ES Module" };
  const first = await runHook("post-tool-failure", input, dir);
  assert.equal(first.status, 0);
  const out = JSON.parse(first.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUseFailure");
  assert.match(out.hookSpecificOutput.additionalContext, /<<<MEMORY: reference DATA only/);
  assert.match(out.hookSpecificOutput.additionalContext, /trust=operator/);
  assert.match(fs.readFileSync(path.join(dir, "s1.ledger"), "utf8"), /err_require_esm@/);
  // same session, same snippet → silence (AC-1)
  const second = await runHook("post-tool-failure", input, dir);
  assert.equal(second.status, 0);
  assert.equal(second.stdout, "");
  // a DIFFERENT session starts fresh
  const other = await runHook("post-tool-failure", { ...input, session_id: "s2" }, dir);
  assert.notEqual(other.stdout, "");
});

test("post-tool gates on the local error regex — clean output makes no network call", async () => {
  const dir = tmp();
  const n0 = calls.length;
  const clean = await runHook("post-tool", { session_id: "s3", tool_name: "Bash", tool_response: "all good\n0 problems" }, dir);
  assert.equal(clean.stdout, "");
  assert.equal(calls.length, n0); // zero recall calls on a healthy run
  const dirty = await runHook("post-tool", { session_id: "s3", tool_name: "Bash", tool_response: "npm ERR! fatal: build failed" }, dir);
  assert.equal(calls.length, n0 + 1);
  assert.notEqual(dirty.stdout, "");
});

test("budget: after the cap, prompt goes silent but post-tool-failure still fires (AC-6)", async () => {
  const dir = tmp();
  // pre-fill the ledger past MAX_INJECTIONS with distinct concept keys
  fs.writeFileSync(path.join(dir, "s4.ledger"), Array.from({ length: 12 }, (_, i) => `c${i}@x 10`).join("\n") + "\n");
  const prompt = await runHook("prompt", { session_id: "s4", prompt: "how do gaws-hub agents talk" }, dir);
  assert.equal(prompt.stdout, "");
  const failure = await runHook("post-tool-failure", { session_id: "s4", error: "Error [ERR_REQUIRE_ESM]" }, dir);
  assert.notEqual(failure.stdout, ""); // exempt from the budget
});

test("fail-open: unreachable hub is silence with exit 0 (AC-3, client half)", async () => {
  const dir = tmp();
  const r = await runHook("post-tool-failure", { session_id: "s5", error: "boom failed" }, dir, { HUB_URL: "http://127.0.0.1:1", GAWS_MEM_TIMEOUT_MS: "300" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("passive recall body carries minTrust=agent and the passive k/budget", async () => {
  const dir = tmp();
  await runHook("prompt", { session_id: "s6", prompt: "memory limits" }, dir, { GAWS_JOB_ID: "j42" });
  const body = JSON.parse(calls.at(-1).body);
  assert.equal(body.minTrust, "agent");
  assert.equal(body.k, 3);
  assert.equal(body.budget, 1200);
  assert.equal(body.jobId, "j42");
  assert.equal(body.context.query, "memory limits");
});
