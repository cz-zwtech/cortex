---
name: cortex-codegraph
description: "The AST symbol graph: ingest, blast-radius, branch-diff, the Code view"
audience: user
---

# Code graph (AST / symbols)

Beyond memories, Cortex can hold a **symbol graph** of your codebases — functions,
classes, methods, modules, interfaces — and the edges between them
(`CALLS` / `IMPORTS` / `EXTENDS` / `IMPLEMENTS` / `REFERENCES`). It lives in the
same SQLite graph (migration `0007`) as a separate `Symbol` node type, so blast-radius
("who calls/imports this?") becomes a first-class query alongside memory recall.

**Ingest.** The AST extractor (ts-morph for TypeScript/JavaScript, tree-sitter
for Python) is **bundled with Cortex** (`server/codegraph`) — no separate
install, nothing to clone. Build or refresh a repo's graph with the one-liner —
it auto-derives the repo name from the repo's git remote (or its directory name)
and extracts `.ts/.tsx/.js/.jsx/.mjs/.cjs` + `.py`, skipping
`node_modules/.next/dist/build`:

```bash
ckn-codegraph <path>        # e.g. ckn-codegraph ~/repos/merit  (defaults to .)
# override the derived name / languages:
ckn-codegraph <path> --repo <name> --langs ts,py
```

From a Claude session, `/codegraph add <path>` does the same. Ingest is API-only
— the server is the single graph writer — so the Cortex server must be running
(`ckn-start`). Re-running re-extracts and marks vanished symbols stale.

`reExtractedRepos` makes the upsert delta-aware: symbols that vanished from the
snapshot are marked stale (`groundTruthValid:false`), not blindly deleted, so
earned lifecycle (centrality, stickiness) is preserved across re-extracts.

**Sync on completion (after a change lands).** Cortex exposes a cheap re-ingest
primitive — `ckn-codegraph --on-complete <path>` — that a *consumer* calls when a
change lands (cars/roads: Cortex provides the road, the consumer drives). It only
re-ingests if the repo's current branch is **core**; an **ephemeral** branch
no-ops (so completion-sync doesn't spam churny branches):

```bash
ckn-codegraph --on-complete <path>          # re-ingest iff the branch is core
ckn-codegraph --on-complete --force <path>  # re-ingest regardless of class
```

Branch class is decided by `classifyBranch` against `CKN_CODEGRAPH_CORE_BRANCHES`
(comma-separated glob list; default `main,master,develop,release/*,feature/*,integration/*`).
Everything else (`epic/*`, `wip/*`, ad-hoc) is ephemeral. On-query freshness
(`ckn-blast`) still refreshes *any* branch; this is purely the completion trigger.

Callers: the swarm finalize/reconciliation step calls it on the feature branch
when an epic merges up; humans can wire an **opt-in** git hook (Cortex installs
none automatically — no surprise hooks). To wire one by hand, drop this in your
repo's `.git/hooks/post-commit` (and/or `post-merge`) and `chmod +x` it:

```sh
#!/bin/sh
ckn-codegraph --on-complete "$(git rev-parse --show-toplevel)" >/dev/null 2>&1 &
```

It runs in the background and no-ops on ephemeral branches, so it's safe on every
commit. The manual `/codegraph add` re-run remains the always-available path.

**Branch-diff (competing-change prediction).** Compare two branches' symbol sets
and predict merge conflicts *at symbol granularity*, before a text-level conflict:

```bash
ckn-graph-diff <repo|path> <branchA> <branchB>   # competing changes first
ckn-graph-diff . epic/x feature/y --base main    # explicit common base
```

`/cortex-codegraph-diff <repo|path> <a> <b>` does the same from a session. The headline
is **competing** — natural ids touched (added or changed vs the common base) on
BOTH branches (it catches "both branches edited `Foo.bar`" that a line diff only
surfaces at merge time) — then `added` / `removed` / `changed`. Endpoint:
`GET /api/graph/symbols/branch-diff?repo=&a=&b=&base=`. Branch reads overlay the
**N-level** ancestry chain (epic → feature → main), walked from each branch's
recorded base, so an epic branch inherits its feature branch's graph.

**Code view.** A dedicated nav surface (and a symbol overlay in the Graph view):
browse symbols grouped by repo, search by name/file/kind, and a **dependency
filter** — `linked` / `depended-on` / `depends-on` / `isolated` — to sweep for
symbols that actually participate in the graph. Selecting a symbol shows its
signature, lifecycle, and live blast-radius (`GET /api/graph/symbols/<id>/dependents`).

**Forget a repo.** A repo's whole symbol subgraph can be removed — per-repo
**Forget** action in the Code view, or `POST /api/graph/symbols/forget {repo}`.
Locally it deletes the repo's symbols and their edges; when private-mind is enabled it
also deletes **and tombstones** the federated `codegraph/<repo>/graph.json` so the
removal propagates to your other machines and doesn't resurrect on the next sync.
Re-extracting the repo revives it (the tombstone is cleared on re-persist).

**Federation.** When private-mind is on, each ingest persists a regenerable
`codegraph/<repo>/graph.json` snapshot into the private repo; a machine that pulls
the mind but lacks the source repo still gets the AST graph (the snapshot replays
into its SQLite graph on sync). Maintenance: `POST /api/graph/prune-orphans` removes
orphaned empty stub nodes (set-based, fast).


Related: [[cortex-about-bridge]] · [[cortex-memory-pipeline]] · [[cortex-configuration]]
