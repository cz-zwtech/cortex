#!/usr/bin/env bash
# Throwaway simulation of file transfer (P6) across a relay (node-a: docker and
# the cortex-lab:dev image; the checkout's own node_modules, read-only).
# Topology as routing.sh: A and D in VLANs that cannot reach each other.
#
#   1. A's session sends a folder (a page and an 80 MB binary) to d:ops
#   2. D's network is cut part-way through; on reconnect the transfer resumes
#   3. on D: every file verified against its hash, in ops' inbox folder;
#      relays B and C staged nothing
#   4. D's session reads it: A drops its snapshot
set -u
R=${R:-$(cd "$(dirname "$0")/../.." && pwd)}
[ -L "$R/node_modules" ] && { echo "node_modules in $R is a symlink: the sim mounts the checkout into a container, where the link target does not exist. Run npm ci in the checkout." >&2; exit 2; }
# One run of this sim at a time on a host (some use fixed subnets); names carry a run id besides.
LOCK=/tmp/cortex-sim-meshfl.lock; exec 9>>"$LOCK"; chmod 666 "$LOCK" 2>/dev/null; flock 9
P=meshfl-${RUN_ID:-$$}
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
cs d "await c.join('ops', { create: true, as: 'ops-1' })" >/dev/null
reach() { cs a "const v = (await import('./modules/comms/server/mesh/view.ts')).meshView('/tmp/h/mesh','node-a'); process.exit(v.nodes.some((n) => n.alias === 'd' && n.reachable && n.roles.some((r) => r.role === 'ops')) ? 0 : 1)"; }
waitfor "A sees d:ops reachable" 120 reach

docker exec -u node $P-a sh -c 'mkdir -p /tmp/h/src/site && echo "<h1>brief</h1>" > /tmp/h/src/site/index.html && head -c 83886080 /dev/urandom > /tmp/h/src/site/assets.bin && sha256sum /tmp/h/src/site/* | sed "s#/tmp/h/src/##"' > /tmp/$P-src.sha
echo "1. A sends the folder to d:ops:"
echo "    $(cs a "console.log((await c.send('pm-1', 'd:ops', 'the site', { files: ['/tmp/h/src/site'] })).outcome)")"
staging() { docker exec $P-d sh -c 'find /tmp/h/mesh/files/in -name "*.part" -size +0 2>/dev/null | head -1'; }
# Poll tightly: on a fast host the transfer takes seconds.
for _ in $(seq 1 600); do
  n=$(docker exec $P-d sh -c 'du -cb /tmp/h/mesh/files/in/*/*/*.part 2>/dev/null | tail -1 | cut -f1')
  [ "${n:-0}" -gt 1048576 ] && break; sleep 0.1
done
echo "2. cut D's network mid-transfer, then restore it:"
docker network disconnect $P-dnet $P-d
echo "    staged on D at the cut: $(docker exec $P-d sh -c 'du -cb /tmp/h/mesh/files/in/*/*/*.part 2>/dev/null | tail -1')"
sleep 3
docker network connect --ip $DNET.10 $P-dnet $P-d
has_files() { cs d "const i = await c.inbox('ops-1'); process.exit(i.some((x) => x.files?.length) ? 0 : 1)"; }
waitfor "D has the files after reconnecting" 180 has_files
echo "3. verify on D:"
docker exec $P-d sh -c 'cd /tmp/h/mesh/files/inbox/ops && sha256sum site/*' > /tmp/$P-dst.sha
if diff /tmp/$P-src.sha /tmp/$P-dst.sha >/dev/null; then echo "    ok: every file's hash matches the source"; else echo "    FAILED: hashes differ"; FAILS=$((FAILS + 1)); diff /tmp/$P-src.sha /tmp/$P-dst.sha; fi
echo "    D inbox: $(cs d "const i = await c.inbox('ops-1'); const m = i.find((x) => x.files?.length); console.log(m ? m.from + ': ' + m.body + ' -> ' + m.files.map((f) => f.path).join(', ') : '(no message with files)')")"
for r in b c; do echo "    relay $r staged: $(docker exec $P-$r sh -c 'ls /tmp/h/mesh/files/in 2>/dev/null | wc -l') transfer(s)"; done
echo "4. D reads it; A drops its snapshot:"
cs d "const i = await c.inbox('ops-1'); c.markSeen('ops-1', i.map((x) => x.id))" >/dev/null
snap_gone() { [ "$(docker exec $P-a sh -c 'ls /tmp/h/mesh/files/out 2>/dev/null | wc -l')" = 0 ]; }
waitfor "A's snapshot is gone" 60 snap_gone
rm -f /tmp/$P-src.sha /tmp/$P-dst.sha
cleanup
echo "cleaned up"
[ "${FAILS:-0}" -eq 0 ] || { echo "$FAILS check(s) FAILED"; exit 1; }
