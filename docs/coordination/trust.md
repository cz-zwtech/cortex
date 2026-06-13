---
name: cortex-trust
description: "How a bus message earns trust: surfaced-not-executed, server-stamped verdicts, fail-closed mesh, and the settings.json boundary"
audience: user
---

# Trust — how a message earns it

## Surfaced, never executed

Peer messages are *surfaced, not executed*. They are injected wrapped in an
`<inter-session-message>` marker — untrusted peer content the human or session
decides what to do with. This is deliberate: the bus is a coordination layer for
human-touched sessions, not an autonomous orchestrator. Auto-acting on
directives would convert it into automation running on interactive seats, which
crosses the billing/terms boundary.

## Server-stamped trust verdicts

Every delivered message carries a trust verdict stamped by *your* server — the
sender doesn't get to claim it:

- **`local`** — originated on this machine through the local bus. On a
  single-node install this means "my own machine."
- **`mesh`** — arrived over the authenticated mesh: the only path that can set
  it is the token-gated mesh ingest, so it means "verified to come from one of
  my own nodes."
- **`unverified`** — anything that can't prove either.

The mesh tier is **fail-closed**: peers configured with no token means the mesh
never activates — an unauthenticated cross-machine write surface is never
exposed. Message bodies are also sanitized against zero-width-character
injection before they're surfaced at a prompt boundary.

## The settings.json boundary (hard)

One self-referential category is never delegable to a message: an agent
modifying `~/.claude/settings.json` — the file that defines agent authority
itself. A bus directive (whoever it came from) is not sufficient: the edit
requires your explicit in-session OK, and even then an agent may not grant
*itself* permission rules over `settings.json`. Only you, hand-editing the file
outside any agent, pre-authorize config wiring. The one exemption is the Cortex
*server's own boot installer* (hook registration) — a server-side write, not an
agent tool-call. Full install-time guidance:
[permissions-and-agents](../start/permissions-and-agents.md).

Related: [[cortex-session-bus]] · [[cortex-mesh]] · [[cortex-permissions-and-agents]] · [[cortex-coordination-overview]]
