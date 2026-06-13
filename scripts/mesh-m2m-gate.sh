#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Milestone 2 acceptance gate — two LOCAL Cortex nodes meshed on one box.
# Proves the 6 criteria in docs/superpowers/specs/2026-06-02-cortex-mesh-transport-design.md §9.
#
# Uses ports 3011/3012 (NOT 3001) so the live dev server on :3001 is untouched.
# Uses an EPHEMERAL shared token (no OpenBao needed for a local test); production
# (a worker node) fetches CKN_MESH_TOKEN via its secret manager instead.
#
# Run from the repo root:  bash scripts/mesh-m2m-gate.sh
# Re-runnable: tears down nodes + temp DBs on entry and exit.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd -P)"
TSX="$ROOT/node_modules/.bin/tsx"

A=http://127.0.0.1:3011
B=http://127.0.0.1:3012
DIR=/tmp/mesh-gate
TOK="gate-$(head -c8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
GOSSIP_MS=2000          # fast convergence for the gate
ZOMBIE_MS=4000          # short zombie horizon for the gate

PASS=0; FAIL=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
j()    { curl -s "$@"; }                       # json GET/POST helper

PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done
  wait 2>/dev/null
}
trap cleanup EXIT

start_node() {  # $1=name $2=port $3=peer-url $4=token(optional override)
  local name=$1 port=$2 peer=$3 tok=${4-$TOK}
  CKN_PORT=$port \
  CKN_GRAPH_DB_PATH="$DIR/graph$name.sqlite" \
  CKN_MESH_PEERS="$peer" \
  CKN_MESH_TOKEN="$tok" \
  CKN_MESH_SELF="http://127.0.0.1:$port" \
  CKN_MESH_GOSSIP_MS=$GOSSIP_MS \
  CKN_MESH_ZOMBIE_MS=$ZOMBIE_MS \
  CKN_PRIVATE_MIND=off \
  CKN_EMBEDDINGS=off \
    "$TSX" server/index.ts >"$DIR/$name.log" 2>&1 &
  PIDS+=($!)
}

wait_up() { for _ in $(seq 1 40); do j "$1/api/home" >/dev/null 2>&1 && return 0; sleep 0.25; done; return 1; }
# Wait until a node's gossip loop has marked at least one peer reachable. A send
# only fans out to ALREADY-reachable peers, so the send checks must wait for the
# fleet to converge first (else delivery falls back to the slower catch-up path).
wait_converged() { for _ in $(seq 1 40); do j "$1/api/bus/mesh-status" | grep -q '"reachable":true' && return 0; sleep 0.5; done; return 1; }
# No sqlite3 CLI on this box — read the WAL DBs via the bundled better-sqlite3
# (readonly handle; concurrent with the node's writer under WAL). Returns JSON rows.
dbq() { node --input-type=module -e 'import D from "better-sqlite3"; const db=new D(process.argv[1],{readonly:true}); process.stdout.write(JSON.stringify(db.prepare(process.argv[2]).all()))' "$1" "$2"; }
scalarA() { dbq "$DIR/graphA.sqlite" "$1" | grep -o '[0-9]\+' | head -1; }
scalarB() { dbq "$DIR/graphB.sqlite" "$1" | grep -o '[0-9]\+' | head -1; }

echo "── reset ──"; cleanup; rm -rf "$DIR"; mkdir -p "$DIR"
echo "token=$TOK  gossip=${GOSSIP_MS}ms  zombie=${ZOMBIE_MS}ms"

echo "── boot two meshed nodes ──"
start_node A 3011 "$B"
start_node B 3012 "$A"
wait_up "$A" && wait_up "$B" || { echo "FATAL: a node never came up"; tail -30 "$DIR"/A.log "$DIR"/B.log; exit 1; }
echo "  both nodes listening"

# Register a session on each node.
j -X POST "$A/api/bus/register" -H 'content-type: application/json' \
   -d '{"sessionId":"gate-A","title":"GateA","cwd":"/gate/a","machine":"nodeA"}' >/dev/null
j -X POST "$B/api/bus/register" -H 'content-type: application/json' \
   -d '{"sessionId":"gate-B","title":"GateB","cwd":"/gate/b","machine":"nodeB"}' >/dev/null

echo "── wait for gossip convergence ──"
if wait_converged "$A" && wait_converged "$B"; then ok "fleet converged (A↔B reachable)"; else bad "fleet did not converge — see logs"; fi

