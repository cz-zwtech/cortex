import { useEffect, useState } from 'react'
import { getSingletonHighlighter, type Highlighter, type ThemedToken } from 'shiki'

const THEME = 'one-dark-pro'

let highlighter: Highlighter | null = null
let loadPromise: Promise<Highlighter> | null = null
const loadedLangs = new Set<string>()
const loadingLangs = new Map<string, Promise<void>>()

const ensureHighlighter = (): Promise<Highlighter> => {
  if (highlighter) return Promise.resolve(highlighter)
  if (loadPromise) return loadPromise
  loadPromise = getSingletonHighlighter({ themes: [THEME], langs: [] }).then((h) => {
    highlighter = h
    return h
  })
  return loadPromise
}

const ensureLang = (lang: string): Promise<void> => {
  if (loadedLangs.has(lang)) return Promise.resolve()
  const existing = loadingLangs.get(lang)
  if (existing) return existing
  const p = ensureHighlighter().then(async (h) => {
    try {
      if (!h.getLoadedLanguages().includes(lang)) {
        await h.loadLanguage(lang as any)
      }
      loadedLangs.add(lang)
    } catch {
      // unsupported lang — mark loaded so we don't retry
      loadedLangs.add(lang)
    }
  })
  loadingLangs.set(lang, p)
  return p
}

const extToLang: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cxx: 'cpp',
  cs: 'csharp', php: 'php', swift: 'swift', kt: 'kotlin', scala: 'scala',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', sass: 'sass', less: 'less',
  md: 'markdown', mdx: 'mdx',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'fish',
  sql: 'sql', vue: 'vue', svelte: 'svelte', astro: 'astro',
  dockerfile: 'docker', docker: 'docker',
  ini: 'ini', conf: 'ini', env: 'shell',
  lua: 'lua', pl: 'perl', r: 'r',
  ex: 'elixir', exs: 'elixir', erl: 'erlang',
  clj: 'clojure', hs: 'haskell', ml: 'ocaml',
  dart: 'dart', elm: 'elm',
}

export const langFromPath = (path: string): string => {
  const name = path.split(/[\\/]/).pop() ?? ''
  if (name.toLowerCase() === 'dockerfile') return 'docker'
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return extToLang[ext] ?? 'text'
}

/**
 * React hook. Loads (async) the highlighter + requested language; returns the
 * highlighter only once it's ready. Triggers a re-render on load.
 */
export const useShikiLang = (lang: string): Highlighter | null => {
  const [h, setH] = useState<Highlighter | null>(
    highlighter && loadedLangs.has(lang) ? highlighter : null,
  )
  useEffect(() => {
    let cancelled = false
    void ensureLang(lang).then(() => {
      if (!cancelled) setH(highlighter)
    })
    return () => { cancelled = true }
  }, [lang])
  return h
}

/**
 * LRU-ish cache for tokenized lines. Shiki tokenization is fast but with
 * virtualized timelines we scroll rows in and out of the DOM — remounted
 * components call this again for lines we've already seen. Keyed on
 * `lang\u0000line` to scope per-language.
 */
const tokenCache = new Map<string, ThemedToken[] | null>()
const TOKEN_CACHE_LIMIT = 2000

/**
 * Tokenize a single line of source. Returns the tokens for that line
 * (shiki returns an array of lines; we take the first). Caller renders.
 * Safe to call with an un-loaded lang — returns null.
 */
export const tokenizeLineSync = (
  h: Highlighter,
  line: string,
  lang: string,
): ThemedToken[] | null => {
  if (!line) return null
  const key = `${lang}\u0000${line}`
  const cached = tokenCache.get(key)
  if (cached !== undefined) return cached
  try {
    const actualLang = loadedLangs.has(lang) ? lang : 'text'
    const result = h.codeToTokensBase(line, { lang: actualLang as any, theme: THEME })
    const tokens = result[0] ?? null
    if (tokenCache.size >= TOKEN_CACHE_LIMIT) {
      const oldest = tokenCache.keys().next().value
      if (oldest !== undefined) tokenCache.delete(oldest)
    }
    tokenCache.set(key, tokens)
    return tokens
  } catch {
    return null
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

/**
 * Tokenize a line and return it as an inline HTML string with color spans.
 * Use this when you need `dangerouslySetInnerHTML` — e.g. for libraries
 * like react-diff-viewer-continued that detect pre-highlighted HTML and
 * overlay diff markers on top of it.
 */
export const highlightLineHtml = (
  h: Highlighter,
  line: string,
  lang: string,
): string => {
  const tokens = tokenizeLineSync(h, line, lang)
  if (!tokens) return escapeHtml(line)
  return tokens
    .map((t) => {
      const italic = t.fontStyle === 1 ? ';font-style:italic' : ''
      return `<span style="color:${t.color}${italic}">${escapeHtml(t.content)}</span>`
    })
    .join('')
}
