/**
 * Cortex private-mind — the singular mind synced across a user's own machines.
 *
 * One user, N machines, one mind. A git repo (e.g.
 * git@github.com:<you>/private-cortex.git) is the canonical substrate; each
 * machine's ~/.claude/.../memory/*.md + graph DB is a working replica that
 * syncs bidirectionally. Memories keep their NATIVE scope (user/, project:<enc>/)
 * — this is NOT shared-mind (that's selective, public, team-facing, and
 * quarantines imports under shared:<name>). See cortex-private-mind-sync.md.
 *
 * Opt-in, disabled by default: active only when the clone exists with a remote
 * configured, and CKN_PRIVATE_MIND !== 'off'.
 *
 * Reconcile is initiator-driven and 3-way against the committed manifest as
 * baseline: local-only-changed → push; remote-only-changed → adopt;
 * both-changed → keep-both (loser saved as a .conflict-* memory, never
 * discarded); deletes → tombstones. Full decision table in the design doc.
 *
 * All graph writes (the post-reconcile re-index) go through the server's graph
 * connection via the API path; this module only touches the filesystem + git.
 */
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

// Where the private-mind git clone lives. Defaults to Cortex runtime state
// under ~/.config/ckn (mirrors shared-mind; ext4 in WSL avoids NTFS git
// quirks). Override with CKN_PRIVATE_MIND_PATH to keep it in your projects
// workspace (e.g. ~/projects/private-cortex) so you can push it
// from where you work.
export const PRIVATE_MIND_PATH =
  process.env.CKN_PRIVATE_MIND_PATH && process.env.CKN_PRIVATE_MIND_PATH.trim()
    ? process.env.CKN_PRIVATE_MIND_PATH.trim()
    : path.join(os.homedir(), '.config', 'ckn', 'private-mind')
const MACHINE_ID_PATH = path.join(os.homedir(), '.config', 'ckn', 'machine-id')

// Durable anchor for the pinned node id. Precedence: explicit CKN_NODE_ID_PATH;
// else, when the private-mind clone is on a Windows volume (/mnt/*, i.e. WSL — a
// distro reimport wipes ~/.config but not /mnt), a sibling OUTSIDE the git clone;
// else the legacy ~/.config/ckn/machine-id (durable enough on servers).
const nodeIdAnchorPath = (): string => {
  const explicit = process.env.CKN_NODE_ID_PATH?.trim()
  if (explicit) return explicit
  if (PRIVATE_MIND_PATH.startsWith('/mnt/')) {
    return path.join(path.dirname(PRIVATE_MIND_PATH), '.ckn-node-id')
  }
  return MACHINE_ID_PATH
}

const MANIFEST_REL = path.join('.cortex', 'manifest.json')
// Per-machine local baseline — what THIS machine last reconciled to. NOT in the
// repo (each machine has its own), and intentionally kept under ~/.config (it's
// machine-local runtime state, never synced). This is the true 3-way ancestor:
// the shared manifest is federation-global, so a freshly-cloned machine "sees"
// files in it that it has never actually pulled down — using it as the ancestor
// would misread "never pulled" as "locally deleted". localBase fixes that.
const LOCAL_STATE_PATH = path.join(os.homedir(), '.config', 'ckn', 'private-mind.state.json')

// Local memory roots → repo subdir. Order matters: concepts is a child of the
// user memory dir, so it must be matched first.
const homeMem = path.join(os.homedir(), '.claude', 'memory')
const homeConcepts = path.join(homeMem, 'concepts')
const projectsRoot = path.join(os.homedir(), '.claude', 'projects')

// ── types ────────────────────────────────────────────────────────────────────

interface ManifestFile {
  hash: string
  updatedAt: number
  originMachine: string
}
interface Tombstone {
  deletedHash: string
  deletedAt: number
  byMachine: string
}
interface Manifest {
  schemaVersion: number
  machines: Record<string, { hostname: string; lastSeenMs: number; platform?: string }>
  files: Record<string, ManifestFile>
  tombstones: Record<string, Tombstone>
  lastSyncMs: number
}

export interface MindSyncReport {
  enabled: boolean
  reason?: string
  pulled: boolean
  pushed: boolean
  adopted: string[] // repo→local writes (new/updated from remote)
  pushedFiles: string[] // local→repo writes
  conflicts: string[] // keep-both conflict files created
  deletedLocal: string[] // files deleted locally per remote tombstone
  tombstoned: string[] // local deletes propagated to remote
  resurrected: string[] // edited-after-delete, kept
  duplicates: { id: string; near: string; score: number }[] // dedup detection
  // codegraph tier (regenerable AST snapshots, newest-wins): repos whose
  // graph.json changed vs this machine's baseline this run → the caller replays
  // them into the graph via the symbols-upsert API (so a machine that pulled
  // the mind but lacks the source repo still gets the AST graph).
  codegraphAdopted: string[]
  // codegraph tier forgets: repos a peer (or this machine) removed via a
  // codegraph tombstone → the caller calls forgetRepoSymbols(repo) for each so
  // the local graph drops them (the federated counterpart to adoption).
  codegraphForgotten: string[]
  // populated by the route after it replays the adopted snapshots into the graph.
  codegraphReplayed?: { repo: string; symbols: number; edges: number; invalidated: number }[]
  // profile tier (single regenerable facet snapshot, merge-by-group): true when
  // profile/profile.json changed vs this machine's baseline this run → the caller
  // replays it into the graph via importProfileSnapshot (merging cross-machine
  // evidence) so a machine that pulled the mind gets the human-profile perception.
  profileAdopted: boolean
  errors: string[]
}

/** Options for {@link mindSync}. */
export interface MindSyncOptions {
  /**
   * Commit + push local changes to the federation origin. Default true
   * (explicit/interactive syncs federate). The BOOT caller passes false: a
   * restart must reconcile + adopt remote WITHOUT silently pushing whatever is
   * committed locally. Local-origin changes stay in the working tree
   * uncommitted until the next explicit push:true sync.
   */
  push?: boolean
  /**
   * Skip the worktree fetch in syncWorktreeToRemote. Set by the FIRST sync right
   * after a fresh clone: origin/main is already current, so the fetch is a redundant
   * no-op that only re-adds the altssh:443 failure surface (#97). Default false (the
   * incremental path fetches, with a retry, to learn real remote deltas).
   */
  skipWorktreeFetch?: boolean
}

const emptyReport = (): MindSyncReport => ({
  enabled: false,
  pulled: false,
  pushed: false,
  adopted: [],
  pushedFiles: [],
  conflicts: [],
  deletedLocal: [],
  tombstoned: [],
  resurrected: [],
  duplicates: [],
  codegraphAdopted: [],
  codegraphForgotten: [],
  profileAdopted: false,
  errors: [],
})

