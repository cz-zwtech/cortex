---
name: cortex-mesh
description: "Cross-machine session coordination: the mesh tier, joining a node, roaming, and the degradation ladder"
audience: user
---

# The mesh (cross-machine tier)

The [session bus](session-bus.md) covers one machine. The **mesh** extends it
across every machine you own: a decentralized fleet of equal Cortex nodes — no
central hub, no single point of failure — so a session on your laptop can see
and message a session on your workstation.

**How it degrades (the ladder).** The mesh is a ladder, not an all-or-nothing
switch: direct node-to-node links where reachability allows → relaying through a
reachable peer where it doesn't (WSL and cross-VLAN setups often need this) →
single-machine bus when a node is offline → a solo session with file-backed
memory. Every rung works on its own; each rung above adds reach. Most
single-machine installs simply live on the lower rungs and never notice.

**How it works.** The broker is behind a `MessageBroker` interface. The local
tier (`GraphBroker` over SQLite, this machine) is always the substrate. When the
mesh is configured, a `MeshBroker` is composed in via a `FederatedBroker`
(local-authoritative + remote-best-effort). Each node runs its own server and
replicates bus state directly: a `send` **broadcasts** the message to every
peer's `/api/mesh/*`, and each peer applies it (upsert-with-union — grow-only
sets, conflict-free) into its **own** local store, so that node's sessions read
it through the normal local inbox. Reads are local; presence rides a periodic
gossip loop with reachability tracking + zombie eviction; an offline node
catches up on reconnect via a per-origin monotonic sequence + per-peer cursor.
The tier is **fail-closed**: a node with peers configured but no token never
activates the mesh (an unauthenticated cross-machine write surface is never
exposed).

## Joining a machine to the mesh

Do this once per machine:

1. **Install Cortex normally first** ([install](../start/install.md)). Get it
   healthy standalone — server on `:3001`, UI on `:1420` — before mesh config.
2. **Persist the node's mesh config** with the `ckn-mesh` alias (non-secret
   values only; they land in `~/.config/ckn/mesh.json`):
   ```bash
   ckn-mesh set --peer http://<reachable-peer>:3001 --self http://<this-host>:3001
   ckn-mesh show     # verify; ckn-mesh clear to reset
   ```
3. **Provide the same mesh token on every node.** It's a plain secret: a plain
   `export CKN_MESH_TOKEN=…` works for a single trusted box; beyond that, fetch it
   at the launcher (`secret-run CKN_MESH_TOKEN -- …`, never a file — see
   [secrets](../start/secrets.md)). When `~/.config/ckn/mesh.json` exists and a
   secret-manager launcher is present, `ckn-start` uses it automatically and the
   node comes up mesh-on; if the token isn't available it starts local-only rather
   than failing.
4. **Restart Cortex** (`ckn-stop`, wait for the port to free, `ckn-start`).
   Without a token the mesh stays off (fail-closed) — peers set + no token is a
   deliberate no-op, not an error.
5. **Verify:** `curl -s http://localhost:3001/api/machines` should list every
   node exactly once, each `live`, with no ghosts (a stale duplicate under a
   second address means this node's `--self` disagrees with how a peer lists
   it — reconcile the two URLs).

For the WSL-specific reality (loopback binds, mirrored networking, firewall
rules, relay behavior), follow the dedicated guide:
**[Installing a Cortex driver node, including WSL](../install-wsl-driver-node.md)**.

The env-var knobs behind this (`CKN_MESH_PEERS`, `CKN_MESH_SELF`,
`CKN_MESH_TOKEN`, `CKN_MESH_GOSSIP_MS`, `CKN_MESH_ZOMBIE_MS`) are documented in
[configuration](../operate/configuration.md) — `ckn-mesh` + the launcher set
them for you. (Redis is not used — the mesh is the sole cross-machine transport.)

## Roaming (the laptop case)

*Roaming is a designed-for mode, not a fallback.* A laptop reached over a VPN is
a first-class node *when reachable* — its routable address lets the other nodes
broadcast to it like any LAN peer. When it's **offline or the VPN is blocked**,
it simply runs as a local hub (its own same-machine session bus) plus git-backed
[private-mind](../minds/private-mind.md), and **catches up on reconnect** — the
`FederatedBroker` is local-authoritative, so the laptop's local bus keeps working
while dark and replays missed cross-machine traffic once it's reachable again.
There is **no live presence while it's dark, by design**: the other nodes
zombie-evict it after `CKN_MESH_ZOMBIE_MS`, and a new session on it revives it
instantly when it reconnects.

Related: [[cortex-session-bus]] · [[cortex-coordination-overview]] · [[cortex-trust]] · [[cortex-private-mind]]
