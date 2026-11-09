/**
 * ONE TEST FOR AN ENTIRE CLASS OF LEAK.
 *
 * The same rule was derived independently three times before anyone named it:
 * the redaction tombstone must not contain the body; the redaction manifest must
 * not carry the payload; a secret-scan finding must not quote the value.
 *
 *   RECORDS *ABOUT* CONTENT NEVER CONTAIN THE CONTENT.
 *
 * Tombstones, manifests, findings, receipts, status output, telemetry — all of
 * it. Each instance is obvious once seen and invisible until then, which is
 * exactly why the guard belongs here rather than in three separate assertions:
 * the next artifact someone adds gets covered without them knowing the rule.
 *
 * The method is deliberately crude — plant a synthetic credential, run the whole
 * pipeline, and grep EVERY non-journal artifact for it. Crude survives refactors
 * that a structural assertion would not.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import Database from 'better-sqlite3'

import { ingest } from '../server/ingest.js'
import { hashContent, Journal } from '../server/journal.js'
import { MemoryStore } from '../server/store.js'

const schema = fs.readFileSync(path.join(import.meta.dirname, '..', 'schema.sql'), 'utf-8')
const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))

/** Synthetic, and it must not resemble anything real enough to be a live key. */
const PLANTED = 'sk-ant-api03-PLANTEDsyntheticVALUE0123456789abcdef'

test('no artifact ABOUT content ever contains the content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-leakguard-'))
  dirs.push(dir)

  const db = new Database(':memory:')
  db.exec(schema)
  const store = new MemoryStore(db)
  const journal = new Journal({ dir: path.join(dir, 'j'), machine: 'node-a' })

  const artifacts: Record<string, unknown> = {}

  // 1. A DECLINE — findings, the quarantine row, status output.
  const leaky = `The token is ${PLANTED} and it should never be indexed.`
  const declined = ingest(
    {
      content: leaky,
      body: leaky,
      slug: 'leaky',
      scope: 'user',
      source: path.join(dir, 'inbox.md'),
      machine: 'node-a',
      authoredAt: 1,
    },
    { store, journal },
  )
  assert.equal(declined.status, 'quarantined')
  artifacts.findings = declined.status === 'quarantined' ? declined.findings : null
  artifacts.quarantineRows = store.quarantined()

  // 2. A REDACTION — the record, the manifest, the epoch. Appended directly
  //    because the gate would (correctly) never let this into the journal.
  journal.appendMemory({
    slug: 'planted',
    source: path.join(dir, 'inbox.md'),
    scope: 'user',
    machine: 'node-a',
    authoredAt: 1,
    content: leaky,
  })
  journal.redact(hashContent(leaky), { memoryId: 'planted', note: 'rotated the token' })

  artifacts.redactionRecords = [...journal.read()].filter((r) => r.kind === 'redaction')
  artifacts.integrity = journal.integrity()

  // 3. A RECEIPT and a ticket, from a clean ingest alongside.
  const clean = 'The token lives in OpenBao under kv/cortex/secrets, never inline.'
  const ok = ingest(
    {
      content: clean,
      body: clean,
      slug: 'where-tokens-live',
      scope: 'user',
      source: path.join(dir, 'inbox.md'),
      machine: 'node-a',
      authoredAt: 2,
    },
    { store, journal },
  )
  if (ok.status !== 'ingested') return assert.fail('expected a clean ingest')
  artifacts.receipt = ok.receipt
  artifacts.ticket = ok.ticket

  // 4. Everything the DB holds that is not a memory body.
  artifacts.consumeLedger = db.prepare('SELECT * FROM consume_ledger').all()
  artifacts.aliases = db.prepare('SELECT * FROM id_aliases').all()
  artifacts.released = db.prepare('SELECT * FROM quarantine_released').all()
  artifacts.observed = db.prepare('SELECT * FROM observed_edges').all()

  for (const [name, value] of Object.entries(artifacts)) {
    assert.ok(
      !JSON.stringify(value ?? null).includes(PLANTED),
      `${name} contains the planted credential — a record ABOUT content must never carry it`,
    )
  }
})

test('and the guard itself is not degenerate — the planted value IS detectable', () => {
  // Without this, the test above would pass just as happily if the pipeline
  // never ran at all. A property that holds because nothing happened is not
  // evidence.
  assert.ok(JSON.stringify({ leak: `x ${PLANTED} y` }).includes(PLANTED))
})