// Repo subdir for the regenerable AST-graph snapshots (design doc repo layout:
// codegraph/<repo>/graph.json). Distinct from the memory/ tier — these are NOT
// .md memories, they're regenerable artifacts, so they reconcile newest-wins
// rather than keep-both.
const CODEGRAPH_REL = 'codegraph'
const codegraphRepoPath = (repo: string): string =>
  path.posix.join(CODEGRAPH_REL, repo, 'graph.json')

// Repo path for the regenerable human-profile snapshot. Unlike codegraph (one
// file per repo), the profile is a SINGLE file — there is one human — so it
// reconciles newest-wins/merge-by-group rather than per-repo. The profile.ts
// importer unions evidence across machines, so re-replaying our own is safe.
const PROFILE_REL = 'profile'
const profilePath = (): string => path.posix.join(PROFILE_REL, 'profile.json')

// ── machine identity ──────────────────────────────────────────────────────────

const hostSlug = (): string => os.hostname().replace(/[^\w.-]/g, '-')

const writeNodeIdFile = (p: string, id: string): void => {
  try {
    fsSync.mkdirSync(path.dirname(p), { recursive: true })
    fsSync.writeFileSync(p, id + '\n', 'utf-8')
  } catch {
    /* best-effort cache; getMachineId still returns the value */
  }
}

/**
 * Derive a HOST-STABLE machine id from the OS machine-id (shared by every user
 * on the box), so all users on one physical host resolve the SAME id → one host
 * = one machine node in the federation. `${hostname}-${sha256(machine-id)[:8]}`.
 * Returns null when no OS machine-id exists (non-Linux / sandboxed) so the
 * caller falls back to the legacy per-home random id.
 */
const deriveHostMachineId = (): string | null => {
  for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const raw = fsSync.readFileSync(p, 'utf-8').trim()
      if (raw) {
        const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8)
        return `${hostSlug()}-${hash}`
      }
    } catch {
      // try the next source
    }
  }
  return null
}

export const getMachineId = (): string => {
  // 1. Explicit override always wins (also lets one host run >1 logical node).
  const override = process.env.CKN_NODE_ID?.trim()
  if (override) return override

  // 2. The durable anchor is AUTHORITATIVE once written — we never re-derive over
  //    it. This is what makes the id survive /etc/machine-id regeneration and
  //    hostname renames (the two churn sources), so one physical host stays one
  //    node instead of fragmenting into a new id per reset.
  const anchor = nodeIdAnchorPath()
  try {
    const pinned = fsSync.readFileSync(anchor, 'utf-8').trim()
    if (pinned) return pinned
  } catch {
    // not minted yet
  }

  // 3. Mint ONCE. Adopt any pre-existing id before deriving a fresh one, so a box
  //    that already had a stable id keeps it even if /etc/machine-id has since
  //    changed: legacy cache → host derivation → random. Then pin to the anchor.
  let minted: string | null = null
  if (anchor !== MACHINE_ID_PATH) {
    try {
      minted = fsSync.readFileSync(MACHINE_ID_PATH, 'utf-8').trim() || null
    } catch {
      /* no legacy cache */
    }
  }
  minted ??= deriveHostMachineId() ?? `${hostSlug()}-${crypto.randomUUID().slice(0, 8)}`
  writeNodeIdFile(anchor, minted)
  return minted
}

/**
 * Collapse this host's legacy per-home machine ids in the private-mind manifest
 * onto the host-derived id. Touches ONLY ids sharing this host's hostname prefix
 * (never another machine's). Idempotent; best-effort (no-op without a manifest).
 * Counterpart to migration 0010's graph remap, for the git-synced manifest tier.
 */
export const remapManifestMachineIds = async (): Promise<{ remapped: number }> => {
  let remapped = 0
  try {
    const manifestPath = path.join(PRIVATE_MIND_PATH, MANIFEST_REL)
    if (!fsSync.existsSync(manifestPath)) return { remapped: 0 }
    const manifest = await readManifest()
    const newId = getMachineId()
    const prefix = hostSlug() + '-'
    const isStale = (id: string): boolean => !!id && id !== newId && id.startsWith(prefix)
    for (const id of Object.keys(manifest.machines)) {
      if (!isStale(id)) continue
      const stale = manifest.machines[id]!
      const target = manifest.machines[newId]
      // Keep whichever record is most recently seen; ensure hostname is current.
      manifest.machines[newId] =
        target && target.lastSeenMs >= stale.lastSeenMs ? target : { ...stale, hostname: os.hostname() }
      delete manifest.machines[id]
      remapped++
    }
    for (const f of Object.values(manifest.files)) if (isStale(f.originMachine)) { f.originMachine = newId; remapped++ }
    for (const t of Object.values(manifest.tombstones)) if (isStale(t.byMachine)) { t.byMachine = newId; remapped++ }
    if (remapped > 0) await writeManifest(manifest)
  } catch {
    // best-effort — never block boot on a manifest remap
  }
  return { remapped }
}

// ── git ────────────────────────────────────────────────────────────────────────

// Network git ops (fetch/pull/push/ls-remote) over a flaky link can hang
// indefinitely — git has no built-in timeout and SSH can stall for many
// minutes. Every runGit gets a hard timeout that SIGKILLs the child, so a
// stuck network op fails fast instead of wedging the caller (and, before the
// lock fix below, the whole graph). Local ops finish well under this.
const GIT_TIMEOUT_MS = Number(process.env.CKN_GIT_TIMEOUT_MS ?? '30000')

const runGit = (
  cwd: string,
  args: string[],
  opts: { allowFail?: boolean; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    // GIT_TERMINAL_PROMPT=0: never block on a credential prompt (which would
    // hang forever headless). Belt-and-suspenders with the timeout.
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      finish(() =>
        opts.allowFail
          ? resolve({ code: 124, stdout, stderr: stderr + `\n[timed out after ${opts.timeoutMs ?? GIT_TIMEOUT_MS}ms]` })
          : reject(new Error(`git ${args.join(' ')} timed out after ${opts.timeoutMs ?? GIT_TIMEOUT_MS}ms`)),
      )
    }, opts.timeoutMs ?? GIT_TIMEOUT_MS)
    child.stdout.on('data', (b) => (stdout += b.toString()))
    child.stderr.on('data', (b) => (stderr += b.toString()))
    child.on('error', (err) => finish(() => reject(err)))
    child.on('close', (code) => {
      const c = code ?? 0
      finish(() => {
        if (c !== 0 && !opts.allowFail) {
          reject(new Error(`git ${args.join(' ')} failed (${c}): ${stderr.trim() || stdout.trim()}`))
          return
        }
        resolve({ code: c, stdout, stderr })
      })
    })
  })

/** Backoff before the single retry of a transient network git op (#97 altssh race). */
const NET_RETRY_DELAY_MS = Number(process.env.CKN_GIT_RETRY_DELAY_MS ?? '1500')

