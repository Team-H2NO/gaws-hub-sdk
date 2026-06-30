// HubClient — call other agents' services and the hub-brokered bus/store.
// Addresses services by NAME (role), never by instance id; the hub routes and
// cold-starts a provider on demand.

import { env } from "./env.js";
import type { Job, JobEvent, ServiceInfo } from "./types.js";

export interface RunJobOptions {
  version?: number;
  idempotencyKey?: string;
  onProgress?: (event: JobEvent) => void;
  signal?: AbortSignal;
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
  async invoke<T = unknown>(name: string, body: unknown = {}, opts: { version?: number } = {}): Promise<T> {
    const q = opts.version ? `?version=${opts.version}` : "";
    const r = await fetch(`${this.hubUrl}/api/v1/services/${encodeURIComponent(name)}/invoke${q}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.auth() },
      body: JSON.stringify(body ?? {}),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`invoke ${name} -> HTTP ${r.status}: ${text.slice(0, 200)}`);
    return parseMaybeJson(text) as T;
  }

  // --- jobs -----------------------------------------------------------

  /** Submit a job; returns immediately with the Job (state queued/starting/running). */
  async submitJob(name: string, inputs: unknown = {}, opts: { version?: number; idempotencyKey?: string } = {}): Promise<Job> {
    const q = opts.version ? `?version=${opts.version}` : "";
    const headers: Record<string, string> = { "content-type": "application/json", ...this.auth() };
    if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
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

  /** Submit a job and await its terminal result, streaming progress to `onProgress`. */
  async runJob<T = unknown>(name: string, inputs: unknown = {}, opts: RunJobOptions = {}): Promise<Job> {
    const job = await this.submitJob(name, inputs, { version: opts.version, idempotencyKey: opts.idempotencyKey });
    if (job.done) return job;
    try {
      for await (const ev of this.streamJob(job.id, { signal: opts.signal })) {
        opts.onProgress?.(ev);
        if (ev.kind === "done") break;
      }
    } catch {
      // stream dropped — fall back to a long-poll below.
    }
    return this.getJob(job.id, { wait: "60s" });
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
   * OWN presence. Pass `""` to clear a field; omit a field to leave it unchanged.
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
