# Spec 01 — Idempotent command dispatch

| | |
|---|---|
| **Status** | Draft |
| **Size** | S (1–2 days) |
| **Depends on** | none (pairs naturally with [02](./02-reconnect-replay-contract.md)) |
| **centaur source** | Three-call durable lifecycle with idempotency keys (`runtime_control.py`: `spawn_id`/`message_id`/`execute_id` + stored `request_hash`, replays the stored response on retry, raises `IDEMPOTENCY_PAYLOAD_MISMATCH` on collision) |

## Problem

A client that retries a command after a flaky WebSocket reconnect (or an optimistic double-submit) can
cause the same agent turn / message to be applied twice. campfire already stamps every command with a
client-supplied `commandId: CommandId` (`packages/contracts/src/orchestration.ts`,
`ClientOrchestrationCommand`), but `orchestration.dispatchCommand` in `apps/server/src/ws.ts` does **no
dedup** — the event store is append-only and will happily record the duplicate. The id is currently used
for tracing only.

## Goal

Make `dispatchCommand` idempotent keyed on `commandId`: a retry with the *same* id and *same* payload
returns the original result without re-applying; a retry with the same id but a *different* payload is
rejected loudly.

### Non-goals

- Cross-thread / cross-process distributed dedup (single shared backend; in-process + SQLite is enough).
- Idempotency for non-mutating queries.

## Design

**Dedup record.** New SQLite table (migration `043_CommandIdempotency.ts`):

```
command_idempotency(
  command_id      TEXT PRIMARY KEY,
  thread_id       TEXT NOT NULL,
  request_hash    TEXT NOT NULL,   -- sha256 of canonical-JSON of the normalized command
  result_payload  TEXT NOT NULL,   -- serialized dispatch result to replay
  created_at      INTEGER NOT NULL
)
```

Use the same canonical-JSON helper introduced in [03](./03-canonical-events-stable-tool-ids.md) (sorted
keys, no insignificant whitespace) for `request_hash` so hashing is deterministic.

**Flow** (in the `dispatchCommand` handler, after `normalizeDispatchCommand`):

1. Compute `request_hash` over the normalized command.
2. `INSERT ... ON CONFLICT(command_id) DO NOTHING`. If the row already existed:
   - same `request_hash` → return the stored `result_payload` (replay). Done, no re-apply.
   - different `request_hash` → fail with a typed `IdempotencyPayloadMismatch` error.
3. On a fresh insert, apply the command as today, then `UPDATE` the row's `result_payload` with the result.

Wrap steps 2–3 so the apply + result-store commit atomically with the dedup row (single SQLite
transaction) — otherwise a crash between apply and store leaves a row that replays an empty result.

**Contract.** Add `IdempotencyPayloadMismatch` to the `dispatchCommand` error channel in
`packages/contracts/src/rpc.ts`. Clients surface it as a developer error (it means a bug: same id reused
for different intent).

**Retention.** Prune rows older than N hours (configurable, default 24h) on a timer — long enough to
cover any realistic reconnect window, short enough to keep the table small. Reuse the existing reaper
pattern (cf. `ProviderSessionReaper`).

## Acceptance criteria

- [ ] Dispatching the same `commandId` + payload twice applies the effect once and returns identical results both times.
- [ ] Dispatching the same `commandId` with a changed payload returns `IdempotencyPayloadMismatch`.
- [ ] A simulated crash between "apply" and "store result" does not leave a poisoned dedup row (transactional).
- [ ] Idempotency rows are pruned after the retention window.
- [ ] Existing single-dispatch behavior is unchanged (no perf regression on the hot path — one indexed insert).

## Risks / open questions

- Some commands carry large payloads (e.g. image attachments already materialized to disk by
  `normalizeDispatchCommand`). Hash the *normalized* command which references files by path, not bytes —
  confirm normalization happens before hashing so the hash is stable and small.
- Decide whether `result_payload` should store the full projection delta or just an ack. Start with the
  minimal ack the client needs to resolve its pending promise.
