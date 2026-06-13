---
name: cortex-coordination-overview
description: "Your Claude sessions as a virtual team sharing one mind — presence and messaging on one machine and across every machine you own"
audience: user
---

# Session coordination — a virtual team, one mind

## What it is

Every Cortex session registers presence and can message every other session —
on this machine (the [session bus](session-bus.md)) and across your fleet (the
[mesh](mesh.md)). Together they make your sessions a *virtual team that shares
one mind*: any session can ask a peer instead of rediscovering, and what one
learns, all can recall.

## The model (read this before the mechanics)

- **Machines are extensions of you.** A session you start IS your voice on that
  machine. The trust model is built on that: interactive launch is your green
  light, and coordination flows between *your* sessions.
- **Peer content is surfaced, never executed.** Messages arrive wrapped as
  untrusted content; you (or your session, with judgment) decide what to act
  on. See [trust](trust.md).
- **This is never cross-human.** Other people subscribe to memories you publish
  to the [team mind](../minds/team-mind.md); they do not join your mesh. The
  mesh is yours alone.

## What it degrades to

Full mesh → relay through a reachable peer → single-machine bus → solo session
with file-backed memory. Every rung works on its own; each rung above adds
reach. A single-machine install just lives on the lower rungs.

## The pieces

- [session-bus](session-bus.md) — same-machine presence, addressing, delivery,
  the real-time watcher, the statusline indicator
- [mesh](mesh.md) — cross-machine membership, joining a node, roaming
- [trust](trust.md) — how a message earns trust; the hard boundaries

Related: [[cortex-session-bus]] · [[cortex-mesh]] · [[cortex-trust]] · [[cortex-private-mind]] · [[cortex-team-mind]]
