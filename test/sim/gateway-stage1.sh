#!/usr/bin/env bash
# Stage 1 of the gateway bring-up (21 Oct 2026): the real gateway box E on the
# devlab VLAN, tested from throwaway containers on this host. Nothing real is
# touched but E itself: every other node is a container, and each one dials E
# (E never dials inward).
#
#   B  a home-domain node (pm-1 in pm, dev-1 in dev), dialling E's mesh port 3021
#   F  a test peer gateway, domain lab-peer, dialling E's external port 28417
#   G  F's home node (lp-1 in lp-dev)
#
# Usage:
#   gateway-stage1.sh setup <E address> <E pin>   start B, F, G; print what to put in E's gateway.json
#   gateway-stage1.sh check                       run the checks (after E's gateway.json has the snippet)
#   gateway-stage1.sh clean
set -u
R=${R:-$(cd "$(dirname "$0")/../.." && pwd)}
[ -L "$R/node_modules" ] && { echo "node_modules in $R is a symlink: the sim mounts the checkout into a container, where the link target does not exist. Run npm ci in the checkout." >&2; exit 2; }
P=gwstage1
NET=172.31.243
STATE=/tmp/$P.env
pass=0; fail=0
ok() { echo "  PASS  $1"; pass=$((pass+1)); }
no() { echo "  FAIL  $1"; fail=$((fail+1)); }
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else no "$what"; fi; }
waitcheck() { local what=$1 secs=$2; shift 2; for _ in $(seq 1 "$secs"); do "$@" >/dev/null 2>&1 && { ok "$what"; return; }; sleep 1; done; no "$what"; }
GW=/tmp/h/.config/ckn/data/gateway
X() { docker exec -u node -w /opt/cortex $P-$1 sh -c "$2"; }
cs() {
  docker exec -u node -w /opt/cortex $P-$1 node_modules/.bin/tsx -e "
import { Comms } from './modules/comms/server/comms.ts'; import { LocalIdentity } from './modules/comms/server/identity.ts';
import { MeshTransport } from './modules/comms/server/transport.ts'; import { MeshLog } from './modules/comms/server/mesh/log.ts'; import { meshView } from './modules/comms/server/mesh/view.ts';
const c = new Comms(new MeshTransport(new MeshLog('/tmp/h/mesh','node-$1')), new LocalIdentity('/tmp/h/id'), { liveMs: 600000, settleMs: 0, sleep: async () => {}, mesh: () => meshView('/tmp/h/mesh','node-$1') });
void (async () => { $2 })().catch((e) => { console.error('ERR', e.message); process.exit(1) })" 2>&1
}
has() { cs $1 "const i = await c.inbox('$2', { includeSeen: true }); process.exit(i.some((x) => x.body.includes('$3')) ? 0 : 1)"; }
ext() { cs $1 "const e = c.meshView().external.find((x) => x.domain === '$2'); process.exit(e && e.linked && JSON.stringify(e.roles) === '$3' ? 0 : 1)"; }
clean() { docker rm -fv $P-b $P-f $P-g >/dev/null 2>&1; docker network rm $P-lan >/dev/null 2>&1; }