/**
 * Run an idempotent async op, retrying ONCE after a short backoff when the result is
 * retryable (a transient failure). The fleet's altssh:443 first-contact clone/fetch
 * intermittently fails on the SSH-dial race; one retry turns that transient into a
 * success instead of a scary "[ckn-mind] fatal: ...fetch...failed". A persistent
 * failure is RETURNED (never swallowed) so the caller still surfaces or throws it. #97.
 */
export async function retryOnce<T>(
  fn: () => Promise<T>,
  retryable: (result: T) => boolean,
  delayMs: number = NET_RETRY_DELAY_MS,
): Promise<T> {
  const first = await fn()
  if (!retryable(first)) return first
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
  return fn()
}

const remoteUrlOf = async (repoPath: string): Promise<string | null> => {
  if (!fsSync.existsSync(path.join(repoPath, '.git'))) return null
  const r = await runGit(repoPath, ['remote', 'get-url', 'origin'], { allowFail: true })
  return r.code === 0 ? r.stdout.trim() || null : null
}

/**
 * Bring the worktree to origin/main WITHOUT a git merge. mindSync does its own
 * file-hash 3-way reconcile (against the per-machine localBase), so git is pure
 * TRANSPORT here, never a merger. A `git pull` layered on top double-reconciles
 * and strands the clone: a merge conflict leaves unmerged files, a dirty
 * regenerable file (.cortex/manifest.json) blocks the pull, and diverged local
 * commits get push-rejected. Instead: fetch, then hard-reset to origin/main.
 * This is conflict-free and idempotent — a dirty OR diverged clone is HEALED,
 * never stranded. Safe because this machine's real contributions live in
 * ~/.claude (scanLocal) and are re-applied by the reconcile + re-pushed; only
 * regenerable worktree state is discarded. Returns whether the worktree now
 * reflects the remote (false when there's no remote branch yet).
 */
export const syncWorktreeToRemote = async (
  repoPath: string,
  opts: { skipFetch?: boolean } = {},
): Promise<{ atRemote: boolean; error?: string }> => {
  // #97: on the fresh-clone path origin/main is already current straight out of the
  // clone, so the fetch is a redundant no-op that only re-adds the altssh:443 failure
  // surface — drop it. On the incremental path the fetch is load-bearing (learns a
  // real remote delta), so keep it but retry once to absorb the SSH-dial race.
  if (!opts.skipFetch) {
    await retryOnce(
      () => runGit(repoPath, ['fetch', 'origin'], { allowFail: true }),
      (r) => r.code !== 0,
    )
  }
  const hasRemote =
    (await runGit(repoPath, ['rev-parse', '--verify', 'origin/main'], { allowFail: true })).code === 0
  if (!hasRemote) {
    // Fresh federation (no remote branch yet) — drop only regenerable local dirt
    // so the first push starts from a clean tree.
    await runGit(repoPath, ['reset', '--hard', 'HEAD'], { allowFail: true })
    return { atRemote: false }
  }
  const reset = await runGit(repoPath, ['reset', '--hard', 'origin/main'], { allowFail: true })
  if (reset.code !== 0) return { atRemote: false, error: reset.stderr.trim().slice(0, 200) }
  return { atRemote: true }
}

// ── enable / clone ───────────────────────────────────────────────────────────

/**
 * Active only when not hard-disabled AND a clone with an origin remote exists.
 * Returns {enabled, reason} so callers can report why it's a no-op.
 */
export const mindStatus = async (): Promise<{
  enabled: boolean
  reason?: string
  remote: string | null
  memories?: number
}> => {
  if ((process.env.CKN_PRIVATE_MIND ?? '').toLowerCase() === 'off') {
    return { enabled: false, reason: 'CKN_PRIVATE_MIND=off', remote: null }
  }
  const remote = await remoteUrlOf(PRIVATE_MIND_PATH)
  if (!remote) {
    return {
      enabled: false,
      reason: 'no private-mind clone/remote — run ckn-mind-sync --remote <url> to enable',
      remote: null,
    }
  }
  // #96: surface the corpus size so `--status` proves the mind is present even when a
  // run's adopted-delta is 0 (the scary "sync broken/empty" first-run signal).
  return { enabled: true, remote, memories: await countMindMemories() }
}

export const listMachines = async (): Promise<
  { machineId: string; hostname: string; lastSeenMs: number; platform?: string; fileCount: number }[]
> => {
  try {
    const manifest = await readManifest()
    const fileCounts: Record<string, number> = {}
    for (const f of Object.values(manifest.files)) fileCounts[f.originMachine] = (fileCounts[f.originMachine] ?? 0) + 1
    return Object.entries(manifest.machines).map(([machineId, m]) => ({
      machineId,
      hostname: m.hostname,
      lastSeenMs: m.lastSeenMs,
      platform: m.platform,
      fileCount: fileCounts[machineId] ?? 0,
    }))
  } catch {
    return []
  }
}

/**
 * Clone (or init) the private-mind repo and configure origin. Idempotent. Returns
 * `freshlyCloned` so the caller can tell the FIRST sync to skip the redundant
 * worktree fetch (origin/main is already current straight out of the clone — #97).
 * Called by `ckn-mind-sync --remote <url>` to enable the feature.
 */
