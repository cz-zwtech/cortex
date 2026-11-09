/**
 * Who is on the bus, and who should handle something.
 *
 * The directory is every member on every machine the mesh reaches: built from
 * the replicated registry (roles, declared metadata) and beats (live, last
 * seen). Roles organise and target work; finding someone needs only a name.
 *
 * resolve() answers "who should handle X" with ranked candidates and reasons,
 * under the rule: INFER WHEN CLEAR, ASK WHEN NOT, never send ambiguous work
 * silently. Clear means the request names the member or role outright (every
 * part of the name is in the words), with no rival naming as well. Anything
 * weaker is a suggestion to put to the human.
 */
import type { Metadata, Registry } from './types.js'

export type Entry = {
  member: string
  roles: string[]
  live: boolean
  lastSeen: number
  meta: Metadata
}

/** A module's own member (private mind's) never runs a watcher, so live/offline says nothing about it. */
export const presence = (e: Pick<Entry, 'live' | 'meta'>): 'live' | 'offline' | 'service' =>
  e.meta.kind === 'service' ? 'service' : e.live ? 'live' : 'offline'

export const directory = (reg: Registry, beats: Map<string, number>, now: number, liveMs: number): Entry[] =>
  [...reg.members.values()]
    .filter((m) => m.roles.size > 0)
    .map((m) => ({
      member: m.name,
      roles: [...m.roles].sort(),
      live: now - (beats.get(m.name) ?? 0) <= liveMs,
      lastSeen: beats.get(m.name) ?? 0,
      meta: m.meta,
    }))
    .sort((a, b) => Number(b.live) - Number(a.live) || a.member.localeCompare(b.member))

/** Words that say what to do, not who should do it. */
const FILLER = new Set(
  ('i id i\'d we you me my our need needs want wants like would could please can to for a an the this that these those ' +
    'build built make made do get have has be is are it of on in with and or so some just').split(' '),
)
export const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !FILLER.has(w))
const parts = (name: string) => name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

export type Candidate = { entry: Entry; address: string; score: number; reasons: string[]; named: boolean }
export type Resolution = { verdict: 'clear' | 'ask' | 'none'; candidates: Candidate[] }

const GENERAL = 'general'

export const resolve = (query: string, entries: Entry[]): Resolution => {
  const q = new Set(words(query))
  const lower = query.toLowerCase()
  // Rarity: a word half the directory shares ("dev") says little about who.
  const df = new Map<string, number>()
  const textOf = (e: Entry) => [e.member, ...e.roles, ...Object.values(e.meta).map(String)].join(' ')
  for (const e of entries) for (const w of new Set(words(textOf(e)))) df.set(w, (df.get(w) ?? 0) + 1)
  const weight = (w: string) => Math.log(1 + entries.length / (df.get(w) ?? 1))

  const cands: Candidate[] = []
  for (const e of entries) {
    const reasons: string[] = []
    let score = 0
    let named = false
    // Whole words only: "ops" is not named by "shops".
    const nameHit = (name: string) =>
      new RegExp(`(^|[^a-z0-9])${name.replace(/[^a-z0-9]/g, '\\$&')}([^a-z0-9]|$)`).test(lower) || parts(name).every((p) => q.has(p))
    if (nameHit(e.member)) {
      named = true
      score += 10
      reasons.push(`its name ${e.member} is in the request`)
    }
    for (const r of e.roles) {
      if (r !== GENERAL && nameHit(r)) {
        named = true
        score += 8
        reasons.push(`it is in role ${r}, named in the request`)
      }
    }
    const field = (label: string, text: string, w: number) => {
      const hit = [...new Set(words(text))].filter((x) => q.has(x))
      if (hit.length) {
        score += w * hit.reduce((n, x) => n + weight(x), 0)
        reasons.push(`${label} matches ${hit.join(', ')}`)
      }
    }
    if (!named) {
      field('name', e.member, 3)
      field('role', e.roles.join(' '), 3)
    }
    field('about', String(e.meta.about ?? ''), 2)
    field('capabilities', String(e.meta.cap ?? ''), 2)
    field('project', String(e.meta.cwd ?? '').split('/').pop() ?? '', 1)
    if (score > 0 && e.live) score += 0.5
    if (score > 0) cands.push({ entry: e, address: `${e.roles[0]}/${e.member}`, score, reasons, named })
  }
  cands.sort((a, b) => b.score - a.score)

  const namedOnes = cands.filter((c) => c.named)
  if (namedOnes.length === 1) return { verdict: 'clear', candidates: [namedOnes[0]!, ...cands.filter((c) => !c.named).slice(0, 3)] }

  // Not clear. Offer the general inbox as a fallback when there is one.
  const shown = cands.slice(0, 5)
  for (const e of entries) {
    if (e.roles.includes(GENERAL) && !shown.some((c) => c.entry.member === e.member)) {
      shown.push({ entry: e, address: `${GENERAL}/${e.member}`, score: 0, reasons: ['general inbox: takes unassigned work'], named: false })
    }
  }
  return { verdict: shown.length ? 'ask' : 'none', candidates: shown }
}
