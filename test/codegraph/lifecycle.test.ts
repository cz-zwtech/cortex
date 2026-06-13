import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decayedRelevance,
  reinforce,
  pin,
  unpin,
  invalidateGroundTruth,
  centralityStickiness,
  shouldForget,
  _internal,
} from '../../server/codegraph/lifecycle.ts';
import { newLifecycle } from '../../server/codegraph/types.ts';

const DAY = _internal.MS_PER_DAY;
const T0 = 1_700_000_000_000; // fixed epoch for determinism

describe('decayedRelevance', () => {
  it('is 1 for a freshly-seen node', () => {
    assert.equal(decayedRelevance(newLifecycle(T0), T0), 1);
  });

  it('decays toward 0 for stickiness 0 over time', () => {
    const lc = { ...newLifecycle(T0), stickiness: 0 };
    const r = decayedRelevance(lc, T0 + 28 * DAY); // 2 half-lives
    assert.ok(r < 0.3 && r > 0.2, `expected ~0.25, got ${r}`);
  });

  it('hits ~0.5 at the 14-day half-life for stickiness 0', () => {
    const lc = { ...newLifecycle(T0), stickiness: 0 };
    const r = decayedRelevance(lc, T0 + 14 * DAY);
    assert.ok(Math.abs(r - 0.5) < 0.02, `expected ~0.5, got ${r}`);
  });

  it('barely decays for high stickiness', () => {
    const lc = { ...newLifecycle(T0), stickiness: 0.95 };
    const r = decayedRelevance(lc, T0 + 60 * DAY);
    assert.ok(r > 0.95, `expected >0.95, got ${r}`);
  });

  it('pinned reads 1 regardless of age', () => {
    const lc = pin({ ...newLifecycle(T0), stickiness: 0 });
    assert.equal(decayedRelevance(lc, T0 + 365 * DAY), 1);
  });

  it('ground-truth-invalid reads 0 even if recently seen', () => {
    const lc = invalidateGroundTruth({ ...newLifecycle(T0), stickiness: 0.9 });
    assert.equal(decayedRelevance(lc, T0 + DAY), 0);
  });

  it('pinned beats ground-truth-invalid (pin is the hard override)', () => {
    const lc = pin(invalidateGroundTruth(newLifecycle(T0)));
    assert.equal(decayedRelevance(lc, T0 + DAY), 1);
  });

  it('never reads outside [0,1]', () => {
    const lc = { ...newLifecycle(T0), base: 5, stickiness: 2 };
    const r = decayedRelevance(lc, T0 + DAY);
    assert.ok(r >= 0 && r <= 1);
  });
});

describe('reinforce', () => {
  it('resets base to 1 and lastSeen to now', () => {
    const old = { ...newLifecycle(T0), base: 0.3, lastSeen: T0 };
    const r = reinforce(old, T0 + 10 * DAY);
    assert.equal(r.base, 1);
    assert.equal(r.lastSeen, T0 + 10 * DAY);
  });

  it('nudges stickiness up with diminishing returns, never above 1', () => {
    let lc = { ...newLifecycle(T0), stickiness: 0 };
    for (let i = 0; i < 50; i++) lc = reinforce(lc, T0, 0.1);
    assert.ok(lc.stickiness < 1 && lc.stickiness > 0.9, `got ${lc.stickiness}`);
  });

  it('is pure (does not mutate input)', () => {
    const old = newLifecycle(T0);
    reinforce(old, T0 + DAY, 0.5);
    assert.equal(old.lastSeen, T0);
  });
});

describe('centralityStickiness', () => {
  it('is 0 for no dependents', () => {
    assert.equal(centralityStickiness(0), 0);
  });
  it('rises monotonically and saturates below 1', () => {
    const a = centralityStickiness(4);
    const b = centralityStickiness(12);
    assert.ok(a > 0.5 && a < 0.7, `in-degree 4 ~0.63, got ${a}`);
    assert.ok(b > 0.9 && b < 1, `in-degree 12 ~0.95, got ${b}`);
    assert.ok(b > a);
  });
});

describe('shouldForget', () => {
  it('never forgets pinned', () => {
    const lc = pin({ ...newLifecycle(T0), stickiness: 0 });
    assert.equal(shouldForget(lc, T0 + 1000 * DAY, 0.2), false);
  });
  it('always forgets ground-truth-invalid', () => {
    const lc = invalidateGroundTruth(newLifecycle(T0));
    assert.equal(shouldForget(lc, T0, 0.2), true);
  });
  it('forgets a stale low-stickiness node below threshold', () => {
    const lc = { ...newLifecycle(T0), stickiness: 0 };
    assert.equal(shouldForget(lc, T0 + 60 * DAY, 0.2), true);
  });
  it('keeps a fresh node above threshold', () => {
    assert.equal(shouldForget(newLifecycle(T0), T0 + DAY, 0.2), false);
  });
  it('unpin re-exposes a node to forgetting', () => {
    const lc = unpin(pin({ ...newLifecycle(T0), stickiness: 0 }));
    assert.equal(shouldForget(lc, T0 + 60 * DAY, 0.2), true);
  });
});
