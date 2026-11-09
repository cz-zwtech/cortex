#!/usr/bin/env bash
# Private mind across throwaway containers (step 6d). Nothing here touches a
# real home, a real Cortex or real memory: every node's state is a tmpfs, the
# memories are made up, and mind.json is enabled only inside these containers.
#
#   pmsim-a, pmsim-b (central) and pmsim-g (a gateway) share one network;
#   pmsim-c is on a second network with only the gateway, until a home link is
#   added. Each home node runs a mesh daemon and a Cortex host (core/index.ts),
#   which runs private mind; the gateway runs a mesh daemon only.
#
# Proves: a round trip through central; the gateway's log never holds a
# mind-state record or a sync message, and a home-only send from C is refused
# while the gateway is its only path; C syncs once it has a home link; a
# redaction made on A removes the text on B and C; with central away C syncs
# from A and says it is degraded, and once central is back it reconciles and
# clears that.
set -u
R=${R:-$(cd "$(dirname "$0")/../.." && pwd)}
[ -L "$R/node_modules" ] && { echo "node_modules in $R is a symlink: the sim mounts the checkout into a container, where the link target does not exist. Run npm ci in the checkout." >&2; exit 2; }
GITDIR=$(git -C "$R" rev-parse --path-format=absolute --git-common-dir)
# One run of this sim at a time on a host; names carry a run id besides.
LOCK=/tmp/cortex-sim-pmsim.lock; exec 9>>"$LOCK"; chmod 666 "$LOCK" 2>/dev/null; flock 9
P=pmsim-${RUN_ID:-$$}
pass=0; fail=0
ok() { echo "  PASS  $1"; pass=$((pass+1)); }
no() { echo "  FAIL  $1"; fail=$((fail+1)); }
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else no "$what"; fi; }
waitcheck() { local what=$1 secs=$2; shift 2; for _ in $(seq 1 "$secs"); do "$@" >/dev/null 2>&1 && { ok "$what"; return; }; sleep 1; done; no "$what"; }
cleanup() { docker rm -fv $P-a $P-b $P-c $P-g >/dev/null 2>&1; docker network rm $P-net1 $P-net2 >/dev/null 2>&1; }
cleanup
docker network create $P-net1 >/dev/null && docker network create $P-net2 >/dev/null

envof() { echo "-e HOME=/tmp/h -e CKN_STATE_DIR=/tmp/h/ckn -e CKN_MODULES_DIR=/opt/cortex/modules -e CKN_MACHINE=node-$1 -e CKN_MESH_PORT=3021 -e CKN_MEMORY_DIRS=/tmp/h/mem -e CLAUDE_CONFIG_DIR=/tmp/h/.claude -e CKN_PORT=3011 ${2:-}"; }
mk() { docker run -d --init --name $P-$1 --network $P-$2 --network-alias $P-$1 --tmpfs /tmp/h:uid=1000 -v $R:/opt/cortex:ro -v $GITDIR:$GITDIR:ro --entrypoint sleep cortex-lab:dev infinity >/dev/null; }
X() { docker exec -u node -w /opt/cortex $(envof $1 "${3:-}") $P-$1 sh -c "$2"; }
T='node_modules/.bin/tsx'
daemon() { docker exec -d -u node -w /opt/cortex $(envof $1 "${2:-}") $P-$1 sh -c "mkdir -p /tmp/h/ckn/data/mesh && exec $T bin/cortex-mesh.ts serve >>/tmp/h/daemon.log 2>&1"; }
host() { docker exec -d -u node -w /opt/cortex $(envof $1) $P-$1 sh -c "exec $T core/index.ts >>/tmp/h/host.log 2>&1"; }
stop_node() { docker exec $P-$1 sh -c "pkill -f '[c]ore/index.ts'; pkill -f '[c]ortex-mesh.ts serve'" ; }
names() { X $1 "$T -e \"import { Journal } from './modules/memory/server/journal.ts'; console.log(new Journal({ dir: '/tmp/h/ckn/data/memory/journal', machine: 'node-$1' }).replay().map((r) => r.slug).sort().join(','))\""; }
has() { names $1 | grep -q "$2"; }
lacks() { ! names $1 | grep -q "$2"; }
memory() { X $1 "mkdir -p /tmp/h/mem && printf -- '---\nname: %s\ndescription: %s\ntype: decision\n---\n\n%s\n' '$2' '$3' '$3' > /tmp/h/mem/$2.md && $T bin/cortex-memory.ts sweep >/dev/null 2>&1"; }
mindjson() { X $1 "mkdir -p /tmp/h/ckn/data/private-mind && echo '{\"central\":\"node-b\",\"enabled\":true,\"syncEveryMin\":0.15}' > /tmp/h/ckn/data/private-mind/mind.json"; }
status() { X $1 "$T modules/private-mind/bin/cortex-mind.ts status"; }

echo "== setup: A, B (central) and gateway G on one network; C reaches only G"
mk a net1; mk b net1; mk g net1; mk c net2
docker network connect $P-net2 $P-g
for n in a b c; do mindjson $n; done
X g "mkdir -p /tmp/h/ckn/data/gateway && echo '{\"domain\":\"home\",\"peers\":[]}' > /tmp/h/ckn/data/gateway/gateway.json"
X g "$T -e \"import { ensureDomainKey } from './modules/gateway/server/keys.ts'; ensureDomainKey('/tmp/h/ckn/data/gateway', 'home')\"" "-e CKN_MESH_INTENT=gateway"
daemon g "-e CKN_MESH_INTENT=gateway"
X a "mkdir -p /tmp/h/ckn/data/mesh && $T bin/cortex-mesh.ts peers add http://$P-b:3021 >/dev/null"
X g "mkdir -p /tmp/h/ckn/data/mesh && $T bin/cortex-mesh.ts peers add http://$P-b:3021 >/dev/null" "-e CKN_MESH_INTENT=gateway"
X c "mkdir -p /tmp/h/ckn/data/mesh && $T bin/cortex-mesh.ts peers add http://$P-g:3021 >/dev/null"
for n in a b c; do daemon $n; host $n; done
memory a queue-choice 'The job queue is the append-only log.'
memory a cache-ttl 'Cache entries live five minutes.'
memory a leaky-note 'This note will be redacted later.'

