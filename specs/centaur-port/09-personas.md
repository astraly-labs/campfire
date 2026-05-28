# Spec 09 — Personas (engine + prompt + tools bundle)

| | |
|---|---|
| **Status** | Draft |
| **Size** | M (3–5 days) |
| **Depends on** | [08](./08-assignment-generation.md) (a persona switch = a new generation) |
| **centaur source** | Personas switch engine + prompt + tools per thread (`sandbox/prompt_assembly.py`); plus the `[Active deployment]` self-introspection block declared authoritative and verifiable, which forbids the agent from confabulating its own configuration |

## Problem

campfire only has **per-instance model selection** (`instanceId` + `model` + optional `options`) — verified:
no notion of a *persona*, i.e. a reusable named bundle of {engine/model + system prompt + enabled/disabled
tools + defaults}. Teams re-pick the same combos by hand, and there's no way to say "this thread is the
*reviewer*" vs "the *implementer*" as a first-class, switchable unit. centaur also bakes a deployment
self-description into the prompt so the agent can't claim "I have no special configuration" when it does —
a real failure mode.

## Goal

Add **personas**: named, reusable bundles of agent configuration that can be selected per thread, switching
the agent's engine + system prompt + tool surface in one move. Switching a persona bumps the thread's
assignment generation (Spec 08). Inject an authoritative, verifiable deployment block into the agent prompt.

### Non-goals

- Per-tool credential scoping (that's the parked iron-proxy work — see README *Future notes*).
- A persona marketplace / sharing UI; start with workspace-local personas.

## Design

**Persona definition** (stored in settings / a `personas` table; also overlay-providable per [12](./12-org-overlay.md)):

```
persona(
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  provider_instance TEXT NOT NULL,     -- engine: reuses existing instance selection
  model           TEXT,                -- optional override
  system_prompt   TEXT,                -- prepended / overlaid persona prompt
  enabled_tools   TEXT,                -- allow/deny list over the provider's skills
  defaults        TEXT                 -- canonical-JSON of runtime defaults (sandbox mode, approval policy)
)
```

**Selection.** A thread references a `persona_id` on its active assignment row (Spec 08). Selecting/changing
a persona calls `spawnAssignment(threadId, { personaId })` → new generation, rebound session. Expose via a
new `orchestration` command + a persona picker in the thread UI (sits beside today's model picker).

**Prompt assembly — authoritative deployment block.** Borrow centaur's discipline: when starting the
session for a persona-bound thread, prepend an `[Active deployment]` block as the *first* content the agent
sees, stating its persona name, engine, and enabled tools, declared authoritative over any base prompt, and
instructing the agent not to claim "no persona/config" without checking. Provide a runtime verification
affordance (a way for the agent to echo its active persona) so the statement is checkable, not just asserted.

**Driver mapping.** Persona fields map onto existing driver knobs:
- `model`/`provider_instance` → existing model selection,
- `enabled_tools` → existing per-instance skill enable/disable,
- `system_prompt` → provider's system-prompt / instructions channel (per driver),
- `defaults` → sandbox mode + approval policy already in the provider instance config.

So personas are mostly a *composition + naming + generation* layer over machinery that exists.

## Acceptance criteria

- [ ] A persona can be defined (name + engine + prompt + tool allow/deny + defaults) and listed.
- [ ] Selecting a persona on a thread bumps the assignment generation and rebinds the session with the persona's config.
- [ ] The agent's session is started with the persona's system prompt and tool surface actually applied.
- [ ] The `[Active deployment]` block appears first and the agent can verify/echo its active persona.
- [ ] Switching persona mid-thread doesn't corrupt history: prior turns stay attributed to their generation (Spec 08).

## Risks / open questions

- Prompt-channel parity across drivers: Codex/Claude/OpenCode expose system-prompt injection differently;
  define a per-driver mapping and degrade gracefully where a channel is limited.
- Overlap with the existing model picker: decide whether model selection becomes "pick a persona" or stays
  a separate quick-switch. Recommend keeping both — persona for the bundle, model picker for a quick tweak
  (which, per Spec 08, may or may not bump the generation).
- Tool allow/deny must be enforced server-side, not just hidden in UI.
