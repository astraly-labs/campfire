# Campfire multiplayer reliability feedback loop

Date: 2026-07-22

Starting commit: `e5fba263e6820350e4edc7e5d93955aabef53df1`

Goal: make one Mac mini environment predictably usable by five concurrent Campfire users without lost or duplicated commands, cross-thread event leakage, browser-dependent agent lifetimes, or unbounded latency and resource growth.

## Acceptance targets

- Zero lost or duplicate command effects across 10,000 idempotent dispatch attempts with retries.
- Zero cross-thread events across five concurrent clients operating independent worktree threads.
- Local server command acknowledgement p95 below 100 ms and p99 below 250 ms, excluding provider/model latency.
- Reconnect and catch-up p95 below 2 seconds after 1,000 missed orchestration events on a local network.
- A disconnected or deliberately slow client does not increase another client's command acknowledgement p95 by more than 20%.
- Browser disconnect, refresh, or replacement never cancels an active Codex turn.
- Server memory reaches a steady bound during a 60-minute five-client soak; queues and catch-up pages remain within configured limits.

These are initial engineering thresholds. A measured Mac mini baseline may tighten them, but weakening one requires an explicit decision recorded here.

## Oracle

- Ground truth: the SQLite orchestration event log and command-receipt table, compared with authoritative projected thread snapshots after workers drain.
- Independent observations: client-received sequence cursors, RPC acknowledgements, provider runtime receipts, process resource metrics, and Codex app-server lifecycle events.
- Why it is trusted: durable events and receipts are written at the server command boundary and can be checked independently of any one browser's cached state.
- Known limits: a green projection comparison does not alone prove good latency or bounded resource use; provider/model latency must be separated from Campfire transport and orchestration latency.

## Baseline

- Command/query: `corepack pnpm exec vp test run apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts apps/server/src/server.test.ts packages/client-runtime/src/rpc/client.test.ts packages/client-runtime/src/connection/supervisor.test.ts packages/client-runtime/src/state/threads-sync.test.ts`.
- Dataset/window: current upstream at the starting commit; deterministic test clock where available.
- Result: 5 files and 174 tests passed in 4.99 seconds. Cursor resume, transport replacement, snapshot race buffering, shell catch-up fallback, and reconnect behavior have focused coverage.
- Residual risk: the command queue, event PubSub, per-subscription live buffers, and detailed-thread catch-up are unbounded. Existing tests prove individual state machines without exercising five simultaneous authenticated clients or slow consumers through the production WebSocket boundary.

## Hypotheses

### H1: Current upstream is a sound reliability base

Status: invalidated

The current upstream orchestration and client runtime already enforce command receipt deduplication, bounded catch-up, cursor-based subscription resume, and transport replacement strongly enough to replace the old Campfire transport path rather than port it.

Expected signal:

- Focused upstream tests pass without modification.
- Every accepted command has one durable receipt and one ordered event effect under retry.
- Subscription replacement resumes from the last applied sequence without snapshot regression.

Validation:

- Command/query: run focused tests for `OrchestrationEngine`, server WebSocket catch-up, client RPC session replacement, connection supervisor, and thread synchronization.
- Dataset/window: deterministic fixtures in `apps/server` and `packages/client-runtime`.
- Control/baseline: document missing five-client and slow-consumer coverage before adding a Campfire harness.

Result:

- All 174 focused tests passed.
- The server already falls back to a shell snapshot when the global sequence gap exceeds 1,000 and clients deduplicate replay overlap by sequence.
- `OrchestrationEngine` still uses an unbounded command queue and unbounded event PubSub.
- Both shell and thread subscriptions use unbounded per-client live buffers.
- Detailed-thread resume calls `readEvents(afterSequence, Number.MAX_SAFE_INTEGER)`, so one stale client can initiate an effectively unbounded global event scan before filtering to one thread.

Decision:

- Keep upstream as the replacement architecture, but reject the claim that it already satisfies Campfire's bounded-load invariants. Close each unbounded path with a separate hypothesis and regression test.

Next:

- Bound detailed-thread catch-up first because it is deterministic, directly reachable by a stale client, and already has a proven shell-level fallback pattern.

### H2: A production-boundary five-client harness exposes the old failure class

Status: proposed

