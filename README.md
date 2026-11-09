# Cortex

> **Coming from Cortex V1?** This repository is now V2, a rewrite. Do not restart V1 from this checkout. Read [ATTENTION.md](ATTENTION.md), then follow [docs/migrating-from-v1.md](docs/migrating-from-v1.md). V1 stays available as the tag `v1-final`.

Cortex is a modular layer for Claude Code. A small core plugs into Claude Code's hooks once, and modules add what you install: persistent memory, messaging between sessions and machines, one mind across your own machines, a gateway to other organisations, and operator notifications.

## What it does

- **Core.**
  - **Hooks.** Registers one hook per Claude Code lifecycle event. Modules subscribe in-process, so installing or removing a module leaves `settings.json` unchanged.
  - **Modules.** Discovers modules, resolves their dependencies (an install is refused when a hard dependency is missing) and checks version compatibility.
  - **Commands.** Installs their slash commands and CLIs.
  - **Status line and updates.** A small status line segment that installed modules extend with their own parts, and in-place updates that modules hook into.
  - **Install and status.** Install, uninstall, status, backup and an isolated test runner.
- **memory.**
  - **Storage.** Memories live in a graph store, with recall that ranks by relevance, usage, links and recency, and decay over time. A journal is the source of truth; the graph is derived from it.
  - **Capture.** Memory files written during sessions are swept into the store.
  - **Standing rules.** Rules can be checked against what a session writes.
- **comms.** Messaging, on one machine and across machines.
  - **Role mailboxes.** Messages go to roles, never to session ids, and a session joins a role under a member name. A watcher delivers messages as they arrive; work messages carry claims, so two members never act on the same one.
  - **Local-only by default.** On one machine, messages go through a local log, with no daemon, no open port and no outbound link.
  - **The mesh, when you connect.** Connecting is a setting, not an install: `cortex-mesh listen on` lets other nodes dial in, `cortex-mesh peers add <host:port>` dials one. Nodes stream the log over one WebSocket link per pair, with link-state routing across hops and files sent through a secret scan.
- **private-mind.** One mind across your own machines: what you learn on one is recallable on the others. Knowledge syncs through a central node you choose; working detail stays on the machine that wrote it and travels only as a pointer; nothing passes a gateway. Off until enabled per node; a machine with no long-running service syncs from its session hooks.
- **gateway.** The only path between your Cortex and another organisation's.
  - **Links.** Mutual TLS between gateways, pinned by key.
  - **Exposure.** Only the roles you expose are reachable, and peer messages are data, never commands.
  - **Return paths, mailbox, secrets.** Replies come back by standing return paths; a mailbox holds messages for home nodes; a secret scan holds outbound messages for review.
  - **Audit.** Every crossing is written to a hash-chained audit log.
- **telegram.** Operator notifications through Telegram bots you configure (there is no built-in bot): store-first delivery, fallback clocks, inbound messages from operators only, several bots by config. Secrets come from environment variables or OpenBao.

## Requirements

- Node.js 20.11 or later, and git. `npm ci` builds better-sqlite3, which ships prebuilt binaries for common platforms; elsewhere it needs Python 3, make and a C++ compiler.
- Claude Code.
- Linux, macOS or WSL. Services use systemd user units on Linux.
- `jq`, for the status line.
- Docker, only for the container simulations under `test/sim` and `examples/gateway-e2e`.

## Install

See [INSTALL.md](INSTALL.md). For one user on one machine:

```bash
git clone <repo url> ~/cortex && cd ~/cortex && npm ci
npx tsx bin/cortex-install.ts
```

If another account on the machine already runs Cortex, the install asks for a shared checkout that every account can run (see INSTALL.md); add `--single-user` if yours is to be separate.

Moving from Cortex V1? Follow [docs/migrating-from-v1.md](docs/migrating-from-v1.md). It links to what changes and to the V1 purge checklist.

The node starts local-only. Connect it to your other machines with `cortex-mesh` when you want to.
To connect, a node that dials needs TCP to the listening node's mesh port (3021 by default) over a private network: the mesh accepts connections from private addresses only. A machine that can only dial out (a laptop, WSL) adds the other as a peer; nothing needs to reach it.

## Writing a module

See [docs/module-author-guide.md](docs/module-author-guide.md), and `examples/hello-world` for a minimal module.

## Tests

```bash
npm test                 # every suite, each in an isolated sandbox
bash test/sim/<name>.sh  # container simulations of multi-node and multi-user setups
```

Tests never touch your real Claude Code config or memory: under test, every path that would reach them is refused.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Copyright 2026 ZW-Tech LLC.
