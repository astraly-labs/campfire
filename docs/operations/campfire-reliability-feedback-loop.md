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

Status: confirmed

Unit-level orchestration tests are insufficient to detect connection-level head-of-line blocking, replay gaps, or cross-client leakage; a five-client WebSocket harness with controllable slow and disconnected consumers will expose those regressions deterministically.

Expected signal:

- The harness can pause one consumer, disconnect another, retry commands, and verify all five final snapshots against the durable event log.
- Baseline resource and latency measurements are emitted in machine-readable form.

Validation:

- Command/query: focused server integration tests plus the opt-in `pnpm soak:campfire` command.
- Dataset/window: five authenticated clients, independent threads, at least 1,000 catch-up events for the narrow test and 60 minutes for soak validation.
- Control/baseline: one-client run using the same command mix.

Result:

- Added a production-WebSocket-boundary fixture with five concurrent clients over a 1,000-event durable global catch-up. Each client disconnected after 100 thread events, resumed from its last applied cursor, received the remaining 100 plus a synchronization marker, and ended with the exact expected 200 strictly ordered sequences, no duplicates, and no cross-thread events.
- One resumed client consumed every item with an artificial delay while the other four completed independently. Every event-store read remained capped at the captured head (`limit <= 1,000`); no live buffer or moving-tail scan was allowed to grow without bound.
- Added a five-user Google OIDC fixture that establishes five distinct authenticated WebSockets and forces five first-send worktree creations to overlap. It proved five unique worktree paths, five server-derived Google subjects, five distinct revocable session IDs, and p95 local acknowledgement below the 500 ms acceptance threshold.
- Added a zero-browser provider fixture that starts five independent Codex sessions from five worktree paths without creating any WebSocket or browser subscriber.
- Added `pnpm soak:campfire [seconds]`, which repeats the five-client reconnect/worktree and zero-browser provider gates and emits a machine-readable JSON completion summary. A one-cycle validation passed all four selected gates.

Decision:

- Keep five clients as a first-class release oracle. The deterministic harness is required in CI/release validation; the 60-minute real-Google/real-Codex run remains a staging promotion gate because it requires the Mac mini, Tailnet identities, and production OAuth credentials.

Next:

- Run the 60-minute command on the staged Mac mini and attach real network/resource measurements before replacing the existing deployment.

### H3: Server-derived identity prevents spoofed authorship

Status: confirmed

Authorship and presence can be derived at the authenticated WebSocket boundary without trusting client-supplied user fields. Tailscale Serve identity headers are safe only when the backend is loopback-only and the immediate peer is loopback.

Expected signal:

- Client-supplied authorship is ignored or rejected.
- Direct requests with forged Tailscale headers do not change identity.
- Authenticated loopback-proxied requests map to one stable user identity and revocable application session.

Validation:

- Command/query: focused trusted-Tailscale-header resolver, orchestration attribution, and WebSocket dispatch tests.
- Dataset/window: direct LAN/Tailnet request fixtures, loopback Serve fixtures, missing/encoded header fixtures, and reconnecting sessions.
- Control/baseline: archived `campfire/v0` identity behavior.

Result:

- Added a server-owned `OrchestrationEventActor` to durable event metadata. The orchestration engine accepts attribution out-of-band from the decoded command, overwrites decided-event actor metadata, and persists subject, display name, application session ID, and optional network login with every client event.
- The WebSocket boundary now derives that actor exclusively from its verified session. A focused RPC fixture observed `kind=client`, the server-issued `desktop-bootstrap` subject, and a real server session ID; no client command field participates in authorship.
- Added a Tailscale Serve identity resolver that trusts `tailscale-user-*` headers only when Serve is explicitly enabled, the configured backend host is loopback-only, and the immediate socket peer is loopback. It normalizes mapped IPv4, bounds header lengths, and normalizes login casing.
- Direct tailnet-origin forged headers, wildcard-bound backends, and Serve-disabled loopback requests all resolved to no Tailscale identity. An enabled loopback WebSocket resolved `Alice@Example.com` to the stable actor subject `tailscale:alice@example.com` with display/network attribution.
- The first WebSocket attribution fixture failed before dispatch because its synthetic workspace path did not exist; switching the fixture to the real test workspace reached the intended oracle and passed.
- Focused auth/contract/engine/server validation passed 4 files and 177 tests in 4.41 seconds. Targeted lint passed with zero warnings/errors; contracts and server typechecks passed with only the same three pre-existing `decider.ts` suggestions.

Decision:

