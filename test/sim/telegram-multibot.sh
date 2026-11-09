#!/usr/bin/env bash
# Two bots in one telegram host, in a throwaway container
# with a stand-in Telegram and made-up tokens:
#   dev  operator alex (555); a "note " prefix route emits telegram.inbound
#   home operators alex (555) and a second person (777)
# A consumer module in the host (notetest, a stand-in for a consumer module)
# subscribes to telegram.inbound and reads the text through telegram.replies.
#
# Proves: operators are per bot; offsets are per bot; the note route reaches the
# consumer with no comms message; one bot's getUpdates conflict stops only that
# bot, with ONE alert sent through its own sendMessage, while the other polls on.
set -u
SRC=${R:-$(cd "$(dirname "$0")/../.." && pwd)}
[ -L "$SRC/node_modules" ] && { echo "node_modules in $SRC is a symlink: the sim mounts the checkout into a container, where the link target does not exist. Run npm ci in the checkout." >&2; exit 2; }
# A worktree\'s .git points at the main repo by absolute path: mount it there, so git works inside.
GITDIR=$(git -C "$SRC" rev-parse --path-format=absolute --git-common-dir)
# One run of this sim at a time on a host (some use fixed subnets); names carry a run id besides.
LOCK=/tmp/cortex-sim-telegrammb.lock; exec 9>>"$LOCK"; chmod 666 "$LOCK" 2>/dev/null; flock 9
P=telegrammb-${RUN_ID:-$$}
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
SOCK=/home/svc/.config/ckn/data/telegram/telegram.sock
health() { U svc "curl -s --unix-socket $SOCK http://x/v1/health"; }
push() { Z "curl -s -X POST -d '{\"update_id\":$2,\"message\":{\"message_id\":$2,\"chat\":{\"id\":$3},\"from\":{\"id\":$3},\"text\":\"$4\"}}' http://127.0.0.1:8081/control/$1/push" >/dev/null; }

echo "== setup: one user's service node, two bots, a consumer module"
Z 'groupadd developers && useradd -m -s /bin/bash -G developers alex && useradd -m -s /bin/bash -G developers svc
   mkdir -p /srv/cortex/cortex-v2-deploy && cd /src && git -c safe.directory=* ls-files -co --exclude-standard | tar -cf - -T - | tar -xf - -C /srv/cortex/cortex-v2-deploy
   cp -a /src/node_modules /srv/cortex/cortex-v2-deploy/ && chgrp -R developers /srv/cortex && chmod -R g+rwX /srv/cortex
   mkdir -p /tmp/tg && chmod 777 /tmp/tg && (nohup node /srv/cortex/cortex-v2-deploy/test/sim/fake-telegram.mjs 8081 /tmp/tg >/tmp/tg/server.log 2>&1 &)'
U alex "$T bin/cortex-mesh.ts config alias node-a >/dev/null && $T bin/cortex-install.ts >/dev/null 2>&1; $T bin/cortex-role.ts join pm --create --as pm >/dev/null"
U svc "$T bin/cortex-install.ts --service --alias node-a-svc --with telegram >/dev/null"
U svc 'mkdir -p ~/.config/ckn/data/telegram ~/.config/ckn/modules/notetest/server && cat > ~/.config/ckn/data/telegram/telegram.json <<EOF
{ "tickSeconds": 1, "http": { "listen": ["127.0.0.1:7320"], "publishToken": { "from": "env", "name": "TELEGRAM_PUBLISH_TOKEN" } },
  "bots": [
    { "id": "dev", "default": true, "identity": { "username": "@fake_dev_bot" }, "token": { "from": "env", "name": "TG_DEV" }, "poll": true, "operators": [ { "name": "alex", "chat": { "from": "env", "name": "TG_ALEX" } } ],
      "fallbackTo": "alex", "routes": [ { "prefix": "note ", "to": { "event": "telegram.inbound" } } ] },
    { "id": "home", "identity": { "username": "@fake_home_bot" }, "token": { "from": "env", "name": "TG_HOME" }, "poll": true, "operators": [ { "name": "alex", "chat": { "from": "env", "name": "TG_ALEX" } }, { "name": "partner", "chat": { "from": "env", "name": "TG_PARTNER" } } ],
      "fallbackTo": "alex" } ] }
