// agent-ui.js — the reusable engine behind the gaws-hub 3-column workbench UI,
// served by the SDK at /_gaws/agent-ui.js. An agent UI imports it relatively (it
// shares the agent's origin under /a/<id>/) and supplies only its own layout +
// service cards + button glue:
//
//   import { createRunBars, openSSE, jobDedup, persistFields, markdown }
//     from "./_gaws/agent-ui.js";
//
// Pairs with /_gaws/agent-ui.css for the status-bar/modal/markdown styles.

// ── number/time formatting for the status bars ──────────────────────────────────
export const kfmt = (n) => { n = +n || 0; return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n); };
export const clock = (s) => { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60); return m ? `${m}m${String(s % 60).padStart(2, "0")}s` : `${s}s`; };

// ── minimal markdown → HTML (escaped first; only http(s) links) ─────────────────
function mdEsc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function mdInline(s) {
  s = s.replace(/`([^`]+)`/g, (m, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, u) => /^https?:\/\//i.test(u) ? `<a href="${u}" target="_blank" rel="noopener">${t}</a>` : t);
  return s;
}
export function markdown(src) {
  const L = mdEsc(src || "").split("\n"); let html = "", i = 0;
  const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  while (i < L.length) {
    const line = L[i];
    if (/^```/.test(line)) { const buf = []; i++; while (i < L.length && !/^```/.test(L[i])) { buf.push(L[i]); i++; } i++; html += `<pre class="md-code">${buf.join("\n")}</pre>`; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/); if (h) { const n = h[1].length; html += `<h${n}>${mdInline(h[2])}</h${n}>`; i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < L.length && /-/.test(L[i + 1]) && /^\s*\|?[\s:|-]+\|?\s*$/.test(L[i + 1])) {
      const head = cells(line); i += 2; const rows = [];
      while (i < L.length && /^\s*\|.*\|\s*$/.test(L[i])) { rows.push(cells(L[i])); i++; }
      html += `<table><thead><tr>${head.map((c) => `<th>${mdInline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${mdInline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) { const it = []; while (i < L.length && /^\s*[-*]\s+/.test(L[i])) { it.push(`<li>${mdInline(L[i].replace(/^\s*[-*]\s+/, ""))}</li>`); i++; } html += `<ul>${it.join("")}</ul>`; continue; }
    if (/^\s*\d+\.\s+/.test(line)) { const it = []; while (i < L.length && /^\s*\d+\.\s+/.test(L[i])) { it.push(`<li>${mdInline(L[i].replace(/^\s*\d+\.\s+/, ""))}</li>`); i++; } html += `<ol>${it.join("")}</ol>`; continue; }
    if (/^\s*$/.test(line)) { i++; continue; }
    const para = [line]; i++;
    while (i < L.length && !/^\s*$/.test(L[i]) && !/^(#{1,6}\s|```|\s*[-*]\s|\s*\d+\.\s|\s*\|)/.test(L[i])) { para.push(L[i]); i++; }
    html += `<p>${para.map(mdInline).join("<br>")}</p>`;
  }
  return html;
}

// ── dedupe a job across two SSE streams (consumer + provider/served) ─────────────
// The first stream to render a given job id owns it; the other is suppressed.
export function jobDedup() {
  const owner = new Map();
  return {
    owns(source, jobId) { if (!jobId) return true; const o = owner.get(jobId); if (!o) { owner.set(jobId, source); return true; } return o === source; },
    clear() { owner.clear(); },
  };
}

// ── persist a set of input fields to localStorage (survives an iframe reload) ────
// `get(id)` returns the element; values are keyed by `key` (e.g. per instance id).
export function persistFields(ids, key, get = (id) => document.getElementById(id)) {
  const save = () => localStorage.setItem(key, JSON.stringify(Object.fromEntries(ids.map((f) => [f, get(f).value]))));
  const restore = () => { try { const s = JSON.parse(localStorage.getItem(key) || "{}"); for (const f of ids) if (s[f] != null && s[f] !== "") get(f).value = s[f]; } catch {} };
  ids.forEach((f) => get(f).addEventListener("input", save));
  return { save, restore };
}

// ── open an SSE stream and route named events to callbacks ──────────────────────
// handlers: { log, done, error, ...any-event-name }. EventSource auto-reconnects.
// Returns the EventSource so the caller can .close() it.
export function openSSE(url, handlers = {}) {
  const es = new EventSource(url);
  for (const [name, fn] of Object.entries(handlers)) {
    if (name === "error") continue; // wired below (fires with/without data)
    es.addEventListener(name, (e) => { let d; try { d = JSON.parse(e.data); } catch { d = e.data; } fn(d, e); });
  }
  if (handlers.error) es.addEventListener("error", (e) => { let d = null; if (e.data) { try { d = JSON.parse(e.data); } catch { d = e.data; } } handlers.error(d, e); });
  return es;
}