case "${1:-}" in
setup)
  EADDR=${2:?E address}; EPIN=${3:?E pin}
  clean
  docker network create --subnet $NET.0/24 $P-lan >/dev/null
  for n in b f g; do
    docker run -d --init --name $P-$n --network $P-lan --tmpfs /tmp/h:uid=1000 -v $R:/opt/cortex:ro \
      -e HOME=/tmp/h -e CKN_MESH_DIR=/tmp/h/mesh -e CKN_MACHINE=node-$n -e CKN_NODE_ALIAS=stage1-$n -e CKN_MESH_PORT=3021 \
      -e CKN_MODULES_DIR=/opt/cortex/modules -w /opt/cortex -u node --entrypoint sleep cortex-lab:dev infinity >/dev/null
    X $n "mkdir -p /tmp/h/mesh $GW"
  done
  FPIN=$(X f "node_modules/.bin/tsx -e \"import { ensureDomainKey } from './modules/gateway/server/keys.ts'; console.log(ensureDomainKey('$GW', 'lab-peer').pin)\"")
  FIP=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$P-lan\").IPAddress}}" $P-f)
  X f "cat > $GW/gateway.json <<JSON
{ \"domain\": \"lab-peer\", \"listen\": { \"host\": \"0.0.0.0\" }, \"peers\": [{ \"domain\": \"home\", \"address\": \"$EADDR:28417\", \"pin\": \"$EPIN\",
  \"expose\": [{ \"human\": \"node\", \"role\": \"pm\", \"roles\": [\"lp-dev\"] }] }] }
JSON"
  X g "printf '{\"peers\":[\"http://$FIP:3021\"]}\n' > /tmp/h/mesh/peers.json"
  X b "printf '{\"peers\":[\"http://$EADDR:3021\"]}\n' > /tmp/h/mesh/peers.json"
  # F starts dialling only in `check`, once E holds its pin: before that, E would refuse it as unpinned and,
  # after repeated failures, ban this host's address (21 Oct: that is what happened on the first real run).
  for n in b g; do docker exec -d -u node -w /opt/cortex $P-$n sh -c 'exec node_modules/.bin/tsx bin/cortex-mesh.ts serve >/tmp/h/daemon.log 2>&1'; done
  sleep 3
  cs b "await c.join('pm', { create: true, as: 'pm-1' }); await c.join('dev', { create: true, as: 'dev-1' })" >/dev/null
  cs g "await c.join('lp-dev', { create: true, as: 'lp-1' })" >/dev/null
  echo "E=$EADDR" > $STATE
  cat <<MSG
Containers up (F does not dial E until check). On E, set ~/.config/ckn/data/gateway/gateway.json to (F dials E; nothing of E's is exposed but dev to lab-peer's lp-dev):

{ "domain": "home", "peers": [{ "domain": "lab-peer", "pin": "$FPIN",
  "expose": [{ "human": "node", "role": "lp-dev", "roles": ["dev"] }] }] }

The gateway re-reads it within seconds; no restart. Then: $0 check
MSG
  ;;
check)
  if ! docker exec $P-f pgrep -f 'cortex-mesh.ts serve' >/dev/null; then
    docker exec -d -u node -w /opt/cortex -e CKN_MESH_INTENT=gateway $P-f sh -c 'exec node_modules/.bin/tsx bin/cortex-mesh.ts serve >/tmp/h/daemon.log 2>&1'
  fi
  # Each run's messages carry their own tag, so a run after a restart never passes on an earlier run's messages.
  T=$(date +%H%M%S)
  echo "== link and announcements (run $T)"
  waitcheck "B sees lab-peer through E, linked, announcing lp-dev" 120 ext b lab-peer '["lp-dev"]'
  waitcheck "G sees home through F, linked, announcing dev" 60 ext g home '["dev"]'
  echo "== inbound: lab-peer -> dev at home, as data"
  cs g "console.log('    ' + (await c.send('lp-1', 'home:dev', 'stage1 $T: hello dev')).outcome)"
  waitcheck "dev-1 on B has it, framed as external data" 60 has b dev-1 "stage1 $T: hello dev"
  check "... never claimable" cs b "const i = (await c.inbox('dev-1', { includeSeen: true })).find((x) => x.body.includes('stage1 $T: hello dev')); process.exit(i.foreign && !i.ownership ? 0 : 1)"
  echo "== refused: lab-peer -> pm (not exposed; any return path from an earlier run is closed first)"
  cs b "console.log('    ' + (await c.closeReturn('pm-1', 'lab-peer:lp-dev')).outcome)"
  nopath() { cs b "const e = c.meshView().external.find((x) => x.domain === 'lab-peer'); process.exit(e && !e.paths.some((p) => p.role === 'pm') ? 0 : 1)"; }
  waitcheck "no return path to pm is open" 60 nopath
  cs g "console.log('    ' + (await c.send('lp-1', 'home:pm', 'stage1 $T: not for you')).outcome)"
  # Refused at F ("has not announced pm") on a fresh run; at E ("pm is not exposed") once F has heard from pm.
  waitcheck "lp-1 is told it was not delivered" 60 has g lp-1 "It said: stage1 $T: not for you"
  check "... and pm-1 never got it" bash -c "! (P=$P; $(declare -f cs has); has b pm-1 'stage1 $T: not for you')"
  echo "== outbound and the return path: pm -> lab-peer:lp-dev, reply back"
  cs b "console.log('    ' + (await c.send('pm-1', 'lab-peer:lp-dev', 'stage1 $T: status?')).outcome)"
  waitcheck "lp-1 on G has it" 60 has g lp-1 "stage1 $T: status?"
  cs g "const i = await c.inbox('lp-1', { includeSeen: true }); const m = i.find((x) => x.body.includes('stage1 $T: status?')); console.log('    ' + (await c.reply('lp-1', m.id, 'stage1 $T: green')).outcome)"
  waitcheck "pm-1 on B has the reply, by the return path" 60 has b pm-1 "stage1 $T: green"
  echo "== held: a fake key outbound"
  held() { cs b "const i = await c.inbox('pm-1', { includeSeen: true }); console.log(i.filter((x) => x.body.includes('was held for review (your message id ')).length)"; }
  before=$(held)
  cs b "console.log('    ' + (await c.send('pm-1', 'lab-peer:lp-dev', 'stage1 $T creds AKIAABCDEFGHIJKLMNOP')).outcome)"
  waitcheck "pm-1 is told held for review, by id" 60 bash -c "[ \$(P=$P; $(declare -f cs held); held) -gt $before ]"
  check "... and nothing crossed" bash -c "! (P=$P; $(declare -f cs has); has g lp-1 AKIA)"
  echo "== READ: the sessions read everything; READ reaches the senders, so E's mailbox drains"
  for m in "b dev-1" "b pm-1" "g lp-1"; do set -- $m; cs $1 "const i = await c.inbox('$2'); c.markSeen('$2', i.map((x) => x.id))" >/dev/null; done
  readback() { X g "node_modules/.bin/tsx -e \"import { MeshLog } from './modules/comms/server/mesh/log.ts'; const l = new MeshLog('/tmp/h/mesh','node-g'); process.exit(l.db.prepare(\\\"SELECT read_at FROM outbox WHERE subject = 'stage1 $T: hello dev'\\\").get()?.read_at ? 0 : 1)\""; }
  waitcheck "G's message to dev is READ: B read it, and READ crossed E and F back to G" 60 readback
  echo
  echo "stage 1: $pass passed, $fail failed"
  echo "On E, also run: cortex-gate status (mailbox held should fall to 0 within a minute); cortex-gate paths --all; cortex-gate audit --tail 20; cortex-gate audit --verify"
  [ "$fail" -eq 0 ]
  ;;
clean)
  # B leaves the mesh first, so E and every node behind it forget it rather than list it UNREACHABLE.
  X b 'node_modules/.bin/tsx bin/cortex-mesh.ts leave' 2>&1 || echo "  B could not leave (not running or not linked); forget it on E: cortex-mesh forget node-b"
  clean; rm -f $STATE; echo cleaned up ;;
*) sed -n '2,16p' "$0"; exit 2 ;;
esac
