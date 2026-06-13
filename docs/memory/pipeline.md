---
name: cortex-memory-pipeline
description: "How sessions become structured memory: patterns, extraction, recall — and the rebuildability invariant"
audience: user
---

# Memory pipeline (how it actually works)

Cortex captures every Claude Code session as structured memory in three stages:

1. **Real-time pattern extraction.** The watcher reads JSONL transcripts as they grow. `extractPatterns()` finds `tool_use(error) → tool_use(success)` pairs of the same tool within a 10-minute window. Each becomes a `pattern-<fingerprint>.md` file plus a row in the Pattern table. Fingerprint dedup collapses semantically equivalent patterns across sessions.

2. **SessionEnd LLM extraction.** When a session ends, `bin/ckn-extract.ts` calls Haiku via the Anthropic SDK directly (needs `ANTHROPIC_API_KEY` in env). The LLM **categorizes** events into typed memories — decisions, workflows, errors, references, topics — and points at `[tag]` anchors in a compact transcript view. **Verbatim-anchored**: deterministic JS code copies the actual outcome text, error strings, and tool args from the JSONL by tag lookup. The LLM never invents data.

3. **Graph-augmented recall.** When you (or Claude in your session) hit a tool error, the PostToolUse hook runs graph-augmented retrieval: vector seeds (bge-small embedding cosine top-K) → 1-hop traversal across typed edges (`:RESOLVES`, `:MENTIONS_FILE`, `:MENTIONS_TOOL`, `:OCCURRED_IN`, `:CONTRADICTS`, `:EVOLVED_INTO`) → composite scoring (`0.55×cosine + 0.20×usage_score + 0.10×recency + edge_bonus − hop_penalty`). Returns hits with full provenance — `signals` field exposes why each ranked where it did.


**Contradiction detection.** When extraction produces a memory whose outcome opposes a prior memory with shared file/tool context, a `CONTRADICTS` typed edge auto-materializes. Cortex never auto-picks a winner; reviewing them is yours today (a known rough edge — they surface in the Graph view).

**Usage signals.** Every memory the recall pipeline returns gets logged at `~/.config/ckn/usage-scores.json`. Repeated surfaces accumulate a small ranking bonus (log-saturated, no time decay). Cold-start fairness preserved — new memories rank by cosine alone until they prove useful.

**Rebuildability invariant.** Every node in the graph maps to a `.md` file on disk. Delete `~/.config/ckn/graph.sqlite`, run `npm run sync`, recover the full graph including auto-extracted patterns, concepts, and replayed vault imports.


Related: [[cortex-recall]] · [[cortex-extraction]] · [[cortex-embeddings]]
