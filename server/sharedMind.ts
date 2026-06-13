/**
 * Shared mind — a git repo holding memories + config artifacts that
 * subscribers import into their local Cortex graph. Two-way pattern:
 *
 *   publish: select entity → queue → batch commit + push
 *   sync:    pull → import memories/*.md into graph as scope shared:<name>
 *
 * Repo layout (at the working clone path):
 *
 *   <path>/
 *     README.md                  # generated; bootstrap instructions
 *     .cortex/manifest.json      # schema version, contributors, item index
 *     memories/<slug>.md         # imported into graph as kind:memory
 *     artifacts/skills/<dir>/    # actual config files; not auto-installed
 *     artifacts/agents/<file>.md
 *     artifacts/commands/<file>.md
 *     artifacts/permissions/<file>.json
 *     catalog.md                 # human-readable index
 *
 * Each artifact has a companion memory in `memories/` describing what it
 * is, when to use it, and where to install. That's what Claude sees in
 * the graph; the artifact itself is on-disk and explicitly installed.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

export const DEFAULT_SHARED_PATH = path.join(os.homedir(), '.config', 'ckn', 'shared-mind')

export interface SharedQueueItem {
  /** Stable id — `<kind>:<slug>` for the file we'll write. Drives dedupe. */
  id: string
  /**
   * What kind of entity this is. Each maps to a distinct artifact path
   * + render function below.
   *
   *   memory      → memories/<slug>.md
   *   skill       → artifacts/skills/<slug>/SKILL.md
   *   agent       → artifacts/agents/<slug>.md
   *   command     → artifacts/commands/<path?>/<slug>.md
   *   rule        → artifacts/rules/<slug>.md
   *   permission  → artifacts/permissions/<slug>.json
   *   hook        → artifacts/hooks/<slug>.json
   *   mcp         → artifacts/mcp/<slug>.json
   */
  kind: 'memory' | 'skill' | 'agent' | 'command' | 'rule' | 'permission' | 'hook' | 'mcp'
  /** Display title for the queue UI. */
  title: string
  /** Optional one-liner description for the queue UI + companion memory. */
  description?: string
  /** Source entity payload — written verbatim to the artifact file (for skills/agents/commands/permissions) or used to render the memory body (for memories). */
  payload: Record<string, any>
  /** Source file path on disk, when applicable. Skills point at SKILL.md, agents at <name>.md, etc. */
  sourcePath?: string
  /**
   * Optional user-edited body for the published memory. When present this
   * replaces the auto-generated functional prose entirely. Lets the user
   * refine the "knowledge" before publishing — like a reviewer's note on
   * top of a generated draft.
   */
  bodyOverride?: string
  /** When the user added it to the queue. */
  queuedAt: number
}

export interface SharedStatus {
  localPath: string
  remoteUrl: string | null
  initialized: boolean
  hasRemote: boolean
  /** Branch name at the working clone, or null if not initialized. */
  branch: string | null
  /** Commits ahead/behind origin. Both 0 if no remote or fully in sync. */
  ahead: number
  behind: number
  /** True when there are uncommitted changes (other than the queue file itself). */
  dirty: boolean
  /** Last time we successfully ran `git pull`. */
  lastSyncMs: number | null
  /** Memory count under memories/. */
  memoryCount: number
  /** Artifact count under artifacts/. */
  artifactCount: number
}

interface ManifestShape {
  schemaVersion: 1
  /** Display name for this shared mind. Used in graph scope as `shared:<name>`. */
  name: string
  /** Free-form description of what this shared mind is about. */
  description?: string
  contributors?: string[]
  lastSyncMs?: number
}

const QUEUE_FILE = '.cortex/queue.json'

// ── git wrapper ──────────────────────────────────────────────────────────────

let gitChecked = false
let gitAvailable = false

/**
 * Verify the `git` binary is reachable on PATH. Cached after the first
 * call. The shared-mind feature is dead-ended without git; the runner
 * should fail loudly with a clean message instead of opaque ENOENTs.
 */
const checkGit = (): Promise<boolean> =>
  new Promise((resolve) => {
    if (gitChecked) return resolve(gitAvailable)
    const child = spawn('git', ['--version'], { stdio: 'ignore' })
    child.on('error', () => {
      gitChecked = true
      gitAvailable = false
      resolve(false)
    })
    child.on('close', (code) => {
      gitChecked = true
      gitAvailable = code === 0
      resolve(gitAvailable)
    })
  })

const runGit = async (
  cwd: string,
  args: string[],
  opts: { allowFail?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> => {
  if (!(await checkGit())) {
    const msg =
      "git binary not found on PATH — shared-mind features need git installed. Install it (apt/brew/winget install git) and restart cortex."
    if (opts.allowFail) return { code: 127, stdout: '', stderr: msg }
    throw new Error(msg)
  }
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: process.env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b) => (stdout += b.toString()))
    child.stderr.on('data', (b) => (stderr += b.toString()))
    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      const c = code ?? 0
      if (c !== 0 && !opts.allowFail) {
        reject(new Error(`git ${args.join(' ')} failed (${c}): ${stderr.trim() || stdout.trim()}`))
        return
      }
      resolve({ code: c, stdout, stderr })
    })
  })
}

// ── path helpers ─────────────────────────────────────────────────────────────

const ensureDir = async (p: string) => fs.mkdir(p, { recursive: true })

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'item'

const safeWrite = async (p: string, content: string) => {
  await ensureDir(path.dirname(p))
  await fs.writeFile(p, content, 'utf-8')
}

const safeReadJson = async <T = unknown>(p: string): Promise<T | null> => {
  try {
    return JSON.parse(await fs.readFile(p, 'utf-8')) as T
  } catch {
    return null
  }
}

// ── secret detection ─────────────────────────────────────────────────────────

/**
 * Detect whether a string looks like a credential. Conservative — false
 * positives are better than leaking a key. Used on MCP publish to scrub
 * literal env values (vs `${ENV_REF}` placeholders, which are safe).
 *
 * Triggers on:
 *  - Common provider prefixes (Anthropic, OpenAI, GitHub, Slack, Stripe, AWS)
 *  - Long high-entropy strings that aren't obvious URLs or filesystem paths
 *  - JWT-shaped tokens (three base64 segments separated by dots)
 *  - Bearer-style tokens
 */
const SECRET_PREFIX_PATTERNS = [
  /^sk-/i,             // Anthropic, OpenAI
  /^xoxb-|^xoxp-|^xoxa-/i, // Slack
  /^ghp_|^gho_|^ghs_|^github_pat_/i, // GitHub
  /^glpat-/i,          // GitLab
  /^AKIA[0-9A-Z]{16}/, // AWS access key
  /^pk_live_|^sk_live_|^pk_test_|^sk_test_/i, // Stripe
  /^Bearer\s/i,        // Bearer tokens
]

