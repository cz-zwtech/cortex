#!/usr/bin/env bash
# The domain gateway in throwaway containers (build plan
# docs/cortex/2026-10-21-gateway-p7-build-plan.md). Nothing here touches a real
# home, a real Cortex or real memory.
#
#   E  home's gateway    (cortex-install --gateway --domain home)
#   F  partner's gateway (cortex-install --gateway --domain partner)
#   X  a stranger       (a gateway whose key nobody pinned)
# All three meet only on an "internet" docker network, on 28417.
#
# Slice 1 proves: each gateway makes its own key and prints only its pin; with
# each other's pins configured, E and F link over mutual TLS; X is refused by
# key and banned after repeated failures; a dialler refuses a listener that
# does not hold the pinned key.
set -u
SRC=${R:-$(cd "$(dirname "$0")/../.." && pwd)}
[ -L "$SRC/node_modules" ] && { echo "node_modules in $SRC is a symlink: the sim mounts the checkout into a container, where the link target does not exist. Run npm ci in the checkout." >&2; exit 2; }
# A worktree\'s .git points at the main repo by absolute path: mount it there, so git works inside.
GITDIR=$(git -C "$SRC" rev-parse --path-format=absolute --git-common-dir)
# One run of this sim at a time on a host (some use fixed subnets); names carry a run id besides.
LOCK=/tmp/cortex-sim-gwsim.lock; exec 9>>"$LOCK"; chmod 666 "$LOCK" 2>/dev/null; flock 9
P=gwsim-${RUN_ID:-$$}
pass=0; fail=0
ok() { echo "  PASS  $1"; pass=$((pass+1)); }
no() { echo "  FAIL  $1"; fail=$((fail+1)); }
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else no "$what"; fi; }
waitcheck() { local what=$1 secs=$2; shift 2; for _ in $(seq 1 "$secs"); do "$@" >/dev/null 2>&1 && { ok "$what"; return; }; sleep 1; done; no "$what"; }
cleanup() { for c in e f x; do docker rm -fv $P-$c >/dev/null 2>&1; done; docker network rm $P-internet >/dev/null 2>&1; }
cleanup

docker network create $P-internet >/dev/null
for c in e f x; do
  docker run -d --init --name $P-$c --network $P-internet -v $SRC:/src:ro -v $GITDIR:$GITDIR:ro --entrypoint sleep cortex-lab:dev infinity >/dev/null
  docker exec $P-$c bash -c 'useradd -m -s /bin/bash alex
    mkdir -p /srv/cortex/cortex-v2-deploy && cd /src && git -c safe.directory=* ls-files -co --exclude-standard | tar -cf - -T - | tar -xf - -C /srv/cortex/cortex-v2-deploy
    cp -a /src/node_modules /srv/cortex/cortex-v2-deploy/ && chown -R alex /srv/cortex/cortex-v2-deploy
    runuser -l alex -c "mkdir -p ~/.config/ckn ~/.claude"'
done
U() { docker exec $P-$1 runuser -l alex -c "cd /srv/cortex/cortex-v2-deploy; $2"; }
T='node_modules/.bin/tsx'
GATE='modules/gateway/bin/cortex-gate.ts'
ip() { docker inspect -f "{{(index .NetworkSettings.Networks \"$P-internet\").IPAddress}}" $P-$1; }

echo "== install three gateways"
U e "$T bin/cortex-install.ts --gateway --domain home --no-mesh-start" > /tmp/$P-e.out 2>&1
U f "$T bin/cortex-install.ts --gateway --domain partner --no-mesh-start" > /tmp/$P-f.out 2>&1
U x "$T bin/cortex-install.ts --gateway --domain stranger --no-mesh-start" > /tmp/$P-x.out 2>&1
check "each prints its pin and never its key" bash -c "grep -q '^  pin: ' /tmp/$P-e.out && ! grep -q 'PRIVATE KEY' /tmp/$P-e.out"
check "the key file is 0600" U e "test \$(stat -c %a ~/.config/ckn/data/gateway/domain.key) = 600"
PE=$(U e "$T $GATE key"); PF=$(U f "$T $GATE key"); EIP=$(ip e)

