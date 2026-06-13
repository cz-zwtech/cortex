---
name: cortex-extraction
description: "Two extraction paths: automatic with an API key, /cortex-snapshot on your subscription"
audience: user
---

# Memory extraction — two paths

Cortex captures session content as structured memories two different ways. **Pick the one that matches your auth situation; both produce the same kind of structured output.**

| What's captured | Path A: automatic (API key) | Path B: manual (no API key) |
|---|---|---|
| Real-time fail→success patterns | ✅ always — pure deterministic, no LLM | ✅ always — pure deterministic, no LLM |
| Local embeddings on every memory | ✅ always | ✅ always |
| Graph-augmented recall on errors | ✅ always | ✅ always |
| **Decisions / workflows / errors / references** as typed memories | ✅ automatic at SessionEnd | 🔧 you run `/cortex-snapshot` |
| Contradiction detection | ✅ on every extraction | ✅ on every extraction |
| PreCompact raw checkpoint | ✅ always | ✅ always |

### Path A — set `ANTHROPIC_API_KEY`

```bash
export ANTHROPIC_API_KEY="sk-ant-..."  # simplest; a secret manager is recommended instead
```

> **Recommended:** don't hardcode the key in a shell profile or `.env` — source it from a secret manager via `CKN_API_KEY_CMD` (see [Prerequisites → secret manager](../start/secrets.md) and the note below).

When set, `bin/ckn-extract.ts` fires automatically on SessionEnd, calls Haiku via the Anthropic SDK directly, and writes structured memories without your involvement. Cost: ~$0.005 per session at Haiku rates. The API key is **separate** from your claude.ai subscription — you'd be billed via [console.anthropic.com](https://console.anthropic.com).

You don't need this if you're already careful to `/cortex-snapshot`. It's the "set and forget" tier.

**Keeping the key out of files (secret manager).** Rather than exporting it into a shell profile, point `CKN_API_KEY_CMD` at a command that prints the key — e.g. for [OpenBao](https://openbao.org): `CKN_API_KEY_CMD='secret-run ANTHROPIC_API_KEY -- printenv ANTHROPIC_API_KEY'`. When `ANTHROPIC_API_KEY` isn't already in env, `ckn-extract` runs that command at SessionEnd, captures the key from stdout, uses it for the one Haiku call, and it's gone when the process exits — never written to a file or surfaced in a session. **It degrades gracefully:** if the command fails or the key isn't there (vault down, key absent, timeout), extraction simply no-ops as if no key were set — same behavior as an unset env var, never an error. Since a vault's path is dynamic and user-specific, this is something you set at setup; Cortex never assumes it.

### Path B — `/cortex-snapshot` before exiting (with auto-prompt safety net)

If you don't want a separate API key, use the `/cortex-snapshot` slash command (auto-installed at `~/.claude/commands/cortex-snapshot.md`). The active Claude in your session reads the conversation, identifies what's worth remembering, and writes the same structured memory files — using your existing claude.ai authentication.

**Auto-prompt safety net:** a UserPromptSubmit hook periodically reminds Claude to run `/cortex-snapshot` so you don't have to remember. It fires at a turn boundary (when you submit your next message) rather than mid-tool-chain, so it never interrupts a sequence of edits. Default cadence: every 25 turns AND ≥10 minutes since the last snapshot for this session. The PostToolUse hook only bumps the turn counter; emission happens at the pause. Worst-case context loss if you close your terminal abruptly: ~25 turns ≈ 5-10 minutes of work.

**Practical workflow:**
- Just work. The auto-prompt fires every ~25 turns and Claude handles `/cortex-snapshot` in the background of the conversation
- Mid-session manual capture: type `/cortex-snapshot` if you want to force a capture immediately (e.g., after a particularly important decision)
- Before exit: optionally type `/cortex-snapshot` for one final capture if your last activity was very recent

**Configuration**:
- `CKN_AUTO_SNAPSHOT=off` — disable the periodic prompt entirely
- `CKN_SNAPSHOT_AT=25` — turns between fires (set to 0 to disable, like `=off`)
- `CKN_SNAPSHOT_MIN_INTERVAL=600` — minimum seconds between fires (prevents bursty sessions from triggering 4 snapshots in 30 seconds)

`/cortex-snapshot` produces the same kind of structured memory files as the automatic path — typed by kind (decision/workflow/error/reference/topic), with verbatim outcome anchoring, mentions_files / mentions_tools, contradiction edges. The difference is **who triggers it**, not what it produces.

### Why both paths exist

The pipeline that classifies and writes memories is the same. The only thing that varies is who calls Claude:
- **Path A**: `ckn-extract.ts` calls Anthropic's API directly (needs API key) — automatic at SessionEnd.
- **Path B**: `/cortex-snapshot` makes the active Claude do it (uses your claude.ai subscription) — in-session, when you (or the auto-prompt) run it.

**Why there's no automatic-on-subscription path:** any *headless/programmatic* invocation — `claude -p`, the Agent SDK, a subprocess from `ckn-extract.ts` — bills as **API usage**, not against your subscription/OAuth. Only the *interactive* session draws on the subscription, which is exactly why Path B runs in-band (the active Claude does the work) rather than as a background hook. So automatic extraction inherently requires an API key; subscription-only users use `/cortex-snapshot`. This is a billing constraint, not a missing feature. Everything else at SessionEnd (raw PreCompact checkpoints, fail→success patterns, embeddings, recall, session naming) is LLM-free and runs regardless — only the LLM *categorization* is gated, and `/cortex-snapshot` backfills it.


Related: [[cortex-memory-pipeline]] · [[cortex-secrets]] · [[cortex-recall]]
