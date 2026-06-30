// agent-ui.js — the reusable engine behind the gaws-hub 3-column workbench UI,
// served by the SDK at /_gaws/agent-ui.js. An agent UI imports it relatively (it
// shares the agent's origin under /a/<id>/) and supplies only its own layout +
// service cards + button glue:
//
//   import { createRunBars, createAskPanel, openSSE, jobDedup, persistFields, markdown }
//     from "./_gaws/agent-ui.js";
//
// Pairs with /_gaws/agent-ui.css for the status-bar/modal/markdown styles.

// ── number/time formatting for the status bars ──────────────────────────────────
export const kfmt = (n) => { n = +n || 0; return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n); };
export const clock = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = String(s % 60).padStart(2, "0"); return h ? `${h}h ${m}m ${sec}s` : m ? `${m}m ${sec}s` : `${s}s`; };

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
    const cost = s.costUsd != null ? s.costUsd : s.cost; // accept either field name (provider drift)
    b.head.textContent = `${glyph} claude · ${s.model || "?"}  ·  ${jobId.slice(0, 10)}  ·  ${clock(secs)}` + (cost != null ? `  ·  $${Number(cost).toFixed(4)}` : "");
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

// ── "Ask" slide-in chat panel: a right-edge drawer for a resumable claude -p Q&A ──
// The drawer + open/close/width/new-chat + the streaming render all live here; the
// consumer supplies only a trigger button and an endpoint. The endpoint must stream the
// run's `<<<STATUS>>>{...}` frames (one JSON object per line → the live banner) and end
// with one `<<<ASKRESULT>>>{answer|error, sessionId}` line. The server owns the session:
// the first turn mints the id, later turns echo it back so it --resumes the same chat.
// opts:
//   endpoint   POST url for one turn (default "api/ask/stream", resolved against the page)
//   title      header title (default "Ask") · subtitle() header right-hand label, re-read
//              on open / syncSubtitle() (e.g. the loaded repo)
//   body(q,id) request body for a turn (default {question, sessionId:id})
//   emptyHTML  empty-state hint · placeholder  textarea placeholder
//   base(p)    url resolver (default: relative to location.href, proxy-safe under /a/<id>/)
//   widthKey   localStorage key for the persisted width (default "gaws-ask-width")
//   id         optional element id for the <aside> (handy for tests)
// Returns { open, close, newChat, syncSubtitle, el }.
export function createAskPanel(opts = {}) {
  const STATUS = "<<<STATUS>>>", ASKRESULT = "<<<ASKRESULT>>>";
  const WIDTHS = { full: "100vw", "2/3": "66.6667vw", half: "50vw", "1/3": "33.3333vw" };
  const base = opts.base || ((p) => { const h = location.href.endsWith("/") ? location.href : location.href + "/"; return new URL(p, h).toString(); });
  const endpoint = opts.endpoint || "api/ask/stream";
  const subtitle = opts.subtitle || (() => "");
  const buildBody = opts.body || ((question, sessionId) => ({ question, sessionId }));
  const emptyHTML = opts.emptyHTML || "Ask anything. The conversation continues until you press “New Chat”.";
  const widthKey = opts.widthKey || "gaws-ask-width";

  const panel = document.createElement("aside");
  panel.className = "gaws-ask"; if (opts.id) panel.id = opts.id;
  panel.setAttribute("aria-hidden", "true"); panel.setAttribute("aria-label", opts.title || "Ask");
  panel.innerHTML = `<div class="gaws-ask-head">`
    + `<span class="gaws-ask-title">${mdEsc(opts.title || "Ask")} · <span class="gaws-ask-sub"></span></span>`
    + `<button type="button" class="gaws-ask-new" title="New chat — start a fresh conversation">＋ New</button>`
    + `<select class="gaws-ask-width" title="panel width"><option value="1/3">⅓</option><option value="half">½</option><option value="2/3">⅔</option><option value="full">⛶</option></select>`
    + `<button type="button" class="gaws-ask-x" title="close" aria-label="close">✕</button></div>`
    + `<div class="gaws-ask-msgs"></div>`
    + `<form class="gaws-ask-form"><textarea rows="2" autocomplete="off"></textarea><button type="submit" class="gaws-ask-send">Send</button></form>`;
  document.body.appendChild(panel);

  const sub = panel.querySelector(".gaws-ask-sub"), msgs = panel.querySelector(".gaws-ask-msgs");
  const form = panel.querySelector(".gaws-ask-form"), input = panel.querySelector("textarea");
  const send = panel.querySelector(".gaws-ask-send"), widthSel = panel.querySelector(".gaws-ask-width");
  input.placeholder = opts.placeholder || "Ask anything… (Enter to send)";
  let sessionId = null, busy = false;

  const applyWidth = (key) => { if (!WIDTHS[key]) key = "1/3"; widthSel.value = key; panel.style.setProperty("--gaws-ask-w", WIDTHS[key]); };
  applyWidth(localStorage.getItem(widthKey) || "1/3");
  widthSel.onchange = () => { applyWidth(widthSel.value); try { localStorage.setItem(widthKey, widthSel.value); } catch {} };

  const syncSubtitle = () => { sub.textContent = subtitle() || ""; };
  const emptyState = () => { msgs.innerHTML = `<div class="gaws-ask-empty">${emptyHTML}</div>`; };
  const bubble = (cls, isHTML, content) => { const d = document.createElement("div"); d.className = "gaws-ask-msg " + cls; if (isHTML) d.innerHTML = content; else d.textContent = content; msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; return d; };

  // live status banner driven by the run's <<<STATUS>>> frames: a spinner + current
  // activity, plus tool-call / token / turn / elapsed tallies.
  function statusParts(s) {
    s = s || {};
    const act = mdEsc((s.activity && String(s.activity).trim()) || (s.tool ? String(s.tool) : "working…"));
    const tools = Number(s.toolCalls || 0), turns = Number(s.turns || 0), tin = Number(s.tokensIn || 0), tout = Number(s.tokensOut || 0);
    const chips = [`<span class="chip">🔧 <b>${tools}</b> tool${tools === 1 ? "" : "s"}</span>`, `<span class="chip">↑${kfmt(tin)} ↓${kfmt(tout)} <b>tok</b></span>`];
    if (turns) chips.push(`<span class="chip">${turns} turn${turns === 1 ? "" : "s"}</span>`);
    if (s.elapsedMs != null) chips.push(`<span class="chip">${mdEsc(clock(s.elapsedMs / 1000))}</span>`);
    return { act, chips: chips.join("") };
  }
  function statusHTML(s) {
    const { act, chips } = statusParts(s);
    return `<div class="gaws-ask-stat"><div class="row"><span class="spin"></span><span class="act">${act}</span></div><div class="mtr">${chips}</div></div>`;
  }
  // update text/chips in place; never touch .spin so its CSS animation runs uninterrupted
  function paintStatus(el, s) {
    const a = el.querySelector(".gaws-ask-stat .act"), m = el.querySelector(".gaws-ask-stat .mtr");
    if (!a || !m) { el.innerHTML = statusHTML(s); return; }
    const p = statusParts(s); a.innerHTML = p.act; m.innerHTML = p.chips;
  }

  function open() { syncSubtitle(); if (!msgs.children.length) emptyState(); panel.classList.add("open"); panel.setAttribute("aria-hidden", "false"); setTimeout(() => input.focus(), 230); }
  function close() { panel.classList.remove("open"); panel.setAttribute("aria-hidden", "true"); }
  function newChat() { sessionId = null; emptyState(); syncSubtitle(); input.value = ""; input.focus(); }

  panel.querySelector(".gaws-ask-new").onclick = newChat;
  panel.querySelector(".gaws-ask-x").onclick = close;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && panel.classList.contains("open")) close(); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const q = input.value.trim(); if (!q) return;
    if (msgs.querySelector(".gaws-ask-empty")) msgs.innerHTML = "";       // drop the hint on first message
    bubble("user", false, q);
    input.value = ""; busy = true; send.disabled = true;
    const pending = bubble("bot pending working", true, statusHTML({ activity: "starting Claude…" }));
    const fail = (m) => { pending.className = "gaws-ask-msg bot err"; pending.textContent = "⚠ " + m; };
    let answered = false;
    try {
      const res = await fetch(base(endpoint), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(buildBody(q, sessionId)) });
      if (!res.ok || !res.body) { const txt = await res.text().catch(() => ""); fail(txt || ("request failed (" + res.status + ")")); }
      else {
        const rd = res.body.getReader(), dec = new TextDecoder();
        let sbuf = "", result = null;
        const take = (line) => {
          if (line.startsWith(STATUS)) { try { paintStatus(pending, JSON.parse(line.slice(STATUS.length))); msgs.scrollTop = msgs.scrollHeight; } catch {} }
          else if (line.startsWith(ASKRESULT)) { try { result = JSON.parse(line.slice(ASKRESULT.length)); } catch {} }
        };
        for (;;) { const { value, done } = await rd.read(); if (done) break; sbuf += dec.decode(value, { stream: true }); let nl; while ((nl = sbuf.indexOf("\n")) >= 0) { take(sbuf.slice(0, nl)); sbuf = sbuf.slice(nl + 1); } }
        if (sbuf) take(sbuf);                                              // flush a final unterminated line
        if (result && result.answer) { sessionId = result.sessionId || sessionId; pending.className = "gaws-ask-msg bot"; pending.innerHTML = markdown(result.answer); answered = true; }
        else fail((result && result.error) || "no answer was produced");
      }
    } catch (err) { fail(err.message || String(err)); }
    finally {
      busy = false; send.disabled = false; input.focus();
      // align the answer's top to the top of the scroll area so a long reply reads from
      // its start (no manual scroll-up); while waiting/erroring, keep the latest line in view.
      if (answered) pending.scrollIntoView({ block: "start" }); else msgs.scrollTop = msgs.scrollHeight;
    }
  };

  return { open, close, newChat, syncSubtitle, el: panel };
}
