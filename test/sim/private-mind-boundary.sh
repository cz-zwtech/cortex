#!/usr/bin/env bash
# Private mind as a module of its own (2 Nov 2026): it extends memory and comms and is
# built into none of them. One throwaway container; its modules dir holds links, so a module is
# removed by deleting its link, as an uninstall would.
#
# Proves, each on a running node (a mesh daemon and a Cortex host):
#   A. private-mind absent: memory and comms's own suites pass on a copy of the checkout with
#      no private-mind code at all; the node starts them, a memory is written and recalled, a
#      message goes and arrives.
#   B. present but not enabled: the same, and it says it is not enabled.
#   C. enabled, then removed: the node starts without it and works, and what it leaves behind is listed.
#   D. a dependency missing: private-mind is blocked by name, the rest runs.
# The static half (no imports either way, seams only, the manifest) is test/boundary.test.ts.
set -u
R=${R:-$(cd "$(dirname "$0")/../.." && pwd)}
[ -L "$R/node_modules" ] && { echo "node_modules in $R is a symlink: the sim mounts the checkout into a container, where the link target does not exist. Run npm ci in the checkout." >&2; exit 2; }
GITDIR=$(git -C "$R" rev-parse --path-format=absolute --git-common-dir)
P=pmbound-${RUN_ID:-$$}
pass=0; fail=0
ok() { echo "  PASS  $1"; pass=$((pass+1)); }
no() { echo "  FAIL  $1"; fail=$((fail+1)); }
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else no "$what"; fi; }
waitcheck() { local what=$1 secs=$2; shift 2; for _ in $(seq 1 "$secs"); do "$@" >/dev/null 2>&1 && { ok "$what"; return; }; sleep 1; done; no "$what"; }
cleanup() { docker rm -fv $P >/dev/null 2>&1; }
cleanup; trap cleanup EXIT

T='node_modules/.bin/tsx'
E="-e HOME=/tmp/h -e CKN_STATE_DIR=/tmp/h/ckn -e CKN_MODULES_DIR=/tmp/h/modules -e CKN_MACHINE=node-p -e CKN_MESH_PORT=3021 -e CKN_MEMORY_DIRS=/tmp/h/mem -e CLAUDE_CONFIG_DIR=/tmp/h/.claude -e CKN_PORT=3011"
X() { docker exec -u node -w /opt/cortex $E $P sh -c "$1"; }
docker run -d --init --name $P --tmpfs /tmp/h:uid=1000,exec -v $R:/opt/cortex:ro -v $GITDIR:$GITDIR:ro --entrypoint sleep cortex-lab:dev infinity >/dev/null
X "mkdir -p /tmp/h/modules /tmp/h/mem /tmp/h/ckn/data/mesh && for m in /opt/cortex/modules/*/; do ln -s \$m /tmp/h/modules/\$(basename \$m); done"
docker exec -d -u node -w /opt/cortex $E $P sh -c "exec $T bin/cortex-mesh.ts serve >>/tmp/h/daemon.log 2>&1"

host_up() { X "pkill -f '[c]ore/index.ts'; sleep 1; : > /tmp/h/host.log"; docker exec -d -u node -w /opt/cortex $E $P sh -c "exec $T core/index.ts >>/tmp/h/host.log 2>&1"; for _ in $(seq 1 30); do X "grep -q 'listening on' /tmp/h/host.log" && return; sleep 1; done; }
# One field of the host's /api/health, by a JS expression over it (h).
health() { X "node -e \"fetch('http://127.0.0.1:3011/api/health').then(r=>r.json()).then(h=>{const v=($1); console.log(typeof v==='string'?v:JSON.stringify(v)); process.exit(v?0:1)})\""; }
mod_health() { health "(h.health.find(x=>x.module==='$1')||{}).summary||''"; }
n=0
works() { # memory written and recalled; a message sent and received
  n=$((n+1))
  check "$1: memory and comms (with the mesh) started; nothing failed or blocked but what is expected" health "['memory','comms'].every(m=>h.modules.started.includes(m)) && h.modules.failed.length===0 && h.modules.blocked.every(b=>b.name==='${2:-}')"
  check "$1: a memory is written and recalled" X "printf -- '---\nname: boundary-fact-$n\ndescription: harbour crane count $n\ntype: decision\n---\n\nThe harbour has $n cranes.\n' > /tmp/h/mem/boundary-fact-$n.md && $T bin/cortex-memory.ts sweep >/dev/null 2>&1 && $T bin/cortex-memory.ts recall harbour crane count | grep -q boundary-fact-$n"
  check "$1: a message goes and arrives" X "$T bin/cortex-role.ts send echo 'ping $n' --as boundary-1 >/dev/null && $T bin/cortex-role.ts inbox --as echo-1 --all | grep -q 'ping $n'"
}
X "$T bin/cortex-role.ts join boundary --create --as boundary-1 >/dev/null && $T bin/cortex-role.ts join echo --create --as echo-1 >/dev/null"

