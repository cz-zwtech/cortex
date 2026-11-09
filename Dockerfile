# Cortex V2 lab image.
#
# This is a V2 deliverable in its own right, not scaffolding: the same image is
# intended to become the self-host artifact. It must therefore stay honest —
# nothing here may depend on the host's Cortex install, config, or identity.
#
# Isolation is the whole point. The container IS its own machine: its own
# graph volume, its own node identity, its own $HOME. That is what makes a
# module install/verify/teardown cycle mean anything.

FROM node:22-bookworm-slim

# better-sqlite3 and node-pty compile from source. python3/make/g++ are build
# inputs only; git is needed at runtime by the codegraph/provenance paths.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ git ca-certificates curl jq \
      openssh-server tmux \
 && rm -rf /var/lib/apt/lists/*

# SSH access exists so a human can sign in to Claude Code interactively INSIDE
# the lab (OAuth requires a real interactive sign-in). It is reachable only
# across the docker bridge, which is host-local and not LAN-routable, and no
# SSH port is published — the loopback-only posture of this lab is deliberate,
# and it matters more than usual while we are simultaneously fixing V1's
# 0.0.0.0-bind exposure.
#
# Key-based only. No password is set, no password auth is permitted, and no key
# is baked into the image — authorized_keys is mounted at runtime, because this
# image is intended to become the public self-host artifact and a committed key
# would ship with it.
RUN mkdir -p /run/sshd \
 && sed -i \
      -e 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' \
      -e 's/^#\?PermitRootLogin.*/PermitRootLogin no/' \
      -e 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' \
      -e 's/^#\?KbdInteractiveAuthentication.*/KbdInteractiveAuthentication no/' \
      /etc/ssh/sshd_config \
 && printf 'AllowUsers node\n' >> /etc/ssh/sshd_config

# Run as a non-root user with a real $HOME. Cortex writes to ~/.config/ckn and
# ~/.claude; both must resolve INSIDE the container so a boot can never reach
# the host's canonical install or rewrite its hook registration.
#
# The node image already ships a `node` user at uid/gid 1000, which is exactly
# the uid we want (it matches the host account that owns the bind-mounted
# worktree, so writes through the mount land with sane ownership). Reuse it
# rather than creating a second user at the same uid.
#
# Deliberately NOT masking failures here with `|| true`: an earlier revision
# did, and it turned "user already exists" into a silent no-op that only
# surfaced at `docker run` as an unfindable-user error. If an assumption below
# stops holding, the build should fail loudly at that line.
RUN test "$(id -u node)" = "1000" && test "$(id -g node)" = "1000"

COPY docker-entrypoint.sh /usr/local/bin/lab-entrypoint
RUN chmod +x /usr/local/bin/lab-entrypoint

WORKDIR /opt/cortex

# node_modules must EXIST in the image, owned by node, before compose mounts a
# named volume over it. Docker seeds an empty named volume from whatever is at
# that path in the image — including ownership. If the directory is absent the
# daemon creates the mount point as root:root and every npm install inside the
# container fails with an unexplained EACCES.
RUN mkdir -p /opt/cortex/node_modules && chown -R node:node /opt/cortex

# NOTE: this image intentionally stays root at runtime so the entrypoint can
# start sshd; the entrypoint drops to `node` for everything user-facing, and
# sshd itself permits only `node` (PermitRootLogin no). A human signing in
# lands as an unprivileged user with a real home, which is what makes the UAT's
# assertions about ~/.claude behaviour representative of a real install.
ENV HOME=/home/node

# Persisted state lives on a named volume mounted at ~/.config/ckn (see
# compose). Declared here so a bare `docker run` without compose still gets
# an isolated location rather than silently writing into the image layer.
VOLUME ["/home/node/.config/ckn"]

EXPOSE 3011 1430

# No CMD baked in yet: the V2 line is empty by design (greenfield), so the
# image currently provides the ENVIRONMENT a foundation gets built and
# iterated in. A CMD lands with the Phase 2 foundation, at which point this
# file stops being a dev shell and becomes the self-host artifact.
ENTRYPOINT ["/usr/local/bin/lab-entrypoint"]
CMD ["sleep", "infinity"]
