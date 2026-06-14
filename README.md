# Cortex

**Memory is table stakes. Cortex gives your [Claude Code](https://www.anthropic.com/claude-code)
sessions a shared mind — and makes them work it as a team.**

Every session you run feeds one persistent, graph-structured mind: what you
learned, what failed and how you fixed it, how your code connects, how you like
to work. Every later session draws on it automatically — on this machine or any
of yours. And sessions running side by side aren't strangers: they see each
other, message each other, split work, hand off, and review each other over
that same mind. Not a per-chat scratchpad — one portable memory, several pairs
of hands.

Under the hood it's a typed graph (sessions, facts, fail→success patterns, code
symbols, and the relationships between them) in a local SQLite file **you own** —
inspectable, portable, and surface-agnostic by design: a local graph behind an
API, with Claude Code as its deepest client, not its cage. The hooks ride
*under* your normal sessions; recall walks the graph's edges so the right
memory surfaces at the moment you're about to need it. Dogfooded daily across
a multi-machine fleet — including the day its own coordination layer caught
and fixed bugs in Cortex itself.

Memory alone is a scratchpad that forgets where you work — what changes things
is a mind your sessions *share* and *work*.

## What that feels like

- **Friday desktop, Monday café.** You crack the bug Friday at the desk. Monday
  on the laptop, the fix is there — and so are the dead-ends you already ruled
  out. Nothing hand-synced, nothing re-explained. *(shipped → [private mind](docs/minds/private-mind.md))*
- **Your teammate's two bad days become your good one.** She tames staging's
  quirks and publishes the lesson; next week you hit the same wall and her
  notes surface automatically, with her name on them. Knowledge compounds
  instead of walking out on PTO. *(shipped → [team mind](docs/minds/team-mind.md))*
- **Three conversations, one line of thought.** The auth design from Tuesday,
  Wednesday's UI review, this morning's hardware quirk — separate sessions,
  one graph. The moment they connect, the synthesis is already linked and
  recall pulls the whole thread, not three fragments. *(shipped → [memory](docs/memory/pipeline.md))*
- **You stop being the context janitor.** The model still has a context window —
  what changes is that the *thread* lives in the graph: capture is automatic,
  work-in-flight survives compaction, and a fresh session picks it up with
  `/cortex-continue` — no `--resume`, no re-pasting. *(shipped → [coordination](docs/coordination/overview.md))*

And the reflexes, firing before you ask: the gotcha note *you* wrote surfacing
at first tool-use ([recall](docs/memory/recall.md)) · last time's fail→success
trace arriving with a repeat error ([patterns](docs/memory/extraction.md)) ·
who-depends-on-this injected before you edit, not in review
([codegraph](docs/codegraph/codegraph.md)).

> **And one for later — vision, not shipped:** you and your partner plan a trip
> from your *own* assistants, on your *own* accounts, sharing one trip-mind —
> the hotel you both liked, what each of you picked, what's booked, what's
> still loose. No shared login. Connected, not merged. The surface-agnostic
> design above is what points here.

## What Cortex gives you

1. **Live session monitor** — every Claude Code session you run is parsed, indexed, and visualized. → [the UI](docs/ui.md)
2. **Configuration manager** — view, edit, and promote agents / commands / skills / rules / hooks / permissions / MCP servers across user and project scopes. → [the UI](docs/ui.md)
3. **Graph-structured memory** — memory files, vault notes, and fail→success patterns become a typed graph; recall combines vector seeds with edge expansion and composite scoring. → [memory](docs/memory/pipeline.md)
4. **Private mind** — opt-in, git-backed sync of your *whole* memory across *your own* machines. → [private mind](docs/minds/private-mind.md)
5. **Team mind** — hand-pick memories to publish to a repo teammates subscribe to; their sessions learn from yours. → [team mind](docs/minds/team-mind.md)
6. **Session-to-session coordination** — your sessions see each other and exchange messages, on one machine and across your fleet; a virtual team sharing one mind. → [coordination](docs/coordination/overview.md)
7. **Personality profile** — an evidence-based, opt-in perception of how you work, surfaced to every session. → [profile](docs/memory/profile.md)
8. **Code graph** — an AST symbol graph of your repos: blast-radius, branch-diff, and file-knowledge recall before you edit. → [codegraph](docs/codegraph/codegraph.md)

