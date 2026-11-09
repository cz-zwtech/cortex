#!/usr/bin/env bash
# The acceptance rehearsal (design section 12): private mind on COPIES of real
# stores, in containers that cannot reach anything (an --internal network: no
# route off this host), so no real node, store or mesh is touched.
#
#   rehearsal.sh prepare <state dir> <out dir>   copy a node's stores (SQLite by its backup
#                                                API, reading only), without its mesh peers
#   rehearsal.sh run <central copy> [<hub copy>] [--local-dirs-central d,...] [--local-dirs-hub d,...]
#                    [--empty-hub-id <id>]   the empty hub runs under this id (default: a new one)
#
# run starts the central copy as central and, beside it, the hub copy (or, for
# the half where only one copy is cleared to move, or recovery, a fresh empty node). The
# hub pushes to central and pulls back; then it reports per node: memories in
# and out, held reasons, pointers, blocks, and five random shipped memories
# compared byte for byte at the far end. The copies are worked on in scratch
# directories and deleted afterwards; the out dirs of prepare stay until you
# delete them.
set -u
R=${R:-$(cd "$(dirname "$0")/../.." && pwd)}
[ -L "$R/node_modules" ] && { echo "node_modules in $R is a symlink: the sim mounts the checkout into a container, where the link target does not exist. Run npm ci in the checkout." >&2; exit 2; }
T='node_modules/.bin/tsx'

copydb() { node -e "const D=require('$R/node_modules/better-sqlite3'); const s=new D(process.argv[1],{readonly:true,fileMustExist:true}); s.backup(process.argv[2]).then(()=>s.close())" "$1" "$2"; }

if [ "${1:-}" = prepare ]; then
  src=${2:?state dir}; out=${3:?out dir}
  [ -e "$out" ] && { echo "refusing: $out exists" >&2; exit 2; }
  mkdir -p "$out/data/memory" "$out/data/mesh" && chmod 700 "$out"
  cp "$src/machine-id" "$out/machine-id" 2>/dev/null || cp "$src/node-id" "$out/node-id"
  [ -f "$src/node-id" ] && cp "$src/node-id" "$out/node-id"
  copydb "$src/cortex.sqlite" "$out/cortex.sqlite"
  cp -r "$src/data/memory/journal" "$out/data/memory/journal" && rm -f "$out/data/memory/journal/journal.lock"
  [ -f "$src/data/memory/context.sqlite" ] && copydb "$src/data/memory/context.sqlite" "$out/data/memory/context.sqlite"
  cp -r "$src/data/comms" "$out/data/comms"
  copydb "$src/data/mesh/mesh.sqlite" "$out/data/mesh/mesh.sqlite"
  # Never its peers: the copy must not know where to dial. Its node identity stays, as the real node's.
  node -e "const D=require('$R/node_modules/better-sqlite3'); const d=new D(process.argv[1]); try { d.exec('DELETE FROM nodes') } catch {} d.close()" "$out/data/mesh/mesh.sqlite"
  echo "prepared $out from $src: $(du -sh "$out" | cut -f1)"
  exit 0
fi

