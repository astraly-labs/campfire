# Spec 12 — Org overlay (extend the fork without diverging)

| | |
|---|---|
| **Status** | Draft |
| **Size** | M (3–5 days) |
| **Depends on** | none (pairs well with [09](./09-personas.md) — personas are overlay-providable) |
| **centaur source** | Overlay system (`docs/pages/extend/overlay.mdx`): one overlay *image* mounted into both API and sandbox; `TOOL_DIRS`/`WORKFLOW_DIRS` are colon paths where later entries **override** earlier; cleanly separates the open-source platform from proprietary company logic — extend without forking |

## Problem

campfire **is** a hand-maintained internal Pragma fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code)
(stated in `specs/architecture/SPEC.md`). Pragma-specific changes (branding, prompts, future personas/tools,
side-threads config) are woven directly into the forked source. Every upstream merge risks conflicts, and
there's no clean line between "platform we track upstream" and "our org's stuff". This is precisely the
problem centaur's overlay solves — and it's arguably the **most strategically valuable** idea to port,
because it changes the *maintenance cost of the fork itself*.

## Goal

Introduce an **overlay mechanism**: a single, well-defined place where Pragma-specific configuration,
prompts, personas, and (later) tools are layered **on top of** the upstream-tracked base, with a clear
override precedence — so the base can be merged from upstream with minimal conflict and org logic lives in
one cohesive, separable location.

### Non-goals

- Replatforming onto a plugin runtime. campfire is a single Effect server, not a multi-image deploy —
  the overlay is a *resolved config + content layer*, not a mounted container image.
- Building a tool-plugin system from scratch (campfire drives native provider protocols). The overlay's
  first job is config/prompts/personas; arbitrary org tools are a later extension.

## Design

**Overlay source.** A single overlay directory (path from config / env, e.g. `CAMPFIRE_OVERLAY_DIR`),
defaulting to an in-repo `overlay/` that holds Pragma's specifics. Structure mirrors what it can override:

```
overlay/
  branding.json         # name, theme, favicon — overrides environmentApi defaults
  personas/*.json       # Spec 09 personas, org-provided
  prompts/*.md          # system-prompt overlays (per persona / global)
  settings.defaults.json# default provider instances, sandbox/approval policy
```

**Resolution precedence.** Establish one rule, applied everywhere overlay-able config is read: **base
value, then overlay value wins** (later overrides earlier), matching centaur's colon-path `TOOL_DIRS`
semantics. Implement as a small `resolveWithOverlay(baseLoader, overlayLoader)` utility (Effect layer) so
every consumer (branding, personas, default settings, prompt assembly) resolves the same way — DRY, one
override rule, unit-tested.

**Integration points (initial):**
- `environmentApi` branding → overlay `branding.json`.
- Persona registry (Spec 09) → load base personas, then overlay `personas/`.
- Prompt assembly (Spec 09's `[Active deployment]` block) → overlay `prompts/` can supply org prompt text.
- Default server settings (provider instances) → overlay `settings.defaults.json`.

**Fork hygiene payoff.** Once org specifics live under `overlay/`, the rest of the tree tracks upstream
t3code closely. Document a merge runbook: "merge upstream into base; overlay rarely conflicts." This is the
deliverable's real value — measured by *reduced merge-conflict surface*, not a user-facing feature.

## Acceptance criteria

- [ ] A single `resolveWithOverlay` utility exists, is unit-tested, and is the only place override precedence is defined.
- [ ] Branding, personas, default settings, and prompts all resolve base-then-overlay through it.
- [ ] With an empty overlay, behavior is identical to base (upstream) defaults.
- [ ] Pragma's current fork-specific config is migrated into `overlay/` and removed from inline base code.
- [ ] A documented runbook shows merging an upstream change touching a base file without touching overlay.

## Risks / open questions

- Drawing the base/overlay line: be conservative initially (config + prompts + personas), expand only when
  a clear seam appears. Over-abstracting now would itself become a maintenance burden.
- Some current fork changes are genuinely *base* changes (side-threads, presence) that Pragma intends to
  keep regardless of upstream — those stay in base; only *org-config* belongs in the overlay. Classify
  existing fork deltas explicitly during migration.
- Secrets must never live in the overlay dir if it's committed — keep credentials in existing auth storage.
