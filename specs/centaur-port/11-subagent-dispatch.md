# Spec 11 — Sub-agent dispatch

| | |
|---|---|
| **Status** | Draft |
| **Size** | L (1–2 weeks) |
| **Depends on** | [05](./05-server-turn-watchdog-lease.md) (sub-agent turns need the same durable-turn machinery) |
| **centaur source** | Sub-agent dispatch / orchestration — an agent spawns specialist sub-agents (`call agent execute` with a `task:<purpose>-<id>` thread_key and a different persona/harness) and polls/stops them; a **reserved-slot scheduler** ensures workflow/sub-agent-spawned turns can't starve user-facing turns |

## Problem

A campfire thread is a single human↔agent conversation. There's no way for the agent to **delegate** a
self-contained subtask to a fresh specialist agent (e.g. "summarize these 40 files", "run the test suite
and triage failures") and incorporate the result — work that pollutes the main context if done inline, and
that a different persona/model might do better/cheaper.

## Goal

Let an active agent spawn one or more **sub-agent runs** — each its own thread with its own persona — track
their progress, collect their results, and feed them back into the parent turn. Guarantee that sub-agent
work runs in a **lower-priority lane** so it can never starve human-facing turns.

### Non-goals

- Arbitrary deep recursion trees as a first deliverable — cap depth (e.g. 1–2 levels) initially.
- A new agent protocol — sub-agents reuse the existing provider/session machinery.

## Design

**Sub-agent thread.** A sub-agent run is a normal orchestration thread, created with:
- a parent link (`parent_thread_id`, `parent_turn_id`) so results route back,
- a `purpose` label and a persona (Spec 09) chosen for the subtask,
- a marker distinguishing it from human threads in the sidebar (collapsible under the parent).

**Dispatch surface.** Expose a tool/command the agent can invoke to request a sub-agent (mirroring centaur's
`call agent execute`): `{ purpose, persona, prompt }`. The server:
1. creates the child thread + assignment (Spec 08),
2. enqueues the child's first turn in the **low-priority lane** (below interactive turns),
3. returns a handle the parent can poll/stop.

**Reserved-slot scheduler.** Generalize turn admission into lanes: a fixed number of slots reserved for
interactive (human) turns, the remainder shared, sub-agent/scheduled turns only ever fill non-reserved
slots. This is the key fairness mechanism — a burst of sub-agents can't lock out a human pressing enter.
Co-locate with the Spec 05 watchdog/lease (same per-turn execution authority).

**Result hand-back.** On sub-agent completion, emit an event into the parent turn (a structured "sub-agent
result" block referencing the child thread) so the parent agent's next step can read it and the human can
expand the child thread to audit it. Use Spec 03 stable ids so the result block is dedup-safe.

**Lifecycle.** Parent can stop a running sub-agent (propagates the Spec 05 interrupt). A sub-agent inherits
the durable-turn guarantees (crash → reclaim/fail like any turn).

## Acceptance criteria

- [ ] An agent can spawn a sub-agent run with a chosen persona + prompt and receive a handle.
- [ ] Sub-agent threads appear under their parent and are auditable by the human.
- [ ] A flood of sub-agent turns never delays an interactive human turn (reserved slots verified under load).
- [ ] Sub-agent results are handed back into the parent turn as a structured, dedup-safe block.
- [ ] Stopping a parent / sub-agent propagates correctly; crashes are reclaimed per Spec 05.
- [ ] Recursion depth is capped and enforced server-side.

## Risks / open questions

- Cost blow-up: sub-agents multiply token spend; add a per-parent sub-agent budget + the depth cap.
- Result routing when the parent turn already ended: queue the result onto the parent thread for the human,
  even if the parent agent turn finished first.
- Provider support: not every driver exposes a clean "spawn child" affordance — the child is just another
  managed session, so this should be driver-agnostic, but verify the result-handback timing per driver.