export const ensureClone = async (remote?: string): Promise<{ freshlyCloned: boolean }> => {
  await fs.mkdir(PRIVATE_MIND_PATH, { recursive: true })
  const hasGit = fsSync.existsSync(path.join(PRIVATE_MIND_PATH, '.git'))
  let freshlyCloned = false
  if (!hasGit) {
    if (remote) {
      // Clone into a temp then move contents — simplest is clone directly when
      // the dir is empty; if non-empty, init + add remote + fetch.
      const entries = await fs.readdir(PRIVATE_MIND_PATH)
      if (entries.length === 0) {
        // #97: clone into a TEMP sibling, then rename into place on success. A clone
        // that dies mid-fetch-pack (the altssh:443 first-contact transient) leaves a
        // PARTIAL .git; retrying the clone INTO the target would 128 on the now-dirty
        // dir ("destination path already exists and is not an empty directory"), so
        // the retry would be futile for the exact failure it targets. Cloning into a
        // fresh temp each attempt means the retry always starts from a clean slate and
        // a partial NEVER lands in PRIVATE_MIND_PATH. On success the complete clone is
        // swapped in via rename (temp is a sibling on the same filesystem → atomic) —
        // the "clone into a temp then move" the original code comment contemplated.
        const tmp = `${PRIVATE_MIND_PATH}.tmp-clone-${process.pid}`
        const cloned = await retryOnce(
          async () => {
            await fs.rm(tmp, { recursive: true, force: true }) // each attempt starts clean
            return runGit(path.dirname(PRIVATE_MIND_PATH), ['clone', remote, tmp], { allowFail: true, timeoutMs: 180_000 })
          },
          (r) => r.code !== 0,
        )
        if (cloned.code !== 0) {
          await fs.rm(tmp, { recursive: true, force: true })
          throw new Error(`private-mind clone failed after one retry: ${cloned.stderr.trim().slice(0, 300)}`)
        }
        await fs.rm(PRIVATE_MIND_PATH, { recursive: true, force: true }) // the empty target we mkdir'd
        await fs.rename(tmp, PRIVATE_MIND_PATH)
        freshlyCloned = true
      } else {
        await runGit(PRIVATE_MIND_PATH, ['init'])
        await runGit(PRIVATE_MIND_PATH, ['remote', 'add', 'origin', remote])
        await retryOnce(
          () => runGit(PRIVATE_MIND_PATH, ['fetch', 'origin'], { allowFail: true }),
          (r) => r.code !== 0,
        )
        // Try to check out the default branch if the remote has one.
        await runGit(PRIVATE_MIND_PATH, ['checkout', '-B', 'main', 'origin/main'], { allowFail: true })
      }
    } else {
      await runGit(PRIVATE_MIND_PATH, ['init'])
    }
  } else if (remote) {
    const existing = await remoteUrlOf(PRIVATE_MIND_PATH)
    if (!existing) await runGit(PRIVATE_MIND_PATH, ['remote', 'add', 'origin', remote])
    else if (existing !== remote) await runGit(PRIVATE_MIND_PATH, ['remote', 'set-url', 'origin', remote])
  }
  // Ensure the manifest + memory dir exist.
  const manifestPath = path.join(PRIVATE_MIND_PATH, MANIFEST_REL)
  if (!fsSync.existsSync(manifestPath)) {
    await fs.mkdir(path.dirname(manifestPath), { recursive: true })
    await fs.mkdir(path.join(PRIVATE_MIND_PATH, 'memory'), { recursive: true })
    const fresh: Manifest = {
      schemaVersion: 1,
      machines: {},
      files: {},
      tombstones: {},
      lastSyncMs: 0,
    }
    await fs.writeFile(manifestPath, JSON.stringify(fresh, null, 2), 'utf-8')
  }
  return { freshlyCloned }
}

// ── manifest io ────────────────────────────────────────────────────────────────

const readManifest = async (): Promise<Manifest> => {
  try {
    const raw = await fs.readFile(path.join(PRIVATE_MIND_PATH, MANIFEST_REL), 'utf-8')
    const m = JSON.parse(raw) as Manifest
    m.files ??= {}
    m.tombstones ??= {}
    m.machines ??= {}
    return m
  } catch {
    return { schemaVersion: 1, machines: {}, files: {}, tombstones: {}, lastSyncMs: 0 }
  }
}

const writeManifest = async (m: Manifest): Promise<void> => {
  await fs.writeFile(path.join(PRIVATE_MIND_PATH, MANIFEST_REL), JSON.stringify(m, null, 2), 'utf-8')
}

const readLocalBase = async (): Promise<Record<string, string>> => {
  try {
    return JSON.parse(await fs.readFile(LOCAL_STATE_PATH, 'utf-8')) as Record<string, string>
  } catch {
    return {}
  }
}

const writeLocalBase = async (base: Record<string, string>): Promise<void> => {
  await fs.mkdir(path.dirname(LOCAL_STATE_PATH), { recursive: true })
  await fs.writeFile(LOCAL_STATE_PATH, JSON.stringify(base, null, 2), 'utf-8')
}

/**
 * Compute the post-reconcile localBase (the per-machine 3-way ancestor).
 *
 * INVARIANT: localBase must reflect what this machine has actually FEDERATED
 * (pushed to / adopted from origin) — NEVER raw local content. Advancing it for
 * an UN-PUSHED local-origin change is a data-loss trap: the conflict-free
 * transport hard-resets the worktree to origin/main, so a later sync reverts the
 * worktree to origin's old copy; if base already == the local edit, the reconcile
 * reads "unchanged since baseline, remote moved" and ADOPTS origin's old version
 * over the live ~/.claude edit (silently losing it). So a local-origin change
 * (pushed/resurrected/conflict files) keeps its PRIOR base until a push lands it;
 * a brand-new such file (no prior base) is omitted, staying "never synced" so it
 * re-pushes and is never mistaken for an adopt/delete.
 */
export function nextLocalBase(opts: {
  prior: Record<string, string>
  localHashes: Record<string, string>
  localOrigin: Set<string>
  federated: boolean
}): Record<string, string> {
  const { prior, localHashes, localOrigin, federated } = opts
  const out: Record<string, string> = {}
  for (const [p, h] of Object.entries(localHashes)) {
    if (localOrigin.has(p) && !federated) {
      if (prior[p] !== undefined) out[p] = prior[p] // keep last-federated; omit if brand-new
    } else {
      out[p] = h
    }
  }
  return out
}

// ── path mapping local <-> repo ──────────────────────────────────────────────

/** Map a local memory file abs path → its canonical repo-relative path. */
const localToRepoPath = (absPath: string): string | null => {
  if (absPath.startsWith(homeConcepts + path.sep)) {
    return path.posix.join('memory', 'user-concepts', path.basename(absPath))
  }
  if (path.dirname(absPath) === homeMem) {
    return path.posix.join('memory', 'user', path.basename(absPath))
  }
  // ~/.claude/projects/<enc>/memory/<file>
  const rel = path.relative(projectsRoot, absPath)
  const parts = rel.split(path.sep)
  if (parts.length === 3 && parts[1] === 'memory') {
    return path.posix.join('memory', 'proj', parts[0]!, parts[2]!)
  }
  return null
}

/** Map a repo-relative path → the local memory file abs path. */
const repoToLocalPath = (repoPath: string): string | null => {
  const parts = repoPath.split('/')
  if (parts[0] !== 'memory') return null
  if (parts[1] === 'user' && parts.length === 3) return path.join(homeMem, parts[2]!)
  if (parts[1] === 'user-concepts' && parts.length === 3) return path.join(homeConcepts, parts[2]!)
  if (parts[1] === 'proj' && parts.length === 4) {
    return path.join(projectsRoot, parts[2]!, 'memory', parts[3]!)
  }
  return null
}

// ── scanning ───────────────────────────────────────────────────────────────────

const sha256 = (content: string): string => crypto.createHash('sha256').update(content).digest('hex')

/** True when frontmatter declares visibility: local (excluded from sync). */
const isLocalOnly = (content: string): boolean => {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return false
  for (const ln of (m[1] ?? '').split('\n')) {
    const idx = ln.indexOf(':')
    if (idx < 0) continue
    if (ln.slice(0, idx).trim() === 'visibility') {
      return ln.slice(idx + 1).trim().toLowerCase() === 'local'
    }
  }
  return false
}

interface ScannedFile {
  repoPath: string
  localPath: string
  hash: string
  content: string
}

