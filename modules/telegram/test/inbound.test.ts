import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { kvGet } from '../server/db.js'
import { explicitAddress, Rejected } from '../server/gateway.js'
import { config, make, OPERATOR, update } from './harness.js'

test('a message from the wrong chat or the wrong person is dropped, counted, and still advances the offset', async () => {
  const { gw, db } = make()
  assert.equal(await gw.handleUpdate('dev', update('hi', { chat: '999', id: 10 })), undefined)
  assert.equal(await gw.handleUpdate('dev', update('hi', { from: '999', id: 11 })), undefined)
  assert.equal(kvGet(db, 'dev:dropped_unauthorised'), '2')
  assert.equal(kvGet(db, 'dev:offset'), '12')
  assert.equal(gw.replies().length, 0)
})

test('a row from someone who is no longer an operator is never served on read', async () => {
  const { gw, db } = make()
  const id = await gw.handleUpdate('dev', update('mine'))
  db.prepare('UPDATE inbound SET from_id = ? WHERE id = ?').run('777', id)
  assert.equal(gw.replies().length, 0)
})

test('an unmatched message is stored unrouted; the same update twice is stored once', async () => {
  const { gw, db } = make()
  const u = update('hello there', { id: 50 })
  const id = await gw.handleUpdate('dev', u)
  assert.equal(await gw.handleUpdate('dev', u), undefined)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM inbound').get() as { n: number }).n, 1)
  assert.equal(gw.replies({ id })[0]!.route_to, null)
})

test('a failure while storing rolls back the row AND the offset together; a re-read stores it once', async () => {
  const { gw, db } = make()
  db.exec("CREATE TRIGGER boom BEFORE INSERT ON kv WHEN NEW.key = 'dev:offset' BEGIN SELECT RAISE(ABORT, 'injected'); END")
  await assert.rejects(gw.handleUpdate('dev', update('x', { id: 1 })), /injected/)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM inbound').get() as { n: number }).n, 0)
  db.exec('DROP TRIGGER boom')
  await gw.handleUpdate('dev', update('x', { id: 1 }))
  await gw.handleUpdate('dev', update('x', { id: 1 }))
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM inbound').get() as { n: number }).n, 1)
  assert.equal(kvGet(db, 'dev:offset'), '2')
})

test('explicit address: longest known name first; a hyphen does not end a name; unknown names never match', () => {
  assert.equal(explicitAddress('ops-dev please look', ['ops-dev', 'ops']), 'ops-dev')
  assert.equal(explicitAddress('ops-development is down', ['ops-dev']), undefined)
  assert.equal(explicitAddress('ops-dev-2 hi', ['ops-dev']), undefined)
  assert.equal(explicitAddress('  OPS-DEV: hi', ['ops-dev']), 'ops-dev')
  assert.equal(explicitAddress('ops-dev', ['ops-dev']), 'ops-dev')
})

test('an explicit address beats a thread; a thread reply routes to its sender and topic, and wakes it by reference', async () => {
  const { gw, mesh, channel } = make()
  const sent = await gw.send({ sender: 'ops-dev', text: 'which branch?', topic: 'ACME-6' })
  const msgId = channel.sent[0]!.message_id
  assert.equal(sent.message_id, msgId)
  const a = await gw.handleUpdate('dev', update('globex-dev take this', { replyTo: msgId }))
  assert.equal(gw.replies({ id: a })[0]!.route_to, 'globex-dev')
  const b = await gw.handleUpdate('dev', update('main', { replyTo: msgId }))
  const row = gw.replies({ id: b })[0]!
  assert.deepEqual([row.route_to, row.topic], ['ops-dev', 'ACME-6'])
  const wake = mesh.sent.find((s) => s.body.includes(`replies --id ${b}`))!
  assert.equal(wake.to, 'ops-dev')
  assert.doesNotMatch(wake.body, /main/)
})

test('a reply to a fallback routes to the item owner, with the item id as the topic', async () => {
  const { gw, clock, channel } = make()
  const { id } = gw.publish({ source: 'gpu', owner: 'globex-dev', severity: 'page', title: 'down' })
  clock.advance(300)
  await gw.tick()
  const r = await gw.handleUpdate('dev', update('on it', { replyTo: channel.sent[0]!.message_id }))
  const row = gw.replies({ id: r })[0]!
  assert.deepEqual([row.route_to, row.topic], ['globex-dev', id])
})

test('a producer cannot steer replies: an owner it named is not an explicit-address name (brief defect 1)', async () => {
  const { gw, clock } = make()
  gw.publish({ source: 'evil', owner: 'yes', severity: 'page', title: 'x' })
  clock.advance(300)
  await gw.tick()
  const r = await gw.handleUpdate('dev', update('yes do it'))
  assert.equal(gw.replies({ id: r })[0]!.route_to, null, 'the bare approval stays unrouted, for the claim flow')
})