Unit-level orchestration tests are insufficient to detect connection-level head-of-line blocking, replay gaps, or cross-client leakage; a five-client WebSocket harness with controllable slow and disconnected consumers will expose those regressions deterministically.

Expected signal:

- The harness can pause one consumer, disconnect another, retry commands, and verify all five final snapshots against the durable event log.
- Baseline resource and latency measurements are emitted in machine-readable form.

Validation:

- Command/query: to be added as a focused server integration test and an opt-in soak command.
- Dataset/window: five authenticated clients, independent threads, at least 1,000 catch-up events for the narrow test and 60 minutes for soak validation.
- Control/baseline: one-client run using the same command mix.

Result:

- Pending.

Decision:

- Pending.

Next:

- Implement after H1 identifies the exact coverage gap.

### H3: Server-derived identity prevents spoofed authorship

Status: proposed

Authorship and presence can be derived at the authenticated WebSocket boundary without trusting client-supplied user fields. Tailscale Serve identity headers are safe only when the backend is loopback-only and the immediate peer is loopback.

Expected signal:

- Client-supplied authorship is ignored or rejected.
- Direct requests with forged Tailscale headers do not change identity.
- Authenticated loopback-proxied requests map to one stable user identity and revocable application session.

Validation:

- Command/query: focused identity resolver and WebSocket dispatch tests.
- Dataset/window: direct LAN/Tailnet request fixtures, loopback Serve fixtures, missing/encoded header fixtures, and reconnecting sessions.
- Control/baseline: archived `campfire/v0` identity behavior.

Result:

- Pending.

Decision:

- Pending.

Next:

- Integrate Google OIDC subject mapping after the trust boundary is explicit.

### H4: Google OIDC plus Tailscale reduces onboarding risk without coupling agent lifetime to login

Status: proposed

Google OIDC can replace shared pairing credentials while preserving long-lived, revocable server sessions. Tailscale remains the network gate; OIDC authenticates the human at the application layer; neither browser token refresh nor browser disconnect owns Codex process lifetime.

Expected signal:

- An allowlisted Google identity can onboard without copying a pairing secret.
- A non-allowlisted identity, invalid state/nonce, forged callback, or revoked session cannot open HTTP or WebSocket APIs.
- Existing Codex turns continue after browser logout/disconnect, while new commands require a valid session.

Validation:

- Command/query: deterministic OIDC callback/session tests using a fake provider plus one manual Google staging flow.
- Dataset/window: success, denial, replay, expiry, revocation, multi-device, and server restart cases.
- Control/baseline: current pairing-token onboarding and session inventory.

Result:

- Pending.

Decision:

- Pending.

Next:

- Choose the smallest standards-compliant OIDC integration that fits the existing environment auth service.

### H5: Snapshot fallback bounds detailed-thread catch-up without losing events

Status: confirmed

Capturing the authoritative head before detailed-thread replay, limiting replay to that fixed gap, and falling back to a fresh thread snapshot when the gap is invalid or exceeds 1,000 removes the unbounded scan while the pre-attached live buffer preserves events published during synchronization.

Expected signal:

- A gap above 1,000 or a cursor ahead of the server emits a thread snapshot and never calls event replay.
- A valid gap calls event replay with exactly the captured finite gap, then emits the synchronization marker and buffered live tail.
- Existing snapshot-race and client sequence-deduplication tests remain green.

Validation:

- Command/query: focused `apps/server/src/server.test.ts` subscription tests, followed by the H1 test group.
- Dataset/window: gaps of 10, 1,001, a cursor ahead of head, and a live event published while snapshot/replay is in flight.
- Control/baseline: current `Number.MAX_SAFE_INTEGER` detailed-thread replay.

Result:

- Added regression cases for a 100,000-versus-5 stale cursor, a cursor ahead of the authoritative head, and a valid 10-event gap.
- The two invalid/large gaps emitted a fresh thread snapshot and made zero replay calls.
- The valid gap passed a replay limit of exactly 10, then emitted the synchronization marker.
- `corepack pnpm exec vp test run apps/server/src/server.test.ts`: 115 tests passed in 4.40 seconds.
- The broader H1 group passed 177 tests in 4.51 seconds after the change.

Decision:

