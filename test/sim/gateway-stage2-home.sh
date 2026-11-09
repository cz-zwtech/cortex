#!/usr/bin/env bash
# Stage 2 of the gateway bring-up, the home half: E in the DMZ, a test peer
# domain on a laptop outside the LAN (gateway-stage2-peer.ts there). E is now
# in the real mesh, so the home side is one throwaway container with test-only
# roles (s2-pm, s2-dev): nothing real is announced, exposed or written to.
#
#   B  a home-domain node (s2-pm-1 in s2-pm, s2-dev-1 in s2-dev), dialling E's mesh port 3021
#
# Usage:
#   gateway-stage2-home.sh setup <E address>   start B
#   gateway-stage2-home.sh check <tag>         the home checks; run with the peer half's check, same tag
#   gateway-stage2-home.sh clean               B leaves the mesh (every node forgets it), then goes
set -u
R=${R:-$(cd "$(dirname "$0")/../.." && pwd)}
[ -L "$R/node_modules" ] && { echo "node_modules in $R is a symlink: the sim mounts the checkout into a container, where the link target does not exist. Run npm ci in the checkout." >&2; exit 2; }
P=gwstage2
pass=0; fail=0
ok() { echo "  PASS  $1"; pass=$((pass+1)); }
no() { echo "  FAIL  $1"; fail=$((fail+1)); }
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else no "$what"; fi; }
waitcheck() { local what=$1 secs=$2; shift 2; for _ in $(seq 1 "$secs"); do "$@" >/dev/null 2>&1 && { ok "$what"; return; }; sleep 1; done; no "$what"; }
X() { docker exec -u node -w /opt/cortex $P-$1 sh -c "$2"; }
cs() {
  docker exec -u node -w /opt/cortex $P-$1 node_modules/.bin/tsx -e "
import { Comms } from './modules/comms/server/comms.ts'; import { LocalIdentity } from './modules/comms/server/identity.ts';
import { MeshTransport } from './modules/comms/server/transport.ts'; import { MeshLog } from './modules/comms/server/mesh/log.ts'; import { meshView } from './modules/comms/server/mesh/view.ts';
const c = new Comms(new MeshTransport(new MeshLog('/tmp/h/mesh','stage2-$1')), new LocalIdentity('/tmp/h/id'), { liveMs: 600000, settleMs: 0, sleep: async () => {}, mesh: () => meshView('/tmp/h/mesh','stage2-$1') });
void (async () => { $2 })().catch((e) => { console.error('ERR', e.message); process.exit(1) })" 2>&1
}
has() { cs $1 "const i = await c.inbox('$2', { includeSeen: true }); process.exit(i.some((x) => x.body.includes('$3')) ? 0 : 1)"; }
ext() { cs $1 "const e = c.meshView().external.find((x) => x.domain === '$2'); process.exit(e && e.linked && JSON.stringify(e.roles) === '$3' ? 0 : 1)"; }
# A worktree's .git names its gitdir by absolute path: mount it where it says.
GITDIR=$(git -C "$R" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
GITMOUNT=(); [ -n "$GITDIR" ] && [ "$GITDIR" != "$R/.git" ] && GITMOUNT=(-v "$GITDIR:$GITDIR:ro")
DEADLINE=300

case "${1:-}" in
setup)
  EADDR=${2:?E address}
  docker rm -fv $P-b >/dev/null 2>&1
  docker run -d --init --name $P-b --tmpfs /tmp/h:uid=1000 -v $R:/opt/cortex:ro "${GITMOUNT[@]}" \
    -e HOME=/tmp/h -e CKN_MESH_DIR=/tmp/h/mesh -e CKN_MACHINE=stage2-b -e CKN_NODE_ALIAS=stage2-b -e CKN_MESH_PORT=3021 \
    -e CKN_MODULES_DIR=/opt/cortex/modules -w /opt/cortex -u node --entrypoint sleep cortex-lab:dev infinity >/dev/null
  X b "mkdir -p /tmp/h/mesh && printf '{\"peers\":[\"http://$EADDR:3021\"]}\n' > /tmp/h/mesh/peers.json"
  cs b "await c.join('s2-pm', { create: true, as: 's2-pm-1' }); await c.join('s2-dev', { create: true, as: 's2-dev-1' })" >/dev/null
  docker exec -d -u node -w /opt/cortex $P-b sh -c 'exec node_modules/.bin/tsx bin/cortex-mesh.ts serve >/tmp/h/daemon.log 2>&1'
  waitcheck "B links to E" 30 X b 'node_modules/.bin/tsx bin/cortex-mesh.ts status | grep -q "live .*gateway"'
  echo "B is up. Run check <tag> here with the peer half's check, same tag."
  ;;