const looksLikeSecret = (value: string): boolean => {
  if (!value || value.length < 16) return false
  // Reference, not value — these are safe.
  if (value.startsWith('${') || value.startsWith('$(')) return false
  // Filesystem paths and URLs aren't secrets.
  if (value.startsWith('/') || /^https?:\/\//i.test(value)) return false
  for (const re of SECRET_PREFIX_PATTERNS) {
    if (re.test(value)) return true
  }
  // JWT (three dot-separated base64 segments).
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return true
  // Long high-entropy alphanumerics (≥32 chars, mix of upper/lower/digit).
  if (
    value.length >= 32 &&
    /[a-z]/.test(value) &&
    /[A-Z]/.test(value) &&
    /[0-9]/.test(value) &&
    !/\s/.test(value)
  ) {
    return true
  }
  return false
}

/**
 * Scan an env-style record for likely secrets and replace each with a
 * `${KEY}` placeholder so the published artifact references an env var
 * instead of leaking the literal value. Returns the redacted env plus
 * the list of keys that were redacted (for warning the publisher).
 */
const scrubEnvSecrets = (
  env: Record<string, unknown>,
): { scrubbed: Record<string, string>; redactedKeys: string[] } => {
  const scrubbed: Record<string, string> = {}
  const redactedKeys: string[] = []
  for (const [k, v] of Object.entries(env ?? {})) {
    const value = typeof v === 'string' ? v : JSON.stringify(v)
    if (looksLikeSecret(value)) {
      scrubbed[k] = '${' + k + '}'
      redactedKeys.push(k)
    } else {
      scrubbed[k] = value
    }
  }
  return { scrubbed, redactedKeys }
}

// ── manifest ─────────────────────────────────────────────────────────────────

const defaultName = (localPath: string): string => path.basename(localPath)

const readManifest = async (localPath: string): Promise<ManifestShape> => {
  const m = await safeReadJson<ManifestShape>(path.join(localPath, '.cortex', 'manifest.json'))
  if (m && m.schemaVersion === 1) return m
  // Bootstrap a minimal manifest on first read.
  return {
    schemaVersion: 1,
    name: defaultName(localPath),
    description: '',
    contributors: [],
  }
}

const writeManifest = async (localPath: string, m: ManifestShape): Promise<void> => {
  await safeWrite(path.join(localPath, '.cortex', 'manifest.json'), JSON.stringify(m, null, 2))
}

// ── queue ────────────────────────────────────────────────────────────────────

export const readQueue = async (localPath: string): Promise<SharedQueueItem[]> => {
  const items = await safeReadJson<SharedQueueItem[]>(path.join(localPath, QUEUE_FILE))
  return Array.isArray(items) ? items : []
}

export const writeQueue = async (localPath: string, items: SharedQueueItem[]): Promise<void> => {
  await safeWrite(path.join(localPath, QUEUE_FILE), JSON.stringify(items, null, 2))
}

export const enqueueItem = async (
  localPath: string,
  item: SharedQueueItem,
): Promise<SharedQueueItem[]> => {
  await ensureClone(localPath)
  const items = await readQueue(localPath)
  // Idempotent — replace if id already present.
  const next = items.filter((q) => q.id !== item.id)
  next.push(item)
  await writeQueue(localPath, next)
  return next
}

export const removeFromQueue = async (
  localPath: string,
  id: string,
): Promise<SharedQueueItem[]> => {
  const items = await readQueue(localPath)
  const next = items.filter((q) => q.id !== id)
  await writeQueue(localPath, next)
  return next
}

/**
 * Patch a queued item's user-editable fields. Lets the SharedMindDialog
 * refine the auto-generated content (title, description, body) before
 * publishing without forcing a re-queue from the source entity.
 */
export const updateQueueItem = async (
  localPath: string,
  id: string,
  patch: Partial<Pick<SharedQueueItem, 'title' | 'description' | 'bodyOverride'>>,
): Promise<SharedQueueItem[]> => {
  const items = await readQueue(localPath)
  const idx = items.findIndex((q) => q.id === id)
  if (idx < 0) return items
  const current = items[idx]!
  const next: SharedQueueItem = {
    ...current,
    title: patch.title ?? current.title,
    description: patch.description ?? current.description,
    // Allow clearing bodyOverride by passing empty string.
    bodyOverride:
      patch.bodyOverride !== undefined
        ? patch.bodyOverride === ''
          ? undefined
          : patch.bodyOverride
        : current.bodyOverride,
  }
  const out = items.slice()
  out[idx] = next
  await writeQueue(localPath, out)
  return out
}

// ── ensure clone exists ──────────────────────────────────────────────────────

const isGitRepo = async (p: string): Promise<boolean> => {
  try {
    await fs.stat(path.join(p, '.git'))
    return true
  } catch {
    return false
  }
}

/**
 * If the local path doesn't exist, create + `git init`. If it exists but
 * isn't a git repo, run `git init` in place. If a manifest is missing,
 * write a minimal one. Idempotent — safe to call on every operation.
 */
export const ensureClone = async (localPath: string): Promise<void> => {
  await ensureDir(localPath)
  if (!(await isGitRepo(localPath))) {
    await runGit(localPath, ['init', '--initial-branch=main'])
  }
  const manifestPath = path.join(localPath, '.cortex', 'manifest.json')
  if (!(await safeReadJson(manifestPath))) {
    await writeManifest(localPath, {
      schemaVersion: 1,
      name: defaultName(localPath),
      description: '',
      contributors: [],
    })
  }
  // Make sure the queue file exists so subsequent reads don't fight a missing path.
  const queuePath = path.join(localPath, QUEUE_FILE)
  if (!(await safeReadJson(queuePath))) {
    await writeQueue(localPath, [])
  }
}

// ── status ───────────────────────────────────────────────────────────────────

const remoteUrlOf = async (localPath: string): Promise<string | null> => {
  if (!(await isGitRepo(localPath))) return null
  const r = await runGit(localPath, ['remote', 'get-url', 'origin'], { allowFail: true })
  if (r.code !== 0) return null
  return r.stdout.trim() || null
}

const branchOf = async (localPath: string): Promise<string | null> => {
  if (!(await isGitRepo(localPath))) return null
  const r = await runGit(localPath, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })
  if (r.code !== 0) return null
  const name = r.stdout.trim()
  return name === 'HEAD' ? null : name
}

const aheadBehind = async (
  localPath: string,
  branch: string,
): Promise<{ ahead: number; behind: number }> => {
  // Try origin/<branch>; fall back to (0, 0) when no remote is configured.
  const r = await runGit(
    localPath,
    ['rev-list', '--left-right', '--count', `${branch}...origin/${branch}`],
    { allowFail: true },
  )
  if (r.code !== 0) return { ahead: 0, behind: 0 }
  const m = r.stdout.trim().match(/^(\d+)\s+(\d+)$/)
  if (!m) return { ahead: 0, behind: 0 }
  return { ahead: parseInt(m[1] ?? '0', 10), behind: parseInt(m[2] ?? '0', 10) }
}

const isDirty = async (localPath: string): Promise<boolean> => {
  if (!(await isGitRepo(localPath))) return false
  const r = await runGit(localPath, ['status', '--porcelain'], { allowFail: true })
  if (r.code !== 0) return false
  // The queue file changes during normal operation — don't treat its
  // presence as "dirty" for status display purposes.
  const lines = r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.endsWith(QUEUE_FILE))
  return lines.length > 0
}

const countFiles = async (dir: string, suffix?: string): Promise<number> => {
  let total = 0
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) total += await countFiles(full, suffix)
      else if (e.isFile() && (!suffix || e.name.endsWith(suffix))) total++
    }
  } catch {
    // dir may not exist
  }
  return total
}

export const status = async (localPath: string): Promise<SharedStatus> => {
  const initialized = await isGitRepo(localPath)
  if (!initialized) {
    return {
      localPath,
      remoteUrl: null,
      initialized: false,
      hasRemote: false,
      branch: null,
      ahead: 0,
      behind: 0,
      dirty: false,
      lastSyncMs: null,
      memoryCount: 0,
      artifactCount: 0,
    }
  }
  const [remoteUrl, branch, dirty, manifest, memoryCount, artifactCount] = await Promise.all([
    remoteUrlOf(localPath),
    branchOf(localPath),
    isDirty(localPath),
    readManifest(localPath),
    countFiles(path.join(localPath, 'memories'), '.md'),
    countFiles(path.join(localPath, 'artifacts')),
  ])
  let ahead = 0
  let behind = 0
  if (remoteUrl && branch) {
    const ab = await aheadBehind(localPath, branch)
    ahead = ab.ahead
    behind = ab.behind
  }
  return {
    localPath,
    remoteUrl,
    initialized,
    hasRemote: !!remoteUrl,
    branch,
    ahead,
    behind,
    dirty,
    lastSyncMs: manifest.lastSyncMs ?? null,
    memoryCount,
    artifactCount,
  }
}

// ── remote management ────────────────────────────────────────────────────────

export const setRemote = async (localPath: string, url: string): Promise<void> => {
  await ensureClone(localPath)
  const existing = await remoteUrlOf(localPath)
  if (existing === url) return
  if (existing) {
    await runGit(localPath, ['remote', 'set-url', 'origin', url])
  } else {
    await runGit(localPath, ['remote', 'add', 'origin', url])
  }
}

// ── publish ──────────────────────────────────────────────────────────────────

/**
 * Render the published memory file for a queued item.
 *
 * Memory shape goal: teach Claude *about the concept* with enough
 * functional knowledge to use the thing — even before the artifact (the
 * "recipe") is installed locally. Like learning what peanut butter is
 * versus knowing the recipe: the memory is the former.
 *
 * If `bodyOverride` is set, the caller has supplied their own functional
 * prose; we use it verbatim. Otherwise we synthesize a kind-specific
 * draft from the entity payload + the artifact body where available.
 */
