---
name: cortex-profile
description: "The personality profile: evidence-based perception of how you work, opt-in surfacing"
audience: user
---

# Personality profile (how Cortex reads you)

> **Surfacing is opt-in — default OFF.** Cortex still **tracks** your profile in the background (facets accrue every session), but it is not **surfaced** unless you set `CKN_PROFILE=1` in Cortex's environment (the `env` block of `~/.claude/settings.json`, or your shell / systemd unit). When off: nothing about you is injected into a session, the onboarding prompt never shows, and the dashboard's **Profile** view is hidden — fully silent. But the profile keeps building, so the day you switch it on it's already populated and ready. Enable it when you want Claude to adapt to how you work.

Cortex keeps an **evidence-based perception of how you work** and surfaces it to every session, so Claude engages the way *you* actually operate — your terseness, your cadence, how much autonomy you want — instead of a generic default. It is **not a questionnaire and not human-edited**: it is inferred from your behavior across sessions and moves only when the evidence does.

**Eight dimensions.** Every observation is a *facet* under one of: `communication`, `cognition`, `work-cadence`, `autonomy`, `technical-depth`, `values`, `affinities`, `disposition`. A facet records a stance ("prefers brief answers first"), a valence (like / dislike / trait / neutral), a confidence, and a trend (**strengthening / stable / weakening / stale**). Contradictory facets share a *competing group*; the highest-confidence one wins, so a changed mind overtakes the old read rather than piling up. Corroboration is deterministic — exact `(dimension, facet_key, stance)` match, no embeddings — and only facets at confidence ≥ 0.6 are injected into a session. Unreinforced facets decay (stale after ~60 days); behaving differently is how you "correct" the profile.

**A synthesized narrative.** Alongside the facets, Cortex maintains a short prose "about the human" summary (a single `profile_narrative` entry) that the capability sheet shows at session start.

**Captured on the same two paths as memory** (next section): **Path A** — `ckn-extract` at SessionEnd via the Anthropic API; **Path B** — `/cortex-snapshot` (the interactive Claude) emits facet candidates with no API key, validated by the *identical* accept/reject parser. Either way the same facets land.

**Cold start — seed it, then let it learn.** A new user's profile is blank — there's no behavior to infer from yet. Once you've enabled surfacing (`CKN_PROFILE=1`), the first session that *still* finds an empty profile offers a one-time `/cortex-profile-setup` (if background tracking already populated it, there's nothing to seed — it's ready): a short guided multiple-choice setup (answer length, autonomy / change-approval, explanation depth, time estimates, tone, code style). Your answers become *declared* seed facets at confidence ~0.62 — just above the 0.6 injection bar — so they shape the very next session. Declared seeds are **soft**: they decay (full strength for ~14 days, fading to a 0.30 floor by ~60 days) and are **overtaken** the moment real behavior corroborates a preference (the observed read wins; an abandoned seed simply fades below the bar on its own). A facet you declared keeps its `declared` provenance even after behavior backs it up. The prompt runs **once** — a global `~/.config/ckn/onboarding-profile.json` marker is written when the nudge is shown, so it never re-fires even if you ignore it, and it's cwd-independent — and **only when the profile is blank**, so a profile synced in from another machine via private-mind is never prompted. Run `/cortex-profile-setup` by hand anytime to (re)seed.

**It follows you across machines.** With private-mind enabled, your profile travels as a `profile.json` snapshot in the private repo and merges by competing group — a truer read earned on one machine shows up on the rest. Inspect it anytime at `GET /api/profile`. **Hard interaction overrides** — your authored `feedback` memories / `identity.yaml` — always override the inferred perception and **never decay**; **declared onboarding seeds are soft** and decay as real behavior accrues.


Related: [[cortex-recall]] · [[cortex-private-mind]] · [[cortex-configuration]]
