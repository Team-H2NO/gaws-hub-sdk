#!/usr/bin/env node
// compliance — check that a gaws-hub agent repo or built image satisfies the
// contract in agents-interface.md. Zero dependencies (Node stdlib only), so it
// rides along in every agent at .gaws-hub/tools/ and is trivial to run in CI.
//
// Compliance is defined by agents-interface.md:
//   §4  manifest rules the HUB ENFORCES (rejects otherwise) ............ FAIL
//   §3  the runtime contract (MUSTs: 0.0.0.0, relative URLs, build.sh) .. FAIL
//   §5/§14 the recommended contract (/healthz, /meta, HEALTHCHECK, label) WARN
//
// Severity: FAIL fails the run (non-zero exit); WARN never does.
//   exit 0 = compliant   exit 1 = a FAIL   exit 2 = usage/precondition error
//
// ponytail: the compliance rules live here, in one place. Mirror the hub's own
// leniency — assert only what the hub asserts; everything else is advisory.

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");

// ── pure helpers (no I/O; unit-tested) ────────────────────────────────────────

const fmt = (v) => (v === undefined ? "(absent)" : JSON.stringify(v));

// Strip a YAML scalar to its value: honor surrounding quotes, drop inline comments.
function cleanScalar(v) {
  if (v == null) return undefined;
  v = String(v).trim();
  if (v === "") return "";
  const q = v[0];
  if (q === '"' || q === "'") {
    const end = v.indexOf(q, 1);
    return end > 0 ? v.slice(1, end) : v.slice(1);
  }
  // Unquoted: a YAML comment starts at the first '#' that is at the start of the
  // value (comment-only → empty) or preceded by whitespace (a tab counts, not just
  // a space). A '#' glued to a token (foo#bar) is literal.
  if (v[0] === "#") return "";
  const h = v.search(/\s#/);
  if (h >= 0) v = v.slice(0, h).trim();
  return v;
}

// First top-level (column-0) `key: value` scalar.
function topScalar(lines, key) {
  const re = new RegExp("^" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ":[ \\t]*(.*)$");
  for (const raw of lines) {
    const m = raw.match(re);
    if (m) return cleanScalar(m[1]);
  }
  return undefined;
}

// Lines belonging to a top-level `key:` mapping block (everything more-indented).
function topBlockLines(lines, key) {
  const re = new RegExp("^" + key + ":[ \\t]*(#.*)?$");
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) { start = i; break; }
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") { out.push(l); continue; }
    if (/^[ \t]/.test(l)) out.push(l); else break;
  }
  return out;
}

// Lines of a top-level `key:`'s block-sequence value. Unlike a mapping block, a YAML
// block sequence may sit at the SAME column as its key (`storage:` then `- …` at
// column 0) — valid, common YAML the hub parses identically. So accept indented lines
// AND column-0 sequence entries (`- …`), stopping at the next top-level mapping key.
function blockSeqLines(lines, key) {
  const re = new RegExp("^" + key + ":[ \\t]*(#.*)?$");
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) { start = i; break; }
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") { out.push(l); continue; }
    if (/^[ \t]/.test(l) || /^-(\s|$)/.test(l)) out.push(l); else break;
  }
  return out;
}

// health.path, if declared (flow `health: { path: /x }` or a block `health:\n  path: /x`).
function parseHealthPath(lines) {
  const flow = lines.find((l) => /^health:[ \t]*\{/.test(l));
  if (flow) { const m = flow.match(/\bpath:[ \t]*([^,}\s]+)/); return m ? cleanScalar(m[1]) : undefined; }
  const blk = topBlockLines(lines, "health");
  if (blk) for (const l of blk) { const m = l.match(/^[ \t]*path:[ \t]*(.*)$/); if (m) return cleanScalar(m[1]); }
  return undefined;
}

// `kind:` value from a single storage item (flow `{kind: x, ...}` or block).
function extractKind(itemText) {
  const m = itemText.match(/(?:^|[\s{,])kind:[ \t]*([^,}\s]+)/);
  return m ? cleanScalar(m[1]) : undefined;
}

// Split a flow list body `a, {b, c}, d` on top-level commas (brace/bracket-aware).
function splitFlowItems(s) {
  const items = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    if (ch === "," && depth <= 0) { items.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim() !== "") items.push(cur);
  return items.map((x) => x.trim()).filter(Boolean);
}

