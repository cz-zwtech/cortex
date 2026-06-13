# Cortex — Home / Landing Design Brief

## What Cortex is

A solo-developer tool for managing Claude Code: live session monitoring, config management across project scopes, and a knowledge graph built from memory files. Three functional views already exist (Config, Knowledge, Graph, Sessions) styled in a deliberate CRT/cyberpunk aesthetic — purple/teal phosphor on near-black, scanlines, vignette, JetBrains Mono + VT323.

The aesthetic is locked. This brief is **only** about a new landing page that sits above those views.

## The ask

Design a **home view** that loads first when the app opens and a refined **header / title bar** that sits across the top of every view.

The home view replaces a default jump into one of the four functional views. It's the orientation moment — the user sees Cortex and decides where to go.

## Who's looking at this

One person. Returns to the tool many times a day. Knows the tool. Doesn't need onboarding, marketing copy, or feature explanations. Wants to know, in a glance: **what's happening right now, and where do I need to be?**

## What home must answer in ≤5 seconds

1. Is any Claude Code session live right now?
2. Did anything land in the knowledge graph today?
3. Is there anything that needs my attention?

If the answer to all three is "no, quiet day," that's also a valid state and should feel intentional, not empty.

## What home must NOT do

- Don't recreate Sessions, Knowledge, Graph, or Config views. It's a launchpad, not a fifth tool.
- Don't introduce new color tokens, fonts, or animation primitives. Use what's in `styles.css`.
- Don't add new persistent UI state beyond view selection.
- Don't propose stats that require new server endpoints — see "Data available" below.
- Don't onboard or explain. The user knows what Cortex is.

## Header / title bar

Currently a thin strip at the top with `◈ CORTEX | cortex :: <view> — <path> | graph ● vault ● claude-opus-4.7`. It works but feels sparse and reads like a status line, not a header. The home view is a natural moment to refine it.

The header is **shared across all views**, not just home. Whatever you design for it must:
- Stay thin (≤32px ideal — vertical space is precious in the dense views below)
- Convey active state (which view, current scope, key health indicators)
- Survive both IconRail states (collapsed 64px, expanded 128px)
- Not duplicate what the StatusBar at the bottom already shows (view name, scope, ⌘1-4 hints)

## Data available

Anything in this list is fetchable today via existing client adapters / store fields. **If your design wants something not listed, flag it as a follow-up, not part of this spec.**

**Sessions** (`/api/sessions/list`)
- Per-session: title (custom or AI-set), project dir, model id, turn count, token count, file size, last-write timestamp, live state (`live` < 60s / `stale` < 120s / `idle` < 300s / `ancient` ≥ 12h)
- WS feed: live append events, state-tier transitions

**Graph** (`/api/graph/*`)
- Total node + edge counts
- Last-sync timestamp + previous-sync timestamp
- Recent entries sorted by sync time (name, kind, scope, syncedAt, updatedAt)
- Per-scope and per-kind entry counts
- WS feed: `graph:sync` events on memory sync, vault import, scope delete

**Config**
- Per-kind counts per scope (claudemd, memory, agent, command, skill, rule, hook, permission, mcp, plugin, marketplace, conversation)
- File-watcher events for recent edits
- Project list with user-set tags

**System**
- Home dir, current selected scope
- User-pinned sessions, hidden sessions

## Constraints (existing tokens)

From `styles.css`:
- **Surfaces**: `--color-bg-0` (deepest) → `--color-bg-3` (panel)
- **Hairlines**: `--color-line`, `--color-line-bright`
- **Accents**: `--color-amber` (electric purple — primary), `--color-phos` (teal — alive/memory), `--color-cyan`, `--color-rose`, `--color-warn`
- **Text**: `--color-pale` → `--color-mid` → `--color-dim` → `--color-ghost`
- **Type**: `--font-mono` (JetBrains Mono) for everything, `--font-vt` (VT323) reserved for big mono brand/section marks
- **Layout**: `--rail-collapsed` 64px, `--rail-expanded` 128px, `--pane-narrow` 220px, `--pane-mid` 280px, `--pane-wide` 300px, `--drawer-w` 360px
- **Glow utilities**: `--glow-amber`, `--glow-phos`
- **Animations**: `pulse-phos`, `pulse-amber`, `caret`, `node-breathe`, `drawer-slide-in`

Honor existing component conventions: `// SECTION` ghost-text labels with letter-spacing, `tag` pill class, `btn` ghost-bordered buttons, dim-red for errors, phos for live/alive things.

## Success criteria

1. Looking at home for 3 seconds tells me whether any session is live
2. Looking at it for 10 seconds tells me what the graph has absorbed in the last hour
3. I can reach any of the four views in one click
4. The header reads better than the current status-line shape on every existing view, not just home
5. On a "quiet" day with no live sessions and no recent graph activity, home doesn't feel empty — it feels like the system at rest

## Deliverable

Match the format of the prior Cortex handoff:
- `build-prompt.md` — design tokens used, layout description, component structure, exact copy/labels for any visible text, color/glow choices per element, animation specifications
- One reference screenshot or mockup if you'd like (not required — written spec is sufficient if it's clear)

The downstream implementer will translate to React + Tailwind v4 against the existing `styles.css`. They will not re-derive style choices — be specific.
