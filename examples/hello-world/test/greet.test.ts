import { test } from 'node:test'
import assert from 'node:assert/strict'
import mod from '../server/index.js'

test('the module exposes a start hook', () => {
  assert.equal(typeof mod.start, 'function')
})

test('greet capability shape is what the manifest promises', async () => {
  const provided = new Map<string, unknown>()
  await mod.start?.({
    name: 'hello-world',
    dir: '.',
    events: { subscribe: () => () => {} } as never,
    capabilities: {
      provide: (id: string, impl: unknown) => provided.set(id, impl),
      get: () => undefined,
      has: () => false,
      revoke: () => {},
      list: () => [],
    },
    core: { version: '2.0.0', contract: '2.0.0' },
    log: () => {},
  })
  const greet = provided.get('hello-world.greet') as (who?: string) => string
  assert.equal(typeof greet, 'function')
  assert.equal(greet('world'), 'hello, world')
})
