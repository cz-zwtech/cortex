#!/usr/bin/env bash
# comms' status line segment: the bus and the mesh, and this session's member.
#
#   ● bus ○ local · docs-1
#
# bus   green: this session is a role member and its comms watcher is live
#       red "bus off": a member whose watcher is not running (messages wait for a prompt)
#       dim: not a role member, so there is nothing to listen for
# mesh  green: linked to at least one peer; yellow "local": the daemon runs with no live
#       peer link; dim "mesh off": no daemon (a local-only node, or stopped: sessions here
#       still talk through the local log)
#
# Plain shell: it renders on every prompt. It reads files the hooks and the daemon keep
# current, and never calls the daemon.

input=$(cat)
state=${CKN_STATE_DIR:-$HOME/.config/ckn}
G='\033[32m'; Y='\033[33m'; R='\033[31m'; D='\033[2m'; X='\033[0m'

sid=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
member=""
[ -n "$sid" ] && member=$(jq -r --arg s "$sid" '.[$s] // empty' "$state/data/comms/sessions.json" 2>/dev/null)
watch_live() {
  local w="$state/data/comms/watch/$member.json" now beat ended
  now=$(($(date +%s) * 1000))
  beat=$(jq -r '.beatAt // 0' "$w" 2>/dev/null)
  ended=$(jq -r '.endedAt // empty' "$w" 2>/dev/null)
  [ -z "$ended" ] && [ "${beat:-0}" -gt 0 ] && [ $((now - beat)) -le 60000 ]
}

# The bus is the local mesh log, always there; the daemon only
# links peers. Read its status file, never call it.
if [ -z "$member" ]; then bus="${D}○ bus${X}"; elif watch_live; then bus="${G}● bus${X}"; else bus="${R}● bus off${X}"; fi
s="$state/data/mesh/status.json"
pid=$(cat "$state/data/mesh/daemon.pid" 2>/dev/null)
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && [ "$(jq -r '.running // false' "$s" 2>/dev/null)" = "true" ]; then
  if [ "$(jq -r '[.links[]? | select(.live == true)] | length' "$s" 2>/dev/null)" -ge 1 ] 2>/dev/null; then
    mesh="${G}● mesh${X}"
  else
    mesh="${Y}○ local${X}"
  fi
else
  mesh="${D}○ mesh off${X}"
fi

printf '%b' "$bus $mesh${member:+ ${D}· $member${X}}"
