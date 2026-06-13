#!/usr/bin/env tsx
/**
 * ckn-engagement — render the human's `engagement:`-tagged feedback memories into a
 * hard managed block in the global ~/.claude/CLAUDE.md. Federates via the source
 * memories; each machine regenerates its own block. Write-only-on-change; reversible;
 * disabled by CKN_MANAGED_CLAUDEMD=off.
 *
 *   ckn-engagement sync       # regenerate the block (default)
 *   ckn-engagement --show     # print what would render, don't write
 *   ckn-engagement --remove   # strip the block
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import YAML from 'yaml'
import { SERVER_URL } from './_graph-guard.js'
import { upsertManagedBlock, removeManagedBlock } from './_managed-block.js'

const BLOCK_ID = 'engagement'
const HEADER = '## How to engage me (Cortex-managed from your federated profile)'
const ckHome = () => process.env.CKN_HOME || os.homedir()
const claudeMdPath = () => path.join(ckHome(), '.claude', 'CLAUDE.md')

interface Directive { name: string; text: string }

/** Server first (authoritative), file-fallback when it's not reachable. */
async function resolveDirectives(): Promise<Directive[]> {
  try {
    const r = await fetch(`${SERVER_URL}/api/profile/engagement`)
    if (r.ok) { const j: any = await r.json(); if (Array.isArray(j?.directives)) return j.directives }
  } catch { /* fall through to files */ }
  return resolveFromFiles()
}

function resolveFromFiles(): Directive[] {
  const dir = path.join(ckHome(), '.claude', 'memory')
  let files: string[] = []
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')) } catch { return [] }
  const out: Directive[] = []
  for (const f of files) {
    let raw = ''; try { raw = fs.readFileSync(path.join(dir, f), 'utf8') } catch { continue }
    const m = raw.match(/^﻿?\s*---\r?\n([\s\S]*?)\r?\n---/)
    if (!m) continue
    let data: any = {}; try { data = YAML.parse(m[1] ?? '') ?? {} } catch { continue }
    const type = String(data.type ?? data.kind ?? '')
    const engaged = data.engagement === true || data.engagement === 'true'
    if (type !== 'feedback' || !engaged) continue
    // Directive text = description, else first non-empty body line, else name —
    // identical fallback chain to the server endpoint so both resolve paths render
    // the same bullet (no block churn when a session flips server-up ↔ server-down).
    const body = raw.slice((m.index ?? 0) + m[0].length)
    const firstBodyLine = body.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
    const text = String(data.description ?? '').trim() || firstBodyLine || String(data.name ?? f.replace(/\.md$/, ''))
    out.push({ name: String(data.name ?? f.replace(/\.md$/, '')), text })
  }
  return out
}

function render(directives: Directive[]): string[] {
  const sorted = [...directives].sort((a, b) => a.name.localeCompare(b.name))
  return [HEADER, ...sorted.map((d) => `- ${d.text}`)]
}

/** Exported so SessionStart / mind-sync hooks regenerate the block too. Best-effort. */
export async function syncEngagementBlock(): Promise<{ wrote: boolean; reason?: string }> {
  if (process.env.CKN_MANAGED_CLAUDEMD === 'off') return { wrote: false, reason: 'disabled' }
  const file = claudeMdPath()
  let existing = ''
  try { existing = fs.readFileSync(file, 'utf8') } catch { /* no CLAUDE.md yet */ }
  const directives = await resolveDirectives()
  // No engagement directives → ensure no stale block lingers, but never create an empty one.
  const next = directives.length === 0 ? removeManagedBlock(existing, BLOCK_ID)
    : upsertManagedBlock(existing, BLOCK_ID, render(directives))
  if (next === existing) return { wrote: false, reason: 'unchanged' }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, next)
  return { wrote: true }
}

async function main() {
  const arg = process.argv[2]
  if (arg === '--remove') {
    if (process.env.CKN_MANAGED_CLAUDEMD === 'off') {
      console.log('ckn-engagement: CKN_MANAGED_CLAUDEMD=off — not modifying CLAUDE.md (unset to remove the block).')
      return
    }
    const file = claudeMdPath()
    let existing = ''; try { existing = fs.readFileSync(file, 'utf8') } catch { return }
    const next = removeManagedBlock(existing, BLOCK_ID)
    if (next !== existing) fs.writeFileSync(file, next)
    console.log('ckn-engagement: managed block removed.')
    return
  }
  if (arg === '--show') {
    const directives = await resolveDirectives()
    console.log(directives.length ? render(directives).join('\n') : '(no engagement directives)')
    return
  }
  const r = await syncEngagementBlock()
  console.log(r.wrote ? `ckn-engagement: CLAUDE.md block updated (${(await resolveDirectives()).length} directive(s)).`
    : `ckn-engagement: no change (${r.reason}).`)
}

// CLI entry — guarded so importing this module (ckn-context / ckn-mind-sync hooks
// importing `syncEngagementBlock`) does NOT execute the CLI.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('ckn-engagement:', e?.message ?? e); process.exit(1) })
}