echo "── (1) cross-node send (A→B) ──"
SID=$(j -X POST "$A/api/bus/send" -H 'content-type: application/json' \
   -d '{"fromSession":"gate-A","fromName":"GateA","to":"GateB","kind":"msg","body":"hello-from-A"}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
sleep 1
if j "$B/api/bus/inbox?session=gate-B" | grep -q "hello-from-A"; then ok "B received A's message (id $SID)"; else bad "B did not receive A's message"; fi

echo "── (2) cross-node presence (gossip) ──"
sleep $(awk "BEGIN{print $GOSSIP_MS/1000*2+1}")
if j "$B/api/bus/peers" | grep -q '"GateA"'; then ok "B sees A's session via gossip"; else bad "B does not see A via gossip"; fi
if j "$A/api/bus/peers" | grep -q '"GateB"'; then ok "A sees B's session via gossip"; else bad "A does not see B via gossip"; fi

echo "── (3) offline catch-up ──"
# Kill B, send 3 while it's down, restart B, expect cursor-driven replay.
kill "${PIDS[1]}" 2>/dev/null; wait "${PIDS[1]}" 2>/dev/null; PIDS=("${PIDS[0]}")
for n in 1 2 3; do
  j -X POST "$A/api/bus/send" -H 'content-type: application/json' \
     -d "{\"fromSession\":\"gate-A\",\"fromName\":\"GateA\",\"to\":\"GateB\",\"kind\":\"msg\",\"body\":\"offline-$n\"}" >/dev/null
done
start_node B 3012 "$A"; wait_up "$B" || bad "B failed to restart"
sleep $(awk "BEGIN{print $GOSSIP_MS/1000*2+2}")
GOT=$(j "$B/api/bus/inbox?session=gate-B" | grep -o "offline-[123]" | sort -u | wc -l)
[ "$GOT" -eq 3 ] && ok "B caught up all 3 offline messages" || bad "B caught up $GOT/3 offline messages"
# idempotency: a second poll must not double-count via re-ingest
sleep $(awk "BEGIN{print $GOSSIP_MS/1000+1}")
DUP=$(scalarB "SELECT COUNT(*) AS n FROM bus_messages WHERE body LIKE 'offline-%'")
[ "${DUP:-0}" -eq 3 ] && ok "no duplicate rows after re-gossip (catch-up idempotent)" || bad "duplicate rows: ${DUP:-?} (expected 3)"

echo "── (4) ack propagation (B acks → A reflects) ──"
ACKID=$(dbq "$DIR/graphB.sqlite" "SELECT id FROM bus_messages WHERE body='offline-1' LIMIT 1" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
j -X POST "$B/api/bus/ack" -H 'content-type: application/json' -d "{\"sessionId\":\"gate-B\",\"id\":\"$ACKID\",\"kind\":\"ack\"}" >/dev/null
sleep $(awk "BEGIN{print $GOSSIP_MS/1000+1}")
if dbq "$DIR/graphA.sqlite" "SELECT acked_by FROM bus_messages WHERE id='$ACKID'" | grep -q "gate-B"; then ok "A's copy reflects B's ack (grow-only union)"; else bad "A's copy did not reflect B's ack"; fi

echo "── (5) zombie eviction ──"
# B currently has a live session (gate-B). Sign it off so B reports 0 sessions,
# then stay silent past the zombie horizon → A should evict B from its fleet view.
j -X POST "$B/api/bus/signoff" -H 'content-type: application/json' -d '{"sessionId":"gate-B"}' >/dev/null
sleep $(awk "BEGIN{print $ZOMBIE_MS/1000 + $GOSSIP_MS/1000*2 + 1}")
if j "$A/api/bus/mesh-status" | grep -q '"zombie":true'; then ok "A marked silent/0-session B a zombie"; else bad "A did not evict zombie B"; fi
# Reviving: a fresh session on B clears the zombie on the next gossip.
j -X POST "$B/api/bus/register" -H 'content-type: application/json' \
   -d '{"sessionId":"gate-B2","title":"GateB2","cwd":"/gate/b","machine":"nodeB"}' >/dev/null
sleep $(awk "BEGIN{print $GOSSIP_MS/1000*2+1}")
if j "$A/api/bus/mesh-status" | grep -q '"zombie":false'; then ok "new session on B cleared the zombie flag"; else bad "zombie flag not cleared after revive"; fi

echo "── (6) auth fail-closed ──"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$A/api/mesh/ingest" -H 'content-type: application/json' -d '{"id":"x","to":"gate-A","body":"spoof"}')
[ "$CODE" = "401" ] && ok "unauthenticated /api/mesh/ingest → 401" || bad "unauthenticated ingest returned $CODE (expected 401)"
CODE2=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$A/api/mesh/ingest" -H "Authorization: Bearer wrong-$TOK" -H 'content-type: application/json' -d '{"id":"x","to":"gate-A","body":"spoof"}')
[ "$CODE2" = "401" ] && ok "wrong-bearer /api/mesh/ingest → 401" || bad "wrong-bearer ingest returned $CODE2 (expected 401)"
# tier refuses to start without a token (peers set, token empty)
start_node NT 3013 "$A" ""    # empty token override
wait_up http://127.0.0.1:3013 || true
for _ in $(seq 1 10); do grep -q "mesh DISABLED" "$DIR/NT.log" 2>/dev/null && break; sleep 0.5; done
if grep -q "mesh DISABLED" "$DIR/NT.log" 2>/dev/null; then ok "no-token node logged mesh DISABLED (fail-closed)"; else bad "no-token node did not fail-closed (check $DIR/NT.log)"; fi

echo
echo "════════ m2m gate: $PASS passed, $FAIL failed ════════"
[ "$FAIL" -eq 0 ] && echo "GATE GREEN" || echo "GATE RED — see $DIR/*.log"
exit "$FAIL"