- Keep the fixed-head finite replay and 1,000-event snapshot fallback. It removes the unbounded detailed-thread scan without weakening resume correctness.

Next:

- Address slow-consumer live buffers independently; snapshot fallback alone does not bound an indefinitely connected slow client.

### H6: Fail-and-resume isolates a slow detailed-thread subscriber

Status: confirmed

A fixed-capacity dropping buffer can preserve all queued events until capacity, then fail only that subscription on overflow. The existing client retry loop can resume after 250 ms from its last applied sequence, avoiding both silent drops and server-wide producer backpressure.

Expected signal:

- Offering beyond capacity never blocks the orchestration producer and causes one explicit overflow failure after already-queued items drain.
- The affected subscription terminates with a typed synchronization error instead of dropping an event silently.
- Other subscriptions and command dispatch remain independent.
- The existing client test for same-session recovery from a transient domain failure remains green.

Validation:

- Command/query: focused unit test for the bounded live buffer, server subscription tests, and client same-session recovery tests.
- Dataset/window: a capacity-two deterministic unit fixture plus production buffer capacity of 512 thread stream items.
- Control/baseline: current unbounded per-thread `Queue`.

Result:

- Added a reusable fixed-capacity live subscription buffer backed by a dropping queue. It accepts every item up to capacity without blocking the producer; the first rejected offer terminates only that queue with a typed failure after the accepted backlog drains.
- Detailed-thread subscriptions now use a capacity of 512 items and surface `OrchestrationGetSnapshotError` on overflow. The client runtime already retries expected stream failures after 250 ms with the latest applied sequence, so recovery goes through the bounded replay-or-snapshot path from H5.
- The capacity-two unit fixture received `[1, 2]` in order and then the exact overflow failure after a third offer; a non-overflow fixture remained open and delivered both accepted items.
- `corepack pnpm exec vp test run apps/server/src/orchestration/liveSubscriptionBuffer.test.ts apps/server/src/server.test.ts packages/client-runtime/src/state/threads-sync.test.ts`: 3 files and 131 tests passed in 4.43 seconds.
- Targeted formatting and lint passed with zero errors or warnings. `corepack pnpm exec vp run --filter t3 typecheck` passed; it reported only three pre-existing Effect suggestions in `decider.ts`.

Decision:

- Keep fail-and-resume rather than blocking or silently dropping. A slow detailed-thread browser is now isolated by a fixed memory bound, while its durable cursor gives it a deterministic recovery path.

Next:

- Apply the same invariant to shell subscriptions and add overflow observability before bounding the engine-wide PubSub.

### H7: Fail-and-resume preserves shell synchronization ordering under overflow

Status: confirmed

The same fixed-capacity buffer can isolate a slow shell/sidebar subscriber without weakening the existing completion-marker invariant. Draining the accepted batch after queuing the marker keeps all pre-marker events before `synchronized`; if the marker or an event overflows, the stream must omit a false synchronization claim and fail after the accepted backlog so the client resumes from its durable shell cursor.

Expected signal:

- A bounded shell buffer drains accepted raw events in order, then propagates its typed overflow failure.
- Under normal capacity, the completion marker stays after every event accepted before it.
- One slow shell subscriber never blocks global orchestration publication or other subscribers.
- Existing shell snapshot-race, replay, and completion-marker tests remain green.

Validation:

- Command/query: extend the buffer unit test for batch draining, then run focused server shell subscription and client thread-synchronization tests.
- Dataset/window: a capacity-two deterministic overflow fixture plus production capacity of 2,048 raw global events before coalescing.
- Control/baseline: current unbounded shell `Queue` and existing 50 ms/512-item coalescing window.

Result:

- Extended the bounded buffer with a typed `takeAll` batch drain. A capacity-two fixture drained `[1, 2]` in order after overflow, then propagated the exact terminal error on the next take.
- Shell subscriptions now buffer at most 2,048 raw global events per client before the existing 50 ms/512-item aggregate coalescer. Overflow fails only that subscription with `OrchestrationGetSnapshotError`; normal completion markers are offered and drained through the same ordered queue as before.
- If an already-full queue rejects the synchronization marker, no false `synchronized` item is emitted: the accepted backlog drains, the stream fails, and the client retries from its last shell sequence.
- `corepack pnpm exec vp test run apps/server/src/orchestration/liveSubscriptionBuffer.test.ts apps/server/src/server.test.ts packages/client-runtime/src/state/threads-sync.test.ts`: 3 files and 132 tests passed in 4.41 seconds.
- Targeted lint passed with zero errors or warnings. Server typecheck passed with only the same three pre-existing Effect suggestions in `decider.ts`.

