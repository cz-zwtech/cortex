#!/usr/bin/env bash
# Throwaway simulation of routed comms (P4) across a relay (node-a: docker and the
# cortex-lab:dev image; the checkout's own node_modules, read-only). Topology
# as routing.sh: A and D in VLANs that cannot reach each other, B and C
# between them. Each node has an alias (a, b, c, d), so addresses read d:ops.
#
#   1. A's session pm-1 sends to d:ops; it arrives on D labelled a:pm/pm-1,
#      relayed through B, which stores nothing
#   2. DELIVERED reaches A; when D's session reads it, READ does, and A drops
#      its copy
#   3. D replies; the reply routes back to A
#   4. D's network is cut; A sends again: held at A; D back: delivered
set -u
R=${R:-$(cd "$(dirname "$0")/../.." && pwd)}
[ -L "$R/node_modules" ] && { echo "node_modules in $R is a symlink: the sim mounts the checkout into a container, where the link target does not exist. Run npm ci in the checkout." >&2; exit 2; }
# One run of this sim at a time on a host (some use fixed subnets); names carry a run id besides.
LOCK=/tmp/cortex-sim-meshrc.lock; exec 9>>"$LOCK"; chmod 666 "$LOCK" 2>/dev/null; flock 9
P=meshrc-${RUN_ID:-$$}
LAN=172.31.250; ANET=172.31.251; DNET=172.31.252
cleanup() { docker rm -fv $P-a $P-b $P-c $P-d >/dev/null 2>&1; docker network rm $P-lan $P-anet $P-dnet >/dev/null 2>&1; }
cleanup
docker network create --subnet $LAN.0/24 $P-lan >/dev/null
docker network create --subnet $ANET.0/24 $P-anet >/dev/null
docker network create --subnet $DNET.0/24 $P-dnet >/dev/null
run() { # name net ip alias advertise extra
  docker run -d --init --name $P-$1 --network $P-$2 --ip $3 --tmpfs /tmp/h:uid=1000 -v $R:/opt/cortex:ro \
    -e HOME=/tmp/h -e CKN_MESH_DIR=/tmp/h/mesh -e CKN_MACHINE=node-$4 -e CKN_NODE_ALIAS=$4 -e CKN_MESH_PORT=3021 -e CKN_MESH_ADVERTISE=$5 \
    $6 -w /opt/cortex -u node cortex-lab:dev sh -c 'mkdir -p /tmp/h/mesh && exec node_modules/.bin/tsx bin/cortex-mesh.ts serve' >/dev/null
}
peer() { docker exec -u node $P-$1 sh -c "printf '{\"peers\":[\"$2\"]}\n' > /tmp/h/mesh/peers.json"; }
# A comms session on node X: run one Comms call. $1 container, $2 JS using `c` (a Comms) and printing.
cs() {
  docker exec -u node -w /opt/cortex -e CKN_MESH_DIR=/tmp/h/mesh $P-$1 node_modules/.bin/tsx -e "
import { Comms } from './modules/comms/server/comms.ts'; import { LocalIdentity } from './modules/comms/server/identity.ts';
import { MeshTransport } from './modules/comms/server/transport.ts'; import { MeshLog } from './modules/comms/server/mesh/log.ts'; import { meshView } from './modules/comms/server/mesh/view.ts';
const c = new Comms(new MeshTransport(new MeshLog('/tmp/h/mesh','node-$1')), new LocalIdentity('/tmp/h/id'), { liveMs: 60000, settleMs: 0, sleep: async () => {}, mesh: () => meshView('/tmp/h/mesh','node-$1') });
void (async () => { $2 })().catch((e) => { console.error('ERR', e.message); process.exit(1) })" 2>&1
}
outbox() { docker exec -u node -w /opt/cortex $P-a node_modules/.bin/tsx -e "import { MeshLog } from './modules/comms/server/mesh/log.ts'; const l = new MeshLog('/tmp/h/mesh','node-a'); const r = l.db.prepare('SELECT id, delivered_at, read_at FROM outbox ORDER BY created').all(); console.log(JSON.stringify(r.map((x) => ({ id: x.id, delivered: !!x.delivered_at, read: !!x.read_at }))), 'held:', l.read('mesh:outbox').length)" 2>&1; }
waitfor() { local what=$1 secs=$2; shift 2
  for _ in $(seq 1 $secs); do if "$@" >/dev/null 2>&1; then echo "    ok: $what"; return 0; fi; sleep 1; done; echo "    FAILED: $what"; FAILS=$((FAILS + 1)); return 1; }
has() { cs $1 "const i = await c.inbox('$2'); process.exit(i.some((x) => x.body === '$3') ? 0 : 1)"; }
outbox_is() { outbox | grep -q "$1"; }