- Keep actor context out of the client command schema and trust Tailscale headers only at the proven Serve hop. This makes authorship non-spoofable at the application boundary and gives Google OIDC a stable subject slot without coupling authorization to client-presented identity.

Next:

- Integrate Google OIDC subject mapping, allowlisting, nonce/state validation, and revocable browser-session issuance on this server-derived identity boundary.

### H4: Google OIDC plus Tailscale reduces onboarding risk without coupling agent lifetime to login

Status: implemented; live staging pending

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

- Implemented authorization-code OIDC with PKCE S256, nonce, one-time state, a browser-bound HttpOnly transaction cookie, a 10-minute TTL, a 128-transaction cap, Google signature/issuer/audience verification, verified-email enforcement, and an explicit normalized email allowlist. Google access and refresh tokens are never persisted.
- Successful callbacks issue the existing 30-day revocable Campfire browser session with administrative scopes, stable `google:<sub>` authorship, display-name attribution, session inventory visibility, HttpOnly/SameSite=Lax cookies, and Secure cookies in HTTPS deployments. Callback return paths are restricted to local absolute paths.
- Hosted web auth now advertises only `google-oidc` when configured and renders a Google sign-in action instead of a shared pairing-token form. Desktop bootstrap remains available only in desktop mode.
- Deterministic flow tests rejected state/browser-binding replay, open redirects, non-allowlisted identities, incomplete/insecure configuration, and callback replay. The HTTP integration test completed login/callback, authenticated the issued session, found the Google subject in session inventory, and observed the same Google subject/display name at WebSocket command dispatch.
- Focused regression validation passed 6 files and 163 tests in 4.50 seconds. Contracts, server, and web typechecks passed; targeted lint reported zero warnings/errors. A live Google staging flow and explicit zero-browser Codex lifetime run remain deployment gates.

Decision:

- Keep Google tokens ephemeral and use the existing server-owned session store as the only steady-state credential. Tailscale remains the private network boundary; Google identity supplies human attribution and application-level revocation without owning provider-process lifetime.

Next:

- Validate a real Google client through Tailscale Serve, revoke an active browser session, and prove an in-flight Codex turn survives browser disappearance before promoting this hypothesis to confirmed.

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

### H11: Bounded volatile presence can stay collaborative without touching agent delivery

Status: confirmed

Presence is useful only as a latest-state hint. A process-owned, session-keyed map with a hard capacity, TTL eviction, monotonic snapshot revisions, and a one-frame sliding broadcast can show who is viewing or typing without adding durable events, replay work, or backpressure to Codex command/event paths.

Expected signal:

- Five users see current thread focus and short-lived typing state within one heartbeat interval.
- A stalled presence subscriber receives only the newest full snapshot and never blocks heartbeats, WebSocket RPCs, or orchestration delivery.
- Disconnect and TTL expiry remove stale sessions; forged client identity fields are impossible because heartbeat payloads contain focus only.

Validation:

- Command/query: focused presence state-machine tests plus authenticated multi-WebSocket RPC fixtures.
- Dataset/window: duplicate human sessions, focus changes, typing expiry, disconnect, TTL expiry, capacity pressure, and one intentionally stalled subscriber.
- Control/baseline: archived `campfire/v0` unbounded PubSub presence implementation.

Result:

- Added schema-only presence heartbeat/snapshot contracts and authenticated WebSocket RPCs. The heartbeat accepts only thread focus and typing state; subject, display name, network login, and session ID are derived from the verified server session.
- The process-owned service has a hard 64-connection cap, 15-second presence TTL, 4-second typing TTL, deterministic full snapshots, and a capacity-one sliding PubSub. A stalled subscriber observed revisions `[0, 3]`, proving intermediate volatile states coalesce without blocking producers.
- Presence is tracked internally per WebSocket connection and projected per authenticated session. A duplicate-session fixture kept the human visible when one of two sockets disconnected, fell back to the surviving socket's focus, and removed the user only after the last socket dropped.
- Capacity pressure evicted the oldest connection, typing expired independently, and disconnect removed state immediately. Repeated identical heartbeats refreshed TTL without incrementing the visible revision or broadcasting frames.
- Added a client-runtime subscription and a latest-only heartbeat lane per environment. The web client sends every two seconds, signals typing immediately on transition, and renders deterministic avatars for viewers of the active task; neither transport backlog nor React render frequency can create an unbounded heartbeat queue.
- A real Google OIDC WebSocket fixture proved the presence snapshot used `google:alice-stable-subject`, `Alice Example`, and the authenticated session ID rather than client-supplied identity.
- Focused validation passed the four presence state-machine tests, the Google OIDC/WebSocket integration fixture, the web presentation tests, contracts/client-runtime/server/web typechecks, and targeted lint with zero warnings or errors (apart from the three pre-existing server typecheck suggestions).