Decision:

- Keep the 2,048-item fail-and-resume shell bound. It preserves completion-marker ordering without allowing one sidebar subscriber to retain memory indefinitely or backpressure global publication.

Next:

- Expose overflow counters and investigate the engine-wide unbounded event PubSub separately.

### H8: A bounded command mailbox gives overload a finite, explicit outcome

Status: confirmed

Replacing the engine's unbounded command queue with a fixed-capacity mailbox and a finite enqueue deadline prevents request bursts from retaining unlimited command/deferred state. Normal commands remain serialized and durable; sustained overload fails before acceptance with a typed retryable error rather than waiting forever or silently discarding a command.

Expected signal:

- Up to 256 waiting commands preserve FIFO order and existing receipt deduplication behavior.
- A command that cannot enter the mailbox within two seconds fails explicitly and is never processed later.
- Cancelling a timed-out offer removes it from the queue safely.
- Queue depth is exported as a gauge and returns to zero after the worker drains.

Validation:

- Command/query: deterministic capacity-one mailbox tests with a virtual clock, then the focused orchestration-engine suite.
- Dataset/window: one accepted item, one timed-out offer, and existing storage-failure/deduplication/metrics fixtures; production capacity 256 and enqueue timeout two seconds.
- Control/baseline: current unbounded command `Queue`.

Result:

- Added a reusable bounded FIFO command mailbox. A capacity-one deterministic fixture proved that a waiting producer preserves FIFO order when capacity frees, while a second fixture advanced the virtual clock through the admission deadline and proved the rejected item was never processed later.
- The first mailbox test invocation failed before executing tests because Effect v4 exposes `TestClock` from `effect/testing`, not `effect/TestClock`; correcting the import made the intended deterministic test run.
- The orchestration engine now admits at most 256 waiting command envelopes. An offer still blocked after two seconds fails with `OrchestrationCommandQueueFullError`, including the real command ID, capacity, and timeout; the worker remains serialized and existing durable receipt semantics are unchanged.
- Added `t3_orchestration_command_queue_depth` and `t3_orchestration_command_queue_rejections_total`. The focused engine metric fixture observed queue depth return to zero after dispatch.
- `corepack pnpm exec vp test run apps/server/src/orchestration/commandMailbox.test.ts apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts apps/server/src/server.test.ts packages/client-runtime/src/rpc/client.test.ts packages/client-runtime/src/connection/supervisor.test.ts packages/client-runtime/src/state/threads-sync.test.ts`: 6 files and 179 tests passed in 4.50 seconds.
- Targeted lint passed with zero warnings or errors; server typecheck passed with only the three pre-existing Effect suggestions in `decider.ts`.

Decision:

- Keep the 256-item/two-second admission boundary and explicit pre-acceptance error. It bounds retained command state and makes overload safely retryable with the same command ID rather than silently dropping or executing a timed-out offer later.

Next:

- Replace the unbounded event PubSub with a bounded durable wake-up feed rather than dropping domain events.

### H9: A one-slot wake-up feed can remain lossless through durable replay

Status: confirmed

The engine does not need to retain every domain event separately for every live subscriber because SQLite already is the authoritative ordered log. A capacity-one sliding PubSub can carry only the newest committed sequence as a wake-up signal; each subscriber then reads the exact missing range from its private cursor. Coalesced wake-ups should bound memory without losing or reordering events, and publication should never wait for a slow subscriber.

Expected signal:

- A subscriber blocked after its first event later receives every intervening persisted event in sequence even though all wake-ups coalesce to one slot.
- A fast subscriber continues receiving while another is blocked.
- Event publication remains non-blocking and the in-memory PubSub retains at most one sequence signal per subscriber.
- Transient durable-read failures retry from the last emitted sequence rather than duplicating the successful prefix.

Validation:

