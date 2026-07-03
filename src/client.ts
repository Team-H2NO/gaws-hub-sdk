// HubClient — call other agents' services and the hub-brokered bus/store.
// Addresses services by NAME (role), never by instance id; the hub routes and
// cold-starts a provider on demand.

import { env } from "./env.js";
import type { Job, JobEvent, ServiceInfo, BusEnvelope } from "./types.js";

export interface RunJobOptions {
  version?: number;
  idempotencyKey?: string;
  onProgress?: (event: JobEvent) => void;
  signal?: AbortSignal;
  /** Correlation id joining this job into a coordination's trace (05 S6 / 13 §4). */
  correlationId?: string;
  /** Parent job / coordinator Plan id, for the coordination job-set query (05 S6). */
  parentId?: string;
  /** Overall deadline; past it `runJob` throws rather than returning a non-terminal job. */
  timeoutMs?: number;
}

/** A place to stash a large value (over the §11 inline ceiling) and return a key for it. */
export interface StoreCtx {
  /** Put `value` in the hub store; returns `{ storeKey }` the caller fetches (§11). */
  putResult(value: unknown): Promise<{ storeKey: string }>;
}

export class HubClient {
  constructor(
    private hubUrl: string = env.hubUrl,
    private busUrl: string = env.busUrl,
    private storeUrl: string = env.storeUrl,
    private token: string = env.busToken,
  ) {}

