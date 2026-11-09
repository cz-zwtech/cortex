import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { MemoryStore, hashContent } from '../server/store.js'
import { LEXICAL_ESTIMATOR } from '../server/reconcile.js'
import {
  DEFAULT_CANDIDATE_LIMIT,
  pendingText,
  reflex,
  toResponse,
  type ToolPayload,
} from '../server/reflex.js'
import { scopeForPath } from '../server/on-pre-tool-use.js'

const schema = fs.readFileSync(path.join(import.meta.dirname, '..', 'schema.sql'), 'utf-8')

const store = () => {
  const db = new Database(':memory:')
  db.exec(schema)
  return new MemoryStore(db)
}

const ROOT = path.join(os.homedir(), '.claude', 'memory')
const MEMFILE = path.join(ROOT, 'deploy.md')
const roots = [ROOT, path.join(os.homedir(), '.claude', 'projects')]

const DEPLOY =
  'Deploy by running the release script on the build host, then wait for the health ' +
  'check to report green before switching traffic over to the new pods.'

const seed = (s: MemoryStore, over: Record<string, unknown> = {}) => {
  const input = {
    id: 'existing',
    source: MEMFILE,
    name: 'deploy-process',
    description: 'how we deploy',
    content: DEPLOY,
    shape: 'workflow' as const,
    authorship: 'authored' as const,
    scope: 'user',
    pinned: false,
    protected: false,
    machine: 'node-a',
    authoredAt: 1000,
    ingestedAt: 1000,
    outcome: '',
    outcomeText: '',
    contentHash: hashContent('deploy-process', 'how we deploy', DEPLOY),
    ...over,
  }
  s.upsert(input as never)
  return input
}

const write = (file: string, content: string): ToolPayload => ({
  tool_name: 'Write',
  tool_input: { file_path: file, content },
})

const deps = (s: MemoryStore, over: Record<string, unknown> = {}) => ({
  store: s,
  scope: 'user',
  roots,
  ...over,
})

// ── scope: what the reflex is and is not in front of ─────────────────────────

test('an ordinary source edit is NOT MINE — the reflex must be cheap and absent', () => {
  const s = store()
  const v = reflex(write('/srv/cortex/cortex-v2/core/paths.ts', DEPLOY), deps(s))
  assert.equal(v.kind, 'not-mine')
})

test('a non-write tool is NOT MINE even when it names a memory file', () => {
  const s = store()
  const v = reflex(
    { tool_name: 'Read', tool_input: { file_path: MEMFILE, content: 'sk-livekey' } },
    deps(s),
  )
  assert.equal(v.kind, 'not-mine')
})

test('a project-scoped memory IS in scope — the second layout, not just the first', () => {
  // The single-root version of this resolver would have been inert for exactly
  // these writes, and inert-but-installed looks identical to working.
  const s = store()
  const projectFile = path.join(
    os.homedir(),
    '.claude',
    'projects',
    '-home-alex',
    'memory',
    'thing.md',
  )
  const v = reflex(write(projectFile, 'sk-live_aaaaaaaaaaaaaaaaaaaaaaaa'), deps(s))
  assert.equal(v.kind, 'deny')
})

test('a non-memory file under the projects root is NOT MINE', () => {
  // `projects` is a root, so without the `memory` segment requirement the reflex
  // would sit in front of every file in every project.
  const s = store()
  const f = path.join(os.homedir(), '.claude', 'projects', '-home-alex', 'notes.md')
  const v = reflex(write(f, DEPLOY), deps(s))
  assert.equal(v.kind, 'not-mine')
})

// ── secret deflection ────────────────────────────────────────────────────────