const renderMemoryFile = (item: SharedQueueItem): string => {
  const slug = slugify(item.title)
  const artifactRelPath =
    item.kind === 'memory' ? null : artifactRelativePath(item.kind, slug, item.payload)

  const fm: string[] = ['---', `name: ${escFm(item.title)}`]
  if (item.description) fm.push(`description: ${escFm(item.description)}`)
  fm.push(`type: ${memoryFrontmatterType(item.kind)}`)
  if (artifactRelPath) fm.push(`artifact: ${artifactRelPath}`)
  fm.push(`source: shared`)
  fm.push('---', '')

  const body = item.bodyOverride?.trim()
    ? item.bodyOverride.trim()
    : renderFunctionalBody(item, artifactRelPath ?? undefined)
  return fm.join('\n') + body + '\n'
}

const escFm = (s: string): string => s.replace(/\n/g, ' ').trim()

const memoryFrontmatterType = (kind: SharedQueueItem['kind']): string => {
  // `memory` stays plain memory; everything else announces itself as
  // knowledge of a specific kind so subscriber-side tooling can detect
  // "you have memory of this <kind> but it isn't installed locally yet".
  return kind === 'memory' ? 'memory' : `${kind}-knowledge`
}

/**
 * Synthesize the functional body of a published memory. The user can
 * always override this by setting `bodyOverride` on the queue item — see
 * the queue editor in SharedMindDialog.
 */
const renderFunctionalBody = (item: SharedQueueItem, artifactRelPath?: string): string => {
  const publishedBy = item.payload.publishedBy ?? 'unknown'
  switch (item.kind) {
    case 'memory':
      return renderMemoryBody(item, publishedBy)
    case 'skill':
      return renderSkillKnowledge(item, artifactRelPath, publishedBy)
    case 'agent':
      return renderAgentKnowledge(item, artifactRelPath, publishedBy)
    case 'command':
      return renderCommandKnowledge(item, artifactRelPath, publishedBy)
    case 'rule':
      return renderRuleKnowledge(item, artifactRelPath, publishedBy)
    case 'permission':
      return renderPermissionKnowledge(item, artifactRelPath, publishedBy)
    case 'hook':
      return renderHookKnowledge(item, artifactRelPath, publishedBy)
    case 'mcp':
      return renderMcpKnowledge(item, artifactRelPath, publishedBy)
  }
}

// ── per-kind functional templates ────────────────────────────────────────────

const renderMemoryBody = (item: SharedQueueItem, publishedBy: string): string => {
  const text = String(item.payload.body ?? item.payload.content ?? '').trim()
  const provenance = item.payload.graphKind
    ? `\n\n_Originally a graph entry of kind \`${item.payload.graphKind}\` under scope \`${item.payload.graphScope ?? 'unknown'}\` · shared by ${publishedBy}._`
    : `\n\n_Shared by ${publishedBy}._`
  return text + provenance
}

const renderSkillKnowledge = (
  item: SharedQueueItem,
  artifactRelPath: string | undefined,
  publishedBy: string,
): string => {
  const v = item.payload
  const desc = item.description || v.description || ''
  const body = String(v.body ?? '').trim()
  const tools = Array.isArray(v.allowedTools) ? v.allowedTools.join(', ') : null
  const lines: string[] = []
  lines.push(`# ${item.title} (skill)`, '')
  if (desc) lines.push(desc, '')
  lines.push(
    `This is a Claude Code **skill** that ${publishedBy === 'unknown' ? 'someone' : publishedBy} uses regularly. Skills are reusable instruction blocks Claude can invoke when relevant; you don't need the underlying file installed to *understand* what this one does, only to invoke it directly.`,
    '',
  )
  if (body) {
    lines.push('## What it does', '')
    lines.push(body, '')
  }
  if (tools) {
    lines.push('## Tools it uses', '', tools, '')
  }
  lines.push('## Using this knowledge', '')
  lines.push(
    `If you (the reading Claude) already have a \`${item.title}\` skill installed locally, just invoke it as you would any skill. `,
    `If you don't, you have two options:`,
    '',
    `1. **Use the knowledge directly** — the "What it does" section above is the actual instruction body of the skill, so you can follow it inline without installing anything.`,
    `2. **Install the recipe** — copy \`${artifactRelPath}\` from this shared mind into \`~/.claude/skills/\` so the skill becomes invocable as a first-class command.`,
    '',
  )
  lines.push(`_Shared by ${publishedBy}._`)
  return lines.join('\n')
}

const renderAgentKnowledge = (
  item: SharedQueueItem,
  artifactRelPath: string | undefined,
  publishedBy: string,
): string => {
  const v = item.payload
  const desc = item.description || v.description || ''
  const body = String(v.body ?? '').trim()
  const tools = Array.isArray(v.tools) ? v.tools.join(', ') : null
  const model = v.model ?? null
  const lines: string[] = []
  lines.push(`# ${item.title} (sub-agent)`, '')
  if (desc) lines.push(desc, '')
  lines.push(
    `This is a Claude Code **sub-agent** ${publishedBy === 'unknown' ? '' : `${publishedBy} uses `}for delegated work. Sub-agents are spawned via the Agent/Task tool with a specialized prompt and a constrained toolset.`,
    '',
  )
  if (body) {
    lines.push('## Behavior', '')
    lines.push(body, '')
  }
  if (tools) lines.push(`**Tools available to this agent:** ${tools}`, '')
  if (model) lines.push(`**Model preference:** \`${model}\``, '')
  lines.push('## Using this knowledge', '')
  lines.push(
    `If you have this agent installed, invoke via the Agent tool with \`subagent_type: "${item.title}"\`. `,
    `If not, the recipe is at \`${artifactRelPath}\` — copy to \`~/.claude/agents/\` to enable. `,
    `Even without installing, the "Behavior" section above tells you what kind of work this agent specialises in, so you can either spawn a generic agent with a similar prompt or do the work inline.`,
    '',
  )
  lines.push(`_Shared by ${publishedBy}._`)
  return lines.join('\n')
}

const renderCommandKnowledge = (
  item: SharedQueueItem,
  artifactRelPath: string | undefined,
  publishedBy: string,
): string => {
  const v = item.payload
  const desc = item.description || v.description || ''
  const body = String(v.body ?? '').trim()
  const lines: string[] = []
  lines.push(`# /${item.title} (slash command)`, '')
  if (desc) lines.push(desc, '')
  lines.push(
    `This is a Claude Code **slash command** ${publishedBy === 'unknown' ? '' : `${publishedBy} has set up `}for a recurring task. Slash commands are user-invokable shortcuts in the Claude Code CLI.`,
    '',
  )
  if (body) {
    lines.push('## What `/' + item.title + '` does', '')
    lines.push(body, '')
  }
  lines.push('## Using this knowledge', '')
  lines.push(
    `If \`/${item.title}\` is installed, the user can invoke it directly. `,
    `If not, the recipe is at \`${artifactRelPath}\`. Copy it to \`~/.claude/commands/\` to enable. `,
    `If the user describes the same need (the "What it does" section above), you can perform the same work inline using your existing tools.`,
    '',
  )
  lines.push(`_Shared by ${publishedBy}._`)
  return lines.join('\n')
}

const renderRuleKnowledge = (
  item: SharedQueueItem,
  artifactRelPath: string | undefined,
  publishedBy: string,
): string => {
  const v = item.payload
  const desc = item.description || v.description || ''
  const body = String(v.body ?? '').trim()
  const lines: string[] = []
  lines.push(`# ${item.title} (operating rule)`, '')
  if (desc) lines.push(desc, '')
  lines.push(
    `This is a Claude Code **rule** ${publishedBy === 'unknown' ? '' : `${publishedBy} applies to their work`}. Rules are persistent operating guidelines Claude is meant to honour across all turns of a session.`,
    '',
  )
  if (body) {
    lines.push('## The rule', '')
    lines.push(body, '')
  }
  lines.push('## Using this knowledge', '')
  lines.push(
    `If you have this rule installed locally (\`~/.claude/rules/\`), it should already shape your behaviour. `,
    `If not, the recipe is at \`${artifactRelPath}\`. Even without installing, you can apply the spirit of the rule by following the "The rule" section above when working with anyone using this shared mind.`,
    '',
  )
  lines.push(`_Shared by ${publishedBy}._`)
  return lines.join('\n')
}