Decision:

- Keep presence volatile, bounded, and outside the orchestration event log. Losing an intermediate presence frame is correct; the next full snapshot or heartbeat repairs it, while Codex command and event delivery remain isolated.

Next:

- Rebuild SideThreads on the already bounded durable orchestration command/event path instead of restoring the archived standalone queues and replay loop.

### H12: SideThreads can reuse the durable orchestration aggregate without a second runtime

Status: confirmed

A side conversation anchored to an agent message can be modeled as commands and events on its parent orchestration thread. Reusing the existing bounded command mailbox, SQLite event log, projection pipeline, detail snapshots, and fail-and-resume stream should make collaboration durable without restoring v0's independent unbounded queues, full-log bootstrap, or client-authored identity.

Expected signal:

- Creating, posting, and archiving a SideThread produces ordered parent-thread events and survives a projection rebuild/reconnect.
- The event author comes from authenticated event metadata; SideThread commands contain no author field.
- Existing detailed-thread snapshot fallback and 512-frame live buffer apply unchanged under slow subscribers.
- The UI can open a message-anchored drawer and exchange human messages without sending anything to Codex.

Validation:

- Command/query: decider/projector/reducer fixtures, real authenticated WebSocket dispatch/replay, and focused UI state/presentation tests.
- Dataset/window: duplicate IDs, missing anchors, archived conversations, reconnect from a prior sequence, and concurrent messages serialized through one parent-thread lane.
- Control/baseline: archived `campfire/v0` standalone SideThread event store, projection tables, unbounded command queue, and unbounded subscription PubSubs.

Result:

- Added schema-only SideThread commands/events and kept them on the parent thread aggregate. Create, post, and archive therefore inherit the existing durable command receipt, per-thread serial scheduler, ordered SQLite event log, 512-frame live buffer, cursor replay, and detail-snapshot fallback without adding a queue, provider session, or runtime.
- The client command schemas contain no identity fields. The decider requires a verified client actor, records the server-derived Google subject/display name, rejects missing anchors, duplicate IDs, archived posts, and missing actors, and bounds each parent to 256 SideThreads and each SideThread to 500 messages.
- Added a SQLite `side_threads_json` read projection with an idempotent migration defaulting existing rows to `[]`. A projection bootstrap from six durable events reconstructed the created conversation, Google authors, message, timestamps, and archive state; the snapshot query then decoded the same typed structure for clients. Restarting the isolated development server applied migration 34 successfully.
- Added the message-anchored web drawer, durable composer, archive control, and typing-presence integration. Opening or posting never invokes Codex; commands use the existing serial parent-thread lane and optimistic identity is never accepted.
- A real Google OIDC WebSocket fixture sent a forged `createdBy` field and proved it was stripped before dispatch while the verified `google:alice-stable-subject` actor remained attached to the envelope.
- Validation passed all 180 server test files (1,590 tests, seven skipped), including migration, projection rebuild/snapshot, decider/projector, authenticated WebSocket, restart/replay, and bounded transport coverage. Focused web and client-runtime SideThread tests passed, repository-wide lint had zero errors, and all package typechecks passed apart from pre-existing Effect suggestions.
- Browser-driven visual QA could not run because the in-app browser runtime exposed no browser instance in this session; deterministic component state/presentation coverage passed and this does not affect the durable path proof.

Decision:

- Keep SideThreads as parent-thread orchestration data and delete the architectural need for v0's standalone runtime. The durable event log remains the source of truth; SQL JSON is only a rebuildable read projection.

Next:

- Exercise the complete system with five authenticated concurrent clients, independent worktree threads, slow/reconnecting consumers, and zero-browser agent continuation under measurable latency/resource thresholds.

### H13: Production signals make regressions diagnosable before users report frozen threads

Status: confirmed

The bounded architecture is operationally useful only if the Mac mini reports command pressure,
client catch-up decisions, slow-consumer failures, scheduler stalls, and the complete provider
process tree.

Expected signal:

- Operators can distinguish a slow network client, an overloaded command worker, a stalled event
  loop, a provider process leak, and a failed resume from metrics/traces without reproducing the UI.
- Connection/resource gauges return to baseline after the corresponding work ends.

Validation:

- Command/query: deterministic metric updates, live WebSocket acquire/release, bounded replay, and
  subscription overflow fixtures.
