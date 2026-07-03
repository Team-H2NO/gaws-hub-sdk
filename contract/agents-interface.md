# Building a gaws-hub–compatible agent

**This document is self-contained.** With only what is here you can build, package,
register, and run an agent on gaws-hub from a separate repo — no other gaws-hub
docs required.

---

## 1. What an agent is

**gaws-hub** is a single-host launcher: it runs and supervises isolated instances
of *agents* and aggregates them behind one origin via a path-stripping reverse
proxy. An **agent type** is described by a small **manifest**; the hub turns each
launch request into Docker containers on a private per-instance network.

> **An agent is any OCI (Docker) image that serves HTTP and satisfies the small
> runtime contract below.** The hub holds no knowledge of your agent beyond its
> manifest. Your agent lives in its own repo, with its own CI publishing the image.

What you provide:

1. A **prebuilt OCI image** that serves HTTP on a port (§3).
2. An **Agent Manifest** describing how to run it (§4) — ideally baked into the
   image as a label so it **self-registers** (§5).
3. A **`build.sh` at the repo root** that builds that image from a clean checkout
   (REQUIRED — see §3). This makes the repo **standalone-buildable**: anyone can
   `git clone … && ./build.sh` to produce the runnable, self-registering image
   without the agent-builder or any other tooling, so a proven agent repo is
   trivial to import and reuse.

What the hub provides: pulling/running the image, a private network, the reverse
proxy at `/a/<id>/`, optional storage and a database, injected environment, and an
optional brokered communication plane (bus + store).

---

## 2. TL;DR — the smallest working agent

1. Serve HTTP on a port (say `3000`) with at least a homepage. Use **relative
   URLs** for every asset so the page works under a path prefix.
2. Write a manifest:

   ```yaml
   apiVersion: agents/v1
   kind: AgentType
   name: my-agent
   image: ghcr.io/you/my-agent:latest
   port: 3000
   ```

3. Bake the manifest into the image as a base64 label so it self-registers:

   ```dockerfile
   ARG MANIFEST_B64=""
   LABEL org.gaws.agent.manifest=$MANIFEST_B64
   ```

   build with `--build-arg MANIFEST_B64="$(base64 -w0 < manifest.yaml)"`.
4. Make the image available to the hub's Docker daemon (`docker build`/`docker pull`).
   The hub auto-registers it on boot, or register it now:
   `POST /api/agent-types/from-image {"image":"ghcr.io/you/my-agent:latest"}`.
5. Launch: `POST /api/instances {"type":"my-agent","inputs":{}}` → `{"id":"i…","url":"/a/i…/"}`.
   Your agent is now live at `/a/<id>/`.

A complete, runnable example is in §13.

---

## 3. The runtime contract

Your image **must**:

- **Serve HTTP on the `port`** declared in the manifest, bound to `0.0.0.0`
  (not `127.0.0.1` — the hub reaches it over a Docker network, not loopback).
- **Tolerate a path-stripping reverse proxy.** The hub serves your instance at
  `/a/<id>/…` (and at `<id>.<host>/…`), but **strips the prefix** before
  forwarding: a browser request to `/a/<id>/style.css` arrives at your server as
  `GET /style.css`. Therefore your HTML/JS/CSS must reference assets with
  **relative URLs** (`./style.css`, `app.js`) or a runtime-injected `<base>` —
  never absolute paths like `/style.css`, which would escape the prefix.

Your **repo must**:

- Include a **`build.sh` at the repo root** that builds the image from a clean
  checkout — at minimum `docker build --build-arg MANIFEST_B64="$(base64 -w0 <
  manifest.yaml)" -t <name>:latest .` (full template in §13). A fresh
  `git clone … && ./build.sh` must yield the runnable, self-registering image with
  no agent-builder, extra args, or manual steps. Keep it the single source of truth
  for how the image is built (honor an optional `GIT_SHA` env for versioning —
  runbook "Image versioning").

Your image **should** (strongly recommended; standard contract):

- Expose **`GET /healthz`** returning `200` when ready. (Add a Docker
  `HEALTHCHECK` hitting it so readiness is visible.)
- Expose **`GET /meta`** returning JSON `{"id","kind","version","capabilities"}`.
- **Persist your web UI state across reloads.** The hub renders your UI in an
  iframe and may reload it at any time — switching to another agent and back, the
  instance **reload** button, or a plain browser refresh all reload `/a/<id>/` from
  scratch. Don't let that wipe the user's working context: persist client-side UI
  state — form inputs, the active tab/view, the current selection — and restore it on
  load. Use `localStorage` **keyed by your instance id** (`GAWS_HUB_INSTANCE` / the
  `id` from `/meta`) — all instances share the hub's single browser origin, so a
  static key lets two instances clobber each other — or re-derive the state from the
  server. Durable *domain* data still belongs server-side (a `volume`/the store/a
  database, §8), not in `localStorage`.

**WebSockets are supported** end to end: a WS upgrade to `/a/<id>/ws` is proxied
to your `/ws`. Open the socket with a **relative** URL resolved against the page
location so it works under the prefix (see §13).

Notes:

- The proxy redirects `/a/<id>` → `/a/<id>/` so your relative assets resolve.
- **Request** bodies through the proxy are capped at **64 MB** (responses are not
  capped). For larger uploads use the artifact/store plane (§11) — but typical web
  UIs are fine.
- The hub assigns the instance **id**; you receive it as `GAWS_HUB_INSTANCE` (§7).
  Do not hardcode an id or a host port.

---

## 4. The Agent Manifest

A YAML document describing one agent type. Authoritatively parsed as:

