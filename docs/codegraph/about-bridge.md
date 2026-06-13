---
name: cortex-about-bridge
description: "File-knowledge recall: before an edit, the memories that mention that file are surfaced automatically"
audience: user
---

# File knowledge before you edit

When a session is about to edit a file in a repo you've ingested into the
[code graph](codegraph.md), Cortex surfaces **the memories you've kept that
mention that file** — right before the edit, as a short note (up to three
one-line bullets):

```
## Cortex · knowledge for server/graph/db.ts

Memories you have kept that mention this file — check before editing:
- **graph-write-concurrency** — the server owns the file; CLIs must be API-first…
```

This is recall delivered at the highest-value moment: the decision point before
a change, not after a failure. It's the sibling of the blast-radius note (which
shows code *dependents*); this one shows what *you know* about the file, and it
fires whether or not the file has dependents.

**How matching works.** Memory frontmatter records mentioned files in whatever
shape you wrote them — absolute paths, another machine's roots, repo-relative.
Cortex normalizes both sides and matches on path-segment suffix, so the same
file is recognized across machines and path styles. Bare filenames are *not*
matched (precision first: `db.ts` alone would match every `db.ts` everywhere).
A relative path that exists in two repos can cross-match — a known rough edge;
in practice code paths are specific enough.

**Behavior:** fires once per session per file; bounded (~2s) and quiet on any
miss or failure — it never blocks the edit; needs the server up and the repo in
the code graph. Off-switch: `CKN_FILE_KNOWLEDGE=off`.

Related: [[cortex-codegraph]] · [[cortex-recall]] · [[cortex-memory-pipeline]]
