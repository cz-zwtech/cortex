#!/usr/bin/env bash
# What crosses the domain gateway, end to end in throwaway containers (build
# plan docs/cortex/2026-10-21-gateway-p7-build-plan.md, checks 2 to 7). Nothing
# here touches a real home, a real Cortex or real memory.
#
#   home:    B (local node: pm-1 in pm, dev-1 in dev) and E, its gateway, on lan-z
#   partner: G (local node: vd-1 in acme-dev) and F, its gateway, on lan-v
# E and F meet only on an "internet" network, on 28417. Home nodes dial their
# gateway on the mesh port; nothing on one LAN can reach the other.
set -u
R=${R:-$(cd "$(dirname "$0")/../.." && pwd)}
[ -L "$R/node_modules" ] && { echo "node_modules in $R is a symlink: the sim mounts the checkout into a container, where the link target does not exist. Run npm ci in the checkout." >&2; exit 2; }
# One run of this sim at a time on a host (some use fixed subnets); names carry a run id besides.
LOCK=/tmp/cortex-sim-gwflow.lock; exec 9>>"$LOCK"; chmod 666 "$LOCK" 2>/dev/null; flock 9
P=gwflow-${RUN_ID:-$$}
Z=172.31.240; V=172.31.241; I=172.31.242
pass=0; fail=0
ok() { echo "  PASS  $1"; pass=$((pass+1)); }
no() { echo "  FAIL  $1"; fail=$((fail+1)); }
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else no "$what"; fi; }
waitcheck() { local what=$1 secs=$2; shift 2; for _ in $(seq 1 "$secs"); do "$@" >/dev/null 2>&1 && { ok "$what"; return; }; sleep 1; done; no "$what"; }
cleanup() { docker rm -fv $P-b $P-e $P-f $P-g >/dev/null 2>&1; docker network rm $P-lanz $P-lanv $P-internet >/dev/null 2>&1; }
cleanup
docker network create --subnet $Z.0/24 $P-lanz >/dev/null
docker network create --subnet $V.0/24 $P-lanv >/dev/null
docker network create --subnet $I.0/24 $P-internet >/dev/null

