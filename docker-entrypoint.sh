#!/bin/sh
# Lab entrypoint.
#
# Starts sshd so a human can sign in to Claude Code interactively inside the
# container, then keeps the container alive.
#
# Key material is NEVER baked into the image: authorized_keys is mounted at
# runtime (read-only) and copied into place with the permissions sshd demands.
# This image is intended to become the public self-host artifact, so a
# committed key would ship to everyone who uses it.

set -eu

AUTH_SRC=/run/secrets/authorized_keys
AUTH_DIR=/home/node/.ssh

if [ -r "$AUTH_SRC" ]; then
  mkdir -p "$AUTH_DIR"
  cp "$AUTH_SRC" "$AUTH_DIR/authorized_keys"
  # sshd is strict about BOTH ownership and mode here, and it fails closed with
  # a bare "Permission denied (publickey)" that names neither. The copy runs as
  # root, so without the chown the file is root-owned and every login is
  # refused with no clue why.
  chown -R node:node "$AUTH_DIR"
  chmod 700 "$AUTH_DIR"
  chmod 600 "$AUTH_DIR/authorized_keys"
  echo "[lab] authorized_keys installed ($(wc -l < "$AUTH_DIR/authorized_keys") key(s))"
else
  echo "[lab] no authorized_keys mounted — SSH will refuse every login"
fi

# Host keys are generated on first boot and live on the state volume, so a
# rebuild does not change the container's identity and produce a
# host-key-changed warning on the next connection.
ssh-keygen -A >/dev/null 2>&1 || true

# Docker creates a named volume's mount point as ROOT, and the state dir is
# where Cortex writes cortex.sqlite, the journal and per-module data. Without
# this, everything running as `node` dies with SQLITE_CANTOPEN — which reads as
# a database problem and is a permissions one. This image already hit the same
# defect once with the node_modules volume; fixed here rather than by hand, or
# the next `compose up` quietly reintroduces it.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /home/node/.config/ckn
  chown -R node:node /home/node/.config

fi

if [ "$(id -u)" = "0" ]; then
  /usr/sbin/sshd -e
  echo "[lab] sshd listening on 22 (docker bridge only, no published port)"
else
  echo "[lab] not root — skipping sshd (dev shell mode)"
fi

# A long-lived tmux session so a signed-in Claude Code session survives a
# dropped SSH connection. Re-authenticating after every disconnect would be
# exactly the repeated ritual the UAT design is trying to avoid.
#
# ⚠ A TMUX SERVER FREEZES ITS ENVIRONMENT AT START, and this line is what starts
# it. Every pane the operator opens later inherits the environment as it was AT
# CONTAINER BOOT — not as it is in their shell. That cost a whole UAT run: an
# env var added to .bashrc afterwards was correctly set in an interactive shell,
# absent inside tmux, and Claude Code therefore read a different config
# directory than the one the harness surface had been installed into. Hooks and
# commands were both in the wrong place; only the commands failure was visible.
#
# So: NOTHING THE HARNESS DEPENDS ON MAY COME FROM THE SHELL ENVIRONMENT. Paths
# resolve from defaults or from the install itself. If a future change needs an
# env var here, it belongs in the Dockerfile as ENV — inherited by every process
# including this one — never in a profile script.
su - node -c 'tmux new-session -d -s uat 2>/dev/null' || true

echo "[lab] ready"
exec "$@"
