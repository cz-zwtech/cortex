---
name: cortex-secrets
description: "Recommended secret-manager posture: keep the API key and mesh token out of files via a launcher wrapper"
audience: user
---


Cortex runs fine with a key exported in your shell profile, but the **recommended** posture — especially once you go multi-machine or headless — is to keep secrets in a **secret manager** and hand them to Cortex through a thin launcher wrapper, rather than pasting them into `.env`, a dotfile, or a systemd unit. Nothing sensitive then lives in a committed file, a shell profile, or a session transcript.

Two kinds of secret come up:

- **The Anthropic API key** (Path A extraction) — instead of `export ANTHROPIC_API_KEY=…` in `~/.bashrc`, point **`CKN_API_KEY_CMD`** at a command that prints the key on stdout. Cortex fetches it transiently only when a hook needs it, uses it for the one call, and never writes it down; it degrades gracefully if the manager is unavailable.
- **The mesh token + git-remote credentials** (multi-machine / private-mind / mesh) — the fleet bearer token (**`CKN_MESH_TOKEN`**) and private-repo access are best pulled at the launcher, never baked into an env file or unit.

The pattern is a small wrapper that authenticates to your manager, pulls the named keys, and `exec`s the child with them in env — e.g. a `secret-run KEY1 KEY2 -- <start-cortex>` launcher backed by **[OpenBao](https://openbao.org)** (or HashiCorp Vault, 1Password CLI, `pass`, your cloud's secret store, …). Cortex ships a generic, adaptable reference template at **`examples/secret-run.sh`** that you can copy and wire to your own manager — and a concrete OpenBao implementation lives at [openbao_wrapper](https://github.com/cz-zwtech/openbao_wrapper) (install it per its README — it ships `bao-run`). For a systemd worker unit, wrap `ExecStart` the same way.

This is **optional** — a plain exported key works for a single trusted workstation — but it's the right default beyond that, and it's *why* the relevant settings (`CKN_API_KEY_CMD`, `CKN_MESH_TOKEN`) are commands / launcher-fetched rather than file-stored values. Details: the [environment-variable table](../operate/configuration.md) and the secret-manager note under [Memory extraction](../memory/extraction.md).


Related: [[cortex-prerequisites]] · [[cortex-extraction]] · [[cortex-mesh]]