- Dataset/window: server plus Codex descendant samples, 25 ms synthetic scheduler lag, one bounded
  overflow, one incremental resume, and one complete WebSocket lifecycle.
- Control/baseline: the pre-Campfire metrics set, which had command/provider timers but no
  WebSocket, resume, event-loop, or process-tree signals.

Result:

- Added authenticated active/total WebSocket metrics with scope-safe decrement on disconnect.
- Added labeled resume decisions (`replay` vs `snapshot`, bounded gap vs cursor ahead/too large),
  replay span counts, and bounded subscription overflow counters without thread-ID metric
  cardinality.
- Extended the existing five-second process monitor with server RSS/heap and combined descendant
  RSS/CPU/process-count gauges. Added a one-second event-loop drift sampler.
- Focused fixtures observed the WebSocket gauge return to baseline, exactly one incremental resume
  over ten durable events, exactly one thread-buffer overflow, RSS/heap/tree values from synthetic
  server+Codex rows, and 25 ms event-loop lag.
- Added `/healthz` for liveness and `/readyz` for command-startup plus projection-query readiness;
  both are no-store and the latter returns 503 without leaking a cause.

Decision:

- Export these metrics through the existing optional OTLP path and retain traces locally. Alert
  thresholds start conservative and must be tuned from the staged 60-minute run.

Next:

- Capture p50/p95/p99, maximum lag/queue/RSS, and reconnect outcomes on the actual Mac mini.

### H14: Immutable staged releases plus online backups make Mac mini promotion recoverable

Status: implemented; live staging pending

An additive migration is not a safe deployment plan by itself. An immutable release layout,
secondary Tailscale Serve port, exact Google callback, readiness gate, transactional backup, and
fresh-directory rollback can prevent a failed candidate from corrupting the currently deployed
service.

Expected signal:

- A candidate can run on an unoccupied secondary Serve port without moving production port 443 or
  its data directory.
- A live SQLite backup passes `PRAGMA integrity_check` and restores independently.
- launchd restarts the pinned release without exposing the backend beyond loopback.

Validation:

- Command/query: shell syntax, plist validation, temporary SQLite backup/restore, and health-route
  integration tests.
- Dataset/window: one live WAL-capable database, runtime state, worktree directory, and immutable
  release template.
- Control/baseline: ad-hoc development server against the user's existing `~/.t3` database.

Result:

- Added a loopback-only launch wrapper with required secret/config validation and a launchd template
  pinned to an immutable `current` release symlink.
- Added a live backup script using SQLite's online backup operation, non-log runtime/worktree copy,
  integrity manifest, and mode-0600 archive. A temporary archive restored `durable` from the copied
  database and reported `database_integrity=ok`.
- Added the complete Mac mini runbook: dedicated account/FileVault, Google web client and exact
  callbacks, Tailscale Serve/no Funnel, isolated staging port, five-client promotion gate, health/alerts,
  encrypted backups, application/database rollback, and the explicit trusted-superadmin threat
  model.
- Verified the plist with `plutil`, both shell scripts with `sh -n`, and the health/readiness routes
  through the real HTTP router seam.

Decision:

- Never migrate or replace the existing deployment directly. Stage against a separate base
  directory and Serve port, then promote only the immutable symlink after real Google/Codex soak.

Next:

- Supply production Google credentials/MagicDNS and run the documented staging gate; no code path
  should bypass that external validation.

### H15: Patched production dependencies and presented-origin checks close ambient browser risks

Status: confirmed

Tailscale reachability and a valid application cookie are not sufficient if a malicious browser
origin can reuse that cookie, or if the deployed dependency graph contains known remotely relevant
vulnerabilities. Every presented browser origin must therefore be same-authority or explicitly
configured, and the production lockfile must pass a repeatable advisory gate.

Expected signal:

- Cross-site WebSocket handshakes and authenticated HTTP requests using a browser-session cookie
  fail before reaching an RPC or state-changing handler.
- Same-origin, exact Google redirect, configured Vite, desktop, and origin-less native clients
  continue to work.
- The production dependency audit reports no known advisories, including the server's Undici,
  Hono, and fast-uri paths.

Validation:

- Command/query: pure origin matrix, real HTTP/WebSocket router fixtures, frozen install,
  `bun run audit:prod`, repository typecheck/tests/build.
- Dataset/window: malicious, malformed, credentialed, path-bearing, same-authority, Google, Vite,
  desktop, and missing origins; all production dependencies in the current lockfile.
- Control/baseline: 27 production advisories (13 high) and no WebSocket Origin enforcement.