EOF
cat > ~/.config/ckn/modules/notetest/module.json <<EOF
{ "name": "notetest", "version": "0.0.1", "requiresCore": ">=2.0.0 <3.0.0", "runs": "host", "optional": ["telegram"] }
EOF
cat > ~/.config/ckn/modules/notetest/server/index.ts <<EOF
import fs from "node:fs"
export default {
  start(ctx) {
    ctx.events.subscribe("telegram.inbound", "notetest", (p) => {
      const rows = ctx.capabilities.get("telegram.replies")({ id: p.inboundId })
      fs.appendFileSync("/tmp/note-consumer.jsonl", JSON.stringify({ ...p, text: rows[0] && rows[0].text }) + "\n")
    })
  },
}
EOF'
Z 'touch /tmp/note-consumer.jsonl && chmod 666 /tmp/note-consumer.jsonl'
U svc "(TG_DEV=fake-dev TG_HOME=fake-home TG_ALEX=555 TG_PARTNER=777 TELEGRAM_PUBLISH_TOKEN=pub-sim CKN_TELEGRAM_API=http://127.0.0.1:8081 nohup $T core/index.ts >/tmp/host.log 2>&1 &)"
waitcheck "the host is up with both bots" 30 bash -c "docker exec $P-node-a runuser -l svc -c 'curl -s --unix-socket $SOCK http://x/v1/health' | grep -q '\"bot\":\"home\"'"

echo "== operators are per bot, and so are offsets"
push fake-dev 10 777 'hello dev'
push fake-home 10 777 'hello home'
push fake-home 11 555 'alex on home'
dropped() { health | grep -q '"bot":"dev".*"dropped_unauthorised":1'; }
waitcheck "the partner (777) is dropped by the dev bot" 20 dropped
stored() { U svc "curl -s --unix-socket $SOCK 'http://x/v1/replies?bot=home'" | grep -q 'hello home'; }
waitcheck "... and accepted by the home bot" 20 stored
check "offsets are per bot (dev 11, home 12)" bash -c "docker exec $P-node-a runuser -l svc -c 'curl -s --unix-socket $SOCK http://x/v1/health' | grep -q '\"bot\":\"dev\".*\"offset\":\"11\".*\"bot\":\"home\".*\"offset\":\"12\"'"

echo "== a prefix route on the dev bot reaches the consumer module"
push fake-dev 12 555 'note buy milk'
consumed() { Z "grep -q '\"bot\":\"dev\".*\"route\":\"note\".*\"text\":\"note buy milk\"' /tmp/note-consumer.jsonl"; }
waitcheck "notetest got telegram.inbound and read the text through telegram.replies" 20 consumed
check "no comms message carried it (pm's inbox has nothing about it)" bash -c "! docker exec $P-node-a runuser -l alex -c 'cd /srv/cortex/cortex-v2-deploy; $T bin/cortex-role.ts inbox --as pm --all' | grep -q "buy milk""

echo "== the dev bot's getUpdates conflict: one alert through its own sendMessage; the home bot polls on"
Z 'touch /tmp/tg/fake-dev.conflict'
alerted() { Z "grep -q 'ALERT: the dev bot stopped listening: another process is polling its token' /tmp/tg/fake-dev-sent.jsonl"; }
waitcheck "one plain alert, naming the fix" 30 alerted
sleep 3
check "... exactly one" bash -c "[ \"\$(docker exec $P-node-a grep -c ALERT /tmp/tg/fake-dev-sent.jsonl)\" = 1 ]"
push fake-home 12 555 'still there?'
home_alive() { U svc "curl -s --unix-socket $SOCK 'http://x/v1/replies?bot=home'" | grep -q 'still there'; }
waitcheck "the home bot still receives" 20 home_alive
check "health on the socket shows the open conflict alert" U svc "curl -s --unix-socket $SOCK http://x/v1/health | grep -q '\"alerts\":\\[\"conflict\"\\]'"

echo
echo "multi-bot sim: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || Z 'tail -20 /tmp/host.log' | sed 's/^/    host: /'
[ -n "${KEEP:-}" ] && { echo "KEEP set: remove with: docker rm -fv $P-node-a"; exit 0; }
cleanup
echo "cleaned up"
[ "$fail" -eq 0 ]
