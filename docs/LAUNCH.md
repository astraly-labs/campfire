# Campfire launch kit

## Positioning

**Run coding agents with your team, not next to them.**

Campfire is an open-source shared workspace for small, trusted teams running coding agents together across projects and machines. It is a deliberately thin fork of T3 Code.

## Launch post

> Campfire is open source: a shared workspace for small, trusted teams running coding agents together. Built as a deliberately thin fork of T3 Code, with huge thanks to @theo, @jullerino, and every upstream contributor.
>
> https://github.com/astraly-labs/campfire

## Launch thread

1. Most multiplayer agent tools put agents back into chat. Campfire takes the opposite bet: bring your teammates into the agent workspace where the work already happens.
2. Campfire gives a small, trusted team one shared workspace for long-running agent threads across projects and machines. See every teammate's runs, who is watching, and the decisions beside the work.
3. Take a Look brings the right teammate into the exact thread, where they can talk to the same agent. Campfire also adds a team discussion, inbox, presence, PR review chats, private briefings, and shared controls.
4. The boundary is intentional: no RBAC, tenant isolation, or granular permissions. Everyone connected is trusted and can act on the team's work. Only invite people you would already trust with repository access.
5. Campfire changes as little as possible so rebasing onto T3 Code stays straightforward. The runtime, provider integrations, remote architecture, and core clients remain upstream work.
6. Huge thanks to the T3 Code team, especially @theo, @jullerino, and every upstream contributor. Campfire is an independent community fork, not an official or endorsed T3 Code release: https://github.com/astraly-labs/campfire

## Ready assets

Use a fictional team throughout: **Northwind Labs**, with **Ada Okafor**, **Ben Roy**, and **Priya Shah**, working in `northwind/api`. Never capture real repositories, people, conversations, hostnames, or credentials.

| Asset                                                                                       | Visible proof                                    | Caption                             |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------- |
| [`docs/assets/campfire-app-thread.png`](./assets/campfire-app-thread.png)                   | Active thread, project list, authors, and branch | One room for your team's agent work |
| [`docs/assets/campfire-app-team-discussion.png`](./assets/campfire-app-team-discussion.png) | Agent transcript and human conversation together | Discuss the run, in the run         |
| [`apps/marketing/public/campfire-feature-reveal.mp4`](../apps/marketing/public/campfire-feature-reveal.mp4) | 15-second H.264/AAC launch film | Bring teammates into the agent workspace |
| [`apps/marketing/public/og.png`](../apps/marketing/public/og.png)                           | 1200x630 social card                             | Open source · Built on T3 Code      |

The product captures are 1600x1000 and use only isolated synthetic data. Capture the team inbox and a dark-mode variant only if the launch channel needs them.

Regenerate the launch film on macOS with `swift scripts/render-campfire-launch.swift`. Its music is synthesized in the renderer; it uses no samples or third-party audio.

## 15-second launch film

| Time    | Beat                                                     | Proof                                  |
| ------- | -------------------------------------------------------- | -------------------------------------- |
| 0-2s    | Campfire positioning                                     | The agent workspace was already here   |
| 2-3s    | Shared task sidebar                                      | Every teammate's threads in one place  |
| 3-6s    | Take a Look pings Ben from an agent answer               | Bring in the person who can unblock it |
| 6-9s    | Ben opens the notification and lands in the exact thread | Context survives the handoff           |
| 9-11s   | Ben joins and sends a direction to the same agent         | The run is truly shared                |
| 11-13s  | Team discussion opens beside the agent transcript         | Human context stays with the work      |
| 13-15s  | End card and T3 Code credit                              | Thin fork, clear upstream credit       |

## 45-second demo

| Time   | Action                                                                | Overlay                              |
| ------ | --------------------------------------------------------------------- | ------------------------------------ |
| 0-5s   | Open `northwind/api` with three active tasks and two presence avatars | Your team's agent work, in one place |
| 5-12s  | Ada starts “Fix flaky auth tests”                                     | Start a run                          |
| 12-20s | Ben opens the same task and writes in the team discussion             | Talk beside the work                 |
| 20-27s | Ben uses Take a Look to mention Priya                                 | Bring in the right teammate          |
| 27-34s | Ada interrupts, corrects, and resumes the run                         | Interrupt. Redirect. Resume.         |
| 34-40s | Show two worktrees and a remote environment                           | Real branches. Real machines.        |
| 40-45s | Campfire name, tagline, and T3 Code attribution                       | Open source. Built on T3 Code.       |

Final voiceover: “Campfire is an open-source shared workspace for coding agents, built on T3 Code for small teams that already trust each other.”
