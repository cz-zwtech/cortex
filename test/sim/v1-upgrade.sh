#!/usr/bin/env bash
# A V1 user upgrades: a new user whose ~/.claude holds V1 memory files (V1's format, no V1 wiring)
# gets the V2 tree, which carries a memory-shaped decoy inside the checkout. One throwaway container.
#
# Proves: the first sweep takes in exactly the user's own three V1 memories (two in ~/.claude/memory,
# one in ~/.claude/projects/-home-alex-work/memory) and nothing that rides along in the checkout;
# the planted files become stubs; the first-sweep backup is taken and holds the memory dirs.
set -u
SRC=${R:-$(cd "$(dirname "$0")/../.." && pwd)}
GITDIR=$(git -C "$SRC" rev-parse --path-format=absolute --git-common-dir)
P=v1up-${RUN_ID:-$$}
pass=0; fail=0
ok() { echo "  PASS  $1"; pass=$((pass+1)); }
no() { echo "  FAIL  $1"; fail=$((fail+1)); }
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else no "$what"; fi; }
cleanup() { docker rm -fv $P >/dev/null 2>&1; }
cleanup; trap cleanup EXIT

docker run -d --init --name $P -v $SRC:/src:ro -v $GITDIR:$GITDIR:ro --entrypoint sleep cortex-lab:dev infinity >/dev/null
Z() { docker exec $P bash -c "$1"; }
A() { docker exec $P runuser -l alex -c "cd ~/cortex; $1"; }
T='npx tsx'

echo "== a V1 user: memories in V1's format, no V1 wiring"
Z 'useradd -m -s /bin/bash alex'
A 'mkdir -p ~/.claude/memory ~/.claude/projects/-home-alex-work/memory
   printf -- "---\nname: v1-planted-alpha\ndescription: alpha feedback from V1\ntype: feedback\n---\n\nPrefer short answers about the alpha pipeline.\n" > ~/.claude/memory/v1-planted-alpha.md
   printf -- "---\nname: v1-planted-beta\ndescription: beta project note from V1\ntype: project\n---\n\nThe beta project ships from the west depot.\n" > ~/.claude/memory/v1-planted-beta.md
   printf -- "---\nname: v1-planted-gamma\ndescription: gamma project note scoped to work\ntype: project\n---\n\nThe gamma build runs on the night shift.\n" > ~/.claude/projects/-home-alex-work/memory/v1-planted-gamma.md' 2>/dev/null || true
check "three V1 memory files are in place" A '[ "$(find ~/.claude/memory ~/.claude/projects -name "v1-planted-*.md" | wc -l)" = 3 ]'

echo "== the V2 tree, with a decoy memory inside the checkout"
# Prefix match on tracked paths, as .public-exclude says.
Z 'mkdir -p /home/alex/cortex && cd /src
   git -c safe.directory=* ls-files -co --exclude-standard | awk "NR==FNR { if (\$0 !~ /^#/ && NF) x[++n]=\$0; next } { for (i=1;i<=n;i++) if (index(\$0, x[i])==1) next; print }" .public-exclude - | tar -cf - -T - | tar -xf - -C /home/alex/cortex
   chown -R alex /home/alex/cortex'
A 'mkdir -p docs memory
   printf -- "---\nname: decoy-should-not-ingest\ndescription: a decoy riding along in the checkout\ntype: project\n---\n\nThis decoy must never reach the store.\n" | tee docs/decoy-memory.md > memory/decoy.md'
check "the tree has no linear module" A '! ls modules/linear'
check "the decoys are in the checkout" A '[ -f docs/decoy-memory.md ] && [ -f memory/decoy.md ]'

echo "== npm ci, install, one session start, a sweep"
A 'npm ci --no-audit --no-fund > /tmp/ci.out 2>&1; echo $? > /tmp/ci.rc'
check "npm ci succeeds (the preinstall V1 check does not refuse: no V1 wiring)" A '[ "$(cat /tmp/ci.rc)" = 0 ]' || A 'tail -20 /tmp/ci.out' | sed 's/^/    /'
A "$T bin/cortex-install.ts > /tmp/install.out 2>&1; echo \$? > /tmp/install.rc"
check "install succeeds" A '[ "$(cat /tmp/install.rc)" = 0 ]'
check "a session start answers" A "echo '{\"session_id\":\"s1\",\"hook_event_name\":\"SessionStart\"}' | CLAUDE_CODE_ENTRYPOINT=cli $T bin/cortex-hook.ts SessionStart > /tmp/start.out 2>&1"
A "$T bin/cortex-memory.ts sweep > /tmp/sweep.out 2>&1"
A 'cat /tmp/sweep.out' | sed 's/^/    /' | head -15

echo "== the store holds exactly the user's own V1 memories"
A "$T bin/cortex-memory.ts list 100 2>/dev/null" > /tmp/$P.list
names=$(grep -E '^[^ ]' /tmp/$P.list | awk '{print $2}' | sort | tr '\n' ' ')
echo "    store: $names"
[ "$names" = "v1-planted-alpha v1-planted-beta v1-planted-gamma " ] && ok "the store holds exactly the three planted memories" || no "the store holds exactly the three planted memories"
check "the decoy is not in the store (list)" bash -c "! grep -q decoy /tmp/$P.list"
check "the decoy is not recalled" A "! $T bin/cortex-memory.ts recall decoy riding along checkout 2>/dev/null | grep -q decoy-should-not-ingest"
check "a planted memory is recalled by its words" A "$T bin/cortex-memory.ts recall beta project west depot 2>/dev/null | grep -q v1-planted-beta"
check "the project memory keeps its project scope" A "$T bin/cortex-memory.ts show v1-planted-gamma 2>/dev/null | grep -q '^scope: -home-alex-work'"
rm -f /tmp/$P.list

echo "== the files: planted ones stubbed, decoys untouched"
check "the three planted files are now stubs" A 'for f in ~/.claude/memory/v1-planted-alpha.md ~/.claude/memory/v1-planted-beta.md ~/.claude/projects/-home-alex-work/memory/v1-planted-gamma.md; do grep -q "cortex:stub" $f || exit 1; done'
check "the decoys are untouched (no stub)" A '! grep -q cortex:stub docs/decoy-memory.md && ! grep -q cortex:stub memory/decoy.md'

echo "== the first-sweep backup"
check "the first-sweep marker exists" A '[ -f ~/.config/ckn/data/memory/first-sweep-backup.json ]'
bk=$(A 'node -e "console.log(require(process.env.HOME + \"/.config/ckn/data/memory/first-sweep-backup.json\").file)"' 2>/dev/null)
echo "    backup: $bk"
check "the backup archive exists and reads back" A "tar tzf '$bk'"
check "the backup holds the planted V1 files" A "tar tzf '$bk' | grep -q 'home/alex/.claude/memory/v1-planted-alpha.md' && tar tzf '$bk' | grep -q 'home/alex/.claude/projects/-home-alex-work/memory/v1-planted-gamma.md'"
check "the backup holds nothing from the checkout" A "! tar tzf '$bk' | grep -q 'home/alex/cortex/'"

echo; echo "v1 upgrade sim: $pass passed, $fail failed"
[ $fail -eq 0 ]
