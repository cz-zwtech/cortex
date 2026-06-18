---
name: cortex-running
description: "Start, stop, and autostart Cortex; the ckn-* helper aliases"
audience: operator
---

# Running Cortex — start, stop, autostart

**Cortex is a local process, not a system service.** It runs only while the
server started by `ckn-start` (or `npm start`) is alive. It does **not** survive
a reboot or full shutdown — after you restart your machine you must start it
again if you want the UI, recall, and the hooks' API-backed fast path. (The hooks
themselves still work without the server via their direct-to-SQLite fallback, but
the server is what serves the UI and the fast API path.)

`npm run install-aliases` writes these helpers into your shell rc
(`~/.bashrc` / `~/.zshrc` / fish config), inside a managed, idempotent block:

| Command | What it does |
|---|---|
| `ckn-start` | Start the server (3001) + UI (1420) in the background. **Idempotent** — if Cortex is already listening on either port it prints `ckn: already running` and does nothing. On a node configured for the mesh (`~/.config/ckn/mesh.json`), it comes up mesh-on when `CKN_MESH_TOKEN` is available — either already in the environment (a plain `export`) or fetched by a secret-manager launcher (e.g. `bao-run`) when one is present; otherwise it starts local-only, and it never fails to start if the token can't be fetched (it just degrades to local-only). |
| `ckn-stop` | Stop the server + UI. |
| `ckn-status` | Show whether the ports are listening. |
| `ckn-log` | Tail the server log (`~/.local/state/ckn/server.log`). |
| `ckn-mind-sync` | Run the private-mind sync (see Private-mind). |
| `ckn-mesh` | Persist this node's **non-secret** mesh config — `ckn-mesh set --peer <url> [--self <url>] [--node-id <id>]`, `show`, `clear` → `~/.config/ckn/mesh.json`. The token is never stored here — it's provided via the environment or a secret-manager launcher. See [Driver node on the mesh](../install-wsl-driver-node.md). |
| `ckn-bus` / `ckn-recall` / `ckn-sync` | Client CLIs the docs reference (session bus, recall, memory sync), pointed at this clone. |
| `ckn-codegraph` / `ckn-blast` / `ckn-graph-diff` | AST code-graph: build a repo's graph, query a file/symbol's blast-radius, diff competing changes between branches. |

After install, `source ~/.bashrc` (or open a new shell), then `ckn-start`.

**One server per box.** Only one Cortex server can own port 3001, and the server
now **self-guards**: a second launch detects the port is already owned and exits
cleanly (`:3001 already in use … single-instance guard`) before it touches the
graph — so racing `ckn-start`s or a stray `npm start` can't dogpile the port and
wedge the server (and with it the bus). The canonical way to run/restart a single
server directly is `npm run server` (non-watch) plus `bin/ckn-reboot` to cycle it.

### Make it start automatically

Because `ckn-start` is guarded (it no-ops when already running), it's safe to run
on every shell launch — so the simplest autostart is to have it fire when you
open a terminal. Two ways:

- **Managed (recommended):** re-run the alias installer with the flag —
  ```bash
  npm run install-aliases -- --autostart
  ```
  This adds an interactive-shell-guarded `ckn-start` to the same managed block
  (`[[ $- == *i* ]] && ckn-start >/dev/null 2>&1`). The first terminal you open
  after a reboot starts Cortex; every other terminal sees it's already up and
  does nothing. Re-run without `--autostart` to remove it.
- **By hand:** add `ckn-start` to the end of your `~/.bashrc` yourself (same
  effect). This mirrors how a personal dotfiles setup wires up project servers.

For a box that should run Cortex **headlessly and persistently across reboots**
(a shared worker, a server), don't use the shell autostart — install the systemd
user service instead, which `loginctl enable-linger` keeps alive across logout
and reboot. See **Worker-mode deployment** below.

To put a driver node (your workstation or **laptop / WSL**) **on the mesh** — join,
roam off and back, and reconnect with no env changes — see **[Installing a Cortex
driver node (including WSL)](../install-wsl-driver-node.md)**, which covers the
WSL loopback/dial-mesh/relay reality and reachability-driven membership.


Related: [[cortex-install]] · [[cortex-updating]] · [[cortex-worker-mode]] · [[cortex-troubleshooting]]
