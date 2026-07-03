#!/usr/bin/env node
// hub — drive *sibling* gaws-hub agents through the hub's brokered HTTP plane.
//
// Every instance sits on its own private network whose only other member is the
// hub (alias `hub`). From inside a container the hub's whole HTTP surface is at
// http://hub:3000: the service plane (`/api/v1/services`, `/api/v1/jobs`), the
// instance lifecycle (`/api/instances`), and the reverse proxy `/a/<id>/…`.
//
// The headline is SERVICE addressing: call another agent by the service NAME it
// advertises (a role), never by instance id — the hub routes to a free provider
// and COLD-STARTS one if none is running. Use `services`/`invoke`/`job`.
//
// ponytail: the exact endpoints live here, in one place — the calibration knob.
// Tune a path/field here, never re-derive it per session.

const http = require("http");
const HUB = process.env.HUB_URL || "http://hub:3000";
const TOKEN = process.env.BUS_TOKEN || ""; // identifies this agent as the job owner

// A reader that closes early (e.g. `hub job … | head`) is normal for a stream;
// exit cleanly instead of crashing with an EPIPE stack trace.
process.stdout.on("error", (e) => { if (e.code === "EPIPE") process.exit(0); throw e; });

function request(method, path, body, onRes, extraHeaders) {
  const u = new URL(HUB + path);
  const data = body == null ? null : typeof body === "string" ? body : JSON.stringify(body);
  const headers = Object.assign(
    data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {},
    TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
    extraHeaders || {});
  const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, onRes);
  r.on("error", (e) => { console.error("hub: " + e.message); process.exit(1); });
  if (data) r.write(data);
  r.end();
  return r;
}
const exit = (res) => process.exit(res.statusCode < 400 ? 0 : 1);
const collect = (res, cb) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => cb(b)); };
// Split positional args from a `--provider <type>` (alias `--from`) flag: pins the call
// to a specific provider TYPE, which the hub serves or fails loudly (never silently
// routes elsewhere). Positionals keep their order.
function parseArgs(argv) {
  const pos = []; let provider = null;
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === "--provider" || argv[i] === "--from") && argv[i + 1] != null) provider = argv[++i];
    else pos.push(argv[i]);
  }
  return { pos, provider };
}
const provQuery = (p) => (p ? `?provider=${encodeURIComponent(p)}` : "");
const stream = (res) => { res.pipe(process.stdout); res.on("end", () => exit(res)); };
const getJSON = (path) => new Promise((ok) => request("GET", path, null, (r) => collect(r, (b) => { try { ok(JSON.parse(b)); } catch { ok(null); } })));
const instances = () => getJSON("/api/instances");

// Submit a job, stream its SSE progress to stderr, print the final result to stdout.
// Output is an envelope carrying `servedBy` (the provider that ACTUALLY ran the job —
// its instance id + type) so the caller reports real provenance, never an assumption.
function runJob(name, body, provider) {
  request("POST", `/api/v1/services/${encodeURIComponent(name)}/jobs${provQuery(provider)}`, body || "{}", (r) => collect(r, (b) => {
    let job; try { job = JSON.parse(b); } catch { console.error("hub: bad job response: " + b); process.exit(1); }
    if (r.statusCode >= 400 || !job.id) { console.error("hub: job submit failed: " + b); process.exit(1); }
    console.error(`hub: job ${job.id} (${name}) ${job.state}`);
    request("GET", `/api/v1/jobs/${job.id}/events`, null, (ev) => {
      ev.setEncoding("utf8");
      let buf = "";
      ev.on("data", (chunk) => {
        buf += chunk; let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (line) process.stderr.write("  " + line.slice(5).trim() + "\n");
        }
      });
      ev.on("end", async () => {
        const done = await getJSON(`/api/v1/jobs/${job.id}`);
        const servedBy = { instance: done?.worker_id || null, type: done?.worker_type || null, service: name };
        process.stdout.write(JSON.stringify({ servedBy, result: done ? done.result : null }) + "\n");
        process.exit(done && done.state === "succeeded" ? 0 : 1);
      });
    });
  }));
}

