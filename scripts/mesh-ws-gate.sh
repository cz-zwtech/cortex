#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# M2.1 overlay gate — 3 local nodes over the WS transport + L2 discovery.
# Mirrors the real topology via DIAL-LISTS (loopback is all mutually reachable, so
# the asymmetry is enforced by config = who dials whom):
#   M  (LAN-equiv)  dials {D1, D2}
#   D1 (dev-lab)    dials {D2}        (+ discovers/dials D1↔D2 symmetrically)
#   D2 (dev-lab)    dials {}          (accept-only; sends over inbound links)
# A pure dialer's (M's) address is never gossiped, so D1/D2 never dial M — the
# asymmetry holds even on loopback. Proves: all-pairs delivery (incl. from the
# accept-only node), presence convergence, reconnect backfill, auth fail-closed.
#
# Ports 3021/3022/3023 (live :3001 untouched). Ephemeral shared token.
# Run from repo root:  bash scripts/mesh-ws-gate.sh
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd -P)"
TSX="$ROOT/node_modules/.bin/tsx"

M=http://127.0.0.1:3021
D1=http://127.0.0.1:3022
D2=http://127.0.0.1:3023
DIR=/tmp/mesh-ws-gate
TOK="wsgate-$(head -c8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
GOSSIP_MS=1500
PROBE_MS=1500

