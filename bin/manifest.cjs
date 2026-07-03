#!/usr/bin/env node
// gaws-manifest — emit the manifest `services:` block from the createAgent
// declaration (L2). One declaration (the code, with zod schemas) is the source;
// this prints the block so the author never hand-keeps a second copy in sync.
//
//   gaws-manifest [entry]          # print the services[] YAML scaffold (default entry: ./server.js)
//   gaws-manifest --json [entry]   # print the raw describe JSON
//
// It runs `GAWS_DESCRIBE=1 node <entry>`, which createAgent honors by printing its
// resolved services[] (JSON Schema via toJsonSchema) and exiting WITHOUT binding a
// port. The `services-match` compliance rule diffs this against the committed
// manifest, so no drift can ship.
//
// ponytail: PRINT only. An in-place `--write` that rewrites the block would have to
// preserve the manifest's operational fields (summary/timeout/pool/concurrency) that
// the code doesn't carry — lossy YAML surgery on hand-tuned config. The enforcement
// is the services-match FAIL, not an auto-rewrite; the author pastes this scaffold
// and adds the operational knobs. Add --write surgery only if drift-fixing by hand
// ever measurably hurts.
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");

function describe(entry) {
  const out = execFileSync("node", [entry], {
    encoding: "utf8",
    env: { ...process.env, GAWS_DESCRIBE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const obj = JSON.parse(out);
  if (!obj || !Array.isArray(obj.services)) throw new Error("describe output has no services[]");
  return obj.services;
}

// Emit the services[] as a YAML block. Nested request/result JSON Schemas are emitted
// as inline flow JSON — valid YAML (a superset of JSON) — so no YAML serializer is needed.
function toYamlBlock(services) {
  const lines = ["services:"];
  for (const s of services) {
    lines.push(`  - name: ${s.name}`);
    lines.push(`    kind: ${s.kind}`);
    lines.push(`    path: ${s.path}`);
    if (s.kind === "sync" && s.method && s.method !== "POST") lines.push(`    method: ${s.method}`);
    if (s.request) lines.push(`    request: ${JSON.stringify(s.request)}`);
    if (s.result) lines.push(`    result: ${JSON.stringify(s.result)}`);
  }
  return lines.join("\n") + "\n";
}

function main(argv) {
  let json = false;
  const pos = [];
  for (const a of argv) {
    if (a === "--json") json = true;
    else if (a === "-h" || a === "--help") { usage(); return 0; }
    else pos.push(a);
  }
  const entry = pos[0] || "./server.js";
  if (!fs.existsSync(entry)) { process.stderr.write(`gaws-manifest: entry not found: ${entry}\n`); return 2; }
  let services;
  try { services = describe(entry); }
  catch (e) { process.stderr.write(`gaws-manifest: could not describe ${entry}: ${(e && e.message) || e}\n`); return 2; }
  process.stdout.write(json ? JSON.stringify({ services }, null, 2) + "\n" : toYamlBlock(services));
  return 0;
}

function usage() {
  process.stdout.write(`gaws-manifest — print the manifest services[] block from createAgent (L2)

Usage:
  gaws-manifest [entry]          print the services[] YAML scaffold (default entry: ./server.js)
  gaws-manifest --json [entry]   print the raw describe JSON

Paste the block into manifest.yaml and add operational fields (summary, timeout,
pool, concurrency). The services-match compliance rule fails on {name,kind,path} drift.
`);
}

process.exit(main(process.argv.slice(2)));
