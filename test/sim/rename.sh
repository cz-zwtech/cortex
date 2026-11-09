#!/usr/bin/env bash
# Session naming in core, in a throwaway container (19 Oct). Nothing here
# touches a real home, a real Cortex or real memory.
#
#   one user, alex: first an EMPTY Cortex (no modules), then a full install.
#
# Proves: /cortex-rename works with no module and refuses [role] there; the
# next prompt's hook hands the title over once; with comms installed the
# command shows [role], the member follows the rename and joins the role, the
# harness's own /rename moves the member too, and a resume keeps the name.
set -u
SRC=${R:-$(cd "$(dirname "$0")/../.." && pwd)}
[ -L "$SRC/node_modules" ] && { echo "node_modules in $SRC is a symlink: the sim mounts the checkout into a container, where the link target does not exist. Run npm ci in the checkout." >&2; exit 2; }
# A worktree\'s .git points at the main repo by absolute path: mount it there, so git works inside.
GITDIR=$(git -C "$SRC" rev-parse --path-format=absolute --git-common-dir)
# One run of this sim at a time on a host (some use fixed subnets); names carry a run id besides.
LOCK=/tmp/cortex-sim-renamesim.lock; exec 9>>"$LOCK"; chmod 666 "$LOCK" 2>/dev/null; flock 9
P=renamesim-${RUN_ID:-$$}
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
hook() { U "echo '$2' | CLAUDE_CODE_ENTRYPOINT=cli $T bin/cortex-hook.ts $1"; }

echo "== setup: one user, this working tree as the checkout"
Z 'useradd -m -s /bin/bash alex
   mkdir -p /srv/cortex/cortex-v2-deploy && cd /src && git -c safe.directory=* ls-files -co --exclude-standard | tar -cf - -T - | tar -xf - -C /srv/cortex/cortex-v2-deploy
   cp -a /src/node_modules /srv/cortex/cortex-v2-deploy/ && chown -R alex /srv/cortex/cortex-v2-deploy
   runuser -l alex -c "mkdir -p ~/.config/ckn/modules ~/.claude"'

echo "== an EMPTY Cortex: no modules"
check "a role argument is refused, saying which module would take it" bash -c "docker exec $P-node-a runuser -l alex -c 'cd /srv/cortex/cortex-v2-deploy; CLAUDE_CODE_SESSION_ID=s1 $T bin/cortex-rename.ts docs-dev docs' 2>&1 | grep -q 'comms adds \[role\]'"
check "rename records the name" bash -c "docker exec $P-node-a runuser -l alex -c 'cd /srv/cortex/cortex-v2-deploy; CLAUDE_CODE_SESSION_ID=s1 $T bin/cortex-rename.ts docs-dev' | grep -q 'becomes docs-dev at your next prompt'"
check "the next prompt hands the title to the harness" bash -c "docker exec $P-node-a runuser -l alex -c \"cd /srv/cortex/cortex-v2-deploy; echo '{\\\"session_id\\\":\\\"s1\\\",\\\"session_title\\\":\\\"old\\\"}' | CLAUDE_CODE_ENTRYPOINT=cli $T bin/cortex-hook.ts UserPromptSubmit\" | grep -q '\"sessionTitle\":\"docs-dev\"'"
check "... once" bash -c "! docker exec $P-node-a runuser -l alex -c \"cd /srv/cortex/cortex-v2-deploy; echo '{\\\"session_id\\\":\\\"s1\\\",\\\"session_title\\\":\\\"docs-dev\\\"}' | CLAUDE_CODE_ENTRYPOINT=cli $T bin/cortex-hook.ts UserPromptSubmit\" | grep -q sessionTitle"

echo "== the full install: comms (and the mesh) installed"
U "$T bin/cortex-install.ts --no-mesh-start >/tmp/install.out 2>&1"
check "the installed /cortex-rename shows [role] (comms extends it)" U "grep -q 'argument-hint: \"<name> \[role\]\"' ~/.claude/commands/cortex-rename.md && grep -q 'cortex:managed:core' ~/.claude/commands/cortex-rename.md"
U "CLAUDE_CODE_SESSION_ID=s2 $T bin/cortex-role.ts join crew --as crew-1 --create >/dev/null"
U "CLAUDE_CODE_SESSION_ID=s2 $T bin/cortex-rename.ts crew-lead docs" | sed 's/^/    /'
check "the member follows the rename in its role" U "$T bin/cortex-role.ts show crew | grep -q crew-lead"
check "[role] joined it to docs under the new name" U "$T bin/cortex-role.ts show docs | grep -q crew-lead"
check "the title is handed over" bash -c "docker exec $P-node-a runuser -l alex -c \"cd /srv/cortex/cortex-v2-deploy; echo '{\\\"session_id\\\":\\\"s2\\\",\\\"session_title\\\":\\\"crew-1\\\"}' | CLAUDE_CODE_ENTRYPOINT=cli $T bin/cortex-hook.ts UserPromptSubmit\" | grep -q '\"sessionTitle\":\"crew-lead\"'"

echo "== the harness's own /rename, then a resume"
hook UserPromptSubmit '{"session_id":"s2","session_title":"crew-lead"}' >/dev/null
hook UserPromptSubmit '{"session_id":"s2","session_title":"crew-renamed"}' | sed 's/^/    /' | cut -c1-200
check "the member follows the harness rename" U "$T bin/cortex-role.ts show crew | grep -q crew-renamed"
check "a resume keeps the name and sets no title" bash -c "out=\$(docker exec $P-node-a runuser -l alex -c \"cd /srv/cortex/cortex-v2-deploy; echo '{\\\"session_id\\\":\\\"s2\\\",\\\"session_title\\\":\\\"crew-renamed\\\",\\\"source\\\":\\\"resume\\\"}' | CLAUDE_CODE_ENTRYPOINT=cli $T bin/cortex-hook.ts SessionStart\"); echo \"\$out\" | grep -q 'you are crew-renamed' && ! echo \"\$out\" | grep -q sessionTitle"

echo
echo "rename sim: $pass passed, $fail failed"
[ -n "${KEEP:-}" ] && { echo "KEEP set: remove with: docker rm -fv $P-node-a"; exit 0; }
cleanup
echo "cleaned up"
[ "$fail" -eq 0 ]
