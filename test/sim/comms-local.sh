#!/usr/bin/env bash
# A local-only node (2 Nov 2026): comms works through the local log with no mesh daemon, no open
# port and no outbound link; connecting is a setting that starts the daemon and undoes cleanly.
# One throwaway container.
#
# Proves: a session start on a fresh node starts no daemon; send, inbox, claim, watch and liveness
# work with none running; `listen on` starts it with a port, `listen off` stops it; a peer added
# starts it without a port (it only dials), and removing the peer stops it.
set -u
R=${R:-$(cd "$(dirname "$0")/../.." && pwd)}
[ -L "$R/node_modules" ] && { echo "node_modules in $R is a symlink: the sim mounts the checkout into a container, where the link target does not exist. Run npm ci in the checkout." >&2; exit 2; }
GITDIR=$(git -C "$R" rev-parse --path-format=absolute --git-common-dir)
P=commslocal-${RUN_ID:-$$}
pass=0; fail=0
ok() { echo "  PASS  $1"; pass=$((pass+1)); }
no() { echo "  FAIL  $1"; fail=$((fail+1)); }
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else no "$what"; fi; }
waitcheck() { local what=$1 secs=$2; shift 2; for _ in $(seq 1 "$secs"); do "$@" >/dev/null 2>&1 && { ok "$what"; return; }; sleep 1; done; no "$what"; }
cleanup() { docker rm -fv $P >/dev/null 2>&1; }
cleanup; trap cleanup EXIT

T='node_modules/.bin/tsx'
E="-e HOME=/tmp/h -e CKN_STATE_DIR=/tmp/h/ckn -e CKN_MODULES_DIR=/opt/cortex/modules -e CKN_MACHINE=node-l -e CKN_MESH_PORT=3021 -e CLAUDE_CONFIG_DIR=/tmp/h/.claude"
docker run -d --init --name $P --tmpfs /tmp/h:uid=1000 -v $R:/opt/cortex:ro -v $GITDIR:$GITDIR:ro --entrypoint sleep cortex-lab:dev infinity >/dev/null
X() { docker exec -u node -w /opt/cortex $E $P sh -c "$1"; }
nodaemon() { X "! pgrep -f '[c]ortex-mesh.ts serve'"; }
noport() { X "! grep -q ':0BCD 00000000:0000 0A' /proc/net/tcp && ! grep -q ':0BCD 00000000000000000000000000000000:0000 0A' /proc/net/tcp6"; }
port() { X "grep -q ':0BCD 00000000:0000 0A' /proc/net/tcp || grep -q ':0BCD 00000000000000000000000000000000:0000 0A' /proc/net/tcp6"; }

echo "== a fresh node: a session starts"
X "echo '{\"session_id\":\"s1\"}' | CLAUDE_CODE_ENTRYPOINT=cli $T bin/cortex-hook.ts SessionStart >/dev/null 2>&1"
sleep 2
check "no mesh daemon started" nodaemon
check "no port open" noport
check "the node is set not to listen" X "grep -q '\"listen\": false' /tmp/h/ckn/data/mesh/node.json"

echo "== messages with no daemon"
X "$T bin/cortex-role.ts join ops --create --as ops-1 >/dev/null && $T bin/cortex-role.ts join dev --create --as dev-1 >/dev/null"
docker exec -d -u node -w /opt/cortex $E $P sh -c "timeout 60 $T bin/cortex-role.ts watch --as dev-1 > /tmp/h/watch.out 2>&1"
# A member is live for a while after joining anyway: wait for the watcher's process, then for it to start reading.
waitcheck "a watcher runs" 30 X "pgrep -f '[c]ortex-role.ts watch'"
sleep 6
X "$T bin/cortex-role.ts send dev 'local hello' --as ops-1 >/tmp/h/sent.out"
check "a message goes" X "grep -q '^sent' /tmp/h/sent.out"
# Before reading the inbox: a message read there is seen, and a watcher reports only unseen ones.
waitcheck "the watcher saw it as it arrived" 20 X "grep -q 'local hello' /tmp/h/watch.out"
check "and arrives in the inbox" X "$T bin/cortex-role.ts inbox --as dev-1 --all | grep -q 'local hello'"
id=$(X "grep -o 'node-l\.[0-9]*' /tmp/h/sent.out | head -1")
check "it can be claimed" X "$T bin/cortex-role.ts claim $id --as dev-1 | grep -q WON"
check "the watching member is live" X "$T bin/cortex-role.ts who | grep dev-1 | grep -q live"
check "still no daemon and no port" sh -c "$(declare -f X nodaemon noport); E='$E' P=$P T='$T'; nodaemon && noport"

echo "== connecting is a setting"
X "$T bin/cortex-mesh.ts listen on >/dev/null"
waitcheck "listen on: the daemon runs, with its port" 20 port
X "$T bin/cortex-mesh.ts listen off >/dev/null"
waitcheck "listen off: stopped, port closed" 20 sh -c "$(declare -f X nodaemon noport); E='$E' P=$P T='$T'; nodaemon && noport"
X "$T bin/cortex-mesh.ts peers add 192.0.2.10:3021 >/dev/null"
waitcheck "a peer added: the daemon runs" 20 X "pgrep -f '[c]ortex-mesh.ts serve'"
check "... and opens no port (it only dials)" noport
X "$T bin/cortex-mesh.ts peers remove 192.0.2.10:3021 >/dev/null"
waitcheck "the peer removed: stopped" 20 nodaemon
check "messages still work after all that" X "$T bin/cortex-role.ts send dev 'after' --as ops-1 >/dev/null && $T bin/cortex-role.ts inbox --as dev-1 --all | grep -q after"

echo; echo "comms local-only sim: $pass passed, $fail failed"
[ $fail -eq 0 ]
