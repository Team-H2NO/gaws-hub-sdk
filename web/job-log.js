// <job-log> — a zero-dependency custom element that streams a gaws-hub JOB's
// progress (the hub's SSE at /api/v1/jobs/<id>/events) into a live log, with
// Last-Event-ID reconnect. Drop it into any agent's page; set the `job` attribute
// (or call .watch(jobId)) and it renders progress/log lines until the terminal event.
//
// IMPORTANT (proxy origin): an agent UI is served THROUGH the hub at /a/<id>/, so it
// shares the hub's ORIGIN. To reach the hub's job API, use an ORIGIN-ROOT path
// (/api/v1/...), NOT a relative one (a relative ./api/... would be proxied back into
// your own agent). This component uses /api/v1/... for exactly that reason.
//
// Usage:
//   <script type="module" src="./job-log.js"></script>
//   <job-log id="log"></job-log>
//   document.getElementById('log').watch(jobId, { onDone: j => ... });

class JobLog extends HTMLElement {
  static get observedAttributes() { return ["job"]; }

  connectedCallback() {
    if (!this._root) {
      this.attachShadow({ mode: "open" });
      this.shadowRoot.innerHTML = `
        <style>
          :host { display:block; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
          .wrap { background:#0b0f12; color:#cfe; border-radius:8px; padding:.6rem .8rem; overflow:auto; max-height:100%; }
          .row { white-space:pre-wrap; word-break:break-word; }
          .progress { color:#9fe1ff; }
          .log { color:#a6b3bd; }
          .state { color:#ffd479; }
          .done-ok { color:#7CFC8A; font-weight:600; }
          .done-bad { color:#ff7b72; font-weight:600; }
          .meta { color:#6b7b86; }
        </style>
        <div class="wrap" part="wrap"><div class="rows"></div></div>`;
      this._rows = this.shadowRoot.querySelector(".rows");
      this._wrap = this.shadowRoot.querySelector(".wrap");
      this._root = true;
    }
    const j = this.getAttribute("job");
    if (j) this.watch(j);
  }

  attributeChangedCallback(name, _old, val) {
    if (name === "job" && val && this._root) this.watch(val);
  }

  disconnectedCallback() { this._abort?.abort(); }

  /** Stream a job's events. opts: { onEvent, onDone }. */
  watch(jobId, opts = {}) {
    this._abort?.abort();
    const ac = new AbortController();
    this._abort = ac;
    this._jobId = jobId;
    this._opts = opts;
    this._lastId = 0;
    this._append("state", `▶ watching job ${jobId}`);
    this._stream(jobId, ac.signal);
  }

  async _stream(jobId, signal) {
    try {
      const headers = this._lastId ? { "last-event-id": String(this._lastId) } : {};
      const r = await fetch(`/api/v1/jobs/${encodeURIComponent(jobId)}/events`, { headers, signal });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let sep;
        while ((sep = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const ev = this._parse(frame);
          if (!ev) continue;
          if (ev.id) this._lastId = ev.id;
          this._render(ev);
          this._opts.onEvent?.(ev);
          if (ev.kind === "done") { this._opts.onDone?.(ev); return; }
        }
      }
      // stream ended without a terminal event (hub/conn drop) → reconnect with Last-Event-ID
      if (!signal.aborted) setTimeout(() => this._stream(jobId, signal), 1000);
    } catch (e) {
      if (!signal.aborted) { this._append("log", `… reconnecting (${e.message})`); setTimeout(() => this._stream(jobId, signal), 1500); }
    }
  }

  _parse(frame) {
    let id = 0, data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("id:")) id = parseInt(line.slice(3).trim(), 10) || 0;
      else if (line.startsWith("data:")) data += line.slice(5).trimStart();
    }
    if (!data) return null;
    try { const ev = JSON.parse(data); ev.id = ev.id || id; return ev; } catch { return null; }
  }

  _render(ev) {
    if (ev.kind === "progress") {
      const d = ev.data && typeof ev.data === "object" ? ev.data : null;
      const tail = d ? Object.entries(d).filter(([, v]) => v != null && typeof v !== "object").slice(0, 4).map(([k, v]) => `${k}=${v}`).join(" ") : "";
      this._append("progress", `• ${ev.message || ""}${tail ? "  " : ""}${tail}`);
    } else if (ev.kind === "log") {
      this._append("log", ev.message || "");
    } else if (ev.kind === "state") {
      this._append("state", `— ${ev.message || ""}`);
    } else if (ev.kind === "done") {
      const ok = !(ev.data && ev.data.error);
      this._append(ok ? "done-ok" : "done-bad", ok ? `✓ done (${ev.message || "succeeded"})` : `✗ ${ev.message || "failed"}: ${ev.data?.error?.message || ""}`);
    }
  }

  _append(cls, text) {
    const div = document.createElement("div");
    div.className = "row " + cls;
    div.textContent = text;
    this._rows.appendChild(div);
    this._wrap.scrollTop = this._wrap.scrollHeight;
  }
}

customElements.define("job-log", JobLog);
export { JobLog };
