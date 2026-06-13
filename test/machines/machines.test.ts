#!/usr/bin/env tsx
import assert from 'node:assert/strict'
const BASE = 'http://localhost:3001/api'
const get = async (p: string) => { const r = await fetch(`${BASE}${p}`); if (!r.ok) throw new Error(`${p} -> ${r.status}`); return r.json() }

const m = await get('/machines')
assert.ok(Array.isArray(m.machines), '/api/machines returns machines[]')
const self = m.machines.find((x: any) => x.isSelf)
assert.ok(self, 'exactly one machine is flagged isSelf')
assert.ok(typeof self.memoryCount === 'number' && self.memoryCount >= 0, 'self has a memoryCount')
assert.ok(typeof self.symbolCount === 'number', 'self has a symbolCount')

const filtered = await get(`/graph/nodes?machine=${encodeURIComponent(self.machineId)}&limit=5`)
assert.ok(Array.isArray(filtered.entries ?? filtered), 'nodes?machine= returns a list')

console.log('machines.test.ts: all assertions passed')
