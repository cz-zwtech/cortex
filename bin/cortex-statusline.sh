#!/usr/bin/env bash
# cortex-statusline: Cortex's part of the Claude Code status line.
#
#   cortex  12 mem  ● bus ○ local · docs-1
#
# Core prints only "cortex"; each installed module that declares a status line segment
# adds its part (memory: the count; comms: bus, mesh, member). Segments are linked into
# <state>/statusline.d by cortex-install as modules install, and unlinked as they go.
# Each reads the status line JSON on stdin, like this script, so it can be
# statusLine.command itself or be called from an existing script with the same stdin.

case "${1:-}" in -h|--help)
  echo "usage: cortex-statusline.sh < status-line-json   (Claude Code's statusLine.command; reads its JSON on stdin)"
  exit 0 ;;
esac
input=$(cat)
state=${CKN_STATE_DIR:-$HOME/.config/ckn}
out='\033[2mcortex\033[0m'
for seg in "$state"/statusline.d/*.sh; do
  [ -e "$seg" ] || continue
  part=$(printf '%s' "$input" | CKN_STATE_DIR="$state" bash "$seg" 2>/dev/null)
  [ -n "$part" ] && out="$out  $part"
done
printf '%b' "$out"