const renderPermissionKnowledge = (
  item: SharedQueueItem,
  artifactRelPath: string | undefined,
  publishedBy: string,
): string => {
  const v = item.payload
  const mode = String(v.mode ?? 'allow')
  const pattern = String(v.pattern ?? '')
  const desc = item.description || ''
  const lines: string[] = []
  lines.push(`# Permission · ${mode}: \`${pattern}\``, '')
  if (desc) lines.push(desc, '')
  lines.push(
    mode === 'allow'
      ? `${publishedBy === 'unknown' ? 'Someone' : publishedBy} grants Claude this permission without prompting. The pattern \`${pattern}\` covers operations they've decided are routinely safe in their environment.`
      : mode === 'deny'
        ? `${publishedBy === 'unknown' ? 'Someone' : publishedBy} explicitly forbids Claude from running operations matching \`${pattern}\`. There's a reason — investigate before considering similar operations on the user's system.`
        : `${publishedBy === 'unknown' ? 'Someone' : publishedBy} requires Claude to ask before running operations matching \`${pattern}\`. The pattern is sensitive enough to warrant explicit confirmation each time.`,
    '',
  )
  lines.push('## Using this knowledge', '')
  lines.push(
    `If your local user has the same permission rule installed, you can act accordingly. `,
    `Otherwise, treat any operation matching \`${pattern}\` according to your local user's defaults — don't assume the same trust level. The recipe (the JSON form of this rule) is at \`${artifactRelPath}\`.`,
    '',
  )
  lines.push(`_Shared by ${publishedBy}._`)
  return lines.join('\n')
}

const renderHookKnowledge = (
  item: SharedQueueItem,
  artifactRelPath: string | undefined,
  publishedBy: string,
): string => {
  const v = item.payload
  const event = String(v.event ?? 'unknown')
  const matcher = String(v.matcher ?? '')
  const handlers: any[] = Array.isArray(v.handlers) ? v.handlers : []
  const desc = item.description || ''
  const lines: string[] = []
  lines.push(`# Hook · ${event}${matcher ? ` [${matcher}]` : ''}`, '')
  if (desc) lines.push(desc, '')
  lines.push(
    `This is a Claude Code **hook** ${publishedBy === 'unknown' ? '' : `${publishedBy} runs `}on \`${event}\` events${matcher ? ` matching \`${matcher}\`` : ' (any matcher)'}. Hooks are commands the Claude Code runtime invokes automatically at well-defined lifecycle points.`,
    '',
  )
  lines.push(eventExplanation(event), '')
  if (handlers.length > 0) {
    lines.push('## What it runs', '')
    for (const h of handlers) {
      const cmd = String(h.command ?? '').slice(0, 200)
      lines.push(`- \`${cmd}\``)
      if (h.timeout) lines.push(`  - timeout: ${h.timeout}s`)
    }
    lines.push('')
  }
  lines.push('## Using this knowledge', '')
  lines.push(
    `Hooks are local automation — they can't be "called", only registered. The functional point for you is awareness: when ${publishedBy === 'unknown' ? 'this user' : publishedBy} uses a session, the operations above happen automatically. Behave accordingly (e.g. don't manually run something a hook will run automatically). `,
    '',
    `If your local user wants the same hook, the recipe is at \`${artifactRelPath}\`. Note: the commands above may reference paths specific to ${publishedBy}'s machine — review and adjust before merging into your user's \`~/.claude/settings.json\`.`,
    '',
  )
  lines.push(`_Shared by ${publishedBy}._`)
  return lines.join('\n')
}

const eventExplanation = (event: string): string => {
  switch (event) {
    case 'PreToolUse':
      return '`PreToolUse` fires before each tool call — typically used for permission checks or telemetry.'
    case 'PostToolUse':
      return '`PostToolUse` fires after each tool call — typically used to react to outputs (e.g. logging, recall on errors).'
    case 'UserPromptSubmit':
      return '`UserPromptSubmit` fires when the user submits a turn — used for context injection.'
    case 'Notification':
      return '`Notification` fires on system notifications.'
    case 'Stop':
      return '`Stop` fires when a session ends — typically used for cleanup, summary writes, or memory sync.'
    case 'SubagentStop':
      return '`SubagentStop` fires when a sub-agent completes its work.'
    case 'SessionStart':
      return '`SessionStart` fires when a Claude Code session begins — used for context injection (memory, capabilities, etc.).'
    case 'PreCompact':
      return '`PreCompact` fires before a `/compact` operation — used to capture state before context summarisation.'
    case 'PostCompact':
      return '`PostCompact` fires after a `/compact` operation — used to re-inject context that compaction discarded.'
    case 'SessionEnd':
      return '`SessionEnd` fires when a session ends — similar to Stop but at session-process exit.'
    default:
      return `\`${event}\` is a Claude Code lifecycle event.`
  }
}

const renderMcpKnowledge = (
  item: SharedQueueItem,
  artifactRelPath: string | undefined,
  publishedBy: string,
): string => {
  const v = item.payload
  const name = String(v.name ?? item.title)
  const desc = item.description || ''
  const transport = String(v.type ?? 'stdio')
  // Recompute the redacted-keys list so the memory can warn subscribers
  // about which env vars they need to set.
  const sourceEnv =
    typeof v.env === 'object' && v.env ? (v.env as Record<string, unknown>) : {}
  const { redactedKeys } = scrubEnvSecrets(sourceEnv)
  const lines: string[] = []
  lines.push(`# MCP server · ${name}`, '')
  if (desc) lines.push(desc, '')
  lines.push(
    `${publishedBy === 'unknown' ? 'Someone' : publishedBy} uses an **MCP server** named \`${name}\`. MCP (Model Context Protocol) servers expose external tools to Claude — they show up in your tool list with names prefixed \`mcp__${name}__*\`.`,
    '',
    `**Transport:** \`${transport}\``,
    '',
  )
  if (v.command) {
    lines.push(`**How it's launched:** \`${String(v.command)}${Array.isArray(v.args) && v.args.length ? ' ' + v.args.join(' ') : ''}\``, '')
  }
  if (v.url) {
    lines.push(`**URL:** \`${String(v.url)}\``, '')
  }
  if (redactedKeys.length > 0) {
    lines.push(
      `**Required env vars:** the published config replaces ${redactedKeys.length} secret-shaped value${redactedKeys.length === 1 ? '' : 's'} with placeholders — \`${redactedKeys.join('`, `')}\`. Set these in your shell or in your \`.claude.json\` env block before invoking the MCP.`,
      '',
    )
  }
  lines.push('## Using this knowledge', '')
  lines.push(
    `If your local user has \`${name}\` configured in their \`~/.claude.json\` \`mcpServers\` block, you'll see \`mcp__${name}__*\` tools in your toolset — invoke them like any other tool. `,
    `If not, the recipe is at \`${artifactRelPath}\`. Even without local install, the awareness here matters: when ${publishedBy === 'unknown' ? 'this user' : publishedBy} mentions tasks that this MCP would handle, you can suggest enabling it rather than reaching for inferior alternatives.`,
    '',
  )
  lines.push(`_Shared by ${publishedBy}._`)
  return lines.join('\n')
}

const artifactRelativePath = (
  kind: SharedQueueItem['kind'],
  slug: string,
  payload: Record<string, any>,
): string => {
  switch (kind) {
    case 'skill':
      return `artifacts/skills/${slug}/SKILL.md`
    case 'agent':
      return `artifacts/agents/${slug}.md`
    case 'command':
      return payload.path
        ? `artifacts/commands/${payload.path}/${slug}.md`
        : `artifacts/commands/${slug}.md`
    case 'rule':
      return `artifacts/rules/${slug}.md`
    case 'permission':
      return `artifacts/permissions/${slug}.json`
    case 'hook':
      return `artifacts/hooks/${slug}.json`
    case 'mcp':
      return `artifacts/mcp/${slug}.json`
    case 'memory':
      return `memories/${slug}.md`
  }
}

