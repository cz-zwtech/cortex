import YAML from 'yaml'

// Tolerant of BOM / leading whitespace before the opening fence.
const FENCE = /^\uFEFF?\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export interface Parsed<T = Record<string, unknown>> {
  data: T
  body: string
  hadFrontmatter: boolean
}

export const parse = <T = Record<string, unknown>>(text: string): Parsed<T> => {
  const m = text.match(FENCE)
  if (!m) return { data: {} as T, body: text, hadFrontmatter: false }
  const yaml = m[1] ?? ''
  // Strip leading blank lines after the closing fence so the in-memory body
  // never carries invisible whitespace the user has to battle.
  const body = text.slice(m[0].length).replace(/^\n+/, '')
  let data: T
  try {
    data = (YAML.parse(yaml) ?? {}) as T
  } catch {
    data = {} as T
  }
  return { data, body, hadFrontmatter: true }
}

export const stringify = (data: Record<string, unknown>, body: string): string => {
  const cleaned: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v) && v.length === 0) continue
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0)
      continue
    cleaned[k] = v
  }
  const trimmedBody = body.replace(/^\n+/, '')
  if (Object.keys(cleaned).length === 0) return trimmedBody
  const yaml = YAML.stringify(cleaned).trimEnd()
  // Single newline between closing fence and body — no synthetic blank line
  // re-inserted if the user deliberately removed it.
  return `---\n${yaml}\n---\n${trimmedBody}`
}
