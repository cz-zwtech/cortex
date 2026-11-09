/**
 * The secret gate — the only step permitted between arrival and the journal
 * append.
 *
 * Everything else in ingest happens strictly AFTER the append, because past
 * that point nothing can lose text. This runs BEFORE it, because the journal is
 * precisely the thing you cannot take content back out of: once a credential is
 * appended and replicated, every remaining option is damage limitation rather
 * than prevention.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BLOCK, NEVER WARN-AND-APPEND
 *
 * Warn-and-append is the tempting design and it is wrong in a specific way: it
 * puts the bytes in the durable, replicated log while the warning waits to be
 * read. The warning is asynchronous; the exposure is not.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MATCH VALUES, NOT KEY NAMES
 *
 * A name-matching scanner quarantines the DOCUMENTATION of a secrets system
 * while the actual secrets flow past it. This fleet's memories legitimately
 * discuss BAO_SECRET_ID, BAO_ROLE_ID, ANTHROPIC_API_KEY and token paths BY NAME
 * — that is what a memory about the secrets architecture IS.
 *
 * And the cost of a false positive is worse than annoyance. A noisy quarantine
 * stops being read; once it does, real secrets sit unsynced in scratchpads and
 * so does everything caught alongside them, so the user's memory silently stops
 * working and NOTHING REPORTS IT. A false positive converts into a silent
 * recall gap, which is the failure this architecture is least able to detect.
 * Tune conservatively, and surface the quarantine depth in `status`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROVENANCE: this reuses V1's detector (server/sharedMind.ts:191-221) and
 * RE-DERIVES its exclusions. Detection logic travels across corpora; exclusions
 * encode assumptions about what the text IS, and those do not. V1's list was
 * tuned against MCP config env records, where a URL is a service endpoint — see
 * §URLs below for why that exclusion is actively backwards here.
 */

export type SecretFinding = {
  /** What kind of match. Never the matched value. */
  kind: 'provider-prefix' | 'private-key' | 'jwt' | 'url-credential' | 'high-entropy'
  /**
   * Only when asked for (explain): the flagged token's SHAPE, never the token: its first
   * two characters, its length and the character classes in it. Enough to tell an
   * identifier from a key without the value leaving.
   */
  shape?: string
  /** 1-indexed line, so a human can find it in their scratchpad. */
  line: number
  /**
   * A short, NON-REVEALING description. This travels into logs and status
   * output, so it must never carry the matched text — a finding that quotes the
   * secret is the leak it exists to prevent, one layer over.
   */
  hint: string
}

/** Known credential shapes. Prefix matching is cheap and near-zero false positive. */
const PROVIDER_PREFIXES = [
  'sk-',
  'sk_live_',
  'sk_test_',
  'rk_live_',
  'xoxb-',
  'xoxp-',
  'xapp-',
  'ghp_',
  'gho_',
  'ghu_',
  'ghs_',
  'ghr_',
  'github_pat_',
  'glpat-',
  'AKIA',
  'ASIA',
  'AIza',
  'ya29.',
  'hvs.',
  'hvb.',
  'npm_',
  'dop_v1_',
  'shpat_',
]

const PRIVATE_KEY_ARMOUR = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/

/**
 * Placeholders and shell forms. These are how a memory legitimately TALKS about
 * a secret without containing one, and they are the single biggest source of
 * false positives in prose that documents a secrets system.
 */
/**
 * Providers' published example credentials, quoted in docs and in notes about
 * detection rules: AWS's AKIAIOSFODNN7EXAMPLE and its secret ending EXAMPLEKEY,
 * and the like. A generated key does not end in a dictionary word.
 */
const DOCUMENTED_EXAMPLE = /EXAMPLE(?:KEY)?$/

const PLACEHOLDER = /^\$\{.*\}$|^\$\(.*\)$|^<.*>$|^\.\.\.$|^x{8,}$|^\*{4,}$/i

/** Words that look high-entropy to a machine and are ordinary to a human. */
const looksLikeHash = (t: string) => /^[a-f0-9]{7,40}$/i.test(t) // git sha, md5 in prose
const looksLikePath = (t: string) => t.includes('/') || t.includes('\\')

/**
 * V1's entropy proxy: long, mixed case, contains digits, no whitespace.
 *
 * Kept as-is. It is a proxy rather than a real entropy calculation, and that is
 * fine — the point is a conservative catch, not a classifier.
 */
const isHighEntropyRun = (t: string): boolean =>
  t.length >= HIGH_ENTROPY_RUN && /[a-z]/.test(t) && /[A-Z]/.test(t) && /[0-9]/.test(t) && !/\s/.test(t)

/**
 * Entropy is judged per RUN, not per token.
 *
 * Scoring the whole token quarantined 17% of a real laptop corpus. The hits
 * were names, not values: checkpoint slugs with an ISO timestamp
 * (`precompact-5cd9b882-2026-10-13T12-30-37-732Z`), code identifiers joined by
 * `_` and `.`, dotted module paths. Each is long and mixed-case only because
 * short pieces are glued together. A credential is one long unbroken run of
 * base62, so splitting on the joiners keeps every real shape and drops the
 * glued-names class whole.
 */
const HIGH_ENTROPY_RUN = 24
const JOINERS = /[-_.:]+/
const isHighEntropy = (t: string): boolean => t.split(JOINERS).some(isHighEntropyRun)

/**
 * A provider prefix is a credential only when a credential FOLLOWS it.
 *
 * Bare `glpat-` or `sk-` in prose is a memory ABOUT a token type, which is
 * exactly what a memory should say instead of the value. Every listed provider
 * issues at least 16 characters after its prefix.
 */
