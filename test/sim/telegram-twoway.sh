#!/usr/bin/env bash
# Two-way Telegram for every dev role (build plan B.6), in one throwaway container:
# alex's node (node-a) with three dev roles, svc's service node (node-a-svc) running
# telegram, and a stand-in Telegram. No real home, Cortex, memory, bot or token is
# touched; every token below is made up.
#
# Proves: cortex-telegram is on PATH through a managed shim; an operator message
# addressed to each dev role reaches it by reference with a ready-to-run reply
# line; each replies with --reply-to and the answer threads under the operator's
# message; the inbound stops awaiting; a dev that has seen one and not answered is
# reminded once at Stop, never twice, and a dev that answered is not reminded.
set -u
SRC=${R:-$(cd "$(dirname "$0")/../.." && pwd)}
[ -L "$SRC/node_modules" ] && { echo "node_modules in $SRC is a symlink: the sim mounts the checkout into a container, where the link target does not exist. Run npm ci in the checkout." >&2; exit 2; }
# A worktree\'s .git points at the main repo by absolute path: mount it there, so git works inside.
GITDIR=$(git -C "$SRC" rev-parse --path-format=absolute --git-common-dir)
# One run of this sim at a time on a host (some use fixed subnets); names carry a run id besides.
LOCK=/tmp/cortex-sim-tg2waysim.lock; exec 9>>"$LOCK"; chmod 666 "$LOCK" 2>/dev/null; flock 9
P=tg2waysim-${RUN_ID:-$$}
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
SOCK=/home/svc/.config/ckn/data/telegram/telegram.sock
DEVS='alpha-dev beta-dev gamma-dev'

echo "== setup: users, the shared checkout (this working tree), a stand-in Telegram"
Z 'groupadd developers && useradd -m -s /bin/bash -G developers alex && useradd -m -s /bin/bash -G developers svc
   mkdir -p /srv/cortex/cortex-v2-deploy && cd /src && git -c safe.directory=* ls-files -co --exclude-standard | tar -cf - -T - | tar -xf - -C /srv/cortex/cortex-v2-deploy
   cp -a /src/node_modules /srv/cortex/cortex-v2-deploy/ && chgrp -R developers /srv/cortex && chmod -R g+rwX /srv/cortex'
Z 'mkdir -p /tmp/tg && chmod 777 /tmp/tg && (nohup node /srv/cortex/cortex-v2-deploy/test/sim/fake-telegram.mjs 8081 /tmp/tg >/tmp/tg/server.log 2>&1 &)'

echo "== alex: node node-a, three dev roles, each bound to its own session"
U alex "$T bin/cortex-mesh.ts config alias node-a >/dev/null && $T bin/cortex-mesh.ts listen on >/dev/null && $T bin/cortex-install.ts >/tmp/alex-install.out 2>&1"
for d in $DEVS; do U alex "CLAUDE_CODE_SESSION_ID=sess-$d $ROLE join $d --create --as $d-1 >/dev/null"; done
check "install put cortex-telegram on PATH as a managed shim" U alex "grep -q 'on PATH: .*cortex-telegram' /tmp/alex-install.out && grep -q cortex:managed-shim ~/.local/bin/cortex-telegram && [ \"\$(command -v cortex-telegram)\" = \"\$HOME/.local/bin/cortex-telegram\" ]"

echo "== svc: service node node-a-svc with telegram, its host under made-up secrets"
U svc "$T bin/cortex-install.ts --service --alias node-a-svc --with telegram" >/dev/null 2>&1
U svc 'mkdir -p ~/.config/ckn/data/telegram && cat > ~/.config/ckn/data/telegram/telegram.json <<EOF
{ "tickSeconds": 1, "http": { "listen": ["127.0.0.1:7320"], "publishToken": { "from": "env", "name": "TELEGRAM_PUBLISH_TOKEN" } },
  "bots": [ { "id": "dev", "default": true, "identity": { "username": "@fake_dev_bot" }, "token": { "from": "env", "name": "TG_DEV" }, "poll": true, "operators": [ { "name": "alex", "chat": { "from": "env", "name": "TG_CHAT" } } ], "fallbackTo": "alex" } ] }
EOF'
U svc "(TG_DEV=fake-dev TG_CHAT=555 TELEGRAM_PUBLISH_TOKEN=pub-sim CKN_TELEGRAM_API=http://127.0.0.1:8081 nohup $T core/index.ts >/tmp/host.log 2>&1 &)"
waitcheck "the host started telegram" 30 U svc "test -S $SOCK"

echo "== the operator writes to each dev role by name"
n=100
for d in $DEVS; do
  n=$((n+1))
  Z "curl -s -X POST -d '{\"update_id\":$n,\"message\":{\"message_id\":$n,\"chat\":{\"id\":555},\"from\":{\"id\":555},\"text\":\"$d what is your status?\"}}' http://127.0.0.1:8081/control/fake-dev/push" >/dev/null
