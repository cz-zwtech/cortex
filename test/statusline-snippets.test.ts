#!/usr/bin/env tsx
/**
 * statuslineSnippets — the single source of truth for the bus + mesh statusline
 * dot shell functions. Focus: the mesh snippet is the TESTED 4-state form
 * (enabled+live+reachable, not just live); both dots are cheap-per-render (proc
 * scan / one bounded local curl, never a tsx spawn); and the shipped doc contains
 * exactly these function texts (no drift).
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const { BUS_DOT_FN, MESH_DOT_FN, composeScaffold } = await import('../bin/_statuslineSnippets.js')

let passed = 0
const ok = (l: string) => {
  passed++
  console.log(`  ok ${l}`)
}

// ── mesh dot: BINARY + link-aware (not a peer count). A relay node (NAT'd WSL /
//    laptop) reaches the fleet via a hub, so direct-dial reachable-count misleads
//    (shows 1-of-N); green keys off >=1 live LINK (connected wsLink OR reachable
//    canonical-http peer), and shows no number. Validated live on a WSL driver node. ──
{
  assert.match(MESH_DOT_FN, /mesh_seg\(\)/, 'exports mesh_seg')
  assert.match(MESH_DOT_FN, /\.enabled \/\/ false/, 'reads enabled')
  assert.match(MESH_DOT_FN, /\.live \/\/ false/, 'reads live')
  assert.match(MESH_DOT_FN, /wsLinks\[\]\?\|select\(\.connected==true\)/, 'counts connected wsLinks (relay-aware)')
  assert.match(MESH_DOT_FN, /\.url\|startswith\("http"\)/, 'counts reachable canonical-http peers')
  assert.match(MESH_DOT_FN, /\$\{GREEN\}● mesh\$\{RST\}/, 'green is binary ● mesh (no count)')
  assert.doesNotMatch(MESH_DOT_FN, /● mesh \$\{reachable\}/, 'no reachable-count in the green dot')
  assert.doesNotMatch(MESH_DOT_FN, /● mesh \$\{linked\}/, 'no link-count shown either (binary)')
  assert.match(MESH_DOT_FN, /● mesh…/, 'red: armed-but-retrying')
  assert.match(MESH_DOT_FN, /○ local/, 'yellow: local-only by choice')
  assert.match(MESH_DOT_FN, /○ mesh/, 'dim: server unreachable / undetermined')
  ok('mesh snippet is the binary, link-aware form')
}

// ── cheap-per-render: one bounded local curl, NO tsx/ckn-bus spawn ──
{
  assert.match(
    MESH_DOT_FN,
    /curl -s --max-time 1 http:\/\/localhost:3001\/api\/bus\/mesh-status/,
    'mesh: a single bounded local curl',
  )
  assert.doesNotMatch(MESH_DOT_FN, /tsx|ckn-bus/, 'mesh: no per-render tsx/ckn-bus spawn')
  assert.doesNotMatch(BUS_DOT_FN, /tsx|curl/, 'bus: pure /proc scan, no tsx/curl')
  ok('both dots are cheap-per-render (no spawn)')
}

// ── bus dot: the proven /proc-scan reference ──
{
  assert.match(BUS_DOT_FN, /bus_watcher_armed\(\)/, 'exports bus_watcher_armed')
  assert.match(BUS_DOT_FN, /\/proc\/\[0-9\]\*/, 'scans /proc')
  assert.match(BUS_DOT_FN, /CLAUDE_CODE_SESSION_ID=\$sid/, 'matches the session via environ')
  ok('bus snippet matches the proc-scan reference')
}

// ── drift guard: the shipped doc contains exactly these function texts ──
{
  const docPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs/statusline-bus-dot.md')
  const doc = await readFile(docPath, 'utf-8')
  assert.ok(doc.includes(BUS_DOT_FN), 'doc ships the canonical bus_watcher_armed text')
  assert.ok(doc.includes(MESH_DOT_FN), 'doc ships the canonical 4-state mesh_seg text')
  ok('doc snippets match the module (no drift)')
}

// ── composeScaffold: a MINIMAL Cortex-dots-only statusline (call b = no model /
//    ctx-bar / rate-limits / bc; the rich personal script is a separate path). ──
{
  const both = composeScaffold(['bus', 'mesh'])
  assert.match(both, /^#!\/bin\/bash/, 'is a runnable bash script')
  assert.ok(both.includes(BUS_DOT_FN), 'embeds the canonical bus function')
  assert.ok(both.includes(MESH_DOT_FN), 'embeds the canonical mesh function')
  assert.match(both, /\$\{BUS_SEG\}.*\$\{MESH_SEG\}/, 'prints both segments')
  // minimal — NONE of the rich personal-script machinery
  assert.doesNotMatch(both, /context_window|rate_limits|bc -l|used_percentage/, 'no ctx-bar / rate-limits / bc')
  // cheap-per-render: no tsx spawn. (`ckn-bus` appears only as a /proc grep PATTERN
  // inside bus_watcher_armed, not a spawned subprocess — so it's not disallowed here.)
  assert.doesNotMatch(both, /tsx/, 'cheap-per-render: no tsx spawn')
  ok('composeScaffold(bus,mesh): minimal dots-only runnable script')
}
{
  const busOnly = composeScaffold(['bus'])
  assert.ok(busOnly.includes(BUS_DOT_FN), 'bus-only embeds bus function')
  assert.doesNotMatch(busOnly, /mesh_seg/, 'bus-only omits mesh function')
  assert.doesNotMatch(busOnly, /\$\{MESH_SEG\}/, 'bus-only prints no mesh segment')
  const meshOnly = composeScaffold(['mesh'])
  assert.ok(meshOnly.includes(MESH_DOT_FN), 'mesh-only embeds mesh function')
  assert.doesNotMatch(meshOnly, /bus_watcher_armed/, 'mesh-only omits bus function')
  ok('composeScaffold respects the chosen dot set')
}

console.log(`\n${passed} assertions passed.`)
process.exit(0)