```yaml
apiVersion: agents/v1          # optional; defaults to "agents/v1"
kind: AgentType                # REQUIRED; must be exactly "AgentType"
name: my-agent                 # REQUIRED; unique key for this type
image: ghcr.io/you/my-agent:latest   # REQUIRED; the prebuilt image to run
port: 3000                     # REQUIRED; the port your server listens on
singleton: true                # optional; at most one live instance of this type (see table)
health:                        # optional
  path: /healthz
inputs:                        # optional; the launch form + values
  - { name: seeds, type: list }
  - { name: maxPages, type: int, default: 500 }
  - { name: verbose, type: bool, default: false, optional: true }
env:                           # optional; environment to inject (see §7)
  - { name: SEEDS, from: input.seeds }
  - { name: GIT_NAME, from: config.git.name }
  - { name: MODE, from: production }          # literal value
storage:                       # optional; volumes / database (see §8)
  - { kind: volume, mountPath: /cache }
  - { kind: database }                        # pgvector 17 sidecar (default)
mounts:                        # optional; host files (TRUSTED types only — §9)
  - { host: "~/.config/gh", container: /root/.config/gh, mode: ro }
capabilities:                  # optional; requested privileges (granted by policy — §9)
  egress: true
  store: true
  messaging: { publishes: [ "task.done" ], subscribes: [] }
  dockerSocket: false
```

### Field reference

| Field | Type | Required | Meaning |
|---|---|---|---|
| `apiVersion` | string | no (default `agents/v1`) | Schema version. |
| `kind` | string | **yes** | Must equal `AgentType`. |
| `name` | string | **yes** | Unique type key; also the registry filename. Must be non-empty. |
| `image` | string | **yes** | OCI image reference the hub pulls and runs. Non-empty. |
| `port` | integer (u16) | **yes** | The HTTP port your server listens on. |
| `health.path` | string | no | Readiness path (declarative; see §3 / §12). |
| `singleton` | bool | no (default false) | At most one live instance of this type at a time. Manual launch returns the existing instance instead of starting a second; cold-start is capped to 1 (over-capacity calls **queue** for `job`, get `429` for `sync` — §14). For agents owning a singleton resource (a shared `volume`, a git working copy) where concurrent instances would corrupt coherence. |
| `inputs[]` | list | no | Launch inputs; render the launch form and supply values. |
| `inputs[].name` | string | yes (per item) | Input key. |
| `inputs[].type` | string | yes (per item) | `string` \| `int` \| `bool` \| `list` \| `select` \| `repo` \| `gitref` \| … (free-form; used by the launch form). |
| `inputs[].optional` | bool | no (default false) | If false **and** no `default`, the input is **required** at launch. |
| `inputs[].default` | any | no | Default value; presence makes the input non-required. |
| `env[]` | list | no | Environment variables to inject. |
| `env[].name` | string | yes | The variable name in the container. |
| `env[].from` | string | yes | Source: `input.<name>`, `config.<path>`, or a literal string. See §7. |
| `storage[]` | list | no | Volumes and/or a database sidecar. See §8. |
| `storage[].kind` | string | yes | `volume` \| `database` \| `external`. (Other values are rejected.) |
| `storage[].mountPath` | string | for `volume` | Where to bind the volume in the container. |
| `storage[].scope` | string | no | For `volume` and `database`: `instance` (default) \| `type` \| `system` — who shares the resource and how long it lives (§8). `per-instance` = `instance`. |
| `storage[].engine` | string | no | DB image reference (default `pgvector/pgvector:pg17`). |
| `storage[].whenInput` | string | no | Provision only when this input is truthy. |
| `mounts[]` | list | no | Host bind-mounts. **Only honored for trusted types** (§9). |
| `mounts[].host` | string | yes | Host path (`~/` expands to the host home). |
| `mounts[].container` | string | yes | Mount target in the container. |
| `mounts[].mode` | string | no | `ro` for read-only. |
| `capabilities.dockerSocket` | bool | no (default false) | Request the host Docker socket. **Trust-gated** (§9). |
| `capabilities.egress` | bool | no (default false) | Request outbound internet. Without it the network is **internal** (§10). |
| `capabilities.store` | bool | no (default false) | Request access to the record/artifact store (§11). |
| `capabilities.messaging` | object | no | `{ publishes: [...], subscribes: [...] }` — request bus access (§11). |

Validation the hub enforces: `kind == "AgentType"`, non-empty `name` and `image`,
and every `storage[].kind` ∈ {`volume`,`database`,`external`}. Everything else is
lenient.

---

## 5. Self-registration via an image label (the recommended path)

Make the image **self-describing** so "drop an image, it registers" works: carry
the manifest (base64-encoded YAML) in the label `org.gaws.agent.manifest`.

```dockerfile
# Dockerfile (excerpt)
ARG MANIFEST_B64=""
LABEL org.gaws.agent.manifest=$MANIFEST_B64
```

Build, computing the label from your YAML:

```bash
docker build --build-arg MANIFEST_B64="$(base64 -w0 < manifest.yaml)" -t my-agent:latest .
```

(You may instead hardcode the base64 string in the `LABEL`, but computing it from
a checked-in `manifest.yaml` keeps the manifest reviewable.)

How the hub uses it:

- **Boot scan:** on startup the hub lists local images carrying
  `org.gaws.agent.manifest` and registers each. Build/pull your image on the
  hub's host and restart the hub, or:
- **On demand:** `POST /api/agent-types/from-image {"image":"my-agent:latest"}`
  pulls the image, reads the label, validates, and registers — no hub restart.

If `image` is omitted/empty in the embedded manifest, the hub fills it with the
image reference it actually resolved.

---

## 6. Other ways to register (no label needed)