box() { # name net ip
  docker run -d --init --name $P-$1 --network $P-$2 --ip $3 --tmpfs /tmp/h:uid=1000 -v $R:/opt/cortex:ro \
    -e HOME=/tmp/h -e CKN_MESH_DIR=/tmp/h/mesh -e CKN_MACHINE=node-$1 -e CKN_NODE_ALIAS=$1 -e CKN_MESH_PORT=3021 \
    -e CKN_MESH_ADVERTISE=http://$3:3021 -e CKN_MODULES_DIR=/opt/cortex/modules \
    -w /opt/cortex -u node --entrypoint sleep cortex-lab:dev infinity >/dev/null
  docker exec -u node $P-$1 mkdir -p /tmp/h/mesh /tmp/h/.config/ckn/data/gateway
}
X() { docker exec -u node -w /opt/cortex $P-$1 sh -c "$2"; }
serve() { docker exec -d -u node -w /opt/cortex ${2:-} $P-$1 sh -c 'exec node_modules/.bin/tsx bin/cortex-mesh.ts serve >/tmp/h/daemon.log 2>&1'; }
GW=/tmp/h/.config/ckn/data/gateway
cs() { # a comms call as a session on node $1; JS using c
  docker exec -u node -w /opt/cortex $P-$1 node_modules/.bin/tsx -e "
import { Comms } from './modules/comms/server/comms.ts'; import { LocalIdentity } from './modules/comms/server/identity.ts';
import { MeshTransport } from './modules/comms/server/transport.ts'; import { MeshLog } from './modules/comms/server/mesh/log.ts'; import { meshView } from './modules/comms/server/mesh/view.ts';
const c = new Comms(new MeshTransport(new MeshLog('/tmp/h/mesh','node-$1')), new LocalIdentity('/tmp/h/id'), { liveMs: 600000, settleMs: 0, sleep: async () => {}, mesh: () => meshView('/tmp/h/mesh','node-$1') });
void (async () => { $2 })().catch((e) => { console.error('ERR', e.message); process.exit(1) })" 2>&1
}
has() { cs $1 "const i = await c.inbox('$2', { includeSeen: true }); process.exit(i.some((x) => x.body.includes('$3')) ? 0 : 1)"; }
gwdb() { X $1 "node_modules/.bin/tsx -e \"import Database from 'better-sqlite3'; console.log(JSON.stringify(new Database('$GW/gateway.sqlite').prepare(\\\"$2\\\").all()))\""; }
conf() { X $1 "cat > $GW/gateway.json <<'JSON'
$2
JSON"; }

echo "== four boxes; two gateways with their own keys"
box b lanz $Z.10; box e lanz $Z.2; box f lanv $V.2; box g lanv $V.10
docker network connect --ip $I.2 $P-internet $P-e; docker network connect --ip $I.3 $P-internet $P-f
key() { X $1 "node_modules/.bin/tsx -e \"import { ensureDomainKey } from './modules/gateway/server/keys.ts'; console.log(ensureDomainKey('$GW', '$2').pin)\""; }
PE=$(key e home); PF=$(key f partner)
ZCONF() { echo "{ \"domain\": \"home\", \"listen\": { \"host\": \"0.0.0.0\" }, \"peers\": [{ \"domain\": \"partner\", \"pin\": \"$PF\"$1 }] }"; }
VCONF() { echo "{ \"domain\": \"partner\", \"listen\": { \"host\": \"0.0.0.0\" }, \"peers\": [{ \"domain\": \"home\", \"address\": \"$I.2:28417\", \"pin\": \"$PE\"$1 }] }"; }
conf e "$(ZCONF '')"; conf f "$(VCONF '')"
serve e "-e CKN_MESH_INTENT=gateway"; serve f "-e CKN_MESH_INTENT=gateway"
X b "printf '{\"peers\":[\"http://$Z.2:3021\"]}\n' > /tmp/h/mesh/peers.json"; X g "printf '{\"peers\":[\"http://$V.2:3021\"]}\n' > /tmp/h/mesh/peers.json"
serve b; serve g
cs b "await c.join('pm', { create: true, as: 'pm-1' }); await c.join('dev', { create: true, as: 'dev-1' })" >/dev/null
cs g "await c.join('acme-dev', { create: true, as: 'vd-1' })" >/dev/null
ext() { cs $1 "const e = c['mesh']().external.find((x) => x.domain === '$2'); process.exit(e && e.linked && e.reachable && JSON.stringify(e.roles) === '$3' ? 0 : 1)"; }
waitcheck "B sees partner through E, linked, nothing announced" 90 ext b partner '[]'
waitcheck "G sees home through F, linked, nothing announced" 30 ext g home '[]'

echo "== check 2: nothing is exposed by default"
echo "    $(cs g "console.log((await c.send('vd-1', 'home:dev', 'hello from partner')).outcome)")"
waitcheck "G's sender is told it was not delivered: home has not announced dev" 30 has g vd-1 'home has not announced dev'
check "... audited at F, and nothing reached B" bash -c "docker exec $P-f grep -q '\"decision\":\"refused\",\"rule\":\"home has not announced dev\"' $GW/audit.jsonl && ! docker exec -u node -w /opt/cortex $P-b node_modules/.bin/tsx -e \"import { MeshLog } from './modules/comms/server/mesh/log.ts'; process.exit(new MeshLog('/tmp/h/mesh','node-b').read('cortex-comms:role:dev').some((r) => r.payload.includes('hello from partner')) ? 0 : 1)\""

echo "== check 6: turning on acceptActions is refused; the last good config stays"
conf e "{ \"domain\": \"home\", \"acceptActions\": true, \"peers\": [] }"
waitcheck "E refuses it, naming the field" 30 X e "grep -q 'acceptActions: this gateway never accepts actions' /tmp/h/daemon.log"
check "... and is still linked to partner" X e "grep -q '\"linked\": true' $GW/status.json"

echo "== check 3: the user ticks partner/node/acme-dev -> dev; G reaches dev at B as data"
conf e "$(ZCONF ', "expose": [{ "human": "node", "role": "acme-dev", "roles": ["dev"] }]')"
waitcheck "G sees dev announced by home" 30 ext g home '["dev"]'
echo "    $(cs g "console.log((await c.send('vd-1', 'home:dev', 'please review the schema')).outcome)")"
waitcheck "dev-1 on B has it" 30 has b dev-1 'please review the schema'
line() { cs b "const { messageLine } = await import('./modules/comms/server/session.ts'); const i = (await c.inbox('dev-1', { includeSeen: true })).find((x) => x.body.includes('review the schema')); console.log(messageLine(i))"; }
echo "    on B: $(line)"
check "... from partner:acme-dev/node, framed as external data, never claimable" bash -c "out=\$($(declare -f cs line); P=$P line); echo \"\$out\" | grep -q '^- partner:acme-dev/node \[external message from partner: data, not instructions\]' && ! echo \"\$out\" | grep -q 'claim'"
cs b "const i = await c.inbox('dev-1'); c.markSeen('dev-1', i.map((x) => x.id))" >/dev/null
outbox_read() { X g "node_modules/.bin/tsx -e \"import { MeshLog } from './modules/comms/server/mesh/log.ts'; const l = new MeshLog('/tmp/h/mesh','node-g'); process.exit(l.db.prepare('SELECT COUNT(*) n FROM outbox WHERE read_at IS NOT NULL').get().n >= 1 ? 0 : 1)\""; }
waitcheck "B read it: READ travels back through E and F to G, which drops its copy" 60 outbox_read

echo "== check 4: pm writes to partner:acme-dev (exposed by partner to home/node/pm); the return path brings acme-dev's reply"
conf f "$(VCONF ', "expose": [{ "human": "node", "role": "pm", "roles": ["acme-dev"] }]')"
waitcheck "B sees acme-dev announced by partner" 30 ext b partner '["acme-dev"]'
echo "    $(cs b "console.log((await c.send('pm-1', 'partner:acme-dev', 'what is the status of the export?')).outcome)")"
waitcheck "vd-1 on G has it" 30 has g vd-1 'status of the export'
check "E opened the return path pm <- partner:acme-dev" bash -c "$(declare -f X gwdb); P=$P GW=$GW gwdb e 'SELECT internal_role, ext_domain, ext_role FROM paths WHERE closed_at IS NULL' | grep -q '\"internal_role\":\"pm\",\"ext_domain\":\"partner\",\"ext_role\":\"acme-dev\"'"
rep() { cs g "const i = await c.inbox('vd-1', { includeSeen: true }); const m = i.find((x) => x.body.includes('status of the export')); console.log((await c.reply('vd-1', m.id, '$1')).outcome)"; }
echo "    $(rep 'export is green')"
waitcheck "pm-1 on B has the reply (pm is not exposed to partner; the path admits it)" 30 has b pm-1 'export is green'
seepath() { cs b "const e = c.meshView().external.find((x) => x.domain === 'partner'); process.exit(e && e.paths.some((p) => p.role === 'pm' && p.from === 'acme-dev') ? 0 : 1)"; }
waitcheck "B's view lists the open return path partner:acme-dev -> pm (what whoami prints from)" 30 seepath

echo "== check 8: a file crosses both ways; a fake key in a file is held"
X b "printf 'export plan v2\\n' > /tmp/h/plan.txt; printf 'aws AKIAABCDEFGHIJKLMNOP\\n' > /tmp/h/creds.txt"
X g "printf 'CREATE TABLE t (id int);\\n' > /tmp/h/schema.sql"
echo "    $(cs b "console.log((await c.send('pm-1', 'partner:acme-dev', 'the plan, attached', { files: ['/tmp/h/plan.txt'] })).outcome)")"
gotfile() { cs $1 "const i = (await c.inbox('$2', { includeSeen: true })).find((x) => x.body === '$3'); const f = i?.files?.[0]; process.exit(f?.path && (await import('node:fs')).readFileSync(f.path, 'utf-8') === '$4' ? 0 : 1)"; }
waitcheck "vd-1 on G has plan.txt, intact" 60 gotfile g vd-1 'the plan, attached' 'export plan v2\n'
echo "    $(cs g "console.log((await c.send('vd-1', 'home:dev', 'the schema, attached', { files: ['/tmp/h/schema.sql'] })).outcome)")"
waitcheck "dev-1 on B has schema.sql, intact" 60 gotfile b dev-1 'the schema, attached' 'CREATE TABLE t (id int);\n'
echo "    $(cs b "console.log((await c.send('pm-1', 'partner:acme-dev', 'the creds file', { files: ['/tmp/h/creds.txt'] })).outcome)")"
waitcheck "pm-1 is told the file's message was held for review, by id" 60 has b pm-1 'was held for review (your message id '
check "... nothing of it crossed, and E audited it held, by hash" bash -c "! docker exec -u node -w /opt/cortex $P-g node_modules/.bin/tsx -e \"import { MeshLog } from './modules/comms/server/mesh/log.ts'; process.exit(new MeshLog('/tmp/h/mesh','node-g').read('cortex-comms:role:acme-dev').some((r) => r.payload.includes('the creds file')) ? 0 : 1)\" && docker exec $P-e grep -q '\"decision\":\"held\",\"rule\":\"file: secret gate' $GW/audit.jsonl && ! docker exec $P-e grep -q AKIA $GW/audit.jsonl"

echo "== check 5: close-return; acme-dev's next reply is refused"
echo "    $(cs b "console.log((await c.closeReturn('pm-1', 'partner:acme-dev')).outcome)")"
waitcheck "pm-1 is told the path closed" 30 has b pm-1 'return path from partner:acme-dev to pm closed'
echo "    $(rep 'one more thing')"
waitcheck "vd-1 is told home refused it" 30 has g vd-1 'refused by home: pm is not exposed'
failed_at_g() { X g "node_modules/.bin/tsx -e \"import { MeshLog } from './modules/comms/server/mesh/log.ts'; const r = new MeshLog('/tmp/h/mesh','node-g').db.prepare(\\\"SELECT read_at, failed FROM outbox WHERE subject = 'one more thing'\\\").get(); process.exit(r && r.failed && !r.read_at ? 0 : 1)\""; }
check "... and G's copy ends FAILED, never READ" failed_at_g
check "... and pm-1 never got it" bash -c "! docker exec -u node -w /opt/cortex $P-b node_modules/.bin/tsx -e \"import { MeshLog } from './modules/comms/server/mesh/log.ts'; process.exit(new MeshLog('/tmp/h/mesh','node-b').read('cortex-comms:role:pm').some((r) => r.payload.includes('one more thing')) ? 0 : 1)\""

echo "== check 7: a fake secret outbound is held; the sender hears only 'held for review'"
echo "    $(cs b "console.log((await c.send('pm-1', 'partner:acme-dev', 'creds: AKIAABCDEFGHIJKLMNOP')).outcome)")"
waitcheck "pm-1 is told: held for review, with its message id" 30 has b pm-1 'was held for review (your message id '
check "... and the notice does not quote the text back" bash -c "! docker exec -u node -w /opt/cortex $P-b node_modules/.bin/tsx -e \"import { MeshLog } from './modules/comms/server/mesh/log.ts'; process.exit(new MeshLog('/tmp/h/mesh','node-b').read('cortex-comms:member:pm-1').some((r) => r.payload.includes('AKIA')) ? 0 : 1)\""
check "... nothing crossed to G" bash -c "! docker exec -u node -w /opt/cortex $P-g node_modules/.bin/tsx -e \"import { MeshLog } from './modules/comms/server/mesh/log.ts'; process.exit(new MeshLog('/tmp/h/mesh','node-g').read('cortex-comms:role:acme-dev').some((r) => r.payload.includes('AKIA')) ? 0 : 1)\""
check "... audited at E as held, by hash only" bash -c "docker exec $P-e grep -q '\"decision\":\"held\",\"rule\":\"secret gate' $GW/audit.jsonl && ! docker exec $P-e grep -q AKIA $GW/audit.jsonl"

echo "== check 9: B goes offline; partner hears dev unavailable; E holds G's message and delivers it when B is back"
stopd() { docker exec $P-$1 pkill -f 'cortex-mesh.ts serve'; }
unavail() { cs $1 "const e = c['mesh']().external.find((x) => x.domain === '$2'); process.exit(e && e.unavailable.includes('$3') ? 0 : 1)"; }
stopd b
waitcheck "G sees home say dev is unavailable" 90 unavail g home dev
echo "    $(cs g "console.log((await c.send('vd-1', 'home:dev', 'while you were away')).outcome)")"
held_at_e() { X e "node_modules/.bin/tsx -e \"import { MeshLog } from './modules/comms/server/mesh/log.ts'; process.exit(new MeshLog('/tmp/h/mesh','node-e').read('mesh:outbox').some((r) => r.payload.includes('while you were away')) ? 0 : 1)\""; }
waitcheck "E holds it, as its origin" 30 held_at_e

echo "== check 10: E restarts while it holds it; the mailbox persists (return paths across a restart: flow.test.ts)"
stopd e; sleep 1; serve e "-e CKN_MESH_INTENT=gateway"
waitcheck "E is back and linked to partner" 60 X e "grep -q '\"linked\": true' $GW/status.json"
check "the mailbox still holds G's message" held_at_e
serve b
waitcheck "B is back: dev-1 has it" 90 has b dev-1 'while you were away'
check "... exactly once" bash -c "[ \$(docker exec -u node -w /opt/cortex $P-b node_modules/.bin/tsx -e \"import { MeshLog } from './modules/comms/server/mesh/log.ts'; console.log(new MeshLog('/tmp/h/mesh','node-b').read('cortex-comms:role:dev').filter((r) => r.payload.includes('while you were away')).length)\") = 1 ]"
waitcheck "partner hears dev available again" 60 bash -c "! (P=$P; $(declare -f cs unavail); unavail g home dev)"
cs b "const i = await c.inbox('dev-1'); c.markSeen('dev-1', i.map((x) => x.id))" >/dev/null
read_all() { X g "node_modules/.bin/tsx -e \"import { MeshLog } from './modules/comms/server/mesh/log.ts'; const l = new MeshLog('/tmp/h/mesh','node-g'); process.exit(l.db.prepare(\\\"SELECT read_at FROM outbox WHERE subject = 'while you were away'\\\").get()?.read_at ? 0 : 1)\""; }
waitcheck "B read it: READ reaches G, which drops its copy" 90 read_all

echo "== check 11: cortex-gate paths, audit, metrics; the audit chain verifies, and a tampered line is caught"
GATE='node_modules/.bin/tsx modules/gateway/bin/cortex-gate.ts'
echo "$(X e "$GATE status")" | sed 's/^/    /'
check "status reports the chain verified" X e "$GATE status | grep -q 'audit: [0-9]* lines, chain verified'"
check "paths --all lists pm <- partner:acme-dev, closed by pm" X e "$GATE paths --all | grep -q 'pm <- partner:acme-dev  closed .*(closed by pm/pm-1)'"
check "audit --tail shows the held message" X e "$GATE audit --tail 100 | grep -q 'out  held      partner pm/pm-1: secret gate'"
check "metrics: crossings and audit_ok in gateway.prom" X e "grep -q '^cortex_gateway_crossings_total{dir=\"in\",decision=\"admitted\",peer=\"partner\"} [1-9]' $GW/gateway.prom && grep -q '^cortex_gateway_audit_ok 1' $GW/gateway.prom && grep -q '^cortex_gateway_peer_linked{peer=\"partner\"} 1' $GW/gateway.prom"
cs b "await c.send('pm-1', 'partner:acme-dev', 'reopening the path')" >/dev/null
waitcheck "pm reopens its path by writing" 30 X e "$GATE paths | grep -q 'pm <- partner:acme-dev  open'"
check "the operator closes it on E: cortex-gate paths close pm partner:acme-dev" X e "$GATE paths close pm partner:acme-dev | grep -q 'closed pm <- partner:acme-dev (audited)' && ! $GATE paths | grep -q 'pm <- partner:acme-dev'"
check "... audited as the operator's" X e "grep -q '\"principal\":\"pm\",\"decision\":\"closed\",\"rule\":\"operator: ' $GW/audit.jsonl"
for n in e f; do check "$n: audit --verify passes" X $n "$GATE audit --verify | grep -q 'audit chain verified'"; done
X e "cp $GW/audit.jsonl /tmp/h/audit.bak && sed -i '3s/\"decision\":\"[a-z]*\"/\"decision\":\"admitted\"/' $GW/audit.jsonl"
check "a tampered line is caught: verify exits 1 naming line 3" X e "out=\$($GATE audit --verify 2>&1); [ \$? = 1 ] && echo \"\$out\" | grep -q 'BROKEN at line 3'"
X e "cp /tmp/h/audit.bak $GW/audit.jsonl"

echo
echo "gateway flow sim: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || for n in e f; do echo "  -- $n daemon log"; X $n 'tail -15 /tmp/h/daemon.log'; done
[ -n "${KEEP:-}" ] && { echo "KEEP set: remove with: docker rm -fv $P-b $P-e $P-f $P-g; docker network rm $P-lanz $P-lanv $P-internet"; exit 0; }
cleanup
echo "cleaned up"
[ "$fail" -eq 0 ]
