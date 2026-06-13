---
name: cortex-team-mind
description: "The team mind: hand-picked memories shared with other Cortex users through a git repo — selective, attributed, never the mesh"
audience: user
---

# Team mind (the shared mind)

The team mind is how **other people** benefit from what your Cortex knows. You
hand-pick a memory — a tool setup, a gotcha, a "do it this way" — and publish it
to a git repo your teammates subscribe to. Their Claude sessions then surface it
at the right moment: *"actually, you should do it this way, per <author>."* One
person figures out the painful setup; everyone's sessions inherit the lesson.

Three properties are load-bearing:

- **Selective.** Nothing is shared unless you explicitly publish it. This is the
  opposite of the [private mind](private-mind.md), which syncs *everything*
  across *your own* machines.
- **Attributed and quarantined.** Imported memories land in scope
  `shared:<name>`, marked as shared content — surfaced with provenance, never
  blended into your own voice.
- **Git, never the mesh.** Cross-human sharing travels through a repo both
  sides can audit. Other humans never join your
  [session mesh](../coordination/mesh.md) — that is yours alone.

## Sharing memory + tools

- In **Config** view, click `share →` on any memory / skill / agent / command / rule / permission / hook / MCP
- In **Knowledge** view, click `share →` on the detail header of any entry
- Open the **Shared Mind dialog**, expand each queued row to refine the published functional description
- Click **publish queue** to commit + push everything in one batch

## Subscribing

- Set the remote URL in the Shared Mind dialog (or
  `curl -sX POST -H 'content-type: application/json' -d '{"url":"git@…"}' http://localhost:3001/api/shared/remote`)
- Click **sync** — pulls + imports memories
- From a Claude Code session, type `/cortex-sync-shared` to re-pull at any time
- Pulled memories land in scope `shared:<name>` in your graph
- The PreToolUse hook automatically surfaces relevant memories when you use a
  tool that has shared knowledge

A headless box can subscribe too — see [worker mode](../operate/worker-mode.md).

Known rough edge: the model assumes mutual trust between collaborators — there
is no commit signing and no secret scrubbing on publish yet, so treat the shared
repo's membership as your trust boundary.

Related: [[cortex-private-mind]] · [[cortex-coordination-overview]] · [[cortex-trust]] · [[cortex-worker-mode]]
