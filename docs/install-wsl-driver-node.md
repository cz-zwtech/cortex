# Installing a Cortex driver node (including WSL)

A **driver node** is an interactive, human-driven machine on your mesh — your
workstation or laptop — as opposed to a **worker node** (a headless server running
the systemd unit; see README → *Worker-mode deployment*). This guide takes a
**genuinely fresh** machine to a working driver node that joins your mesh, with
the WSL specifics that trip people up called out first-class. Goal: succeed from
this doc alone.

> **Identity rule:** the mesh node **is the computer** — do **not** set a custom
> `--node-id`. Cortex derives a stable per-machine id; a custom id just
> double-counts the same box in the roster. Only override it for multi-node-on-one-host
> testing.

## 0. The WSL reality (read this first)

Most driver nodes are WSL, and WSL networking shapes everything:

- **A WSL Cortex binds `127.0.0.1` (loopback) only — by design.** It is therefore
  **not inbound-reachable** from outside its own WSL, regardless of NAT, firewall,
  or portproxy. This is the correct *secure default*: your graph/bus/API stay off
  the network.
- **A driver node doesn't need to be inbound-reachable to join.** The mesh is a
  **WS dial-mesh**: a node only needs to *dial* one reachable peer; the link it
  opens carries traffic **both directions**. So a loopback/NAT WSL node joins fine
  by dialing a peer that *is* reachable (a server, or any node running the optional
  published bind).
- **Reachability is per-pair and directional.** Two loopback nodes can't connect
  directly in *either* direction — they reach each other by **relay** through a
  commonly-reachable node. Relay is a permanent, first-class path, not a fallback.
- **Membership is reachability-driven, never an env flip.** On VPN / peers
  reachable → the node joins and announces; off VPN → it falls back to **local-only**
  (local bus + graph + memory keep working) and **auto-rejoins** when reachability
  returns — with **no config change and no restart**. The roaming laptop is the
  sharpest case and needs zero special handling.

## 1. Prerequisites (fresh box)