The UI is for monitoring. **The actual intelligence runs through hooks** that
fire during your normal Claude Code sessions — the UI doesn't have to be open
for any of it to work.

> **Why `ckn`?** The package, CLI (`ckn-*`), and env-var (`CKN_*`) prefix come
> from this project's early-days name, **C**laude **K**nowledge **N**etwork.
> It's since been rebranded **Cortex**, but the `ckn` prefix stuck.

## Install

The fastest path: open a Claude Code session and paste the auto-install prompt
from **[docs/start/install.md](docs/start/install.md)** — Claude clones,
installs, verifies, and seeds an onboarding corpus so it can drive the rest of
setup from recall. The manual path is four commands:

```bash
git clone git@github.com:cz-zwtech/cortex.git ~/cortex
cd ~/cortex && npm install
npm start                    # first boot registers hooks + commands + skills
npm run install-aliases      # ckn-start / ckn-stop / ckn-bus / …
```

Then restart your Claude Code session so the just-installed hooks load.
Check [prerequisites](docs/start/prerequisites.md) first (Node 20+, build
toolchain, git identity, SSH keys), and read
[permissions & agent-driven setup](docs/start/permissions-and-agents.md) before
asking a session to do the install for you.

## What Cortex touches on your system

Cortex is **per-user and additive** — everything lives under your home
directory, no root, no system service unless you opt into
[worker mode](docs/operate/worker-mode.md), and **no MCP servers registered**.
Every install step is idempotent and marker-fenced: re-running refreshes
Cortex's own block and never clobbers entries you added yourself.

| Where | What |
|---|---|
| `~/.claude/settings.json` | 7 hook registrations, inside Cortex markers — Cortex never writes a `statusLine` key |
| `~/.claude/commands/`, `~/.claude/skills/` | 11 slash commands + the `codegraph` skill |
| your shell rc | one managed alias block — only when you run `npm run install-aliases` |
| `~/.config/ckn/` | the graph DB, app config, machine id, optional mind clones |
| `~/.local/state/ckn/` | server log |

Full detail per group: [install](docs/start/install.md). Opt-in only:
API-key extraction, private-mind sync, the mesh, worker mode — each documented
in its own page.

## The map

| Domain | Start at |
|---|---|
| Getting started | [docs/start/install.md](docs/start/install.md) |
| Add a machine to your fleet (mesh) | [docs/install-wsl-driver-node.md](docs/install-wsl-driver-node.md) |
| Day-to-day operation | [docs/operate/running.md](docs/operate/running.md) |
| Memory | [docs/memory/pipeline.md](docs/memory/pipeline.md) |
| Session coordination | [docs/coordination/overview.md](docs/coordination/overview.md) |
| Your minds (private / team) | [docs/minds/private-mind.md](docs/minds/private-mind.md) |
| Code graph | [docs/codegraph/codegraph.md](docs/codegraph/codegraph.md) |
| The UI | [docs/ui.md](docs/ui.md) |
| Statusline dots (bus / mesh, opt-in) | [docs/statusline-bus-dot.md](docs/statusline-bus-dot.md) |
| Architecture (one page) | [docs/architecture.md](docs/architecture.md) |
| Configuration reference | [docs/operate/configuration.md](docs/operate/configuration.md) |
| Troubleshooting | [docs/operate/troubleshooting.md](docs/operate/troubleshooting.md) |

## Known pain points

Cortex is pre-1.0 personal infrastructure: functional and daily-driven, with
acknowledged rough edges rather than a roadmap. The ones you're most likely to
hit:

- Pattern detection is greedy — per-fail-id dedup, no semantic similarity, so
  the pattern corpus accumulates noise.
- The D3 graph view slows above ~500 nodes.
- The team-mind model assumes mutual trust between collaborators (no commit
  signing, no secret scrubbing on publish).
- `remote` embeddings mode is a reserved value, not implemented — `local` and
  `off` are the real choices.
- Each page in `docs/` notes its own rough edges where you'll hit them.
- A handful of `npm audit` advisories (2 critical / 3 high / 1 moderate) live in dev/build dependencies (`vite`/`esbuild`, `concurrently` → `shell-quote`) or an unused SDK code path — none are reachable from the running server, and the criticals have no patched upstream release yet. A deliberate major-version bump pass is tracked separately.

## License

[MIT](LICENSE) © 2026 Corey Zwart.
