/**
 * Cortex Profile view — "Dossier" layout.
 *
 * Shows the AI's evidence-grounded PERCEPTION of the human: how Cortex reads
 * you, grouped by dimension, each facet carrying a confidence bar, trend, and
 * evidence count. This is the "mirror you can't put makeup on" — strictly
 * READ-ONLY. There are no edit/delete/save affordances anywhere. Perception
 * only shifts as you behave differently (trend decay) or argue a truer read;
 * it is never directly edited here.
 *
 * Empty state is first-class: `/api/profile` is empty until session capture is
 * wired, so the default surface is a graceful "still forming" panel, not a
 * blank or an error.
 */
import { useEffect, useState } from 'react'
import { getProfile, type Facet, type ProfileView as Profile } from '@/adapters/profileAdapter'

// Fixed render order — must match PROFILE_DIMENSIONS in server/graph/profile.ts.
const DIMENSIONS = [
  'communication',
  'cognition',
  'work-cadence',
  'autonomy',
  'technical-depth',
  'values',
  'affinities',
  'disposition',
] as const

// ── Trend presentation ────────────────────────────────────────────────────────
// strengthening = phos/ok; stable = neutral mid; weakening/stale = dim/warn.

const TREND_GLYPH: Record<Facet['trend'], string> = {
  strengthening: '↑',
  stable: '→',
  weakening: '↘',
  stale: '⌛',
}

const TREND_COLOR: Record<Facet['trend'], string> = {
  strengthening: 'var(--color-phos)',
  stable: 'var(--color-mid)',
  weakening: 'var(--color-amber)',
  stale: 'var(--color-dim)',
}

// ── Facet row ───────────────────────────────────────────────────────────────

function FacetRow({ facet }: { facet: Facet }) {
  const pct = Math.max(0, Math.min(1, facet.confidence)) * 100
  return (
    <div
      className="flex flex-col gap-1 py-2.5 border-b border-[var(--color-line)]"
    >
      {/* Stance + statement */}
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="t-hi text-[12px] font-mono">{facet.stance}</span>
        <span className="t-dim text-[11px] leading-[1.5]">{facet.statement}</span>
      </div>

      {/* Confidence bar + numerics */}
      <div className="flex items-center gap-2.5 mt-0.5">
        <div
          className="relative h-[6px] flex-1 min-w-0 overflow-hidden"
          style={{ background: 'var(--color-bg-2)', border: '1px solid var(--color-line)' }}
          role="img"
          aria-label={`confidence ${facet.confidence.toFixed(2)}`}
        >
          <div
            className="absolute inset-y-0 left-0"
            style={{
              width: `${pct}%`,
              background: 'var(--color-phos)',
              boxShadow: '0 0 6px var(--color-phos)',
              opacity: 0.85,
            }}
          />
        </div>
        <span className="t-phos text-[11px] font-mono tabular-nums w-[34px] text-right">
          {facet.confidence.toFixed(2)}
        </span>
        <span
          className="text-[12px] font-mono w-[14px] text-center"
          style={{ color: TREND_COLOR[facet.trend] }}
          title={facet.trend}
        >
          {TREND_GLYPH[facet.trend]}
        </span>
        <span className="t-ghost text-[10px] font-mono w-[42px] text-right" title="distinct corroborating sessions">
          ev:{facet.evidence_count}
        </span>
      </div>
    </div>
  )
}

// ── Dimension section ─────────────────────────────────────────────────────────

function DimensionSection({ name, facets }: { name: string; facets: Facet[] }) {
  return (
    <section className="mb-6">
      <div className="flex items-center gap-3 mb-1">
        <h2 className="t-amber text-[11px] tracking-[0.25em] uppercase shrink-0">{name}</h2>
        <div className="flex-1 border-t border-[var(--color-line)]" />
      </div>
      <div>
        {facets.map((f) => (
          <FacetRow key={f.id} facet={f} />
        ))}
      </div>
    </section>
  )
}

// ── Empty / loading / error surfaces ───────────────────────────────────────────

