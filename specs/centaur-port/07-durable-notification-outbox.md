# Spec 07 — Durable notification delivery (outbox)

| | |
|---|---|
| **Status** | Draft |
| **Size** | M (3–5 days) |
| **Depends on** | none |
| **centaur source** | Outbox pattern for final delivery (`agent_final_delivery_outbox`, states `awaiting_terminal → pending → sending → retry_wait → delivered → dead_letter`, with a lease + `next_attempt_at`) — decouples "produced" from "actually received", with retries and dead-lettering for an unreliable channel |

## Problem

Inbox / mention / reaction notifications are delivered **purely as live WebSocket push**
(`InboxReadModel`, `subscribeInbox` in `ws.ts`): `mentionsStream` + `dismissalsStream` merge into
`upserted`/`removed` events pushed to connected clients. If the recipient is **offline**, the notification
is lost — they can re-derive current state via `inbox.list` on reconnect, but **transient signals are not
replayed**, and there's no path to push beyond the live socket (e.g. an OS/mobile push notification when the
app is closed). For a multiplayer tool where teammates peer-prompt asynchronously, a silently-dropped
"@you" is a real miss.

## Goal

Introduce a durable **outbox** for user-directed notifications so each notification has an at-least-once
delivery guarantee with retries and dead-lettering, independent of whether the recipient is connected at
emit time — and a clean seam for future out-of-band channels (OS notification, mobile push).

### Non-goals

- The full orchestration event stream (already durable + replayable — that's [02](./02-reconnect-replay-contract.md)).
- Building the actual mobile-push transport now — this spec lands the *outbox + in-app delivery*; external
  channels plug into the same `sending` step later.

## Design

**Outbox table** (migration, next free id):

```
notification_outbox(
  id              TEXT PRIMARY KEY,
  recipient_id    TEXT NOT NULL,
  kind            TEXT NOT NULL,        -- 'mention' | 'reaction' | 'sidethread-activity' | ...
  payload         TEXT NOT NULL,        -- canonical-JSON of the notification
  state           TEXT NOT NULL,        -- pending | sending | retry_wait | delivered | dead_letter
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,              -- backoff schedule
  lease_expires_at INTEGER,             -- claim guard (mirrors Spec 05 lease idea)
  created_at      INTEGER NOT NULL,
  delivered_at    INTEGER
)
```

**Producer.** Where `InboxReadModel` currently emits a live event (mention created, etc.), *also* write a
`pending` outbox row in the same transaction as the side-thread event (transactional outbox — the
notification can't exist without the event that caused it, and vice versa).

**Dispatcher.** New `apps/server/src/sidethreads/Services/NotificationDispatcher.ts` (Effect fiber):

1. Claim due rows (`state ∈ {pending, retry_wait}` and `next_attempt_at ≤ now`) under a lease.
2. Attempt delivery: if the recipient has a live subscription, push as today and mark `delivered`.
3. If not connected (or push fails), increment `attempts`, set `retry_wait` + exponential `next_attempt_at`.
4. After a max-attempt budget, move to `dead_letter` (surfaced in diagnostics, never silently dropped).
5. On reconnect, `subscribeInbox` drains any `pending`/`retry_wait` rows for that user immediately.

This makes "offline → reconnect" lossless for inbox items, and gives a single place to bolt on an
out-of-band channel (step 2/3) when the user is offline past a threshold.

**Idempotent client apply:** notifications carry the outbox `id`; the client dedups on it (a redelivered
"@you" after a flaky push doesn't double-badge).

## Acceptance criteria

- [ ] Mentioning an *offline* user creates a `pending` outbox row; on their reconnect they receive it exactly once.
- [ ] Producing a notification and writing its outbox row are atomic (no event without notification, no orphan notification).
- [ ] Failed deliveries retry with backoff and land in `dead_letter` after the budget — visible in diagnostics.
- [ ] A redelivered notification is deduped client-side via its outbox `id`.
- [ ] Live (online) delivery latency is unchanged for the common case.

## Risks / open questions

- Scope creep into a general pub/sub: keep it to *user-directed* notifications, not the thread event stream.
- Retention: prune `delivered` rows after a window; keep `dead_letter` longer for debugging.
- Defining "offline past a threshold" for the future external-channel hook — leave a TODO seam, don't build it here.
