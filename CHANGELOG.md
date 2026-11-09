# Changelog

## 2.0.0

A rewrite. Cortex is now a small core that plugs into Claude Code's hooks once, plus modules you install. Moving from V1: see [docs/migrating-from-v1.md](docs/migrating-from-v1.md), [docs/v1-features-in-v2.md](docs/v1-features-in-v2.md) and [docs/v1-purge.md](docs/v1-purge.md).

- **Core.** One hook per Claude Code event, with modules subscribed in-process. Module discovery, dependency checks and version checks. Slash commands, a status line that modules extend, in-place updates, install, uninstall, status, backup, and an isolated test runner.
- **memory.** A journal is the source of truth and a graph store is derived from it. Recall ranks by relevance, usage, links and recency. Memory files are taken in and left as stubs. Standing rules are checked against what a session writes. Transcript capture, restore after a compaction, a secret gate with quarantine, and optional nightly consolidation on your subscription.
- **comms.** Role mailboxes with claims. Local-only by default; the mesh (one WebSocket link per node pair, routing across hops, file transfer through a secret scan) when you connect.
- **private-mind.** One mind across your own machines, synced through a central node you choose. Working detail stays on the machine that wrote it. Off until enabled.
- **gateway.** The only path to another organisation's Cortex: mutual TLS pinned by key, exposed roles only, and a hash-chained audit log.
- **telegram.** Operator notifications through bots you configure. No built-in bot; secrets come from environment variables or OpenBao.
- **Removed from V1:** the server and web UI, the code graph, thread resume commands, the team shared mind, the personal profile, embeddings, and Obsidian import. Each is listed with its workaround in docs/v1-features-in-v2.md.
