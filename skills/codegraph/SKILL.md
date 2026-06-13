---
name: codegraph
description: Build and query the Cortex AST code graph. Ingest — add or refresh a repo's graph with `/codegraph add <path>` (or `ckn-codegraph <path>`). Query — who depends on a symbol, a file's blast-radius, what a symbol depends on, branch-scoped. Use when planning a change, scoping QA, researching unfamiliar code, or debugging a regression, in any repo that's in the graph. The PreToolUse hook already auto-injects blast-radius before edits; use these verbs for the non-edit cases.
---

# Cortex code graph

The Cortex server (`http://localhost:3001`) holds an AST graph of the user's
repos: `Symbol` nodes (functions/classes/etc.) + CALLS/IMPORTS/EXTENDS/
IMPLEMENTS/REFERENCES edges, provenance-stamped per machine + git branch +
commit. Lean on it instead of grepping when the question is "what depends on
this" / "what's the impact" / "where is this used".

## Add a repo to the graph (ingest)

Build or refresh the AST graph for a repo the user works on. The extractor is
**bundled with Cortex** — no separate install. Requires the Cortex server
running (`ckn-start`).

**`/codegraph add <path>`** (or the user runs the one-liner directly): resolve
`<path>` — default to the current directory if none was given — and run:

```bash
ckn-codegraph <path>        # e.g. ckn-codegraph ~/repos/merit
```

It auto-derives the repo name (the repo's git-remote basename, else the
directory name) and extracts `.ts/.tsx/.js/.jsx/.mjs/.cjs` + `.py`
(`node_modules/.next/dist/build` are skipped), then upserts into the graph.
Report the symbol/edge counts it prints — the repo is then queryable below.

Override the derived name or languages when needed:

```bash
ckn-codegraph <path> --repo <name> --langs ts,py
```

Re-running re-extracts and marks vanished symbols stale without dropping earned
lifecycle (centrality, stickiness). After ingesting, confirm freshness with the
`/api/graph/heads` verb below.

## Query verbs (Bash + curl)

All reads are branch-scoped: pass the branch you're working on; results overlay
your branch on top of the repo's base branch, so a fresh feature branch still
sees the base graph. An unspecified branch falls back to the repo base branch.

**Blast-radius of a file (the most useful one):** symbols defined in given
repo-relative paths + their cross-file dependents.
```bash
curl -s localhost:3001/api/graph/symbols/blast \
  -H 'content-type: application/json' \
  -d '{"repo":"<repo>","paths":["src/foo.ts"],"branch":"<your-branch>","baseBranch":"main"}' | jq
```

**Dependents / dependencies of one symbol:** (id is `<machine>@<branch>::<repo>:<file>#<name>`; get ids from blast or `/symbols`).
```bash
curl -s "localhost:3001/api/graph/symbols/<url-encoded-id>/dependents" | jq
```

**List / search symbols in a repo:**
```bash
curl -s "localhost:3001/api/graph/symbols?repo=<repo>&branch=<branch>&limit=50" | jq '.symbols[].name'
```

**Is the graph fresh for my branch?** (commit it was built at vs your HEAD)
```bash
curl -s "localhost:3001/api/graph/heads?repo=<repo>" | jq
```

**Which repos/branches/machines are graphed?**
```bash
curl -s localhost:3001/api/graph/symbols/views | jq
```

**Branch-diff — competing changes between two branches** (predict merge conflicts
at symbol granularity, BEFORE a text-level conflict). `competing` = natural ids
touched on BOTH branches vs the common base; also `added`/`removed`/`changed`.
```bash
curl -s "localhost:3001/api/graph/symbols/branch-diff?repo=<repo>&a=<branchA>&b=<branchB>" | jq
```
Or the CLI / slash command (competing-first render): `ckn-graph-diff <repo|path> <a> <b>`
/ `/cortex-codegraph-diff <repo|path> <a> <b>`. Pass `--base <b>` to override the common base.

Branch reads overlay the **N-level** ancestry chain (epic → feature → main),
walked from each branch's recorded base — so querying an epic branch inherits its
feature branch's graph, which inherits main's.

## When to use
- **Ingest:** when the user wants AST/impact analysis on a repo that isn't in the graph yet, or after big changes — `/codegraph add <path>`.
- **Planning:** before proposing a change, blast the files you'll touch — know the call sites you'll affect.
- **QA scoping:** map a change's blast-radius to the tests/behaviors that could break.
- **Research:** in unfamiliar code, dependents/dependencies beat grep for "who actually calls this".
- **Debugging a regression:** trace the dependency chain from the symptom symbol.

If the server is down or the repo isn't graphed, fall back to grep/read — the graph is an accelerator, not a dependency.