[ "${1:-}" = run ] || { echo "usage: rehearsal.sh prepare <state> <out> | run <central copy> [<hub copy>] [--local-dirs-central d,..] [--local-dirs-hub d,..]" >&2; exit 2; }
shift
CENTRAL=${1:?central copy}; shift
HUB=; case "${1:-}" in --*|'') ;; *) HUB=$1; shift ;; esac
LDC=; LDH=; EHID=rehearsal-empty-hub
while [ $# -gt 0 ]; do case $1 in --local-dirs-central) LDC=$2; shift 2 ;; --local-dirs-hub) LDH=$2; shift 2 ;; --empty-hub-id) EHID=$2; shift 2 ;; *) shift ;; esac; done

GITDIR=$(git -C "$R" rev-parse --path-format=absolute --git-common-dir)
LOCK=/tmp/cortex-sim-rehearsal.lock; exec 9>>"$LOCK"; chmod 666 "$LOCK" 2>/dev/null; flock 9
P=rehearsal-${RUN_ID:-$$}
WORK=$(mktemp -d); chmod 700 "$WORK"
cleanup() { [ -n "${KEEP:-}" ] && { echo "KEEP set: containers $P-central $P-hub and scratch $WORK kept"; return; }; docker rm -fv $P-central $P-hub >/dev/null 2>&1; docker network rm $P-net >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT
docker network create --internal $P-net >/dev/null

idof() { cat "$1/machine-id" 2>/dev/null || cat "$1/node-id"; }
cp -r "$CENTRAL" "$WORK/central"
CID=$(idof "$WORK/central")
if [ -n "$HUB" ]; then cp -r "$HUB" "$WORK/hub"; HID=$(idof "$WORK/hub"); else mkdir -p "$WORK/hub"; HID=$EHID; echo "$HID" > "$WORK/hub/machine-id"; fi
list() { node -e "console.log(JSON.stringify((process.argv[1]||'').split(',').filter(Boolean)))" "$1"; }
mind() { mkdir -p "$1/data/private-mind" && echo "{\"central\":\"$CID\",\"enabled\":true,\"syncEveryMin\":0.15,\"localRoles\":[\"contoso\"],\"localDirs\":$(list "$2")}" > "$1/data/private-mind/mind.json"; }
mind "$WORK/central" "$LDC"; mind "$WORK/hub" "$LDH"

envof() { echo "-e HOME=/tmp/h -e CKN_STATE_DIR=/tmp/h/ckn -e CKN_MODULES_DIR=/opt/cortex/modules -e CKN_MESH_PORT=3021 -e CKN_MEMORY_DIRS=/tmp/h/mem -e CLAUDE_CONFIG_DIR=/tmp/h/.claude -e CKN_PORT=3011"; }
mk() { docker run -d --init --name $P-$1 --network $P-net --network-alias $P-$1 --tmpfs /tmp/h:uid=$(id -u) -v $R:/opt/cortex:ro -v $GITDIR:$GITDIR:ro -v "$WORK/$1":/tmp/h/ckn --entrypoint sleep cortex-lab:dev infinity >/dev/null; }
X() { docker exec -u $(id -u) -w /opt/cortex $(envof) $P-$1 sh -c "$2"; }
up() { docker exec -d -u $(id -u) -w /opt/cortex $(envof) $P-$1 sh -c "mkdir -p /tmp/h/ckn/data/mesh && exec $T bin/cortex-mesh.ts serve >>/tmp/h/daemon.log 2>&1"; docker exec -d -u $(id -u) -w /opt/cortex $(envof) $P-$1 sh -c "exec $T core/index.ts >>/tmp/h/host.log 2>&1"; }
mk central; mk hub
X hub "$T bin/cortex-mesh.ts peers add http://$P-central:3021 >/dev/null"
up central; up hub

echo "rehearsal: central $CID${HUB:+, hub $HID}${HUB:- (and a fresh empty hub)}; isolated network, copies only"
vv() { X $1 "$T -e \"import { Journal } from './modules/memory/server/journal.ts'; console.log(JSON.stringify(new Journal({ dir: '/tmp/h/ckn/data/memory/journal', machine: '\$(cat /tmp/h/ckn/machine-id 2>/dev/null || cat /tmp/h/ckn/node-id)' }).versionVector()))\""; }
# Converged: the hub holds everything central holds (its own records and every other node's it
# carries, which is what a node rebuilt from central needs), and central holds the hub's.
converged() { local c h; c=$(vv central); h=$(vv hub); node -e "const c=JSON.parse(process.argv[1]), h=JSON.parse(process.argv[2]); const C=process.argv[3], H=process.argv[4]; process.exit(Object.keys(c).every((m) => m === H || (h[m]??0) >= c[m]) && (!process.argv[5] || (c[H]??0) >= (h[H]??0)) ? 0 : 1)" "$c" "$h" "$CID" "$HID" "$HUB"; }
# A hub under an id central already holds beyond the hub's journal must refuse to sync, not converge.
refused() { X hub "grep -m1 'private mind: refused:' /tmp/h/host.log" 2>/dev/null; }
for i in $(seq 1 120); do converged && break; [ $i -ge 6 ] && refused >/dev/null && break; sleep 5; done
if converged; then echo "converged after about $((i * 5)) s"; elif refused >/dev/null; then echo "REFUSED by the hub after about $((i * 5)) s:"; refused; else echo "NOT converged after 10 min: reporting what arrived"; fi

echo; echo "== per node"
for n in central hub; do echo "-- $n"; X $n "$T modules/private-mind/bin/cortex-mind.ts status"; echo "vector: $(vv $n)"; done
echo; echo "== what crossed"
X hub "$T -e \"
import { Journal } from './modules/memory/server/journal.ts';
const j = new Journal({ dir: '/tmp/h/ckn/data/memory/journal', machine: '$HID' });
const by = {}; for (const r of j.peerRecords()) by[r.machine + ' ' + r.kind] = (by[r.machine + ' ' + r.kind] ?? 0) + 1;
console.log('hub holds from others: ' + JSON.stringify(by))\""
[ -n "$HUB" ] && X central "$T -e \"
import { Journal } from './modules/memory/server/journal.ts';
const j = new Journal({ dir: '/tmp/h/ckn/data/memory/journal', machine: '$CID' });
const by = {}; for (const r of j.peerRecords()) by[r.machine + ' ' + r.kind] = (by[r.machine + ' ' + r.kind] ?? 0) + 1;
console.log('central holds from others: ' + JSON.stringify(by))\""

echo; echo "== five random shipped memories, byte for byte"
spot() { # $1 = node that wrote them, $2 its id, $3 = the node that received them
  X $1 "$T -e \"import { Journal } from './modules/memory/server/journal.ts'; const own = [...new Journal({ dir: '/tmp/h/ckn/data/memory/journal', machine: '$2' }).read()].filter((r) => r.kind === 'memory'); console.log(JSON.stringify(own))\"" > "$WORK/own.json"
  X $3 "$T -e \"import { Journal } from './modules/memory/server/journal.ts'; const j = new Journal({ dir: '/tmp/h/ckn/data/memory/journal', machine: 'x' }); console.log(JSON.stringify([...j.peerRecords()].filter((r) => r.kind === 'memory' && r.machine === '$2')))\"" > "$WORK/far.json"
  node -e "
const own = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf-8')), far = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf-8'));
const at = new Map(far.map((r) => [r.seq, r]));
const shipped = own.filter((r) => at.has(r.seq));
console.log('  ' + process.argv[3] + ': ' + shipped.length + ' of ' + own.length + ' own memories at the far end');
for (let i = 0; i < Math.min(5, shipped.length); i++) {
  const r = shipped.splice(Math.floor(Math.random() * shipped.length), 1)[0];
  const same = JSON.stringify(r) === JSON.stringify(at.get(r.seq));
  console.log('  ' + (same ? 'IDENTICAL ' : 'DIFFERENT ') + r.machine + ':' + r.seq + ' ' + (r.slug ?? ''));
}" "$WORK/own.json" "$WORK/far.json" "$1 -> $3"
}
spot central "$CID" hub
[ -n "$HUB" ] && spot hub "$HID" central
echo; echo "rehearsal done; containers and scratch copies removed"
