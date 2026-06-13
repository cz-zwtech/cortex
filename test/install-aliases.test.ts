#!/usr/bin/env tsx
/**
 * ckn-install-aliases buildBlock — the generated shell helpers. Focus: ckn-start
 * must come up MESH-ON via bao-run when reachable, and degrade to a plain
 * local-only start when bao-run/mesh.json/OpenBao are absent (never fail), in
 * both bash/zsh and fish. Plus the ckn-mesh alias driver nodes need.
 */
import assert from 'node:assert/strict'

const { buildBlock } = await import('../bin/ckn-install-aliases.js')

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

const bash = buildBlock('/home/x/.bashrc', false)
const fish = buildBlock('/home/x/.config/fish/config.fish', false)

// ── bash/zsh: graceful bao-wrap ──
{
  // gates on bao-run presence + a mesh.json + a token probe before mesh mode
  assert.match(bash, /command -v bao-run/, 'bash gates on bao-run presence')
  assert.match(bash, /\$HOME\/\.config\/ckn\/mesh\.json/, 'bash gates on mesh.json')
  assert.match(bash, /timeout 5 bao-run CKN_MESH_TOKEN -- true/, 'bash probes the token (bounded)')
  assert.match(bash, /exec bao-run CKN_MESH_TOKEN -- npm start/, 'bash mesh-on path')
  assert.match(bash, /else exec npm start/, 'bash local-only fallback')
  ok('bash ckn-start: bao-wrap when reachable, plain start otherwise')
}

// ── fish: same graceful bao-wrap (reuses the POSIX sh -c) ──
{
  assert.match(fish, /timeout 5 bao-run CKN_MESH_TOKEN -- true/, 'fish probes the token (bounded)')
  assert.match(fish, /exec bao-run CKN_MESH_TOKEN -- npm start/, 'fish mesh-on path')
  assert.match(fish, /else exec npm start/, 'fish local-only fallback')
  ok('fish ckn-start: same graceful bao-wrap')
}

// ── ckn-mesh alias present in both shells ──
{
  assert.match(bash, /ckn-mesh\(\)\s*\{[^}]*ckn-mesh\.ts/, 'bash ckn-mesh alias')
  assert.match(fish, /function ckn-mesh;[^]*ckn-mesh\.ts/, 'fish ckn-mesh alias')
  ok('ckn-mesh alias generated for both bash and fish')
}

// ── a plain start must never wedge an unreachable node: no UNGUARDED bao-run ──
{
  // every `bao-run ... npm start` must be the `exec` inside the conditional, never
  // a bare top-level launch — guard against a regression that drops the fallback.
  assert.doesNotMatch(bash, /nohup bao-run/, 'bash never bao-wraps unconditionally')
  assert.doesNotMatch(fish, /nohup bao-run/, 'fish never bao-wraps unconditionally')
  ok('no unconditional bao-wrap — unreachable OpenBao degrades, never fails to start')
}

// ── deterministic (idempotent re-install relies on stable output) ──
{
  assert.equal(buildBlock('/home/x/.bashrc', false), bash, 'buildBlock is deterministic')
  ok('buildBlock output is stable for identical inputs')
}

console.log(`\n${passed} assertions passed.`)
process.exit(0)
