# Message authors and user memory

When several people use one environment with Google sign-in, the agent knows who sent each message.

## Message author

Each turn starts with a short block that names the sender:

```text
[Message from: Alice (alice@example.com)]
```

The block is added per turn, not per session. One thread can have messages from many people, and the agent sees the correct sender on each turn.

Messages from CLI, desktop pairing, or other sessions without Google sign-in get no block.

## User memory

Each signed-in person has one memory note. When the note is not empty, it follows the author block on each turn from that person:

```text
[Message from: Alice (alice@example.com)]
[User memory for Alice:
Prefers French replies.
]
```

To change your memory, ask the agent. For example: "Remember that I prefer French replies." or "Forget my preferences." The agent uses the `memory_read` and `memory_update` tools of the T3 Code MCP server. The agent must write memory only when you ask it to.

The tools always act on the memory of the person who sent the latest message in the thread. The agent cannot select another person. The limit is 4,000 characters.

## Limits

- Memory is injected, not private. The injected text stays in the thread context, so other people in the same thread and the agent can see it in later turns. Do not put secrets in memory.
- The email shows only when the author dispatched the turn from their own signed-in session.