const PREFIX_TAIL = /^[A-Za-z0-9_\-.]{16,}/
const hasProviderPrefix = (v: string): boolean =>
  PROVIDER_PREFIXES.some((p) => v.startsWith(p) && PREFIX_TAIL.test(v.slice(p.length)))

/**
 * URLs. THE ONE V1 EXCLUSION THAT MUST NOT CARRY FORWARD.
 *
 * V1 excluded `http(s)://` wholesale because in an MCP config a URL is a service
 * endpoint. In memory PROSE a URL is exactly where a credential hides:
 *
 *   postgres://user:<password>@host/db      authority userinfo
 *   https://api.example.com?api_key=...   query value
 *   https://x.com/d/AKIA.../file          credential-shaped path segment
 *
 * So the URL is exempt AS A WHOLE from entropy scoring — a long opaque path or
 * a signed-looking blob in a docs link should not trip the scanner — while its
 * credential-bearing POSITIONS are still scanned. Exempting the whole string is
 * what creates the bypass.
 */
const CREDENTIAL_QUERY_KEYS =
  /^(?:api[-_]?key|access[-_]?token|token|secret|password|passwd|pwd|sig|signature|auth|credential)$/i

const scanUrl = (raw: string, line: number): SecretFinding[] => {
  const out: SecretFinding[] = []
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return out
  }

  // 1. Authority userinfo — `scheme://user:<password>@host`. A password here is a
  //    credential by construction; no entropy judgement needed.
  // The parser percent-encodes a placeholder (`<pw>` becomes `%3Cpw%3E`): judge it as written.
  const password = (() => {
    try {
      return decodeURIComponent(url.password)
    } catch {
      return url.password
    }
  })()
  if (password && !PLACEHOLDER.test(password)) {
    out.push({ kind: 'url-credential', line, hint: 'password embedded in a URL authority' })
  }

  // 2. Query values under credential-shaped keys. Here the KEY is the signal —
  //    which is not a contradiction of "values not names": this is a structured
  //    position whose meaning is defined by the URL grammar, not a guess about
  //    prose.
  for (const [k, v] of url.searchParams) {
    if (!v || PLACEHOLDER.test(v)) continue
    if (CREDENTIAL_QUERY_KEYS.test(k)) {
      out.push({ kind: 'url-credential', line, hint: `credential-shaped query parameter "${k}"` })
    }
  }

  // 3. Path segments carrying a known provider shape. Deliberately NOT entropy
  //    on path segments: opaque ids in documentation links are common and would
  //    make this noisy, and noise is the failure mode that matters most here.
  for (const seg of url.pathname.split('/')) {
    if (hasProviderPrefix(seg) && !DOCUMENTED_EXAMPLE.test(seg)) {
      out.push({ kind: 'url-credential', line, hint: 'credential-shaped URL path segment' })
    }
  }

  return out
}

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi

/**
 * Scan text for credential-shaped values.
 *
 * Returns findings; the caller decides the disposition. Deliberately not
 * throwing and deliberately not redacting in place: quarantine holds the ORIGINAL
 * so nothing is lost, and a scanner that silently rewrote content would be a
 * second writer of memory text.
 */
const shapeOf = (t: string): string => {
  const classes = [/[a-z]/.test(t) && 'a-z', /[A-Z]/.test(t) && 'A-Z', /[0-9]/.test(t) && '0-9', /[^A-Za-z0-9]/.test(t) && `other(${[...new Set(t.replace(/[A-Za-z0-9]/g, ''))].join('')})`].filter(Boolean)
  return `${t.slice(0, 2)}… ${t.length} chars, ${classes.join(' ')}`
}

export const scanForSecrets = (text: string, opts: { explain?: boolean } = {}): SecretFinding[] => {
  const findings: SecretFinding[] = []

  text.split('\n').forEach((written, i) => {
    const line = i + 1
    // Text inside JSON (a sync bundle's line, as the mesh's file gate reads it) carries its
    // newlines and quotes as escapes: read them as the breaks they stand for, or words glued by
    // a literal \n look like one long high-entropy run, and a URL runs on past its end.
    const rawLine = written.replace(/\\[nrt"]/g, ' ')

    if (PRIVATE_KEY_ARMOUR.test(rawLine)) {
      findings.push({ kind: 'private-key', line, hint: 'private key block' })
    }
    if (JWT.test(rawLine)) {
      findings.push({ kind: 'jwt', line, hint: 'JWT-shaped token' })
    }

    // URLs first, and remove them from what the entropy pass sees — that is the
    // "exempt as a whole, scan its positions" rule in one step.
    let remainder = rawLine
    for (const m of rawLine.match(URL_RE) ?? []) {
      findings.push(...scanUrl(m, line))
      remainder = remainder.replace(m, ' ')
    }

    for (const token of remainder.split(/[\s"'`,;()[\]{}<>]+/)) {
      if (!token || PLACEHOLDER.test(token)) continue

      // `KEY=value` / `KEY: value` — judge the VALUE, never the name. This is
      // what lets a memory say BAO_SECRET_ID and be indexed normally.
      const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : token
      if (!value || PLACEHOLDER.test(value) || DOCUMENTED_EXAMPLE.test(value)) continue

      const shape = opts.explain ? { shape: shapeOf(value) } : {}
      if (hasProviderPrefix(value)) {
        findings.push({ kind: 'provider-prefix', line, hint: 'known credential prefix', ...shape })
        continue
      }
      if (looksLikePath(value) || looksLikeHash(value)) continue
      if (isHighEntropy(value)) {
        findings.push({ kind: 'high-entropy', line, hint: 'long high-entropy value', ...shape })
      }
    }
  })

  return findings
}

export const hasSecrets = (text: string): boolean => scanForSecrets(text).length > 0