PASS=0; FAIL=0
ok()  { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
j()   { curl -s "$@"; }

PIDS=()
# Kill by PORT — tsx forks a child node, so killing the wrapper leaks the listener;
# killing whatever holds the port reaps the actual server regardless of process tree.
kill_port() { local pid; pid=$(ss -ltnp 2>/dev/null | grep ":$1 " | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2); [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null; }
cleanup() { for p in 3021 3022 3023; do kill_port "$p"; done; for p in "${PIDS[@]:-}"; do kill -9 "$p" 2>/dev/null; done; wait 2>/dev/null; }
trap cleanup EXIT

start_node() { # $1=name $2=port $3=self-url $4=dial-list-csv $5=token(optional)
  local name=$1 port=$2 self=$3 peers=$4 tok=${5-$TOK}
  CKN_PORT=$port CKN_BIND=127.0.0.1 \
  CKN_GRAPH_DB_PATH="$DIR/graph$name.sqlite" \
  CKN_MESH_SELF="$self" CKN_MESH_PEERS="$peers" CKN_MESH_TOKEN="$tok" \
  CKN_MESH_GOSSIP_MS=$GOSSIP_MS CKN_MESH_PROBE_MS=$PROBE_MS \
  CKN_NODE_ID="node-$name" \
  CKN_PRIVATE_MIND=off CKN_EMBEDDINGS=off \
  "$TSX" server/index.ts >"$DIR/$name.log" 2>&1 &
  PIDS+=($!)
}
wait_up()  { for _ in $(seq 1 60); do j "$1/api/home" >/dev/null 2>&1 && return 0; sleep 0.25; done; return 1; }
wslinks()  { j "$1/api/bus/mesh-status" | grep -o '"connected":true' | wc -l; }
reg()      { j -X POST "$1/api/bus/register" -H 'content-type: application/json' -d "{\"sessionId\":\"$2\",\"title\":\"$3\",\"cwd\":\"/gate/$2\",\"machine\":\"$2\"}" >/dev/null; }
# send from node $1 (session $2/name $3) to friendly name $4 body $5
send()     { j -X POST "$1/api/bus/send" -H 'content-type: application/json' -d "{\"fromSession\":\"$2\",\"fromName\":\"$3\",\"to\":\"$4\",\"kind\":\"msg\",\"body\":\"$5\"}" >/dev/null; }
inbox_has(){ j "$1/api/bus/inbox?session=$2" | grep -q "$3"; }

echo "── reset ──"; cleanup; rm -rf "$DIR"; mkdir -p "$DIR"; echo "token=$TOK"

echo "── boot 3 nodes (dial-lists: M→{D1,D2}, D1→{D2}, D2→{}) ──"
start_node M  3021 "$M"  "$D1,$D2"
start_node D1 3022 "$D1" "$D2"
start_node D2 3023 "$D2" ""
wait_up "$M" && wait_up "$D1" && wait_up "$D2" || { echo "FATAL boot"; tail -20 "$DIR"/*.log; exit 1; }
echo "  all 3 up"

# Register a session on each node.
reg "$M"  s-m  GateM
reg "$D1" s-d1 GateD1
reg "$D2" s-d2 GateD2

echo "── converge (gossip + discovery) ──"
sleep $(awk "BEGIN{print $GOSSIP_MS/1000*3 + $PROBE_MS/1000*2 + 2}")
LM=$(wslinks "$M"); LD1=$(wslinks "$D1"); LD2=$(wslinks "$D2")
echo "  live WS links — M:$LM D1:$LD1 D2:$LD2"
[ "$LM" -ge 2 ] && [ "$LD1" -ge 1 ] && [ "$LD2" -ge 1 ] && ok "fleet converged (M has 2 links; D1,D2 linked)" || bad "fleet did not converge (M:$LM D1:$LD1 D2:$LD2)"

echo "── (1) all-pairs delivery (incl. from accept-only D2) ──"
send "$M"  s-m  GateM  GateD1 "m2d1"
send "$M"  s-m  GateM  GateD2 "m2d2"
send "$D1" s-d1 GateD1 GateM  "d12m"
send "$D1" s-d1 GateD1 GateD2 "d12d2"
send "$D2" s-d2 GateD2 GateM  "d22m"
send "$D2" s-d2 GateD2 GateD1 "d22d1"
sleep 2
inbox_has "$D1" s-d1 m2d1  && ok "M→D1 delivered"  || bad "M→D1 missing"
inbox_has "$D2" s-d2 m2d2  && ok "M→D2 delivered"  || bad "M→D2 missing"
inbox_has "$M"  s-m  d12m  && ok "D1→M delivered"  || bad "D1→M missing"
inbox_has "$D2" s-d2 d12d2 && ok "D1→D2 delivered" || bad "D1→D2 missing"
inbox_has "$M"  s-m  d22m  && ok "D2→M delivered (accept-only sends over inbound link)" || bad "D2→M missing"
inbox_has "$D1" s-d1 d22d1 && ok "D2→D1 delivered" || bad "D2→D1 missing"

echo "── (2) presence convergence (each node sees the other two) ──"
j "$M/api/bus/peers"  | grep -q '"GateD1"' && j "$M/api/bus/peers"  | grep -q '"GateD2"' && ok "M sees D1+D2" || bad "M missing a peer"
j "$D1/api/bus/peers" | grep -q '"GateM"'  && j "$D1/api/bus/peers" | grep -q '"GateD2"' && ok "D1 sees M+D2" || bad "D1 missing a peer"
j "$D2/api/bus/peers" | grep -q '"GateM"'  && j "$D2/api/bus/peers" | grep -q '"GateD1"' && ok "D2 sees M+D1" || bad "D2 missing a peer"

echo "── (3) reconnect backfill (restart D1, send during gap, expect replay) ──"
kill_port 3022   # reap D1 by port (kills the real listener regardless of process tree)
sleep 1
send "$M" s-m GateM GateD1 "gap-msg-1"
send "$D2" s-d2 GateD2 GateD1 "gap-msg-2"
start_node D1 3022 "$D1" "$D2"; PIDS[1]=$!
wait_up "$D1" || bad "D1 restart failed"
sleep $(awk "BEGIN{print $GOSSIP_MS/1000*3 + 3}")
inbox_has "$D1" s-d1 gap-msg-1 && ok "D1 caught up M's gap message (backfill)" || bad "D1 missed gap-msg-1"
inbox_has "$D1" s-d1 gap-msg-2 && ok "D1 caught up D2's gap message" || bad "D1 missed gap-msg-2"

echo "── (4) auth fail-closed ──"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$M/api/mesh/ingest" -H 'content-type: application/json' -d '{"id":"x","to":"s-m","body":"spoof"}')
[ "$CODE" = "401" ] && ok "unauthenticated /api/mesh/ingest → 401" || bad "ingest without bearer returned $CODE"

echo
echo "════════ ws overlay gate: $PASS passed, $FAIL failed ════════"
[ "$FAIL" -eq 0 ] && echo "GATE GREEN" || { echo "GATE RED — logs in $DIR/*.log"; }
exit "$FAIL"
