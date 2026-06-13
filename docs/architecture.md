---
name: cortex-architecture
description: "The one-page mental model: hooks are the intelligence, the graph is the substrate, everything else is optional reach"
audience: user
---

# Architecture — the mental model

Cortex is three pillars on one substrate:

1. **A graph-structured memory.** Your memory files, session learnings, and
   fail→success patterns become typed nodes and edges in a local SQLite database.
   Recall walks those edges instead of grepping flat files — see
   [memory pipeline](memory/pipeline.md).
2. **A session fabric.** Every Claude Code session registers presence and can
   message every other session — on this machine and across your machines. Your
   sessions become a virtual team sharing one mind — see
   [coordination](coordination/overview.md).
3. **A monitor + config UI.** Live session monitoring, knowledge browsing, and
   config management — see [the UI](ui.md). The UI is *optional*: nothing else
   depends on it being open.

**The intelligence runs through hooks.** Eight hook registrations fire during
your normal Claude Code sessions — context at start, awareness before tools,
recall on errors, sync at stop, extraction at end. Every hook is API-first
(talks to the local server at `:3001`) and falls back to direct SQLite access
when the server isn't running, so the memory layer works even with everything
else stopped.

```
                  ┌──────────────────────────┐
   ~/.claude/ ←──→│  Claude Code session     │←── you talk here
                  │                          │
                  │  hooks fire on lifecycle │
                  └────────┬─────────────────┘
                           │ tsx scripts
                  ┌─────────────────────────────────┐
                  │  bin/ckn-*.ts                   │
                  │  - context      (SessionStart)  │
                  │  - aware        (PreToolUse)    │
                  │  - recall       (PostToolUse)   │
                  │  - pause-context(UserPromptSubmit)│
                  │  - sync         (Stop)          │
                  │  - precompact   (PreCompact)    │
                  │  - extract      (SessionEnd)    │
                  └────────┬────────────────────────┘
                           │ API-first; direct SQLite only when server down
                  ┌────────▼─────────────────────┐
                  │  SQLite graph DB             │  ← server is the single writer;
                  │  ~/.config/ckn/graph.sqlite  │    WAL mode (readers concurrent)
                  └───┬──────────────────────┬───┘
                      │ git (team)           │ git (your own machines)
          ┌───────────▼────────┐  ┌──────────▼───────────────┐
          │  Team mind         │  │  Private mind            │
          │  (selective/shared)│  │  (everything/your mind)  │
          │  shared:<name>     │  │  native scope, bidir     │
          └────────────────────┘  └──────────────────────────┘

      The Cortex UI (server + React) is *optional* — runs at :3001/:1420
      for monitoring + manual control. Hooks work without it.
```

**The single-writer rule.** better-sqlite3 statements are synchronous and
single-process, so the server owns the graph file; CLIs read concurrently (WAL)
but writes route through the server. This is why ingest commands need the server
up and why the hooks' direct path is read-mostly.

**Everything above the substrate is opt-in reach.** A solo install on one
machine is fully functional. The [mesh](coordination/mesh.md) adds cross-machine
sessions; the [private mind](minds/private-mind.md) adds cross-machine memory;
the [team mind](minds/team-mind.md) adds cross-human sharing. Each layer
degrades independently — losing one never takes down the rest.

For contributors, the code-layer map (ontology → adapters → engine → UI) lives
in [CLAUDE.md](../CLAUDE.md) and the graph schema in
[reference/graph-schema.md](reference/graph-schema.md).

Related: [[cortex-memory-pipeline]] · [[cortex-coordination-overview]] · [[cortex-private-mind]] · [[cortex-team-mind]] · [[cortex-ui]]
