# V1 purge checklist

Run this only after V2 is installed and verified ([migration guide](migrating-from-v1.md), step 5). It is written for Claude Code on the machine being cleaned, with the person approving each deletion.

Every item ends with a **Check:** block. It exits 0 only when the item is gone, and non-zero while anything is left, printing what is left where it can. Run the check first: if it already passes, skip the item. After removing an item, run its check again. The [final check](#final-check) runs them all in a loop.

**Rules for Claude:**
- Archive anything marked **data** before deleting it, into the backup folder from migration step 1. Ask the person before each one.
- Never print the value of an environment variable or secret, only its name.
- V1 ignores `CLAUDE_CONFIG_DIR` and always used `~/.claude`. Check `~/.claude` even if that variable is set.

## Never delete these: V2 uses them too

| Path | Why |
|---|---|
| `~/.config/ckn/` (the folder itself) and in it: `machine-id`, `node-id`, `cortex.sqlite*`, `data/`, `modules/`, `backups/`, `core/`, `statusline.d/`, `hook-trace.ndjson`, `update.lock` | V2's own state. V2 keeps V1's machine id so the machine keeps its name |
| `~/.claude/settings.json.bak-cortex` | V2 writes a backup of the same name |
| `~/.claude/.env` (the file) | May hold other bootstrap settings. Remove V1's lines only (item 6) |
| Memory files under `~/.claude/memory/` and `~/.claude/projects/*/memory/` | V2 reads them. Once taken in they are stubs, and that is expected |
| `custom-title` lines in `~/.claude/projects/*/*.jsonl` | Claude Code's own session titles |
| Linger (`loginctl show-user "$USER" -p Linger`) | V2 service nodes need it too |

Set these once:

```bash
S=~/.config/ckn; C=~/.claude
REPO=$(cat "$S/home" 2>/dev/null)    # V1's checkout path; read it before item 10 removes the file
```

## 1. Processes and ports

V1's server re-adds its hooks when it starts, so it must be stopped first. The patterns match V1's own paths only (`$REPO`, set at the top), and the brackets keep a pattern from matching the shell that runs it.

```bash
systemctl --user disable --now cortex.service 2>/dev/null
[ -n "$REPO" ] && pkill -f "$REPO/server/index.ts"
pkill -f '[c]kn-vite-guard'; pkill -f '[c]kn-bus.*watch'; pkill -f '/bin/[c]kn-[a-z0-9-]+\.ts'; pkill -f '[c]ortex-runner\.sh'
```

**Check:**
```bash
! ss -ltn | grep -qE ':(3001|1420)\b' \
&& ! pgrep -f '[c]ortex-runner\.sh|[c]kn-bus.*watch|/bin/[c]kn-[a-z0-9-]+\.ts|[c]kn-vite-guard' >/dev/null \
&& { [ -z "$REPO" ] || ! pgrep -f "$REPO/server/index.ts" >/dev/null; }
```

If V1 had a mesh listener (`CKN_MESH_BIND`), it stopped with the server.

## 2. systemd units and cron

Remove `~/.config/systemd/user/cortex.service` and its enable link `~/.config/systemd/user/default.target.wants/cortex.service`, then run `systemctl --user daemon-reload`. V1 installed no system units and no cron entries. The checks confirm that.

**Check:**
```bash
[ ! -e ~/.config/systemd/user/cortex.service ] && [ ! -e ~/.config/systemd/user/default.target.wants/cortex.service ] \
&& ! systemctl --user cat cortex.service >/dev/null 2>&1 \
&& ! crontab -l 2>/dev/null | grep -qE 'ckn-|cortex-runner'
```

## 3. Hooks in settings.json

V1 registered seven hooks: `ckn-sync` (Stop), `ckn-recall` (PostToolUse), `ckn-pause-context` (UserPromptSubmit), `ckn-aware` (PreToolUse), `ckn-context` (SessionStart, and PostCompact on older installs), `ckn-precompact` (PreCompact) and `ckn-extract` (SessionEnd). Remove every hook whose command contains `ckn-`, keeping V2's `cortex-hook.ts` entries. Back up `settings.json` first (`cp ~/.claude/settings.json ~/.claude/settings.json.pre-v1-purge`).

Also look in `~/.claude/settings.local.json` and in any project `.claude/settings*.json` the person copied hooks into: add those files to `FILES` below.

**Check** (it also confirms V2's seven hooks are still there):
```bash
FILES=${FILES:-}; ok=1
for f in ~/.claude/settings.json ~/.claude/settings.local.json $FILES; do
  [ -f "$f" ] || continue
  jq -e '[.hooks // {} | .. | objects | .command? // empty | select(test("ckn-"))] | length == 0' "$f" >/dev/null || { echo "V1 hook left in $f"; ok=0; }
done
jq -e '[.hooks // {} | .. | objects | .command? // empty | select(test("cortex-hook"))] | length >= 7' ~/.claude/settings.json >/dev/null || { echo "V2 hooks missing"; ok=0; }
[ "$ok" = 1 ]
```

## 4. env and statusLine keys in settings.json

| Key | Action |
|---|---|
| `env.CORTEX_HOME_DIR`, `env.CKN_FORCE_SERVER` | Remove. V2 does not read them |
| `env.CKN_BIND` | **Ask first.** V2 reads `CKN_BIND` too (default `127.0.0.1`). V1 often set `0.0.0.0`. Removing it makes V2 bind to localhost only, which is usually what you want |
| Any other `env.CKN_*` | Review each with the person. V2 reads some (`CKN_STATE_DIR`, `CKN_MEMORY_DIRS`, `CKN_MESH_PORT`, ...) |
| `statusLine.command` = `~/.config/ckn/statusline.sh` | Remove only if V2's status line setup has not replaced it. Run `/cortex-statusline` afterwards |

**Check:**
```bash
jq -e '(.env // {}) | (has("CORTEX_HOME_DIR") or has("CKN_FORCE_SERVER")) | not' ~/.claude/settings.json >/dev/null \
&& jq -e '(.statusLine.command // "") | test("/\\.config/ckn/statusline\\.sh$") | not' ~/.claude/settings.json >/dev/null
```

## 5. Slash commands and skills

V1's command files end with `<!-- cortex-managed -->` (V2's carry `cortex:managed`, with no hyphen). Tell them apart **by the marker, never by the name**: both versions ship `cortex-rename.md`. V1 commands: `cortex-snapshot`, `cortex-sync`, `cortex-sync-shared`, `cortex-rename`, `cortex-bus`, `cortex-threads`, `cortex-continue`, `cortex-handoff`, `cortex-available`, `cortex-blast`, `cortex-codegraph-diff`, `cortex-profile-setup`. Older installs also have unmarked files `sync-shared`, `snapshot`, `rename`, `bus`, `available`, `blast`, `codegraph-diff` and `profile-setup` whose body runs `/bin/ckn-`.

The **`codegraph` skill** (`~/.claude/skills/codegraph/`) has no marker. Earlier purge tools missed it. It calls V1's server on `localhost:3001`, so it cannot work without V1: remove it. Remove any other skill that carries the V1 marker or runs `ckn-`, after showing it to the person.

**Check:**
```bash
! grep -lsF -- '<!-- cortex-managed -->' ~/.claude/commands/*.md ~/.claude/skills/*/SKILL.md | grep -q . \
&& ! grep -lsE '/bin/ckn-[a-z0-9-]+(\.ts)?' ~/.claude/commands/*.md ~/.claude/skills/*/SKILL.md | grep -q . \
&& [ ! -e ~/.claude/skills/codegraph ]
```

Then re-run `npx tsx bin/cortex-install.ts` so V2 fills any command V1 was shadowing.

## 6. CLAUDE.md, shell rc and .env

| Item | Where | Action |
|---|---|---|
| V1 engagement block | `~/.claude/CLAUDE.md`, between `<!-- cortex:managed:engagement` and `<!-- /cortex:managed:engagement -->` | **Data** (your preferences). V2 leaves it where it is. Show its lines to the person, turn the ones they want to keep into V2 standing rules (`/cortex-rules`), then remove the block |
| Preserved copy, if an earlier V2 made one | `~/.claude/cortex/preserved-v1-engagement.md` and its `@` import line | **Data.** V2 keeps importing it. Delete the file and the import line once every line is a standing rule |
| Alias block | `~/.bashrc`, `~/.zshrc`, `~/.config/fish/config.fish` (whichever the shell uses), between the `Cortex helpers (managed by ckn-install-aliases)` line and its `/Cortex helpers` closing line | Remove the block |
| `.env` lines | `~/.claude/.env`: `CKN_MESH_TOKEN_CMD=`, `CKN_PROFILE=`, and the `# Cortex driver-node env` header | Remove those lines only, never the file |

**Check:**
```bash
! grep -qsE '<!-- /?cortex:managed:engagement' ~/.claude/CLAUDE.md \
&& ! grep -qsE 'Cortex helpers|ckn-install-aliases|ckn-start' ~/.bashrc ~/.zshrc ~/.config/fish/config.fish ~/.profile ~/.bash_profile \
&& ! grep -qsE '^[[:space:]]*#?[[:space:]]*CKN_(MESH_TOKEN_CMD|PROFILE)=|Cortex driver-node env' ~/.claude/.env
```

Open shells keep the old `ckn-*` functions until they restart: `! compgen -A function | grep -q '^ckn-'` in a new shell.

## 7. V1 instructions in CLAUDE.md files

Hand-written lines in CLAUDE.md files can still teach Claude V1 behaviour: `ckn-*` scripts, `/snapshot` with `ckn-extract`, the dashboard on `localhost:3001`. Item 6 only removes V1's managed block, so these survive it.

**Claude:** search the user's CLAUDE.md, the files it imports from `~/.claude/cortex/`, and the CLAUDE.md files of every project the person names (set `PROJECTS` to those roots, space-separated). Show each line found to the person, and rewrite it to the V2 equivalent ([what changes](v1-features-in-v2.md)) with their OK. A line that only records history may stay if it ends with `(V1 history)`.

**Check:**
```bash
PROJECTS=${PROJECTS:-}
hits=$( { for f in ~/.claude/CLAUDE.md ~/.claude/cortex/*.md; do [ -f "$f" ] && echo "$f"; done
          for d in $PROJECTS; do for f in "$d/CLAUDE.md" "$d/.claude/CLAUDE.md"; do [ -f "$f" ] && echo "$f"; done; done; } \
        | xargs -r grep -nE 'ckn-|claude-config-dashboard|localhost:3001|:1420\b' 2>/dev/null | grep -v '(V1 history)')
[ -z "$hits" ] || { echo "$hits"; false; }
```

## 8. Scripts on PATH

V1 put no files on PATH: its CLIs were shell functions (item 6). Remove any `ckn-*` shims someone made by hand.

**Check:**
```bash
! ls ~/.local/bin/ckn-* /usr/local/bin/ckn-* 2>/dev/null | grep -q . && ! compgen -c | grep -q '^ckn-'
```

## 9. MCP entries

V1 registered no MCP server. This confirms it.

**Check:**
```bash
! jq -e '[.mcpServers // {} | to_entries[] | select((.value|tostring)|test("ckn-"))] | length > 0' ~/.claude.json >/dev/null 2>&1
```

## 10. Data files

Archive the **data** rows into the backup folder, ask, then delete. Everything else is wiring or cache.

| Path (under `~/.config/ckn/` unless shown) | Kind |
|---|---|
| `graph.sqlite`, `graph.sqlite-wal`, `graph.sqlite-shm`, `graph.db*` | **data** (V1 messages, sessions, code graph). V2 does not read it |
| `private-mind/` (git clone), `private-mind.state.json` | **data**. See migration step 8 for a machine that is gone. The remote repo is off-machine and stays as it is |
| `shared-mind/` | **data**, if you published to a team mind |
| `identity.yaml`, `onboarding-profile.json`, `ui-state.json`, `config.json` | **data** (small, user-written). `config.json` may reference a key: archive it, do not print it |
| `.ckn-node-id` next to a private-mind clone under `/mnt/*` | identity, archive |
| `home`, `mesh.json`, `mesh-peers.json`, `migrations.json`, `last-sync.json`, `usage-scores.json`, `imported-vaults.json`, `onboarding-seeded.json`, `profile-narrative.hash`, `auto-name-counter.json`, `file-cache.cache.json`, `conversation-meta.cache.json`, `token-cache.json`, `statusline.sh`, `embeddings/` | wiring or cache |
| `~/.local/state/ckn/` (logs, pid, caches, `sessions/`) | logs and cache |
| `${XDG_CACHE_HOME:-~/.cache}/huggingface/hub/models--Xenova--bge-small-en-v1.5` | model cache. Delete only this model folder: other tools may share the cache |
| The V1 checkout (`$REPO`) | code. Delete last, after every check passes, and **only if V2 runs from a different folder**. If you pulled V2 into your V1 checkout (migration path A), that folder is V2 now: keep it, and only remove the `home` pointer |

**Check:**
```bash
S=~/.config/ckn; left=
for n in home graph.sqlite graph.sqlite-wal graph.sqlite-shm embeddings private-mind private-mind.state.json shared-mind \
  mesh.json mesh-peers.json identity.yaml migrations.json last-sync.json usage-scores.json imported-vaults.json \
  onboarding-profile.json onboarding-seeded.json profile-narrative.hash auto-name-counter.json file-cache.cache.json \
  conversation-meta.cache.json ui-state.json token-cache.json config.json statusline.sh; do
  [ -e "$S/$n" ] && left="$left $S/$n"
done
for f in "$S"/graph.db*; do [ -e "$f" ] && left="$left $f"; done
[ -e ~/.local/state/ckn ] && left="$left ~/.local/state/ckn"
[ -n "$REPO" ] && [ -e "$REPO/bin/ckn-bus.ts" ] && left="$left $REPO"
[ -z "$left" ] || { printf 'left: %s\n' $left; false; }
```

## 11. Secrets stored elsewhere

V1 read `CKN_MESH_TOKEN` (and optionally an Anthropic key and an embeddings key) from a secret store such as OpenBao. V2 does not read `CKN_MESH_TOKEN`. **You:** remove those keys from your secret store if nothing else uses them. Claude lists key names only, and checks that nothing on this machine still asks for them.

**Check:**
```bash
! grep -qsE 'CKN_MESH_TOKEN|CKN_API_KEY_CMD|CKN_EMBED_API_KEY' ~/.claude/settings.json ~/.claude/.env ~/.config/systemd/user/*.service ~/.bashrc ~/.zshrc ~/.profile
```

## Final check

Every **Check:** block above can be run in one loop, which prints pass or FAIL per item and exits non-zero if any item fails. Run it from the V2 checkout with `REPO` still set from the top of this file:

```bash
dir=$(mktemp -d)
awk -v d="$dir" '
  /^## [0-9]+\./ { item = $2 + 0 }
  /^\*\*Check/  { want = 1; next }
  want && /^```bash$/ { inblk = 1; want = 0; f = sprintf("%s/item-%02d.sh", d, item); next }
  inblk && /^```$/   { inblk = 0; close(f); next }
  inblk { print > f }
' docs/v1-purge.md
failed=0
for f in "$dir"/item-*.sh; do
  if REPO="$REPO" bash "$f"; then echo "pass  $(basename "$f" .sh)"; else echo "FAIL  $(basename "$f" .sh)"; failed=1; fi
done
[ "$failed" = 0 ]
```

Then:

```bash
npx tsx bin/cortex-status.ts     # healthy, no shadowed or missing commands
```

Start a new Claude Code session. It must show no `ckn-` hook errors, and the session start must still show Cortex context. Report the result of every check to the person, with any item skipped and why.
