// Regression tests for the evolution-08 compliance rules — specifically the
// services-match manifest parser, whose false-FAILs (found by the v0.7.0 adversarial
// review) BLOCK legit builds. Each case below matched createAgent yet FAILed pre-fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { parseManifestServiceList, diffServices } = require("../bin/compliance.cjs");

const CODE = [{ name: "echo", kind: "sync", path: "/api/echo" }];

test("services-match parser: canonical + previously-false-FAIL YAML forms all MATCH", () => {
  const matching = {
    canonical: "services:\n  - name: echo\n    kind: sync\n    path: /api/echo",
    "trailing comment on header": "services:   # the contract\n  - name: echo\n    kind: sync\n    path: /api/echo",
    'quoted kind ("sync")': 'services:\n  - name: echo\n    kind: "sync"\n    path: /api/echo',
    "quoted kind ('sync')": "services:\n  - name: echo\n    kind: 'sync'\n    path: /api/echo",
    "bare-dash bullet": "services:\n  -\n    name: echo\n    kind: sync\n    path: /api/echo",
    "request block before path": "services:\n  - name: echo\n    kind: sync\n    request: { type: object, properties: { path: { type: string } } }\n    path: /api/echo",
  };
  for (const [label, yaml] of Object.entries(matching)) {
    const parsed = parseManifestServiceList(yaml);
    assert.notEqual(parsed, null, `${label}: should parse (block form)`);
    assert.deepEqual(diffServices(CODE, parsed), [], `${label}: should MATCH, not drift`);
  }
});

test("services-match parser: unparseable forms return null (→ WARN, never a false FAIL)", () => {
  // flow style + absent → null; the caller degrades to WARN rather than diffing to FAIL.
  assert.equal(parseManifestServiceList("services: [{name: echo, kind: sync, path: /api/echo}]"), null);
  assert.equal(parseManifestServiceList("name: x\nkind: AgentType"), null);
});

test("services-match parser: a REAL drift is still detected", () => {
  const drifted = parseManifestServiceList("services:\n  - name: echo\n    kind: sync\n    path: /api/DIFFERENT");
  assert.ok(diffServices(CODE, drifted).length > 0, "genuine path drift must still be caught");
});
