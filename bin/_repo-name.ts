/**
 * Shared repo-name derivation for Cortex CLI scripts.
 *
 * The repo name (the `repo` key used to scope every Symbol/GraphHead row) is the
 * basename of the git `origin` remote (sans `.git`), falling back to the
 * directory name when the dir isn't a git repo or has no origin remote. Extracted
 * from `ckn-codegraph.ts` so `ckn-blast` (and any future opener) derive the same
 * name as the ingest path — a mismatch would scope queries to the wrong repo.
 */
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export function deriveRepoName(root: string): string {
  try {
    const url = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (url) {
      const base = url
        .replace(/[/\\]+$/, '')
        .split(/[/\\:]/)
        .pop()
        ?.replace(/\.git$/, '')
      if (base) return base
    }
  } catch {
    // not a git repo, or no origin remote — fall back to the directory name
  }
  return path.basename(root)
}
