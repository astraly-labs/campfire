# Spec 02 — Reconnect-safe replay contract (harden + document)

| | |
|---|---|
| **Status** | Draft |
| **Size** | M (3–5 days) |
| **Depends on** | none |
| **centaur source** | "The event log IS the client contract" — `agent_execution_events` is an append-only `BIGSERIAL` stream; clients reconnect with `after_event_id`; a documented failure model (client disconnect / API restart / pod death / worker failover) gives each case a defined recovery |

## Problem

campfire already has the *machinery* for replayable state:

- `OrchestrationEventStore` assigns a monotonic `sequence` and exposes `readFromSequence(sequenceExclusive, limit?)`.
- `orchestration.replayEvents(fromSequenceExclusive)` RPC (`apps/server/src/ws.ts`).
- `OrchestrationRecoveryCoordinator` (`apps/web/src/orchestrationRecovery.ts`) with `classifyDomainEvent`
  states `ignore` / `defer` / `recover` / `apply`, tracking `latestSequence`, `highestObservedSequence`,
  `bootstrapped`.

What's missing is a **stated contract and the tests that prove it**. The behavior under each failure mode
(brief disconnect, long disconnect with a sequence gap, server restart, server restart mid-turn) is
emergent, not specified — so we can't confidently say reconnect is lossless, and regressions are silent.

## Goal

1. Specify the replay contract as the single source of truth between client and server.
2. Harden the edges: bounded replay, snapshot-vs-replay decision, and the mid-turn case.
3. Lock it with deterministic tests covering each failure mode.

### Non-goals

- Changing the event schema (that's [03](./03-canonical-events-stable-tool-ids.md)).
- Durable delivery of *notifications* (that's [07](./07-durable-notification-outbox.md)); this spec is the
  *orchestration thread* event stream only.

## Design

**Contract (to document in this file + the protocol comment in `ws.ts`):**

- Every orchestration domain event has a strictly increasing `sequence`, gap-free per emit order.
- A client holds `latestSequence` (last applied). On (re)subscribe it sends `subscribeThread` and, if it
  already has state, calls `replayEvents(fromSequenceExclusive = latestSequence)`.
- Server returns events `(latestSequence, now]` in order. Client applies, advancing `latestSequence`.
- If the gap to replay exceeds a **bound** `MAX_REPLAY_EVENTS`, the server tells the client to
  **re-bootstrap** (fetch a fresh `ProjectionSnapshotQuery` snapshot) instead of streaming a huge backlog.
  This is the snapshot-vs-replay decision, made explicit.
- Live events arriving during a replay are buffered (`defer`) and applied after the replay drains, so
  ordering is preserved (the coordinator already models this; make it explicit and tested).

**Failure model table** (the deliverable — mirror centaur's `docs/pages/architecture.mdx` failure section):

| Failure | Detection | Recovery |
|---|---|---|
| Brief client disconnect | WS close → reconnect | `replayEvents(latestSequence)`; apply gap; resume live |
| Long disconnect (gap > bound) | replay span > `MAX_REPLAY_EVENTS` | server signals re-bootstrap; client reloads snapshot, resets `latestSequence` |
| Server restart (no turn running) | WS close; new server has events in SQLite | identical to brief disconnect — events survive in the store |
| Server restart **mid-turn** | turn was in-flight | event stream is intact up to the crash; the in-flight turn is re-driven by [04](./04-inflight-turn-persistence.md) and reclaimed by [05](./05-server-turn-watchdog-lease.md) |
| Duplicate live + replayed event | same `sequence` seen twice | `classifyDomainEvent → ignore` (idempotent apply) |

**Hardening tasks:**

1. Add `MAX_REPLAY_EVENTS` bound and a `ReplayTooLarge`/`reBootstrap` signal in the `replayEvents` result
   contract (`packages/contracts/src/rpc.ts`).
2. Make `replayEvents` paginate (`limit` + continuation) so a large-but-allowed replay streams in chunks.
3. Audit `classifyDomainEvent` for the buffered-during-replay path and assert ordering invariants.

## Acceptance criteria

- [ ] This file's failure-model table is reflected by tests: a harness drops the socket, restarts the
      server, and injects a sequence gap, and the client reaches a state byte-identical to a
      never-disconnected client.
- [ ] Replays larger than `MAX_REPLAY_EVENTS` trigger a clean re-bootstrap rather than a giant stream.
- [ ] Events delivered live during an in-flight replay end up applied exactly once, in sequence order.
- [ ] The contract is documented inline in `ws.ts` next to `replayEvents` and here.

## Risks / open questions

- Choosing `MAX_REPLAY_EVENTS`: too low and short blips force expensive re-bootstraps; too high and a
  reconnect after hours offline streams forever. Start ~2000, make it config-driven, measure.
- Snapshot cost: re-bootstrap leans on `ProjectionSnapshotQuery`; confirm it's cheap enough to be the
  fallback for large gaps, else add an incremental snapshot.