Result:

- Added one shared presented-origin validator. Missing Origin remains valid for native clients; a
  supplied Origin must exactly match the request authority or the configured Google/Vite/desktop
  origin. Length, whitespace, credentials, paths, invalid schemes, and malformed authorities are
  rejected.
- Browser-session-cookie HTTP authentication and every WebSocket upgrade now apply the validator
  before an authenticated handler runs. Real router fixtures accepted same-origin WebSocket use and
  rejected malicious-origin HTTP and WebSocket cookie reuse.
- Added bounded production overrides for patched Undici 7/8, Hono, fast-uri, js-yaml, Sharp,
  shell-quote, SVGO, brace-expansion, and UUID releases, plus the patched Astro release. The frozen
  lockfile installs successfully and `bun run audit:prod` reports no known vulnerabilities.
- All 1,610 server tests passed after the dependency and origin changes; all package typechecks and
  the production build passed. The focused origin suite passed five tests.

Decision:

- Keep the audit command as a release gate and reject presented browser origins by default. Do not
  weaken the check to trust forwarded headers; only configured origins and the actual request Host
  participate.

Next:

- Exercise the exact Google staging origin through Tailscale Serve port 10000 and retain the audit
  result with the promoted release record.

### H16: An executable release gate prevents unsafe manual promotion

Status: confirmed

The remaining non-Google deployment risk is operational: the runbook describes safe staging and
rollback, but the operator can still source an insecure environment file, run an unsupported Node
version, point staging at production data, or move the release symlink without a durable gate
record. A fail-closed preflight and atomic release switch should make those mistakes mechanically
detectable before the real Google/five-user gate.

Expected signal:

- Environment validation rejects insecure permissions, missing builds, unsupported Node versions,
  malformed Google callbacks, invalid allowlists, unsafe ports, and staging/production data reuse.
- Staging evidence is emitted as an append-only machine-readable record containing the commit,
  upstream relation, health/readiness, deterministic soak result, and explicit human-gate status.
- Promotion and rollback change only an explicit `current` symlink, preserve the previous target,
  and refuse unbuilt or ambiguous release paths.

Validation:

- Command/query: focused POSIX-shell fixtures, `sh -n`, `plutil -lint`, one short deterministic soak
  cycle, and temporary release/config/database directories.
- Dataset/window: secure/insecure env files, fake Node 24/25 executables, distinct/colliding data
  directories, two built release fixtures, and one backup/restore fixture.
- Control/baseline: H14 runbook plus launch/backup scripts with manual preflight, promotion, and
  evidence capture.

Result:

- Added a fail-closed environment preflight that checks mode/owner before sourcing, requires a built
  release and Node 24.13.1+, validates one-to-five unique Google identities and the exact Tailnet
  callback/Serve-port pair, rejects overlapping code/data paths, and prevents staging from reusing
  production data or ports.
- Added guarded atomic promotion/rollback. Temporary symlinks are renamed in the same directory,
  only built absolute releases are accepted, a non-symlink `current` is refused, and the displaced
  target is retained as `current.previous`.
- Hardened online backup against source/destination overlap and made SQLite integrity a hard gate.
  Added restore-to-new-directory with archive path validation, temporary extraction, and SQLite
  verification before the restored directory becomes visible.
- Extended the deterministic soak summary with commit, Node version, upstream relation, human-gate
  status, and promotion eligibility. An optional JSONL target is mode `0600`; the machine gate
  always records `humanGateStatus: "pending"` and `eligibleForPromotion: false`.
- Temporary fixtures passed secure/insecure env validation, Node 24/25 discrimination, callback and
  data-isolation failures, two-release promote/rollback, live SQLite backup/restore, plist parsing,
  POSIX syntax, and ShellCheck. A real one-cycle focused soak passed three five-client server cases
  plus the zero-browser provider case under Node 24.18.0 and emitted a mode-0600 non-promotable
  record for commit `3ff4616cf` at upstream relation `0/13`.
- Installed Homebrew Node 24.18.0 at its keg-only path and enabled the pnpm 11.10.0 Corepack shim on
  the Mac mini. The existing Tailscale handlers on 8443/8444 were not changed.

Decision:

- Use the executable preflight, evidence writer, release switch, and restore command as mandatory
  operator gates. Machine tests may prove deterministic readiness but may never authorize promotion
  without the separate real-Google/five-person record.

Next:

- Install the Google client/allowlist in the mode-0600 env file, run staging on ports 3774/10000,
  complete the real 60-minute five-person gate, then promote and merge.