run b lan $LAN.21 b "http://$LAN.21:3021,http://$DNET.21:3021,http://$ANET.1:28521" "-p $ANET.1:28521:3021"
run c lan $LAN.22 c "http://$LAN.22:3021,http://$DNET.22:3021,http://$ANET.1:28522" "-p $ANET.1:28522:3021"
docker network connect --ip $DNET.21 $P-dnet $P-b
docker network connect --ip $DNET.22 $P-dnet $P-c
run d dnet $DNET.10 d "http://$DNET.10:3021" ""
run a anet $ANET.20 a "http://$ANET.20:3021" ""
sleep 2
peer a "http://$ANET.1:28521"; peer c "http://$LAN.21:3021"; peer b "http://$DNET.10:3021"
cs a "await c.join('pm', { create: true, as: 'pm-1' })" >/dev/null
cs b "await c.join('relay', { create: true, as: 'relay-1' })" >/dev/null
cs c "await c.join('relay2', { create: true, as: 'relay2-1' })" >/dev/null
cs d "await c.join('ops', { create: true, as: 'ops-1', meta: { cap: 'deploys' } })" >/dev/null
reach() { cs a "const v = (await import('./modules/comms/server/mesh/view.ts')).meshView('/tmp/h/mesh','node-a'); process.exit(v.nodes.some((n) => n.alias === 'd' && n.reachable && n.roles.some((r) => r.role === 'ops')) ? 0 : 1)"; }
waitfor "A sees d:ops reachable (2 hops, no direct link)" 120 reach

echo "1a. who --mesh on A lists every role across the relays, with liveness from the announcements:"
whomesh() { docker exec -u node -w /opt/cortex $P-a node_modules/.bin/tsx bin/cortex-role.ts who --mesh "$@" 2>&1; }
whomesh | sed 's/^/    /'
mesh_ok() { whomesh --json | grep -q '"address":"d:ops","reachable":true,"members":\[{"name":"ops-1","live":true}\]'; }
waitfor "A sees d:ops reachable with ops-1 live (2 hops)" 30 mesh_ok
live_ok() { [ "$(whomesh --live --json | grep -o '"address":"[^"]*"' | sort | tr '\n' ' ')" = '"address":"a:pm" "address":"b:relay" "address":"c:relay2" "address":"d:ops" ' ]; }
waitfor "--live lists the four roles, each with a live member" 10 live_ok
echo "1. A sends to d:ops through the relay:"
echo "    $(cs a "console.log((await c.send('pm-1', 'd:ops', 'deploy the brief')).outcome)")"
waitfor "D has it" 30 has d ops-1 'deploy the brief'
echo "    on D: $(cs d "const i = await c.inbox('ops-1'); console.log(i.map((x) => x.from + ': ' + x.body).join(' | '))")"
echo "    relay B's mailboxes: $(cs b "console.log((await c.inbox('relay-1', { includeSeen: true })).length) ") message(s); its log holds no ops mail: $(docker exec -u node -w /opt/cortex $P-b node_modules/.bin/tsx -e "import { MeshLog } from './modules/comms/server/mesh/log.ts'; console.log(new MeshLog('/tmp/h/mesh','node-b').read('cortex-comms:role:ops').length)")"
echo "2. DELIVERED, then READ when D's session reads it:"
waitfor "A: delivered, not read, still held" 30 outbox_is '"delivered":true,"read":false}] held: 1'
cs d "const i = await c.inbox('ops-1'); c.markSeen('ops-1', i.map((x) => x.id))" >/dev/null
waitfor "A: read, and its copy dropped" 30 outbox_is '"delivered":true,"read":true}] held: 0'
echo "2b. A sends again right after its first message was read, nothing in between: a new id, delivered (seq reuse, fixed):"
echo "    $(cs a "console.log((await c.send('pm-1', 'd:ops', 'right after the read')).outcome)")"
waitfor "D has the second message" 30 has d ops-1 'right after the read'
distinct() { [ "$(outbox | grep -o '"id":"[^"]*"' | sort -u | wc -l)" -eq 2 ]; }
waitfor "A's outbox holds two distinct ids" 10 distinct
echo "3. D replies; the reply routes back to A:"
echo "    $(cs d "const i = await c.inbox('ops-1', { includeSeen: true }); console.log((await c.reply('ops-1', i.find((x) => x.body === 'deploy the brief').id, 'done, deployed')).outcome)")"
waitfor "A has the reply" 30 has a pm-1 'done, deployed'
echo "    on A: $(cs a "const i = await c.inbox('pm-1'); console.log(i.map((x) => x.from + ': ' + x.body).join(' | '))")"
echo "4. D's network is cut; A sends; held at A until D is back:"
docker network disconnect $P-dnet $P-d
unreach() { ! reach; }
waitfor "A sees d unreachable" 60 unreach
echo "    $(cs a "console.log((await c.send('pm-1', 'd:ops', 'while you were cut off')).outcome)")"
sleep 3
echo "    A outbox while D is away: $(outbox)"
docker network connect --ip $DNET.10 $P-dnet $P-d
waitfor "D has it after reconnecting" 120 has d ops-1 'while you were cut off'
cleanup
echo "cleaned up"
[ "${FAILS:-0}" -eq 0 ] || { echo "$FAILS check(s) FAILED"; exit 1; }
