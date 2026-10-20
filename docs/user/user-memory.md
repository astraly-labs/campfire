# Message authors and user memory

When several people use one environment with Google sign-in, the agent knows who sent each message, and it can remember things about each person.

## Message author

Each message from a signed-in person starts with a short block that names the sender:

```text
[Message from: Alice (alice@example.com)]
```

The block is added to each message, so in a thread that many people share, the agent sees the correct sender every time. This includes a message that steers someone else's running turn.

Messages from the CLI, a paired device, or another agent get no block. Slash commands such as `/compact` also get no block, so the provider still runs them.

## User memory

Each signed-in person has one memory note. When the note is not empty, it follows the author block on each of that person's messages:

```text
[Message from: Alice (alice@example.com)]
[User memory for Alice:
Prefers French replies.
]
```

To change your memory, ask the agent. For example, "Remember that I prefer French replies" or "Forget my preferences." The agent uses the `memory_read` and `memory_update` tools of the T3 Code MCP server, and it writes memory only when you ask it to. A note can be up to 4,000 characters.

The tools always act on the memory of the person who sent the current message. The agent cannot pick another person.

## Limits

- Memory is not private. The injected text stays in the thread's context, so the agent and other people in the same thread can see it in later turns. Do not put secrets in memory.
- The email shows only while you have an active Google sign-in on the environment.
