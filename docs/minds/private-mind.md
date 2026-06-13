---
name: cortex-private-mind
description: "Your whole memory synced across your own machines — one mind, many machines"
audience: user
---

# Private-mind (your singular mind across your machines)

**Different from shared-mind.** Shared-mind is *selective + public + team-facing*: you hand-pick a memory (a tool setup, a statusline) to publish, and a teammate's Cortex imports it quarantined under `shared:<name>`. Private-mind is *everything + private + yours*: your whole memory corpus synced across **your own** machines, in native scope, bidirectionally. One mind, many machines.

**Opt-in, disabled by default.** Active only once a clone + remote are configured; `CKN_PRIVATE_MIND=off` hard-disables it regardless.

```bash
# Enable once per machine (clones the repo + configures origin, then syncs):
ckn-mind-sync --remote git@github.com:<you>/private-cortex.git
ckn-mind-sync            # bidirectional sync now (pulls + pushes)
ckn-mind-sync --status   # show enabled state + remote
```

`ckn-mind-sync` is installed by `npm run install-aliases`. If you haven't run
that yet, invoke it directly from the repo: `npx tsx bin/ckn-mind-sync.ts --remote <url>`.

**Bringing up a new machine (e.g. a laptop):** install Cortex normally, then run
`ckn-mind-sync --remote <your-private-cortex-url>` once. That clones the whole
private repo and **adopts your entire mind** (memories re-index into the laptop's
own SQLite graph; the codegraph/AST tier replays too), then pushes anything the
laptop already had. From then on it's just another machine in the mesh — search
"tool use: SSH" on the laptop and you get the memory your desktop wrote.

**Boot sync is pull-only by default.** When private-mind is enabled, the server
runs a sync at startup — but as of the pull-only-boot change it only **pulls +
adopts** remote changes; it does **not** push local commits. A restart can no
longer silently federate whatever happens to be committed locally. To push:
- run `ckn-mind-sync` explicitly (the CLI and the `/api/mind/sync` route both
  push by default), or
- set `CKN_MIND_PUSH_ON_BOOT=1` in the server env to opt the boot sync back into
  pushing.

This means a fresh laptop gets the mind on every boot automatically, while
publishing your local changes stays an explicit act.

**How reconcile works (the safe part):**
- 3-way merge against a **per-machine local baseline** (`~/.config/ckn/private-mind.state.json`) — *not* the shared manifest, so a freshly-cloned machine adopts files instead of mistaking "never pulled" for "deleted."
- **Keep-both conflicts:** if the same memory changed on two machines, the syncing machine keeps its version canonical and preserves the other as a `<name>.conflict-<machine>-<hash>.md` memory — never silent loss.
- **Tombstoned deletes:** deletions propagate via the shared manifest; an edit-after-delete resurrects (no content loss).
- **`visibility: local`** frontmatter keeps a memory on the machine — it never leaves.
- **Dedup detection (non-destructive):** near-duplicate memories (cosine ≥ 0.92) are reported, never auto-merged.

**What federates vs what stays local.** Private-mind merges **all** your memory `.md` files into one corpus, so every machine ends up holding the same mind — that's the whole point ("one mind, many machines"). The human-profile rides along too, as the `profile.json` snapshot. The **only** per-file exclusion today is `visibility: local` frontmatter (enforced in `server/privateMind.ts`): a memory tagged that way is never written to the private repo and never leaves the machine that authored it. Everything else federates.

The repo holds `memory/<scope>/*.md` + `.cortex/manifest.json` (hashes, tombstones, machine registry).


Related: [[cortex-team-mind]] · [[cortex-mesh]] · [[cortex-profile]]