test('a tag routes to its last asker, else the configured default; a tag in the replied-to text counts', async () => {
  const cfg = config({ bots: [{ id: 'dev', identity: { username: '@test_bot' }, token: { from: 'env', name: 'T' }, operators: [{ name: 'alex', chat: { from: 'env', name: 'C' } }], fallbackTo: 'alex', tags: [{ pattern: 'ACME-\\d+', defaultOwner: 'acme-dev' }] }] })
  const { gw } = make({ config: cfg })
  const a = await gw.handleUpdate('dev', update('about [ACME-9] yes'))
  assert.deepEqual([gw.replies({ id: a })[0]!.route_to, gw.replies({ id: a })[0]!.topic], ['acme-dev', 'ACME-9'])
  await gw.send({ sender: 'ops-dev', text: 'q', topic: 'ACME-9' })
  const b = await gw.handleUpdate('dev', update('fine', { replyTo: 424242, replyText: '[ACME-9] q' }))
  assert.equal(gw.replies({ id: b })[0]!.route_to, 'ops-dev')
})

test('nothing matches: never guessed; the claim request goes only to roles with a live member, by reference', async () => {
  const { gw, mesh } = make()
  const id = await gw.handleUpdate('dev', update('who owns this?'))
  assert.equal(gw.replies({ id })[0]!.route_to, null)
  assert.deepEqual(mesh.sent.map((s) => s.to).sort(), ['node-a:ops-dev', 'node-b:globex-dev'])
  assert.ok(mesh.sent.every((s) => s.body.includes(`cortex-telegram claim ${id}`) && !s.body.includes('who owns this')))
})

test('the first claim wins, and replies by owner finds it; an unknown role cannot claim', async () => {
  const { gw } = make()
  const id = await gw.handleUpdate('dev', update('mystery'))
  assert.deepEqual(gw.claim(id, 'globex-dev'), { won: true, owner: 'globex-dev' })
  assert.deepEqual(gw.claim(id, 'ops-dev'), { won: false, owner: 'globex-dev' })
  assert.equal(gw.replies({ owner: 'globex-dev' })[0]!.id, id)
  assert.throws(() => gw.claim(id, 'nobody'), (e: Rejected) => e.status === 403)
  assert.throws(() => gw.claim('x', 'globex-dev'), (e: Rejected) => e.status === 400)
})

test('a failed wake-up is retried with backoff, and shows in health until it lands (brief defect 4)', async () => {
  const { gw, mesh, clock } = make()
  await gw.send({ sender: 'ops-dev', text: 'q?', topic: 'T1' })
  mesh.up = false
  const id = await gw.handleUpdate('dev', update('ops-dev answer'))
  assert.equal(gw.health().bots[0]!.unnotified_inbound, 1)
  mesh.up = true
  await gw.tick()
  assert.equal(mesh.sent.length, 0, 'not every tick: it waits for the backoff')
  clock.advance(61)
  await gw.tick()
  assert.ok(mesh.sent.some((s) => s.body.includes(`replies --id ${id}`)))
  assert.equal(gw.health().bots[0]!.unnotified_inbound, 0)
})

test('replies --since compares times, not strings; the same second still counts (brief defect 7)', async () => {
  const { gw, clock } = make()
  clock.t = Date.parse('2026-09-28T10:00:00.500Z')
  const id = await gw.handleUpdate('dev', update('later in the second'))
  assert.deepEqual(gw.replies({ since: '2026-09-28T10:00:00Z' }).map((r) => r.id), [id])
  assert.equal(gw.replies({ since: '2026-09-28T10:00:01Z' }).length, 0)
  assert.throws(() => gw.replies({ since: 'yesterday' }), Rejected)
})

test('a bare approval in a claim request is labelled as approving nothing; shell characters are flagged', async () => {
  const { gw, mesh } = make()
  await gw.handleUpdate('dev', update('Go ahead!'))
  assert.match(mesh.sent[0]!.body, /BARE APPROVAL/)
  await gw.handleUpdate('dev', update('do $(this)'))
  assert.match(mesh.sent.at(-1)!.body, /shell metacharacters/)
})