function parseStorage(lines) {
  // Flow style `storage: [ … ]`, possibly spanning several lines until the matching `]`.
  const idx = lines.findIndex((l) => /^storage:[ \t]*\[/.test(l));
  if (idx >= 0) {
    let buf = lines[idx], depth = 0;
    const scan = (s) => { for (const ch of s) { if (ch === "[") depth++; else if (ch === "]") depth--; } };
    scan(buf);
    for (let j = idx + 1; depth > 0 && j < lines.length; j++) { buf += "\n" + lines[j]; scan(lines[j]); }
    const a = buf.indexOf("["), b = buf.lastIndexOf("]");
    const body = b > a ? buf.slice(a + 1, b) : buf.slice(a + 1);
    return splitFlowItems(body).map((it) => ({ kind: extractKind(it) }));
  }
  const blk = blockSeqLines(lines, "storage");
  if (!blk) return [];
  const items = [];
  let cur = null;
  for (const l of blk) {
    const t = l.replace(/^[ \t]+/, "");
    if (t.startsWith("- ")) { if (cur != null) items.push(cur); cur = t.slice(2); }
    else if (t === "-") { if (cur != null) items.push(cur); cur = ""; }
    else if (cur != null) cur += "\n" + t;
  }
  if (cur != null) items.push(cur);
  return items.map((it) => ({ kind: extractKind(it) }));
}

// Tolerant subset parse: extract exactly what the hub validates (§4).
function parseManifest(text) {
  const m = { storage: [] };
  if (typeof text !== "string") return m;
  const lines = text.split(/\r?\n/);
  m.apiVersion = topScalar(lines, "apiVersion");
  m.kind = topScalar(lines, "kind");
  m.name = topScalar(lines, "name");
  m.image = topScalar(lines, "image");
  m.port = topScalar(lines, "port");
  m.healthPath = parseHealthPath(lines);
  m.storage = parseStorage(lines);
  m._text = text;
  return m;
}

// Light parse of the `services:` block (the service contract). Collects each
// service's kind/name/path so validateManifest can check them. Handles block style
// (the canonical form); flow `services: [ … ]` on one line is treated as absent.
function parseServicesBlock(text) {
  const lines = String(text || "").split(/\r?\n/);
  const i = lines.findIndex((l) => /^services:[ \t]*$/.test(l));
  if (i < 0) return { present: false };
  // Split the block into service ITEMS (each starts with a `-` bullet); per item,
  // take the FIRST kind/path (top-level) so nested request/result schemas — which use
  // `name:`/`type:` — don't inflate the count or get mistaken for the service kind.
  const items = [];
  let cur = null;
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (/^[^\s#]/.test(l)) break; // back to a top-level key
    if (/^\s*#/.test(l) || !l.trim()) continue;
    if (/^\s*-\s/.test(l)) { cur = { text: l }; items.push(cur); }
    else if (cur) cur.text += "\n" + l;
  }
  const kinds = [];
  let withPath = 0;
  for (const it of items) {
    const km = it.text.match(/\bkind:\s*([A-Za-z]+)/);
    if (km) kinds.push(km[1]);
    if (/\bpath:\s*[^\s,}]+/.test(it.text)) withPath++;
  }
  return { present: true, count: items.length, kinds, allHavePath: items.length > 0 && withPath >= items.length };
}

// §4 — the rules the hub enforces (rejects otherwise). All FAIL severity.
function validateManifest(m) {
  m = m || {};
  const c = [];
  const fail = (label, ok, detail) => c.push({ label, status: ok ? "pass" : "fail", detail: detail || "" });
  fail('manifest kind == "AgentType"', m.kind === "AgentType", `kind=${fmt(m.kind)}`);
  fail("manifest name is non-empty", !!(m.name && String(m.name).trim()), `name=${fmt(m.name)}`);
  fail("manifest image is non-empty", !!(m.image && String(m.image).trim()), `image=${fmt(m.image)}`);
  fail("manifest port is present and numeric", m.port != null && /^\d+$/.test(String(m.port)), `port=${fmt(m.port)}`);
  const kinds = (m.storage || []).map((s) => s.kind);
  const bad = kinds.filter((k) => !["volume", "database", "external"].includes(k));
  fail(
    "every storage[].kind ∈ {volume,database,external}",
    bad.length === 0,
    bad.length ? `invalid/missing: ${bad.map(fmt).join(", ")}` : kinds.length ? `${kinds.length} ok` : "none"
  );
  // §service-contract — services[] (optional; only checked when declared).
  const svc = parseServicesBlock(m._text);
  if (svc.present) {
    const badSvc = svc.kinds.filter((k) => !["sync", "job"].includes(k));
    fail("every service[].kind ∈ {sync,job}", badSvc.length === 0,
      badSvc.length ? `invalid: ${badSvc.map(fmt).join(", ")}` : `${svc.count} service(s)`);
    fail("every service declares a path", svc.allHavePath,
      svc.allHavePath ? `${svc.count} service(s)` : "a service is missing path:");
  }
  return c;
}

// ── Tools-tab capability requests (advisory; the hub doesn't enforce these) ──────
// The builder persists the operator's Tools-tab selection in .gaws-hub/agent.toml as
// `tools_auto = true` (build decides) or `requested = ["database", ...]`, and tells the
// inner build to wire each into manifest.yaml/Dockerfile. We re-derive what the built
// agent actually declares and flag any requested capability that didn't land — WARN
// only, since it's a build-quality check, not a hub-enforced rule.

// Read the Tools-tab selection the builder persists in .gaws-hub/agent.toml.
function parseRequested(tomlText) {
  const text = String(tomlText || "");
  const autoTools = /^[ \t]*tools_auto[ \t]*=[ \t]*true/m.test(text);
  const requested = [];
  if (!autoTools) {
    const m = text.match(/requested[ \t]*=[ \t]*\[([\s\S]*?)\]/);
    if (m) { const re = /"((?:\\.|[^"\\])*)"/g; let mm; while ((mm = re.exec(m[1]))) requested.push(mm[1]); }
  }
  return { autoTools, requested };
}