const renderArtifactFile = (item: SharedQueueItem): string => {
  switch (item.kind) {
    case 'memory':
      return renderMemoryFile(item)
    case 'skill': {
      // Skills are markdown with frontmatter — write the same shape as ~/.claude/skills/<name>/SKILL.md
      const fm = [
        '---',
        `name: ${item.payload.name ?? item.title}`,
        `description: ${item.payload.description ?? ''}`,
      ]
      if (Array.isArray(item.payload.allowedTools)) {
        fm.push(`allowed-tools: [${item.payload.allowedTools.join(', ')}]`)
      }
      if (item.payload.license) fm.push(`license: ${item.payload.license}`)
      fm.push('---', '', String(item.payload.body ?? ''))
      return fm.join('\n')
    }
    case 'agent': {
      const fm = ['---', `name: ${item.payload.name ?? item.title}`, `description: ${item.payload.description ?? ''}`]
      if (item.payload.model) fm.push(`model: ${item.payload.model}`)
      if (Array.isArray(item.payload.tools)) fm.push(`tools: [${item.payload.tools.join(', ')}]`)
      if (item.payload.color) fm.push(`color: ${item.payload.color}`)
      fm.push('---', '', String(item.payload.body ?? ''))
      return fm.join('\n')
    }
    case 'command': {
      const fm = ['---', `name: ${item.payload.name ?? item.title}`, `description: ${item.payload.description ?? ''}`]
      if (item.payload.path) fm.push(`path: ${item.payload.path}`)
      fm.push('---', '', String(item.payload.body ?? ''))
      return fm.join('\n')
    }
    case 'rule': {
      // Rules look the same on disk as skills/agents — markdown with
      // frontmatter — but live under ~/.claude/rules/<name>.md.
      const fm = ['---', `name: ${item.payload.name ?? item.title}`, `description: ${item.payload.description ?? ''}`]
      if (item.payload.path) fm.push(`path: ${item.payload.path}`)
      fm.push('---', '', String(item.payload.body ?? ''))
      return fm.join('\n')
    }
    case 'permission': {
      // Permissions are stored as JSON so subscribers can review and merge.
      const data = {
        mode: item.payload.mode,
        pattern: item.payload.pattern,
        notes: item.description ?? '',
      }
      return JSON.stringify(data, null, 2)
    }
    case 'hook': {
      // Hooks live under settings.json `hooks.<event>` arrays. Capturing
      // event + matcher + handlers lets a subscriber merge it into the
      // matching event group on their side. Commands are PRESERVED VERBATIM —
      // subscribers must trust the publisher (or rewrite paths). Notes
      // line carries any caveats from the publisher.
      const data = {
        event: item.payload.event,
        matcher: item.payload.matcher ?? '',
        handlers: Array.isArray(item.payload.handlers) ? item.payload.handlers : [],
        notes: item.description ?? '',
      }
      return JSON.stringify(data, null, 2)
    }
    case 'mcp': {
      // MCP servers live in `~/.claude.json` mcpServers. We carry the
      // server config; `env` is scanned for likely secrets and each is
      // replaced with a `${KEY}` placeholder so the artifact never
      // contains literal credentials. Subscribers fill in their own.
      const sourceEnv =
        typeof item.payload.env === 'object' && item.payload.env
          ? (item.payload.env as Record<string, unknown>)
          : {}
      const { scrubbed, redactedKeys } = scrubEnvSecrets(sourceEnv)
      const data = {
        name: item.payload.name ?? item.title,
        type: item.payload.type ?? 'stdio',
        command: item.payload.command ?? '',
        args: Array.isArray(item.payload.args) ? item.payload.args : [],
        env: scrubbed,
        url: item.payload.url ?? undefined,
        enabled: item.payload.enabled !== false,
        notes: item.description ?? '',
        ...(redactedKeys.length > 0
          ? { _redacted_env_keys: redactedKeys, _redaction_note: 'Values replaced with ${KEY} placeholders. Subscribers must set these env vars locally.' }
          : {}),
      }
      return JSON.stringify(data, null, 2)
    }
  }
}

export interface PublishOptions {
  /** Optional commit message override. Defaults to a generated summary. */
  message?: string
  /** Author identity for the companion memory's "shared by" line. */
  publishedBy?: string
  /** Push after committing? Default true; disable for dry runs. */
  push?: boolean
}

export interface PublishResult {
  itemsWritten: number
  filesCommitted: number
  pushed: boolean
  pushError: string | null
  commitSha: string | null
}

/**
 * Drain the queue: write every queued item's artifact + companion memory
 * file, regenerate README and catalog, commit, push (if enabled).
 *
 * If anything fails before commit, the working tree is left as-is for the
 * user to inspect — we don't try to revert. If commit succeeds but push
 * fails (network, auth), the commit stays — `pushError` is reported and
 * the user can retry sync later.
 */
export const publishQueue = async (
  localPath: string,
  opts: PublishOptions = {},
): Promise<PublishResult> => {
  await ensureClone(localPath)
  const items = await readQueue(localPath)
  if (items.length === 0) {
    return {
      itemsWritten: 0,
      filesCommitted: 0,
      pushed: false,
      pushError: null,
      commitSha: null,
    }
  }
  const publishedBy = opts.publishedBy ?? (process.env.USER ?? 'cortex')
  const writtenFiles: string[] = []

  for (const item of items) {
    const slug = slugify(item.title)
    const memoryPath = path.join(localPath, 'memories', `${slug}.md`)
    // Tag the publishedBy onto the payload so the rendered companion memory
    // includes it.
    const enriched: SharedQueueItem = {
      ...item,
      payload: { ...item.payload, publishedBy },
    }
    await safeWrite(memoryPath, renderMemoryFile(enriched))
    writtenFiles.push(memoryPath)

    if (item.kind !== 'memory') {
      const artifactPath = path.join(
        localPath,
        artifactRelativePath(item.kind, slug, enriched.payload),
      )
      await safeWrite(artifactPath, renderArtifactFile(enriched))
      writtenFiles.push(artifactPath)
    }
  }

  // Regenerate the index files from disk after writing.
  await regenerateIndex(localPath)

  // Commit everything that changed under the working tree.
  await runGit(localPath, ['add', '.'])
  const messageLines = opts.message
    ? [opts.message]
    : [
        `cortex: publish ${items.length} item${items.length === 1 ? '' : 's'}`,
        '',
        ...items.map((i) => `- ${i.kind}: ${i.title}`),
      ]
  const message = messageLines.join('\n')
  // No-op commit if nothing changed (e.g. all queued items already match disk).
  const statusBefore = await runGit(localPath, ['status', '--porcelain'], { allowFail: true })
  let commitSha: string | null = null
  let filesCommitted = 0
  if (statusBefore.stdout.trim().length > 0) {
    await runGit(localPath, ['commit', '-m', message])
    const sha = await runGit(localPath, ['rev-parse', 'HEAD'])
    commitSha = sha.stdout.trim()
    filesCommitted = writtenFiles.length
  }

  // Empty the queue file as the final step before push so a re-attempt
  // after a failed push doesn't double-publish.
  await writeQueue(localPath, [])
  await runGit(localPath, ['add', QUEUE_FILE], { allowFail: true })
  // Amend the queue-clear into the same commit so history stays tidy.
  if (commitSha) {
    await runGit(localPath, ['commit', '--amend', '--no-edit'], { allowFail: true })
    const newSha = await runGit(localPath, ['rev-parse', 'HEAD'])
    commitSha = newSha.stdout.trim()
  }

  let pushed = false
  let pushError: string | null = null
  if (opts.push !== false) {
    const remote = await remoteUrlOf(localPath)
    if (!remote) {
      pushError = 'no remote configured — set sharedMind.remoteUrl first'
    } else {
      const branch = (await branchOf(localPath)) ?? 'main'
      const r = await runGit(localPath, ['push', '-u', 'origin', branch], { allowFail: true })
      if (r.code === 0) pushed = true
      else pushError = (r.stderr || r.stdout).trim() || `push failed (${r.code})`
    }
  }

  return {
    itemsWritten: items.length,
    filesCommitted,
    pushed,
    pushError,
    commitSha,
  }
}

// ── sync (pull + return memory list) ─────────────────────────────────────────

