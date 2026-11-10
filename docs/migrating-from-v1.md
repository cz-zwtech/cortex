# Migrating from Cortex V1 to V2

This guide is written for Claude Code running on the machine being moved, working with the person who owns it. Each step says who does it: **Claude** (run it and check it), or **you** (the person: a choice, a secret, or something only a human can do). Every step ends with a check. Do not go on until it passes.

Do this once per machine. Moving all your machines is best: V2's private mind then carries each machine's memories to the others.

Before you start, read [What changes moving to V2](v1-features-in-v2.md). Some V1 features have no V2 equivalent, and you should know which before you move.

## 0. Before anything: what you have

**Claude:** find the V1 install and report what is there. Change nothing yet.

```bash
REPO=$(cat ~/.config/ckn/home 2>/dev/null); echo "V1 checkout: ${REPO:-not found}"
jq -r '[.hooks // {} | .. | objects | .command? // empty | select(test("ckn-"))] | length' ~/.claude/settings.json
ls ~/.claude/commands/ ~/.claude/skills/ 2>/dev/null
systemctl --user is-active cortex.service 2>/dev/null; ss -ltn | grep -E ':(3001|1420)\b'
ls ~/.config/ckn/private-mind 2>/dev/null | head -3
find ~/.claude/memory ~/.claude/projects/*/memory -name '*.md' 2>/dev/null | wc -l
[ -n "$REPO" ] && git -C "$REPO" remote -v && git -C "$REPO" status --short | head
pgrep -af '[c]kn-update' ; [ -n "$REPO" ] && ls "$REPO"/.git/MERGE_HEAD 2>/dev/null
```

If a `ckn-update` is running, wait for it to finish before going on. If the checkout is in the middle of a merge (`MERGE_HEAD` exists), stop and show it to the person: a V1 update was interrupted.

**Which path are you on?**
- **Path A: your V1 checkout is a clone of this repository** (its remote is this repo, and it tracks `main`). V2 arrives in that same checkout with `git pull`. The moment you pull, V1's code is gone from under its hooks, so the order in steps 1 to 4 matters: back up, stop V1, take V1's hooks out, and only then pull.
- **Path B: V1 lives somewhere else** (another remote, or a copy with no git). You install V2 in a new checkout and keep V1's until the purge.

If `git status` shows local changes in the V1 checkout (logs, edits), `git pull` will refuse. Claude shows them to the person, who decides whether they matter. Then `git stash` or move them aside.

**You:** confirm three things:
1. Which machine will be the private mind's **central** node. It should be one that is usually on and that your other machines can reach over a private network. If you only have one machine, skip the private mind.
2. Whether any machine you used V1 on is gone for good. Its memories exist only in V1's private-mind git remote, so see step 8.
3. Whether you use Telegram notifications, OpenBao, or neither. Both are optional in V2.

## 1. Back up

**Claude:**

```bash
ts=$(date +%Y%m%d-%H%M%S); mkdir -p ~/cortex-v1-backup-$ts
tar -czf ~/cortex-v1-backup-$ts/claude.tgz -C ~ .claude
tar -czf ~/cortex-v1-backup-$ts/ckn.tgz -C ~ .config/ckn
[ -d ~/.local/state/ckn ] && tar -czf ~/cortex-v1-backup-$ts/state.tgz -C ~ .local/state/ckn
ls -la ~/cortex-v1-backup-$ts
```

**Check:** each archive lists cleanly (`tar -tzf <file> >/dev/null`). Tell the person where the backup is. It holds their memory files and possibly keys, so it must not be uploaded anywhere.

V2 turns memory files into one-line stubs once it has taken them in (the full text lives in its journal). This backup is your copy of the originals.

On path A, also record where the checkout is now, for a rollback: `git -C "$REPO" rev-parse HEAD > ~/cortex-v1-backup-$ts/v1-head.txt`. V1 also stays reachable on the repository as the tag `v1-final`.

## 2. Stop V1

A running V1 server re-adds its hooks every time it starts, so stop it before anything else changes.

**Claude:**