- **Raw manifest API:** `POST /api/agent-types` with the manifest YAML (or JSON)
  as the request body.
- **Static catalogue:** drop `your-agent.yaml` into the hub's state dir
  `~/.gaws-hub/types/` (loaded on boot).
- **List / remove:** `GET /api/agent-types`, `DELETE /api/agent-types/{name}`.

All three converge on the same type registry; the label path is just the most
self-service. The image still has to be runnable by the hub's Docker daemon.

---

## 7. Environment the hub injects

When an instance is created, the container receives:

**Always:**

| Variable | Value |
|---|---|
| `GAWS_HUB_INSTANCE` | the instance id (`i…`) — also your network alias |
| `AGENT_NAME` | your agent type `name` |
| `HUB_URL` | `http://hub:<port>` — the hub API root (service plane); where you POST presence |
| `BUS_TOKEN` | a per-instance bearer token — your identity to the hub (presence + job reports always; bus/store only when those caps are granted) |

**From `manifest.env[]`** — each entry `{name, from}` becomes `name=<resolved>`:

| `from:` | Resolves to |
|---|---|
| `input.<name>` | the launch input value (objects/arrays are JSON-stringified; **empty string** if that input wasn't provided) |
| `config.git.name` / `config.git.email` | the operator's configured git identity (empty if unset). These are the **only** recognized `config.*` paths; any other `config.*` resolves to an empty string. |
| anything else (no `input.` / `config.` prefix) | the literal string |

**If you declare `storage: [{ kind: database }]`** (§8):

| Variable | Value |
|---|---|
| `DATABASE_URL` | `postgres://app:app@<host>:5432/app` — host is `<id>-db` (`instance`), `gawsdb-type-<name>` (`type`), or `gawsdb-system` (`system`); see §8 `scope`. |

**If you declare `capabilities.store` and/or `capabilities.messaging`** (§11):

| Variable | Value | When |
|---|---|---|
| `BUS_URL` | `http://hub:<port>/bus` | `messaging` or `store` granted |
| `STORE_URL` | `http://hub:<port>` | `store` granted |

(`BUS_TOKEN` is **always** injected now — see the Always table — so even a
capability-less instance can self-report presence; `BUS_URL`/`STORE_URL` stay
gated on their caps, so an identity-only token still can't reach bus/store.)

**Always read `HUB_URL`/`BUS_URL`/`STORE_URL`/`DATABASE_URL` from the environment** —
never hardcode hostnames or ports. `hub` is a network alias for the hub on your
instance's private network.

### Presence — advertise a sidebar label + live activity

Because every instance now gets `HUB_URL` + `BUS_TOKEN`, **every** instance —
capable or not — can self-report **presence**: a short **label** (shown in the
launcher sidebar instead of the opaque id) and an **activity** (what you're doing
right now, shown instead of the docker `status`). The hub stores and displays
whatever you send, with no agent-specific knowledge; report nothing and your row
renders exactly as today (id + docker status).

```
POST $HUB_URL/api/presence      Authorization: Bearer $BUS_TOKEN
{ "label": "acme-bot", "activity": "iter 2/5 · build" }
```

- Identity is the **token**, never a body field — you can only set your own presence.
- Each field is trimmed + clamped to 120 chars. Send `""` to **clear** a field;
  **omit** a field to leave it unchanged — so set `label` once, then update
  `activity` alone on every step.
- Best-effort, live-only soft-state: presence is lost on hub restart and cleared
  when your instance dies, so it must **never gate real work** — fire and forget,
  ignore the response.

**Report often.** Presence is the operator's only live window into a long-running
instance, so push a fresh `activity` at *every* state transition — not just at
start and end. For an interactive agent that means: selecting/loading a repo or
target, saving, each loop iteration **and its phase** (e.g. `iter 3/5 · eval`),
answering a query, creating a resource — and reset to `"idle"` when a job ends
(keep the `label` so the row still shows what you last touched). A stale
`activity` reads as "stuck"; frequent updates read as "alive".

Node agents on `@gaws-hub/sdk` get this for free as
`hub.presence({ label, activity })` (same omit/clear semantics; a no-op without a
token). For `job` **services** the SDK job host **reports presence automatically**
over each job's lifecycle (start → every `ctx.progress` → `idle`), so a service
provider needs no manual presence call — see §14.

---

## 8. Storage

`storage` is a list; declare what you need.

### `kind: volume`
A named Docker volume bound at `mountPath`. Survives a `reload` (container
recreate). Use it for caches or, with sqlite, a single-writer datastore.

```yaml
storage:
  - { kind: volume, mountPath: /cache }                 # per-instance (default)
```

#### `scope` — who shares the volume, and how long it lives
Like a database (below), a volume's `scope` decides both sharing and lifecycle.
`per-instance` is accepted as a synonym for `instance`.

| `scope` | One volume per… | Lifecycle |
|---|---|---|
| `instance` *(default)* | this instance | created with the instance, **removed with it**; survives `reload` |
| `type` | this **agent type** | keyed on the type (`gawsvol-type-<name>-<path>`); **survives instance removal**, reaped only when the type is permanently deleted |
| `system` | **all agents** | keyed on the mount path (`gawsvol-system-<path>`); survives instance removal; never auto-reaped |

```yaml
storage:
  - { kind: volume, mountPath: /data, scope: type }     # data survives remove+relaunch
```

> **Singletons should use `scope: type`.** A `singleton: true` type has at most one
> live instance, so *removing* it and launching a new one yields a **new instance id**
> — with `instance` scope that means a fresh, empty volume and the old data is gone
> (a `reload` keeps it; a `remove` does not). A `type`-scoped volume is keyed on the
> type, so a relaunched instance reattaches the same data. Safe because a singleton is
> the only writer.

### `kind: database`
A **PostgreSQL sidecar** the hub starts and injects into your container as
`DATABASE_URL`. **Read `DATABASE_URL` from the environment and connect** — your app
is the same regardless of who else shares the database; that's decided by `scope`,
not by your code.

The default image is **`pgvector/pgvector:pg17`** — Postgres 17 with the
[`pgvector`](https://github.com/pgvector/pgvector) extension available (run
`CREATE EXTENSION vector;`). Override with `engine`, which is a **full image
reference**:

```yaml
storage:
  - { kind: database }                          # per-instance (default)
  - { kind: database, engine: postgres:16 }     # or any Postgres-compatible image
```

#### `scope` — who shares the database
`scope` selects how widely the sidecar is shared. The connection contract
(`DATABASE_URL`, fixed `app`/`app`/`app` creds, port `5432`) is identical in every
scope — only **how many instances point at the same Postgres** changes:

| `scope` | One database per… | Alias / `DATABASE_URL` host | Lifecycle |
|---|---|---|---|
| `instance` *(default)* | this instance | `<id>-db` | created with the instance, removed with it; survives `reload` |
| `type` | this **agent type** (every instance of it) | `gawsdb-type-<name>` | created on first instance, reaped when the **last** instance of the type is removed |
| `system` | **all agents** | `gawsdb-system` | created on first consumer, reaped when the last is removed |

```yaml
storage:
  - { kind: database, scope: type }    # all instances of this type share one DB
  - { kind: database, scope: system }  # every agent shares one DB
```

Mechanically, a **shared** scope provisions **one** Postgres container (keyed on the
scope, not the instance) and multi-attaches it to each consumer instance's private
network under the shared alias. Your instance still can't reach other instances —
only the shared database is reachable across them. Creation is idempotent and
locked, so concurrent launches converge on the same sidecar; teardown is
reference-counted, so the sidecar lives exactly as long as it has a consumer.

**What sharing means for your app.** You are no longer the sole writer:

- **Don't assume an empty or solely-owned database.** Other instances (same type, or
  any type for `system`) read and write concurrently. Namespace your tables, and
  treat pre-existing rows as normal.
- **Make schema setup concurrency-safe** — `CREATE TABLE IF NOT EXISTS` / `CREATE
  EXTENSION IF NOT EXISTS`, or an advisory-lock'd migrator. Every instance runs its
  init on boot against the same database.
- **Don't run blanket "fix-up on boot" writes** (e.g. resetting all `processing`
  rows to `stopped`) — under sharing that stomps another live instance's state.
  Scope such writes to your own instance (`GAWS_HUB_INSTANCE`).
