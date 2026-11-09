#!/usr/bin/env bash
# The telegram module end to end, in one throwaway container (retire plan,
# telegram build): alex's node (node-a) with session roles, svc's service node (node-a-svc)
# running the Cortex host with telegram, and a stand-in Telegram. No real home,
# Cortex, memory, bot or token is touched; every token below is made up.
#
# Proves: a producer's item is routed to its owner role by reference; it falls
# back to the operator on Telegram; the operator's reply to it is routed back to
# the owner, who reads the text from a file with cortex-telegram; an unowned
# message is offered to live roles; an ack over comms is recorded as the
# sender's role; the LAN health holds counts only.
set -u
SRC=${R:-$(cd "$(dirname "$0")/../.." && pwd)}
[ -L "$SRC/node_modules" ] && { echo "node_modules in $SRC is a symlink: the sim mounts the checkout into a container, where the link target does not exist. Run npm ci in the checkout." >&2; exit 2; }
# A worktree\'s .git points at the main repo by absolute path: mount it there, so git works inside.
GITDIR=$(git -C "$SRC" rev-parse --path-format=absolute --git-common-dir)
# One run of this sim at a time on a host (some use fixed subnets); names carry a run id besides.
LOCK=/tmp/cortex-sim-telegramsim.lock; exec 9>>"$LOCK"; chmod 666 "$LOCK" 2>/dev/null; flock 9
P=telegramsim-${RUN_ID:-$$}
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
ROLE="$T bin/cortex-role.ts"
TG="$T modules/telegram/bin/cortex-telegram.ts"
SOCK=/home/svc/.config/ckn/data/telegram/telegram.sock

echo "== setup: users, the shared checkout (this working tree), a stand-in Telegram"
Z 'groupadd developers && useradd -m -s /bin/bash -G developers alex && useradd -m -s /bin/bash -G developers svc
   mkdir -p /srv/cortex/cortex-v2-deploy && cd /src && git -c safe.directory=* ls-files -co --exclude-standard | tar -cf - -T - | tar -xf - -C /srv/cortex/cortex-v2-deploy
   cp -a /src/node_modules /srv/cortex/cortex-v2-deploy/ && chgrp -R developers /srv/cortex && chmod -R g+rwX /srv/cortex'
Z 'mkdir -p /tmp/tg && chmod 777 /tmp/tg && (nohup node /srv/cortex/cortex-v2-deploy/test/sim/fake-telegram.mjs 8081 /tmp/tg >/tmp/tg/server.log 2>&1 &)'

echo "== alex: node node-a with session roles globex-dev and pm"
U alex "$T bin/cortex-mesh.ts config alias node-a >/dev/null && $T bin/cortex-mesh.ts listen on >/dev/null && $T bin/cortex-install.ts >/dev/null 2>&1; $ROLE join globex-dev --create --as globex-dev-1 >/dev/null; $ROLE join pm --create --as pm >/dev/null"

echo "== svc: service node node-a-svc with telegram, its host under made-up secrets"
U svc "$T bin/cortex-install.ts --service --alias node-a-svc --with telegram" | sed 's/^/    /'
U svc 'mkdir -p ~/.config/ckn/data/telegram && cat > ~/.config/ckn/data/telegram/telegram.json <<EOF
{ "tickSeconds": 1, "http": { "listen": ["127.0.0.1:7320"], "publishToken": { "from": "env", "name": "TELEGRAM_PUBLISH_TOKEN" } }, "owners": { "known": ["globex-dev"] },
  "bots": [ { "id": "dev", "default": true, "identity": { "username": "@fake_dev_bot" }, "token": { "from": "env", "name": "TG_DEV" }, "poll": true, "operators": [ { "name": "alex", "chat": { "from": "env", "name": "TG_CHAT" } } ],
              "fallbackTo": "alex", "fallbackMinutes": { "page": 0.05, "action": 60 } } ] }
EOF'
U svc "(TG_DEV=fake-dev TG_CHAT=555 TELEGRAM_PUBLISH_TOKEN=pub-sim CKN_TELEGRAM_API=http://127.0.0.1:8081 nohup $T core/index.ts >/tmp/host.log 2>&1 &)"
waitcheck "the host started telegram, and its socket is 0600" 30 U svc "[ \"\$(stat -c %a $SOCK)\" = 600 ]"
check "telegram is host-only: a plain status run lists it as such" U svc "$T bin/cortex-status.ts | grep -q 'Host only.*telegram'"

echo "== a producer's page: routed to its owner by reference, then falls back to the operator"
pub() { Z "curl -s -X POST -H 'authorization: Bearer pub-sim' -H 'content-type: application/json' -d '$1' http://127.0.0.1:7320/v1/items"; }
item=$(pub '{"source":"gpu-check","owner":"globex-dev","severity":"page","title":"GPU missing","body":"nvidia-smi saw no device"}' | sed 's/.*"id":"\([^"]*\)".*/\1/')
echo "    item $item"
routed() { U alex "$ROLE inbox --as globex-dev-1 --all" | grep -q "cortex-telegram show $item"; }
waitcheck "globex-dev-1 got the reference" 30 routed
check "... and it carries no producer text" bash -c "! docker exec $P-node-a runuser -l alex -c 'cd /srv/cortex/cortex-v2-deploy; $ROLE inbox --as globex-dev-1 --all' | grep -q 'nvidia-smi'"
fell() { Z "grep -q 'cortex -- unacknowledged, from gpu-check \\[page\\] GPU missing' /tmp/tg/fake-dev-sent.jsonl"; }
waitcheck "the page fell back to the operator on Telegram" 30 fell