const scanLocal = async (): Promise<Map<string, ScannedFile>> => {
  const out = new Map<string, ScannedFile>()
  const addDir = async (dir: string) => {
    let entries: fsSync.Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md') || e.name === 'MEMORY.md') continue
      const abs = path.join(dir, e.name)
      const repoPath = localToRepoPath(abs)
      if (!repoPath) continue
      let content: string
      try {
        content = await fs.readFile(abs, 'utf-8')
      } catch {
        continue
      }
      if (isLocalOnly(content)) continue // visibility: local — never leaves the machine
      out.set(repoPath, { repoPath, localPath: abs, hash: sha256(content), content })
    }
  }
  await addDir(homeMem)
  await addDir(homeConcepts)
  let projs: fsSync.Dirent[] = []
  try {
    projs = await fs.readdir(projectsRoot, { withFileTypes: true })
  } catch {
    // none
  }
  for (const p of projs) {
    if (!p.isDirectory()) continue
    await addDir(path.join(projectsRoot, p.name, 'memory'))
  }
  return out
}

const scanRepo = async (): Promise<Map<string, ScannedFile>> => {
  const out = new Map<string, ScannedFile>()
  const memRoot = path.join(PRIVATE_MIND_PATH, 'memory')
  const walk = async (dir: string) => {
    let entries: fsSync.Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        await walk(abs)
      } else if (e.isFile() && e.name.endsWith('.md')) {
        const repoPath = path.posix.join('memory', path.relative(memRoot, abs).split(path.sep).join('/'))
        const localPath = repoToLocalPath(repoPath)
        if (!localPath) continue
        let content: string
        try {
          content = await fs.readFile(abs, 'utf-8')
        } catch {
          continue
        }
        out.set(repoPath, { repoPath, localPath, hash: sha256(content), content })
      }
    }
  }
  await walk(memRoot)
  return out
}

/**
 * Count the memory .md files in the private-mind clone — the corpus size surfaced by
 * `--status` and the first-clone report, so a fresh machine can confirm its mind is
 * present even when THIS run's adopted-delta is 0 (the boot pull-only sync already
 * adopted it). Structure-agnostic raw walk of memory/**\/*.md; a clone only ever holds
 * synced files. #96.
 */
export const countMindMemories = async (): Promise<number> => {
  const memRoot = path.join(PRIVATE_MIND_PATH, 'memory')
  let n = 0
  const walk = async (dir: string) => {
    let entries: fsSync.Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) await walk(abs)
      else if (e.isFile() && e.name.endsWith('.md')) n++
    }
  }
  await walk(memRoot)
  return n
}

// ── codegraph tier (regenerable AST snapshots) ───────────────────────────────

/**
 * Persist a codegraph snapshot as the canonical, regenerable artifact at
 * codegraph/<repo>/graph.json in the private-mind repo. Filesystem only (no
 * git, no graph) — the next mindSync commits/pushes it and replays adopted
 * snapshots into the graph. No-op when private-mind is disabled (community-safe).
 * Returns the repo-relative path written, or null when disabled.
 */
export const persistCodegraphSnapshot = async (
  repo: string,
  snapshot: { symbols: unknown[]; edges: unknown[] },
): Promise<string | null> => {
  if (!repo || !(await mindStatus()).enabled) return null
  const repoPath = codegraphRepoPath(repo)
  const abs = path.join(PRIVATE_MIND_PATH, repoPath)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(
    abs,
    JSON.stringify({ symbols: snapshot.symbols ?? [], edges: snapshot.edges ?? [] }, null, 2) + '\n',
    'utf-8',
  )
  // Re-extracting a repo that was previously forgotten must REVIVE it: clear any
  // codegraph tombstone for this path so the next mindSync doesn't (a) re-delete
  // the file we just wrote. Without this, forget would be irreversible per
  // machine. See forgetCodegraphSnapshot.
  try {
    const manifest = await readManifest()
    if (manifest.tombstones[repoPath]) {
      delete manifest.tombstones[repoPath]
      await writeManifest(manifest)
    }
  } catch {
    /* best-effort; the snapshot file is already written */
  }
  return repoPath
}

/**
 * Forget a repo's codegraph snapshot in the private-mind repo: delete
 * codegraph/<repo>/graph.json AND write a manifest tombstone so a peer's plain
 * delete doesn't resurrect it on the next sync (mirrors the memory-tier delete
 * → tombstone path). Filesystem + manifest only — no git, no graph; the next
 * mindSync commits/pushes. No-op when private-mind is disabled. Returns true
 * when a snapshot or manifest entry was actually removed.
 */
export const forgetCodegraphSnapshot = async (repo: string): Promise<boolean> => {
  if (!repo || !(await mindStatus()).enabled) return false
  const repoPath = codegraphRepoPath(repo)
  const abs = path.join(PRIVATE_MIND_PATH, repoPath)
  let existed = fsSync.existsSync(abs)
  let hash = 'forgotten'
  if (existed) {
    try {
      hash = sha256(await fs.readFile(abs, 'utf-8'))
    } catch {
      /* use sentinel */
    }
    await fs.rm(abs, { force: true })
  }
  const manifest = await readManifest()
  if (manifest.files[repoPath]) existed = true
  delete manifest.files[repoPath]
  manifest.tombstones[repoPath] = {
    deletedHash: hash,
    deletedAt: Date.now(),
    byMachine: getMachineId(),
  }
  await writeManifest(manifest)
  // Drop it from this machine's baseline so reconcile doesn't later see a
  // phantom "locally deleted vs base" (codegraph baseline is keyed by repoPath).
  try {
    const base = await readLocalBase()
    if (base[repoPath] !== undefined) {
      delete base[repoPath]
      await writeLocalBase(base)
    }
  } catch {
    /* best-effort */
  }
  return existed
}

/** Read a persisted codegraph snapshot back from the private-mind repo. */
export const readCodegraphSnapshot = async (
  repo: string,
): Promise<{ symbols: any[]; edges: any[] } | null> => {
  try {
    const raw = await fs.readFile(path.join(PRIVATE_MIND_PATH, codegraphRepoPath(repo)), 'utf-8')
    const j = JSON.parse(raw)
    return {
      symbols: Array.isArray(j.symbols) ? j.symbols : [],
      edges: Array.isArray(j.edges) ? j.edges : [],
    }
  } catch {
    return null
  }
}

interface ScannedCodegraph {
  repoPath: string
  repo: string
  hash: string
}

/** Scan codegraph/<repo>/graph.json snapshots present in the private-mind repo. */
const scanRepoCodegraph = async (): Promise<Map<string, ScannedCodegraph>> => {
  const out = new Map<string, ScannedCodegraph>()
  const root = path.join(PRIVATE_MIND_PATH, CODEGRAPH_REL)
  let repos: fsSync.Dirent[]
  try {
    repos = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const r of repos) {
    if (!r.isDirectory()) continue
    const repoPath = codegraphRepoPath(r.name)
    let content: string
    try {
      content = await fs.readFile(path.join(PRIVATE_MIND_PATH, repoPath), 'utf-8')
    } catch {
      continue
    }
    out.set(repoPath, { repoPath, repo: r.name, hash: sha256(content) })
  }
  return out
}

