/**
 * People and their roles, so a query that names a role by department finds the
 * person who holds it.
 *
 * For example, "who handles marketing, is there an exec for it?" shares no
 * word with "| CMO | Dana Quill |", so lexical recall ranks the roster memory
 * far down and never seeds it. A vector seed would close that gap in
 * general; this closes the common case cheaply and explainably: titles are
 * extracted where memories state them (a table row, "Name (Title)", "Title:
 * Name"), and a small dictionary says which words point at which titles.
 */

/** A role key, the titles that spell it, and the words that point at it. */
type Role = { key: string; titles: string[]; words: string[] }

const ROLES: Role[] = [
  { key: 'ceo', titles: ['ceo', 'chief executive officer', 'chief executive'], words: [] },
  { key: 'cto', titles: ['cto', 'chief technology officer', 'chief technical officer'], words: ['technology', 'tech', 'technical', 'engineering'] },
  { key: 'cmo', titles: ['cmo', 'chief marketing officer'], words: ['marketing', 'brand', 'growth'] },
  { key: 'cfo', titles: ['cfo', 'chief financial officer', 'chief finance officer'], words: ['finance', 'financial', 'accounting'] },
  { key: 'coo', titles: ['coo', 'chief operating officer', 'chief operations officer'], words: ['operations', 'ops'] },
  { key: 'cio', titles: ['cio', 'chief information officer'], words: ['information'] },
  { key: 'ciso', titles: ['ciso', 'chief information security officer', 'chief security officer'], words: ['security'] },
  { key: 'cro', titles: ['cro', 'chief revenue officer'], words: ['revenue', 'sales'] },
  { key: 'cpo', titles: ['cpo', 'chief product officer'], words: ['product'] },
  { key: 'chro', titles: ['chro', 'chief people officer', 'chief human resources officer'], words: ['people', 'hiring', 'recruiting'] },
]

/** Words that mean the whole top table: every chief role. */
const GROUP = new Set(['c-suite', 'csuite', 'c-level', 'clevel', 'exec', 'execs', 'executive', 'executives', 'leadership', 'officers', 'chiefs'])

const byTitle = new Map<string, string>()
for (const r of ROLES) for (const t of r.titles) byTitle.set(t, r.key)

const chiefKeys = ROLES.map((r) => r.key)

/**
 * The role keys a title carries: its chief role, and any department it names
 * ("VP of Sales" carries sales, "Head of Marketing" carries marketing and cmo's
 * department words).
 */
export const roleKeys = (title: string): string[] => {
  const t = title.toLowerCase().replace(/\s+/g, ' ').trim()
  const keys = new Set<string>()
  const chief = byTitle.get(t)
  if (chief) keys.add(chief)
  else if (/^c[a-z]{1,3}o$/.test(t)) keys.add(t)
  for (const r of ROLES) for (const w of r.words) if (new RegExp(`\\b${w}\\b`).test(t)) keys.add(`dept:${r.key}`)
  if (keys.size === 0) keys.add(t)
  return [...keys]
}

/**
 * The role keys a query term points at, or none. A department word points at
 * that chief and at anyone whose title names the department; a group word at
 * every chief.
 */
export const roleQuery = (term: string): string[] => {
  const t = term.toLowerCase()
  if (GROUP.has(t)) return chiefKeys
  const chief = byTitle.get(t)
  if (chief) return [chief, `dept:${chief}`]
  for (const r of ROLES) if (r.words.includes(t)) return [r.key, `dept:${r.key}`]
  return []
}

// ── extraction ──────────────────────────────────────────────────────────────

const WORD = "[A-Z][a-z]+(?:[-'][A-Za-z]+)?"
const NAME = `${WORD}(?: (?:[A-Z]\\. )?${WORD}){1,2}`
const DEPT = '[A-Z][A-Za-z&]+(?: [A-Z][A-Za-z&]+)?'
const TITLE =
  `(?:C[A-Z]{1,2}O|CISO|CHRO|Chief [A-Z][a-z]+(?: [A-Z][a-z]+)? Officer|Chief Executive|` +
  `(?:Senior |Executive )?(?:VP|Vice President)(?: of)? ${DEPT}|Head of ${DEPT}|` +
  `(?:${DEPT} )?Director(?: of ${DEPT})?|Co-?[Ff]ounder|Founder|President|General Manager)`

const TITLE_ONLY = new RegExp(`^${TITLE}$`)
const NAME_ONLY = new RegExp(`^${NAME}$`)
const INLINE = [
  new RegExp(`(${NAME})\\s*\\(\\s*(${TITLE})\\b`, 'g'),
  new RegExp(`(${NAME}),\\s*(?:the |our |their |its )?(${TITLE})\\b`, 'g'),
  new RegExp(`\\b(${TITLE})\\s*[:\\-–—]\\s*(${NAME})`, 'g'),
  new RegExp(`\\b(${TITLE}) (${NAME})\\b`, 'g'),
]

/** Capitalised words that open a name match but are not names. */
const NOT_A_NAME = new Set(['The', 'Our', 'Their', 'Its', 'This', 'That', 'New', 'Former', 'Interim', 'Acting', 'And', 'With', 'From', 'For'])

export type Person = { name: string; title: string; roles: string[] }

const clean = (name: string): string | undefined => {
  const words = name.trim().split(' ')
  while (words.length && NOT_A_NAME.has(words[0]!)) words.shift()
  return words.length >= 2 ? words.join(' ') : undefined
}

/** People and titles a memory states. Each pair once. */
export const extractPeople = (content: string): Person[] => {
  const out = new Map<string, Person>()
  const add = (rawName: string, title: string) => {
    const name = clean(rawName)
    if (!name || TITLE_ONLY.test(name)) return
    const key = `${name.toLowerCase()}|${title.toLowerCase()}`
    if (!out.has(key)) out.set(key, { name, title: title.trim(), roles: roleKeys(title) })
  }
  for (const line of content.split('\n')) {
    const l = line.trim()
    if (l.startsWith('|')) {
      const cells = l.split('|').slice(1, -1).map((c) => c.replace(/\*\*/g, '').trim())
      const title = cells.find((c) => TITLE_ONLY.test(c))
      const name = cells.find((c) => c !== title && NAME_ONLY.test(c))
      if (title && name) add(name, title)
      continue
    }
    for (const re of INLINE) {
      for (const m of l.matchAll(re)) {
        const [a, b] = [m[1]!, m[2]!]
        if (TITLE_ONLY.test(a)) add(b, a)
        else add(a, b)
      }
    }
  }
  return [...out.values()]
}

/**
 * The words and phrases a role term may be written as, for the second pass of
 * prompt-time recall: the chief titles spelled both ways, and the department
 * titles ("head of marketing", "vp marketing", "director of marketing").
 * Lower-case; matched as whole words.
 */
export const roleSynonyms = (term: string): string[] => {
  const keys = new Set(roleQuery(term))
  if (!keys.size) return []
  const out = new Set<string>()
  for (const r of ROLES) {
    if (!keys.has(r.key) && !keys.has(`dept:${r.key}`)) continue
    for (const t of r.titles) out.add(t)
    for (const w of r.words) {
      out.add(w)
      for (const pattern of [`head of ${w}`, `director of ${w}`, `${w} director`, `vp ${w}`, `vp of ${w}`, `vice president of ${w}`, `${w} lead`, `${w} exec`])
        out.add(pattern)
    }
  }
  out.delete(term.toLowerCase())
  return [...out]
}
