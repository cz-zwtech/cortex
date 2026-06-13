/**
 * Git provenance reads, isolated so the codegraph extractor stays
 * branch/machine-agnostic (it never reads git). Called ONCE per ingest at the
 * CLI boundary. All reads degrade to empty/false on a non-git dir or any git
 * failure — that preserves pre-provenance behavior (branch='' commitSha='').
 */
import { execFileSync } from 'node:child_process'

export interface GitProvenance {
  branch: string
  commitSha: string
  dirty: boolean
  dirtyFiles: string
  baseBranch: string
}

const git = (root: string, args: string[]): string => {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
  } catch {
    return ''
  }
}

/** Current branch name; '' if detached HEAD or non-git. */
function currentBranch(root: string): string {
  const b = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return b === 'HEAD' ? '' : b // detached → ''
}

/**
 * Repo default branch from origin's HEAD symref (auto-detects main vs the
 * swarm's develop). Falls back to 'main' when there's no origin or it's unset.
 */
export function inferBaseBranch(root: string): string {
  const ref = git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD'])
  // e.g. "refs/remotes/origin/develop" → "develop"
  const m = ref.match(/refs\/remotes\/origin\/(.+)$/)
  return m?.[1] ?? 'main'
}

export function readGitProvenance(root: string): GitProvenance {
  const commitSha = git(root, ['rev-parse', 'HEAD'])
  if (!commitSha) {
    // Non-git or unborn branch → preserve legacy behavior.
    return { branch: '', commitSha: '', dirty: false, dirtyFiles: '', baseBranch: 'main' }
  }
  const branch = currentBranch(root)
  const porcelain = git(root, ['status', '--porcelain'])
  const dirty = porcelain.length > 0
  return {
    branch,
    commitSha,
    dirty,
    dirtyFiles: dirty ? porcelain : '',
    baseBranch: inferBaseBranch(root),
  }
}
