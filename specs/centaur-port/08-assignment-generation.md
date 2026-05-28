# Spec 08 — Assignment generation epoch per thread

| | |
|---|---|
| **Status** | Draft |
| **Size** | S (1–2 days) |
| **Depends on** | none (enables clean [09](./09-personas.md); complements [04](./04-inflight-turn-persistence.md)/[05](./05-server-turn-watchdog-lease.md)) |
| **centaur source** | `assignment_generation` as a monotonic epoch per thread (`migration 008`, `spawn_assignment()`) — each thread's sandbox binding is an immutable generation row; messages/executions are tagged with their generation; a partial unique index `WHERE state='active'` enforces exactly one active binding; persona/prompt/harness changes force a **new generation** rather than mutating in place (clean invalidation + audit trail) |

## Problem

campfire guarantees one provider session per thread (`ProviderSessionDirectory`: `threadId →
ProviderRuntimeBinding`), but the binding is **mutated in place** — there's no concept of a generation/epoch.
So:

- When the model/provider instance (or future persona) changes, it's unclear which subsequent turns ran
  under which config; there's no audit trail of reassignments.
- Late events from a *superseded* session can't be cleanly distinguished from the current one.
- "Invalidate everything bound to the old config" has no clean primitive.

## Goal

Make each thread→session binding an **immutable generation row** with a monotonically increasing
`generation` number. Tag turns (and the in-flight turn row) with the generation they ran under. Any
config change that should reset the agent's context creates a *new* generation instead of mutating the old.

### Non-goals

- Changing the one-active-binding-per-thread guarantee (we formalize it, not change it).
- Personas themselves (that's [09](./09-personas.md); this is the substrate that makes a persona switch clean).

## Design

**Generation table** (migration, next free id):

```
thread_assignment(
  thread_id          TEXT NOT NULL,
  generation         INTEGER NOT NULL,    -- monotonic per thread, starts at 1
  provider_instance  TEXT NOT NULL,
  persona_id         TEXT,                -- Spec 09, nullable until then
  state              TEXT NOT NULL,       -- 'active' | 'superseded'
  created_at         INTEGER NOT NULL,
  PRIMARY KEY (thread_id, generation)
)
```

Enforce **exactly one active generation per thread** with a partial unique index (SQLite supports it):

```sql
CREATE UNIQUE INDEX thread_assignment_one_active
  ON thread_assignment(thread_id) WHERE state = 'active';
```

**Tagging.** Add `assignment_generation` to:

- turn records / `thread.turn-started` events,
- the `inflight_turn` row (Spec 04),
- the provider-session runtime binding.

**Reassign.** A new `spawnAssignment(threadId, { providerInstance, personaId })` operation:
1. marks the current active row `superseded`,
2. inserts a new `active` row with `generation = prev + 1`,
3. (re)binds the session in `ProviderSessionDirectory` to the new generation.

All in one transaction, so the partial unique index never sees two active rows.

**Use it for invalidation.** Events/turns tagged with a superseded generation are recognizable as stale —
e.g. a late provider event from gen 1 arriving after a switch to gen 2 is dropped or attributed to history,
not applied as current.

## Acceptance criteria

- [ ] Each thread has exactly one `active` assignment row at all times (enforced by the partial unique index).
- [ ] Changing the provider instance (and, with Spec 09, the persona) bumps the generation rather than mutating in place.
- [ ] Turns and the in-flight-turn row are tagged with their `assignment_generation`.
- [ ] A late event from a superseded generation is identifiable and not applied as current state.
- [ ] The reassign operation is atomic (no window with two active rows).

## Risks / open questions

- Backfill: existing threads get `generation = 1` for their current binding on migration.
- Keep generation numbers per-thread (not global) so they read as a clean version history of that thread's agent config.
- Decide whether a plain *model* change within the same instance bumps the generation or not — recommend
  only bump when the change should reset agent context (persona/instance/prompt), not for trivial knob tweaks.