- Command/query: focused durable-feed unit fixtures plus an orchestration-engine integration fixture with fast and deliberately blocked subscribers.
- Dataset/window: consecutive synthetic sequences with a mid-range read failure, then a real thread receiving a burst while one subscriber is paused.
- Control/baseline: current unbounded event PubSub containing full `OrchestrationEvent` objects per subscriber.

Result:

- Replaced the full-event unbounded PubSub with a capacity-one sliding sequence wake-up feed. Each subscription captures a race-safe initial cursor/head pair, then reads only its missing durable range; later wake-ups coalesce while the subscriber is busy.
- The first implementation attempt exposed two invalid Effect v4 assumptions: `Stream.unwrapScoped` does not exist, and a PubSub subscription is not a `Queue` consumable by `Stream.fromQueue`. The resulting focused runs failed before the oracle could execute (then one timed out). Switching to `Stream.unwrap` and a repeated `PubSub.take` produced the intended scoped subscription.
- A synthetic fast/blocked subscriber fixture coalesced four pending wake-ups into the one-slot signal while both subscribers still received sequences `[1, 2, 3, 4, 5]` exactly once and in order.
- A durable-read fixture emitted sequence 1, failed mid-range, retried from the updated cursor, and produced `[1, 2, 3]` without duplicating the successful prefix. The retry counter observed one read error.
- A real engine integration fixture blocked one subscriber after its first event while dispatching 20 thread updates. The fast subscriber completed independently; after release, the blocked subscriber replayed exactly the same 20 strictly increasing sequences from SQLite.
- Added `t3_orchestration_event_feed_read_retries_total` and a 100 ms retry interval for transient event-store failures.
- The expanded reliability group passed 7 files and 182 tests in 4.55 seconds. Targeted lint passed with zero warnings/errors and server typecheck passed with only the three pre-existing `decider.ts` suggestions.

Decision:

- Keep the durable one-slot wake-up architecture. It gives event delivery a fixed in-memory bound per subscriber, preserves the database as the oracle, and removes slow-subscriber backpressure from command publication without dropping domain events.

Next:

- Bound the drainable reactor workers that currently absorb this stream into their own unbounded queues.

### H10: Bounded reactor workers propagate safe backpressure into durable feeds

Status: confirmed

Internal reactors should not copy the now-bounded durable event feed into unbounded worker queues. A bounded drainable worker can suspend its producer when full: domain-event producers then stop pulling and later replay from SQLite via H9, while runtime-event producers retain backpressure instead of growing the worker heap. No internal event should be rejected or dropped.

Expected signal:

- A worker with capacity one processes FIFO and keeps a third enqueue suspended until space is released.
- `drain` still resolves only when every admitted item has completed.
- Existing provider-command, runtime-ingestion, checkpoint, deletion, and relay tests remain green with a finite default capacity.
- Reactor failures continue to be isolated by each reactor's existing safe processor and do not kill the worker loop.

Validation:

- Command/query: deterministic `DrainableWorker` backpressure/drain fixtures followed by focused tests for every production consumer.
- Dataset/window: capacity-one blocked processor for the primitive; production default capacity 1,024.
- Control/baseline: current shared `TxQueue.unbounded` implementation.

Result:

- Changed the shared worker from `TxQueue.unbounded` to a bounded FIFO `TxQueue` with a production default of 1,024 and an explicit capacity override for focused tests.
- A capacity-one fixture blocked the first processor, admitted a second item, and proved a third producer remained suspended until capacity freed. After release, `drain` waited for all three and the observed order was exactly `first`, `second`, `third`.
- No rejection/drop path was added: backpressure propagates to the source stream. For domain events that source is H9's durable cursor feed, so coalesced wake-ups replay later from SQLite rather than accumulating in the worker.
- Focused production-consumer validation passed 7 files and 108 tests covering `DrainableWorker`, provider command/runtime ingestion (including approvals), checkpoints, thread deletion, and agent-awareness relay.
- Targeted lint passed with zero warnings/errors. Shared and server typechecks passed; server output contained only the same three pre-existing `decider.ts` suggestions.

Decision:

- Keep the 1,024-item bounded backpressure default. It removes every unbounded queue created through `makeDrainableWorker` while preserving FIFO, drain semantics, and lossless internal processing.

Next:

- Inventory remaining unbounded browser-facing terminal/preview queues and separate lossy output from durable control messages.