function CenterPanel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex-1 min-w-0 overflow-auto flex items-center justify-center"
      style={{
        background:
          'radial-gradient(ellipse at center, #0a0c22 0%, #07081a 60%, #05061a 100%)',
      }}
    >
      <div className="max-w-[440px] px-8 text-center">{children}</div>
    </div>
  )
}

function EmptyState() {
  return (
    <CenterPanel>
      <div className="t-amber text-[11px] tracking-[0.25em] uppercase mb-3">
        // PERCEPTION STILL FORMING
      </div>
      <div className="t-mid text-[13px] leading-[1.7] mb-3">
        Cortex hasn&rsquo;t formed a read of you yet.
      </div>
      <div className="t-dim text-[11px] leading-[1.8]">
        This profile is how Cortex perceives you — it accrues from how you work
        across sessions. Nothing has been observed enough to show. As you use
        Cortex, evidence-grounded facets will appear here, each with a visible
        confidence.
      </div>
      <div className="t-ghost text-[10px] leading-[1.7] mt-4">
        It isn&rsquo;t directly editable: it shifts only as you behave
        differently, or argue a truer read.
      </div>
    </CenterPanel>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────

export function ProfileView() {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getProfile()
      .then((p) => {
        if (cancelled) return
        setProfile(p)
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center t-dim text-[12px]">
        <span className="caret">reading perception</span>
      </div>
    )
  }

  if (error) {
    return (
      <CenterPanel>
        <div className="t-amber text-[11px] tracking-[0.25em] uppercase mb-3">// COULD NOT READ PROFILE</div>
        <div className="t-dim text-[11px] leading-[1.7] font-mono break-words">{error}</div>
      </CenterPanel>
    )
  }

  const facets = profile?.facets ?? []
  if (facets.length === 0) return <EmptyState />

  // Group facets by dimension, render only dimensions that have facets, in the
  // fixed order. Any facet on an unknown dimension is dropped from the grouped
  // body but still counts toward coverage being incomplete.
  const byDimension = new Map<string, Facet[]>()
  for (const f of facets) {
    const list = byDimension.get(f.dimension)
    if (list) list.push(f)
    else byDimension.set(f.dimension, [f])
  }

  const orderedSections = DIMENSIONS.filter((d) => byDimension.has(d))
  const formingCount = DIMENSIONS.length - orderedSections.length

  const narrative = profile?.narrative?.trim() ?? ''

  return (
    <div
      className="flex-1 min-w-0 overflow-auto"
      style={{
        background:
          'radial-gradient(ellipse at center, #0a0c22 0%, #07081a 60%, #05061a 100%)',
      }}
    >
      <div className="max-w-[760px] mx-auto px-8 py-8">
        {/* Narrative header */}
        <div className="mb-1.5">
          <span className="t-ghost text-[10px] tracking-[0.25em] uppercase">how cortex sees you</span>
        </div>
        <div className="mb-6">
          {narrative ? (
            <p className="t-mid text-[13px] leading-[1.7]">{narrative}</p>
          ) : (
            <p className="t-dim text-[12px] leading-[1.7] italic">
              No summary synthesized yet — the facets below are the read so far.
            </p>
          )}
        </div>

        {/* Read-only note */}
        <div className="t-ghost text-[10px] leading-[1.6] mb-7 border-l border-[var(--color-line)] pl-3">
          This is Cortex&rsquo;s perception, not a setting — it isn&rsquo;t
          directly editable. It shifts as you behave differently, or argue a
          truer read.
        </div>

        {/* Grouped facets */}
        {orderedSections.map((d) => (
          <DimensionSection key={d} name={d} facets={byDimension.get(d)!} />
        ))}

        {/* Coverage footer */}
        {formingCount > 0 && (
          <div className="t-ghost text-[10px] tracking-[0.15em] mt-2">
            {formingCount} of {DIMENSIONS.length} dimensions still forming
          </div>
        )}
      </div>
    </div>
  )
}
