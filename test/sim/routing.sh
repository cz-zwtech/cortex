#!/usr/bin/env bash
# Throwaway simulation of Alex's mesh example, the P3 part: relay and
# liveness (node-a: docker and the cortex-lab:dev image; the checkout's own
# node_modules, read-only).
#
#   lan  (172.31.250.0/24): B and C
#   anet (172.31.251.0/24): A. A reaches B and C through ports published on
#        anet's gateway; nothing can reach A.
#   dnet (172.31.252.0/24): D, and B and C attached as a second network, so B
#        and C reach D directly. Nothing of D's is published on a host address
#        (every container can reach every host address), so A has no way to D,
#        and D none to A.
#
# Expected: A and D never link, yet reach each other through B (the lower id
# of two 2-hop relays). C going offline is withdrawn everywhere; B going
# offline too leaves A with no route to D, so D's roles are unavailable.
set -u
R=${R:-$(cd "$(dirname "$0")/../.." && pwd)}
[ -L "$R/node_modules" ] && { echo "node_modules in $R is a symlink: the sim mounts the checkout into a container, where the link target does not exist. Run npm ci in the checkout." >&2; exit 2; }
# One run of this sim at a time on a host (some use fixed subnets); names carry a run id besides.
LOCK=/tmp/cortex-sim-meshrt.lock; exec 9>>"$LOCK"; chmod 666 "$LOCK" 2>/dev/null; flock 9
P=meshrt-${RUN_ID:-$$}
LAN=172.31.250; ANET=172.31.251; DNET=172.31.252
cleanup() { docker rm -fv $P-a $P-b $P-c $P-d >/dev/null 2>&1; docker network rm $P-lan $P-anet $P-dnet >/dev/null 2>&1; }
cleanup
docker network create --subnet $LAN.0/24 $P-lan >/dev/null
docker network create --subnet $ANET.0/24 $P-anet >/dev/null
docker network create --subnet $DNET.0/24 $P-dnet >/dev/null
run() { # name net ip machine advertise extra
  docker run -d --init --name $P-$1 --network $P-$2 --ip $3 --tmpfs /tmp/h:uid=1000 -v $R:/opt/cortex:ro \
    -e HOME=/tmp/h -e CKN_MESH_DIR=/tmp/h/mesh -e CKN_MACHINE=$4 -e CKN_MESH_PORT=3021 -e CKN_MESH_ADVERTISE=$5 -e CKN_MODULES_DIR=/opt/cortex/modules \
    $6 -w /opt/cortex -u node cortex-lab:dev sh -c 'mkdir -p /tmp/h/mesh && exec node_modules/.bin/tsx bin/cortex-mesh.ts serve' >/dev/null
}
peer() { docker exec -u node $P-$1 sh -c "printf '{\"peers\":[\"$2\"]}\n' > /tmp/h/mesh/peers.json"; }
q() { docker exec -u node -w /opt/cortex -e CKN_MESH_DIR=/tmp/h/mesh $P-$1 node_modules/.bin/tsx -e "$2" 2>&1; }
join() {
  q $1 "import { Comms } from './modules/comms/server/comms.ts'; import { LocalIdentity } from './modules/comms/server/identity.ts'; import { MeshTransport } from './modules/comms/server/transport.ts'; import { MeshLog } from './modules/comms/server/mesh/log.ts';
  void new Comms(new MeshTransport(new MeshLog('/tmp/h/mesh','$2')), new LocalIdentity('/tmp/h/id'), { liveMs: 60000, settleMs: 0, sleep: async () => {} }).join('$3', { create: true, as: '$3-1' }).catch((e) => { console.error('JOIN FAILED', e); process.exit(1) })"
}
st() { docker exec $P-$1 cat /tmp/h/mesh/status.json; }
route() { st $1 | python3 -c "
import json,sys; s=json.load(sys.stdin); n=[x for x in s['nodes'] if x['node']=='$2']
r=n[0].get('route') if n else None
print(f\"via {r['nextHop']} ({r['hops']} hops)\" if r else 'unreachable')"; }
linked() { st $1 | python3 -c "import json,sys; s=json.load(sys.stdin); print(' '.join(sorted(l['node'] for l in s['links'] if l['ready'] and l['live'])))"; }
waitfor() { # description seconds command...
  local what=$1 secs=$2; shift 2
  for _ in $(seq 1 $secs); do if "$@" >/dev/null 2>&1; then echo "    ok: $what"; return 0; fi; sleep 1; done
  echo "    FAILED: $what"; FAILS=$((FAILS + 1)); return 1
}
is() { [ "$(route $1 $2)" = "$3" ]; }

run b lan $LAN.21 sim-b "http://$LAN.21:3021,http://$DNET.21:3021,http://$ANET.1:28521" "-p $ANET.1:28521:3021"
run c lan $LAN.22 sim-c "http://$LAN.22:3021,http://$DNET.22:3021,http://$ANET.1:28522" "-p $ANET.1:28522:3021"
docker network connect --ip $DNET.21 $P-dnet $P-b
docker network connect --ip $DNET.22 $P-dnet $P-c
run d dnet $DNET.10 sim-d "http://$DNET.10:3021" ""
run a anet $ANET.20 sim-a "http://$ANET.20:3021" ""
sleep 2
peer a "http://$ANET.1:28521"   # A is told of B
peer c "http://$LAN.21:3021"    # C is told of B
peer b "http://$DNET.10:3021"   # B is told of D
for n in a b c d; do join $n sim-$n $n-dev; done

echo "1. reachability:"
q a "fetch('http://$DNET.10:3021/health',{signal:AbortSignal.timeout(3000)}).then(r=>console.log('    A->D REACHED', r.status)).catch(e=>console.log('    A->D unreachable:', e.cause?.code ?? e.name))"
q d "fetch('http://$ANET.20:3021/health',{signal:AbortSignal.timeout(3000)}).then(r=>console.log('    D->A REACHED', r.status)).catch(e=>console.log('    D->A unreachable:', e.cause?.code ?? e.name))"
echo "2. mesh forms; A and D route through B:"
waitfor "A routes to D via sim-b" 120 is a sim-d "via sim-b (2 hops)"
waitfor "D routes to A via sim-b" 60 is d sim-a "via sim-b (2 hops)"
for n in a b c d; do echo "    sim-$n linked to: $(linked $n)"; done
echo "3. a record from A reaches D through the relay:"
q a "import { MeshLog } from './modules/comms/server/mesh/log.ts'; new MeshLog('/tmp/h/mesh','sim-a').append('mind-state','role:sim','A to D','a-to-d')" >/dev/null
waitfor "D holds A's record" 30 sh -c "docker exec -u node -w /opt/cortex -e CKN_MESH_DIR=/tmp/h/mesh $P-d node_modules/.bin/tsx -e \"import { MeshLog } from './modules/comms/server/mesh/log.ts'; process.exit(new MeshLog('/tmp/h/mesh','sim-d').read('role:sim').length ? 0 : 1)\""
echo "4. C goes offline: withdrawn everywhere, A still reaches D via B:"
docker stop -t 2 $P-c >/dev/null
waitfor "A: C unreachable" 60 is a sim-c unreachable
waitfor "D: C unreachable" 60 is d sim-c unreachable
waitfor "B: C unreachable" 60 is b sim-c unreachable
echo "    A to D: $(route a sim-d)"
echo "5. B goes offline too: A has no route to D, so D's roles are unavailable to A:"
docker stop -t 2 $P-b >/dev/null
waitfor "A: D unreachable" 60 is a sim-d unreachable
waitfor "D: A unreachable" 60 is d sim-a unreachable
st a | python3 -c "import json,sys; s=json.load(sys.stdin); [print('   ', n['node'], n['roles'], 'route' if n.get('route') else 'NO ROUTE') for n in s['nodes']]"
cleanup
echo "cleaned up"
[ "${FAILS:-0}" -eq 0 ] || { echo "$FAILS check(s) FAILED"; exit 1; }
