---
name: cortex-embeddings
description: "Semantic recall via local embeddings: modes, the worker thread, graceful degradation"
audience: user
---

# Embeddings (semantic recall)

Cortex augments keyword recall with vector similarity by default. Memories that match a query *semantically* — same meaning, different words — surface alongside literal matches.

**Three modes** via the `CKN_EMBEDDINGS` env var:

| Mode | Behavior | When to use |
|---|---|---|
| `local` (default) | `bge-small-en-v1.5` via `@huggingface/transformers`. Model is downloaded to `~/.cache/huggingface/` on first use (~33 MB), ~150 MB RAM resident, ~10 ms per embedding warm. | Workstations, dev boxes, home servers |
| `remote` | Reserved value — not implemented today; selecting it degrades to `off`. | — |
| `off` | Substring search only. Recall still works; semantic ranking is disabled. | Tiny VPSs, Alpine, air-gapped boxes, the model-failed-to-load case |

**Runs in a worker thread.** Model load (~800 ms cold) and inference run in a dedicated worker (`server/embeddingWorker.mjs`), never on the server's event loop. This matters under load: `/api/recall` embeds a query on every tool error across every live session, and doing that on the main thread used to wedge the server (the loop stopped accepting connections). With the worker, the event loop only does message-passing and stays responsive no matter the embedding volume — so `local` is safe even with many concurrent sessions / worker-mode. A bounded mailbox (`CKN_EMBED_MAX_QUEUE`, default 6) sheds excess in-flight requests to keep backlog bounded; the model is warmed at boot so the first recall isn't cold.

**First boot / fresh clone — background backfill.** Adopting a private mind (or any first boot with a populated memory dir) needs one embedding per memory. That work runs in the **background after the graph is already up**: the boot re-index upserts every memory under the graph lock (fast), then embeds them *outside* the lock in bounded-parallel batches — so the graph and bus are usable immediately instead of frozen while the whole corpus embeds. A large corpus still takes a couple of minutes to finish embedding; recall is keyword-only for not-yet-embedded memories and upgrades to semantic as the backfill lands. If the model download is slow on a brand-new machine and you want the server up instantly, set `CKN_EMBEDDINGS=off` for the first boot and switch back to `local` later — anything left unembedded is picked up on the next sync (the fast-path only skips a memory once it actually has a vector, so nothing is stranded unembedded).

**Graceful degradation:** if `local` is selected but the model/worker fails to load (missing native bindings, no network on first run, unsupported platform), Cortex logs a one-line warning and continues in `off` mode. Nothing else breaks.

**Storage:** embeddings live in a sidecar at `~/.config/ckn/embeddings/` (manifest.json + vectors.bin) — outside the SQLite database so it stays portable. Brute-force cosine handles up to ~10K entries in <5 ms; beyond that is a known limit.

To force a mode:
```bash
export CKN_EMBEDDINGS=off    # then ckn-stop && ckn-start
```

The mode is decided once at server boot and cached for the process lifetime.


Related: [[cortex-memory-pipeline]] · [[cortex-recall]] · [[cortex-configuration]]
