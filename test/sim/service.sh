#!/usr/bin/env bash
# A service account's send-only node beside a human's node on one host
# (retire plan step 1: `svc` on node-a). Throwaway container; nothing here
# touches a real home, a real Cortex or real memory.
#
#   one host, users alex (a full install, alias node-a, port 3021, role ops) and
#   svc (cortex-install --service: comms and mesh only, no hooks, loopback
#   3022, alias node-a-svc). Both inherit the SAME V1 machine-id, as on node-a.
#
# Proves: the service node gets its own id; svc's Claude config is not
# touched and has no Cortex hooks (so a headless `claude -p` as svc runs
# none); a service send reaches an alex session, DELIVERED then READ; a reply
# routes back; the service node advertises no address; a rerun changes nothing.
set -u
SRC=${R:-$(cd "$(dirname "$0")/../.." && pwd)}
[ -L "$SRC/node_modules" ] && { echo "node_modules in $SRC is a symlink: the sim mounts the checkout into a container, where the link target does not exist. Run npm ci in the checkout." >&2; exit 2; }
# A worktree\'s .git points at the main repo by absolute path: mount it there, so git works inside.
GITDIR=$(git -C "$SRC" rev-parse --path-format=absolute --git-common-dir)
# One run of this sim at a time on a host (some use fixed subnets); names carry a run id besides.
LOCK=/tmp/cortex-sim-svcsim.lock; exec 9>>"$LOCK"; chmod 666 "$LOCK" 2>/dev/null; flock 9
P=svcsim-${RUN_ID:-$$}
pass=0; fail=0
ok() { echo "  PASS  $1"; pass=$((pass+1)); }
no() { echo "  FAIL  $1"; fail=$((fail+1)); }
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else no "$what"; fi; }
waitcheck() { local what=$1 secs=$2; shift 2; for _ in $(seq 1 "$secs"); do "$@" >/dev/null 2>&1 && { ok "$what"; return; }; sleep 1; done; no "$what"; }
cleanup() { docker rm -fv $P-node-a >/dev/null 2>&1; }
cleanup

docker run -d --init --name $P-node-a -v $SRC:/src:ro -v $GITDIR:$GITDIR:ro --entrypoint sleep cortex-lab:dev infinity >/dev/null
Z() { docker exec $P-node-a bash -c "$1"; }
U() { docker exec $P-node-a runuser -l "$1" -c "cd /srv/cortex/cortex-v2-deploy; $2"; }
T='node_modules/.bin/tsx'

echo "== setup: two users, one shared checkout (this working tree), one inherited V1 machine-id"
Z 'groupadd developers && useradd -m -s /bin/bash -G developers alex && useradd -m -s /bin/bash -G developers svc
   mkdir -p /srv/cortex/cortex-v2-deploy && cd /src && git -c safe.directory=* ls-files -co --exclude-standard | tar -cf - -T - | tar -xf - -C /srv/cortex/cortex-v2-deploy
   cp -a /src/node_modules /srv/cortex/cortex-v2-deploy/ && chgrp -R developers /srv/cortex && chmod -R g+rwX /srv/cortex
   for u in alex svc; do runuser -l $u -c "mkdir -p ~/.config/ckn ~/.claude && echo node-a-sim-901329ee > ~/.config/ckn/machine-id"; done'
# svc still has V1 hooks at this point on node-a; the service install must leave them for the V1 purge.
U svc 'printf "%s" "{\"hooks\":{\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"ckn-stop\"}]}]}}" > ~/.claude/settings.json'
before=$(U svc 'sha256sum ~/.claude/settings.json')

echo "== alex: the full install, alias and port from node config (not shell env)"
U alex "$T bin/cortex-mesh.ts config alias node-a >/dev/null && $T bin/cortex-mesh.ts config port 3021 >/dev/null && $T bin/cortex-mesh.ts listen on >/dev/null && $T bin/cortex-install.ts >/tmp/alex-install.out 2>&1; $T bin/cortex-role.ts join ops --create --as ops-1 >/dev/null"
check "alex's node runs as alias node-a on 3021, started from node.json" U alex "$T bin/cortex-mesh.ts status | grep -q 'alias node-a' && $T bin/cortex-mesh.ts status | grep -q 'port 3021'"

