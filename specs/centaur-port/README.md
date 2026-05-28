# Porting the best of `paradigmxyz/centaur` into campfire

> Source of ideas: [paradigmxyz/centaur](https://github.com/paradigmxyz/centaur) — *"Multiplayer,
> self-hosted, secure agents."* A team-wide platform where one shared agent runs per Slack thread
> inside an isolated K8s sandbox, with a Python/FastAPI control plane on Postgres.
>
> campfire is a **local-first / shared-tailnet** product: an Effect + SQLite + WebSocket backend that
> spawns Codex / Claude / OpenCode app-server processes per thread, with side-threads, presence and
> git worktrees. See [`../architecture/SPEC.md`](../architecture/SPEC.md).

The two products solve the same problem — *durable, multiplayer, agent-driven coding* — from opposite
deployment ends. centaur is a hardened cloud control plane; campfire is a thin shared backend. So we
**don't port centaur's deployment** (K8s sandboxes, Slack ingress, iron-proxy). We port its
**control-plane discipline**: how it makes agent turns durable, reconnect-safe, deliverable, and
extensible without forking.

This folder splits those ideas into **small, independently shippable specs**. Each spec is self-contained:
you can implement and merge it without the others (dependencies are called out explicitly).

---

## How to read this

Each centaur idea below is classified by:

- **Applicability** — High / Medium / Low / N/A for campfire's architecture.
- **campfire today** — `missing` / `partial` / `present` (verified against current code).
- **Spec** — the spec file that implements it, or why we skip it.

---

## The ranked map

### Tier 1 — port now (high value, real gap)

| # | centaur idea | campfire today | Spec |
|---|---|---|---|
| 7 | Harness-agnostic event normalization + **stable tool-call IDs** (SHA of canonical JSON) so the same call dedups across reconnects | `partial` — events are normalized to a canonical `OrchestrationEvent`, but tool-call IDs are provider-assigned/ephemeral | [03](./03-canonical-events-stable-tool-ids.md) |
| 3 | **The event log IS the client contract** — `after_event_id` replay + a documented failure model (disconnect / restart / pod death) | `partial` — `sequence` + `replayEvents(fromSequenceExclusive)` + `OrchestrationRecoveryCoordinator` exist, but the failure model is undocumented and untested | [02](./02-reconnect-replay-contract.md) |
| 5 (impl) | **In-flight turn replay** — persist `inflight_turn_input` so a mid-turn restart re-drives the exact input | `missing` — in-flight turn state is in-memory only; a server crash loses it (client watchdog is the only net) | [04](./04-inflight-turn-persistence.md) |
| 9 + 13 | **Postgres-as-queue with leases + a three-tier watchdog** (silence / tool-silence / hard-deadline) reclaiming dead turns | `missing` server-side — watchdog is client-only (2-tier, no RPC); no server reclaim | [05](./05-server-turn-watchdog-lease.md) |
| 1 | **Idempotent lifecycle** — client-supplied IDs + stored `request_hash`, replay the stored response on retry | `partial` — commands carry `commandId` but the server does no dedup | [01](./01-idempotent-command-dispatch.md) |
| 11 | **Overlay system — extend without forking** (org tools / skills / personas / prompts layered via a mounted dir) | `missing` — campfire *is* a hand-maintained fork of t3code; org changes are tangled into base | [12](./12-org-overlay.md) |

### Tier 2 — port soon (clear value, moderate scope)

| # | centaur idea | campfire today | Spec |
|---|---|---|---|
| 10 | **Outbox pattern for delivery** — `awaiting_terminal → pending → sending → delivered/dead_letter` with retries | `missing` — inbox/mentions are live WebSocket push only; lost while offline (only re-fetchable via `inbox.list`) | [07](./07-durable-notification-outbox.md) |
| 14 | **Warm pool with evict-on-startup** — pre-spawned idle sessions kill ~cold-start latency; evict stale on deploy | `missing` — sessions are spawned on-demand per thread, reaped on inactivity | [06](./06-warm-session-pool.md) |
| 2 | **`assignment_generation`** — a monotonic epoch per thread; tag turns/messages; persona/model change bumps the generation (clean invalidation + audit) | `partial` — one session per thread is guaranteed by `ProviderSessionDirectory`, but there's no generation/epoch concept | [08](./08-assignment-generation.md) |
| 13 (prompt) | **Personas** — a bundle of {engine + system prompt + enabled tools} switchable per thread, + deployment self-introspection prompt block | `missing` — only per-instance model selection; no persona bundle | [09](./09-personas.md) |

### Tier 3 — bigger bets (high ceiling, larger scope)

| # | centaur idea | campfire today | Spec |
|---|---|---|---|
| 8 | **Durable workflows** (`ctx.step` / `ctx.sleep` / `ctx.wait_for_event` / `run_agent`) → schedulable & webhook-triggerable recurring agent runs | `missing` | [10](./10-scheduled-recurring-runs.md) (MVP slice: scheduled/recurring runs + webhook trigger; full engine noted as follow-up) |
| (impl) | **Sub-agent dispatch** — an agent spawns specialist sub-agents with a reserved-slot scheduler so they don't starve user-facing turns | `missing` | [11](./11-subagent-dispatch.md) |

### Skip — not applicable to campfire's model

| # | centaur idea | Why we skip (for now) |
|---|---|---|
| 4, 5, 6 | **iron-proxy credential binding** (placeholders swapped on the wire, typed secret taxonomy, per-sandbox proxy) | Solves credential exfiltration when *untrusted* agents run on shared infra with the *org's* secrets. campfire runs agents locally on a trusted machine using the operator's own already-resolved CLI credentials (`codex login`, etc.), over a private tailnet. The threat model doesn't match. **Revisit if** campfire grows a multi-tenant hosted mode where one host runs agents on behalf of users who must not see each other's keys — see *Future notes* below. |
| 12 | **`call` + TOON tool dispatcher** (agents shell out; responses TOON-encoded for token economy) | campfire drives agents through the providers' native protocols (Codex app-server JSON-RPC, Claude/OpenCode adapters). We don't own the agent's tool surface, so there's nothing to re-encode. |
| — | **Slack ingress / rich-text streaming** | campfire has its own first-class web/desktop UI; Slack is not an ingress path. |
| — | **First-class attachments table (BYTEA)** | Largely already present: turn image uploads are persisted to `serverConfig.attachmentsDir` and served over HTTP; only side-thread GIFs are URL-only (Tenor), which is fine. Low value to generalize now. |

---

## Suggested implementation order

Reliability core first (these compound — later features inherit their guarantees), then extensibility, then big bets:

```
03 ──▶ 02 ──▶ 04 ──▶ 05         reliability core (events, replay, durable turns)
        │              │
01 ─────┘              └──▶ 08   idempotency + generation tagging
06   07                          latency + delivery (independent, parallelizable)
08 ──▶ 09                        personas build on generations
              10   11   12       features / strategy (depend on reliability core)
```

Rough sizing (S ≈ 1–2 days, M ≈ 3–5 days, L ≈ 1–2 weeks):

| Spec | Title | Size | Depends on |
|---|---|---|---|
| 01 | Idempotent command dispatch | S | 02 (shares the dedup table idea) |
| 02 | Reconnect-safe replay contract (harden + document) | M | — |
| 03 | Canonical events + stable tool-call IDs | M | — |
| 04 | In-flight turn persistence & crash replay | M | 03 |
| 05 | Server-side tiered turn watchdog + lease reclaim | M | 04 |
| 06 | Warm session pool (evict-on-startup) | M | — |
| 07 | Durable notification delivery (outbox) | M | — |
| 08 | Assignment generation epoch per thread | S | — |
| 09 | Personas (engine + prompt + tools) | M | 08 |
| 10 | Scheduled & recurring agent runs (+ webhook trigger) | L | 02, 04 |
| 11 | Sub-agent dispatch | L | 05 |
| 12 | Org overlay (extend the fork without diverging) | M | — |

---

## Future notes (parked, not yet specced)

- **Scoped credential proxy for a hosted/multi-tenant mode.** If campfire ever runs agents on shared
  infra for users who must not see each other's keys, revisit centaur's iron-proxy: agents hold only a
  placeholder string; a per-session MITM proxy swaps in the real value *only* on outbound requests
  matching the secret's declared host + header/query/path. This neutralizes the credential-exfiltration
  class of prompt-injection attacks structurally. Heavy; out of scope until the deployment model demands it.
- **Full durable workflow engine.** Spec 10 ships the high-value slice (scheduled/recurring runs). The
  general `ctx.step`/`ctx.sleep`/`ctx.wait_for_event` checkpoint-replay engine (centaur's `workflow_engine.py`)
  is a large follow-up; only build it if multi-step durable orchestration becomes a product need.
