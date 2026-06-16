import assert from 'node:assert/strict'
import { scopeProximity, SCOPE_PRIOR_WEIGHT } from '../../server/graph/recall.js'

// exact / ancestor project scope → full proximity
assert.equal(scopeProximity('project:-mnt-e-Repos-personal', ['project:-mnt-e-Repos-personal']), 1)
// descendant match → full proximity
assert.equal(scopeProximity('project:-mnt-e-Repos-personal-cortex', ['project:-mnt-e-Repos-personal']), 1)
// sibling whose encoded name is only a string-prefix must NOT match (boundary-aware)
assert.equal(scopeProximity('project:-mnt-e-Repos-personalish', ['project:-mnt-e-Repos-personal']), 0)
// user-wide → partial nudge
assert.equal(scopeProximity('user', ['project:-mnt-e-Repos-personal']), 0.5)
// unrelated project → zero
assert.equal(scopeProximity('project:-mnt-e-Repos-other', ['project:-mnt-e-Repos-personal']), 0)
// no in-play scopes → zero (recall stays scope-agnostic)
assert.equal(scopeProximity('project:-anything', undefined), 0)
assert.equal(scopeProximity('project:-anything', []), 0)
// weight is a conservative, labeled knob
assert.ok(SCOPE_PRIOR_WEIGHT > 0 && SCOPE_PRIOR_WEIGHT <= 0.1)

console.log('scope-prior: OK')
process.exit(0)