Everything a fresh box needs (self-contained — you don't need the README open):

- **Node 20+** via nvm (`nvm install --lts`) — distro `nodejs` is usually too old.
- **Build toolchain + Python 3** (`node-pty` compiles): `sudo apt install build-essential python3 make g++`.
- **Git identity** (every driver node uses private-mind, which pushes on your behalf):
  ```bash
  git config --global user.name  "Your Name"
  git config --global user.email "you@example.com"
  ```
- **SSH key on the host(s) you clone from:** Cortex and the secret-manager wrapper
  (`bao-run`) both clone from **GitHub**; your private-mind repo is wherever you host
  it. Add the machine's `~/.ssh/id_ed25519.pub` to each, and **trust the host keys
  first** (else the clone fails `Host key verification failed`):
  ```bash
  ssh -T git@github.com   # accept the prompt
  ```
  If your network blocks port 22 (common on locked-down / roaming networks), route
  SSH over 443 as a fallback — add to `~/.ssh/config`:
  ```
  Host github.com
    Hostname ssh.github.com
    Port 443
  ```
  (Laptops roam networks that block 22 — worth setting proactively.)
- **The mesh token (`CKN_MESH_TOKEN`):** a plain secret, the same value on every node.
  For a single trusted box, a plain `export CKN_MESH_TOKEN=…` (in the environment
  `ckn-start` sees) is all you need. **For a fleet, fetch it at the launcher via a
  secret manager** so it never lands in a file — any manager works (see
  [secrets](start/secrets.md)); this guide uses OpenBao + the `bao-run` wrapper as one
  option. Install `bao-run` per the
  [openbao_wrapper README](https://github.com/cz-zwtech/openbao_wrapper) (`curl` + `jq`:
  `sudo apt install curl jq`), then **configure its bootstrap** — without it
  `ckn-start`'s `bao-run CKN_MESH_TOKEN …` has no credentials and the node won't
  auto-fetch the token:
  - Get the **AppRole bootstrap** from your fleet admin: `BAO_ADDR` (the OpenBao
    endpoint), `BAO_ROLE_ID`, `BAO_SECRET_ID` — these are *scoped-read* creds, not the
    secrets themselves.
  - Put them in **`bao-run`'s own env file** — `~/.config/bao-run/env` (`chmod 600`),
    one `KEY=value` per line. `bao-run` self-sources **and exports** this file (it reads
    it under `set -a`) whenever the creds aren't already in the environment — so it works
    identically for an interactive `ckn-start` **and** a systemd worker unit, with **no
    `~/.bashrc` edit and no shell-export dance**:
    ```
    BAO_ADDR=http://<openbao-host>:8200
    BAO_ROLE_ID=<role-id>
    BAO_SECRET_ID=<secret-id>
    BAO_SECRET_PATH=<your-kv-path>   # e.g. secret/cortex — NOT the stock 'secret/app' default
    ```
  - **Two footguns the native file avoids** — read these even if you deviate:
    - **Export, not just set.** The bootstrap must reach the `bao-run` *child process*.
      A plain `. ~/.claude/.env` only sets vars in your shell and does **not** export
      them, so the child dies with `BAO_ADDR not set` and the mesh silently never joins
      (this is the exact failure that bit a fresh box). The native env file sidesteps it.
      If you instead want creds alongside other Claude tooling in `~/.claude/.env`, point
      bao-run at it with `BAO_ENV_FILE=$HOME/.claude/.env` — don't rely on `~/.bashrc`
      sourcing.
    - **`BAO_SECRET_PATH`.** Stock `bao-run` defaults to `secret/app`; the wrong KV path
      makes every token read fail and the mesh stays silently off. Set it (above) on
      **every** node.
  - Verify before continuing: `bao-run CKN_MESH_TOKEN -- true` exits 0 (OpenBao
    reachable + the key readable for this node).

## 2. Install Cortex

```bash
git clone git@github.com:cz-zwtech/cortex.git ~/cortex
cd ~/cortex
npm install
npm start          # first boot writes hooks/commands/skill into ~/.claude
```
**Restart your Claude Code session** after first boot (so the just-written hooks +
slash commands load), then install the shell helpers:
```bash
npm run install-aliases   # adds ckn-start/stop/status/log, ckn-mesh, ckn-bus, …
source ~/.bashrc          # or open a new shell
ckn-stop                  # STOP the first-boot `npm start` before §3 — otherwise
                          # `ckn-start` launches a SECOND server (port clash / mess).
```
(Or Ctrl-C the `npm start` terminal. `ckn-start` in §3 is the real, mesh-aware launch.)

## 3. Join the mesh

1. **Persist the non-secret mesh config** — point this node at one reachable peer
   (a server, or any inbound-reachable node). The token is *not* set here:
   ```bash
   ckn-mesh set --peer http://<reachable-peer-host>:3001
   ckn-mesh show
   ```
   (Add more `--peer` flags for additional seeds; the node learns the rest of the
   fleet via gossip and persists them to `~/.config/ckn/mesh-peers.json`, so it
   re-forms the mesh on later restarts without re-listing them.)
2. **Start with the token available** so the node comes up mesh-on:
   ```bash
   ckn-start
   ```
   If `CKN_MESH_TOKEN` is already exported, `ckn-start` just uses it. If instead you
   use a secret manager, `ckn-start` auto-detects `mesh.json` + a wrapper and launches
   bao-wrapped (`bao-run CKN_MESH_TOKEN -- npm start`). Either way, if the token can't
   be obtained (e.g. OpenBao unreachable because you're off VPN), it **starts
   local-only instead of failing** — and the node joins automatically once a token + a
   peer become reachable (no restart needed).

   > **Hands-free auto-rejoin needs `CKN_MESH_TOKEN_CMD` in the *server's* env.** When
   > the node booted without a token, the membership controller re-fetches one each tick
   > by running this command — so an off-VPN→on-VPN transition rejoins with no restart.
   > The shell helpers source `~/.claude/.env`, so put it there (chmod 600), **quoted**
   > because it contains spaces:
   > ```bash
   > # ~/.claude/.env  (OpenBao users: swap secret-run for bao-run, per "the mesh token" above)
   > CKN_MESH_TOKEN_CMD="secret-run CKN_MESH_TOKEN -- printenv CKN_MESH_TOKEN"
   > ```
   > The same file feeds `CKN_PROFILE` (§5). Without the command in the env, a node that
   > came up local-only stays local-only until you re-run `ckn-start`.

## 4. Verify

```bash
ckn-status                                                  # ports listening
curl -s localhost:3001/api/bus/mesh-status | grep enabled  # "enabled":true when joined
ckn-bus peers                                               # fleet sessions, machine-tagged
```
A joined node shows `enabled:true`, a connected WS link to your peer, and remote
sessions (machine-tagged) in `ckn-bus peers`. If `enabled:false`, the token wasn't
fetched — re-check `bao-run CKN_MESH_TOKEN -- true` (OpenBao reachable + key readable).

> Use **`/api/bus/mesh-status`** — it's an auth-free *local* diagnostic. The
> `/api/mesh/*` endpoints (note: no `bus`) are bearer-gated and return `mesh auth`
> without the token — that's expected, not a failure of your node.

## 5. Adopt your mind (memory + profile)

Joining the mesh connects you to *live* sessions; this step brings **your memory
and profile** onto the node — the whole point of a driver node ("my memory follows
me"). Once, per machine:

```bash
# Your OWN private-mind repo — create an empty private git repo (any host) and use its URL.
ckn-mind-sync --remote git@github.com:<your-user>/private-cortex.git
```

This clones your private-mind repo and adopts your **whole mind** — every memory
re-indexes into this node's graph, the AST code-graph replays too — then pushes
anything local. **Boot sync is pull-only by default:** a restart adopts remote
changes but does NOT auto-push; run `ckn-mind-sync` explicitly to publish, or set
`CKN_MIND_PUSH_ON_BOOT=1`. `ckn-mind-sync --status` shows state.

> The first adopt is slow and nearly silent — it clones, re-indexes the corpus,
> downloads the embedding model (~33 MB, first run only), and embeds everything. A
> minute or two of a still cursor is normal; **don't Ctrl-C it.**

To **surface your personality profile** (how Cortex reads you — engagement style,
anticipation), opt in with `CKN_PROFILE=1` in `~/.claude/.env` (default off). With
private-mind above, the profile then follows you across machines. Without this step
the node is on the mesh but doesn't yet *know you* — the exact "memory follows me"
value test.

## No server on your network? Direct WSL↔WSL links (the I5 LAN tier)

A driver node needs *one* reachable peer to dial. If your fleet has **no**
inbound-reachable node at all (e.g. desktop + laptop, both WSL, no server), every
message between two loopback nodes must **relay** through some third reachable node —
and if none exists, they can't talk. The fix is to make a WSL node **directly
reachable on your LAN** without exposing its graph/API: WSL **mirrored networking**
gives the box a real LAN IP, and the **published mesh-accept bind** (`CKN_MESH_BIND`)
opens a dedicated, **bearer-gated** port that serves *only* the mesh WebSocket
(`/api/mesh/ws`) — the graph/bus/REST/UI stay on `127.0.0.1`. A peer learns this
node's advertised URL via gossip, probes it, and dials it **directly**.

Do this on **at least one** node of a server-less pair (both is fine — then either
can dial the other). It is **opt-in and default-off**; an ordinary loopback driver
needs none of it.

**1. Turn on WSL mirrored networking (Windows side).** Edit
`%UserProfile%\.wslconfig` (WSL path `/mnt/c/Users/<you>/.wslconfig`) — create it if
absent:
```ini
[wsl2]
networkingMode=mirrored
```
Then, from a **Windows** shell (PowerShell/cmd), restart the WSL VM:
```powershell
wsl --shutdown
```
Reopen WSL. The distro now shares the host's LAN adapters, so it has a real LAN IP.

**2. Find this box's LAN IP** (the address other LAN hosts route to — a
`192.168.x.x` / `10.x.x.x`, **not** a `172.x` WSL-internal one):
```bash
ip -4 addr show | grep -v '127.0.0.1' | grep inet
```
Pick the interface on your actual LAN/VLAN. Call it `<lan-ip>` below and choose a
mesh port (e.g. `3010`) distinct from the API's `3001`.

**3. Enable the published bind.** Put both in `~/.claude/.env` (auto-sourced; same
file as your other `CKN_*` / bao bootstrap):
```bash
CKN_MESH_BIND=<lan-ip>:3010          # the auth-gated mesh-accept listener (mesh ws ONLY)
CKN_MESH_SELF=http://<lan-ip>:3010   # advertised so peers dial THIS port directly
```
Prefer the **specific `<lan-ip>`** over `0.0.0.0` — a specific bind is the
recommended posture; never publish on an untrusted network without a host firewall.

**4. Restart and confirm the bind opened** (new shell so `.env` is sourced):
```bash
ckn-stop; ckn-start
ckn-log | grep 'published mesh-accept bind'   # → "...bind on <lan-ip>:3010 — mesh upgrade only"
```

**5. Verify a DIRECT link** (not a relay). From the *other* WSL node, after it has
gossiped with this one:
```bash
ckn-bus mesh    # wsLinks shows a link whose peerNode IS this node (dialed:true) — not via a hub
```
When two NAT'd nodes still have no direct path, `ckn-bus mesh` prints a
`⚠ hint:` line telling you to do exactly the above — it fires when this node is
loopback-only (no `CKN_MESH_BIND`) **and** has peers a probe can't reach. Once a
direct link forms, the hint clears.

> **Windows firewall:** mirrored-mode *inbound* connections are blocked by Windows
> Defender Firewall by default. If a peer can't reach `<lan-ip>:3010`, add a standard
> inbound allow rule from an **elevated PowerShell**:
> ```powershell
> New-NetFirewallRule -DisplayName "Cortex mesh" -Direction Inbound -Protocol TCP -LocalPort 3010 -Action Allow
> ```
> The Hyper-V firewall rule (`New-NetFirewallHyperVRule`) is **not** needed for
> mirrored networking — the standard Defender rule above suffices (verified on the
> zwd↔zw2 link). The auth-gated bind is safe to expose on a trusted LAN; the token
> still fails closed.

Relay stays a valid **fallback** — a pair that can't connect directly still talks
through any reachable node, so you only need one published bind across a server-less
pair, not both.

## Driver vs worker — which am I?

| | Driver node (this doc) | Worker node |
|---|---|---|
| Who | Your workstation / laptop | A headless server |
| Launch | Interactive `ckn-start` (token from env or a secret-manager launcher) | systemd user unit (`cortex-runner.sh`; token from env or a secret-manager launcher) |
| Survives reboot/logout | No (start it yourself) | Yes (`loginctl enable-linger`) |
| Mesh role | Dials peers; relayed if loopback | Usually inbound-reachable (a relay hub) |
| Setup | This guide | README → *Worker-mode deployment* |
