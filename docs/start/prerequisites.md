---
name: cortex-prerequisites
description: "What a machine needs before installing Cortex: Node 20+, build toolchain, git identity, SSH keys"
audience: user
---

# Prerequisites

Cortex pulls a native dependency (`node-pty`) that compiles from source on first install. Make sure your machine has the toolchain to build the native dep:

- **Node.js 20+** and npm (`node --version` to check). On a bare box, install via [nvm](https://github.com/nvm-sh/nvm): `nvm install --lts` (lands a current LTS). Distro packages (apt's `nodejs`) are often too old — prefer nvm, which is also what the worker launcher (`cortex-runner.sh`) sources.
- **Git** for cloning + the shared-mind feature
- **Git identity** (`git config --global user.name "…"` and `git config --global user.email "…"`) — required if you'll enable the **private-mind** sync, which commits and pushes on your behalf. Without it the first push fails with `fatal: ... Author identity unknown`. (Headless/worker boxes need this too — set it for the user the service runs as.)
- **C/C++ build toolchain + Python 3:**
  - Debian/Ubuntu: `sudo apt install build-essential python3 make g++`
  - Fedora/RHEL: `sudo dnf install gcc-c++ make python3`
  - Arch: `sudo pacman -S base-devel python`
  - macOS: `xcode-select --install`
  - Windows (WSL2): use the Linux instructions for your distro
- **SSH key registered on GitHub** (`ssh-keygen -t ed25519` + paste the public key into GitHub → Settings → SSH and GPG keys), or fall back to HTTPS by swapping the clone URL to `https://github.com/cz-zwtech/cortex.git` and ensuring you have an HTTPS credential helper configured.
  - **Trust the host key first** on a fresh box, or the clone fails with `Host key verification failed` — a *trust* issue, not auth. Run `ssh -T git@github.com` once and accept the prompt, or `ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts`.
  - **If you use the secret-manager wrapper** ([openbao_wrapper](https://github.com/cz-zwtech/openbao_wrapper)), the *same* SSH key (or HTTPS credential) authorizes both the Cortex repo and the wrapper — both are hosted on GitHub.

If you skip the build toolchain you'll see `node-gyp rebuild` failures during `npm install` — that's the giveaway that the prereqs aren't met.


Related: [[cortex-install]] · [[cortex-secrets]]