- Mind the shared connection budget (Postgres `max_connections`): size your pool for
  N instances, not one.

> **Current limits.** Postgres-protocol only: `engine` is the image to run, but the
> credentials, data path, port (`5432`) and the injected `postgres://…` URL are
> Postgres-shaped. Credentials are fixed (`app`/`app`/`app`); for `instance`/`type`
> this is safe because the DB is reachable only on the consumers' private networks,
> but note a **shared** scope means every consumer is a full superuser on the shared
> data — request the narrowest scope that works. **Only the *first* `kind: database`
> entry is provisioned**; multiple sidecars (e.g. postgres + redis) are not
> supported yet.

### `kind: external` — *not implemented yet*
Intended for an operator-supplied connection string instead of a spawned sidecar
(managed DBs). The manifest validator **accepts** `kind: external`, but the hub does
not act on it today — it provisions nothing and injects no connection string. Use
`kind: database` (a sidecar) for now.

> **Sharing is opt-in and explicit.** A `type`/`system` `scope` is a deliberate,
> hub-managed shared datastore (above). Do **not** instead hand-wire a shared
> *volume*, or pass your per-instance `DATABASE_URL` to another agent, to talk
> across instances — that bypasses the scope model and breaks isolation. For
> message-passing between agents use the communication plane (§11); reach for a
> shared `scope` only when agents genuinely need shared *durable* state.

---

## 9. Capabilities & trust

The manifest **declares** what it wants; the **hub operator's policy decides** what
it gets. Privilege is never self-granted by a label. Defaults are **deny**.

| Capability | Grants | How it's gated |
|---|---|---|
| `dockerSocket: true` | the host Docker socket bind-mounted in (host-root-equivalent) | only for **trusted** types |
| `mounts: [...]` | host files bind-mounted in | only for **trusted** types |
| `egress: true` | outbound internet (otherwise the network is `internal`, §10) | honored as declared |
| `store: true` | write/read the record + artifact store (§11) | per-instance `BUS_TOKEN` minted |
| `messaging: {...}` | publish/subscribe on the bus (§11) | per-instance `BUS_TOKEN` minted |

An operator marks a type **trusted** via `GAWS_HUB_TRUSTED=type-a,type-b` (env) or
`{"trusted":["type-a"]}` in `~/.gaws-hub/config.json`. **Untrusted types still run
fully** — they just get their private network and declared volumes, with no socket,
no host mounts. Design your agent to work untrusted unless it genuinely needs host
privileges.

---

## 10. Networking & isolation (what you can and cannot reach)

- Each instance gets **its own private Docker network** (`inst-<id>`). The **hub is
  the only other member** (reachable as `hub`). **Instances cannot reach each
  other** — there is no network path between two agents.
- The hub reaches your container by its alias (`http://<id>:<port>`); **no host
  port is published**. Don't expect to be reachable on the host directly.
