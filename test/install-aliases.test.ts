#!/usr/bin/env tsx
/**
 * ckn-install-aliases buildBlock — the generated shell helpers. Focus: ckn-start
 * must come up MESH-ON via bao-run when reachable, and degrade to a plain
 * local-only start when bao-run/mesh.json/OpenBao are absent (never fail), in
 * both bash/zsh and fish. Plus the ckn-mesh alias driver nodes need.
 */
import assert from 'node:assert/strict'

const { buildBlock, upsertEnvLine, envTemplate } = await import('../bin/ckn-install-aliases.js')

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

// ── T1 env-load: the managed block sources ~/.claude/.env so documented Cortex
//    env (CKN_MESH_TOKEN_CMD, CKN_PROFILE) reaches the server ckn-start launches.
//    This is the root-cause fix for a driver node booting local-only and never
//    rejoining the mesh: the runtime auto-rejoin reads process.env.CKN_MESH_TOKEN_CMD,
//    which was empty because nothing sourced the documented env into the start shell. ──
{
  // bash/zsh: guarded source, auto-export on, always restore +a (even if .env errors)
  assert.match(
    bash,
    /if \[ -r "\$HOME\/\.claude\/\.env" \]; then set -a; \. "\$HOME\/\.claude\/\.env"; set \+a; fi/,
    'bash sources ~/.claude/.env guarded, with set -a/+a',
  )
  ok('bash managed block sources ~/.claude/.env (exported, guarded)')
}
{
  // fish can't source a bash .env — it gets a line-parsed loader that exports globally
  assert.match(fish, /\.claude\/\.env/, 'fish references ~/.claude/.env')
  assert.match(fish, /set -gx/, 'fish exports parsed vars globally')
  ok('fish managed block loads ~/.claude/.env')
}

// ── T2 ordering: env-load must precede the opt-in autostart so a launched
//    ckn-start is mesh/profile-AWARE, not blind (autostart lives inside the same
//    managed block, which today runs before any env is loaded). ──
{
  const bashAuto = buildBlock('/home/x/.bashrc', true)
  const envIdx = bashAuto.indexOf('.claude/.env')
  const autoIdx = bashAuto.indexOf('&& ckn-start') // the autostart invocation
  assert.ok(envIdx >= 0 && autoIdx >= 0, 'bash: both env-load and autostart present')
  assert.ok(envIdx < autoIdx, 'bash: env-load must come before autostart')
  ok('bash: env-load precedes autostart (mesh/profile-aware autostart)')

  const fishAuto = buildBlock('/home/x/.config/fish/config.fish', true)
  const fEnv = fishAuto.indexOf('.claude/.env')
  const fAuto = fishAuto.indexOf('and ckn-start')
  assert.ok(fEnv >= 0 && fAuto >= 0 && fEnv < fAuto, 'fish: env-load before autostart')
  ok('fish: env-load precedes autostart')
}

// ── T3 value-wiring: upsertEnvLine writes a QUOTED, idempotent, non-clobbering
//    KEY="value" into ~/.claude/.env content (the value has spaces, so quoting is
//    mandatory — an unquoted `set -a; . .env` mis-parses it). ──
{
  const out = upsertEnvLine('FOO=1\n', 'CKN_MESH_TOKEN_CMD', 'bao-run CKN_MESH_TOKEN -- printenv CKN_MESH_TOKEN')
  assert.match(out, /^FOO=1$/m, 'preserves existing lines')
  assert.match(
    out,
    /^CKN_MESH_TOKEN_CMD="bao-run CKN_MESH_TOKEN -- printenv CKN_MESH_TOKEN"$/m,
    'writes the value quoted',
  )
  ok('upsertEnvLine: appends a quoted line, preserves other content')
}
{
  // idempotent: same value re-applied is a byte-for-byte no-op
  const once = upsertEnvLine('', 'CKN_MESH_TOKEN_CMD', 'a b c')
  assert.equal(upsertEnvLine(once, 'CKN_MESH_TOKEN_CMD', 'a b c'), once, 'idempotent on identical value')
  ok('upsertEnvLine: idempotent for an unchanged value')
}
{
  // in-place update when the key already exists with a different value (no duplicate)
  const seed = upsertEnvLine('FOO=1\n', 'CKN_MESH_TOKEN_CMD', 'old --cmd')
  const upd = upsertEnvLine(seed, 'CKN_MESH_TOKEN_CMD', 'new --cmd here')
  assert.match(upd, /^CKN_MESH_TOKEN_CMD="new --cmd here"$/m, 'updates in place')
  assert.doesNotMatch(upd, /old --cmd/, 'old value replaced, not appended')
  assert.equal((upd.match(/^CKN_MESH_TOKEN_CMD=/gm) ?? []).length, 1, 'exactly one CKN_MESH_TOKEN_CMD line')
  assert.match(upd, /^FOO=1$/m, 'still preserves other lines')
  ok('upsertEnvLine: in-place update, never duplicates')
}
{
  // adds a separating newline when existing content lacks a trailing one
  const out = upsertEnvLine('FOO=1', 'BAR', 'x')
  assert.match(out, /^FOO=1\nBAR="x"\n$/, 'inserts newline before the appended line')
  ok('upsertEnvLine: handles missing trailing newline')
}

// ── T3 scaffold: envTemplate is a COMMENTED, secret-manager-agnostic template —
//    the PUBLIC default writes NOTHING active (no live infra value baked in). ──
{
  const t = envTemplate()
  assert.match(t, /CKN_MESH_TOKEN_CMD/, 'template documents CKN_MESH_TOKEN_CMD')
  assert.match(t, /CKN_PROFILE/, 'template documents CKN_PROFILE')
  // every non-blank line is commented — nothing active is written by default
  for (const line of t.split('\n')) {
    if (line.trim() === '') continue
    assert.ok(line.trimStart().startsWith('#'), `template line must be commented: ${line}`)
  }
  // agnostic example only — no live OpenBao/bao-run command baked into the public default
  assert.doesNotMatch(t, /bao-run/, 'public template uses an agnostic example, not bao-run')
  ok('envTemplate: fully commented, agnostic, writes nothing active')
}

console.log(`\n${passed} assertions passed.`)
process.exit(0)
