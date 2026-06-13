#!/usr/bin/env tsx
/**
 * One-liner: build/refresh the Cortex AST code-graph for a repo you work on.
 *
 *   ckn-codegraph <path>              # e.g. ckn-codegraph ~/repos/merit
 *   ckn-codegraph                     # defaults to the current directory
 *   ckn-codegraph <path> --repo <n>   # override the derived repo name
 *   ckn-codegraph <path> --langs ts   # override languages (default: ts,py)
 *   ckn-codegraph --on-complete <path># sync-on-completion: re-ingest ONLY if the
 *                                     # branch is core (ephemeral → no-op)
 *   ckn-codegraph --on-complete --force <path>  # force the re-ingest regardless
 *
 * The repo name is auto-derived from the repo's git remote (basename, sans
 * .git), falling back to the directory name. Languages default to `ts,py`; the
 * `ts` bucket already covers .ts/.tsx/.js/.jsx/.mjs/.cjs, so JS/Next.js repos
 * extract without extra flags (node_modules/.next/dist are skipped by the
 * extractor). This wraps `ingestRepo` from ckn-codegraph-ingest; it requires the
 * Cortex server to be running (API-only — the server owns the single writer).
 *
 * **--on-complete (cars/roads)** is the consumer-invoked "after a change lands"
 * trigger (spec Phase 2). Cortex exposes the primitive; a consumer (the swarm
 * finalize step, an opt-in git post-commit/post-merge hook — see README) calls
 * it. It classifies the repo's current branch via `classifyBranch`: a **core**
 * branch (main/develop/feature/* by default; CKN_CODEGRAPH_CORE_BRANCHES tunes
 * it) re-ingests; an **ephemeral** branch (epic/wip/ad-hoc) NO-OPs to keep
 * completion-sync from spamming churny branches — `--force` overrides.
 */
import path from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { ingestRepo } from './ckn-codegraph-ingest.js'
import { deriveRepoName } from './_repo-name.js'
import { readGitProvenance } from '../server/git/provenance.js'
import { classifyBranch } from '../server/graph/branchPolicy.js'

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < process.argv.length && !process.argv[i + 1]!.startsWith('--')
    ? process.argv[i + 1]
    : undefined
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

async function main(): Promise<void> {
  const raw = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? '.'
  const root = path.resolve(raw)
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`not a directory: ${root}`)
  }
  const repo = flag('repo') ?? deriveRepoName(root)
  const langs = (flag('langs') ?? 'ts,py')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  // Sync-on-completion gate: classify the branch, skip ephemeral ones unless forced.
  if (hasFlag('on-complete')) {
    const branch = readGitProvenance(root).branch
    const cls = classifyBranch(branch)
    if (cls === 'ephemeral' && !hasFlag('force')) {
      console.error(
        `[codegraph] on-complete: branch="${branch || '(none)'}" is ephemeral — ` +
          `skipping re-ingest (it syncs on-query). Pass --force to override.`,
      )
      return
    }
    console.error(
      `[codegraph] on-complete: branch="${branch || '(none)'}" is ${cls}` +
        (cls === 'ephemeral' ? ' (forced)' : '') +
        ` — re-ingesting repo="${repo}".`,
    )
  }

  console.error(`[codegraph] repo="${repo}" root="${root}" langs=${langs.join(',')}`)
  await ingestRepo({ repo, root, langs })
}

main().catch((err) => {
  console.error(`[codegraph] FAILED: ${err?.message ?? err}`)
  process.exit(1)
})