- **Without `egress: true` the network is `internal`** — no outbound internet. With
  it, normal NAT egress. Either way, the hub (`hub`) and your DB sidecar
  (`<id>-db`) are reachable; the wider internet is not, unless egress is granted.
- Anything you need from another agent flows through the hub's brokered plane (§11),
  never a direct connection.

---

## 11. Inter-agent communication (bus + store)

Isolated by default; communication is an **explicitly granted, hub-brokered
capability**. All endpoints require `Authorization: Bearer $BUS_TOKEN` (the token
injected at launch for capable types). Reach them at `BUS_URL`/`STORE_URL`.

The pattern is **store → notify → fetch by key**: write the payload to the store,
publish a small message carrying the *key*, the consumer fetches by key. Keep bus
messages small (references, not payloads).

### Bus (durable pub/sub) — needs `capabilities.messaging`

| Call | Effect |
|---|---|
| `POST /bus/topics/<topic>` (JSON body) | Publish a message. Persists; returns `202`. |
| `GET /bus/topics/<topic>` | Pull the durable backlog as a JSON array (for consumers that were offline). |
| `GET /bus/topics/<topic>` with a WebSocket upgrade | Subscribe: the backlog is replayed, then new messages are pushed as JSON text frames. |

**Getting notified.** The hub never pushes to an agent unsolicited — to learn that a
message arrived you must either hold an open **WebSocket** subscription (real-time)
or **poll** the backlog. Current semantics (minimal; hardening is a design open
question):

- **Storage** — each message is appended to a durable per-topic log on disk
  (`~/.gaws-hub/bus/<topic>.jsonl`, on the hub's state volume, so it survives
  restarts), fronted by an in-memory cache. But **both pull and WebSocket-replay
  serve only the most recent ~1000 messages per topic** — older messages stay on
  disk yet are not replayed.
- **WebSocket** — best-effort real-time fan-out to every subscriber of the topic. On
  connect the recent backlog is replayed, then new messages stream live. There is
  **no resume cursor**: a reconnect replays that recent backlog again. A subscriber
  that falls far behind may have *live* frames dropped (bounded buffer), but the
  message is still in the log (and a re-pull sees it, within the last ~1000).
- **Pull** — returns the recent backlog every time (no `?since=` / offset), so a
  polling consumer must **track and dedupe** what it has already handled.
- **No acks, no consumer groups, no per-consumer offsets, no delivery guarantees.**

Topics are durable, so a late/restarting consumer still receives prior messages.
Address by **topic/role/task-id**, never a raw instance id (instances are
ephemeral).

### Store (records + artifacts) — needs `capabilities.store`

| Call | Effect |
|---|---|
| `PUT /store/<key>` (raw body) | Write a durable record. Keys may contain `/` (nested). `204` on success. |
| `GET /store/<key>` | Read it back (raw bytes). `404` if absent. |
| `DELETE /store/<key>` | Delete a record. `204` if it existed, `404` if already absent. |
| `POST /artifacts` (raw body) | Upload a blob; returns `201 {"key":"a…"}`. |
| `GET /artifacts/<key>` | Download the blob. |
| `POST /artifacts/presign` | Bulk object-store URLs — **not implemented yet** (`501`); use `/artifacts` for now. |

Records + artifacts are **kept forever by default**. A `PUT` to an existing key
overwrites; `DELETE /store/<key>` removes one record. An operator can enable
time-based eviction by setting `GAWS_HUB_STORE_TTL_SECS` on the hub — a periodic
sweep then deletes any record/artifact older than that many seconds (by file
mtime). Direct uploads to `/store` and `/artifacts` accept bodies up to **256 MB**
(buffered in memory; the proxy path keeps its separate 64 MB cap — §3).

### Example: two agents exchanging data (store → notify → fetch)

A **producer** and a **consumer** run as separate instances with **no network path
to each other** (see §10 — agents can't reach each other or the internet without the
capability). Everything flows through the hub; each side uses only its own injected
`$BUS_URL` / `$STORE_URL` / `$BUS_TOKEN`.

```bash
# --- producer: write the payload to the store, then announce its key on the bus ---
curl -s -X PUT  "$STORE_URL/store/page/example/about" \
     -H "Authorization: Bearer $BUS_TOKEN" -d '{"title":"About","len":1234}'
curl -s -X POST "$BUS_URL/topics/crawl.done" \
     -H "Authorization: Bearer $BUS_TOKEN" -H 'content-type: application/json' \
     -d '{"record":"page/example/about"}'

# --- consumer (a DIFFERENT instance): pull the backlog, then fetch by key ---
curl -s "$BUS_URL/topics/crawl.done"           -H "Authorization: Bearer $BUS_TOKEN"
# -> [{"record":"page/example/about"}]
curl -s "$STORE_URL/store/page/example/about"  -H "Authorization: Bearer $BUS_TOKEN"
# -> {"title":"About","len":1234}
```

The consumer receives data the producer created **without ever connecting to it** —
the bus + store are the only bridge. Requests without a valid token get `401`; treat
`$BUS_TOKEN` as a secret and read it from the environment, never hardcode it.

---

## 12. Lifecycle (what the hub does to your instance)

| API | Effect |
|---|---|
| `POST /api/instances {type, inputs}` | Validate inputs → create network → provision storage → start container(s) → instance live at `/a/<id>/`. Required inputs missing → `400`. |
| `POST /api/instances/{id}/stop` | Stop the container(s); keep them. |
| `POST /api/instances/{id}/reload` | **Remove and recreate** the container(s) on the latest image, keeping the **same id/alias/URL**. Use this to pick up a new image build. Uncommitted in-container state is lost unless on a volume. |
| `DELETE /api/instances/{id}` | Remove container(s), the private network, and the instance's volumes. |
| `GET /api/instances` | List instances `{id, type, port, status, …}`. |