gw_up() { X g "$T bin/cortex-mesh.ts status | grep -q 'live.*node-b'" "-e CKN_MESH_INTENT=gateway"; }
waitcheck "the gateway is up and linked to central" 120 gw_up
c_via_g() { X c "$T bin/cortex-mesh.ts status | grep -q 'live.*node-g'"; }
waitcheck "C is linked to the gateway, and to nothing else" 120 c_via_g

echo "== a round trip through central"
waitcheck "B (central) has A's memories" 150 has b queue-choice
waitcheck "... all three" 30 has b leaky-note
service_member() { X b "$T bin/cortex-role.ts show mind --as probe" | grep -q "service.*mind-node-b"; }
check "central's mind member shows as a service, not offline" service_member
check "C, behind the gateway only, has none of them" lacks c queue-choice
check "C's private mind has no source: no home route to any mind" bash -c "docker exec -u node -w /opt/cortex $(envof c) $P-c sh -c '$T modules/private-mind/bin/cortex-mind.ts status' | grep -q 'last sync: never'"
refused() { X c "$T -e \"
import { LocalIdentity } from './modules/comms/server/identity.ts'; import { Comms } from './modules/comms/server/comms.ts';
import { MeshTransport } from './modules/comms/server/transport.ts'; import { MeshLog } from './modules/comms/server/mesh/log.ts'; import { meshView } from './modules/comms/server/mesh/view.ts';
const c = new Comms(new MeshTransport(new MeshLog('/tmp/h/ckn/data/mesh', 'node-c')), new LocalIdentity('/tmp/h/ckn/data/comms'), { mesh: () => meshView('/tmp/h/ckn/data/mesh', 'node-c') });
(async () => { const r = await c.send('mind-node-c', 'node-b:mind', 'probe', { homeOnly: true });
require('node:fs').writeFileSync('/tmp/h/probe.out', JSON.stringify({ r, b: meshView('/tmp/h/ckn/data/mesh', 'node-c').nodes.find((n) => n.node === 'node-b') ?? null }));
process.exit(!r.ok && /through a gateway/.test(r.outcome) ? 0 : 1) })()\""; }
waitcheck "a home-only send from C to central is refused: its only route is the gateway" 60 refused
echo "    probe: $(docker exec $P-c cat /tmp/h/probe.out 2>/dev/null | head -c 700)"
[ -n "${STOP_AFTER_PROBE:-}" ] && { echo "STOP_AFTER_PROBE: containers kept"; exit 0; }

echo "== C gets a home link"
docker network connect $P-net1 $P-c
X c "$T bin/cortex-mesh.ts peers add http://$P-a:3021 >/dev/null"
waitcheck "C has A's memories, through central" 180 has c cache-ttl
gw_clean() { X g "$T -e \"
import { MeshLog } from './modules/comms/server/mesh/log.ts'; const l = new MeshLog('/tmp/h/ckn/data/mesh', 'node-g');
const n = l.db.prepare(\\\"SELECT COUNT(*) n FROM records WHERE kind = 'mind-state' OR payload LIKE '%mind.sync%' OR payload LIKE '%queue-choice%'\\\").get().n;
process.exit(n === 0 ? 0 : 1)\" && ! find /tmp/h/ckn/data/mesh/files -type f 2>/dev/null | grep -q ." "-e CKN_MESH_INTENT=gateway"; }
check "the gateway's log holds no mind-state, no sync message, no memory text, and no files" gw_clean

echo "== a redaction made on A reaches B and C"
X a "$T -e \"
import { Journal } from './modules/memory/server/journal.ts';
const j = new Journal({ dir: '/tmp/h/ckn/data/memory/journal', machine: 'node-a' });
const r = j.replay().find((x) => x.slug === 'leaky-note'); j.redact(r.contentHash, { note: 'sim' })\""
waitcheck "gone from B" 120 lacks b leaky-note
waitcheck "gone from C" 120 lacks c leaky-note
check "... and its text from B's disk" bash -c "! docker exec $P-b grep -rq 'will be redacted later' /tmp/h/ckn/data/memory/journal"

echo "== central away: C syncs from A, degraded; central back: reconcile"
stop_node b
memory a while-away 'Written while central was away.'
waitcheck "C has it from A" 120 has c while-away
waitcheck "C says it is degraded" 60 bash -c "docker exec -u node -w /opt/cortex $(envof c) $P-c sh -c '$T modules/private-mind/bin/cortex-mind.ts status' | grep -q DEGRADED"
daemon b; host b
waitcheck "central has what was written while it was away" 180 has b while-away
waitcheck "C reconciled with central: no longer degraded" 120 bash -c "! docker exec -u node -w /opt/cortex $(envof c) $P-c sh -c '$T modules/private-mind/bin/cortex-mind.ts status' | grep -q DEGRADED"
check "the gateway is still clean" gw_clean

echo
echo "private-mind sim: $pass passed, $fail failed"
[ -n "${KEEP:-}" ] && { echo "KEEP set: remove with: docker rm -fv $P-a $P-b $P-c $P-g; docker network rm $P-net1 $P-net2"; exit 0; }
cleanup
[ "$fail" -eq 0 ]
