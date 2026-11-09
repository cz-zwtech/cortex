# Installing Cortex V2

Cortex installs from a git checkout into your own Claude Code config. Hooks and daemons run from the
checkout; your data (memories, the mesh log, comms) stays under your own `~/.config/ckn`.

## Requirements

- Node.js 20.11 or later (tested on 20 and 22), and git.
- Claude Code.
- `jq`, for the status line.
- Linux, macOS or WSL. Services use systemd user units on Linux.
- `npm ci` builds better-sqlite3. It ships prebuilt binaries for common platforms; elsewhere it needs
  Python 3, make and a C++ compiler.
- Docker, only for the container simulations under `test/sim` and `examples/gateway-e2e`.

## Single-user machine

```bash
git clone <repo url> ~/cortex && cd ~/cortex && npm ci
npx tsx bin/cortex-install.ts
```

Then start a Claude Code session and run `/cortex-status`. The install also puts the Cortex CLIs
(`cortex-mesh`, `cortex-role` and those of the installed modules) in `~/.local/bin`.

## Shared Linux host with several users

When more than one account on a machine runs Cortex, they share one checkout that every account can
run and update, outside any home, for example `/srv/cortex/cortex`. Each user still installs into
their own config, so each user's data stays separate.

Make the parent directory owned by a group those users share, setgid, with a default ACL that gives
the group rwx. Then, as any user in that group:

```bash
git clone <repo url> /srv/cortex/cortex
/srv/cortex/cortex/bin/cortex-deploy-update.sh --no-pull   # npm ci, then make it group-writable
```

To update it later, any user in the group runs `/srv/cortex/cortex/bin/cortex-deploy-update.sh`. It
pulls (fast-forward only), runs `npm ci`, and makes every file the running user owns group-writable,
since npm writes package files 0644 whatever the directory's ACL says.

git refuses to work in a repository owned by another user (its `safe.directory` protection), and in a
shared checkout that is everyone but the user who cloned it. The update script adds the checkout to
the running user's `safe.directory`, so each user should run it once before using git there.

Then each user installs into their own config:

```bash
cd /srv/cortex/cortex && npx tsx bin/cortex-install.ts
```

### When the installer refuses a checkout in your home

On Linux, `cortex-install` refuses a checkout inside your home when another account on the machine
already runs Cortex, because that account could not run or update a checkout in your home. The
message names the accounts. Use a shared checkout as above, or pass `--single-user` if your Cortex is
to be your own, separate from theirs.