Design implications for your agent:

- **`reload` recreates the container**, so persist anything that must survive in a
  declared `volume` (or the store) — not in the container filesystem.
- The **id/URL is stable** across reload; safe to share `/a/<id>/` links.
- Status comes from the container state (`running`/`stopped`/…). Exit cleanly on
  `SIGTERM` so stop/reload are graceful.

---

## 13. Complete worked example (zero-dependency, Python stdlib)

A minimal but real agent: a homepage with a relative-path asset, plus `/healthz`
and `/meta`. No third-party deps. (For WebSockets, swap `http.server` for a
framework like `aiohttp` and add a `/ws` route — the proxy handles WS the same way.)

**`app.py`**

```python
#!/usr/bin/env python3
import json, os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

NAME = os.environ.get("AGENT_NAME", "my-agent")
INSTANCE = os.environ.get("GAWS_HUB_INSTANCE", "local")
PORT = int(os.environ.get("PORT", "3000"))

PAGE = f"""<!doctype html><html><head><meta charset="utf-8">
<title>{NAME}</title><link rel="stylesheet" href="./style.css"></head>
<body><h1>Hello from {NAME}</h1>
<p>instance <b>{INSTANCE}</b></p></body></html>"""   # NOTE: relative ./style.css

class H(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype):
        b = body.encode()
        self.send_response(code); self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(b))); self.end_headers()
        self.wfile.write(b)
    def do_GET(self):
        p = self.path.split("?", 1)[0]
        if p == "/healthz":   self._send(200, "ok", "text/plain")
        elif p == "/meta":    self._send(200, json.dumps(
            {"id": INSTANCE, "kind": NAME, "version": "0.1.0", "capabilities": {}}),
            "application/json")
        elif p == "/style.css": self._send(200, "body{font-family:sans-serif;margin:3rem}", "text/css")
        else:                 self._send(200, PAGE, "text/html")
    def log_message(self, *a): pass

ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()   # 0.0.0.0, not 127.0.0.1
```

**`manifest.yaml`**

```yaml
apiVersion: agents/v1
kind: AgentType
name: my-agent
image: my-agent:latest
port: 3000
health: { path: /healthz }
capabilities: {}          # untrusted + isolated: no socket, no egress
```

**`Dockerfile`**

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY app.py .
ARG MANIFEST_B64=""
LABEL org.gaws.agent.manifest=$MANIFEST_B64   # self-registration
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK CMD python -c "import urllib.request;urllib.request.urlopen('http://localhost:3000/healthz')" || exit 1
CMD ["python", "app.py"]
```

**`build.sh`** (REQUIRED, at the repo root — §3; the one command that builds the image)

```bash
#!/usr/bin/env bash
set -euo pipefail
docker build --build-arg MANIFEST_B64="$(base64 -w0 < manifest.yaml)" -t my-agent:latest .
```

**Register & launch** (against a hub on, say, `http://localhost:3000`):

```bash
./build.sh
# self-register from the image label (no hub restart):
curl -s -X POST localhost:3000/api/agent-types/from-image \
     -H 'content-type: application/json' -d '{"image":"my-agent:latest"}'
# launch:
ID=$(curl -s -X POST localhost:3000/api/instances \
     -H 'content-type: application/json' -d '{"type":"my-agent","inputs":{}}' \
     | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
# visit it through the proxy:
curl -s "localhost:3000/a/$ID/"          # the homepage
curl -s "localhost:3000/a/$ID/style.css" # the relative asset, path-stripped
curl -s "localhost:3000/a/$ID/healthz"   # -> ok
```

Open `http://<hub>/` in a browser to launch and view it from the hub's UI.

---

## 14. Services — advertise operations other agents can call

Beyond serving a UI, an agent can **advertise named services** other agents invoke
**by name (a role), never by instance id**. The hub routes each call to a free
provider and **cold-starts one on demand** if none is running. Two kinds:

- **`sync`** — request/response (short).
- **`job`** — long-running; the hub schedules it, tracks a durable lifecycle, and
  streams progress + a result (AIP-151-style).

Declare them in the manifest:

```yaml
services:
  - name: build            # the role; callers use this, never your instance id
    kind: job              # sync | job
    path: /api/build       # the path on YOUR server the hub dispatches to
    summary: "…"
    concurrency: 1         # max in-flight per instance (job default 1)
    timeout: { run: 40m, heartbeat: 5m, start: 5m, queue: 20m }
    pool: { min: 0, max: 3, idleTtl: 30m }   # cold-start pool (min:0 = scale-to-zero)
    request: { type: object, required: [repo], properties: { … } }   # optional JSON Schema
```

> A type offering a **cold-startable** service must be **launchable with no required
> inputs** (the request carries the work). A `job` provider is auto-granted a
> `BUS_TOKEN` (it needs it to report).

> **Singleton providers.** With `singleton: true` (§4) the cold-start pool is capped
> at **one** instance regardless of `pool.max`: all of the type's services share that
> one instance, and when it is saturated `job` calls **queue** (up to `timeout.queue`,
> then `queue_timeout`) and `sync` calls get **`429` + `Retry-After`** rather than a
> second instance. Use it for a provider that owns a singleton resource (one volume,
> one git working copy) where two instances would race.

