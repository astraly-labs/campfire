# Spec 04 — In-flight turn persistence & crash replay

| | |
|---|---|
| **Status** | Draft |
| **Size** | M (3–5 days) |
| **Depends on** | [03](./03-canonical-events-stable-tool-ids.md) (stable ids make replayed events dedup cleanly) |
| **centaur source** | In-flight turn replay (`migration 006`, `agent.py`): `inflight_turn_id` + `inflight_turn_input` persisted on the session, so a restart mid-turn can re-drive the exact same input; ephemeral runtime state stays in-memory keyed by sandbox |

## Problem

When a turn is running and the campfire server crashes/restarts, **the in-flight turn is lost**. Verified:
in-flight turn state lives only in memory; the restarted server has no record of it. The sole safety net is
the *client-side* `stuckTurnWatchdog` (`apps/web/src/stuckTurnWatchdog.ts`), which flips the turn to
"interrupted" after 2–5 min — but the user's intent (the prompt they sent) is gone and nothing re-drives it.

This is the prerequisite for any server-side recovery: you can't reclaim or resume a turn whose input you
didn't persist.

## Goal

Persist enough of each turn's *intent* that, after a restart, the server can deterministically re-drive
the exact same turn input against a freshly-spawned provider session — turning a crash from "lost work"
into "transparent retry."

### Non-goals

- Resuming a turn *mid-execution* (replaying partial agent output). We re-drive from the turn's input, not
  from its partial progress — simpler and correct given agents are largely deterministic-enough at the
  turn boundary.
- The watchdog/lease that *decides* to reclaim — that's [05](./05-server-turn-watchdog-lease.md). This spec
  makes reclaim *possible*; 05 makes it *happen*.

## Design

**Persist turn intent.** Extend the provider-session runtime row (`ProviderSessionRuntime`,
`apps/server/src/persistence/Services/ProviderSessionRuntime.ts`) — or a dedicated `inflight_turn` table —
with:

```
inflight_turn(
  thread_id        TEXT PRIMARY KEY,   -- one in-flight turn per thread (matches ProviderSessionDirectory)
  turn_id          TEXT NOT NULL,
  command_id       TEXT NOT NULL,      -- ties back to the originating dispatch (Spec 01)
  turn_input       TEXT NOT NULL,      -- canonical-JSON of the exact normalized turn input
  assignment_gen   INTEGER,            -- Spec 08, if present
  started_at       INTEGER NOT NULL,
  state            TEXT NOT NULL        -- 'running' | 'completed' | 'failed'
)
```

Migration `043+_InflightTurn.ts` (renumber per the next free id).

**Write path:** on turn start (in `OrchestrationEngine` / the managed provider in
`makeManagedServerProvider.ts`), persist the `inflight_turn` row *before* dispatching to the provider.
On turn completion/failure, mark `state` accordingly (or delete the row).

**Recovery path:** on server startup, after layers initialize, scan `inflight_turn WHERE state='running'`.
For each, the recovery routine (gated by Spec 05's policy) can re-drive `turn_input` against a new session.
Use `command_id` + Spec 01 idempotency so a re-drive that races with anything already applied is safe, and
Spec 03 stable ids so re-emitted tool-call events dedup against any that did persist before the crash.

**Crash-during-turn ordering:** persist the row in the same transaction that appends the
`thread.turn-started` event, so the event stream and the in-flight record never disagree.

## Acceptance criteria

- [ ] Starting a turn writes a `running` `inflight_turn` row before any provider dispatch.
- [ ] Completing/failing a turn clears or marks the row terminally.
- [ ] After a simulated mid-turn restart, the row survives and exposes the exact original `turn_input`.
- [ ] Re-driving the persisted input through the dispatch path is idempotent (no duplicated message/turn)
      thanks to `command_id` + Spec 01.
- [ ] At most one `running` `inflight_turn` per thread at any time.

## Risks / open questions

- `turn_input` size: prompts can include large pasted context / attachment refs. Store refs (paths) not
  bytes, consistent with `normalizeDispatchCommand` materializing attachments to disk already.
- Non-determinism: re-driving produces a *new* agent execution, not a byte-identical replay. That's
  acceptable (the user gets their turn run once, correctly) — document it so nobody expects bit-exact resume.
- Decide whether recovery is automatic on boot or requires Spec 05's lease/watchdog to authorize it.
  Recommend: this spec only *persists*; 05 owns the decision to re-drive.
