import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import Database from 'better-sqlite3'

import {
  annotateDeclines,
  consume,
  STUB_LINE,
  splitScratchpad,
  type ConsumeTicket,
} from '../server/consume.js'
import { ingest, type IngestInput } from '../server/ingest.js'
import { hashContent, Journal } from '../server/journal.js'
import { MemoryStore } from '../server/store.js'

const schema = fs.readFileSync(path.join(import.meta.dirname, '..', 'schema.sql'), 'utf-8')
const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))

const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-consume-'))
  dirs.push(d)
  return d
}

const memo = (slug: string, body: string) => `---\nname: ${slug}\n---\n\n${body}\n`

const A = 'The release script lives at bin/release.sh and takes the tag as its only argument.'
const B = 'Staging runs on port 5433 and is seeded nightly from an anonymised production dump.'
const C = 'Metrics dashboards are provisioned from the repo, never edited in the UI directly.'

// ── splitting ────────────────────────────────────────────────────────────────

test('a scratchpad splits into one block per memory', () => {
  const blocks = splitScratchpad([memo('a', A), memo('b', B)].join('\n'))
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0]!.body, A)
  assert.equal(blocks[1]!.body, B)
})

test('a memory written WITHOUT frontmatter is still a memory', () => {
  // Dropping it as unparseable would lose it, and the design criterion is that
  // a session which never read our instructions must still be safe.
  const blocks = splitScratchpad(`${A}\n\n${memo('b', B)}`)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0]!.body, A)
})

test('block hashes match what ingest hashes, or nothing would ever be dropped', () => {
  const blocks = splitScratchpad(memo('a', A))
  assert.equal(blocks[0]!.hash, hashContent(A))
})

// ── drop by proof ────────────────────────────────────────────────────────────

const ticket = (source: string, ...bodies: string[]): ConsumeTicket => ({
  source,
  hashes: bodies.map(hashContent),
  mintedAt: 1,
})

test('consume drops ONLY what the ticket names', () => {
  const file = path.join(tmp(), 'inbox.md')
  fs.writeFileSync(file, [memo('a', A), memo('b', B)].join('\n'))

  const out = consume(ticket(file, A))
  assert.equal(out.dropped, 1)
  assert.equal(out.retained, 1)

  const left = fs.readFileSync(file, 'utf-8')
  assert.ok(!left.includes(A), 'the ingested memory is gone')
  assert.ok(left.includes(B), 'the un-ticketed one is not')
})

test('PARTIAL CONSUME is automatic — no special case', () => {
  // Two clean memories and one declined: the ticket carries two hashes, the
  // rewrite retains the third, and nothing in consume knows about quarantine.
  const file = path.join(tmp(), 'inbox.md')
  fs.writeFileSync(file, [memo('a', A), memo('b', B), memo('c', C)].join('\n'))

  const out = consume(ticket(file, A, C))
  assert.equal(out.dropped, 2)
  assert.equal(out.retained, 1)
  assert.equal(fs.readFileSync(file, 'utf-8').includes(B), true)
})

test('an un-ticketed file is left completely alone', () => {
  const file = path.join(tmp(), 'inbox.md')
  const original = [memo('a', A), memo('b', B)].join('\n')
  fs.writeFileSync(file, original)

  const out = consume({ source: file, hashes: [], mintedAt: 1 })
  assert.equal(out.dropped, 0)
  assert.equal(fs.readFileSync(file, 'utf-8'), original, 'untouched, byte for byte')
})

test('a DECLINED memory survives consume, because no ticket names it', () => {
  // The end-to-end version of the coupling argument: quarantine keeps no copy,
  // so the scratchpad must keep it — and the reason it does is structural.
  const dir = tmp()
  const file = path.join(dir, 'inbox.md')
  const secret = 'The key is ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA and it must not sync.'
  fs.writeFileSync(file, [memo('a', A), memo('leak', secret)].join('\n'))

  const db = new Database(':memory:')
  db.exec(schema)
  const store = new MemoryStore(db)
  const journal = new Journal({ dir: path.join(dir, 'j'), machine: 'node-a' })

  const mk = (body: string, slug: string): IngestInput => ({
    content: memo(slug, body),
    body,
    slug,
    scope: 'user',
    source: file,
    machine: 'node-a',
    authoredAt: 1,
  })

  const clean = ingest(mk(A, 'a'), { store, journal })
  const declined = ingest(mk(secret, 'leak'), { store, journal })

  assert.equal(declined.status, 'quarantined')
  assert.equal(declined.ticket, null)
  if (clean.status !== 'ingested') return assert.fail()

  consume(clean.ticket)

  const left = fs.readFileSync(file, 'utf-8')
  assert.ok(left.includes(secret), 'the only copy is still there')
  assert.ok(!left.includes(A), 'and the clean one was consumed')
})

