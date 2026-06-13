/**
 * Obsidian vault import → graph.
 *
 * Handles two frontmatter shapes:
 *   Compiled articles: title, aliases, tags, sources, created, updated
 *   Plain markdown:    no frontmatter (e.g. design-principles.md)
 *   Claude memory:     name, description, type  (handled by sync.ts — kept separate)
 *
 * Imported entries use scope = vault:{vaultName} so they're clearly
 * distinguishable from Claude memory entries in the graph.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { run, transaction } from './db.js'
import { writeLastSync } from './sync.js'

// ── Frontmatter parser ────────────────────────────────────────────────────────

const FENCE = /^\uFEFF?\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function parseFrontmatter(text: string): { data: Record<string, any>; body: string } {
  const m = text.match(FENCE)
  if (!m) return { data: {}, body: text }
  let data: Record<string, any> = {}
  try { data = YAML.parse(m[1] ?? '') ?? {} } catch {}
  return { data, body: text.slice(m[0].length).replace(/^\n+/, '') }
}

// ── graph helpers ──────────────────────────────────────────────────────────────

/**
 * Upsert one vault entry. In one
 * transaction: delete this node's incident edges (so a re-import clears stale
 * name-mention edges), then `INSERT OR REPLACE` the row. Wrapped in a
 * transaction so a crash mid-rewrite never strands an entry with edges only
 * half-cleared.
 */
function upsertVaultEntry(
  id: string, name: string, kind: string,
  description: string, content: string,
  source: string, scope: string, updatedAt: number,
) {
  transaction(() => {
    // DETACH: drop edges incident to this node before the row is replaced.
    run(`DELETE FROM edges WHERE src = ? OR dst = ?`, id, id)
    run(
      `INSERT OR REPLACE INTO entries ` +
        `(id, name, kind, description, content, source, scope, updatedAt) ` +
        `VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id, name, kind, description, content.slice(0, 8192), source, scope, updatedAt,
    )
  })
}

// ── File scanner ──────────────────────────────────────────────────────────────

async function collectFiles(target: string): Promise<string[]> {
  const stat = await fs.stat(target).catch(() => null)
  if (!stat) return []
  if (stat.isFile()) return target.endsWith('.md') ? [target] : []

  const files: string[] = []
  const entries = await fs.readdir(target, { withFileTypes: true })
  for (const e of entries) {
    const full = path.join(target, e.name)
    if (e.isDirectory()) {
      files.push(...await collectFiles(full))
    } else if (e.isFile() && e.name.endsWith('.md') && e.name !== 'MEMORY.md') {
      files.push(full)
    }
  }
  return files
}

// ── Main import ───────────────────────────────────────────────────────────────

export interface VaultImportResult {
  imported: number
  skipped: number
  errors: string[]
}

export async function importVaultPaths(
  vaultName: string,
  targets: string[],  // absolute paths to files or directories
): Promise<VaultImportResult> {
  const result: VaultImportResult = { imported: 0, skipped: 0, errors: [] }
  // Normalize vault name to lowercase so re-imports of the same vault under a
  // different casing (e.g. "Personal" vs "personal") hit the same nodes
  // instead of creating duplicates.
  const vName = vaultName.toLowerCase()
  const scope = `vault:${vName}`

  const allFiles: string[] = []
  for (const t of targets) allFiles.push(...await collectFiles(t))

  for (const filePath of allFiles) {
    try {
      const raw = await fs.readFile(filePath, 'utf-8')
      const stat = await fs.stat(filePath)
      const { data, body } = parseFrontmatter(raw)

      const filename = path.basename(filePath, '.md')

      // Normalise across two frontmatter shapes
      const name = String(data.title ?? data.name ?? filename)
      const description = String(data.description ?? '')
      // Infer kind from tags or folder
      const tags: string[] = Array.isArray(data.tags) ? data.tags.map(String) : []
      const kind = inferKind(filePath, tags)

      const id = `vault:${vName}:${filename}`
      const updatedAt = Math.floor(stat.mtimeMs)

      upsertVaultEntry(id, name, kind, description, body, filePath, scope, updatedAt)

      // Tag + wikilink edges to concept stubs were removed — they created
      // empty `scope:'vault'` nodes that cluttered the graph without value.
      // `inferNameMentionEdges` produces the meaningful entry-to-entry
      // connectivity by matching names across rich content.

      result.imported++
    } catch (e: any) {
      result.errors.push(`${filePath}: ${e.message}`)
      result.skipped++
    }
  }

  await writeLastSync()
  return result
}

// ── Kind inference ────────────────────────────────────────────────────────────

function inferKind(filePath: string, tags: string[]): string {
  // Folder-based hints
  if (filePath.includes('/philosophy/')) return 'decision'
  if (filePath.includes('/concepts/')) return 'concept'
  if (filePath.includes('/technology/')) return 'technology'
  if (filePath.includes('/merit/')) return 'project'
  if (filePath.includes('/connections/')) return 'pattern'
  if (filePath.includes('/daily/')) return 'memory'

  // Tag-based hints
  if (tags.some(t => ['docker', 'postgresql', 'redis', 'typescript', 'python'].includes(t))) return 'technology'
  if (tags.some(t => ['merit', 'herald', 'windrose'].includes(t))) return 'project'

  return 'concept'
}