```bash
systemctl --user disable --now cortex.service 2>/dev/null
REPO=$(cat ~/.config/ckn/home 2>/dev/null)
[ -n "$REPO" ] && pkill -f "$REPO/server/index.ts"
pkill -f '[c]kn-vite-guard'; pkill -f '[c]kn-bus.*watch'
```

**Check:**

```bash
! systemctl --user is-active --quiet cortex.service && ! ss -ltn | grep -qE ':(3001|1420)\b' && ! pgrep -f '/bin/[c]kn-|[c]ortex-runner\.sh' >/dev/null && echo stopped
```

**Never pull V2 while V1 is running.** On path A this check must pass before step 4.

**You:** close every open Claude Code session now. A session already running keeps V1's hooks loaded, and on path A those hooks point at files the pull is about to remove.

### 2b. Path A only: take V1's hooks out before the pull

Do [purge item 3](v1-purge.md#3-hooks-in-settingsjson) now, not later. After the pull, V1's hook commands point at `bin/ckn-*.ts` files that no longer exist, and every session event would fail until they are gone. Removing them first means no session ever runs a broken hook. The backup from step 1 holds the old `settings.json`.

Also take out V1's shell alias block now ([purge item 6](v1-purge.md#6-claudemd-shell-rc-and-env), the rc part). It can start `ckn-start` in every new shell, which runs `npm start` in the checkout, and after the pull that would start V2's host before V2 is installed.

Then remove V1's home pointer: `rm -f ~/.config/ckn/home` (its path is in `$REPO`, set in step 0, and in the step 1 backup). V2's install refuses while that file names this checkout, because it is how a V1 updater landing on V2 is stopped.

Do not use `ckn-update` for this move: it would pull V2 and then try to restart V1. Use `git pull` in step 4.

Look in `~/.claude/settings.local.json` and in any project `.claude/settings.json` or `.claude/settings.local.json` the person copied V1's hooks into, as purge item 3 does: add those files to `FILES` below.

**Check:**
```bash
FILES=${FILES:-}; ok=1
for f in ~/.claude/settings.json ~/.claude/settings.local.json $FILES; do
  [ -f "$f" ] || continue
  jq -e '[.hooks // {} | .. | objects | .command? // empty | select(test("ckn-"))] | length == 0' "$f" >/dev/null || { echo "V1 hook left in $f"; ok=0; }
done
grep -qsE 'Cortex helpers|ckn-install-aliases|ckn-start' ~/.bashrc ~/.zshrc ~/.config/fish/config.fish ~/.profile ~/.bash_profile && { echo "V1 alias block left"; ok=0; }
[ -e ~/.config/ckn/home ] && { echo "V1 home pointer left"; ok=0; }
[ "$ok" = 1 ]
```

## 3. Requirements

**Claude:** check Node.js 20.11 or later, git and jq. Docker is needed only for the test simulations.

```bash
node --version; git --version; jq --version
```

**You:** install whatever is missing. `npm ci` builds the SQLite driver (better-sqlite3). Common platforms get a prebuilt binary; anywhere else it needs Python 3, make and a C++ compiler. If `npm ci` fails at better-sqlite3, install those and run it again.

## 4. Install V2

**Claude:** follow [INSTALL.md](../INSTALL.md). For one person on one machine:

Path A (V2 arrives in your V1 checkout):
```bash
cd "$REPO" && git pull && npm ci
npx tsx bin/cortex-install.ts
```

Path B (a new checkout; pick a folder that is not V1's):
```bash
git clone https://github.com/cz-zwtech/cortex.git ~/cortex-v2 && cd ~/cortex-v2 && npm ci
npx tsx bin/cortex-install.ts
```

On a Linux machine where more than one account runs Cortex, use a shared checkout as INSTALL.md describes.

**Rollback, path A:** `git -C "$REPO" checkout v1-final && (cd "$REPO" && npm ci)`, restore `settings.json` from the step 1 backup, then `systemctl --user enable --now cortex.service`.

**Check:**

```bash
npx tsx bin/cortex-status.ts            # healthy; nothing blocked or failed
jq '.hooks | keys' ~/.claude/settings.json
```

`cortex-status` may list a command as **shadowed**, usually `cortex-rename.md`. V1's file of the same name is in the way. Step 6 removes V1's copy and step 7 fills the gap.

**You:** start a new Claude Code session. **Claude (in that session):** confirm the session start shows Cortex context (memories, rules, and the comms identity once a role is joined).

## 5. Verify V2 before removing V1

**Claude**, in a new session:

1. **Memory.** `npx tsx bin/cortex-memory.ts status` shows a count close to the number of memory files from step 0. Then `npx tsx bin/cortex-memory.ts recall <a topic you know is in memory>` finds it.
2. **Stubs.** `grep -L 'cortex:stub' ~/.claude/memory/*.md` lists only `MEMORY.md`, if anything.
3. **Comms.** `npx tsx bin/cortex-role.ts join test --create --as test-1`, then `send test hello --as test-1`, then `inbox --as test-1`. Leave the role afterwards.
4. **Status line.** When the session offers it, the person chooses with `/cortex-statusline`. It keeps their own status line and adds the Cortex segment.

If any check fails, stop and fix it before step 6. You can still go back: on path B, V1 is stopped but installed, so restore from step 1 and re-enable `cortex.service`; on path A, use the rollback under step 4.

## 6. Purge V1

**Claude:** work through [the V1 purge checklist](v1-purge.md) in order. Each item has a check that proves it is gone. Archive anything that holds data before deleting it. Never delete what the checklist marks as shared with V2.

**You:** approve each deletion. The checklist asks before anything that holds data.

## 7. Re-run the install

Now that V1's command files are gone, V2 can install the ones they shadowed.

**Claude:**

```bash
npx tsx bin/cortex-install.ts && npx tsx bin/cortex-status.ts
```

**Check:** no command is listed as shadowed or missing.

## 8. Connect your machines (optional)

V2 starts local-only: no daemon, no open port, no outbound link.

**You:** pick the network path. Every node that dials needs TCP to the listening node's mesh port (3021 by default) over a private address. The mesh refuses public ones. A laptop or WSL that can only dial out adds the other machine as a peer, and nothing needs to reach it.

**Claude:**

```bash
npx tsx bin/cortex-mesh.ts config alias <short-name>
npx tsx bin/cortex-mesh.ts listen on                 # on a machine others dial into
npx tsx bin/cortex-mesh.ts peers add <host>:3021      # on a machine that dials out
```

**Check:** `npx tsx bin/cortex-mesh.ts status` shows the peer as live.

### The private mind

**You:** confirm the central node from step 0.

**Claude**, on every machine (the central one included): write `~/.config/ckn/data/private-mind/mind.json`:

```json
{ "central": "<central node id, from cortex-mesh status>", "enabled": true }
```

Add `"localRoles"` or `"localDirs"` for work that must stay on that machine. Then:

```bash
npx tsx modules/private-mind/bin/cortex-mind.ts dry-run     # what would travel, and what stays home
npx tsx modules/private-mind/bin/cortex-mind.ts sync
npx tsx modules/private-mind/bin/cortex-mind.ts status
```

**Check:** `status` shows the same central, `degraded: false`, and a recent last sync on each machine. A memory written on one machine is found by `cortex-memory recall` on another after the next sync.

**A machine that is gone:** V2 does not read V1's private-mind git clone. To keep that machine's memories, copy its memory `.md` files from the clone into a folder under `~/.claude/memory/` on one live machine, then run `npx tsx bin/cortex-memory.ts sweep`. Do this on one machine only, or the same memories arrive twice.

## 9. Telegram and secrets (optional)

V2 has no built-in bot. **You:** create your own bot and keep its token in your secret store: environment variables, or OpenBao through `bao-run`. Never put the token in a file in the repo or in `settings.json`.

**Claude:** follow the telegram section of INSTALL.md. It writes `telegram.json` (bot names and the env var each reads, no secrets) and a systemd user unit, then runs `cortex-telegram-admin check`.

**Check:** `cortex-telegram-admin check` reports every required variable present, by name only.

## 10. Done

**Claude:** run the full check list in [v1-purge.md](v1-purge.md#final-check) one last time and report the result to the person. Keep the step 1 backup until you have worked a few sessions on V2.
