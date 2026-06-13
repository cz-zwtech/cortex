#!/usr/bin/env bash
# cortex-runner.sh — node-version-agnostic launcher for the systemd user unit.
#
# The systemd unit calls this wrapper instead of pinning the nvm node
# path. Sources nvm to pick up whatever node version is currently active
# under the user, then execs `npm start`. nvm install / nvm alias default
# changes don't break the unit.
#
# Used by `bin/ckn-install-worker.ts` when generating the systemd unit.
# Safe to run standalone for debugging too.
set -euo pipefail

# nvm is sourced from $NVM_DIR — default to ~/.nvm. Don't fail loudly if
# it's missing; some environments use system node.
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
fi

# Pick up user-local bin path too (where `claude` CLI usually lives).
export PATH="$HOME/.local/bin:$PATH"

# Cortex repo root — the unit sets WorkingDirectory but be defensive in
# case someone invokes the wrapper from elsewhere.
cd "$(dirname "$(readlink -f "$0")")/.."

# CKN_MESH_TOKEN (the fleet bearer gating /api/mesh/*) lives in OpenBao; the
# `bao-run KEY -- cmd...` wrapper injects it into the child env and execs the
# command. The non-secret mesh config (CKN_MESH_PEERS / CKN_MESH_GOSSIP_MS /
# CKN_MESH_ZOMBIE_MS) is set in the unit's own env. When bao-run is unavailable
# (or the token is absent) the server still starts — the mesh tier is
# fail-closed, so it stays off and the bus runs local-only.
if command -v bao-run >/dev/null 2>&1; then
  exec bao-run CKN_MESH_TOKEN -- npm start
else
  exec npm start
fi
