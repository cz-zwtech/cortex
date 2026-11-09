#!/usr/bin/env bash
# Throwaway simulation of Alex's mesh example, the P2 part (node-a: docker and the
# cortex-lab:dev image; uses the checkout's own node_modules, read-only).
#
#   lan  (172.31.250.0/24): B, C, D can all reach each other
#   anet (172.31.251.0/24): A, in its own VLAN. A reaches B, C and D through
#        ports published on anet's gateway; nothing on lan can reach A.
#
# Configured: A knows only B, C knows only B, D knows only C. Expected:
# gossip completes the mesh (6 links), and every link involving A was
# dialed by A, because nobody else can reach it.
set -u
R=${R:-$(cd "$(dirname "$0")/../.." && pwd)}
[ -L "$R/node_modules" ] && { echo "node_modules in $R is a symlink: the sim mounts the checkout into a container, where the link target does not exist. Run npm ci in the checkout." >&2; exit 2; }
# One run of this sim at a time on a host (some use fixed subnets); names carry a run id besides.
LOCK=/tmp/cortex-sim-meshgsp.lock; exec 9>>"$LOCK"; chmod 666 "$LOCK" 2>/dev/null; flock 9
P=meshgsp-${RUN_ID:-$$}
LAN=172.31.250; ANET=172.31.251
cleanup() { docker rm -fv $P-a $P-b $P-c $P-d >/dev/null 2>&1; docker network rm $P-lan $P-anet >/dev/null 2>&1; }
cleanup
docker network create --subnet $LAN.0/24 $P-lan >/dev/null
docker network create --subnet $ANET.0/24 $P-anet >/dev/null
GW=$ANET.1
run() { # name net ip machine advertise extra
  docker run -d --init --name $P-$1 --network $P-$2 --ip $3 --tmpfs /tmp/h:uid=1000 -v $R:/opt/cortex:ro \
    -e HOME=/tmp/h -e CKN_MESH_DIR=/tmp/h/mesh -e CKN_MACHINE=$4 -e CKN_MESH_PORT=3021 -e CKN_MESH_ADVERTISE=$5 \
    $6 -w /opt/cortex -u node cortex-lab:dev sh -c 'mkdir -p /tmp/h/mesh && exec node_modules/.bin/tsx bin/cortex-mesh.ts serve' >/dev/null
}
peer() { docker exec -u node $P-$1 sh -c "mkdir -p /tmp/h/mesh && printf '{\"peers\":[\"$2\"]}\n' > /tmp/h/mesh/peers.json"; }
q() { docker exec -u node -w /opt/cortex -e CKN_MESH_DIR=/tmp/h/mesh $P-$1 node_modules/.bin/tsx -e "$2" 2>&1; }
join() {
  q $1 "import { Comms } from './modules/comms/server/comms.ts'; import { LocalIdentity } from './modules/comms/server/identity.ts'; import { MeshTransport } from './modules/comms/server/transport.ts'; import { MeshLog } from './modules/comms/server/mesh/log.ts';
  void new Comms(new MeshTransport(new MeshLog('/tmp/h/mesh','$2')), new LocalIdentity('/tmp/h/id'), { liveMs: 60000, settleMs: 0, sleep: async () => {} }).join('$3', { create: true, as: '$3-1', meta: { cap: '$4' } }).catch((e) => { console.error('JOIN FAILED', e); process.exit(1) })"
}
links() { docker exec $P-$1 cat /tmp/h/mesh/status.json | python3 -c "
import json,sys; s=json.load(sys.stdin)
ready=sorted((l['node'], l['direction']) for l in s['links'] if l['ready'] and l['live'])
print('   ', s['node'], '->', ', '.join(f'{n} ({d})' for n,d in ready) or '(none)')"; }
count() { docker exec $P-$1 cat /tmp/h/mesh/status.json | python3 -c "import json,sys; s=json.load(sys.stdin); print(len({l['node'] for l in s['links'] if l['ready'] and l['live']}))"; }

run b lan $LAN.11 sim-b "http://$LAN.11:3021,http://$GW:28511" "-p $GW:28511:3021"
run c lan $LAN.12 sim-c "http://$LAN.12:3021,http://$GW:28512" "-p $GW:28512:3021"
run d lan $LAN.13 sim-d "http://$LAN.13:3021,http://$GW:28513" "-p $GW:28513:3021"
run a anet $ANET.10 sim-a "http://$ANET.10:3021" ""
peer a "http://$GW:28511"      # A is told only of B (through its published port)
peer c "http://$LAN.11:3021"   # C is told only of B
peer d "http://$LAN.12:3021"   # D is told only of C
sleep 2
for n in a b c d; do join $n sim-$n $n-dev "builds $n things"; done

echo "1. lan -> A direct (must FAIL: nothing on lan can reach A):"
q d "fetch('http://$ANET.10:3021/health',{signal:AbortSignal.timeout(3000)}).then(r=>console.log('  REACHED', r.status)).catch(e=>console.log('  unreachable:', e.cause?.code ?? e.name))"
echo "2. waiting for gossip to complete the mesh (each node linked to the other 3)..."
ok=0
for _ in $(seq 1 120); do
  if [ "$(count a)" = 3 ] && [ "$(count b)" = 3 ] && [ "$(count c)" = 3 ] && [ "$(count d)" = 3 ]; then ok=1; break; fi
  sleep 1
done
[ $ok = 1 ] && echo "   complete" || echo "   NOT COMPLETE after 120 s"
echo "3. links (direction is from each node's own view):"
for n in a b c d; do links $n; done
echo "4. A's links must all be 'out' (A dialed every one):"
docker exec $P-a cat /tmp/h/mesh/status.json | python3 -c "
import json,sys; s=json.load(sys.stdin); d=[l['direction'] for l in s['links'] if l['ready'] and l['live']]
print('   ', 'PASS' if d and all(x=='out' for x in d) else 'FAIL', d)"
echo "5. what D knows about A (learned by gossip; D was never told of A):"
docker exec $P-d cat /tmp/h/mesh/status.json | python3 -c "
import json,sys; s=json.load(sys.stdin); [print('   ', n) for n in s['nodes'] if n['node']=='sim-a']"
q d "import { NodeTable } from './modules/comms/server/mesh/nodes.ts'; import { MeshLog } from './modules/comms/server/mesh/log.ts'; const n = new NodeTable(new MeshLog('/tmp/h/mesh','sim-d').db).get('sim-a'); console.log('    members:', JSON.stringify(n?.members))"
cleanup
echo "cleaned up"
