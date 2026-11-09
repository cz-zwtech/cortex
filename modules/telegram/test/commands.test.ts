import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'

import { handleCommands, roleOf, type CommandMessage, type CommandPort } from '../server/commands.js'
import { make, tmp, update } from './harness.js'

class FakePort implements CommandPort {
  waiting: CommandMessage[] = []
  seen: string[] = []
  replies: { to: string; body: Record<string, { ok: boolean; nonce?: string; result?: Record<string, unknown>; error?: string; status?: number }>; files?: string[]; fileData?: unknown }[] = []
  async inbox() {
    return this.waiting.filter((m) => !this.seen.includes(m.id))
  }
  markSeen(ids: string[]) {
    this.seen.push(...ids)
  }
  async reply(to: string, body: string, files?: string[]) {
    // Read the files now: the handler removes its working copies once sent, as comms has snapshotted them.
    this.replies.push({ to, body: JSON.parse(body), files, fileData: files?.map((f) => JSON.parse(fs.readFileSync(f, 'utf-8'))) })
    return true
  }
}

let n = 0
const cmd = (from: string, c: Record<string, unknown>): CommandMessage => ({ id: `m${++n}`, from, body: JSON.stringify({ nonce: `n${n}`, ...c }) })

test('the sender role comes from the node label, local or remote', () => {
  assert.equal(roleOf('node-b:pm/pm'), 'pm')
  assert.equal(roleOf('globex-dev/globex-dev-1'), 'globex-dev')
  assert.equal(roleOf('node-a:globex-dev/globex-dev-1'), 'globex-dev')
  assert.equal(roleOf('BAD'), undefined)
})

test('ack over comms acts as the sending role, whatever the body claims (D5)', async () => {
  const { gw } = make()
  const { id } = gw.publish({ source: 'gpu', owner: 'globex-dev', severity: 'action', title: 't' })
  const port = new FakePort()
  port.waiting.push(cmd('node-a:globex-dev/globex-dev-1', { command: 'ack', item: id, resolution: 'handled', session: 'ops-dev', sender: 'ops-dev' }))
  await handleCommands(gw, port, tmp(), () => {})
  assert.equal(gw.show(id!).acked_by, 'globex-dev')
  const r = port.replies[0]!
  assert.equal(r.to, 'node-a:globex-dev/globex-dev-1')
  assert.equal(r.body.commandResult!.nonce, `n${n}`)
  assert.equal(r.body.commandResult!.ok, true)
})

test('replies and show come back as files, never in the body; the working copies are removed', async () => {
  const { gw } = make()
  const id = await gw.handleUpdate('dev', update('globex-dev the secret plan is $(x)'))
  const item = gw.publish({ source: 'gpu', owner: 'globex-dev', severity: 'action', title: 'producer title', body: 'producer body' })
  const port = new FakePort()
  const out = tmp()
  port.waiting.push(cmd('node-b:globex-dev/m', { command: 'replies', id }), cmd('node-b:globex-dev/m', { command: 'show', item: item.id }))
  await handleCommands(gw, port, out, () => {})
  for (const r of port.replies) {
    const body = JSON.stringify(r.body)
    assert.ok(!body.includes('secret plan') && !body.includes('producer body'), 'no text in a body')
    assert.equal(r.files?.length, 1)
  }
  assert.equal((port.replies[0]!.fileData as { text: string }[][])[0]![0]!.text, 'globex-dev the secret plan is $(x)')
  assert.equal((port.replies[1]!.fileData as { body: string }[])[0]!.body, 'producer body')
  assert.deepEqual(fs.readdirSync(out), [])
})

test('an unknown verb, a bad request or an unknown role gets an error reply; chatter that is not a command is ignored', async () => {
  const { gw } = make()
  const port = new FakePort()
  port.waiting.push(
    cmd('node-b:pm/pm', { command: 'explode' }),
    cmd('node-b:stranger/s', { command: 'claim', id: 1 }),
    { id: 'chat', from: 'node-b:pm/pm', body: 'hello notify, how are you' },
  )
  await handleCommands(gw, port, tmp(), () => {})
  assert.equal(port.replies.length, 2)
  assert.match(port.replies[0]!.body.commandResult!.error!, /unknown telegram command/)
  assert.equal(port.replies[1]!.body.commandResult!.status, 403)
  assert.deepEqual(port.seen.sort(), ['chat', `m${n - 1}`, `m${n}`].sort(), 'every message is marked seen once')
})

test('send over comms carries the role as its prefix, and claim names the role', async () => {
  const { gw, channel } = make()
  const port = new FakePort()
  port.waiting.push(cmd('node-b:ops-dev/o', { command: 'send', text: 'which branch?', topic: 'T7' }))
  await handleCommands(gw, port, tmp(), () => {})
  assert.equal(channel.sent[0]!.text, 'ops-dev -- which branch?')
  const id = await gw.handleUpdate('dev', update('nobody owns this'))
  port.waiting.push(cmd('node-a:globex-dev/m', { command: 'claim', id }))
  await handleCommands(gw, port, tmp(), () => {})
  assert.deepEqual(port.replies.at(-1)!.body.commandResult!.result, { won: true, owner: 'globex-dev' })
})
