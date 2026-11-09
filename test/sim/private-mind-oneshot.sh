#!/usr/bin/env bash
# Private mind with no long-running host on a node (node-b, Alex's gaming PC): session hooks start a
# one-shot sync that runs a round, takes the answers and exits. Throwaway containers only.
#
#   B: central, mesh daemon + Cortex host (as node-a).   Z: mesh daemon only, hooks fired by hand (as node-b).
#
# Proves: a session start syncs both ways; nothing of Cortex stays running on Z after the run
# (no host ever, no sync process); the one-shot starts private mind and never telegram; a prompt
# right after is not due; session end carries a new write; two starts at once make one run.
set -u
R=${R:-$(cd "$(dirname "$0")/../.." && pwd)}
[ -L "$R/node_modules" ] && { echo "node_modules in $R is a symlink: the sim mounts the checkout into a container, where the link target does not exist. Run npm ci in the checkout." >&2; exit 2; }
GITDIR=$(git -C "$R" rev-parse --path-format=absolute --git-common-dir)
LOCK=/tmp/cortex-sim-pmoneshot.lock; exec 9>>"$LOCK"; chmod 666 "$LOCK" 2>/dev/null; flock 9
P=pmone-${RUN_ID:-$$}
pass=0; fail=0
ok() { echo "  PASS  $1"; pass=$((pass+1)); }
no() { echo "  FAIL  $1"; fail=$((fail+1)); }
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else no "$what"; fi; }
waitcheck() { local what=$1 secs=$2; shift 2; for _ in $(seq 1 "$secs"); do "$@" >/dev/null 2>&1 && { ok "$what"; return; }; sleep 1; done; no "$what"; }
cleanup() { docker rm -fv $P-b $P-z >/dev/null 2>&1; docker network rm $P-net >/dev/null 2>&1; }
cleanup; trap '[ -n "${KEEP:-}" ] || cleanup' EXIT
docker network create $P-net >/dev/null

T='node_modules/.bin/tsx'
envof() { echo "-e HOME=/tmp/h -e CKN_STATE_DIR=/tmp/h/ckn -e CKN_MODULES_DIR=/opt/cortex/modules -e CKN_MACHINE=node-$1 -e CKN_MESH_PORT=3021 -e CKN_MEMORY_DIRS=/tmp/h/mem -e CLAUDE_CONFIG_DIR=/tmp/h/.claude -e CKN_PORT=3011"; }
mk() { docker run -d --init --name $P-$1 --network $P-net --network-alias $P-$1 --tmpfs /tmp/h:uid=1000 -v $R:/opt/cortex:ro -v $GITDIR:$GITDIR:ro --entrypoint sleep cortex-lab:dev infinity >/dev/null; }
X() { docker exec -u node -w /opt/cortex $(envof $1) $P-$1 sh -c "$2"; }
daemon() { docker exec -d -u node -w /opt/cortex $(envof $1) $P-$1 sh -c "mkdir -p /tmp/h/ckn/data/mesh && exec $T bin/cortex-mesh.ts serve >>/tmp/h/daemon.log 2>&1"; }
host() { docker exec -d -u node -w /opt/cortex $(envof $1) $P-$1 sh -c "exec $T core/index.ts >>/tmp/h/host.log 2>&1"; }
names() { X $1 "$T -e \"import { Journal } from './modules/memory/server/journal.ts'; console.log(new Journal({ dir: '/tmp/h/ckn/data/memory/journal', machine: 'node-$1' }).replay().map((r) => r.slug).sort().join(','))\""; }
has() { names $1 | grep -q "$2"; }
memory() { X $1 "mkdir -p /tmp/h/mem && printf -- '---\nname: %s\ndescription: %s\ntype: decision\n---\n\n%s\n' '$2' '$3' '$3' > /tmp/h/mem/$2.md && $T bin/cortex-memory.ts sweep >/dev/null 2>&1"; }
mindjson() { X $1 "mkdir -p /tmp/h/ckn/data/private-mind && echo '{\"central\":\"node-b\",\"enabled\":true,\"syncEveryMin\":${2:-15}}' > /tmp/h/ckn/data/private-mind/mind.json"; }
hook() { X z "echo '{\"session_id\":\"s1\",\"hook_event_name\":\"$1\"}' | CLAUDE_CODE_ENTRYPOINT=cli $T bin/cortex-hook.ts $1 >/dev/null 2>&1"; }
runs() { X z "grep -c ' sync: ' /tmp/h/ckn/data/private-mind/sync.log 2>/dev/null || echo 0"; }
synced() { X z "grep ' sync: ' /tmp/h/ckn/data/private-mind/sync.log | grep -c '\"ran\":true'"; }
idle() { X z "! pgrep -f '[c]ortex-mind.ts sync' && ! pgrep -f '[c]ore/index.ts'"; }

echo "== setup: B central with a host; Z with a mesh daemon and nothing else"
mk b; mk z
mindjson b 0.15; mindjson z
X z "mkdir -p /tmp/h/ckn/data/telegram && echo '{\"bots\":{}}' > /tmp/h/ckn/data/telegram/telegram.json"
X z "mkdir -p /tmp/h/ckn/data/mesh && $T bin/cortex-mesh.ts peers add http://$P-b:3021 >/dev/null"
daemon b; host b; daemon z
memory b pool-size 'The pool holds eight workers.'
memory z queue-choice 'The job queue is the append-only log.'
memory z cache-ttl 'Cache entries live five minutes.'
sleep 8

echo "== a session starts on Z"
hook SessionStart
z_on_b() { has b queue-choice && has b cache-ttl; }
waitcheck "Z's memories reach central" 120 z_on_b
waitcheck "central's memory reaches Z" 60 has z pool-size
waitcheck "the run exits by itself; no Cortex host or sync process stays on Z" 240 idle
check "the one-shot started private mind and not telegram" X z "tail -1 /tmp/h/ckn/data/private-mind/sync.log | grep -q '\"private-mind\"' && ! tail -1 /tmp/h/ckn/data/private-mind/sync.log | grep -q telegram"
X z "tail -1 /tmp/h/ckn/data/private-mind/sync.log" | sed 's/^/        /'

echo "== a prompt right after: not due"
n=$(runs); hook UserPromptSubmit; sleep 5
check "no second run" sh -c "[ \"\$(docker exec -u node $P-z sh -c 'grep -c \" sync: \" /tmp/h/ckn/data/private-mind/sync.log')\" = '$n' ] && ! docker exec $P-z pgrep -f '[c]ortex-mind.ts sync'"

echo "== a new write, then the session ends"
memory z retry-limit 'Retries stop after three attempts.'
hook SessionEnd
waitcheck "session end carries it to central" 120 has b retry-limit
waitcheck "and exits" 240 idle

echo "== two session starts at once"
m=$(synced); hook SessionStart & hook SessionStart; wait
waitcheck "settled" 240 idle
check "one run, not two" sh -c "[ $(synced) -eq $((m + 1)) ]"

echo; echo "private-mind one-shot sim: $pass passed, $fail failed"
[ $fail -eq 0 ]