/** Hostile strings, generated: no comms body ever carries operator or producer text, and nothing runs. */
test('property: operator and producer text never reaches a comms body, in any routing path', async () => {
  const parts = ['$(touch /tmp/notify-pwned)', '`id`', '${HOME}', "it's; rm -rf ~", 'a && b | c > d', 'go ahead', 'yes do it', '\\n', '{x}', '<y>']
  let seed = 7
  const rand = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n
  const { gw, mesh, clock, channel } = make()
  await gw.send({ sender: 'ops-dev', text: 'question', topic: 'Q1' })
  const asked = channel.sent[0]!.message_id
  const markers: string[] = []
  for (let i = 0; i < 60; i++) {
    const marker = `M${i}x${rand(1e6)}`
    markers.push(marker)
    const text = `${parts[rand(parts.length)]} ${marker} ${parts[rand(parts.length)]}`
    switch (i % 4) {
      case 0: await gw.handleUpdate('dev', update(text)); break
      case 1: await gw.handleUpdate('dev', update(`ops-dev ${text}`)); break
      case 2: await gw.handleUpdate('dev', update(text, { replyTo: asked })); break
      default: gw.publish({ source: 'prod', owner: 'globex-dev', severity: 'page', title: `t ${marker}`, body: text })
    }
  }
  clock.advance(600)
  await gw.tick()
  for (const s of mesh.sent) for (const m of markers) assert.ok(!s.body.includes(m), `a comms body carried ${m}`)
  assert.ok(mesh.sent.length > 40)
  assert.equal(fs.existsSync('/tmp/telegram-pwned'), false)
})

test('no shell, eval or exec anywhere in the module source', () => {
  const root = path.join(import.meta.dirname, '..')
  const files = ['server', 'bin'].flatMap((d) => fs.readdirSync(path.join(root, d)).map((f) => path.join(root, d, f)))
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf-8')
    // child_process exec runs a shell; SQLite's db.exec does not, hence the lookbehind.
    assert.doesNotMatch(src, /(?<![.\w])exec(Sync)?\(|\bexecFile|shell:\s*true|\beval\(|new Function\(/, f)
    if (/node:child_process/.test(src)) assert.match(src, /import \{ spawnSync \} from 'node:child_process'/, `${f}: only spawnSync with an argv list`)
  }
  void OPERATOR
})

test('two-way: a routed message awaits an answer; the owner is told how to reply; --reply-to threads under it and clears the wait', async () => {
  const { gw, mesh, channel, db } = make()
  const id = (await gw.handleUpdate('dev', update('ops-dev what is the status?', { messageId: 777 })))!
  const row = gw.replies({ id })[0]!
  assert.deepEqual([row.message_id, row.awaiting], [777, 1])
  const notice = mesh.sent.find((s) => s.to === 'ops-dev')!
  assert.match(notice.body, new RegExp(`send --reply-to ${id} \\(text on stdin\\)`))
  assert.match(notice.body, /expects an answer on Telegram/)
  assert.deepEqual(notice.awaits, { key: `telegram:${id}`, how: `answer on Telegram with: cortex-telegram send --reply-to ${id} (text on stdin)` })

  const out = await gw.send({ sender: 'ops-dev', text: 'green, shipping', replyTo: id })
  assert.equal(channel.sent.at(-1)!.reply_to, 777, 'threads under the operator message')
  const after = gw.replies({ id })[0]!
  assert.deepEqual([after.awaiting, after.answered_by], [0, out.id])
  assert.equal((db.prepare('SELECT reply_to_inbound AS r FROM outbound WHERE id = ?').get(out.id) as { r: number }).r, id)
})

test('two-way: --reply-to refuses an unknown inbound, one on another bot, and another operator', async () => {
  const { gw } = make()
  const id = (await gw.handleUpdate('dev', update('ops-dev hi')))!
  await assert.rejects(gw.send({ sender: 'ops-dev', text: 'x', replyTo: 9999 }), /no inbound 9999/)
  await assert.rejects(gw.send({ sender: 'ops-dev', text: 'x', replyTo: 'abc' }), /reply_to must be an inbound id/)
  await assert.rejects(gw.send({ sender: 'ops-dev', text: 'x', replyTo: id, to: 'nobody' }), Rejected)
})

test('two-way: an event route awaits nothing; a claim makes it awaited and tells the claimer how to answer', async () => {
  const { gw, mesh } = make()
  const id = (await gw.handleUpdate('dev', update('hello there')))!
  assert.equal(gw.replies({ id })[0]!.awaiting, 0, 'unowned: nobody owes it yet')
  const ask = mesh.sent.find((s) => s.body.includes(`claim ${id}`))!
  assert.match(ask.body, new RegExp(`send --reply-to ${id}`))
  assert.equal(ask.awaits, undefined, 'the claim request reminds nobody')
  assert.equal(gw.claim(id, 'globex-dev').won, true)
  assert.equal(gw.replies({ id })[0]!.awaiting, 1)
  await new Promise((r) => setImmediate(r))
  const told = mesh.sent.find((s) => s.to === 'globex-dev' && s.body.startsWith('You claimed'))!
  assert.equal(told.awaits?.key, `telegram:${id}`)
})