const [cmd, ...a] = process.argv.slice(2);
(async () => {
  switch (cmd) {
    // --- service plane (the contract: address by NAME, hub routes + cold-starts) ---
    case "services": { // list advertised services (optionally one name)
      const list = (await getJSON("/api/v1/services")) || [];
      for (const s of list) {
        if (a[0] && s.name !== a[0]) continue;
        const prov = s.providers.map((p) => `${p.type}[${p.instances.length} run${p.canColdStart ? ",cold" : ""}]`).join(",");
        console.log(`${s.name}@${s.version}\t${s.kind}\tavailable=${s.available}\t${prov}`);
      }
      break;
    }
    case "invoke": { // hub invoke <name> [json] [--provider <type>] -> call a sync service
      // Output is an envelope: { servedBy:{instance,type,service}, response } — report
      // the ACTUAL provider from `servedBy`, never the service name you asked for.
      const { pos, provider } = parseArgs(a);
      request("POST", `/api/v1/services/${encodeURIComponent(pos[0])}/invoke${provQuery(provider)}`, pos[1] || "{}",
        (r) => collect(r, (b) => {
          let body; try { body = JSON.parse(b); } catch { body = b; }
          const servedBy = { instance: r.headers["x-gaws-served-by"] || null, type: r.headers["x-gaws-served-by-type"] || null, service: pos[0] };
          process.stdout.write(JSON.stringify({ servedBy, response: body }) + "\n");
          exit(r);
        }));
      break;
    }
    case "job": { // hub job <name> [json] [--provider <type>] -> run a job, stream progress
      const { pos, provider } = parseArgs(a);
      runJob(pos[0], pos[1], provider);
      break;
    }
    case "describe": // hub describe <name> -> the service contract (kind, request/result schema)
      request("GET", `/api/v1/services/${encodeURIComponent(a[0])}`, null,
        (r) => collect(r, (b) => { try { process.stdout.write(JSON.stringify(JSON.parse(b), null, 2) + "\n"); } catch { process.stdout.write(b + "\n"); } exit(r); }));
      break;
    case "job-status": // hub job-status <id>
      request("GET", `/api/v1/jobs/${a[0]}`, null, stream);
      break;
    case "job-result": // hub job-result <id>
      request("GET", `/api/v1/jobs/${a[0]}/result`, null, stream);
      break;
    case "job-cancel": // hub job-cancel <id>
      request("POST", `/api/v1/jobs/${a[0]}/cancel`, "{}", stream);
      break;

    // --- instance lifecycle + raw proxy ---
    case "agents":
      for (const i of (await instances()) || []) console.log(`${i.id}\t${i.type}\t${i.status}\tport=${i.port}`);
      break;
    case "find": {
      const m = ((await instances()) || []).filter((i) => i.type === a[0] && i.status === "running");
      if (!m.length) { console.error(`hub: no running instance of type ${a[0]}`); process.exit(1); }
      console.log(m[0].id);
      break;
    }
    case "launch":
      request("POST", "/api/instances", { type: a[0], inputs: a[1] ? JSON.parse(a[1]) : {} },
        (r) => collect(r, (b) => { process.stdout.write(b + "\n"); exit(r); }));
      break;
    case "rm":
      request("DELETE", `/api/instances/${a[0]}`, null, (r) => { console.log(`rm ${a[0]} -> HTTP ${r.statusCode}`); exit(r); });
      break;
    case "call": // hub call <id> <METHOD> <path> [json] -> proxied to a specific instance
      request((a[1] || "GET").toUpperCase(), `/a/${a[0]}${a[2]}`, a[3], stream);
      break;

    // --- build shortcut: agent-builder's `build` is a job service ---
    case "build": { // hub build [json] [--provider <type>] -> run a build via the build service
      const { pos, provider } = parseArgs(a);
      runJob("build", pos[0], provider);
      break;
    }

    default:
      console.error(
        "usage:\n" +
        "  service plane (address by name; hub routes + cold-starts):\n" +
        "    hub services [name]            # list advertised services + availability\n" +
        "    hub describe <name>            # the service contract (request/result schema)\n" +
        "    hub invoke <name> [json] [--provider <type>]   # SYNC call; prints {servedBy,response}\n" +
        "    hub job <name> [json] [--provider <type>]      # JOB: progress (stderr) + {servedBy,result}\n" +
        "    hub job-status|job-result|job-cancel <id>\n" +
        "    # --provider pins the provider TYPE (fails loud if it can't serve); servedBy = who ACTUALLY served\n" +
        "    hub build [json]               # shortcut for: hub job build <json>\n" +
        "  instances + raw proxy:\n" +
        "    hub agents | find <type> | launch <type> [json] | rm <id>\n" +
        "    hub call <id> <METHOD> <path> [json]\n");
      process.exit(2);
  }
})();
