#!/usr/bin/env tsx
/**
 * §1 content-derivation (memory→file linkage). A token is a file mention when it
 * is PATH-SHAPED: contains `/` AND its terminal segment carries a file extension.
 * Backticks are a strong signal, not a requirement. Excluded: URLs, bare
 * basenames (no `/`), globs, package specifiers (no extension), dates/session-ids.
 * Precision-first — same spirit as fileMentionMatches (no "db.ts matches every
 * db.ts" false positives). The verbatim path is kept (stub name is verbatim).
 */
import assert from 'node:assert/strict'
import { deriveFileMentions } from '../../server/graph/fileMentions.ts'

let passed = 0
const ok = (l: string) => { passed++; console.log(`  ok ${l}`) }

const has = (text: string, ...expected: string[]) => {
  const got = deriveFileMentions(text)
  for (const e of expected) assert.ok(got.includes(e), `expected '${e}' in [${got.join(', ')}]`)
  return got
}
const lacks = (text: string, ...banned: string[]) => {
  const got = deriveFileMentions(text)
  for (const b of banned) assert.ok(!got.includes(b), `did NOT expect '${b}' in [${got.join(', ')}]`)
  return got
}

// ── 1. backtick-quoted repo-relative path (the canonical case)
{
  has('I edited `server/graph/bus.ts` today.', 'server/graph/bus.ts')
  ok('backtick repo-relative path is derived')
}

// ── 2. bare basename (no slash) is EXCLUDED (precision-first)
{
  lacks('the `bus.ts` file and config.json here', 'bus.ts', 'config.json')
  ok('bare basenames (no slash) excluded')
}

// ── 3. URLs are EXCLUDED
{
  lacks('see https://example.com/app.ts and http://x.io/y.js', 'https://example.com/app.ts', 'example.com/app.ts')
  ok('URLs excluded')
}

// ── 4. globs / wildcards EXCLUDED
{
  lacks('match `server/*.ts` and bin/** here', 'server/*.ts', 'bin/**')
  ok('glob/wildcard tokens excluded')
}

// ── 5. package specifiers (slash but no file extension) EXCLUDED
{
  lacks('import from `@anthropic-ai/sdk` and node a/b', '@anthropic-ai/sdk', 'a/b')
  ok('package specifiers / extension-less slash tokens excluded')
}

// ── 6. absolute + tilde paths kept VERBATIM (stub name is verbatim)
{
  has('ran `/path/to/cortex/bin/x.ts` and `~/.claude/settings.json`',
    '/path/to/cortex/bin/x.ts', '~/.claude/settings.json')
  ok('absolute + tilde paths kept verbatim')
}

// ── 7. trailing punctuation is trimmed; path still derived; deduped
{
  const got = has('(see server/graph/db.ts). Again server/graph/db.ts!', 'server/graph/db.ts')
  assert.equal(got.filter((p) => p === 'server/graph/db.ts').length, 1, 'deduped')
  ok('trailing punctuation trimmed + deduped')
}

// ── 8. dates / session ids are not path-shaped → excluded
{
  lacks('on 2026-06-11 session 411f5f18-0229-45cb-a437-5c37b7003b7f', '2026-06-11', '411f5f18-0229-45cb-a437-5c37b7003b7f')
  ok('dates + session ids excluded')
}

console.log(`\nOK derive-file-mentions.test.ts — ${passed} assertions passed`)