**Implement it with the SDK** ([`@gaws-hub/sdk`](https://github.com/Team-H2NO/gaws-hub-sdk)) —
you write only the handler:

```ts
import { createAgent } from "@gaws-hub/sdk";
createAgent({ name: "my-agent", services: [
  { name: "build", kind: "job", path: "/api/build",
    handler: async (input, ctx) => { await ctx.progress({step:1}); return { ok: true }; } },
]});
```

**Call a service** (from any agent):

```ts
import { hub } from "@gaws-hub/sdk";
const out = await hub.invoke("echo", { hi: 1 });                       // sync
const job = await hub.runJob("build", req, { onProgress: e => log(e) }); // job + live progress
```
or with the baked-in `hub` CLI: `hub services`, `hub invoke <name> <json>`,
`hub job <name> <json>`.

**Hub endpoints** (what the SDK/CLI wrap): `GET /api/v1/services` (discovery),
`POST /api/v1/services/<name>/invoke` (sync), `POST /api/v1/services/<name>/jobs`
(create job → `202`), `GET /api/v1/jobs/<id>` (`?wait=30s`), `GET …/events` (SSE),
`POST …/cancel`. Workers report to `POST /api/v1/jobs/<id>/report` (token-gated; the
SDK handles this). The job-worker contract: idempotent + checkpointed work, so a
retry/hard-kill never corrupts output.

### Surface what you're serving (REQUIRED)

A provider is **cold-started to run work the user never started from its own page** —
so by default opening its iframe shows an idle homepage while a job runs invisibly,
and the operator can't tell a busy instance from a stuck one. **Any agent that
declares `services` MUST surface its current service activity on both planes the
operator watches:**

- **The hub sidebar** — report **presence** (§7) across the service lifecycle:
  `activity` = what you're doing right now, reset to `"idle"` when the work ends.
  This is the cross-agent, at-a-glance view.
- **Its own web UI** — when the iframe is opened *mid-job*, the page must show the
  in-progress work (current step / streaming log / status), **not a blank idle
  screen**. Because the hub can reload your iframe at any time (§3), this surface
  must **re-attach to a job already running** on load, not only show events that
  arrive after connect.

**On [`@gaws-hub/sdk`](https://github.com/Team-H2NO/gaws-hub-sdk) you get both for
free for `job` services:**

- The job host **auto-reports presence** over each job's lifecycle (start → every
  `ctx.progress(...)` → `idle`) — no handler code. (Best-effort; a no-op without a
  `BUS_TOKEN`.)
- `createAgent` runs an in-process **activity feed** served at `GET /api/served`
  (SSE that **replays the running backlog on connect**, so a freshly-opened page
  re-attaches to an in-flight job). Wire your page in a few lines: open
  `/api/served` on load and render with the kit's `createRunBars`, served at
  `./_gaws/agent-ui.js`. The reference template does exactly this (a `serving: N
  jobs` badge + live status bars). Opt out with `feed: false` only if you surface
  activity another way.

For a **slow `sync`** service (one that drives an LLM or runs many seconds), call
`hub.presence({ activity })` from the handler the same way — sync handlers aren't
auto-fed (a sub-second request/response isn't worth the UI churn).

Building **without** the SDK? Implement both yourself: POST presence to
`$HUB_URL/api/presence` across the lifecycle (§7), and serve a live activity surface
(an SSE/stream of your run state, with a backlog/`GET` re-attach) that your page
subscribes to on load — so a reload mid-job shows the running work.

---

## 15. Observability — structured logs

The hub runs an observability stack (Grafana **Alloy → Loki → Grafana**, browsable
at `/a/grafana/`). Alloy collects the **stdout** of every gaws-managed container and
ships it to Loki, already tagged with your `instance` and `agent` (from the
container's `org.gaws.*` labels). To make that stream *useful* — filterable by the
work your agent is doing — **emit one JSON object per line to stdout**.

> Plain-text stdout is still collected (it just carries only the `instance`/`agent`
> labels). Structured lines add the ids below, so an operator can follow one
> session or one build through the noise.

### The line format

```json
{"ts":"2026-06-28T07:20:01.123Z","level":"info","msg":"→ Edit(server.js)",
 "event":"claude.tool_use","thread":"i9491c870:9af3c1#iter2/build",
 "session":"d1c2…","job":"j1a2…","data":{"tool":"Edit","tokensOut":1234}}
```

| Field | Required | Meaning |
|---|---|---|
| `ts` | **yes** | RFC3339 timestamp (`new Date().toISOString()`). Used as the log time. |
| `level` | **yes** | `debug` \| `info` \| `warn` \| `error`. Becomes an indexed label. |
| `msg` | **yes** | Human-readable message. |
| `event` | recommended | Machine event name, e.g. `claude.tool_use`, `build.iteration`, `job.start`. |
| `session` | when in scope | One model conversation — the `session_id` of a `claude -p` run (see below). |
| `thread` | when in scope | Your agent's own logical unit of work (a build, a run, an iteration). |
| `job` | when in scope | The hub job id (`x-gaws-job`) when serving a `job` service. |
| `data` | optional | Any extra structured fields (object). |
| `agent`,`instance` | optional | Come free from container labels; include them if you also read logs outside Loki. |

### The id hierarchy

```
instance   GAWS_HUB_INSTANCE — your container (also the Loki label)
 ├ thread   your unit of work: a build / run / iteration (you define the string)
 │   └ session   one `claude -p` session_id (the model conversation)
 └ job      the hub job id, when invoked as a service
```

Map your own concepts onto `thread`/`session`. A long agent run has **many**
sessions and threads — that is exactly why each line carries its ids, so they can be
told apart in Grafana.

### `claude -p` (and other JSONL sub-processes)

If you run `claude -p --output-format stream-json`, you already parse a JSON event
stream. Surface it: set `session` from the `session_id` in the `system/init` event,
then emit one log line per event with `event = "claude.<type>"` (`claude.assistant`,
`claude.tool_use`, `claude.result`, …) and the human text in `msg`. Now every model
action your agent took is in Loki under that session id.

### Cardinality rule (don't skip this)

Loki **indexes labels**, so only **bounded** fields may be labels: `instance`,
`agent`, `role`, `level`. The high-cardinality ids — `session`, `thread`, `job`,
`event` — are carried as **structured metadata** (the hub's Alloy pipeline promotes
them automatically from your JSON). **Never** invent your own labels for per-request
ids; put them in the line as fields and the pipeline does the right thing.

### Drop-in helper (zero-dependency, Node)

```js
// gaws-hub structured logging — one JSON object per line to stdout.
const _I = process.env.GAWS_HUB_INSTANCE || "local";
const _A = process.env.AGENT_NAME || "agent";
const _emit = (level, msg, f = {}) =>
  process.stdout.write(JSON.stringify(
    { ts: new Date().toISOString(), level, agent: _A, instance: _I, msg, ...f }) + "\n");
const mk = (base) => ({
  info:  (m, f) => _emit("info",  m, { ...base, ...f }),
  warn:  (m, f) => _emit("warn",  m, { ...base, ...f }),
  error: (m, f) => _emit("error", m, { ...base, ...f }),
  debug: (m, f) => _emit("debug", m, { ...base, ...f }),
  child: (ctx) => mk({ ...base, ...ctx }),   // bind session/thread/job for a unit of work
});
const log = mk({});
// log.info("started"); const t = log.child({ thread: buildId }); t.info("building", { event: "build.start" });
```

If you build on **`@gaws-hub/sdk`** you get this for free: import `{ log }`, and a
job handler's `ctx.log(...)` / `ctx.progress(...)` already emit a structured stdout
line tagged with the `job` id.

---

## 16. Prompts as files — agents that drive `claude -p`

If your agent runs `claude -p` (or any sub-LLM), **every prompt it sends MUST live as a
`prompts/*.md` file in the repo and be loaded at call time — never inlined as a string
literal in code.** The prompts *are* the agent's behavior; as files they show up in
diffs, are editable without touching process logic, and let the next person (or coding
agent) extend the agent by reading `prompts/` instead of hunting literals across source.

The contract:

- **Location & naming.** One top-level `prompts/` directory, one `.md` per distinct
  prompt/step, named by purpose (`prompts/build.md`, `prompts/eval.md`,
  `prompts/ask_system.md`).
- **Loaded, not inlined.** Read the file at call time and substitute variables; do not
  bake prompt text into the source as a literal. A trivial loader is enough:

  ```js
  const renderPrompt = (name, vars = {}) =>
    fs.readFileSync(path.join("prompts", name + ".md"), "utf8")
      .replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));
  // claude -p «renderPrompt("ask_system", { repo, base })»
  ```

- **Explicit variables.** Use `{{name}}` placeholders for injected runtime values
  (task, repo, criteria, …). Compute any conditional/derived text in code and pass it
  in as a variable, so the file stays a readable template.
- **System prompts count.** Text passed via `--append-system-prompt` is a prompt — it
  lives in `prompts/` too (e.g. `prompts/ask_system.md`), same rules.
- **Shipped with the image.** `COPY prompts ./prompts` (or equivalent) so the files
  exist at runtime — they are part of the agent, like `build.sh`.

Applies only to agents that embed an LLM; a plain HTTP agent has nothing to do here.

---

## 17. Compatibility checklist

- [ ] Serves HTTP on the manifest `port`, bound to `0.0.0.0`.
- [ ] All web assets use **relative** URLs (works under `/a/<id>/`). WS too, if used.
- [ ] `GET /healthz` returns `200` when ready (and a Docker `HEALTHCHECK`).
- [ ] `GET /meta` returns `{id, kind, version, capabilities}` (recommended).
- [ ] Web UI state (form inputs, active tab/view, selection) survives an iframe
      reload — persisted to `localStorage` keyed by instance id, or re-derived from
      the server (§3).
- [ ] Manifest has `kind: AgentType`, `name`, `image`, `port`; validates (§4).
- [ ] Repo has a root **`build.sh`**; a clean `git clone … && ./build.sh` builds the
      self-registering image with no other tooling (§3).
- [ ] Image carries `org.gaws.agent.manifest` (base64 YAML) for self-registration.
- [ ] Reads config from env (`GAWS_HUB_INSTANCE`, `DATABASE_URL`, `BUS_URL`,
      `BUS_TOKEN`, `STORE_URL`, your `env[]`) — nothing hardcoded.
- [ ] Persists durable state in a declared `volume`/the store (survives `reload`).
- [ ] Only requests `dockerSocket`/`mounts`/`egress`/`store`/`messaging` it truly
      needs; works **untrusted** otherwise.
- [ ] Emits **structured JSONL logs to stdout** (`ts`/`level`/`msg`, plus
      `session`/`thread`/`job` when in scope; `claude -p` events surfaced) — §15.
- [ ] *(If you drive `claude -p` / any sub-LLM)* every prompt is a `prompts/*.md` file
      loaded at call time, not inlined in code (§16).
- [ ] Exits cleanly on `SIGTERM`.
- [ ] *(If you advertise services)* `services[]` declared (§14); cold-startable
      services are launchable with no required inputs; `job` work is
      idempotent + checkpointed.
- [ ] *(If you advertise services)* current service activity is visible on **both**
      the hub sidebar (presence, §7) and your own web UI — a cold-started instance
      opened mid-job shows its in-progress work, not an idle page (free from the SDK
      for `job` services — §14).

If every box is checked, your image is launchable on any gaws-hub.