// ── convergence ──────────────────────────────────────────────────────────────

test('a concurrent append survives BY IDENTITY, not by timing', () => {
  // The C7 residual: an append landing in the read-modify-write gap. Its hash is
  // not in the ticket, so it is retained however the timing falls — and the
  // convergent re-read catches the write that raced us.
  const file = path.join(tmp(), 'inbox.md')
  fs.writeFileSync(file, memo('a', A))

  let wrote = 0
  const out = consume(ticket(file, A), {
    writeFile: ((p: string, data: string, enc: BufferEncoding) => {
      fs.writeFileSync(p, data, enc)
      // Simulate a session appending in the gap, exactly once.
      if (wrote++ === 0) fs.appendFileSync(p, '\n' + memo('b', B))
    }) as typeof fs.writeFileSync,
  })

  assert.ok(out.retries >= 1, 'the mismatch was detected')
  const left = fs.readFileSync(file, 'utf-8')
  assert.ok(left.includes(B), 'the concurrent append survived')
  assert.ok(!left.includes(A), 'and the ticketed memory still went')
})

test('a relentless concurrent writer cannot make consume spin', () => {
  // This asserted a retry count of 3 in an earlier revision and the count was 1,
  // because the loop converges for a better reason than the retry bound:
  // ONCE THE TICKETED CONTENT IS GONE THE DROP SET IS EMPTY, so the next pass
  // returns immediately no matter how much a concurrent writer appends. The
  // bound is a backstop for a case this design makes hard to reach, and the
  // property worth asserting is termination plus safety — not a number.
  const file = path.join(tmp(), 'inbox.md')
  fs.writeFileSync(file, memo('a', A))

  let appends = 0
  const out = consume(ticket(file, A), {
    writeFile: ((p: string, data: string, enc: BufferEncoding) => {
      fs.writeFileSync(p, data, enc)
      appends++
      fs.appendFileSync(p, '\n' + memo(`x${appends}`, `Append number ${appends} racing the drop.`))
    }) as typeof fs.writeFileSync,
    maxRetries: 2,
  })

  assert.ok(out.retries <= 3, 'terminates rather than spinning')
  assert.ok(!fs.readFileSync(file, 'utf-8').includes(A), 'the ticketed memory went')
  assert.ok(fs.readFileSync(file, 'utf-8').includes('racing the drop'), 'the racer survived')
})

test('the retry bound gives up in the SAFE direction when it is reached', () => {
  // Re-running ingest is idempotent (rung 2), so leaving the scratchpad
  // populated costs nothing. Looping forever, or dropping content to escape the
  // loop, both cost a great deal. Forced by a writer that keeps re-adding the
  // ticketed content itself, which is the only way to actually reach the bound.
  const file = path.join(tmp(), 'inbox.md')
  fs.writeFileSync(file, memo('a', A))

  const out = consume(ticket(file, A), {
    writeFile: ((p: string, data: string, enc: BufferEncoding) => {
      fs.writeFileSync(p, data, enc)
      fs.appendFileSync(p, '\n' + memo('a', A))
    }) as typeof fs.writeFileSync,
    maxRetries: 2,
  })

  assert.equal(out.retries, 3, 'bounded rather than infinite')
  assert.ok(fs.readFileSync(file, 'utf-8').includes(A), 'and it stopped WITHOUT losing content')
})

// ── 1a: the decline receipt the WRITER actually sees ─────────────────────────

const SECRETY = 'The key is ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA and it must not sync.'

test('a decline receipt lands in the scratchpad, next to the held memory', () => {
  // The quarantine table tells the SYSTEM. The party who can fix it looks at
  // the FILE. Without this the queue depends on someone checking status.
  const file = path.join(tmp(), 'inbox.md')
  fs.writeFileSync(file, [memo('a', A), memo('leak', SECRETY)].join('\n'))

  annotateDeclines(file, [
    { hash: hashContent(SECRETY), findings: [{ kind: 'provider-prefix', line: 1, hint: 'known credential prefix' }] },
  ])

  const text = fs.readFileSync(file, 'utf-8')
  assert.match(text, /cortex:held/)
  assert.match(text, /HAS NOT LEFT THIS MACHINE/)
  assert.match(text, /cortex-memory\.ts release [0-9a-f]{12}/, 'and it names the false-positive escape')
  assert.ok(text.indexOf('cortex:held') > text.indexOf(A), 'placed at the held block, not the top')
})

