#!/usr/bin/env tsx
/**
 * ckn-migrate-session-md — one-shot migration from session-<sid>.md
 * frontmatter to Claude Code custom-title events.
 *
 * Pre-refactor, Cortex stored session topic names in per-SID markdown
 * files under ~/.claude/projects/<encProj>/memory/session-<sid>.md with
 * frontmatter `prompt_state: named` + `auto_named: false`. Post-refactor,
 * the topic is whatever the JSONL's latest `custom-title` event says —
 * which Claude Code propagates across resumes natively.
 *
 * This script:
 *   1. For each session-*.md with `prompt_state: named && auto_named: false`,
 *      append a `custom-title` event to that SID's JSONL (only if the
 *      JSONL doesn't already carry the same name as its latest title).
 *   2. Delete ALL session-*.md files. The 350+ auto-named ones are noise;
 *      the 10ish renamed ones are now expressed via JSONL custom-title.
 *
 * Run flags:
 *   --dry-run    Print planned actions; touch nothing.
 *   --delete-only  Skip step 1 (custom-title append). Just sweep the files.
 *   --keep-md    Skip step 2 (file deletion). Just migrate titles.
 *
 * Default: full migration (both steps).
 */
import * as fsSync from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects')

interface CLIFlags {
  dryRun: boolean
  deleteOnly: boolean
  keepMd: boolean
}

const parseFlags = (): CLIFlags => {
  const argv = process.argv.slice(2)
  return {
    dryRun: argv.includes('--dry-run'),
    deleteOnly: argv.includes('--delete-only'),
    keepMd: argv.includes('--keep-md'),
  }
}

interface ParsedSessionMd {
  sid: string
  encProj: string
  name: string | null
  promptState: string | null
  autoNamed: boolean | null
  filePath: string
}

const FRONTMATTER_FENCE = /^---\r?\n([\s\S]*?)\r?\n---/

const parseSessionMd = (filePath: string): ParsedSessionMd | null => {
  const base = path.basename(filePath)
  if (!base.startsWith('session-') || !base.endsWith('.md')) return null
  const sid = base.slice('session-'.length, -'.md'.length)
  const encProj = path.basename(path.dirname(path.dirname(filePath))) // …/<encProj>/memory/<file>
  let raw: string
  try {
    raw = fsSync.readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
  const m = raw.match(FRONTMATTER_FENCE)
  if (!m) return { sid, encProj, name: null, promptState: null, autoNamed: null, filePath }
  let name: string | null = null
  let promptState: string | null = null
  let autoNamed: boolean | null = null
  for (const ln of (m[1] ?? '').split('\n')) {
    const idx = ln.indexOf(':')
    if (idx < 0) continue
    const key = ln.slice(0, idx).trim()
    let val = ln.slice(idx + 1).trim()
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n')
    }
    if (key === 'name') name = val
    else if (key === 'prompt_state') promptState = val
    else if (key === 'auto_named') autoNamed = val === 'true'
  }
  return { sid, encProj, name, promptState, autoNamed, filePath }
}

const findAllSessionMd = async (): Promise<ParsedSessionMd[]> => {
  const out: ParsedSessionMd[] = []
  let projects: string[] = []
  try {
    projects = await fsp.readdir(PROJECTS_ROOT)
  } catch {
    return out
  }
  for (const proj of projects) {
    const memDir = path.join(PROJECTS_ROOT, proj, 'memory')
    let entries: string[] = []
    try {
      entries = await fsp.readdir(memDir)
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.startsWith('session-') || !e.endsWith('.md')) continue
      const parsed = parseSessionMd(path.join(memDir, e))
      if (parsed) out.push(parsed)
    }
  }
  return out
}

const latestCustomTitle = (jsonlPath: string): string | null => {
  let raw: string
  try {
    raw = fsSync.readFileSync(jsonlPath, 'utf-8')
  } catch {
    return null
  }
  let title: string | null = null
  for (const ln of raw.split('\n')) {
    if (!ln.includes('"custom-title"')) continue
    try {
      const evt = JSON.parse(ln) as { type?: string; customTitle?: string }
      if (evt.type === 'custom-title' && typeof evt.customTitle === 'string') {
        title = evt.customTitle
      }
    } catch {}
  }
  return title
}

const appendCustomTitle = (jsonlPath: string, sid: string, title: string): void => {
  const evt = JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: sid }) + '\n'
  fsSync.appendFileSync(jsonlPath, evt, 'utf-8')
}

const main = async (): Promise<void> => {
  const flags = parseFlags()
  const all = await findAllSessionMd()

  let migrated = 0
  let skipped = 0
  let deleted = 0

  if (!flags.deleteOnly) {
    const liveCutoffMs = Date.now() - 10 * 60 * 1000
    for (const entry of all) {
      if (entry.promptState !== 'named' || entry.autoNamed !== false || !entry.name) continue
      const jsonlPath = path.join(PROJECTS_ROOT, entry.encProj, `${entry.sid}.jsonl`)
      if (!fsSync.existsSync(jsonlPath)) {
        console.warn(`[migrate] no JSONL for ${entry.encProj}/${entry.sid} — name "${entry.name}" lost`)
        skipped++
        continue
      }
      // Skip JSONLs touched in the last 10 minutes — that session is
      // very likely live and CC's in-memory title would race our append.
      try {
        const stat = fsSync.statSync(jsonlPath)
        if (stat.mtimeMs > liveCutoffMs) {
          console.warn(`[migrate] skipping live session ${entry.encProj}/${entry.sid} (jsonl mtime < 10min)`)
          skipped++
          continue
        }
      } catch {}
      const current = latestCustomTitle(jsonlPath)
      if (current === entry.name) {
        skipped++
        continue
      }
      if (flags.dryRun) {
        console.log(`[dry] append custom-title "${entry.name}" → ${entry.encProj}/${entry.sid}`)
      } else {
        appendCustomTitle(jsonlPath, entry.sid, entry.name)
        console.log(`[migrate] append custom-title "${entry.name}" → ${entry.encProj}/${entry.sid}`)
      }
      migrated++
    }
  }

  if (!flags.keepMd) {
    for (const entry of all) {
      if (flags.dryRun) {
        deleted++
        continue
      }
      try {
        fsSync.unlinkSync(entry.filePath)
        deleted++
      } catch (e) {
        console.warn(`[migrate] failed to delete ${entry.filePath}: ${(e as Error).message}`)
      }
    }
  }

  console.log(
    `[migrate] done. titles migrated=${migrated} skipped=${skipped} files deleted=${deleted}${flags.dryRun ? ' (dry-run)' : ''}`,
  )
  console.log('[migrate] re-sync recommended so OCCURRED_IN edges refresh: npm run sync')
}

main().catch((e) => {
  console.error('[migrate] fatal:', e?.message ?? e)
  process.exit(1)
})