  private auth(): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }

  // --- service discovery + sync invoke --------------------------------

  /** List services across all running/cold-startable providers (optionally one name). */
  async discover(name?: string): Promise<ServiceInfo[]> {
    const r = await fetch(`${this.hubUrl}/api/v1/services`, { headers: this.auth() });
    if (!r.ok) throw new Error(`discover -> HTTP ${r.status}`);
    const list = (await r.json()) as ServiceInfo[];
    return name ? list.filter((s) => s.name === name) : list;
  }

  /** Invoke a sync service by name; returns the provider's JSON response. */
  async invoke<T = unknown>(name: string, body: unknown = {}, opts: { version?: number; signal?: AbortSignal } = {}): Promise<T> {
    const q = opts.version ? `?version=${opts.version}` : "";
    const r = await fetch(`${this.hubUrl}/api/v1/services/${encodeURIComponent(name)}/invoke${q}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.auth() },
      body: JSON.stringify(body ?? {}),
      signal: opts.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`invoke ${name} -> HTTP ${r.status}: ${text.slice(0, 200)}`);
    return parseMaybeJson(text) as T;
  }

  // --- jobs -----------------------------------------------------------

  /** Submit a job; returns immediately with the Job (state queued/starting/running). */
  async submitJob(
    name: string,
    inputs: unknown = {},
    opts: { version?: number; idempotencyKey?: string; correlationId?: string; parentId?: string } = {},
  ): Promise<Job> {
    const q = opts.version ? `?version=${opts.version}` : "";
    const headers: Record<string, string> = { "content-type": "application/json", ...this.auth() };
    if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
    if (opts.correlationId) headers["x-gaws-correlation"] = opts.correlationId;
    if (opts.parentId) headers["x-gaws-parent"] = opts.parentId;
    const r = await fetch(`${this.hubUrl}/api/v1/services/${encodeURIComponent(name)}/jobs${q}`, {
      method: "POST",
      headers,
      body: JSON.stringify(inputs ?? {}),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`submitJob ${name} -> HTTP ${r.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as Job;
  }

  async getJob(id: string, opts: { wait?: string } = {}): Promise<Job> {
    const q = opts.wait ? `?wait=${encodeURIComponent(opts.wait)}` : "";
    const r = await fetch(`${this.hubUrl}/api/v1/jobs/${id}${q}`, { headers: this.auth() });
    if (!r.ok) throw new Error(`getJob ${id} -> HTTP ${r.status}`);
    return (await r.json()) as Job;
  }

  async cancelJob(id: string): Promise<Job> {
    const r = await fetch(`${this.hubUrl}/api/v1/jobs/${id}/cancel`, { method: "POST", headers: this.auth() });
    if (!r.ok) throw new Error(`cancelJob ${id} -> HTTP ${r.status}`);
    return (await r.json()) as Job;
  }

  async jobResult<T = unknown>(id: string): Promise<T> {
    const r = await fetch(`${this.hubUrl}/api/v1/jobs/${id}/result`, { headers: this.auth() });
    if (!r.ok) throw new Error(`jobResult ${id} -> HTTP ${r.status}`);
    return parseMaybeJson(await r.text()) as T;
  }

  /** Stream a job's progress events (SSE) until the terminal `done` event. */
  async *streamJob(id: string, opts: { after?: number; signal?: AbortSignal } = {}): AsyncGenerator<JobEvent> {
    const headers: Record<string, string> = { ...this.auth() };
    if (opts.after) headers["last-event-id"] = String(opts.after);
    const r = await fetch(`${this.hubUrl}/api/v1/jobs/${id}/events`, { headers, signal: opts.signal });
    if (!r.ok || !r.body) throw new Error(`streamJob ${id} -> HTTP ${r.status}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const ev = parseSseFrame(frame);
        if (ev) {
          yield ev;
          if (ev.kind === "done") return;
        }
      }
    }
  }

  /**
   * Submit a job and await its TERMINAL result, streaming progress to `onProgress`.
   * Guarantees the returned Job is `done` — if the SSE stream drops it long-polls
   * to a deadline and throws rather than handing back a still-`running` job (§7.9).
   */
  async runJob<T = unknown>(name: string, inputs: unknown = {}, opts: RunJobOptions = {}): Promise<Job> {
    const job = await this.submitJob(name, inputs, {
      version: opts.version, idempotencyKey: opts.idempotencyKey,
      correlationId: opts.correlationId, parentId: opts.parentId,
    });
    if (job.done) return job;
    const deadline = Date.now() + (opts.timeoutMs ?? 60 * 60_000);
    // Bound the STREAM by the deadline too (not just the fallback poll) — else a
    // healthy SSE blocks for the whole real job duration and timeoutMs is ignored.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.max(0, deadline - Date.now()));
    if (opts.signal) {
      if (opts.signal.aborted) ac.abort();
      else opts.signal.addEventListener("abort", () => ac.abort(), { once: true });
    }
    try {
      try {
        for await (const ev of this.streamJob(job.id, { signal: ac.signal })) {
          opts.onProgress?.(ev);
          if (ev.kind === "done") break;
        }
      } catch {
        // stream dropped/aborted (deadline or caller signal) — fall through to poll.
      }
      let j = await this.getJob(job.id);
      while (!j.done) {
        if (opts.signal?.aborted) throw new Error(`runJob ${name} (${job.id}) aborted`);
        if (Date.now() > deadline) throw new Error(`runJob ${name} (${job.id}) not terminal before deadline`);
        j = await this.getJob(job.id, { wait: "30s" }); // hub long-poll; loops until terminal
      }
      return j; // guaranteed j.done
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Put a (possibly large) value in the hub store and get back a `{ storeKey }` to
   * return in place of an inline payload (the §11 store-a-blob pattern, one call).
   * Throws if no store grant is wired (BUS/STORE env absent).
   */
  async putResult(value: unknown): Promise<{ storeKey: string }> {
    const storeKey = `result/${env.instance}/${crypto.randomUUID()}`;
    const ok = await this.storePut(storeKey, value);
    if (!ok) throw new Error("store unavailable (no store grant?) — cannot putResult");
    return { storeKey };
  }

  // --- bus + store ----------------------------------------------------

  async busPublish(topic: string, msg: unknown): Promise<boolean> {
    if (!this.busUrl) return false;
    const r = await fetch(`${this.busUrl}/topics/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.auth() },
      body: JSON.stringify(msg),
    });
    return r.ok;
  }

  async busPull<T = unknown>(topic: string): Promise<T[]> {
    if (!this.busUrl) return [];
    const r = await fetch(`${this.busUrl}/topics/${encodeURIComponent(topic)}`, { headers: this.auth() });
    if (!r.ok) return [];
    return (await r.json()) as T[];
  }

  // --- durable event backbone (evolution 10) --------------------------------

  /** Publish a versioned envelope `{kind, ref}`; returns the hub-assigned seq. */
  async publishEvent(topic: string, kind: string, ref: unknown): Promise<number> {
    if (!this.busUrl) return 0;
    const r = await fetch(`${this.busUrl}/topics/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.auth() },
      body: JSON.stringify({ kind, ref }),
    });
    if (!r.ok) return 0;
    const j = (await r.json().catch(() => ({}))) as { seq?: number };
    return j.seq ?? 0;
  }

  /** One durable-group pull: envelopes since the group's cursor + the seq to ack to.
   *  The group id must equal this instance's TYPE (10 §6); the cursor survives restart. */
  async pullGroup(topic: string, group: string, opts: { limit?: number } = {}): Promise<{ messages: BusEnvelope[]; next: number }> {
    if (!this.busUrl) return { messages: [], next: 0 };
    const q = new URLSearchParams({ group });
    if (opts.limit) q.set("limit", String(opts.limit));
    const r = await fetch(`${this.busUrl}/topics/${encodeURIComponent(topic)}?${q}`, { headers: this.auth() });
    if (!r.ok) throw new Error(`pullGroup ${topic} -> HTTP ${r.status}`);
    return (await r.json()) as { messages: BusEnvelope[]; next: number };
  }

  /** Anonymous offset pull (catch-up/debug): envelopes with seq > `from`, beyond the ring. */
  async pullFrom(topic: string, from: number, opts: { limit?: number } = {}): Promise<{ messages: BusEnvelope[]; next: number }> {
    if (!this.busUrl) return { messages: [], next: from };
    const q = new URLSearchParams({ from: String(from) });
    if (opts.limit) q.set("limit", String(opts.limit));
    const r = await fetch(`${this.busUrl}/topics/${encodeURIComponent(topic)}?${q}`, { headers: this.auth() });
    if (!r.ok) throw new Error(`pullFrom ${topic} -> HTTP ${r.status}`);
    return (await r.json()) as { messages: BusEnvelope[]; next: number };
  }

  /** Advance a durable group's cursor (monotonic; a lower ack is a no-op). */
  async ackGroup(topic: string, group: string, seq: number): Promise<boolean> {
    if (!this.busUrl) return false;
    const r = await fetch(`${this.busUrl}/topics/${encodeURIComponent(topic)}/cursors/${encodeURIComponent(group)}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.auth() },
      body: JSON.stringify({ ack: seq }),
    });
    return r.ok;
  }

  /**
   * Durably consume a topic as a GROUP: pull → yield each envelope → ack the batch,
   * resuming from the persisted cursor. **At-least-once** — your handler must be
   * idempotent (the ack lands only after the consumer has processed the whole batch,
   * so a crash mid-batch redelivers). Loops until `signal` aborts; sleeps `idleMs`
   * between empty polls. This is the episodic-ingest contract for memory (11).
   */
  async *consumeGroup(
    topic: string,
    group: string,
    opts: { limit?: number; idleMs?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<BusEnvelope> {
    const idleMs = opts.idleMs ?? 2000;
    while (!opts.signal?.aborted) {
      let batch: { messages: BusEnvelope[]; next: number };
      try {
        batch = await this.pullGroup(topic, group, { limit: opts.limit });
      } catch {
        await sleep(idleMs);
        continue;
      }
      if (batch.messages.length) {
        for (const env of batch.messages) yield env;
        await this.ackGroup(topic, group, batch.next); // ack AFTER the consumer processed the batch
      } else {
        await sleep(idleMs);
      }
    }
  }

  async storePut(key: string, value: unknown): Promise<boolean> {
    if (!this.storeUrl) return false;
    const body = typeof value === "string" ? value : JSON.stringify(value);
    const r = await fetch(`${this.storeUrl}/store/${key}`, { method: "PUT", headers: this.auth(), body });
    return r.ok;
  }

  async storeGet(key: string): Promise<string | null> {
    if (!this.storeUrl) return null;
    const r = await fetch(`${this.storeUrl}/store/${key}`, { headers: this.auth() });
    if (!r.ok) return null;
    return r.text();
  }

  // --- presence -------------------------------------------------------

  /**
   * Advertise this instance's display label / current activity to the hub — shown
   * in the launcher sidebar (label replaces the opaque id; activity replaces the
   * docker status). Identity is the instance's BUS_TOKEN, so it can only set its
   * OWN presence. Pass `""` to clear a field; omit a field to leave it unchanged
   * (so set `label` once, then update `activity` alone on each step).
   *
   * Call it at EVERY state transition — load/save/select, each loop iteration and
   * its phase, answering a query — and `{ activity: "idle" }` when a job ends. A
   * stale activity reads as "stuck"; frequent updates read as "alive".
   *
   * Best-effort: a no-op without a token (local / untrusted runs) and never throws
   * into the caller — presence must not break the agent's real work.
   */
  async presence(p: { label?: string | null; activity?: string | null }): Promise<void> {
    if (!this.token) return;
    try {
      await fetch(`${this.hubUrl}/api/presence`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.auth() },
        body: JSON.stringify(p),
      });
    } catch {
      // swallow — presence is advisory.
    }
  }
}

/** A client wired from the injected environment. */
export const hub = new HubClient();

/** The store context handed to every sync/job handler (`ctx.store.putResult`). */
export const storeCtx: StoreCtx = { putResult: (value) => hub.putResult(value) };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function parseMaybeJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseSseFrame(frame: string): JobEvent | null {
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) data += line.slice(5).trimStart();
  }
  if (!data) return null;
  try {
    return JSON.parse(data) as JobEvent;
  } catch {
    return null;
  }
}