echo "== svc: cortex-install --service"
U svc "$T bin/cortex-install.ts --service --alias node-a-svc" | sed 's/^/    /'
check "the service node has its own id, not the inherited machine-id" U svc "[ \"\$($T bin/cortex-mesh.ts id)\" != node-a-sim-901329ee ] && $T bin/cortex-mesh.ts id | grep -q '^node-a-svc-'"
check "alex's node keeps the machine-id" U alex "[ \"\$($T bin/cortex-mesh.ts id)\" = node-a-sim-901329ee ]"
check "only comms (with the mesh) is installed for svc" U svc '[ "$(ls ~/.config/ckn/modules | tr "\n" " ")" = "comms " ]'
check "--with private-mind on a node without memory is refused, naming what it requires" U svc "$T bin/cortex-install.ts --service --alias node-a-svc --with private-mind --no-mesh-start 2>&1 | grep -q 'refused, private-mind requires memory'"
check "... and links nothing" U svc '[ "$(ls ~/.config/ckn/modules | tr "\n" " ")" = "comms " ]'
check "svc's Claude config is byte-for-byte unchanged" bash -c "[ \"\$(docker exec $P-node-a runuser -l svc -c 'sha256sum ~/.claude/settings.json')\" = \"$before\" ]"
check "... and has no Cortex hooks, so a headless claude -p as svc runs none" U svc '! grep -q cortex-hook ~/.claude/settings.json && ! ls ~/.claude/commands 2>/dev/null | grep -q cortex'
# /proc/net/tcp: 0100007F:0BCE is 127.0.0.1:3022, 00000000:0BCE would be every address; 0A is LISTEN.
check "its daemon opens no port: it only dials the human node (listen off)" Z "! grep -q ':0BCE 00000000:0000 0A' /proc/net/tcp"
linked() { U alex "$T bin/cortex-mesh.ts status" | grep -q "node-a-svc"; }
waitcheck "alex's node links the service node (it dialed in)" 30 linked
svc_known() { U alex "$T -e \"import { meshView } from './modules/comms/server/mesh/view.ts'; const n = meshView(process.env.HOME + '/.config/ckn/data/mesh', 'node-a-sim-901329ee').nodes.find((x) => x.alias === 'node-a-svc'); process.exit(n && n.reachable && n.roles.some((r) => r.role === 'service') ? 0 : 1)\""; }
waitcheck "alex's node sees node-a-svc:service reachable" 30 svc_known
check "the service node advertises no address to dial" U alex "$T -e \"import Database from 'better-sqlite3'; const db = new Database(process.env.HOME + '/.config/ckn/data/mesh/mesh.sqlite', { readonly: true }); const r = db.prepare(\\\"SELECT addresses FROM nodes WHERE alias = 'node-a-svc'\\\").get(); process.exit(r && r.addresses === '[]' ? 0 : 1)\""

echo "== a service send, delivered then READ, and a reply"
U svc "echo 'triage escalation: made-up ticket 42' > /tmp/body.txt && $T bin/cortex-role.ts send node-a:ops --as service-1 --body-file /tmp/body.txt" | sed 's/^/    svc: /'
arrived() { U alex "$T bin/cortex-role.ts inbox --as ops-1 --all" | grep -q 'made-up ticket 42'; }
waitcheck "it arrives in alex's ops mailbox" 30 arrived
check "... labelled from node-a-svc:service/service-1" bash -c "docker exec $P-node-a runuser -l alex -c 'cd /srv/cortex/cortex-v2-deploy; $T bin/cortex-role.ts inbox --as ops-1 --all' | grep -q 'node-a-svc:service/service-1'"
outbox() { U svc "$T -e \"import Database from 'better-sqlite3'; const db = new Database(process.env.HOME + '/.config/ckn/data/mesh/mesh.sqlite', { readonly: true }); console.log(JSON.stringify(db.prepare('SELECT delivered_at d, read_at r FROM outbox').all()))\""; }
read_back() { outbox | grep -q '"r":[0-9]'; }
waitcheck "svc's outbox: DELIVERED, then READ once alex's session was shown it" 30 read_back
msgid=$(U alex "$T bin/cortex-role.ts inbox --as ops-1 --all" | grep -o '(id [^)]*)' | head -1 | sed 's/(id //; s/)//')
U alex "$T bin/cortex-role.ts reply $msgid 'seen, on it' --as ops-1" | sed 's/^/    alex: /'
reply_back() { U svc "$T bin/cortex-role.ts inbox --as service-1 --all" | grep -q 'seen, on it'; }
waitcheck "the reply routes back to the service member" 30 reply_back

echo "== rerun"
id1=$(U svc "$T bin/cortex-mesh.ts id")
U svc "$T bin/cortex-install.ts --service --alias node-a-svc" >/dev/null 2>&1
check "a second --service run keeps the node id" bash -c "[ -n '$id1' ] && [ \"\$(docker exec $P-node-a runuser -l svc -c 'cd /srv/cortex/cortex-v2-deploy; $T bin/cortex-mesh.ts id')\" = '$id1' ]"
U svc 'printf "%s" "{\"hooks\":{\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"tsx /x/bin/cortex-hook.ts Stop\"}]}]}}" > /tmp/hooked.json && cp ~/.claude/settings.json /tmp/keep.json && cp /tmp/hooked.json ~/.claude/settings.json'
check "--service refuses a Claude config that has Cortex hooks" U svc "$T bin/cortex-install.ts --service --no-mesh-start 2>&1 | grep -q 'a service account must have none'"
U svc 'cp /tmp/keep.json ~/.claude/settings.json'

echo
echo "service sim: $pass passed, $fail failed"
[ -n "${KEEP:-}" ] && { echo "KEEP set: remove with: docker rm -fv $P-node-a"; exit 0; }
cleanup
echo "cleaned up"
[ "$fail" -eq 0 ]
