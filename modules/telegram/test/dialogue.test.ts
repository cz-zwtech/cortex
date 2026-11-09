import assert from 'node:assert/strict'
import { test } from 'node:test'

import { receivedRecords, sentRecord } from '../server/dialogue.js'

test("an operator message and the session's reply are two records, linked by the inbound id", () => {
  const [inbound] = receivedRecords('game-dev-1', [{ id: 68, bot: 'dev', at: '2026-10-26T14:49:11Z', operator: 'alex', text: 'Ship the boss fight first.' }])
  const reply = sentRecord('game-dev-1', 'On it.', { replyTo: '68', outboundId: '12' })
  assert.deepEqual([inbound!.id, inbound!.from, inbound!.member], ['in:68', { kind: 'operator', name: 'alex' }, 'game-dev-1'])
  assert.deepEqual([reply.id, reply.replyTo, reply.from.name], ['out:12', 'in:68', 'game-dev-1'])
})

test('rows without text are not dialogue', () => {
  assert.deepEqual(receivedRecords('m', [{ id: 1, text: '' }, { id: 2 }]), [])
})