test('a credential-shaped value DENIES the write', () => {
  const s = store()
  const v = reflex(write(MEMFILE, 'The token is ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), deps(s))
  assert.equal(v.kind, 'deny')
})

test('THE DENY REASON NEVER CONTAINS THE VALUE — the leak one layer over', () => {
  // A refusal that quotes the credential in order to complain about it has
  // published it to a durable, replicated transcript. The whole SecretFinding
  // shape exists to carry a hint instead of the text; this asserts the reason
  // built from it kept that property.
  const s = store()
  const secret = 'ghp_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'
  const v = reflex(write(MEMFILE, `token: ${secret}`), deps(s))
  assert.equal(v.kind, 'deny')
  assert.ok(v.kind === 'deny' && !v.reason.includes(secret), 'the reason must not quote it')
  assert.ok(v.kind === 'deny' && v.reason.includes('credential-shaped'), 'but must say what it is')
})

test('naming a secret is fine — this matches VALUES, not names', () => {
  // The memory ABOUT the secrets architecture is the thing a name-matching
  // scanner destroys, and this fleet's memories legitimately discuss these.
  const s = store()
  const v = reflex(
    write(MEMFILE, 'Bootstrap creds BAO_ROLE_ID and BAO_SECRET_ID live in ~/.claude/.env'),
    deps(s),
  )
  assert.notEqual(v.kind, 'deny')
})

test('an Edit is judged on new_string ONLY — never on the text being removed', () => {
  // The most hostile possible false positive: denying the write whose whole
  // purpose is deleting the credential.
  const s = store()
  const v = reflex(
    {
      tool_name: 'Edit',
      tool_input: {
        file_path: MEMFILE,
        old_string: 'token: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        new_string: 'token: stored in OpenBao under kv/cortex/secrets',
      },
    },
    deps(s),
  )
  assert.notEqual(v.kind, 'deny')
})

test('every new_string of a MultiEdit is scanned, not just the first', () => {
  const s = store()
  const v = reflex(
    {
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: MEMFILE,
        edits: [
          { old_string: 'a', new_string: 'harmless prose about deployment' },
          { old_string: 'b', new_string: 'AKIAIOSFODNN7EXAMPLE1234' },
        ],
      },
    },
    deps(s),
  )
  assert.equal(v.kind, 'deny', 'a later edit must not be able to hide behind an earlier one')
})

test('pendingText ignores old_string entirely', () => {
  const text = pendingText({
    tool_name: 'Edit',
    tool_input: { old_string: 'REMOVED', new_string: 'KEPT' },
  })
  assert.ok(text.includes('KEPT'))
  assert.ok(!text.includes('REMOVED'))
})

// ── dedupe deflection ────────────────────────────────────────────────────────

test('a same-slug write INFORMS with the graph id and does not block', () => {
  const s = store()
  seed(s)
  const v = reflex(
    write(MEMFILE, `---\nname: deploy-process\n---\n\nSomething quite different.`),
    deps(s),
  )
  assert.equal(v.kind, 'inform', 'never a refusal — the writer decides')
  assert.ok(v.kind === 'inform' && v.matched.includes('existing'))
  assert.ok(v.kind === 'inform' && v.text.includes('existing'), 'the id is the payload')
})

test('the inform tells the writer how to make it rung 0', () => {
  // The whole value of this reflex is that its output is a GRAPH ID, which moves
  // the common case off the guessing rungs. Saying so is what makes it usable.
  const s = store()
  seed(s)
  const v = reflex(write(MEMFILE, `---\nname: deploy-process\n---\n\nWhatever.`), deps(s))
  assert.ok(v.kind === 'inform' && /\bid:/.test(v.text))
})

test('a near-duplicate under the estimator informs without a slug hit', () => {
  const s = store()
  seed(s)
  const v = reflex(write(MEMFILE, DEPLOY + ' Roll back with the same script.'), deps(s))
  assert.equal(v.kind, 'inform')
})

test('AN EMPTY GRAPH REPORTS ITSELF — it must not answer "no duplicates"', () => {
  // Worse than an unbuilt feature, because it REPORTS SUCCESS. Nothing currently
  // drives ingest, so on a fresh install the graph is permanently empty and
  // dedupe answers "nothing matched" on every call, forever. If ingest lands
  // months from now nobody re-tests dedupe — it has been "working" throughout.
  //
  // Same rule as seed provenance: finding nothing because there IS nothing and
  // finding nothing because you are broken must not be the same output.
  const s = store()
  const v = reflex(write(MEMFILE, `---\nname: anything\n---\n\nA memory with no corpus behind it.`), deps(s))
  assert.equal(v.kind, 'no-corpus')
  assert.equal(v.kind === 'no-corpus' && v.scope, 'user')
})

test('an empty graph contributes NO context — our incompleteness is not the model\'s problem', () => {
  // Reported to the operator, who can act on it; not to the model, where it would
  // spend another module's injection budget on our own gap.
  const s = store()
  const v = reflex(write(MEMFILE, `---\nname: x\n---\n\nSome memory text here.`), deps(s))
  assert.equal(toResponse(v), undefined)
})

test('a POPULATED graph with no match is SILENT, not no-corpus — the states are distinct', () => {
  const s = store()
  seed(s)
  const v = reflex(
    write(MEMFILE, 'The staging database lives on port 5433 and is seeded nightly from an ' +
      'anonymised dump, so never point an integration test at the production port.'),
    deps(s),
  )
  assert.equal(v.kind, 'silent')
})

test('AN UNRELATED WRITE IS SILENT — bias to split is the default, not a fallback', () => {
  const s = store()
  seed(s)
  const v = reflex(
    write(
      MEMFILE,
      'The staging database lives on port 5433 and is seeded nightly from an anonymised ' +
        'dump, so never point an integration test at the production port.',
    ),
    deps(s),
  )
  assert.equal(v.kind, 'silent')
})

test('CANNOT JUDGE SAYS NOTHING — an unjudgeable pair is not a duplicate', () => {
  // Below the token floor a Jaccard score means nothing. The reflex must not
  // convert "I cannot tell" into "these are the same", because the writer would
  // then be nudged toward a merge on the strength of no evidence at all.
  const s = store()
  seed(s, { content: 'Port is 8080.' })
  const v = reflex(write(MEMFILE, 'Port is 8081.'), deps(s))
  assert.equal(v.kind, 'silent')
})

test('a dead estimator degrades to SILENT, never to a false duplicate', () => {
  // The same property the embedding estimator asserts one layer down: a backend
  // that cannot judge must produce splits, not merges.
  const s = store()
  seed(s)
  const v = reflex(
    write(MEMFILE, DEPLOY),
    deps(s, {
      estimator: { ...LEXICAL_ESTIMATOR, name: 'dead', compare: () => null },
    }),
  )
  assert.equal(v.kind, 'silent')
})

test('the inform never reads as an instruction to fold', () => {
  // Honest about what this asserts: it is a property of the TEMPLATE, not of any
  // contradiction detection — the reflex deliberately has none, because it is
  // informing rather than deciding. What matters is that a writer who has hit a
  // genuine contradiction (near-identical text, opposite meaning — the case the
  // collapse exempts) is told that keeping both is correct, rather than being
  // nudged into reusing the id and destroying one of the two.
  const s = store()
  seed(s)
  const v = reflex(write(MEMFILE, `---\nname: deploy-process\n---\n\n${DEPLOY}`), deps(s))
  assert.ok(v.kind === 'inform' && /CONTRADICTS/.test(v.text), 'the exemption is spelled out')
  assert.ok(v.kind === 'inform' && /genuinely different/.test(v.text))
})

test('A TRUNCATED COMPARISON SET IS REPORTED — silence must not read as a clean result', () => {
  // "no duplicates found" and "no duplicates found in the 3 most recent" are the
  // same sentence with different meanings. A mechanism that can silently reduce
  // its own scope has to report the reduction.
  const s = store()
  for (let i = 0; i < 5; i++) {
    seed(s, { id: `m${i}`, name: `slug-${i}`, authoredAt: 1000 + i })
  }
  seed(s, { id: 'target', name: 'deploy-process', authoredAt: 9999 })

  const v = reflex(
    write(MEMFILE, `---\nname: deploy-process\n---\n\nreplacement`),
    deps(s, { candidateLimit: 3 }),
  )
  assert.equal(v.kind, 'inform')
  assert.ok(v.kind === 'inform' && /most recent/.test(v.text), 'the bound is stated')
})

test('provisional thresholds are labelled AT THE POINT OF USE', () => {
  const s = store()
  seed(s)
  const v = reflex(write(MEMFILE, `---\nname: deploy-process\n---\n\nx`), deps(s))
  assert.ok(v.kind === 'inform' && /provisional/.test(v.text))
})

test('the default candidate limit is a stated bound, not an accident', () => {
  assert.equal(typeof DEFAULT_CANDIDATE_LIMIT, 'number')
  assert.ok(DEFAULT_CANDIDATE_LIMIT > 0)
})

// ── the harness translation ──────────────────────────────────────────────────

test('toResponse maps the three outcomes onto the two proven channels', () => {
  assert.deepEqual(toResponse({ kind: 'not-mine' }), undefined)
  assert.deepEqual(toResponse({ kind: 'silent' }), undefined)
  assert.deepEqual(toResponse({ kind: 'deny', reason: 'r', findings: [] }), {
    decision: 'deny',
    reason: 'r',
  })
  assert.deepEqual(toResponse({ kind: 'inform', text: 't', matched: ['a'] }), {
    additionalContext: 't',
  })
})

test('DEDUPE NEVER PRODUCES A DECISION — informing and refusing are different acts', () => {
  // The constraint that keeps this from becoming an auto-merge by another route:
  // if a duplicate could deny, a false positive would block a legitimate write
  // and the pressure would be to relax the scanner that catches secrets.
  const s = store()
  seed(s)
  const v = reflex(write(MEMFILE, `---\nname: deploy-process\n---\n\nx`), deps(s))
  const r = toResponse(v)
  assert.ok(r && 'additionalContext' in r, 'context, never a decision')
})

// ── scope derivation ─────────────────────────────────────────────────────────

test('scope comes from the path, because the layout already encodes it', () => {
  assert.equal(scopeForPath(path.join(ROOT, 'x.md')), 'user')
  assert.equal(
    scopeForPath(path.join(os.homedir(), '.claude', 'projects', '-home-alex', 'memory', 'x.md')),
    '-home-alex',
  )
})

test('the reflex ALSO trusts a declared root — same trap, same fix', () => {
  // `underMemoryRoot` required a `memory` segment unconditionally, so a user who
  // pointed CKN_MEMORY_DIRS at a differently-named directory got a reflex that
  // silently never fired on it — no secret gate, no dedupe, no report.
  const s = store()
  const odd = path.join(os.homedir(), '.claude', 'notes')
  const file = path.join(odd, 'creds.md')

  const untrusted = reflex(write(file, 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), {
    store: s,
    scope: 'user',
    roots: [odd],
  })
  assert.equal(untrusted.kind, 'not-mine', 'defaulted roots still need the segment')

  process.env.CKN_MEMORY_DIRS = odd
  try {
    const trusted = reflex(write(file, 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), {
      store: s,
      scope: 'user',
      roots: [odd],
    })
    assert.equal(trusted.kind, 'deny', 'a declared root is in scope')
  } finally {
    delete process.env.CKN_MEMORY_DIRS
  }
})
