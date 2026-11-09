#!/usr/bin/env bash
# Standing rules in a throwaway container (20 Oct). Nothing here touches a real
# home, a real Cortex or real memory.
#
# Proves: a full install wires the rules import into the user's CLAUDE.md,
# replacing V1's frozen block and keeping the user's own text; a rule memory
# swept in appears in rules.md with its reason; cortex-rules check finds a TODO
# outside quotes; the chat-reply audit logs and never blocks; status sees an
# empty import; uninstall removes the block and the file.
set -u
SRC=${R:-$(cd "$(dirname "$0")/../.." && pwd)}
[ -L "$SRC/node_modules" ] && { echo "node_modules in $SRC is a symlink: the sim mounts the checkout into a container, where the link target does not exist. Run npm ci in the checkout." >&2; exit 2; }
# A worktree\'s .git points at the main repo by absolute path: mount it there, so git works inside.
GITDIR=$(git -C "$SRC" rev-parse --path-format=absolute --git-common-dir)
# One run of this sim at a time on a host (some use fixed subnets); names carry a run id besides.
LOCK=/tmp/cortex-sim-rulessim.lock; exec 9>>"$LOCK"; chmod 666 "$LOCK" 2>/dev/null; flock 9
P=rulessim-${RUN_ID:-$$}
pass=0; fail=0
ok() { echo "  PASS  $1"; pass=$((pass+1)); }
no() { echo "  FAIL  $1"; fail=$((fail+1)); }
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else no "$what"; fi; }
cleanup() { docker rm -fv $P-node-a >/dev/null 2>&1; }
cleanup

docker run -d --init --name $P-node-a -v $SRC:/src:ro -v $GITDIR:$GITDIR:ro --entrypoint sleep cortex-lab:dev infinity >/dev/null
Z() { docker exec $P-node-a bash -c "$1"; }
U() { docker exec $P-node-a runuser -l alex -c "cd /srv/cortex/cortex-v2-deploy; $1"; }
T='node_modules/.bin/tsx'

echo "== setup: one user with V1's frozen block in CLAUDE.md"
Z 'useradd -m -s /bin/bash alex
   mkdir -p /srv/cortex/cortex-v2-deploy && cd /src && git -c safe.directory=* ls-files -co --exclude-standard | tar -cf - -T - | tar -xf - -C /srv/cortex/cortex-v2-deploy
   cp -a /src/node_modules /srv/cortex/cortex-v2-deploy/ && chown -R alex /srv/cortex/cortex-v2-deploy'
U 'mkdir -p ~/.claude/memory && printf "%s\n" "# Mine" "Keep this." "" "<!-- cortex:managed:engagement - regenerated -->" "## How to engage me" "- old" "<!-- /cortex:managed:engagement -->" > ~/.claude/CLAUDE.md'
docker exec -i $P-node-a runuser -l alex -c "cat > ~/.claude/memory/no-todo.md" <<'EOF'
---
name: no-todo
kind: rule
category: voice-and-writing
why: a TODO reads as unfinished work
scope: user
when: always
do: No TODO in shipped text
check: regex:\bTODO\b
enforce: audit
---
A TODO left in shipped text reads as unfinished work.
EOF

echo "== install"
U "$T bin/cortex-install.ts --no-mesh-start >/tmp/install.out 2>&1"
check "CLAUDE.md imports rules.md" U "grep -q '@~/.claude/cortex/rules.md' ~/.claude/CLAUDE.md"
check "V1's block is left as it was: the purge checklist removes it, never the install" U "grep -q 'How to engage me' ~/.claude/CLAUDE.md"
check "the user's own text is kept, and the original is backed up" U "grep -q 'Keep this.' ~/.claude/CLAUDE.md && grep -q 'How to engage me' ~/.claude/CLAUDE.md.before-cortex-imports"
check "rules.md exists before any rule (never an empty import)" U "test -s ~/.claude/cortex/rules.md"
U "CKN_CONSUME=off $T bin/cortex-memory.ts sweep >/dev/null 2>&1"
check "a swept rule is in rules.md with its reason" U "grep -q 'No TODO in shipped text (a TODO reads as unfinished work)' ~/.claude/cortex/rules.md"
printf 'Hi TODO there\nshe said "a TODO b"\n' | docker exec -i $P-node-a runuser -l alex -c 'cat > /tmp/draft.txt'
check "cortex-rules check finds a TODO outside quotes, and only that one" bash -c "docker exec $P-node-a runuser -l alex -c 'cd /srv/cortex/cortex-v2-deploy; $T bin/cortex-rules.ts check /tmp/draft.txt' | grep -q '^1 finding'"

echo "== the chat-reply audit"
U "printf '%s\n%s\n' '{\"type\":\"user\",\"message\":{\"content\":\"d\"}}' '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Hi Todd, here. TODO attach.\"}]}}' > /tmp/t.jsonl"
U "echo '{\"session_id\":\"s1\",\"prompt\":\"Write a WhatsApp message to Todd\"}' | CLAUDE_CODE_ENTRYPOINT=cli $T bin/cortex-hook.ts UserPromptSubmit >/dev/null 2>&1"
check "Stop does not block" bash -c "! docker exec $P-node-a runuser -l alex -c \"cd /srv/cortex/cortex-v2-deploy; echo '{\\\"session_id\\\":\\\"s1\\\",\\\"transcript_path\\\":\\\"/tmp/t.jsonl\\\"}' | CLAUDE_CODE_ENTRYPOINT=cli $T bin/cortex-hook.ts Stop\" 2>/dev/null | grep -q 'TODO'"
check "... and logs the finding for review" U "grep -q '\"event\":\"Stop\".*\"outcome\":\"audited-violation\"' ~/.config/ckn/data/memory/rule-fires.jsonl"

echo "== status and uninstall"
U ': > ~/.claude/cortex/rules.md'
U "$T bin/cortex-status.ts >/dev/null 2>&1"
check "an emptied rules.md is rewritten by the next Cortex run (it heals itself)" U "grep -q 'reads as unfinished work' ~/.claude/cortex/rules.md"
U 'mv ~/.config/ckn/modules/memory /tmp/memory-aside'
U ': > ~/.claude/cortex/rules.md'
check "with nothing to rewrite it, status warns about the empty import" U "$T bin/cortex-status.ts | grep -q 'missing or empty'"
U 'mv /tmp/memory-aside ~/.config/ckn/modules/memory'
U "$T bin/cortex-install.ts uninstall >/dev/null 2>&1"
check "uninstall removes the block and the file, keeps the user's text, and puts V1's lines back" U "! grep -q cortex:managed:imports ~/.claude/CLAUDE.md && grep -q 'Keep this.' ~/.claude/CLAUDE.md && grep -q 'How to engage me' ~/.claude/CLAUDE.md && ! test -e ~/.claude/cortex/rules.md"

echo
echo "rules sim: $pass passed, $fail failed"
[ -n "${KEEP:-}" ] && { echo "KEEP set: remove with: docker rm -fv $P-node-a"; exit 0; }
cleanup
echo "cleaned up"
[ "$fail" -eq 0 ]