done
inbound_of() { U alex "$ROLE inbox --as $1-1 --all" | grep -o 'send --reply-to [0-9]*' | head -1 | awk '{print $3}'; }
for d in $DEVS; do
  waitcheck "$d is told, with a ready-to-run reply line" 30 bash -c "docker exec $P-node-a runuser -l alex -c 'cd /srv/cortex/cortex-v2-deploy; $ROLE inbox --as $d-1 --all' | grep -q 'expects an answer on Telegram. Reply with: cortex-telegram send --reply-to'"
done
check "... and no operator text travels in it" bash -c "! docker exec $P-node-a runuser -l alex -c 'cd /srv/cortex/cortex-v2-deploy; $ROLE inbox --as alpha-dev-1 --all' | grep -q 'what is your status'"
IA=$(inbound_of alpha-dev); IB=$(inbound_of beta-dev); IG=$(inbound_of gamma-dev)
echo "    inbound: alpha $IA, beta $IB, gamma $IG"
check "each awaits an answer" U alex "cortex-telegram replies --id $IA --as alpha-dev-1 | grep -q '\"awaiting\": 1'"

stop() { U alex "echo '{\"hook_event_name\":\"Stop\",\"session_id\":\"sess-$1\"}' | CLAUDE_CODE_SESSION_ID=sess-$1 $T bin/cortex-hook.ts Stop"; }
watch() { U alex "(CLAUDE_CODE_SESSION_ID=sess-$1 nohup $ROLE watch --as $1-1 >/tmp/watch-$1.log 2>&1 &)"; }

echo "== beta has seen its message (its inbox showed it) and has not answered: reminded once at Stop"
watch beta-dev
waitcheck "beta's watcher is live (so Stop is not held for it)" 20 Z "grep -q beatAt /home/alex/.config/ckn/data/comms/watch/beta-dev-1.json"
check "Stop reminds beta once, with the reply line" bash -c "out=\$(docker exec $P-node-a runuser -l alex -c \"cd /srv/cortex/cortex-v2-deploy; echo '{\\\"hook_event_name\\\":\\\"Stop\\\",\\\"session_id\\\":\\\"sess-beta-dev\\\"}' | CLAUDE_CODE_SESSION_ID=sess-beta-dev $T bin/cortex-hook.ts Stop\"); echo \"\$out\" | grep -q 'answer is still expected' && echo \"\$out\" | grep -q 'send --reply-to $IB'"
check "... and never again" bash -c "! docker exec $P-node-a runuser -l alex -c \"cd /srv/cortex/cortex-v2-deploy; echo '{\\\"session_id\\\":\\\"sess-beta-dev\\\"}' | CLAUDE_CODE_SESSION_ID=sess-beta-dev $T bin/cortex-hook.ts Stop\" | grep -q 'still expected'"

echo "== each dev replies with --reply-to, through the shim on PATH"
for d in $DEVS; do
  id=$(inbound_of $d)
  check "$d replies to inbound $id" U alex "echo '$d: all green' | CLAUDE_CODE_SESSION_ID=sess-$d cortex-telegram send --reply-to $id | grep -q '\"state\": \"sent\"'"
done
for pair in "alpha-dev:101" "beta-dev:102" "gamma-dev:103"; do
  d=${pair%%:*}; m=${pair##*:}
  check "$d's answer threads under the operator's message $m" Z "grep '$d: all green' /tmp/tg/fake-dev-sent.jsonl | grep -q '\"reply_to\":$m'"
done
for pair in "alpha-dev:$IA" "beta-dev:$IB" "gamma-dev:$IG"; do
  d=${pair%%:*}; id=${pair##*:}
  check "inbound $id no longer awaits, and names its answer" U alex "cortex-telegram replies --id $id --as $d-1 | grep -q '\"awaiting\": 0' && cortex-telegram replies --id $id --as $d-1 | grep -q '\"answered_by\": \"ob_'"
done

echo "== gamma saw its message and answered before Stop: no reminder"
watch gamma-dev
waitcheck "gamma's watcher is live (so Stop is not held for it)" 20 Z "grep -q beatAt /home/alex/.config/ckn/data/comms/watch/gamma-dev-1.json"
check "Stop does not remind gamma" bash -c "! docker exec $P-node-a runuser -l alex -c \"cd /srv/cortex/cortex-v2-deploy; echo '{\\\"session_id\\\":\\\"sess-gamma-dev\\\"}' | CLAUDE_CODE_SESSION_ID=sess-gamma-dev $T bin/cortex-hook.ts Stop\" | grep -q 'still expected'"

echo "== refusals"
check "--reply-to an unknown inbound is refused" U alex "! echo x | cortex-telegram send --reply-to 9999 --as alpha-dev-1"

echo
echo "telegram two-way sim: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || Z 'tail -20 /tmp/host.log' | sed 's/^/    host: /'
[ -n "${KEEP:-}" ] && { echo "KEEP set: remove with: docker rm -fv $P-node-a"; exit 0; }
cleanup
echo "cleaned up"
[ "$fail" -eq 0 ]
