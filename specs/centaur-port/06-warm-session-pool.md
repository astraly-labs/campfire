# Spec 06 — Warm session pool (evict-on-startup)

| | |
|---|---|
| **Status** | Draft |
| **Size** | M (3–5 days) |
| **Depends on** | none |
| **centaur source** | `warm_pool.py` — pre-spawned idle sandboxes eliminate ~15s cold-start; on API restart it **evicts** warm pods rather than adopting them, because pre-existing instances run stale image/overlay refs (correctness-over-latency) |

## Problem

campfire spawns a provider session (Codex/Claude/OpenCode app-server child process) **on demand** the
first time a thread needs one (`makeManagedServerProvider.ts`, `ProviderSessionDirectory`), and
`ProviderSessionReaper` tears idle ones down. So the first turn on a new thread pays the full process
spawn + protocol handshake cost as user-visible latency — exactly when the user is most attentive.

## Goal

Keep a small pool of pre-warmed, idle provider sessions per provider instance so a new thread can **claim**
one instantly instead of cold-starting. On server restart, **evict** any leftover warm sessions rather
than adopting them, so the first post-restart claim always runs current code/config.

### Non-goals

- Pre-warming per *thread* (threads aren't known ahead of time) — pool is keyed by provider instance config.
- Sharing a warm session's *conversation* across threads — a claimed session is bound to exactly one thread
  and reset; the pool warms the *process + handshake*, not state.

## Design

**Pool service.** New `apps/server/src/provider/Services/WarmSessionPool.ts` (Effect service):

- Config: `warmPoolSize` per provider instance (default small, e.g. 1; 0 disables → today's behavior).
- Maintains N idle sessions per instance: spawned, handshaked, *unbound* to any thread.
- `claim(providerInstanceId, threadId)` → hands an idle session to `ProviderSessionDirectory`, binds it to
  the thread, and asynchronously refills the pool. Cache miss (empty pool) → fall back to on-demand spawn.

**Evict-on-startup.** On boot, before warming, terminate any sessions the pool might have left behind
(stale child processes / runtime rows from a prior process). Rationale, straight from centaur: a warm
session spawned by the *old* binary may run a stale model/skill/prompt config; adopting it risks serving
the first user a stale agent. Evict + re-warm guarantees freshness. (campfire is deployed by restarting the
Mac-mini backend on update — exactly the scenario this protects.)

**Lifecycle hooks:**

- Bind on claim: reset session to a clean per-thread state (clear any handshake-time scratch, set cwd to
  the thread's worktree).
- Reaper coordination: `ProviderSessionReaper` must not reap *pool* sessions as if idle-abandoned; tag pool
  sessions so the reaper skips them (or the pool owns their lifecycle entirely).

**Validity:** a warm session that fails its handshake or dies while idle is discarded and replaced; never
hand a sick session to a thread.

## Acceptance criteria

- [ ] With `warmPoolSize ≥ 1`, the first turn on a brand-new thread observably skips the cold-start spawn cost.
- [ ] Claiming from the pool triggers an async refill back to target size.
- [ ] Empty pool falls back to on-demand spawn (no user-facing failure).
- [ ] On server restart, pre-existing warm sessions are evicted, not adopted; the first post-restart claim runs current config.
- [ ] The reaper does not kill pool-owned idle sessions.
- [ ] `warmPoolSize = 0` reproduces exactly today's on-demand behavior.

## Risks / open questions

- Resource cost: each warm session is a live child process holding RAM. Default the pool small; make it
  per-instance so expensive providers can stay at 0.
- Binding correctness: a pooled session was spawned without a thread context — confirm cwd/worktree and any
  per-thread init can be applied *after* spawn for each provider, else pre-warming buys nothing for that provider.
- Interaction with Spec 08 generations: a claimed session starts a fresh assignment generation for its thread.
