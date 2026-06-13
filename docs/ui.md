---
name: cortex-ui
description: "The optional monitoring UI: knowledge, graph, sessions, and config views"
audience: user
---

# The UI

The Cortex UI runs at `http://localhost:1420` (server on `:3001`) — see [running](operate/running.md). It is optional: monitoring and manual control for humans; the hooks never need it. The **Config** view also manages your Claude Code configuration — view, edit, and promote agents / commands / skills / rules / hooks / permissions / MCP servers across user and project scopes, with live editing (changes save automatically, debounced).

### Browse what's in your graph
- Open the **Knowledge** view — facets by scope (user, project, vault, shared, pattern), kind, and tags
- **Graph** view shows the same data force-laid out
- Click any entry to see its content + backlinks

### Live session monitoring
- **Sessions** view shows every Claude Code session you've run, parsed from `~/.claude/projects/*/<id>.jsonl`
- Pin live sessions to keep them in tabs even after they go idle
- Right rail shows recent graph writes + sparkline


Related: [[cortex-memory-pipeline]] · [[cortex-session-bus]] · [[cortex-ui]]