export interface SyncResult {
  pulled: boolean
  pullError: string | null
  memories: { name: string; body: string; sourcePath: string }[]
  /** Per-artifact comparisons against the local user's `~/.claude/` config. */
  divergences: Divergence[]
}

export interface Divergence {
  /** Stable id used for graph upsert: scope:<name>:divergence/<kind>/<slug>. */
  id: string
  /** Source kind — drives how the comparison was performed. */
  kind: 'skill' | 'agent' | 'command' | 'rule' | 'permission' | 'hook' | 'mcp'
  /** Display title for the divergence memory. */
  title: string
  /** Short description for the memory frontmatter. */
  description: string
  /** Detailed prose body describing what the shared version has that local lacks. */
  body: string
  /** Path inside the shared mind. */
  artifactRel: string
  /** Local path(s) compared against. May be empty when local has no equivalent. */
  localPaths: string[]
}

// ── divergence comparison ────────────────────────────────────────────────────

const HOME = os.homedir()

const safeReadJsonAt = async <T = any>(p: string): Promise<T | null> => {
  try {
    return JSON.parse(await fs.readFile(p, 'utf-8')) as T
  } catch {
    return null
  }
}

const safeReadText = async (p: string): Promise<string | null> => {
  try {
    return await fs.readFile(p, 'utf-8')
  } catch {
    return null
  }
}

const stripFrontmatter = (text: string): string => {
  const m = text.match(/^---\n[\s\S]*?\n---\n?/)
  return m ? text.slice(m[0].length).trim() : text.trim()
}

const arrayDiff = <T>(shared: T[], local: T[], eq?: (a: T, b: T) => boolean): T[] => {
  const isEq = eq ?? ((a: T, b: T) => JSON.stringify(a) === JSON.stringify(b))
  return shared.filter((s) => !local.some((l) => isEq(s, l)))
}

/**
 * Walk the shared mind's artifacts/ tree and compare each artifact against
 * the local user's equivalent in `~/.claude/`. Emits one Divergence per
 * artifact that differs — what the shared version has that the local
 * doesn't. Caller upserts these as graph memories.
 *
 * Comparison is intentionally simple — surface what the shared has that's
 * "extra". The user decides whether to merge. If we can't structurally
 * compare (e.g. markdown bodies that diverge), we still emit a divergence
 * with a coarse "differs" note so awareness still fires.
 */
export const computeDivergences = async (
  localPath: string,
  scopeName: string,
): Promise<Divergence[]> => {
  const out: Divergence[] = []
  const artifactsRoot = path.join(localPath, 'artifacts')
  const exists = await fs.access(artifactsRoot).then(() => true).catch(() => false)
  if (!exists) return out

  // Pre-load the structured local files we'll compare against.
  const localClaudeJson = await safeReadJsonAt<any>(path.join(HOME, '.claude.json'))
  const localSettings = await safeReadJsonAt<any>(path.join(HOME, '.claude', 'settings.json'))

  // Skills: artifacts/skills/<slug>/SKILL.md → ~/.claude/skills/<slug>/SKILL.md
  await scanMdSubdir({
    sharedDir: path.join(artifactsRoot, 'skills'),
    sharedFileName: 'SKILL.md',
    localDir: path.join(HOME, '.claude', 'skills'),
    localFileName: 'SKILL.md',
    kind: 'skill',
    scopeName,
    out,
  })

  // Agents: artifacts/agents/<slug>.md → ~/.claude/agents/<slug>.md
  await scanMdFlat({
    sharedDir: path.join(artifactsRoot, 'agents'),
    localDir: path.join(HOME, '.claude', 'agents'),
    kind: 'agent',
    scopeName,
    out,
  })

  // Commands + rules — same flat shape.
  await scanMdFlat({
    sharedDir: path.join(artifactsRoot, 'commands'),
    localDir: path.join(HOME, '.claude', 'commands'),
    kind: 'command',
    scopeName,
    out,
  })
  await scanMdFlat({
    sharedDir: path.join(artifactsRoot, 'rules'),
    localDir: path.join(HOME, '.claude', 'rules'),
    kind: 'rule',
    scopeName,
    out,
  })

  // MCPs: artifacts/mcp/<slug>.json → mcpServers[slug] in ~/.claude.json
  await scanMcp({
    sharedDir: path.join(artifactsRoot, 'mcp'),
    localServers: localClaudeJson?.mcpServers ?? {},
    scopeName,
    out,
  })

  // Hooks: artifacts/hooks/<slug>.json → settings.json hooks[event] entries
  await scanHooks({
    sharedDir: path.join(artifactsRoot, 'hooks'),
    localHooks: localSettings?.hooks ?? {},
    scopeName,
    out,
  })

  // Permissions: artifacts/permissions/<slug>.json → settings.json permissions[mode]
  await scanPermissions({
    sharedDir: path.join(artifactsRoot, 'permissions'),
    localPermissions: localSettings?.permissions ?? {},
    scopeName,
    out,
  })

  return out
}

interface ScanMdFlatOpts {
  sharedDir: string
  localDir: string
  kind: Divergence['kind']
  scopeName: string
  out: Divergence[]
}

const scanMdFlat = async (o: ScanMdFlatOpts): Promise<void> => {
  let entries: string[] = []
  try {
    entries = await fs.readdir(o.sharedDir)
  } catch {
    return
  }
  for (const f of entries) {
    if (!f.endsWith('.md')) continue
    const slug = f.replace(/\.md$/, '')
    const sharedPath = path.join(o.sharedDir, f)
    const localPath = path.join(o.localDir, f)
    const sharedText = await safeReadText(sharedPath)
    if (!sharedText) continue
    const localText = await safeReadText(localPath)
    const div = compareMd({
      kind: o.kind,
      slug,
      sharedText,
      localText,
      sharedRelPath: path.relative(path.dirname(o.sharedDir), sharedPath).replace(/\\/g, '/'),
      localPath,
      scopeName: o.scopeName,
    })
    if (div) o.out.push(div)
  }
}

interface ScanMdSubdirOpts extends Omit<ScanMdFlatOpts, 'localDir'> {
  sharedFileName: string
  localFileName: string
  localDir: string
}

const scanMdSubdir = async (o: ScanMdSubdirOpts): Promise<void> => {
  let entries: string[] = []
  try {
    entries = await fs.readdir(o.sharedDir)
  } catch {
    return
  }
  for (const slug of entries) {
    const sharedPath = path.join(o.sharedDir, slug, o.sharedFileName)
    const localPath = path.join(o.localDir, slug, o.localFileName)
    const sharedText = await safeReadText(sharedPath)
    if (!sharedText) continue
    const localText = await safeReadText(localPath)
    const div = compareMd({
      kind: o.kind,
      slug,
      sharedText,
      localText,
      sharedRelPath: `artifacts/${o.kind}s/${slug}/${o.sharedFileName}`,
      localPath,
      scopeName: o.scopeName,
    })
    if (div) o.out.push(div)
  }
}

const compareMd = (args: {
  kind: Divergence['kind']
  slug: string
  sharedText: string
  localText: string | null
  sharedRelPath: string
  localPath: string
  scopeName: string
}): Divergence | null => {
  const sharedBody = stripFrontmatter(args.sharedText)
  if (!args.localText) {
    return {
      id: `shared:${args.scopeName}:divergence/${args.kind}/${args.slug}`,
      kind: args.kind,
      title: `Shared ${args.kind} not installed: ${args.slug}`,
      description: `Shared mind contains a ${args.kind} called \`${args.slug}\` that the local user has not installed.`,
      body: divergenceBody({
        kind: args.kind,
        slug: args.slug,
        situation: 'not-installed',
        sharedBody,
        sharedRelPath: args.sharedRelPath,
        localPath: args.localPath,
      }),
      artifactRel: args.sharedRelPath,
      localPaths: [args.localPath],
    }
  }
  const localBody = stripFrontmatter(args.localText)
  if (sharedBody === localBody) return null
  return {
    id: `shared:${args.scopeName}:divergence/${args.kind}/${args.slug}`,
    kind: args.kind,
    title: `Shared ${args.kind} differs from local: ${args.slug}`,
    description: `The shared version of \`${args.slug}\` has content the local copy doesn't.`,
    body: divergenceBody({
      kind: args.kind,
      slug: args.slug,
      situation: 'content-diverged',
      sharedBody,
      localBody,
      sharedRelPath: args.sharedRelPath,
      localPath: args.localPath,
    }),
    artifactRel: args.sharedRelPath,
    localPaths: [args.localPath],
  }
}

