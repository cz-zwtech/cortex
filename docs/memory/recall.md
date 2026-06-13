---
name: cortex-recall
description: "Beyond raw recall: observations, temporal queries, pinned models, operating identity"
audience: user
---

# Capabilities beyond raw recall

These layers sit on top of the memory pipeline. All are on by default except private-mind (opt-in).

**Observations (auto-consolidated beliefs).** `bin/ckn-derive.ts` (or `POST /api/derive`) clusters semantically-similar memories (cosine ≥ 0.7, ≥3 members) into `Observation` nodes with `DERIVED_FROM` edges to their sources and a `trend` (stable / strengthening / weakening / stale). SessionStart surfaces the top-5 in the capability sheet, so Claude sees *what the graph believes about you* without scanning every memory. Set `CKN_DERIVE_ON_STOP=1` to refresh them after each session. Pattern-kind entries are excluded (they have their own recall path).

**Temporal recall.** `POST /api/recall` accepts `since` / `until` (ISO) or `since_relative` (`"7d"`, `"24h"`, `"2w"`). When a time bound is set, scoring shifts weight from cosine toward recency — "what was I working on last week" becomes a first-class query.

**Pinned mental models.** Frontmatter `pinned: true` on any memory (or observation) gives it a flat +0.3 recall boost and overrides stale-trend handling. For load-bearing facts you always want surfaced.

**Operating identity.** Optional `~/.config/ckn/identity.yaml` (+ per-project `<project>/.claude/identity.yaml`) with `mission` / `directives` / `disposition` renders an "Operating identity" block at the top of the capability sheet — who Claude is *being* in your context, not just what tools it has.

**Memory lineage.** Every memory carries a `machine:` frontmatter field (stamped by `ckn-extract` on creation; the graph's `Entry.machine` column mirrors it). Adopted memories keep their origin machine verbatim across a sync, so you can always see which machine authored a fact. Backfill existing memories with `ckn-stamp-lineage` (writes the local machine into files lacking the tag).

**Private-mind (cross-machine, opt-in).** Sync your *whole* mind across your *own* machines via a private git repo — distinct from shared-mind (that's selective/public/team-facing). Bidirectional, native-scope, with 3-way reconcile, tombstoned deletes, keep-both conflicts, and `visibility: local` exclusion. Disabled by default. See "Private-mind" below.


Related: [[cortex-memory-pipeline]] · [[cortex-embeddings]] · [[cortex-profile]]