echo "== configure: F dials E; X dials E with E's real pin, but nobody pinned X"
U e "cat > ~/.config/ckn/data/gateway/gateway.json <<EOF
{ \"domain\": \"home\", \"peers\": [{ \"domain\": \"partner\", \"pin\": \"$PF\" }], \"limits\": { \"banAfterFailures\": 3, \"banMinutes\": 5 } }
EOF"
U f "cat > ~/.config/ckn/data/gateway/gateway.json <<EOF
{ \"domain\": \"partner\", \"peers\": [{ \"domain\": \"home\", \"address\": \"$EIP:28417\", \"pin\": \"$PE\" }] }
EOF"
U x "cat > ~/.config/ckn/data/gateway/gateway.json <<EOF
{ \"domain\": \"stranger\", \"peers\": [{ \"domain\": \"home\", \"address\": \"$EIP:28417\", \"pin\": \"$PE\" }] }
EOF"
check "cortex-gate check reads the config" U e "$T $GATE check | grep -q 'peer partner (it dials us): nothing exposed'"
for c in e f x; do U $c "$T bin/cortex-mesh.ts start >/dev/null 2>&1"; done

echo "== link"
linked() { U $1 "$T $GATE status" | grep -q "^  linked     $2"; }
waitcheck "E and F link over mutual TLS with pinned keys" 30 bash -c "docker exec $P-e runuser -l alex -c 'cd /srv/cortex/cortex-v2-deploy; $T $GATE status' | grep -q '^  linked     partner' && docker exec $P-f runuser -l alex -c 'cd /srv/cortex/cortex-v2-deploy; $T $GATE status' | grep -q '^  linked     home'"
banned() { U e "$T $GATE status" | grep -q "banned sources: $(ip x)"; }
waitcheck "X is refused by key, and banned after three failures" 60 banned
check "X never links" bash -c "! docker exec $P-x runuser -l alex -c 'cd /srv/cortex/cortex-v2-deploy; $T $GATE status' | grep -q '^  linked'"

echo "== a dialler checks the listener's key"
U f "$T bin/cortex-mesh.ts stop >/dev/null 2>&1"
# F now dials X's address but pins E: X holds the wrong key. X pins F, so the TLS handshake completes and the
# refusal is F's own check of the listener's key.
U x "$T bin/cortex-mesh.ts stop >/dev/null 2>&1"
U x "cat > ~/.config/ckn/data/gateway/gateway.json <<EOF
{ \"domain\": \"stranger\", \"peers\": [{ \"domain\": \"partner\", \"pin\": \"$PF\" }] }
EOF"
U x "$T bin/cortex-mesh.ts start >/dev/null 2>&1"
U f "cat > ~/.config/ckn/data/gateway/gateway.json <<EOF
{ \"domain\": \"partner\", \"peers\": [{ \"domain\": \"home\", \"address\": \"$(ip x):28417\", \"pin\": \"$PE\" }] }
EOF"
U f "$T bin/cortex-mesh.ts start >/dev/null 2>&1"
waitcheck "F refuses a listener that does not hold home's pinned key" 30 U f "grep -q \"does not hold home's pinned key\" ~/.config/ckn/data/mesh/daemon.log"
check "... and is not linked" bash -c "! docker exec $P-f runuser -l alex -c 'cd /srv/cortex/cortex-v2-deploy; $T $GATE status' | grep -q '^  linked'"

echo
echo "gateway sim: $pass passed, $fail failed"
[ -n "${KEEP:-}" ] && { echo "KEEP set: remove with: docker rm -fv $P-e $P-f $P-x; docker network rm $P-internet"; exit 0; }
cleanup
echo "cleaned up"
[ "$fail" -eq 0 ]
