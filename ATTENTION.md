# Cortex V1 users: stop here

This checkout is now **Cortex V2**, a rewrite. V1's server, hooks and `ckn-*` scripts are gone from it, so V1 cannot run from these files.

If you got here by updating V1 (`ckn-update`, `/cortex-update` or `git pull`):

1. **Do not start V1 again.** Its service and hooks point at files that no longer exist.
2. **Back up** `~/.claude` and `~/.config/ckn` before anything else changes.
3. **Follow [docs/migrating-from-v1.md](docs/migrating-from-v1.md)** with Claude Code. It takes V1 out cleanly, installs V2, and checks every step. Read [docs/v1-features-in-v2.md](docs/v1-features-in-v2.md) first: some V1 features have no V2 equivalent.
4. **To go back to V1 instead:** `git checkout v1-final && npm ci`, then start V1 as you did before.

Installing V2 while V1 is still wired on this machine stops with this message. V1 is still wired while any of these is true: a `ckn-` hook in `~/.claude/settings.json` or `settings.local.json`, V1's `cortex.service` installed, or `~/.config/ckn/home` naming this checkout. The migration guide removes them. To install anyway, set `CORTEX_SKIP_V1_CHECK=1`.
