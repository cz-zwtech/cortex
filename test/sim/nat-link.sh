#!/usr/bin/env bash
# Throwaway NAT simulation for mesh links (node-a: needs docker and the
# cortex-lab:dev image; uses the checkout's own node_modules, as cortex-lab
# does, so run npm ci in the checkout first). Two containers on separate docker
# networks: the "nat" node can dial out to the hub's published port, and the
# hub has no route to the nat node. Isolated HOME and mesh dirs in tmpfs; the
# repo (with node_modules) is mounted read-only. Everything is removed at the end.
# Run with R=<checkout> to point it at another tree.
set -u
R=${R:-$(cd "$(dirname "$0")/../.." && pwd)}
[ -L "$R/node_modules" ] && { echo "node_modules in $R is a symlink: the sim mounts the checkout into a container, where the link target does not exist. Run npm ci in the checkout." >&2; exit 2; }
# One run of this sim at a time on a host (some use fixed subnets); names carry a run id besides.
LOCK=/tmp/cortex-sim-meshsim.lock; exec 9>>"$LOCK"; chmod 666 "$LOCK" 2>/dev/null; flock 9
P=meshsim-${RUN_ID:-$$}
cleanup() { docker rm -fv $P-hub $P-nat >/dev/null 2>&1; docker network rm $P-hubnet $P-natnet >/dev/null 2>&1; }
cleanup
docker network create $P-hubnet >/dev/null
docker network create $P-natnet >/dev/null
GW=$(docker network inspect $P-natnet -f '{{(index .IPAM.Config 0).Gateway}}')
HOSTPORT=28499
run() { # name net machine extra-docker-args
  docker run -d --init --name $P-$1 --network $P-$2 --tmpfs /tmp/h:uid=1000 \
    -v $R:/opt/cortex:ro \
    -e HOME=/tmp/h -e CKN_MESH_DIR=/tmp/h/mesh -e CKN_MACHINE=$3 -e CKN_MESH_PORT=3021 -e CKN_MODULES_DIR=/opt/cortex/modules \
    $4 -w /opt/cortex -u node cortex-lab:dev \
    node_modules/.bin/tsx bin/cortex-mesh.ts serve >/dev/null
}
q() { docker exec -u node -w /opt/cortex -e CKN_MESH_DIR=/tmp/h/mesh $P-$1 node_modules/.bin/tsx -e "$2" 2>&1; }
join() { # container machine role: a session joins a role, which validates the node
  q $1 "import { Comms } from './modules/comms/server/comms.ts'; import { LocalIdentity } from './modules/comms/server/identity.ts'; import { MeshTransport } from './modules/comms/server/transport.ts'; import { MeshLog } from './modules/comms/server/mesh/log.ts';
  void new Comms(new MeshTransport(new MeshLog('/tmp/h/mesh','$2')), new LocalIdentity('/tmp/h/id'), { liveMs: 60000, settleMs: 0, sleep: async () => {} }).join('$3', { create: true, as: '$3-1' }).catch((e) => { console.error('JOIN FAILED', e); process.exit(1) })"
}
LOG="import { MeshLog } from './modules/comms/server/mesh/log.ts';"
append() { q $1 "$LOG new MeshLog('/tmp/h/mesh','$2').append('mind-state','role:sim','$3','$3')" >/dev/null; }
show() { q $1 "$LOG console.log(new MeshLog('/tmp/h/mesh','$2').read('role:sim').map(r=>'    '+r.origin+': '+r.payload).join('\n'))"; }
links() { docker exec $P-$1 cat /tmp/h/mesh/status.json | python3 -c "import json,sys; s=json.load(sys.stdin); [print('   ', l.get('node'), l['direction'], 'ready' if l['ready'] else 'not-ready', 'live' if l['live'] else 'down') for l in s['links']] or print('    (no links)')"; }
waitfor() { # container machine count seconds
  for _ in $(seq 1 $(($4 * 10))); do
    n=$(q $1 "$LOG console.log(new MeshLog('/tmp/h/mesh','$2').read('role:sim').length)")
    [ "$n" -ge "$3" ] && return 0; sleep 0.1
  done; return 1
}

run hub hubnet sim-hub "-p $GW:$HOSTPORT:3021"
run nat natnet sim-nat ""
docker exec -u node $P-nat sh -c "mkdir -p /tmp/h/mesh && printf '{\"peers\":[\"http://$GW:$HOSTPORT\"]}\n' > /tmp/h/mesh/peers.json"
NATIP=$(docker inspect $P-nat -f "{{(index .NetworkSettings.Networks \"$P-natnet\").IPAddress}}")
sleep 3
echo "1. hub -> nat node direct (must FAIL: no inbound to the NAT'd node):"
q hub "fetch('http://$NATIP:3021/health',{signal:AbortSignal.timeout(3000)}).then(r=>console.log('  REACHED', r.status)).catch(e=>console.log('  unreachable:', e.cause?.code ?? e.name))"
echo "2. before any role: linked but not ready (unvalidated nodes exchange nothing):"
links hub
join hub sim-hub sim-hub-role; join nat sim-nat sim-nat-role
sleep 1
echo "3. after each node has a role: the nat node's dialed link is ready on the hub:"
links hub
echo "4. records both ways over the one link, no polling:"
T0=$(date +%s%N); append nat sim-nat 'hello from behind NAT'; waitfor hub sim-hub 1 5 && echo "    nat -> hub in $(( ($(date +%s%N) - T0) / 1000000 )) ms (includes docker exec overhead)"
T0=$(date +%s%N); append hub sim-hub 'reply from hub'; waitfor nat sim-nat 2 5 && echo "    hub -> nat in $(( ($(date +%s%N) - T0) / 1000000 )) ms (includes docker exec overhead)"
echo "5. cut the nat node's network, write on both sides, restore it:"
docker network disconnect $P-natnet $P-nat
append hub sim-hub 'written on hub during the outage'; append nat sim-nat 'written on nat during the outage'
sleep 2
docker network connect $P-natnet $P-nat
if waitfor hub sim-hub 4 60 && waitfor nat sim-nat 4 60; then echo "    caught up both ways after the outage"; else echo "    NOT caught up"; fi
echo "  on hub:"; show hub sim-hub
echo "  on nat:"; show nat sim-nat
echo "6. hub status:"; links hub
cleanup
echo "cleaned up"