check)
  T=${2:?tag, the same as the peer half}
  echo "== link (run $T); up to $DEADLINE s, while the peer half starts F"
  waitcheck "B sees lab-peer through E, linked, announcing lp-dev" $DEADLINE ext b lab-peer '["lp-dev"]'
  echo "== inbound: lab-peer -> s2-dev, as data"
  waitcheck "s2-dev-1 has it, framed as external data" $DEADLINE has b s2-dev-1 "stage2 $T: hello dev"
  check "... never claimable" cs b "const i = (await c.inbox('s2-dev-1', { includeSeen: true })).find((x) => x.body.includes('stage2 $T: hello dev')); process.exit(i.foreign && !i.ownership ? 0 : 1)"
  echo "== outbound and the return path: s2-pm -> lab-peer:lp-dev, reply back"
  cs b "console.log('    ' + (await c.send('s2-pm-1', 'lab-peer:lp-dev', 'stage2 $T: status?')).outcome)"
  waitcheck "s2-pm-1 has the reply, by the return path" $DEADLINE has b s2-pm-1 "stage2 $T: green"
  echo "== held: a fake key outbound"
  held() { cs b "const i = await c.inbox('s2-pm-1', { includeSeen: true }); console.log(i.filter((x) => x.body.includes('was held for review (your message id ')).length)"; }
  before=$(held)
  cs b "console.log('    ' + (await c.send('s2-pm-1', 'lab-peer:lp-dev', 'stage2 $T creds AKIAABCDEFGHIJKLMNOP')).outcome)"
  waitcheck "s2-pm-1 is told held for review, by id" 60 bash -c "[ \$(P=$P; $(declare -f cs held); held) -gt $before ]"
  cs b "console.log('    ' + (await c.send('s2-pm-1', 'lab-peer:lp-dev', 'stage2 $T: done')).outcome)"
  check "s2-pm-1 never got the refused message" bash -c "! (P=$P; $(declare -f cs has); has b s2-pm-1 'stage2 $T: not for you')"
  echo "== READ: B reads everything, so READ reaches the peer and E's mailbox drains"
  for m in s2-dev-1 s2-pm-1; do cs b "const i = await c.inbox('$m'); c.markSeen('$m', i.map((x) => x.id))" >/dev/null; done
  cs b "console.log('    ' + (await c.closeReturn('s2-pm-1', 'lab-peer:lp-dev')).outcome)"
  echo
  echo "stage 2 home half: $pass passed, $fail failed"
  echo "On E: cortex-gate status (mailbox held falls to 0 within a minute); cortex-gate paths --all; cortex-gate audit --tail 20; cortex-gate audit --verify"
  [ "$fail" -eq 0 ]
  ;;
clean)
  # B leaves first, so E and the real nodes behind it forget it rather than list it UNREACHABLE.
  X b 'node_modules/.bin/tsx bin/cortex-mesh.ts leave' 2>&1 || echo "  B could not leave (not running or not linked); forget it: cortex-mesh forget stage2-b"
  docker rm -fv $P-b >/dev/null 2>&1; echo cleaned up ;;
*) sed -n '2,13p' "$0"; exit 2 ;;
esac
