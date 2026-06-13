#!/usr/bin/env tsx
import assert from 'node:assert/strict'

// branchPolicy is pure (no DB): import directly, no CKN_GRAPH_DB_PATH dance.
const { classifyBranch, coreBranchPatterns, matchesCore, DEFAULT_CORE_BRANCHES } = await import(
  '../../server/graph/branchPolicy.js'
)

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

// ── default core set (no env, no cfg) ────────────────────────────────────────
{
  delete process.env.CKN_CODEGRAPH_CORE_BRANCHES
  assert.equal(classifyBranch('main'), 'core', 'main is core')
  assert.equal(classifyBranch('master'), 'core', 'master is core')
  assert.equal(classifyBranch('develop'), 'core', 'develop is core')
  ok('default trunk branches classify core')
}

{
  delete process.env.CKN_CODEGRAPH_CORE_BRANCHES
  assert.equal(classifyBranch('feature/foo'), 'core', 'feature/* is core by default')
  assert.equal(classifyBranch('release/1.2'), 'core', 'release/* is core')
  assert.equal(classifyBranch('integration/abc'), 'core', 'integration/* is core')
  ok('default glob patterns classify core')
}

{
  delete process.env.CKN_CODEGRAPH_CORE_BRANCHES
  assert.equal(classifyBranch('epic/big-thing'), 'ephemeral', 'epic/* is ephemeral')
  assert.equal(classifyBranch('wip/spike'), 'ephemeral', 'wip/* is ephemeral')
  assert.equal(classifyBranch('alice/scratch'), 'ephemeral', 'ad-hoc is ephemeral')
  assert.equal(classifyBranch(''), 'ephemeral', 'empty branch is ephemeral')
  ok('non-core branches classify ephemeral')
}

// glob is segment-scoped: feature/* must NOT match a nested path with default '*'
{
  delete process.env.CKN_CODEGRAPH_CORE_BRANCHES
  assert.equal(
    classifyBranch('feature/a/b'),
    'ephemeral',
    'feature/* (single *) does not cross a slash',
  )
  ok('single-* glob is segment-scoped (does not cross /)')
}

// ── env override (CKN_CODEGRAPH_CORE_BRANCHES) ───────────────────────────────
{
  process.env.CKN_CODEGRAPH_CORE_BRANCHES = 'trunk, epic/*'
  assert.equal(classifyBranch('trunk'), 'core', 'env: trunk is core')
  assert.equal(classifyBranch('epic/x'), 'core', 'env: epic/* now core')
  assert.equal(classifyBranch('main'), 'ephemeral', 'env replaces default — main no longer core')
  assert.equal(classifyBranch('feature/y'), 'ephemeral', 'env: feature/* no longer core')
  delete process.env.CKN_CODEGRAPH_CORE_BRANCHES
  ok('env CKN_CODEGRAPH_CORE_BRANCHES replaces the default set')
}

// explicitly-empty env → nothing is core
{
  process.env.CKN_CODEGRAPH_CORE_BRANCHES = ''
  assert.equal(classifyBranch('main'), 'ephemeral', 'empty env → no core branches')
  assert.deepEqual(coreBranchPatterns(), [], 'empty env → empty pattern list')
  delete process.env.CKN_CODEGRAPH_CORE_BRANCHES
  ok('explicitly-empty env means no branch is core')
}

// ── cfg override beats env ───────────────────────────────────────────────────
{
  process.env.CKN_CODEGRAPH_CORE_BRANCHES = 'trunk'
  assert.equal(classifyBranch('main', { coreBranches: ['main'] }), 'core', 'cfg beats env')
  assert.equal(classifyBranch('trunk', { coreBranches: ['main'] }), 'ephemeral', 'cfg replaces env list')
  delete process.env.CKN_CODEGRAPH_CORE_BRANCHES
  ok('explicit cfg.coreBranches overrides env')
}

// ── custom globs: ** crosses slashes ─────────────────────────────────────────
{
  assert.equal(matchesCore('a/b/c', ['a/**']), true, '** crosses slashes')
  assert.equal(matchesCore('a/b/c', ['a/*']), false, 'single * does not cross slashes')
  assert.equal(matchesCore('release/2.0.1', ['release/*']), true, 'literal dots match')
  ok('custom globs: ** vs * slash semantics')
}

// fallback sanity: the exported default contains the trunk names
{
  assert.ok(DEFAULT_CORE_BRANCHES.includes('main'), 'default set includes main')
  assert.ok(DEFAULT_CORE_BRANCHES.includes('develop'), 'default set includes develop')
  ok('DEFAULT_CORE_BRANCHES exported with trunk names')
}

console.log(`\n${passed} assertions passed.`)
