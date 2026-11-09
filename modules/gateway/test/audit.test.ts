import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { Audit, auditFile, verifyAudit } from '../server/audit.js'
import { Crossings, metricsFile, renderMetrics, writeMetrics } from '../server/metrics.js'

const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-audit-'))
  dirs.push(d)
  return d
}
const fill = (d: string) => {
  const a = new Audit(d)
  a.write({ dir: 'in', peer: 'partner', principal: 'acme-dev/alex', kind: 'message', decision: 'admitted', rule: 'exposed', payloadHash: 'x' })
  a.write({ dir: 'in', peer: 'partner', decision: 'refused', rule: 'kind filter' })
  a.write({ dir: 'out', peer: 'partner', principal: 'pm/pm', decision: 'held', rule: 'secret gate: aws' })
  a.write({ dir: 'link', peer: '203.0.113.9', decision: 'banned', rule: 'banned for 60 min after 5 failures' })
}
const lines = (d: string) => fs.readFileSync(auditFile(d), 'utf-8').trimEnd().split('\n')
const put = (d: string, ls: string[]) => fs.writeFileSync(auditFile(d), ls.join('\n') + '\n')

test('the chain verifies, survives a reopen, and detects an edited, removed or reordered line, naming it', () => {
  const d = tmp()
  fill(d)
  new Audit(d).write({ dir: 'out', peer: 'partner', decision: 'read', rule: 'peer read' })
  assert.deepEqual(verifyAudit(d), { ok: true, lines: 5 }, 'a reopened audit continues the chain')
  const good = lines(d)

  put(d, good.map((l, i) => (i === 1 ? l.replace('"refused"', '"admitted"') : l)))
  assert.deepEqual(verifyAudit(d), { ok: false, line: 2, why: 'its content does not match its hash' })
  put(d, good.filter((_, i) => i !== 2))
  assert.deepEqual(verifyAudit(d), { ok: false, line: 3, why: 'seq 4, expected 3' })
  put(d, [good[0]!, good[2]!, good[1]!, ...good.slice(3)])
  assert.equal(verifyAudit(d).ok, false)
  put(d, good.map((l, i) => (i === 3 ? 'garbage' : l)))
  assert.deepEqual(verifyAudit(d), { ok: false, line: 4, why: 'not JSON' })
})

test('metrics: crossings counted from the chain (so a restart keeps them), gauges, and a ban never adds a label per address', () => {
  const d = tmp()
  fill(d)
  const c = new Crossings(d)
  c.count({ dir: 'in', peer: 'partner', decision: 'admitted', rule: 'exposed' })
  const text = renderMetrics(c, { peers: [{ domain: 'partner', linked: true }, { domain: 'ht', linked: false }], paths: 2, mailbox: 1, banned: 1, auditLines: 4, auditOk: true })
  assert.match(text, /^# TYPE cortex_gateway_crossings_total counter$/m)
  assert.match(text, /^cortex_gateway_crossings_total\{dir="in",decision="admitted",peer="partner"\} 2$/m)
  assert.match(text, /^cortex_gateway_crossings_total\{dir="out",decision="held",peer="partner"\} 1$/m)
  assert.match(text, /^cortex_gateway_crossings_total\{dir="link",decision="banned",peer="-"\} 1$/m)
  assert.doesNotMatch(text, /203\.0\.113\.9/)
  assert.match(text, /^cortex_gateway_peer_linked\{peer="ht"\} 0$/m)
  assert.match(text, /^cortex_gateway_return_paths 2$/m)
  assert.match(text, /^cortex_gateway_audit_ok 1$/m)

  const extra = tmp()
  writeMetrics(d, text, { CKN_GATEWAY_TEXTFILE_DIR: extra })
  assert.equal(fs.readFileSync(metricsFile(d), 'utf-8'), text)
  assert.equal(fs.readFileSync(metricsFile(extra), 'utf-8'), text, "also into node_exporter's textfile dir")
})
