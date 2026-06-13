---
name: cortex-updating
description: "Pull the latest Cortex and how boot-time data migrations work"
audience: operator
---

# Updating

If you already have Cortex installed and want to pull the latest:

```bash
cd ~/cortex
git pull
npm install            # picks up any new deps
ckn-stop && ckn-start  # or `npm start` directly
```

On boot, Cortex runs any pending data migrations and logs each one. Migrations are idempotent and recorded in `~/.config/ckn/migrations.json`, so subsequent boots are no-ops. Migrations are additive — they don't break older state.

**If you don't run the server**, run the migrations standalone:

```bash
cd ~/cortex
npx tsx bin/ckn-backfill-md.ts
```

This pulls the same migration list and applies what's pending. Safe to run repeatedly.

**Current migrations:**

| ID | Effect |
|---|---|
| `0001-backfill-pattern-md` | Writes `.md` files for every auto-extracted pattern + concept node so the graph is rebuildable from disk. After this lands, `rm ~/.config/ckn/graph.sqlite && npm run sync` recovers your full graph. |
| `0002-typed-schema` | Adds typed edges (`RESOLVES`, `MENTIONS_FILE`, `CONTRADICTS`, …), the `Pattern` table, and new `Entry` columns. |
| `0003-session-table` | `Session` specialization node table for live-session metadata. |
| `0004-observation-table` | `Observation` node + `DERIVED_FROM` edges (auto-consolidated beliefs). |
| `0005-entry-pinned` | `pinned` flag column on `Entry`. |
| `0006-entry-machine` | `machine` lineage column on `Entry`. |
| `0007-code-graph-schema` | `Symbol` node + code-graph edges (`CALLS`/`IMPORTS`/`EXTENDS`/`IMPLEMENTS`/`REFERENCES`) + `ABOUT` for the AST/code-graph tier. See "Code graph" below. |
| `0008-session-bus` | Session bus: presence columns on the `Session` node (`friendly_name`, `cwd`, `machine`, `title`, `last_seen`, `status`, `supersedes`) + `BusMessage` node table. See "Session bus" above. |

If a migration fails, the failure is logged and the migration stays pending so the next boot retries cleanly. No partial-write state is recorded.


Related: [[cortex-running]] · [[cortex-configuration]]