echo "== the operator replies to it: routed to globex-dev, read as a file with cortex-telegram"
mid=$(Z "grep 'GPU missing' /tmp/tg/fake-dev-sent.jsonl | head -1 | sed 's/.*\"message_id\":\([0-9]*\).*/\1/'")
Z "curl -s -X POST -d '{\"update_id\":1,\"message\":{\"message_id\":9,\"chat\":{\"id\":555},\"from\":{\"id\":555},\"text\":\"rebooting it now \$(id)\",\"reply_to_message\":{\"message_id\":$mid}}}' http://127.0.0.1:8081/control/fake-dev/push" >/dev/null
woke() { U alex "$ROLE inbox --as globex-dev-1 --all" | grep -q 'Operator reply stored as inbound'; }
waitcheck "globex-dev-1 is told a reply is stored, by reference" 30 woke
check "... with no operator text in the message" bash -c "! docker exec $P-node-a runuser -l alex -c 'cd /srv/cortex/cortex-v2-deploy; $ROLE inbox --as globex-dev-1 --all' | grep -q 'rebooting'"
inb=$(U alex "$ROLE inbox --as globex-dev-1 --all" | grep -o 'replies --id [0-9]*' | head -1 | awk '{print $3}')
check "cortex-telegram replies --id $inb returns the text, from a file" U alex "$TG replies --id $inb --as globex-dev-1 | grep -q 'rebooting it now'"

echo "== await with a watcher running on the same member (PM's live defect): await returns, the watcher shows no results"
U alex "(nohup $ROLE watch --as globex-dev-1 >/tmp/watch-globex.log 2>&1 &)"
since=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
U alex "(nohup $TG await --topic $item --since $since --timeout 90 --interval 2 --as globex-dev-1 >/tmp/await.out 2>&1; echo \$? >/tmp/await.rc) >/dev/null 2>&1 &"
sleep 6
Z "curl -s -X POST -d '{\"update_id\":3,\"message\":{\"message_id\":11,\"chat\":{\"id\":555},\"from\":{\"id\":555},\"text\":\"second answer\",\"reply_to_message\":{\"message_id\":$mid}}}' http://127.0.0.1:8081/control/fake-dev/push" >/dev/null
awaited() { Z "[ \"\$(cat /tmp/await.rc 2>/dev/null)\" = 0 ] && grep -q 'second answer' /tmp/await.out"; }
waitcheck "await returned the first reply after --since, with exit 0" 60 awaited
check "the watcher never showed a command result" bash -c "! docker exec $P-node-a grep -q commandResult /tmp/watch-globex.log"
# The watcher prints on its own schedule: await returning first is no proof it has not yet.
wokeup() { Z "grep -q 'Operator reply stored as inbound' /tmp/watch-globex.log"; }
waitcheck "... but did show the human wake-up" 20 wokeup
Z "pkill -f 'cortex-role.ts watch' || true"

echo "== an unowned message is offered to live roles; the first claim wins"
Z "curl -s -X POST -d '{\"update_id\":4,\"message\":{\"message_id\":12,\"chat\":{\"id\":555},\"from\":{\"id\":555},\"text\":\"go ahead\"}}' http://127.0.0.1:8081/control/fake-dev/push" >/dev/null
offered() { U alex "$ROLE inbox --as pm --all" | grep -q 'BARE APPROVAL'; }
waitcheck "pm (live) got the claim request, flagged as a bare approval" 30 offered
cid=$(U alex "$ROLE inbox --as pm --all" | grep -o 'cortex-telegram claim [0-9]*' | head -1 | awk '{print $3}')
check "pm claims inbound $cid over comms and wins, as role pm" U alex "$TG claim $cid --as pm | grep -q '\"owner\": \"pm\"'"
check "a second claim loses (exit 1, owner pm)" U alex "out=\$($TG claim $cid --as globex-dev-1); rc=\$?; [ \$rc = 1 ] && echo \"\$out\" | grep -q '\"won\": false'"

echo "== an ack over comms is the sender's role"
item2=$(pub '{"source":"gpu-check","owner":"globex-dev","severity":"action","title":"fan slow"}' | sed 's/.*"id":"\([^"]*\)".*/\1/')
check "ack --handled by globex-dev-1 is recorded as globex-dev" U alex "$TG ack $item2 --handled --as globex-dev-1 | grep -q '\"state\": \"acked\"' && $TG show $item2 --as pm | grep -q '\"acked_by\": \"globex-dev\"'"

echo "== the LAN health holds counts only"
check "no item ids, offset or error text without a token" bash -c "! docker exec $P-node-a curl -s http://127.0.0.1:7320/v1/health | grep -qE 'it_|offset|last_error'"
check "the publish token cannot read replies" bash -c "[ \"\$(docker exec $P-node-a curl -s -o /dev/null -w '%{http_code}' -H 'authorization: Bearer pub-sim' http://127.0.0.1:7320/v1/replies)\" = 403 ]"

echo
echo "telegram sim: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || Z 'tail -20 /tmp/host.log' | sed 's/^/    host: /'
[ -n "${KEEP:-}" ] && { echo "KEEP set: remove with: docker rm -fv $P-node-a"; exit 0; }
cleanup
echo "cleaned up"
[ "$fail" -eq 0 ]
