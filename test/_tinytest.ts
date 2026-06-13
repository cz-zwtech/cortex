/**
 * Tiny vitest-compatible shim over node:assert so describe/it/expect tests run
 * under this project's harness (tsx + node:assert; vitest is NOT a dependency).
 * Synchronous by design — test bodies here are sync. `it` runs immediately, so
 * `beforeEach`/`afterEach` registered at the top of a `describe` apply per case;
 * `afterAll` runs on process exit. Import this instead of 'vitest'.
 */
import assert from 'node:assert/strict'

const _before: (() => void)[] = []
const _after: (() => void)[] = []
const _afterAll: (() => void)[] = []
let _passed = 0

export const beforeEach = (fn: () => void): void => {
  _before.push(fn)
}
export const afterEach = (fn: () => void): void => {
  _after.push(fn)
}
export const afterAll = (fn: () => void): void => {
  _afterAll.push(fn)
}
export const describe = (_name: string, fn: () => void): void => {
  fn()
}
export const it = (name: string, fn: () => void): void => {
  for (const b of _before) b()
  fn()
  for (const a of _after) a()
  _passed++
  console.log(`  ok ${name}`)
}
export const expect = (actual: unknown) => ({
  toBe: (e: unknown) => assert.strictEqual(actual, e),
  toEqual: (e: unknown) => assert.deepStrictEqual(actual, e),
  toBeUndefined: () => assert.strictEqual(actual, undefined),
  toMatch: (re: RegExp) => assert.ok(re.test(String(actual)), `${String(actual)} does not match ${re}`),
})

process.on('beforeExit', () => {
  for (const a of _afterAll) a()
  console.log(`\n${_passed} assertions passed.`)
})
