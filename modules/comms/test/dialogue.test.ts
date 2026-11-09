import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { appendDialogue, isProtocolBody } from '../../../core/dialogue.js'
import { busRecord } from '../server/dialogue.js'
import type { Envelope } from '../server/types.js'

const dirs: string[] = []
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))

const msg = (over: Partial<Envelope> = {}): Envelope => ({ v: 1, type: 'msg', stamp: 1793000000000, from: 'lead/lead-1', to: 'alpha-dev', body: 'Use the log, not a queue.', ...over })

test('a session-to-session message is dialogue; the same message has the same id on sender and receiver', () => {
  const sent = busRecord(msg(), 'lead-1')!
  const got = busRecord(msg(), 'role:alpha-dev')!
  assert.equal(sent.id, got.id)
  assert.deepEqual([sent.source, sent.from, sent.to, sent.member], ['bus', { kind: 'member', name: 'lead-1' }, { kind: 'role', name: 'alpha-dev' }, 'lead-1'])
  assert.equal(busRecord(msg({ ref: 'node.7' }), 'lead-1')!.replyTo, 'node.7', 'replies keep their chain (relay markers)')
  assert.equal(busRecord(msg({ foreign: { domain: 'partner', human: 'bob', role: 'beta-dev' } as Envelope['foreign'], notify: true }), 'role:alpha-dev')!.source, 'external', 'a message from another organisation is not home dialogue')
})

test('protocol is not dialogue: commands, results, silent replies, mesh notices and non-messages', () => {
  assert.equal(busRecord(msg({ body: '{"command":"send","text":"hi","nonce":"ab"}' }), 'x'), undefined)
  assert.equal(busRecord(msg({ silent: true }), 'x'), undefined)
  assert.equal(busRecord(msg({ from: 'cortex-mesh' }), 'x'), undefined)
  assert.equal(busRecord(msg({ type: 'claim' }), 'x'), undefined)
  assert.equal(busRecord(msg({ body: '' }), 'x'), undefined)
  assert.equal(isProtocolBody('{ not json'), false, 'prose that starts with a brace is still prose')
})

test('each writer appends to its own feed file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-dialogue-'))
  dirs.push(root)
  appendDialogue('comms', 'send', [busRecord(msg(), 'lead-1')!], root)
  appendDialogue('comms', 'receive', [busRecord(msg(), 'role:alpha-dev')!], root)
  assert.deepEqual(fs.readdirSync(path.join(root, 'comms', 'dialogue')).sort(), ['receive.ndjson', 'send.ndjson'])
})