// ── profile tier (regenerable human-profile snapshot) ────────────────────────

/**
 * Persist the human-profile snapshot as the canonical, regenerable artifact at
 * profile/profile.json in the private-mind repo. Filesystem only (no git, no
 * graph) — the next mindSync commits/pushes it and replays it via
 * importProfileSnapshot (merge-by-group). No-op when private-mind is disabled
 * (community-safe). Returns the repo-relative path written, or null when disabled.
 */
export const persistProfileSnapshot = async (
  snapshot: { narrative: string; facets: unknown[] },
): Promise<string | null> => {
  if (!(await mindStatus()).enabled) return null
  const repoPath = profilePath()
  const abs = path.join(PRIVATE_MIND_PATH, repoPath)
  // Guard: never let a transient EMPTY snapshot clobber a previously-federated
  // non-empty profile. Facets can be momentarily 0 (e.g. just after a DB
  // cutover/restart, before they re-derive); a push in that window would
  // overwrite profile.json with an empty narrative+facets and silently
  // un-federate the profile to every peer (this is what stranded zw2's adopt).
  // Skip the write and keep the good snapshot — the next push with real facets
  // refreshes it.
  const isEmpty = (snapshot.facets?.length ?? 0) === 0 && !(snapshot.narrative ?? '').trim()
  if (isEmpty) {
    const existing = await readProfileSnapshot()
    if (existing && (existing.facets.length > 0 || existing.narrative.trim())) return null
  }
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(
    abs,
    JSON.stringify({ narrative: snapshot.narrative ?? '', facets: snapshot.facets ?? [] }, null, 2) + '\n',
    'utf-8',
  )
  return repoPath
}

/** Read the persisted human-profile snapshot back from the private-mind repo. */
export const readProfileSnapshot = async (): Promise<{ narrative: string; facets: any[] } | null> => {
  try {
    const raw = await fs.readFile(path.join(PRIVATE_MIND_PATH, profilePath()), 'utf-8')
    const j = JSON.parse(raw)
    return {
      narrative: typeof j.narrative === 'string' ? j.narrative : '',
      facets: Array.isArray(j.facets) ? j.facets : [],
    }
  } catch {
    return null
  }
}

/** Scan the profile/profile.json snapshot present in the private-mind repo. */
const scanRepoProfile = async (): Promise<{ repoPath: string; hash: string } | null> => {
  const repoPath = profilePath()
  try {
    const content = await fs.readFile(path.join(PRIVATE_MIND_PATH, repoPath), 'utf-8')
    return { repoPath, hash: sha256(content) }
  } catch {
    return null
  }
}

// ── conflict filename ─────────────────────────────────────────────────────────

const conflictRepoPath = (repoPath: string, byMachine: string, hash: string): string => {
  const dir = path.posix.dirname(repoPath)
  const base = path.posix.basename(repoPath, '.md')
  const safeMachine = byMachine.replace(/[^\w.-]/g, '-')
  return path.posix.join(dir, `${base}.conflict-${safeMachine}-${hash.slice(0, 8)}.md`)
}

// ── reconcile ────────────────────────────────────────────────────────────────