echo "== A: private-mind absent"
X "rm /tmp/h/modules/private-mind"
check "A: memory and comms suites pass on a checkout copy with no private-mind code" X "mkdir /tmp/h/co && cd /opt/cortex && git -c safe.directory=* ls-files -co --exclude-standard | grep -v '^modules/private-mind/' | tar -cf - -T - | tar -xf - -C /tmp/h/co && ln -s /opt/cortex/node_modules /tmp/h/co/node_modules && cd /tmp/h/co && ! ls modules/private-mind 2>/dev/null && env -u CKN_MACHINE -u CKN_MESH_PORT -u CKN_PORT -u CKN_MEMORY_DIRS CKN_STATE_DIR=/tmp/h/suite-state CLAUDE_CONFIG_DIR=/tmp/h/suite-claude $T --test \$(for m in memory comms; do node -e \"const m=require('./modules/'+process.argv[1]+'/module.json'); console.log((m.tests||[]).map(t=>'modules/'+process.argv[1]+'/'+t).join(' '))\" \$m; done) >/tmp/h/suites.log 2>&1"
X "grep -E '^# (pass|fail)' /tmp/h/suites.log" | sed 's/^/        /'
host_up
check "A: the host does not know private-mind" health "!JSON.stringify(h.modules).includes('private-mind')"
works A

echo "== B: present, not enabled"
X "ln -s /opt/cortex/modules/private-mind /tmp/h/modules/private-mind && mkdir -p /tmp/h/ckn/data/private-mind && echo '{\"central\":\"node-p\",\"enabled\":false}' > /tmp/h/ckn/data/private-mind/mind.json"
host_up
check "B: private-mind says it is not enabled" health "((h.health.find(x=>x.module==='private-mind')||{}).summary||'').includes('NOT enabled')"
works B

echo "== C: enabled, then removed"
X "echo '{\"central\":\"node-p\",\"enabled\":true,\"syncEveryMin\":0.15}' > /tmp/h/ckn/data/private-mind/mind.json"
host_up
waitcheck "C: enabled, and its member joined comms" 30 X "$T bin/cortex-role.ts who | grep -q 'mind-node-p'"
mod_health private-mind | sed 's/^/        private-mind: /'
X "$T modules/private-mind/bin/cortex-mind.ts remove" | sed 's/^/        remove: /'
check "C: cortex-mind remove takes its member out of comms" X "! $T bin/cortex-role.ts who | grep -q 'mind-node-p'"
X "rm /tmp/h/modules/private-mind"
host_up
check "C: removed, the host does not know it" health "!JSON.stringify(h.modules).includes('private-mind')"
works C
check "C: no error in the host log after removal" X "! grep -iE 'error|exception|cannot' /tmp/h/host.log"
echo "        left behind (listed, not removed):"
X "ls /tmp/h/ckn/data/private-mind 2>/dev/null | tr '\n' ' ' | sed 's/^/          data\/private-mind: /'; echo"
X "$T bin/cortex-role.ts who | grep 'mind-node-p' | sed 's/^/          comms member (should be none): /'"
X "node -e \"const D=require('/opt/cortex/node_modules/better-sqlite3'); const d=new D('/tmp/h/ckn/data/mesh/mesh.sqlite',{readonly:true}); try { console.log('          mesh records of kind mind-state: '+d.prepare(\\\"SELECT count(*) n FROM records WHERE kind='mind-state'\\\").get().n) } catch (e) { console.log('          mesh log: '+e.message) }\""

echo "== D: a dependency missing"
X "ln -s /opt/cortex/modules/private-mind /tmp/h/modules/private-mind && rm /tmp/h/modules/memory"
host_up
check "D: private-mind is blocked, naming memory" health "(h.modules.blocked.find(b=>b.name==='private-mind')||{reason:''}).reason.includes('memory')"
health "h.modules.blocked" | sed 's/^/        blocked: /'
check "D: comms still starts" health "['comms'].every(m=>h.modules.started.includes(m))"
check "D: the host log names it" X "grep -i 'private-mind' /tmp/h/host.log | grep -q memory"
X "ln -s /opt/cortex/modules/memory /tmp/h/modules/memory"

echo; echo "private-mind boundary sim: $pass passed, $fail failed"
[ $fail -eq 0 ]