Other accounts that do not run Cortex (a container image's default user, say) are no reason to
refuse; the installer notes them and goes ahead.

## Connecting machines

A node is local-only by default: its sessions talk through the local log, with no daemon, no open
port and no outbound link. Connecting is a setting, not a reinstall.

**Network first.** The node that dials needs TCP to the listening node's mesh port (3021 by default)
on a private address: the mesh accepts connections from private addresses only. A machine that can
only dial out (a laptop, WSL) adds the other as a peer; nothing needs to reach it.

On the machine the others dial into (here `home`, the always-on one):

```bash
cortex-mesh config alias home
cortex-mesh listen on
```

On a machine that dials it (here `laptop`):

```bash
cortex-mesh config alias laptop
cortex-mesh peers add 10.0.0.12:3021
```

- `listen on` opens the daemon's port; `peers add <host:port>` dials a node. Either one starts the
  daemon. `listen off` together with removing the last peer (`cortex-mesh peers remove <host:port>`)
  stops it.
- The alias names the node in addresses such as `home:pm`. It is kept in the node's mesh folder
  (`node.json`, with `port` and `host` if set), so every start uses it: from a session, from
  `ssh home 'cortex-mesh start'`, or from systemd. `cortex-mesh config` alone prints the settings.
- The listener binds every interface (`0.0.0.0`) by default. On a host with several interfaces,
  `cortex-mesh config host <addr>` binds it to one, such as the LAN address. Restart the daemon to
  apply it (`cortex-mesh stop`, then `cortex-mesh start`).
- `CKN_NODE_ALIAS`, `CKN_MESH_PORT` and `CKN_MESH_BIND` override the alias, port and host.
- `cortex-mesh status` shows the daemon, its port and each peer's link.
- `cortex-mesh aliases install` adds the shell aliases `cortex` (start and status) and `cortex-off`.

If `~/.local/bin` is not on your `PATH`, run the same commands from the checkout as
`npx tsx bin/cortex-mesh.ts ...`.

## A gateway node

A gateway is the only path between your Cortex and another organisation's. It runs comms and the
gateway module only: no hooks, no memory, no sessions. Install it as the account that will run it:

```bash
npx tsx bin/cortex-install.ts --gateway --domain home [--alias home-gw] [--port 3021]
```

- `--domain` is required: lowercase letters, digits and dashes. `--alias` defaults to
  `<hostname>-gw`, and `--port` to 3021.
- The install makes the domain key and prints only its pin. Give the pin to the owner of each peer
  gateway, and add theirs under `peers` in `~/.config/ckn/data/gateway/gateway.json`. Nothing is
  exposed until a role is listed under a peer. Check it with
  `npx tsx modules/gateway/bin/cortex-gate.ts status`.
- A rerun keeps the node id, the domain key and certificate, and `gateway.json`. Pass the same
  `--alias` and `--port`, since they are rewritten from the flags or their defaults.
- It refuses an account whose Claude config already has Cortex hooks (run
  `npx tsx bin/cortex-install.ts uninstall` first).
- The home-checkout rule above applies here too: add `--single-user` if only this account runs
  Cortex on the machine.

## A service account

A service account runs automation and has no interactive sessions. Comms data is per Linux user, so
a service cannot send through a human's node; it runs its own small, send-only node. On a shared
host, as the service account:

```bash
cd /srv/cortex/cortex && npx tsx bin/cortex-install.ts --service --alias home-svc [--with telegram]
```

Defaults: `--alias <hostname>-svc`, `--port 3022`, `--peer 127.0.0.1:3021`, `--role service`. Each
module named with `--with` (comma separated) also gets a role of its own name.

- Comms only (with the mesh), plus any `--with` modules. No Claude Code hooks, commands or memory, so
  a headless `claude -p` run as that user runs no Cortex. It refuses if the Claude config already has
  Cortex hooks.
- Its own node id, in `~/.config/ckn/node-id`.
- Peered to the human node on the same host. It does not listen, opens no port and advertises no
  address. A systemd user unit (`cortex-mesh.service`) keeps it up; the account needs linger
  (`loginctl enable-linger <account>`) for it to run without a login.
- A service sends as a role's member, for example
  `npx tsx bin/cortex-role.ts send home:pm --as service-1 --body-file <file>`.
- Container test: `test/sim/service.sh`.

## The telegram module

Operator notifications through a Telegram bot you create and own: Cortex has no built-in bot. It is a
host-only module: it runs in the Cortex host process on a service node, never in hooks or CLIs.

```bash
cd /srv/cortex/cortex && npx tsx bin/cortex-install.ts --service --alias home-svc --with telegram
```

Then configure it. Tokens and chat ids are never written to a file: `telegram.json` holds only
references to them. Without OpenBao, the references name environment variables:

```bash
npx tsx modules/telegram/bin/cortex-telegram-admin.ts init --bot dev --username @my_cortex_bot \
  --token env:TG_MY_BOT_TOKEN --operator me --chat env:TG_MY_CHAT_ID
```

With OpenBao, they name a KV path, which the module reads at start through `bao-run`:

```bash
npx tsx modules/telegram/bin/cortex-telegram-admin.ts init --bot dev --username @my_cortex_bot \
  --token bao:kv/cortex/secrets#TG_MY_BOT_TOKEN \
  --operator me --chat bao:kv/cortex/secrets#TG_MY_CHAT_ID
```

`init` writes `~/.config/ckn/data/telegram/telegram.json` only after every reference resolves and
Telegram reports the named username for the token. Then run the host:

```bash
npx tsx modules/telegram/bin/cortex-telegram-admin.ts check     # each reference: resolves or not, never the value
npx tsx modules/telegram/bin/cortex-telegram-admin.ts unit > ~/.config/systemd/user/cortex-host.service
systemctl --user daemon-reload && systemctl --user enable --now cortex-host.service
```

- The unit passes no secrets. With env references it loads `~/.config/ckn/telegram.env`, which you
  create (chmod 600) with the names it lists. With OpenBao references it loads the `bao-run` login
  (`BAO_ADDR`, `BAO_ROLE_ID`, `BAO_SECRET_ID`) from `~/.claude/.env`.
- Sessions on any node reach it with `cortex-telegram` (or `/cortex-telegram`), over comms to the
  role `telegram`.
- More bots are more entries in `bots`. See [modules/telegram/README.md](modules/telegram/README.md)
  for the full configuration and what it refuses.
- Container tests: `test/sim/telegram.sh`, `test/sim/telegram-multibot.sh`.

## Uninstall

```bash
npx tsx bin/cortex-install.ts uninstall
```

It removes the Cortex hooks from `settings.json`, the Cortex commands, the CLAUDE.md imports, the
CLIs in `~/.local/bin` and the status line, and stops the mesh daemon. It touches only entries that
carry the `cortex:managed` marker. Your data in `~/.config/ckn` stays; delete it yourself if you want
it gone.

On a gateway or service node, also disable its units:
`systemctl --user disable --now cortex-mesh.service` (and `cortex-host.service` if you added it).

## Moving from V1

Follow [docs/migrating-from-v1.md](docs/migrating-from-v1.md). It links to what changes and to the V1
purge checklist.
