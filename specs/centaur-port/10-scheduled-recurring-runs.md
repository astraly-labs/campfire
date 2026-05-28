# Spec 10 — Scheduled & recurring agent runs (+ webhook trigger)

| | |
|---|---|
| **Status** | Draft |
| **Size** | L (1–2 weeks) |
| **Depends on** | [02](./02-reconnect-replay-contract.md), [04](./04-inflight-turn-persistence.md) |
| **centaur source** | Durable workflow engine (`workflow_engine.py`: `ctx.step`/`ctx.sleep`/`ctx.wait_for_event`/`run_agent`, schedulable) + webhook → durable workflow (`webhooks.py`: `WebhookSpec`, HMAC verify before state creation, idempotency via `trigger_key`) |

## Problem

Every agent turn in campfire is **human-initiated and synchronous** to a thread. There's no way to say
"run this agent task every morning" (a digest, a dependency-bump scan, a CI-failure triage) or "run this
agent when an external event fires (a webhook)". centaur gets this from a general durable workflow engine;
campfire has nothing analogous.

## Goal

Ship the **high-value slice**: time-scheduled and recurring agent runs, plus an authenticated webhook
trigger — without (yet) building the full general-purpose checkpoint/replay workflow engine. A scheduled
run = "at time T (or cron C), start a turn on a (possibly fresh) thread with a fixed prompt + persona."

### Non-goals (this spec)

- The general `ctx.step`/`ctx.sleep`/`ctx.wait_for_event` multi-step workflow engine — noted as a larger
  follow-up in the README *Future notes*. We implement *triggers that start a normal turn*, which covers
  most of the value at a fraction of the cost.
- Sub-agent fan-out (that's [11](./11-subagent-dispatch.md)).

## Design

**Schedule table** (migration, next free id):

```
agent_schedule(
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,     -- 'once' | 'cron'
  cron          TEXT,              -- when kind='cron'
  run_at        INTEGER,           -- when kind='once'
  project_id    TEXT NOT NULL,
  persona_id    TEXT,              -- Spec 09; else provider instance + model
  prompt        TEXT NOT NULL,     -- the turn input
  thread_policy TEXT NOT NULL,     -- 'new-thread-each-run' | 'reuse-thread'
  target_thread TEXT,              -- when reuse-thread
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_run_at   INTEGER,
  next_run_at   INTEGER
)
```

**Scheduler service.** New `apps/server/src/orchestration/Services/AgentScheduler.ts` (Effect fiber): wakes
on the nearest `next_run_at`, and for each due schedule:
1. resolves/creates the target thread (per `thread_policy`),
2. dispatches a normal turn through the existing orchestration command path — reusing **Spec 01
   idempotency** (a deterministic `commandId` derived from `scheduleId + fire-time` so a scheduler restart
   can't double-fire) and **Spec 04** durability (a scheduled turn is as crash-safe as a human one),
3. recomputes `next_run_at` for cron schedules.

Because a scheduled run is just a turn, all of reconnect/replay/watchdog/personas apply unchanged — that's
the whole point of the slice.

**Webhook trigger.** Add an authenticated HTTP route in `apps/server/src/http.ts`,
`POST /webhooks/{slug}`:
- verify an HMAC signature on the raw body **before** creating any state (centaur's ordering — reject junk
  cheaply, no half-created runs),
- idempotency via a `trigger_key` header (or raw-body SHA-256) reusing the Spec 01 dedup table so a
  webhook redelivery doesn't double-fire,
- map the verified payload to a schedule-style run (persona + prompt template + target thread policy),
- strip sensitive headers before anything is persisted; return 202 (new) / 200 (already processed).

**UI.** A "Scheduled runs" settings panel: list/create/enable-disable schedules, see `last_run_at` and the
resulting thread link.

## Acceptance criteria

- [ ] A `once` schedule fires a real agent turn at its time on the right thread/persona.
- [ ] A `cron` schedule fires repeatedly and recomputes `next_run_at` correctly across a server restart (no missed/duplicated fire thanks to deterministic `commandId`).
- [ ] A scheduled turn is crash-safe (Spec 04) and reconnect-visible (Spec 02) like a human turn.
- [ ] A webhook with a valid HMAC starts a run; an invalid signature is rejected before any state is created.
- [ ] A redelivered webhook (same `trigger_key`) does not double-fire.
- [ ] Disabling a schedule stops future runs without deleting history.

## Risks / open questions

- Cron semantics across restart/timezone: persist `next_run_at` absolutely (epoch), recompute from a single
  clock source; document the timezone.
- Resource contention: scheduled runs compete with human turns for sessions — consider a low-priority lane
  (ties into [11](./11-subagent-dispatch.md)'s reserved-slot scheduler) so a digest can't starve interactive work.
- Keep the door open to the full workflow engine: model a schedule's action as a single "step" so a future
  engine can compose steps without reworking this table.