const scanMcp = async (o: {
  sharedDir: string
  localServers: Record<string, any>
  scopeName: string
  out: Divergence[]
}): Promise<void> => {
  let entries: string[] = []
  try {
    entries = await fs.readdir(o.sharedDir)
  } catch {
    return
  }
  for (const f of entries) {
    if (!f.endsWith('.json')) continue
    const slug = f.replace(/\.json$/, '')
    const shared = await safeReadJsonAt<any>(path.join(o.sharedDir, f))
    if (!shared) continue
    const local = o.localServers[slug] ?? null
    const sharedRelPath = `artifacts/mcp/${f}`
    if (!local) {
      o.out.push({
        id: `shared:${o.scopeName}:divergence/mcp/${slug}`,
        kind: 'mcp',
        title: `Shared MCP not installed: ${slug}`,
        description: `Shared mind contains an MCP server config (\`${slug}\`) the local user has not installed in their \`~/.claude.json\`.`,
        body: divergenceBody({
          kind: 'mcp',
          slug,
          situation: 'not-installed',
          sharedBody: JSON.stringify(shared, null, 2),
          sharedRelPath,
          localPath: '~/.claude.json',
        }),
        artifactRel: sharedRelPath,
        localPaths: [path.join(HOME, '.claude.json')],
      })
      continue
    }
    // Per-element comparison: command, args, env keys.
    const additions: string[] = []
    if (shared.command && shared.command !== local.command) {
      additions.push(`launch command differs (\`${shared.command}\` vs your \`${local.command ?? 'unset'}\`)`)
    }
    const sharedArgs: string[] = Array.isArray(shared.args) ? shared.args : []
    const localArgs: string[] = Array.isArray(local.args) ? local.args : []
    const argDiff = arrayDiff(sharedArgs, localArgs)
    if (argDiff.length > 0) {
      additions.push(`extra args: ${argDiff.map((a) => `\`${a}\``).join(', ')}`)
    }
    const sharedEnv = (shared.env ?? {}) as Record<string, string>
    const localEnv = (local.env ?? {}) as Record<string, string>
    const envKeyDiff = Object.keys(sharedEnv).filter((k) => !(k in localEnv))
    if (envKeyDiff.length > 0) {
      additions.push(`extra env keys: ${envKeyDiff.map((k) => `\`${k}\``).join(', ')}`)
    }
    if (additions.length === 0) continue
    o.out.push({
      id: `shared:${o.scopeName}:divergence/mcp/${slug}`,
      kind: 'mcp',
      title: `Shared MCP \`${slug}\` has additions you don't have`,
      description: additions.join('; '),
      body: divergenceBody({
        kind: 'mcp',
        slug,
        situation: 'additions',
        additions,
        sharedBody: JSON.stringify(shared, null, 2),
        localBody: JSON.stringify(local, null, 2),
        sharedRelPath,
        localPath: '~/.claude.json',
      }),
      artifactRel: sharedRelPath,
      localPaths: [path.join(HOME, '.claude.json')],
    })
  }
}

const scanHooks = async (o: {
  sharedDir: string
  localHooks: Record<string, any[]>
  scopeName: string
  out: Divergence[]
}): Promise<void> => {
  let entries: string[] = []
  try {
    entries = await fs.readdir(o.sharedDir)
  } catch {
    return
  }
  for (const f of entries) {
    if (!f.endsWith('.json')) continue
    const slug = f.replace(/\.json$/, '')
    const shared = await safeReadJsonAt<any>(path.join(o.sharedDir, f))
    if (!shared || !shared.event) continue
    const localGroups: any[] = Array.isArray(o.localHooks[shared.event]) ? o.localHooks[shared.event]! : []
    const sharedRelPath = `artifacts/hooks/${f}`
    // Match by matcher (or empty matcher) + first-handler-command substring.
    const matcher = String(shared.matcher ?? '')
    const sharedCmd = String(shared.handlers?.[0]?.command ?? '')
    const found = localGroups.some(
      (g: any) =>
        String(g.matcher ?? '') === matcher &&
        Array.isArray(g.hooks) &&
        g.hooks.some((h: any) => String(h.command ?? '').includes(sharedCmd.split(' ')[0] ?? '')),
    )
    if (found) continue
    o.out.push({
      id: `shared:${o.scopeName}:divergence/hook/${slug}`,
      kind: 'hook',
      title: `Shared hook not installed: ${shared.event}${matcher ? ` [${matcher}]` : ''}`,
      description: `Shared mind defines a \`${shared.event}\` hook the local user does not have.`,
      body: divergenceBody({
        kind: 'hook',
        slug,
        situation: 'not-installed',
        sharedBody: JSON.stringify(shared, null, 2),
        sharedRelPath,
        localPath: '~/.claude/settings.json',
      }),
      artifactRel: sharedRelPath,
      localPaths: [path.join(HOME, '.claude', 'settings.json')],
    })
  }
}

const scanPermissions = async (o: {
  sharedDir: string
  localPermissions: any
  scopeName: string
  out: Divergence[]
}): Promise<void> => {
  let entries: string[] = []
  try {
    entries = await fs.readdir(o.sharedDir)
  } catch {
    return
  }
  for (const f of entries) {
    if (!f.endsWith('.json')) continue
    const slug = f.replace(/\.json$/, '')
    const shared = await safeReadJsonAt<any>(path.join(o.sharedDir, f))
    if (!shared || !shared.mode || !shared.pattern) continue
    const localList: string[] = Array.isArray(o.localPermissions?.[shared.mode])
      ? o.localPermissions[shared.mode]
      : []
    if (localList.includes(shared.pattern)) continue
    const sharedRelPath = `artifacts/permissions/${f}`
    o.out.push({
      id: `shared:${o.scopeName}:divergence/permission/${slug}`,
      kind: 'permission',
      title: `Shared permission not installed: ${shared.mode}: ${shared.pattern}`,
      description: `Shared mind grants \`${shared.mode}: ${shared.pattern}\` — the local user does not have this rule.`,
      body: divergenceBody({
        kind: 'permission',
        slug,
        situation: 'not-installed',
        sharedBody: JSON.stringify(shared, null, 2),
        sharedRelPath,
        localPath: '~/.claude/settings.json',
      }),
      artifactRel: sharedRelPath,
      localPaths: [path.join(HOME, '.claude', 'settings.json')],
    })
  }
}

const divergenceBody = (args: {
  kind: Divergence['kind']
  slug: string
  situation: 'not-installed' | 'content-diverged' | 'additions'
  sharedBody?: string
  localBody?: string
  additions?: string[]
  sharedRelPath: string
  localPath: string
}): string => {
  const lines: string[] = []
  lines.push(`# Divergence · ${args.kind} \`${args.slug}\``, '')
  switch (args.situation) {
    case 'not-installed':
      lines.push(
        `Someone in this shared mind has a **${args.kind}** called \`${args.slug}\`. The local user does not have it.`,
        '',
        `**Awareness, not auto-install.** When the user asks about something this ${args.kind} would handle, mention that an external version exists in the shared mind. Don't auto-install it. The user decides.`,
      )
      break
    case 'content-diverged':
      lines.push(
        `Someone in this shared mind has a different version of the **${args.kind}** called \`${args.slug}\`. Theirs and yours have diverged.`,
        '',
        `**Awareness, not auto-merge.** If the user hits friction with their version, mention that the shared mind has a different approach — they might want to compare. Don't auto-merge.`,
      )
      break
    case 'additions':
      lines.push(
        `Someone in this shared mind has a **${args.kind}** called \`${args.slug}\` with elements your local copy doesn't have:`,
        '',
        ...(args.additions ?? []).map((a) => `- ${a}`),
        '',
        `**Awareness, not auto-merge.** If the user uses this ${args.kind} and hits a limit, mention that the shared mind has additions — propose a merge. The user decides per-element.`,
      )
      break
  }
  lines.push('', `**Recipe:** \`${args.sharedRelPath}\` in the shared mind clone.`)
  lines.push(`**Local target:** \`${args.localPath}\``)
  if (args.sharedBody && args.situation !== 'content-diverged') {
    lines.push('', '## Shared content', '', '```', args.sharedBody.slice(0, 2000), '```')
  }
  return lines.join('\n')
}

