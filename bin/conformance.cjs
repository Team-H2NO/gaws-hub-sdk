#!/usr/bin/env node
// gaws-conformance — the SDK release gate (L5). Boots the `echo` sample agent from
// the built dist and drives every wire behavior the SDK server GUARANTEES, so a
// hub↔SDK contract regression fails the release, not just a downstream agent build:
//
//   /healthz, /meta                     the runtime contract (§3/§5)
//   GAWS_DESCRIBE services[]            the manifest source of truth (L2)
//   sync invoke echoes the body         sync service happy path
//   malformed JSON body → 400           readBody distinguishes empty from garbage (§7.9)
//   response past the inline ceiling → 413   the §11 store-a-blob guard
//   sync past the sync ceiling → 504         the §14 long-running-⇒-job guard
//   services-match on the sample passes      L2 code⇄manifest, install-free (self-reference)
//
// SCOPE (honest): this drives the SDK SERVER side directly (no hub needed), which is
// where 08's new guards live. The hub-MEDIATED flows (cold-start invoke, job dispatch
// + progress, cancel latency) are exercised by the hub's own e2e scenario using real
// SDK agents; the report-auth 403 case is deferred with D2 (01, single-user prototype).
"use strict";

const http = require("http");
const net = require("net");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const ECHO = path.join(ROOT, "test", "conformance", "echo");

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

function req(port, method, p, body, raw) {
  return new Promise((resolve) => {
    const data = body == null ? null : raw ? String(body) : JSON.stringify(body);
    const r = http.request({ host: "127.0.0.1", port, method, path: p,
      headers: data != null ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} },
      (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode, body: b })); });
    r.on("error", () => resolve({ status: 0, body: "" }));
    if (data != null) r.write(data);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    GAWS_SYNC_CEILING_MS: "150",     // slow-sync sleeps 400ms → 504
    GAWS_MAX_INLINE_BYTES: "1024",   // big-echo returns 4KB → 413
    ECHO_SLOW_MS: "400",
    ECHO_BLOB_BYTES: "4096",
  };
  const child = spawn("node", [path.join(ECHO, "server.js")], { env, stdio: ["ignore", "ignore", "inherit"] });

  const results = [];
  const check = (label, ok, detail) => { results.push({ label, ok, detail: detail || "" }); };

  try {
    // wait for /healthz
    let up = false;
    for (let i = 0; i < 60; i++) { const r = await req(port, "GET", "/healthz"); if (r.status === 200) { up = true; break; } await sleep(100); }
    if (!up) { check("agent boots + /healthz → 200", false, "never became healthy"); throw new Error("boot"); }
    check("agent boots + /healthz → 200", true);

    const meta = await req(port, "GET", "/meta");
    let metaOk = false;
    try { const j = JSON.parse(meta.body); metaOk = Array.isArray(j.capabilities?.services) && j.capabilities.services.length === 4; } catch {}
    check("GET /meta advertises the 4 services", metaOk, `status ${meta.status}`);

    const echo = await req(port, "POST", "/api/echo", { hi: 1 });
    check("sync invoke echoes the body", echo.status === 200 && JSON.parse(echo.body || "{}").hi === 1, `status ${echo.status}`);

    const bad = await req(port, "POST", "/api/echo", "{not json", true);
    check("malformed JSON body → 400 (not {}-validated 200)", bad.status === 400, `status ${bad.status}`);

    const big = await req(port, "POST", "/api/big-echo", {});
    check("response past inline ceiling → 413", big.status === 413, `status ${big.status}`);

    const slow = await req(port, "POST", "/api/slow-sync", {});
    check("sync past sync ceiling → 504", slow.status === 504, `status ${slow.status}`);

    // GAWS_DESCRIBE
    let descOk = false;
    try {
      const out = execFileSync("node", [path.join(ECHO, "server.js")], { encoding: "utf8", env: { ...process.env, GAWS_DESCRIBE: "1" }, stdio: ["ignore", "pipe", "ignore"] });
      const j = JSON.parse(out);
      descOk = Array.isArray(j.services) && j.services.length === 4 && j.services.every((s) => s.name && s.kind && s.path);
    } catch {}
    check("GAWS_DESCRIBE prints services[] (L2 source of truth)", descOk);

    // services-match on the sample (install-free via self-reference). The echo dir
    // is not a full agent repo (no build.sh), so overall compliance exits non-zero —
    // read stdout regardless and inspect just the services-match rule's status.
    let matchOk = false, matchDetail = "";
    let out = "";
    try {
      out = execFileSync("node", [path.join(__dirname, "compliance.cjs"), ECHO, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch (e) { out = (e && e.stdout) || ""; }
    try {
      const rep = JSON.parse(out);
      const sm = (rep.sections || []).flatMap((s) => s.checks).find((c) => /services-match/.test(c.label));
      matchOk = !!sm && sm.status === "pass"; matchDetail = sm ? sm.detail : "rule not found";
    } catch (e) { matchDetail = "could not parse compliance output"; }
    check("services-match passes on the sample (code ⇄ manifest)", matchOk, matchDetail);
  } finally {
    child.kill("SIGKILL");
  }

  const fails = results.filter((r) => !r.ok);
  for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.label}${r.detail ? "  — " + r.detail : ""}`);
  console.log(`\ngaws-conformance: ${results.length - fails.length}/${results.length} passed`);
  console.log("  note: hub-mediated flows (cold-start, job dispatch, cancel) run in the hub e2e; report-auth 403 deferred with D2.");
  return fails.length ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e) => { console.error("gaws-conformance: " + ((e && e.stack) || e)); process.exit(1); });
