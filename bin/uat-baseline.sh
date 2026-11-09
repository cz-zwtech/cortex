#!/bin/sh
# Capture a PRISTINE settings.json baseline — before core is ever installed.
#
# Why this exists, and why it runs now rather than when the reset is built:
#
# Resetting the harness to zero without deleting ~/.claude (which holds the
# OAuth credential) means restoring settings.json to a pristine state. There are
# two ways to get one, and only one is safe:
#
#   CIRCULAR   — use core's own uninstall to remove its registrations. Tempting,
#                because every reset would exercise uninstall. But it makes the
#                thing under test into the test harness: if uninstall is subtly
#                wrong, every reset perpetuates the wrongness and the UAT is
#                structurally unable to see it.
#   INDEPENDENT — capture the file ONCE, before core has ever touched it, and
#                restore that. The reset then owes nothing to core's correctness.
#
# With an independent baseline in hand you get both: restore it to reset, and
# separately assert that core's uninstall produces the SAME result. That turns
# uninstall symmetry into a claim proven against an independent oracle instead
# of against itself.
#
# The catch is one-way: once core has written settings.json, a true pristine
# baseline no longer exists and cannot be reconstructed. So capture is cheap
# now and impossible later.

set -eu

CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
BASELINE_DIR="${UAT_BASELINE_DIR:-$HOME/.uat-baseline}"
SETTINGS="$CONFIG_DIR/settings.json"
BASELINE="$BASELINE_DIR/settings.json.pristine"

mkdir -p "$BASELINE_DIR"

if [ -e "$BASELINE" ]; then
  echo "[uat-baseline] baseline already captured at $BASELINE — refusing to overwrite"
  echo "[uat-baseline] (a second capture could record a core-contaminated file as pristine)"
  exit 0
fi

if [ -e "$SETTINGS" ]; then
  # Guard: if the file already carries our marker, core has touched it and this
  # is NOT pristine. Recording it would silently bake core's registrations into
  # the thing that is supposed to prove they were removed.
  if grep -q 'cortex:managed' "$SETTINGS" 2>/dev/null; then
    echo "[uat-baseline] REFUSING: $SETTINGS already contains cortex registrations."
    echo "[uat-baseline] A pristine baseline is no longer obtainable in this config dir."
    echo "[uat-baseline] Use a fresh config dir, or accept that reset cannot be independent here."
    exit 1
  fi
  cp "$SETTINGS" "$BASELINE"
  echo "[uat-baseline] captured existing settings.json -> $BASELINE"
else
  # No settings file yet is itself the pristine state, and it must be recorded
  # as such — otherwise "restore" would have nothing to restore and the reset
  # would leave whatever core last wrote.
  printf '' > "$BASELINE.absent"
  echo "[uat-baseline] no settings.json present — recorded 'absent' as the pristine state"
fi