/**
 * Pull from origin (if configured) and return every memory under
 * `memories/`. Caller is responsible for upserting these into the graph.
 * The graph upsert lives in the route handler so we can reuse the existing
 * graph helpers without coupling sharedMind.ts to the DB layer.
 */
export const sync = async (localPath: string): Promise<SyncResult> => {
  await ensureClone(localPath)
  let pulled = false
  let pullError: string | null = null
  const remote = await remoteUrlOf(localPath)
  if (remote) {
    const branch = (await branchOf(localPath)) ?? 'main'
    // Detect "unborn HEAD" — `git init` has run but no local commit exists
    // yet. `git pull --rebase` against an unborn HEAD emits a noisy
    // `fatal: Updating an unborn branch` warning even when it succeeds.
    // Use `fetch + reset --hard` to land remote content cleanly without
    // the warning. Same end state, quieter logs.
    const headCheck = await runGit(localPath, ['rev-parse', '--verify', 'HEAD'], { allowFail: true })
    const unbornHead = headCheck.code !== 0

    if (unbornHead) {
      const fetched = await runGit(localPath, ['fetch', 'origin', branch], { allowFail: true })
      if (fetched.code === 0) {
        const reset = await runGit(localPath, ['reset', '--hard', `origin/${branch}`], { allowFail: true })
        if (reset.code === 0) {
          pulled = true
          const m = await readManifest(localPath)
          m.lastSyncMs = Date.now()
          await writeManifest(localPath, m)
        } else {
          // Remote has no `<branch>` yet — fine, leave the unborn local repo
          // in place and let the user push first to seed the remote.
          pullError = (reset.stderr || reset.stdout).trim() || null
        }
      } else {
        pullError = (fetched.stderr || fetched.stdout).trim() || `fetch failed (${fetched.code})`
      }
    } else {
      // Normal case — local has commits, regular pull is the right shape.
      const r = await runGit(localPath, ['pull', '--rebase', 'origin', branch], { allowFail: true })
      if (r.code === 0) {
        pulled = true
        const m = await readManifest(localPath)
        m.lastSyncMs = Date.now()
        await writeManifest(localPath, m)
      } else {
        pullError = (r.stderr || r.stdout).trim() || `pull failed (${r.code})`
      }
    }
  } else {
    pullError = 'no remote configured'
  }

  const memoriesDir = path.join(localPath, 'memories')
  const memories: SyncResult['memories'] = []
  try {
    const files = await fs.readdir(memoriesDir)
    for (const f of files) {
      if (!f.endsWith('.md')) continue
      const full = path.join(memoriesDir, f)
      const body = await fs.readFile(full, 'utf-8').catch(() => '')
      memories.push({ name: path.basename(f, '.md'), body, sourcePath: full })
    }
  } catch {
    // memories dir may not exist yet
  }
  const manifest = await readManifest(localPath)
  const divergences = await computeDivergences(localPath, manifest.name)
  return { pulled, pullError, memories, divergences }
}

// ── README + catalog regeneration ────────────────────────────────────────────

const renderReadme = async (localPath: string, manifest: ManifestShape): Promise<string> => {
  const memoryCount = await countFiles(path.join(localPath, 'memories'), '.md')
  const artifactCount = await countFiles(path.join(localPath, 'artifacts'))
  const lines: string[] = [
    `# ${manifest.name} — Cortex shared mind`,
    '',
    manifest.description || '_A shared collection of memories and Claude Code artifacts._',
    '',
    `**Contents:** ${memoryCount} memor${memoryCount === 1 ? 'y' : 'ies'} · ${artifactCount} artifact${artifactCount === 1 ? '' : 's'}`,
    '',
    '---',
    '',
    '## Subscribing — automated (Cortex)',
    '',
    'If you have [Cortex](https://github.com/cz-zwtech/cortex) installed:',
    '',
    '1. Open the **Shared Mind** panel in Cortex',
    '2. Set the remote URL to this repo (`git remote get-url origin` to copy it)',
    '3. Click **Sync** — the memories will land in your local graph under scope `shared:' +
      manifest.name +
      '`',
    '',
    '## Subscribing — manual',
    '',
    '```bash',
    `git clone <this-repo-url> ~/.config/ckn/shared-mind`,
    '# in Cortex Settings, point sharedMind.localPath at the clone',
    '# click Sync in the Shared Mind panel',
    '```',
    '',
    '## Bootstrap a new machine — Claude Code prompt',
    '',
    'Paste this into a fresh Claude Code session and it will set you up:',
    '',
    '```',
    'You\'re bootstrapping a new dev machine. Please:',
    '1. Clone https://github.com/cz-zwtech/cortex (the Cortex app itself)',
    '2. Run `npm install` in the cortex repo',
    '3. Run `npm start` to verify it boots (server on :3001, UI on :1420)',
    '4. In Cortex Settings, set sharedMind.remoteUrl to <THIS REPO URL>',
    '5. Click Sync in the Shared Mind panel',
    '6. Open Knowledge view to verify the memories landed under scope `shared:' +
      manifest.name +
      '`',
    '```',
    '',
    '## Index',
    '',
    '- See `catalog.md` for the human-readable list of memories + artifacts.',
    '- `.cortex/manifest.json` carries machine metadata.',
    '',
    '_This README is regenerated by Cortex on every publish — manual edits will be overwritten._',
  ]
  return lines.join('\n')
}

const renderCatalog = async (localPath: string): Promise<string> => {
  const lines: string[] = [`# ${defaultName(localPath)} — catalog`, '', '_Auto-generated by Cortex on publish._', '']
  const memoriesDir = path.join(localPath, 'memories')
  try {
    const files = (await fs.readdir(memoriesDir)).filter((f) => f.endsWith('.md')).sort()
    if (files.length > 0) {
      lines.push('## Memories', '')
      for (const f of files) {
        const raw = await fs.readFile(path.join(memoriesDir, f), 'utf-8').catch(() => '')
        const m = raw.match(/^---\n([\s\S]*?)\n---/)
        const fm = m ? m[1]! : ''
        const titleMatch = fm.match(/^name:\s*(.+)$/m)
        const descMatch = fm.match(/^description:\s*(.+)$/m)
        const title = (titleMatch?.[1] ?? f.replace(/\.md$/, '')).trim()
        const desc = (descMatch?.[1] ?? '').trim()
        lines.push(`- **${title}** — ${desc || `\`memories/${f}\``}`)
      }
      lines.push('')
    }
  } catch {
    // no memories
  }
  // Artifacts walk — recursive listing under artifacts/
  const artifactsDir = path.join(localPath, 'artifacts')
  const artifacts: string[] = []
  const walk = async (d: string, prefix: string) => {
    try {
      const entries = await fs.readdir(d, { withFileTypes: true })
      for (const e of entries) {
        const next = path.join(d, e.name)
        const rel = prefix ? `${prefix}/${e.name}` : e.name
        if (e.isDirectory()) await walk(next, rel)
        else if (e.isFile()) artifacts.push(rel)
      }
    } catch {
      // none
    }
  }
  await walk(artifactsDir, '')
  if (artifacts.length > 0) {
    lines.push('## Artifacts', '')
    for (const a of artifacts) lines.push(`- \`artifacts/${a}\``)
    lines.push('')
  }
  return lines.join('\n')
}

const regenerateIndex = async (localPath: string): Promise<void> => {
  const manifest = await readManifest(localPath)
  await safeWrite(path.join(localPath, 'README.md'), await renderReadme(localPath, manifest))
  await safeWrite(path.join(localPath, 'catalog.md'), await renderCatalog(localPath))
}

// ── manifest helpers used by the UI ──────────────────────────────────────────

export const updateManifest = async (
  localPath: string,
  patch: Partial<Pick<ManifestShape, 'name' | 'description'>>,
): Promise<ManifestShape> => {
  await ensureClone(localPath)
  const m = await readManifest(localPath)
  const next = { ...m, ...patch }
  await writeManifest(localPath, next)
  return next
}

export const getManifest = async (localPath: string): Promise<ManifestShape> => {
  await ensureClone(localPath)
  return readManifest(localPath)
}