// Which capability keys the built agent actually declares — mirrors the builder's own
// deriveFeaturesFromManifest (manifest.yaml is the source of truth; Dockerfile only for
// image-only tooling). Comment-stripped + heuristic. Keys in canonical order.
function detectCapabilities(manifestText, dockerfileText) {
  const strip = (s) => String(s || "").split(/\r?\n/)
    .map((l) => l.replace(/\s+#.*$/, "")).filter((l) => !/^\s*#/.test(l)).join("\n");
  const m = strip(manifestText), d = strip(dockerfileText);
  const has = [];
  const add = (k, cond) => { if (cond && !has.includes(k)) has.push(k); };
  add("database", /kind:\s*database/.test(m));
  add("volume", /kind:\s*volume/.test(m));
  add("egress", /\begress:\s*true/.test(m));
  add("store", /\bstore:\s*true/.test(m));
  add("messaging", /\bmessaging\s*:/.test(m));
  add("dockerSocket", /\bdockerSocket:\s*true/.test(m));
  add("claude", /~\/\.claude\b/.test(m));
  add("codex", /~\/\.codex\b/.test(m));
  add("gh", /~\/\.config\/gh\b/.test(m));
  add("playwright", /playwright|chromium/i.test(d) || /playwright/i.test(m));
  // database `scope` rides in the requested list as a `db_scope:<scope>` token
  // (instance is implicit). Detect it so the requested-vs-manifest check matches.
  if (has.includes("database")) {
    const sm = m.match(/kind:\s*database[^\n}]*\bscope:\s*(type|system)\b/)
            || m.match(/\bscope:\s*(type|system)\b[^\n{]*kind:\s*database/);
    if (sm) has.push(`db_scope:${sm[1]}`);
  }
  return has;
}

// Advisory check: did the build wire every operator-requested capability? (WARN only.)
function checkRequested(spec, manifestText, dockerfileText) {
  spec = spec || { autoTools: false, requested: [] };
  if (spec.autoTools) return [{ label: "tools: AUTO — capabilities determined by the build", status: "pass", detail: "no explicit request to verify" }];
  if (!spec.requested.length) return [{ label: "tools: no extra capabilities requested", status: "pass", detail: "" }];
  const have = new Set(detectCapabilities(manifestText, dockerfileText));
  const missing = spec.requested.filter((k) => !have.has(k));
  return [{
    label: "operator-requested capabilities are wired into the agent",
    status: missing.length ? "warn" : "pass",
    detail: missing.length ? `requested but not found in manifest.yaml/Dockerfile: ${missing.join(", ")}` : spec.requested.join(", "),
  }];
}

// §5/§14 — recommended Dockerfile contract. All WARN severity (never fails).
function scanDockerfile(text, manifestPort) {
  text = text || "";
  const c = [];
  const warn = (label, ok, detail) => c.push({ label, status: ok ? "pass" : "warn", detail: detail || "" });
  const hasArg = /^[ \t]*ARG[ \t]+MANIFEST_B64\b/m.test(text);
  const hasLabel = /^[ \t]*LABEL[ \t]+org\.gaws\.agent\.manifest\b/m.test(text);
  warn("self-registers (ARG MANIFEST_B64 + LABEL org.gaws.agent.manifest)", hasArg && hasLabel, `ARG=${hasArg} LABEL=${hasLabel}`);
  warn("has a HEALTHCHECK", /^[ \t]*HEALTHCHECK\b/m.test(text), "");
  if (manifestPort != null && String(manifestPort) !== "") {
    const expose = text.match(/^[ \t]*EXPOSE[ \t]+(\d+)/m);
    warn(`EXPOSE matches manifest port ${manifestPort}`, expose ? expose[1] === String(manifestPort) : false, expose ? `EXPOSE ${expose[1]}` : "no EXPOSE");
  }
  return c;
}

// Heuristic: same-origin absolute refs that break under the /a/<id>/ path-strip.
// Flags `href|src|action="/x"`, `fetch|WebSocket|EventSource("/x")`, and CSS/inline
// `url(/x)` (§3 calls out HTML/JS *and CSS*); ignores relative (`./x`, `x`) and
// protocol-relative (`//host`) URLs.
function findAbsoluteAssetRefs(text) {
  const hits = [];
  if (typeof text !== "string") return hits;
  const reAttr = /\b(?:href|src|action)\s*=\s*["']\/(?!\/)/;
  const reCall = /\b(?:fetch|WebSocket|EventSource)\s*\(\s*[`"']\/(?!\/)/;
  const reCss = /\burl\(\s*["']?\/(?!\/)/;
  text.split(/\r?\n/).forEach((l, i) => {
    if (reAttr.test(l) || reCall.test(l) || reCss.test(l)) hits.push({ line: i + 1, text: l.trim().slice(0, 120) });
  });
  return hits;
}

const decideExit = (checks) => ((checks || []).some((c) => c && c.status === "fail") ? 1 : 0);

// ── evolution 08 rules: L2 services-match + L6 §11/§14/§16 static rules ─────────

// Parse the manifest services[] into [{name,kind,path}] (block style; the canonical
// form). Returns null when the block can't be cleanly parsed (no block header, or
// flow style `services: [ … ]`) — the caller degrades to WARN, never a false FAIL.
// Takes the FIRST name/kind/path per item, matched ON THE SAME LINE so a nested
// request schema's `name:`/`path:` child keys can't be captured across a newline.
function parseManifestServiceList(text) {
  const lines = String(text || "").split(/\r?\n/);
  // block header only; a trailing inline comment is allowed. Flow `services: [` → no
  // match → null (WARN, not FAIL).
  const i = lines.findIndex((l) => /^services:[ \t]*(#.*)?$/.test(l));
  if (i < 0) return null; // no block services header (absent, or flow style)
  const items = [];
  let cur = null;
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (/^[^\s#]/.test(l)) break; // back to a top-level key
    if (/^\s*#/.test(l) || !l.trim()) continue;
    // a new item bullet: `- name: …` OR a bare `-` on its own line (fields below).
    if (/^\s*-(\s|$)/.test(l)) { cur = { text: l }; items.push(cur); }
    else if (cur) cur.text += "\n" + l;
  }
  // Match the field on the first line where the key is at LINE START (after an
  // optional `- ` bullet) — so a nested `path:`/`name:` inside an inline
  // `request: { … path: … }` (mid-line, not at line start) can't be captured.
  const field = (text, key) => {
    const re = new RegExp("^[ \\t]*(?:-[ \\t]+)?" + key + ":[ \\t]*(.*)$");
    for (const line of text.split("\n")) { const m = line.match(re); if (m) return cleanScalar(m[1]); }
    return undefined;
  };
  return items.map((it) => ({ name: field(it.text, "name"), kind: field(it.text, "kind"), path: field(it.text, "path") }));
}

// L2 services-match: the code createAgent declaration is the source; diff its
// {name,kind,path} against the manifest's. Runs GAWS_DESCRIBE (needs node_modules)
// — when it can't run (no install/entry) it's a non-blocking WARN, not a false FAIL.
function diffServices(codeServices, manifestServices) {
  const key = (s) => `${s.name}|${s.kind}|${s.path}`;
  const codeSet = new Set((codeServices || []).map(key));
  const manSet = new Set((manifestServices || []).map(key));
  const drift = [];
  for (const s of codeServices || []) if (!manSet.has(key(s))) drift.push(`+ code ${s.name} (${s.kind} ${s.path}) — absent/differs in manifest`);
  for (const s of manifestServices || []) if (!codeSet.has(key(s))) drift.push(`- manifest ${s.name} (${s.kind} ${s.path}) — absent/differs in code`);
  return drift;
}

function findEntry(dir) {
  try {
    const pkg = JSON.parse(readSafe(path.join(dir, "package.json")) || "{}");
    if (pkg.main && fs.existsSync(path.join(dir, pkg.main))) return pkg.main;
  } catch {}
  for (const e of ["server.js", "server.mjs", "dist/server.js", "src/server.js"]) {
    if (fs.existsSync(path.join(dir, e))) return e;
  }
  return null;
}

function describeServices(dir, entry) {
  try {
    const out = execFileSync("node", [entry], {
      cwd: dir, encoding: "utf8", env: { ...process.env, GAWS_DESCRIBE: "1" },
      stdio: ["ignore", "pipe", "ignore"], timeout: 20000,
    });
    const obj = JSON.parse(out);
    return Array.isArray(obj.services) ? obj.services : null;
  } catch { return null; }
}

function checkServicesMatch(dir, manifestText) {
  const label = "services-match (createAgent ⇄ manifest services[])";
  const entry = findEntry(dir);
  if (!entry) return [{ label, status: "pass", detail: "no server entry found — skipped" }];
  const code = describeServices(dir, entry);
  if (code == null) return [{ label, status: "warn", detail: `could not run GAWS_DESCRIBE on ${entry} (npm install/build first?) — not verified` }];
  const manifestServices = parseManifestServiceList(manifestText);
  // A present-but-unparseable services block (flow style, exotic YAML) → WARN, never a
  // hard FAIL: only diff when the manifest parsed cleanly, else we could block a
  // legit build on a parse quirk (the whole point — services-match is the one FAIL rule).
  if (manifestServices == null) {
    return [{ label, status: "warn", detail: "manifest services[] not in block form (flow/absent) — not diffed; the runtime is the gate" }];
  }
  // Validity backstop: a well-formed service has kind ∈ {sync,job} and a path
  // starting with "/". Anything else means the parse is untrustworthy (a nested
  // schema key leaked in) → WARN, never a false FAIL.
  if (manifestServices.some((s) => !s.name || !["sync", "job"].includes(s.kind) || !(s.path && s.path.startsWith("/")))) {
    return [{ label, status: "warn", detail: "a manifest service[] entry didn't parse cleanly (name/kind∈{sync,job}/path=/…) — not diffed" }];
  }
  const drift = diffServices(code, manifestServices);
  return [{ label, status: drift.length ? "fail" : "pass",
    detail: drift.length ? drift.slice(0, 8).join("; ") : `${code.length} service(s) match` }];
}

// Collect an agent's own source (JS/TS), excluding vendored/build dirs.
const SRC_SKIP = new Set(["node_modules", ".git", ".gaws-hub", "dist", "web", "test", "tests", "public", "static"]);
function collectSourceFiles(root) {
  const out = [];
  const stack = [root];
  let budget = 5000;
  while (stack.length && budget-- > 0) {
    const dir = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SRC_SKIP.has(e.name)) stack.push(full); }
      else if (/\.(m|c)?[jt]s$/.test(e.name)) out.push(full);
    }
  }
  return out;
}

// L6 §14 (static half; the runtime 504 sync-ceiling is the HARD gate): flag an
// `await` inside a plain `for (…)`/`while (…)` loop — the per-element sequential
// async pattern that blows a sync ceiling on a large collection (pubmed batch-fulltext).
// Deliberately EXCLUDES `for await (…)` — that is stream/async-iterable consumption
// (hub.streamJob), which is idiomatic and bounded by the producer, not a batch loop.
// WARN, because static analysis can't tell a fast bounded loop (search/metadata
// caching) from a slow unbounded one without running it (§10) — the runtime ceiling
// makes that call; this is a pre-build hint, not the gate.
function findAwaitInLoop(text) {
  const lines = String(text || "").split(/\r?\n/);
  const hits = [];
  const loopStack = []; // brace depths at which a plain-loop header opened
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // plain for/while only — NOT `for await` (stream consumption).
    const isLoopHeader = !/\bfor\s+await\s*\(/.test(l) && /\b(for\s*\(|while\s*\()/.test(l);
    const opens = (l.match(/\{/g) || []).length;
    const closes = (l.match(/\}/g) || []).length;
    if (isLoopHeader) loopStack.push(depth);
    // ignore an await that is itself iterating a stream on this line
    if (loopStack.length && /\bawait\b/.test(l) && !/for\s+await/.test(l)) hits.push({ line: i + 1, text: l.trim().slice(0, 100) });
    depth += opens - closes;
    while (loopStack.length && depth <= loopStack[loopStack.length - 1]) loopStack.pop();
  }
  lines.forEach((l, i) => { if (/Promise\.all\s*\([^)]*\.map\s*\(\s*async/.test(l)) hits.push({ line: i + 1, text: l.trim().slice(0, 100) }); });
  return hits;
}

// Scope the scan to plausible HANDLER files (the entry + service/route/handler
// files) — internal db/util loops aren't sync-handler code, so scanning the whole
// tree just adds noise.
function collectHandlerFiles(dir) {
  const entry = findEntry(dir);
  const all = collectSourceFiles(dir);
  const set = new Set();
  if (entry) set.add(path.resolve(dir, entry));
  for (const f of all) if (/(servic|handler|route|api)/i.test(path.basename(f))) set.add(path.resolve(f));
  return [...set];
}

function checkSyncNotBatch(dir, manifestText) {
  const label = "sync-not-batch (§14: per-element await in a sync handler)";
  const services = parseManifestServiceList(manifestText) || [];
  const nSync = services.filter((s) => s.kind === "sync").length;
  if (!nSync) return [{ label, status: "pass", detail: "no sync services" }];
  const hits = [];
  for (const f of collectHandlerFiles(dir)) for (const h of findAwaitInLoop(readSafe(f))) hits.push(`${rel(dir, path.resolve(f))}:${h.line}`);
  if (!hits.length) return [{ label, status: "pass", detail: `${nSync} sync service(s), no per-element loop-await in handler files` }];
  return [{ label, status: "warn",
    detail: `${hits.length} loop-await site(s): ${hits.slice(0, 6).join(", ")}${hits.length > 6 ? " …" : ""} — if any is in a sync handler over a large collection, make it kind:job (the runtime returns 504 past the 10s ceiling)` }];
}

// L6 §11 (static half; the runtime 413 inline-ceiling is the hard gate): flag a
// base64 blob in a handler — the inline-a-large-payload smell. WARN.
function findBase64Blobs(text) {
  const hits = [];
  String(text || "").split(/\r?\n/).forEach((l, i) => {
    if (/\.toString\(\s*["']base64["']\s*\)/.test(l)) hits.push({ line: i + 1 });
  });
  return hits;
}
function checkNoBase64Blob(dir) {
  const label = "no-base64-blob (§11: inline base64 payload)";
  const hits = [];
  for (const f of collectSourceFiles(dir)) for (const h of findBase64Blobs(readSafe(f))) hits.push(`${rel(dir, f)}:${h.line}`);
  if (!hits.length) return [{ label, status: "pass", detail: "" }];
  return [{ label, status: "warn",
    detail: `${hits.length} base64 site(s): ${hits.slice(0, 6).join(", ")}${hits.length > 6 ? " …" : ""} — a large payload belongs in the store (return {storeKey}); the runtime refuses a response over the inline ceiling with 413` }];
}

// L6 §16: if the repo AUTHORS a sub-LLM prompt, keep it in a file under prompts/,
// not a large string literal — keeps the injectable prompt surface auditable in
// diffs. WARN (not FAIL): a passthrough/conversational agent (the template) forwards
// the USER's input as the task and has no authored prompt to file, so a hard FAIL
// would wrongly block the load-bearing seed. The signal we flag is a LARGE string
// LITERAL prompt (an authored prompt inlined in code); a variable/renderPrompt task
// passes. The blessed loader is renderPrompt (from the SDK).
function checkPromptsAsFiles(dir) {
  const label = "prompts-as-files (§16: authored LLM prompts are files, not literals)";
  const files = collectSourceFiles(dir);
  let usesClaude = false;
  const literalHits = [];
  for (const f of files) {
    const t = readSafe(f);
    if (/\brunClaude\s*\(/.test(t) || /["'`]claude["'`]\s*,/.test(t)) usesClaude = true;
    // an AUTHORED literal prompt: a big inline string as the task / first runClaude arg.
    t.split(/\r?\n/).forEach((l, i) => {
      if (/\brunClaude\s*\(\s*["'`][^"'`]{40,}/.test(l) || /\btask\s*:\s*["'`][^"'`]{80,}/.test(l)) literalHits.push(`${rel(dir, f)}:${i + 1}`);
    });
  }
  if (!usesClaude) return [{ label, status: "pass", detail: "no sub-LLM driver" }];
  if (literalHits.length) return [{ label, status: "warn",
    detail: `authored string-literal prompt(s): ${literalHits.slice(0, 6).join(", ")} — move to prompts/*.md via renderPrompt so the injectable surface is diff-auditable` }];
  const promptsDir = path.join(dir, "prompts");
  const hasPrompts = isDir(promptsDir) && (() => { try { return fs.readdirSync(promptsDir).some((n) => /\.md$/.test(n)); } catch { return false; } })();
  return [{ label, status: "pass",
    detail: hasPrompts ? "prompts/*.md present" : "sub-LLM task is a variable/renderPrompt value (no inlined authored prompt)" }];
}

module.exports = { parseManifest, validateManifest, scanDockerfile, findAbsoluteAssetRefs, decideExit, parseArgs,
  parseRequested, detectCapabilities, checkRequested,
  parseManifestServiceList, diffServices, findAwaitInLoop, findBase64Blobs };

// ── filesystem helpers ────────────────────────────────────────────────────────

const readSafe = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isExec = (p) => { try { return !!(fs.statSync(p).mode & 0o111); } catch { return false; } };
const rel = (base, p) => path.relative(base, p).split(path.sep).join("/") || path.basename(p);

const SKIP_DIRS = new Set(["node_modules", ".git", ".gaws-hub", ".hg", ".svn"]);
const CLIENT_DIRS = new Set(["public", "static", "assets", "www", "client", "dist", "web"]);

// HTML anywhere (excluding vendored dirs); client JS only under known web dirs, so
// server.js's own route strings don't trip the absolute-ref heuristic.
function collectWebFiles(root) {
  const out = [];
  const stack = [{ dir: root, underClient: false }];
  let budget = 20000;
  while (stack.length && budget > 0) {
    const { dir, underClient } = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (budget-- <= 0) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push({ dir: full, underClient: underClient || CLIENT_DIRS.has(e.name) });
      } else if (e.isFile()) {
        if (/\.(html?|css)$/i.test(e.name)) out.push(full);
        else if (underClient && /\.m?js$/i.test(e.name)) out.push(full);
      }
    }
  }
  return out;
}

function checkRelativeUrls(dir) {
  const files = collectWebFiles(dir);
  const hits = [];
  for (const f of files) for (const h of findAbsoluteAssetRefs(readSafe(f))) hits.push(`${rel(dir, f)}:${h.line}`);
  if (files.length === 0) return [{ label: "no absolute same-origin asset refs", status: "pass", detail: "no HTML/client JS found (assets likely server-rendered)" }];
  if (hits.length === 0) return [{ label: "no absolute same-origin asset refs", status: "pass", detail: `${files.length} file(s) scanned` }];
  return [{ label: "no absolute same-origin asset refs", status: "warn", detail: `${hits.length} ref(s): ${hits.slice(0, 8).join(", ")}${hits.length > 8 ? " …" : ""}` }];
}

// ── repo (static) mode ────────────────────────────────────────────────────────

function checkRepo(dir) {
  const sections = [];
  let manifest = {};
  const mPath = path.join(dir, "manifest.yaml");
  const manExists = fs.existsSync(mPath);
  const manText = manExists ? readSafe(mPath) : "";
  if (!manExists) {
    sections.push({ name: "manifest (§4 — hub-enforced)", checks: [{ label: "manifest.yaml exists at repo root", status: "fail", detail: "missing" }] });
  } else {
    // present-but-empty still runs §4 field validation (which then FAILs on the absent fields)
    manifest = parseManifest(manText);
    sections.push({ name: "manifest (§4 — hub-enforced)", checks: [{ label: "manifest.yaml exists at repo root", status: "pass", detail: manText.trim() ? "" : "present but empty" }, ...validateManifest(manifest)] });
  }

  const bPath = path.join(dir, "build.sh");
  let bcheck;
  if (!fs.existsSync(bPath)) bcheck = { label: "build.sh exists at repo root (§3 REQUIRED)", status: "fail", detail: "missing" };
  else bcheck = { label: "build.sh exists and is executable (§3 REQUIRED)", status: isExec(bPath) ? "pass" : "fail", detail: isExec(bPath) ? "" : "not executable — run: chmod +x build.sh" };
  sections.push({ name: "build (§3)", checks: [bcheck] });

  const dPath = path.join(dir, "Dockerfile");
  const dockExists = fs.existsSync(dPath);
  const dockText = dockExists ? readSafe(dPath) : "";
  if (dockExists) sections.push({ name: "Dockerfile (§5/§14 — recommended)", checks: scanDockerfile(dockText, manifest.port) });
  else sections.push({ name: "Dockerfile (§5/§14 — recommended)", checks: [{ label: "Dockerfile at repo root", status: "warn", detail: "none found" }] });

  sections.push({ name: "web assets (§3 — relative URLs)", checks: checkRelativeUrls(dir) });

  // evolution 08: contract-as-code rules (L2 services-match + L6 §11/§14/§16).
  sections.push({
    name: "contract rules (§11/§14/§16 — evolution 08)",
    checks: [
      ...checkServicesMatch(dir, manText),
      ...checkSyncNotBatch(dir, manText),
      ...checkNoBase64Blob(dir),
      ...checkPromptsAsFiles(dir),
    ],
  });

  // advisory: did the build wire the operator's Tools-tab requests? (only when a spec exists)
  const tomlText = readSafe(path.join(dir, ".gaws-hub", "agent.toml"));
  if (tomlText.trim()) {
    sections.push({ name: "requested capabilities (tools tab — advisory)", checks: checkRequested(parseRequested(tomlText), manText, dockText) });
  }
  return { mode: "repo", target: dir, sections };
}

// ── image mode (docker inspect + optional live probe) ─────────────────────────

const hasDocker = () => { try { execFileSync("docker", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } };

function dockerInspect(ref) {
  try {
    const out = execFileSync("docker", ["inspect", ref], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const arr = JSON.parse(out);
    return Array.isArray(arr) && arr[0] ? arr[0] : null;
  } catch { return null; }
}

async function checkImage(ref, opts) {
  if (!hasDocker()) return { mode: "image", target: ref, precondition: "docker CLI not found on PATH — required for image checks" };
  const info = dockerInspect(ref);
  if (!info) return { mode: "image", target: ref, precondition: `image not found locally: ${ref}\n  build it (./build.sh) or pull it (docker pull ${ref}) first.` };

  const sections = [];
  let manifest = {};
  const labels = (info.Config && info.Config.Labels) || {};
  const b64 = labels["org.gaws.agent.manifest"];
  if (!b64) {
    sections.push({ name: "image manifest label (§5)", checks: [{ label: "org.gaws.agent.manifest label present", status: "warn", detail: "absent — image won't self-register" }] });
  } else {
    let decoded = "";
    try { decoded = Buffer.from(b64, "base64").toString("utf8"); } catch {}
    if (!decoded.trim()) {
      sections.push({ name: "image manifest label (§5)", checks: [{ label: "manifest label base64-decodes", status: "fail", detail: "present but could not decode" }] });
    } else {
      manifest = parseManifest(decoded);
      sections.push({ name: "image manifest label (§4/§5)", checks: [{ label: "org.gaws.agent.manifest present + decodes", status: "pass", detail: "" }, ...validateManifest(manifest)] });
    }
  }

  const hc = info.Config && info.Config.Healthcheck;
  const exposed = Object.keys((info.Config && info.Config.ExposedPorts) || {});
  const meta = [{ label: "image has a HEALTHCHECK", status: hc && hc.Test && hc.Test.length ? "pass" : "warn", detail: hc && hc.Test ? "" : "no HEALTHCHECK" }];
  if (manifest.port) {
    const portOk = exposed.some((p) => p.split("/")[0] === String(manifest.port));
    meta.push({ label: `manifest port ${manifest.port} in ExposedPorts`, status: portOk ? "pass" : "warn", detail: exposed.join(", ") || "none exposed" });
  }
  sections.push({ name: "image metadata (§14)", checks: meta });

  if (opts.run) sections.push(...(await liveProbe(ref, manifest, opts)));
  return { mode: "image", target: ref, sections };
}

// ── live probe (--run): launch, poll, hit the endpoints, always tear down ─────

const PROBE_LABEL = "gaws.compliance.probe=1";
const _live = new Set();
let _hooked = false;
function cleanupAll() { for (const id of _live) { try { execFileSync("docker", ["rm", "-f", id], { stdio: "ignore" }); } catch {} } _live.clear(); }
function hookCleanup() {
  if (_hooked) return;
  _hooked = true;
  process.on("SIGINT", () => { cleanupAll(); process.exit(130); });
  process.on("SIGTERM", () => { cleanupAll(); process.exit(143); });
  process.on("exit", cleanupAll);
}
// In-process cleanup can't run on SIGKILL / OOM / a native crash. Every probe
// container carries PROBE_LABEL, so a later run reaps any orphan left by one that died.
function reapOrphans() {
  try {
    const ids = execFileSync("docker", ["ps", "-aq", "--filter", "label=" + PROBE_LABEL], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\s+/).filter(Boolean);
    for (const id of ids) { try { execFileSync("docker", ["rm", "-f", id], { stdio: "ignore" }); } catch {} }
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(port, p, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: p, timeout: timeoutMs || 3000 }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, error: "timeout" }); });
    req.on("error", (e) => resolve({ status: 0, error: e.code || e.message }));
  });
}

function mappedPort(cid, port) {
  try {
    const out = execFileSync("docker", ["port", cid, `${port}/tcp`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const line = out.split(/\r?\n/).find(Boolean) || "";
    const m = line.match(/:(\d+)\s*$/);
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}

async function liveProbe(ref, manifest, opts) {
  reapOrphans(); // sweep any probe container a previously-killed run left behind
  const port = manifest.port && /^\d+$/.test(String(manifest.port)) ? String(manifest.port) : "3000";
  const args = ["run", "-d", "--label", PROBE_LABEL, "-p", `127.0.0.1:0:${port}`];
  for (const e of opts.env || []) args.push("-e", e);
  args.push(ref);

  let cid;
  try { cid = execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch (e) { return [{ name: "live probe (§3)", checks: [{ label: "docker run", status: "fail", detail: String(e.stderr || e.message || "").trim().slice(0, 300) }] }]; }
  _live.add(cid);

  try {
    const hostPort = mappedPort(cid, port);
    if (!hostPort) return [{ name: "live probe (§3)", checks: [{ label: "published host port", status: "fail", detail: `could not resolve a host port for container port ${port}` }] }];

    const deadline = Date.now() + (opts.timeout || 30) * 1000; // CLI runtime — Date.now is fine here
    let reachable = false, lastErr = "connection refused";
    while (Date.now() < deadline) {
      const r = await httpGet(hostPort, "/healthz", 2000);
      if (r.status > 0) { reachable = true; break; }
      lastErr = r.error || lastErr;
      const r2 = await httpGet(hostPort, "/", 2000);
      if (r2.status > 0) { reachable = true; break; }
      await sleep(500);
    }

    const checks = [];
    if (!reachable) {
      let logs = "";
      try { logs = execFileSync("docker", ["logs", "--tail", "6", cid], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().slice(0, 400); } catch {}
      checks.push({
        label: `reachable on published port within ${opts.timeout || 30}s`,
        status: "fail",
        detail: `never responded (${lastErr}). The server may not bind 0.0.0.0, or the agent needs inputs/mounts — pass -e KEY=VAL or raise --timeout.${logs ? ` last logs: ${logs.replace(/\s+/g, " ")}` : ""}`,
      });
      return [{ name: "live probe (§3)", checks }];
    }

    // /healthz is "should" (§3) unless the manifest declares health.path — then the
    // agent promised it, so a non-200 is a real FAIL; otherwise it's a WARN.
    const hz = await httpGet(hostPort, "/healthz", 3000);
    const declaredHealth = !!manifest.healthPath;
    checks.push({
      label: "GET /healthz → 200",
      status: hz.status === 200 ? "pass" : declaredHealth ? "fail" : "warn",
      detail: hz.status === 200 ? "" : `status ${hz.status}${declaredHealth ? " (manifest declares health.path)" : " (recommended; no health.path declared)"}`,
    });

    const m = await httpGet(hostPort, "/meta", 3000);
    let metaOk = false, metaDetail = `status ${m.status}`;
    if (m.status === 200) {
      try { const j = JSON.parse(m.body); metaOk = ["id", "kind", "version", "capabilities"].every((k) => k in j); metaDetail = metaOk ? "" : "missing field(s)"; }
      catch { metaDetail = "not JSON"; }
    }
    checks.push({ label: "GET /meta → {id,kind,version,capabilities}", status: metaOk ? "pass" : "warn", detail: metaDetail });

    const home = await httpGet(hostPort, "/", 3000);
    if (home.status >= 200 && home.status < 400) {
      const refs = findAbsoluteAssetRefs(home.body || "");
      checks.push({ label: "GET / reachable with relative asset refs", status: refs.length ? "warn" : "pass", detail: refs.length ? `${refs.length} absolute ref(s)` : `status ${home.status}` });
    } else {
      checks.push({ label: "GET / reachable", status: "warn", detail: `status ${home.status}` });
    }

    checks.push({ label: "bound 0.0.0.0 (reachable via published port)", status: "pass", detail: `127.0.0.1:${hostPort}` });
    return [{ name: "live probe (§3)", checks }];
  } finally {
    try { execFileSync("docker", ["rm", "-f", cid], { stdio: "ignore" }); } catch {}
    _live.delete(cid);
  }
}

// ── reporting ─────────────────────────────────────────────────────────────────

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (s, c) => (COLOR ? `\x1b[${c}m${s}\x1b[0m` : s);
const SYM = { pass: ["✓", "32"], warn: ["⚠", "33"], fail: ["✗", "31"], skip: ["·", "90"] };

function printReport(result, opts) {
  const all = [];
  const collect = () => { for (const sec of result.sections || []) for (const c of sec.checks) all.push(c); };

  if (opts.json) {
    collect();
    const summary = { pass: 0, warn: 0, fail: 0, skip: 0 };
    all.forEach((c) => (summary[c.status] = (summary[c.status] || 0) + 1));
    process.stdout.write(JSON.stringify({ mode: result.mode, target: result.target, ok: summary.fail === 0, summary, sections: result.sections || [] }, null, 2) + "\n");
    return decideExit(all);
  }

  if (!opts.quiet) {
    console.log(`gaws-hub compliance — ${result.mode}: ${result.target}\n`);
    for (const sec of result.sections || []) {
      console.log(paint(sec.name, "1"));
      for (const c of sec.checks) {
        all.push(c);
        const [sym, col] = SYM[c.status] || ["?", "0"];
        console.log(`  ${paint(sym, col)} ${c.label}${c.detail ? paint("  — " + c.detail, "90") : ""}`);
      }
      console.log("");
    }
  } else {
    collect();
  }

  const summary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  all.forEach((c) => (summary[c.status] = (summary[c.status] || 0) + 1));
  const code = decideExit(all);
  const verdict = code === 0 ? paint("PASS — compliant", "32") : paint(`FAIL — ${summary.fail} problem(s)`, "31");
  console.log(`${verdict}  (${summary.pass} ok, ${summary.warn} warn, ${summary.fail} fail)`);
  return code;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = { forced: null, target: null, positional: null, run: false, timeout: 30, env: [], json: false, quiet: false, help: false, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // consume the next token as this option's value — but refuse a following flag
    // (e.g. `--repo --json`), which means the value was omitted.
    const val = (name) => {
      const nx = argv[i + 1];
      if (nx == null || (nx.length > 1 && nx[0] === "-")) { o.error = o.error || `${name} needs a value`; return null; }
      return argv[++i];
    };
    if (a === "-h" || a === "--help") o.help = true;
    else if (a === "--run") o.run = true;
    else if (a === "--json") o.json = true;
    else if (a === "-q" || a === "--quiet") o.quiet = true;
    else if (a === "--repo") { const v = val("--repo"); if (v != null) { o.forced = "repo"; o.target = v; } }
    else if (a === "--image") { const v = val("--image"); if (v != null) { o.forced = "image"; o.target = v; } }
    else if (a === "--timeout") { const v = val("--timeout"); if (v != null) { if (/^\d+$/.test(v.trim())) o.timeout = Math.max(1, parseInt(v, 10)); else o.error = o.error || `--timeout needs a number, got "${v}"`; } }
    else if (a === "-e" || a === "--env") { const v = val(a); if (v != null) o.env.push(v); }
    else if (!a.startsWith("-") && o.positional == null) o.positional = a;
  }
  return o;
}

function printUsage() {
  console.log(`compliance — check gaws-hub agent compliance (agents-interface.md)

Usage:
  compliance [PATH]            repo (static) check; PATH defaults to "."
  compliance IMAGE_REF         image check (docker inspect: label / health / ports)
  compliance --run IMAGE_REF   image check + live probe (run, hit endpoints, rm)

Mode auto-detects: an existing directory (or no arg) → repo; otherwise the arg is
treated as an image reference.

Options:
  --repo PATH        force repo mode
  --image REF        force image mode
  --run              with an image, launch it and probe /healthz, /meta, /
  --timeout SECS     seconds to wait for the container to respond (default 30)
  -e KEY=VAL         env var for the probed container (repeatable)
  --json             machine-readable output
  -q, --quiet        only print the final verdict line
  -h, --help         this help

Severity: FAIL = spec MUST/REQUIRED or hub-rejected; WARN = SHOULD/recommended.
Exit: 0 compliant · 1 a FAIL · 2 usage/precondition error.`);
}

async function main(argv) {
  const o = parseArgs(argv);
  if (o.help) { printUsage(); return 0; }
  if (o.error) { process.stderr.write("compliance: " + o.error + "\n"); return 2; }

  let mode = o.forced, target = o.target;
  if (!mode) {
    if (o.positional == null) { mode = "repo"; target = "."; }
    else if (isDir(o.positional)) { mode = "repo"; target = o.positional; }
    else { mode = "image"; target = o.positional; }
  }
  if (mode === "repo" && target == null) target = ".";
  if (mode === "image" && !target) { process.stderr.write("compliance: --image needs an image reference\n"); return 2; }
  if (mode === "repo" && o.run) process.stderr.write("compliance: --run only applies to image checks; ignoring it.\n");

  let result;
  if (mode === "repo") result = checkRepo(target);
  else { if (o.run) hookCleanup(); result = await checkImage(target, { run: o.run, timeout: o.timeout, env: o.env }); }

  if (result.precondition) { process.stderr.write("compliance: " + result.precondition + "\n"); return 2; }
  return printReport(result, { json: o.json, quiet: o.quiet });
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => { console.error("compliance: " + ((e && e.stack) || e)); process.exit(2); });
}
