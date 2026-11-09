import assert from 'node:assert/strict'
import { test } from 'node:test'

import { suggestNode } from '../server/suggest.js'

test('prior work on the same subject suggests that node, and says why', () => {
  const s = suggestNode('tweak the landing page hero again', [
    { address: 'node-a:web-dev', about: [], prior: ['build the landing page hero', 'fix the footer'] },
    { address: 'node-c:web-dev', about: [], prior: ['set up the billing api'] },
  ])
  assert.deepEqual(s, { address: 'node-a:web-dev', reason: 'it worked on "build the landing page hero" before' })
})

test('members\' capabilities and focus suggest a node when there is no prior work', () => {
  const s = suggestNode('the react build is failing', [
    { address: 'node-a:web-dev', about: ['python services'], prior: [] },
    { address: 'node-c:web-dev', about: ['react frontend', 'focus: build tooling'], prior: [] },
  ])
  assert.equal(s?.address, 'node-c:web-dev')
  assert.match(s!.reason, /its members list .*react/)
})

test('no match, a tie, or words every candidate shares: no suggestion', () => {
  assert.equal(suggestNode('do the thing', [
    { address: 'a:x', about: ['react'], prior: [] },
    { address: 'b:x', about: ['python'], prior: [] },
  ]), undefined)
  assert.equal(suggestNode('react work', [
    { address: 'a:x', about: ['react'], prior: [] },
    { address: 'b:x', about: ['react'], prior: [] },
  ]), undefined, 'a word both share tells them apart not at all')
  assert.equal(suggestNode('anything', [{ address: 'a:x', about: ['anything'], prior: [] }]), undefined, 'one candidate needs no suggestion')
})

test('a word every candidate has is no evidence, however often it appears', () => {
  // "react" is in both: five past react jobs on a must not outweigh b's billing focus.
  const s = suggestNode('react billing page', [
    { address: 'a:web', about: [], prior: ['react one', 'react two', 'react three', 'react four', 'react five'] },
    { address: 'b:web', about: ['react', 'billing'], prior: [] },
  ])
  assert.equal(s?.address, 'b:web')
})