test('the receipt NEVER changes the block hash', () => {
  // If it did, every re-scan would look like new content: idempotency breaks,
  // edit-to-fix never matches its own decline row, and the marker is re-added
  // forever.
  const file = path.join(tmp(), 'inbox.md')
  fs.writeFileSync(file, memo('leak', SECRETY))
  const before = splitScratchpad(fs.readFileSync(file, 'utf-8'))[0]!.hash

  annotateDeclines(file, [{ hash: before, findings: [{ kind: 'x', line: 1, hint: 'h' }] }])

  const after = splitScratchpad(fs.readFileSync(file, 'utf-8'))[0]!.hash
  assert.equal(after, before, 'annotation is invisible to hashing')
})

test('re-annotating unchanged content rewrites the same bytes', () => {
  const file = path.join(tmp(), 'inbox.md')
  fs.writeFileSync(file, memo('leak', SECRETY))
  const notice = { hash: hashContent(SECRETY), findings: [{ kind: 'x', line: 1, hint: 'h' }] }

  annotateDeclines(file, [notice])
  const once = fs.readFileSync(file, 'utf-8')
  annotateDeclines(file, [notice])
  annotateDeclines(file, [notice])

  assert.equal(fs.readFileSync(file, 'utf-8'), once, 'notices do not stack')
})

test('fixing the memory clears its receipt', () => {
  const file = path.join(tmp(), 'inbox.md')
  fs.writeFileSync(file, memo('leak', SECRETY))
  annotateDeclines(file, [{ hash: hashContent(SECRETY), findings: [{ kind: 'x', line: 1, hint: 'h' }] }])
  assert.match(fs.readFileSync(file, 'utf-8'), /cortex:held/)

  // The writer edits it; nothing is declined any more.
  fs.writeFileSync(file, memo('leak', 'The GitHub token lives in OpenBao, never inline.'))
  const out = annotateDeclines(file, [])

  assert.equal(out.annotated, 0)
  assert.doesNotMatch(fs.readFileSync(file, 'utf-8'), /cortex:held/)
})

test('a receipt never quotes the value it is about', () => {
  const file = path.join(tmp(), 'inbox.md')
  fs.writeFileSync(file, memo('leak', SECRETY))
  annotateDeclines(file, [
    { hash: hashContent(SECRETY), findings: [{ kind: 'provider-prefix', line: 1, hint: 'known credential prefix' }] },
  ])

  const marker = fs.readFileSync(file, 'utf-8').match(/<!-- cortex:held[\s\S]*?-->/)![0]
  assert.ok(!marker.includes('ghp_AAAA'), 'records about content never contain the content')
})

test('an annotated block does not MERGE into the one above it', () => {
  // The seam bug. splitScratchpad starts a block at a fence preceded by a blank
  // line; without a trailing blank line after the marker, the fence stopped
  // being a block start and two memories silently became one — with a new hash
  // matching no ticket and no decline row. Invisible to every unit test here,
  // because annotation and splitting were each individually correct.
  const file = path.join(tmp(), 'inbox.md')
  fs.writeFileSync(file, [memo('a', A), memo('leak', SECRETY)].join('\n'))

  annotateDeclines(file, [
    { hash: hashContent(SECRETY), findings: [{ kind: 'x', line: 1, hint: 'h' }] },
  ])

  const blocks = splitScratchpad(fs.readFileSync(file, 'utf-8'))
  assert.equal(blocks.length, 2, 'still two memories after annotation')
  assert.deepEqual(blocks.map((b) => b.hash), [hashContent(A), hashContent(SECRETY)])
})

// ── stubs ────────────────────────────────────────────────────────────────────

test('the stub alone is not a memory, wherever it sits', () => {
  assert.deepEqual(splitScratchpad(STUB_LINE + '\n'), [])
  assert.deepEqual(splitScratchpad('  ' + STUB_LINE), [])
  const blocks = splitScratchpad([STUB_LINE, '', memo('a', A)].join('\n'))
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]!.body, A)
})

test('consume without a stub source still just drops', () => {
  const file = path.join(tmp(), 'm.md')
  fs.writeFileSync(file, memo('a', A))
  consume(ticket(file, A))
  assert.equal(fs.readFileSync(file, 'utf-8'), '')
})