// ── run-bars + detail modal: one live status bar per claude -p run ──────────────
// Returns a controller; feed it status snapshots + done states. It owns its own
// modal (appended to <body>). opts: { statusbarsEl, onCancel(jobId), confirmCancel }.
export function createRunBars(opts = {}) {
  const statusbars = opts.statusbarsEl || document.getElementById("statusbars");
  const onCancel = opts.onCancel || (() => {});
  const confirmCancel = opts.confirmCancel ?? ((jobId) => confirm("Cancel this run?"));
  const bars = new Map();
  let modalJob = null;

  // build the modal once
  const ov = document.createElement("div"); ov.className = "gaws-modal-ov";
  ov.innerHTML = `<div class="gaws-modal"><div class="gaws-modal-head"><span class="gaws-mtitle">claude</span><button class="gaws-mfull" title="full screen">⛶</button><button class="gaws-mx" title="close">✕</button></div><div class="gaws-modal-body"></div></div>`;
  document.body.appendChild(ov);
  const box = ov.querySelector(".gaws-modal");
  const mtitle = ov.querySelector(".gaws-mtitle");
  const mbody = ov.querySelector(".gaws-modal-body");
  const closeModal = () => { modalJob = null; ov.classList.remove("show"); box.classList.remove("full"); };
  const openModal = (jobId) => { modalJob = jobId; ov.classList.add("show"); renderModal(); };
  ov.querySelector(".gaws-mx").onclick = closeModal;
  ov.querySelector(".gaws-mfull").onclick = () => box.classList.toggle("full");
  ov.onclick = (e) => { if (e.target === ov) closeModal(); };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

  function renderModal() {
    if (!modalJob) return; const b = bars.get(modalJob); const s = b && b.status;
    const running = !s || s.state === "running";
    mtitle.textContent = `claude · ${(s && s.model) || "?"} · ${modalJob.slice(0, 10)} — ${(s && s.state) || "starting"}`;
    if (running) {
      mbody.className = "gaws-modal-body";
      const txt = (b && b.logs && b.logs.length) ? b.logs.join("\n") : "(waiting for output…)";
      mbody.innerHTML = ""; const pre = document.createElement("pre"); pre.textContent = txt; mbody.append(pre);
      mbody.scrollTop = mbody.scrollHeight;
    } else {
      mbody.className = "gaws-modal-body md";
      mbody.innerHTML = markdown((s && s.text) || "(no final message)");
    }
  }

  function getBar(jobId) {
    let b = bars.get(jobId);
    if (!b) {
      const el = document.createElement("div"); el.className = "sbar run"; el.title = "click for details";
      const head = document.createElement("div"); head.className = "sb-head";
      const htext = document.createElement("span"); htext.className = "sb-text";
      const xbtn = document.createElement("button"); xbtn.className = "sb-x"; xbtn.textContent = "✕";
      xbtn.onclick = (e) => { e.stopPropagation(); xClick(jobId); };       // running → cancel (confirm); else dismiss
      head.append(htext, xbtn);
      const line = document.createElement("div"); line.className = "sb-line";
      el.append(head, line); statusbars.append(el);
      el.onclick = () => openModal(jobId);
      b = { el, head: htext, line, xbtn, status: null, recv: 0, logs: [] }; bars.set(jobId, b);
    }
    return b;
  }
  function xClick(jobId) { const b = bars.get(jobId); if (b && b.status && b.status.state === "running") { if (confirmCancel(jobId)) { if (b) b.line.textContent = "cancelling…"; onCancel(jobId); } } else dismissBar(jobId); }
  function dismissBar(jobId) { const b = bars.get(jobId); if (!b) return; b.el.remove(); bars.delete(jobId); if (modalJob === jobId) closeModal(); }
  function paintBar(jobId) {
    const b = bars.get(jobId); if (!b || !b.status) return; const s = b.status;
    const glyph = s.state === "error" ? "✗" : s.state === "done" ? "✓" : "●";
    const live = s.state === "running" && b.recv ? Date.now() - b.recv : 0;
    const secs = ((s.elapsedMs || 0) + live) / 1000;
    b.el.className = "sbar " + (s.state === "running" ? "run" : s.state);
    b.xbtn.title = s.state === "running" ? "cancel run" : "dismiss";
    b.head.textContent = `${glyph} claude · ${s.model || "?"}  ·  ${jobId.slice(0, 10)}  ·  ${clock(secs)}` + (s.costUsd != null ? `  ·  $${Number(s.costUsd).toFixed(4)}` : "");
    const bits = [(s.toolCalls || 0) + " tool" + (s.toolCalls === 1 ? "" : "s")];
    if (s.turns) bits.push(s.turns + " turn" + (s.turns === 1 ? "" : "s"));
    if (s.tokensOut != null) bits.push("↓" + kfmt(s.tokensOut) + " tok");
    b.line.textContent = (s.activity ? s.activity + "   " : "") + bits.join(" · ");
  }

  setInterval(() => { for (const [id, b] of bars) if (b.status && b.status.state === "running") paintBar(id); }, 1000); // smooth the clock

  return {
    updateBar(jobId, status) { if (!jobId || !status) return; const b = getBar(jobId); b.status = status; b.recv = Date.now(); paintBar(jobId); if (modalJob === jobId) renderModal(); },
    finalizeBar(jobId, state) { const b = bars.get(jobId); if (!b || !b.status) return; if (state && b.status.state === "running") b.status.state = state === "succeeded" ? "done" : (state === "failed" || state === "cancelled" || state === "timed_out") ? "error" : b.status.state; paintBar(jobId); if (modalJob === jobId) renderModal(); },
    barLog(jobId, line) { const b = bars.get(jobId); if (!b) return; b.logs.push(line); if (modalJob === jobId) renderModal(); },
    dismissBar,
    has(jobId) { return bars.has(jobId); },
    clear() { bars.clear(); statusbars.innerHTML = ""; closeModal(); },
  };
}