// Single-flight for mind-sync. mindSync does git (network) + filesystem only —
// NOT the graph — so it must NOT run under the graph write lock (a hung git push
// would otherwise starve every /api/graph/sync; that bug wedged the server).
// It still needs serializing against itself so two syncs don't race the same
// git repo. This chain does that without touching the graph lock.
let _mindChain: Promise<unknown> = Promise.resolve()
const withMindLock = <T>(op: () => Promise<T>): Promise<T> => {
  const run = _mindChain.then(op, op)
  _mindChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * Run a full bidirectional sync: pull, reconcile (initiator-driven, keep-both),
 * push. Returns a structured report. Does NOT re-index the graph — the caller
 * triggers ckn-sync through the server after this returns (so the single graph
 * writer stays the server). Serialized by withMindLock (git+fs only, never the
 * graph write lock). All git network ops are timeout-bounded (see runGit).
 */
export const mindSync = (opts: MindSyncOptions = {}): Promise<MindSyncReport> =>
  withMindLock(() => mindSyncInner(opts))

const mindSyncInner = async (opts: MindSyncOptions = {}): Promise<MindSyncReport> => {
  const push = opts.push ?? true
  const report = emptyReport()
  const status = await mindStatus()
  if (!status.enabled) {
    report.reason = status.reason
    return report
  }
  report.enabled = true
  const machineId = getMachineId()

  // 1. Sync the worktree to the remote — conflict-free transport (see
  //    syncWorktreeToRemote). The file-hash reconcile below re-applies this
  //    machine's contributions, so a dirty/diverged clone heals instead of
  //    stranding in a merge-conflict/non-fast-forward state.
  try {
    const r = await syncWorktreeToRemote(PRIVATE_MIND_PATH, { skipFetch: opts.skipWorktreeFetch })
    report.pulled = r.atRemote
    if (r.error) report.errors.push(`sync-to-remote: ${r.error}`)
  } catch (e: any) {
    report.errors.push(`sync-to-remote: ${e?.message ?? e}`)
  }

  const manifest = await readManifest()
  const localBase = await readLocalBase() // per-machine ancestor
  const local = await scanLocal()
  const repo = await scanRepo()

  // Build the union of paths to consider. Restrict to the memory/ tier — the
  // codegraph/ tier reconciles separately below; without this filter its
  // localBase entries would fall through to the "gone everywhere" branch
  // (repoToLocalPath returns null for them) and wrongly clear their manifest.
  const isMemoryPath = (p: string): boolean => p.startsWith('memory/')
  const paths = new Set<string>(
    [
      ...local.keys(),
      ...repo.keys(),
      ...Object.keys(localBase),
      ...Object.keys(manifest.tombstones),
    ].filter(isMemoryPath),
  )

  const writeLocal = async (repoPath: string, content: string) => {
    const lp = repoToLocalPath(repoPath)
    if (!lp) return
    await fs.mkdir(path.dirname(lp), { recursive: true })
    await fs.writeFile(lp, content, 'utf-8')
  }
  const writeRepo = async (repoPath: string, content: string) => {
    const rp = path.join(PRIVATE_MIND_PATH, repoPath)
    await fs.mkdir(path.dirname(rp), { recursive: true })
    await fs.writeFile(rp, content, 'utf-8')
  }
  const deleteLocalFile = async (repoPath: string) => {
    const lp = repoToLocalPath(repoPath)
    if (lp) await fs.rm(lp, { force: true })
  }
  const deleteRepoFile = async (repoPath: string) => {
    await fs.rm(path.join(PRIVATE_MIND_PATH, repoPath), { force: true })
  }

  const now = Date.now()
  // The 3-way ancestor is THIS machine's local baseline (what it last synced
  // to), not the federation-global manifest. `had` = this machine had the file.
  for (const p of paths) {
    const L = local.get(p)?.hash ?? null
    const R = repo.get(p)?.hash ?? null
    const base = localBase[p] ?? null
    const had = base !== null
    const tomb = manifest.tombstones[p] ?? null

    try {
      // ── in sync ──
      if (L && R && L === R) {
        manifest.files[p] = { hash: L, updatedAt: manifest.files[p]?.updatedAt ?? now, originMachine: manifest.files[p]?.originMachine ?? machineId }
        delete manifest.tombstones[p]
        continue
      }

      // ── both present, differ ──
      if (L && R && L !== R) {
        if (L === base) {
          // I'm unchanged since baseline; remote moved → adopt remote
          await writeLocal(p, repo.get(p)!.content)
          manifest.files[p] = { hash: R!, updatedAt: now, originMachine: manifest.files[p]?.originMachine ?? machineId }
          report.adopted.push(p)
        } else if (R === base) {
          // remote unchanged since my baseline; I moved → push local
          await writeRepo(p, local.get(p)!.content)
          manifest.files[p] = { hash: L!, updatedAt: now, originMachine: machineId }
          report.pushedFiles.push(p)
        } else {
          // both moved since baseline → keep-both. Local stays canonical
          // (initiator wins the slot); remote preserved as a .conflict-* memory.
          const remoteOrigin = manifest.files[p]?.originMachine ?? 'remote'
          const cPath = conflictRepoPath(p, remoteOrigin, R!)
          await writeLocal(cPath, repo.get(p)!.content)
          await writeRepo(cPath, repo.get(p)!.content)
          await writeRepo(p, local.get(p)!.content) // canonical = local
          manifest.files[p] = { hash: L!, updatedAt: now, originMachine: machineId }
          manifest.files[cPath] = { hash: R!, updatedAt: now, originMachine: remoteOrigin }
          report.conflicts.push(cPath)
        }
        continue
      }

      // ── local present, remote absent ──
      if (L && !R) {
        if (had && L === base) {
          // I had it, unchanged, and it's gone from the repo → remote deleted
          // it → respect the delete locally.
          await deleteLocalFile(p)
          delete manifest.files[p]
          if (!tomb) manifest.tombstones[p] = { deletedHash: L!, deletedAt: now, byMachine: machineId }
          report.deletedLocal.push(p)
        } else {
          // New local (never synced) OR I edited it after it was deleted
          // elsewhere → push/resurrect. Never lose a local edit.
          await writeRepo(p, local.get(p)!.content)
          delete manifest.tombstones[p]
          manifest.files[p] = { hash: L!, updatedAt: now, originMachine: machineId }
          if (had) report.resurrected.push(p)
          else report.pushedFiles.push(p)
        }
        continue
      }

      // ── remote present, local absent ──
      if (!L && R) {
        if (had && R === base) {
          // I had it, it's unchanged on the remote, and I removed it locally →
          // I deleted it → propagate the delete to the federation.
          await deleteRepoFile(p)
          delete manifest.files[p]
          manifest.tombstones[p] = { deletedHash: R!, deletedAt: now, byMachine: machineId }
          report.tombstoned.push(p)
        } else if (had && R !== base) {
          // I deleted it but the remote edited it since my baseline → adopt
          // the remote edit back rather than lose their content.
          await writeLocal(p, repo.get(p)!.content)
          delete manifest.tombstones[p]
          manifest.files[p] = { hash: R!, updatedAt: now, originMachine: manifest.files[p]?.originMachine ?? machineId }
          report.adopted.push(p)
        } else {
          // I never had it (fresh clone / new remote memory) → adopt.
          await writeLocal(p, repo.get(p)!.content)
          delete manifest.tombstones[p]
          manifest.files[p] = { hash: R!, updatedAt: now, originMachine: manifest.files[p]?.originMachine ?? machineId }
          report.adopted.push(p)
        }
        continue
      }

      // ── gone everywhere ──
      if (!L && !R) {
        delete manifest.files[p]
        // keep any tombstone so other machines still learn of the delete
      }
    } catch (e: any) {
      report.errors.push(`${p}: ${e?.message ?? e}`)
    }
  }

  // ── codegraph tier reconcile (regenerable; newest-wins, no keep-both) ──
  // Git already transported the snapshots (pull above / push below). Here we
  // only (a) refresh the manifest for snapshots present in the repo, and
  // (b) flag any whose hash differs from this machine's baseline so the caller
  // replays them into the graph. "Differs from baseline" covers both a snapshot
  // pulled from a peer and one this machine just wrote via persistCodegraphSnapshot;
  // re-replaying our own is idempotent (upsertSymbols preserves earned lifecycle).
  const repoCg = await scanRepoCodegraph()
  const codegraphAdopted: string[] = []
  const codegraphForgotten: string[] = []
  const isCodegraphPath = (p: string): boolean =>
    p.startsWith(CODEGRAPH_REL + '/') && p.endsWith('/graph.json')
  const repoFromCgPath = (p: string): string => p.split('/')[1] ?? ''

  // (a) Honor codegraph tombstones: a peer forgot this repo. Drop any stale
  // local snapshot file, clear the manifest file entry, and flag the repo so
  // the caller forgets it in the graph. A tombstone is terminal here — a legitimate
  // re-extraction clears it via persistCodegraphSnapshot on the owning machine.
  for (const p of Object.keys(manifest.tombstones)) {
    if (!isCodegraphPath(p)) continue
    const repoName = repoFromCgPath(p)
    if (!repoName) continue
    if (repoCg.get(p)) {
      // A snapshot still sits in the repo under a tombstone (our pulled tree had
      // the file, or we re-added it). Respect the forget: remove it so the push
      // doesn't resurrect it, and stop treating it as adopted.
      await deleteRepoFile(p)
      repoCg.delete(p)
    }
    delete manifest.files[p]
    codegraphForgotten.push(repoName)
  }

  // (b) Normal adopt pass for snapshots that survive (no live tombstone).
  for (const [rp, sf] of repoCg) {
    if (manifest.tombstones[rp]) continue
    if ((localBase[rp] ?? null) !== sf.hash) codegraphAdopted.push(sf.repo)
    manifest.files[rp] = {
      hash: sf.hash,
      updatedAt: now,
      originMachine: manifest.files[rp]?.originMachine ?? machineId,
    }
  }
  report.codegraphAdopted = [...new Set(codegraphAdopted)]
  report.codegraphForgotten = [...new Set(codegraphForgotten)]

  // ── profile tier reconcile (single regenerable snapshot; merge-by-group) ──
  // Git already transported profile/profile.json. Flag it adopted when its hash
  // differs from this machine's baseline (covers both a peer's snapshot and one
  // this machine just wrote via persistProfileSnapshot) so the caller replays it
  // into the graph; importProfileSnapshot unions evidence, so re-replaying is
  // idempotent. There is one human → no per-repo loop, no tombstones.
  const repoProfile = await scanRepoProfile()
  if (repoProfile) {
    if ((localBase[repoProfile.repoPath] ?? null) !== repoProfile.hash) report.profileAdopted = true
    manifest.files[repoProfile.repoPath] = {
      hash: repoProfile.hash,
      updatedAt: now,
      originMachine: manifest.files[repoProfile.repoPath]?.originMachine ?? machineId,
    }
  }

  // Recompute this machine's local baseline (the 3-way ancestor). It must
  // reflect FEDERATED state, so un-pushed local-origin changes keep their prior
  // base now (conservative); a successful push below advances them. See
  // nextLocalBase — this closes the reset-to-origin local-edit-loss trap.
  const localHashes: Record<string, string> = {}
  const finalLocal = await scanLocal()
  for (const [rp, sf] of finalLocal) localHashes[rp] = sf.hash
  // Codegraph + profile snapshots live in the repo, not under ~/.claude/memory,
  // so scanLocal misses them — seed them here.
  for (const [rp, sf] of repoCg) localHashes[rp] = sf.hash
  if (repoProfile) localHashes[repoProfile.repoPath] = repoProfile.hash
  // Conflict files we just wrote locally are also part of our state.
  for (const cp of report.conflicts) {
    const lp = repoToLocalPath(cp)
    if (lp) {
      try {
        localHashes[cp] = sha256(await fs.readFile(lp, 'utf-8'))
      } catch {
        /* skip */
      }
    }
  }
  // Files this machine changed locally — NOT federated until a push lands them.
  const localOrigin = new Set<string>([
    ...report.pushedFiles,
    ...report.resurrected,
    ...report.conflicts,
  ])
  await writeLocalBase(nextLocalBase({ prior: localBase, localHashes, localOrigin, federated: false }))

  // Record which local files changed this run for the post-reindex dedup pass.
  ;(report as MindSyncReport & { _changedLocal?: string[] })._changedLocal = [
    ...report.adopted,
    ...report.conflicts,
  ]
    .map((rp) => repoToLocalPath(rp))
    .filter((x): x is string => !!x)

  // 2. Stamp machine + commit + push.
  manifest.machines[machineId] = { hostname: os.hostname(), lastSeenMs: now, platform: `${os.platform()}/${os.arch()}` }
  manifest.lastSyncMs = now
  await writeManifest(manifest)

  // Pull-only mode (push:false) — used by the BOOT sync so a restart can't
  // silently federate local commits. Reconcile + adopt-remote already happened
  // above; we deliberately do NOT commit/push here. Any local-origin changes
  // (writeRepo / conflict files / manifest) stay in the working tree
  // uncommitted; the next explicit push:true sync (route, CLI, or
  // CKN_MIND_PUSH_ON_BOOT=1) commits + pushes them. report.pushed stays false.
  if (!push) {
    return report
  }

  // Refresh the regenerable human-profile snapshot from the live graph before we
  // stage+commit, so EVERY push — boot (CKN_MIND_PUSH_ON_BOOT=1), /cortex-snapshot, or a
  // manual ckn-mind-sync — federates the CURRENT profile, not whatever the last
  // /api/profile/observe happened to persist. Best-effort + lock-free (a graph
  // read): a failure here must never abort the memory/codegraph push below.
  try {
    const { exportProfileSnapshot } = await import('./graph/profile.js')
    const wrote = await persistProfileSnapshot(exportProfileSnapshot())
    if (wrote) report.pushedFiles.push(wrote)
  } catch (e: any) {
    report.errors.push(`profile-export: ${e?.message ?? e}`)
  }

  try {
    await runGit(PRIVATE_MIND_PATH, ['add', '-A'])
    const st = await runGit(PRIVATE_MIND_PATH, ['status', '--porcelain'], { allowFail: true })
    if (st.stdout.trim()) {
      await runGit(PRIVATE_MIND_PATH, [
        'commit',
        '-m',
        `mind-sync ${machineId} ${new Date(now).toISOString()}`,
      ])
      report.pushed = true
    }
    if (status.remote) {
      const pushed = await runGit(PRIVATE_MIND_PATH, ['push', 'origin', 'HEAD'], { allowFail: true, timeoutMs: 180_000 })
      if (pushed.code !== 0) {
        report.errors.push(`push: ${pushed.stderr.trim().slice(0, 200)}`)
        report.pushed = false
      }
    }
  } catch (e: any) {
    report.errors.push(`commit/push: ${e?.message ?? e}`)
  }

  // A push landed our local-origin changes on origin — advance their baseline so
  // the next sync sees them as in-sync (not perpetually "to push"). On a failed
  // push the conservative base from above stands, so they re-push next time.
  if (report.pushed && localOrigin.size > 0) {
    await writeLocalBase(nextLocalBase({ prior: localBase, localHashes, localOrigin, federated: true }))
  }

  return report
}

/**
 * Detection-only dedup pass (v1 — non-destructive). For each memory adopted or
 * conflicted this run, embed it and search the (freshly re-indexed) store for
 * near-identical existing memories (cosine ≥ 0.92). Returns candidate pairs for
 * the report; does NOT merge or delete anything — that's deferred to a session
 * or a future derive pass so the keep-both philosophy holds.
 *
 * Lock-free: embedding + searchSimilar read the sidecar, not the graph.
 */
export const detectDuplicates = async (
  changedLocalPaths: string[],
): Promise<{ id: string; near: string; score: number }[]> => {
  if (changedLocalPaths.length === 0) return []
  let embedText: (t: string) => Promise<Float32Array | null>
  let getEmbeddingMode: () => string
  let searchSimilar: (q: Float32Array, k: number, min: number) => Promise<{ id: string; score: number }[]>
  try {
    const m1 = await import('./embeddings.js')
    const m2 = await import('./embeddingStore.js')
    embedText = m1.embedText
    getEmbeddingMode = m1.getEmbeddingMode
    searchSimilar = m2.searchSimilar
  } catch {
    return []
  }
  if (getEmbeddingMode() === 'off') return []

  const out: { id: string; near: string; score: number }[] = []
  for (const lp of changedLocalPaths) {
    let content: string
    try {
      content = await fs.readFile(lp, 'utf-8')
    } catch {
      continue
    }
    // Strip frontmatter for the embed body; use the whole thing if no fence.
    const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim() || content
    const vec = await embedText(body.slice(0, 2000))
    if (!vec) continue
    const hits = await searchSimilar(vec, 6, 0.92)
    // The just-synced copy of THIS memory is in the store at ~1.0 — drop it.
    const others = hits.filter((h) => h.score < 0.999).slice(0, 2)
    for (const h of others) {
      out.push({ id: path.basename(lp, '.md'), near: h.id, score: Number(h.score.toFixed(3)) })
    }
  }
  return out
}

/** The local paths changed this run, stashed on the report by mindSync. */
export const changedLocalPaths = (report: MindSyncReport): string[] =>
  (report as MindSyncReport & { _changedLocal?: string[] })._changedLocal ?? []
