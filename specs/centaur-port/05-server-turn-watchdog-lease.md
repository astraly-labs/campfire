# Spec 05 — Server-side tiered turn watchdog + lease reclaim

| | |
|---|---|
| **Status** | Draft |
| **Size** | M (3–5 days) |
| **Depends on** | [04](./04-inflight-turn-persistence.md) (needs persisted turn intent to reclaim) |
| **centaur source** | Watchdog with three timeout tiers (`runtime_control.py`: silence 600s / tool-silence 1800s / hard deadline 3600s + stream-break counting) and Postgres-as-queue worker **leases** with a watchdog that reclaims dead leases (`_claim_next_execution`, `worker_lease_expires_at`, `migration 011`) |

## Problem

campfire's only stuck-turn detection is **client-side** (`apps/web/src/stuckTurnWatchdog.ts`): two tiers
(120s with no tokens, 300s after tokens), checked every 5s, no RPC, purely a UI state flip. Two gaps:

1. **No server authority.** If every client is closed, a wedged turn is never noticed; the provider process
   can hang indefinitely. The server doesn't distinguish "model thinking" from "long tool running" from
   "genuinely hung."
2. **No reclaim.** After a restart, an `inflight_turn` (Spec 04) sits in `running` forever — nothing leases,
   times out, or re-drives it.

## Goal

Move turn liveness to the **server**, with centaur's three-tier discrimination, and add a **lease +
watchdog** so a crashed/stalled turn is detected and either re-driven or failed cleanly — with no client
attached.

### Non-goals

- Removing the client watchdog (keep it as a fast local UX hint; the server becomes the source of truth).
- Multi-process work-stealing (single shared backend; this is in-process liveness, not a distributed queue).

## Design

**Three tiers** (config-driven, defaults adapted to local agents which run longer than cloud tools):

| Tier | Resets on | Default | Meaning |
|---|---|---|---|
| `silenceTimeout` | any event from the session | 120s | model produced nothing at all |
| `toolSilenceTimeout` | tool start/output events | 600s | a long-running tool is legitimately working |
| `hardDeadline` | never | 1800s | absolute cap regardless of activity |

Plus a **stream-break counter**: repeated provider stream errors within a turn escalate to failure even
before a timeout. (centaur's lesson, captured in `call.sh`: a too-short timeout trains agents to give up; a
too-long one hides hangs — hence three tiers rather than one.)

**Lease.** Add `lease_expires_at` to the `inflight_turn` row (Spec 04). The component running a turn holds
the lease and renews it on each event. A server-side watchdog fiber (Effect; new
`apps/server/src/orchestration/Services/TurnWatchdog.ts`) scans periodically:

- lease expired (e.g. crash, no renewer) → the turn is orphaned. Apply the **reclaim policy**:
  - if turn is re-drivable and under a retry budget → re-drive via Spec 04's recovery path.
  - else → emit `thread.turn-failed` (timeout) so clients and the projection converge.
- lease alive but a tier exceeded → emit an interrupt to the provider (the existing interrupt path, cf.
  Codex `SIGINT`/`interrupt`), then fail the turn if it doesn't stop.

**Single-flight per thread:** the lease doubles as the "one active turn per thread" guard (aligns with
`ProviderSessionDirectory`'s one-session-per-thread). A reclaim re-spawns a session for that thread only
after the prior lease is provably dead.

**Events:** the watchdog emits real orchestration events (`turn-interrupted` / `turn-failed` /
`turn-redriven`) so the client watchdog's local guesses are superseded by authoritative server state.

## Acceptance criteria

- [ ] A turn that emits nothing for `silenceTimeout` is interrupted/failed by the server even with no client connected.
- [ ] A turn running a slow tool (events flowing) is *not* killed before `toolSilenceTimeout` / `hardDeadline`.
- [ ] After a simulated crash mid-turn, the watchdog detects the expired lease and either re-drives (Spec 04) or fails the turn within one scan interval.
- [ ] Repeated provider stream errors escalate to failure before the hard deadline.
- [ ] No double-execution: a reclaim never runs concurrently with a still-alive lease (verified under a contrived race).
- [ ] Client `stuckTurnWatchdog` is reconciled by the authoritative server event (no permanently-diverging UI state).

## Risks / open questions

- Retry budget for re-drive: cap at 1–2 to avoid a crash-loop hammering the provider on a poison turn.
  Track attempt count on the `inflight_turn` row.
- Tuning defaults: local Codex/Claude turns can legitimately be quiet during long compiles; lean generous
  on `toolSilenceTimeout` and rely on `hardDeadline` as the real cap.
- Interrupt reliability: confirm each driver (Codex/Claude/OpenCode) honors an interrupt; for those that
  don't, fall back to killing the session process and failing the turn.
