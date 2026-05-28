# Spec 03 — Canonical events + stable tool-call IDs

| | |
|---|---|
| **Status** | Draft |
| **Size** | M (3–5 days) |
| **Depends on** | none |
| **centaur source** | Harness-agnostic event normalization (`packages/harness-events/src/normalize.ts` + 1:1 Python port `sandbox/normalize.py`); tool-call IDs made **stable via SHA-1 of sorted-key JSON** (`_stable_tool_call_id`) so the same call dedups deterministically across reconnects/harnesses |

## Problem

campfire already normalizes provider output into a canonical `OrchestrationEvent`
(`apps/server/src/orchestration/Normalizer.ts`, schemas in `packages/contracts/src/orchestration.ts`),
across Codex / Claude / OpenCode / Cursor drivers (`apps/server/src/provider/Drivers/`). But **tool-call
identifiers are provider-assigned and ephemeral** — they're preserved verbatim in the event payload.
Consequences:

- The same tool call streamed, then re-observed after a reconnect or session resume, can't be reliably
  deduped because its id may differ (or be absent) across renders.
- Cross-provider UI code can't key on a stable identity (e.g. to collapse a tool-call card and its result).
- Diffing / projection logic has to special-case each provider's id scheme.

## Goal

Give every normalized tool call (and its paired result) a **deterministic, provider-independent stable
ID**, derived from the call's content, so identical calls always hash to the same id regardless of
provider or how many times they're observed.

### Non-goals

- Re-architecting the normalizer or the event schema beyond adding the stable id.
- Changing what counts as a "tool call" per provider (that mapping stays in the drivers).

## Design

**Canonical JSON helper.** Add a shared `canonicalJson(value)` to `packages/shared` (sorted keys, no
insignificant whitespace, stable number formatting) — the same primitive used by [01](./01-idempotent-command-dispatch.md)
for `request_hash`. One implementation, reused. Unit-test it against key-order and whitespace permutations.

**Stable id derivation.** In the normalizer, when emitting a tool-call event, compute:

```
stableToolCallId = sha256(canonicalJson({
  threadId,
  turnId,
  toolName,
  input,            // the normalized tool input
  ordinalWithinTurn // tiebreaker for genuinely identical repeated calls in one turn
}))                 // hex, truncated to a readable length (e.g. 16 bytes)
```

`ordinalWithinTurn` is the count of prior calls in the same turn with an identical `(toolName, input)` —
this disambiguates a model that legitimately calls the same tool with the same args twice, while still
being deterministic on replay (the ordinal is reproducible from the event stream).

Carry both ids on the event: the provider's raw id (kept for debugging / provider round-trips) **and**
`stableToolCallId` (the one UI and dedup logic key on).

**Where:**

- `Normalizer.ts` computes `stableToolCallId` at emit time.
- Add the field to the tool-call (and tool-result) event schema in `packages/contracts/src/orchestration.ts`.
- Tool-result events reference the same `stableToolCallId` as their call so the UI can pair them.
- The projection pipeline (`ProjectionPipeline` / `ProjectionSnapshotQuery`) keys tool-call/result merging
  on `stableToolCallId`.

**Migration.** This is additive on the event schema; old events simply lack the field. Decide: backfill on
read (compute lazily for historical events) or leave historical events without it (UI falls back to the
provider id). Recommend lazy fallback — no destructive migration.

## Acceptance criteria

- [ ] `canonicalJson` is in `packages/shared`, unit-tested, and reused by Spec 01's hashing.
- [ ] Every newly-emitted tool-call and tool-result event carries `stableToolCallId`.
- [ ] The same logical tool call observed twice (live + replay) produces the same `stableToolCallId`.
- [ ] Two identical-arg calls in one turn get distinct, reproducible ids via `ordinalWithinTurn`.
- [ ] Stable ids are consistent across at least Codex and Claude drivers for an equivalent call.
- [ ] UI/projection pairs a tool call with its result via `stableToolCallId`.

## Risks / open questions

- Defining "the normalized tool input" consistently across providers is the crux — if two providers
  describe the same call with structurally different inputs, their stable ids won't match. Accept
  per-provider stability as the floor; cross-provider stability is best-effort and only matters where the
  same thread switches providers mid-stream (rare).
- Truncating the hash trades collision resistance for readability; 16 bytes is ample for per-turn scope.
