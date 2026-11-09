#!/usr/bin/env bash
# memory's status line segment: how many memories this node holds ("1991 mem").
# The count file is kept current by the hooks; this never starts node.
state=${CKN_STATE_DIR:-$HOME/.config/ckn}
cat >/dev/null
mem=$(cat "$state/data/memory/count" 2>/dev/null)
printf '%b' "\033[2m${mem:-?} mem\033[0m"
