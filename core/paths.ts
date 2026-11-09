import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Dynamic `import()` of an absolute path needs a file:// URL, not a bare path —
 * on POSIX a bare path happens to work, which is exactly why it is worth
 * centralising: the version that "works" silently is the one that breaks later.
 */
export const pathToFile = (absPath: string): string => pathToFileURL(absPath).href

/**
 * INSTALL HOME vs STATE DIR — two different things that were one variable.
 *
 * `CKN_HOME` is the INSTALL directory: the checkout, the code, `bin/` and
 * `package.json`. V1 resolves it through a pointer file and it is legitimately
 * wherever the user cloned the repo: on a Linux machine that may be `/home/svc/cortex`, and
 * on a WSL machine `/mnt/d/projects/cortex`.
 *
 * An earlier revision derived the database, the data root and the modules
 * directory from it. That is wrong on EVERY machine, not just a WSL one: it
 * writes runtime state into a git checkout. The WSL case merely makes it
 * *visibly* wrong, because there the install lives on drvfs, which does not
 * provide the fsync and rename semantics the journal's durability rests on — so
 * the journal would sit on a filesystem that cannot keep the promise it makes,
 * and (since it now refuses such a path) would refuse to open at all on a real
 * primary node.
 *
 * On a typical WSL machine: an install under `/mnt/d/...` is drvfs; state
 * `~/.config/ckn` is ext4. They are already different filesystems, and V1
 * already stores its state — embeddings, the home pointer itself — under the
 * ext4 one. The separation exists; only V2's resolver had lost it.
 *
 * So: code comes from the install home, everything WRITTEN comes from here.
 */
/**
 * FAIL CLOSED UNDER TEST (a standing rule after the 2026-10-13 incident).
 *
 * Node's test runner sets NODE_TEST_CONTEXT in every test process, and every
 * process a test spawns inherits it. Under it, no root Cortex resolves may lie
 * outside the temp dir: the call throws instead of returning the developer's
 * real ~/.claude or ~/.config/ckn. This holds however the tests were started
 * (cortex-test, npx tsx --test, a mutation loop) and whether or not the test
 * remembered to isolate itself. CORTEX_UNDER_TEST=1 opts other harnesses in.
 */
export const underTest = (env: NodeJS.ProcessEnv = process.env): boolean =>
  Boolean(env.NODE_TEST_CONTEXT) || env.CORTEX_UNDER_TEST === '1'

export const guardRoot = (p: string, what: string, env: NodeJS.ProcessEnv = process.env): string => {
  if (!underTest(env)) return p
  const tmp = fs.realpathSync(os.tmpdir())
  const abs = path.resolve(p)
  const real = fs.existsSync(abs) ? fs.realpathSync(abs) : abs
  if (real !== tmp && !real.startsWith(tmp + path.sep) && !abs.startsWith(os.tmpdir() + path.sep)) {
    throw new Error(
      `refusing ${what} outside the temp dir under test: ${abs}. ` +
        'Isolate the test (test/isolatedEnv.ts) or run it through cortex-test, which sandboxes every suite.',
    )
  }
  return p
}

/** The harness config dir, ~/.claude unless CLAUDE_CONFIG_DIR says otherwise. Guarded under test. */
export const claudeConfigDir = (env: NodeJS.ProcessEnv = process.env): string =>
  guardRoot(env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'the harness config dir', env)

export const stateDir = (): string =>
  guardRoot(process.env.CKN_STATE_DIR ?? path.join(os.homedir(), '.config', 'ckn'), 'the Cortex state dir')

/**
 * Where modules are discovered.
 *
 * Under the state dir rather than the install: "drop it in the folder and
 * restart" must not mean "edit your git checkout", or every user with a module
 * has a dirty working tree and an upgrade conflict.
 */
export const modulesDir = (): string =>
  process.env.CKN_MODULES_DIR ?? path.join(stateDir(), 'modules')

export const dbPath = (): string => process.env.CKN_DB_PATH ?? path.join(stateDir(), 'cortex.sqlite')

/** Per-module private data, including memory's journal. */
export const dataRoot = (): string => path.join(stateDir(), 'data')

/** The mesh log dir. CKN_MESH_DIR lets separate state dirs share one machine's bus (UAT). */
export const meshDir = (): string => guardRoot(process.env.CKN_MESH_DIR ?? path.join(dataRoot(), 'mesh'), 'the mesh dir')

/**
 * Where the human writes memories — the scratchpad surface, NOT state.
 *
 * Deliberately a LIST rather than a single directory, because there are already
 * two shapes in the fleet and a single-root resolver would silently cover only
 * one of them: user-wide memories live in `~/.claude/memory`, and project-scoped
 * memories live in `~/.claude/projects/<encoded-cwd>/memory`. A write-time
 * reflex that only knew the first would be inert for exactly the project-scoped
 * writes, and inert-but-installed is the state this project keeps paying for.
 *
 * These are ROOTS to search under, not exact directories; see `underMemoryRoot`.
 */
export const memoryRoots = (): string[] => {
  const declared = process.env.CKN_MEMORY_DIRS
  const roots = declared
    ? declared.split(path.delimiter).filter(Boolean).map((p) => path.resolve(p))
    : [path.join(claudeConfigDir(), 'memory'), path.join(claudeConfigDir(), 'projects')]
  return roots.map((r) => guardRoot(r, 'a memory root'))
}

/**
 * Were the roots DECLARED, or defaulted?
 *
 * A declared root is one the user named in `CKN_MEMORY_DIRS`, and it must be
 * trusted as a memory directory on its own terms. The default roots are search
 * roots — `~/.claude/projects` holds one directory per encoded cwd — and there
 * the `memory` segment is what distinguishes a memory directory from every other
 * directory in a project tree.
 *
 * Applying the segment rule to a DECLARED root is a silent trap: the variable is
 * called CKN_MEMORY_DIRS, the user points it at a directory of memories, and the
 * sweep reports "no memory directories found".
 */
export const memoryRootsAreDeclared = (): boolean => Boolean(process.env.CKN_MEMORY_DIRS)

/**
 * Is this path a memory file?
 *
 * It must sit under a root. Beyond that the rule depends on how the roots were
 * obtained, and conflating the two cases is a trap that appeared TWICE:
 *
 *   DEFAULTED roots are SEARCH roots — `~/.claude/projects` holds one directory
 *     per encoded cwd — so a `memory` segment is required, or the reflex would
 *     sit in front of every source edit in every project.
 *   DECLARED roots (`CKN_MEMORY_DIRS`) already say what they are. Requiring them
 *     to ALSO be named `memory` makes the reflex silently inert for a directory
 *     the user explicitly nominated, and nothing reports it.
 *
 * The same mistake in `memoryDirs` made the sweep answer "no memory directories
 * found" for a declared root. One rule, two call sites, one fix.
 */
export const underMemoryRoot = (
  file: string,
  roots = memoryRoots(),
  declared = memoryRootsAreDeclared(),
): boolean => {
  const abs = path.resolve(file)
  if (!abs.endsWith('.md')) return false
  const inRoot = roots.some((r) => abs === r || abs.startsWith(r + path.sep))
  if (!inRoot) return false
  return declared || abs.split(path.sep).includes('memory')
}

/**
 * May the memory sweep rewrite memory files (replace consumed memories with the stub)?
 *
 * Not when the store is somewhere else (CKN_STATE_DIR set) while the memory
 * roots are the defaults, i.e. the user's real ~/.claude. That pairing moves
 * real memories into a store nobody uses. On 2026-10-13 a test that ran the
 * hook dispatcher with a temporary state dir and no CKN_MEMORY_DIRS did exactly
 * that: 269 of the owner's memory files on the home machine were consumed into a temp dir the
 * test then deleted. Ingest still runs in that pairing; only the files stay.
 */
export const consumeAllowed = (env: NodeJS.ProcessEnv = process.env): boolean =>
  Boolean(env.CKN_MEMORY_DIRS) || !env.CKN_STATE_DIR

/**
 * How every command Cortex writes runs a script: the checkout's own tsx, by
 * absolute path, shell-quoted. Never `npx tsx`: npx resolves tsx from the
 * session's working directory, then its download cache, then the network, so
 * a hook in a session started outside the repo depended on a warm cache and
 * died at the 10s hook timeout without one (laptop canary, 14 Oct).
 */
export const shellQuote = (s: string): string => (/^[A-Za-z0-9_./:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)
export const tsxBin = (repoRoot: string): string => path.join(repoRoot, 'node_modules', '.bin', 'tsx')
export const runScript = (repoRoot: string, script: string): string =>
  `${shellQuote(tsxBin(repoRoot))} ${shellQuote(path.join(repoRoot, 'bin', script))}`

/**
 * The stores the Cortex host runs on. The same functions every CLI and the mesh
 * daemon use, so a host can never run on different stores from its own tools
 * (it once read CKN_HOME, which in places is the checkout, where they read CKN_STATE_DIR).
 */
export const hostPaths = (): { modulesDir: string; dataRoot: string; dbPath: string } => ({ modulesDir: modulesDir(), dataRoot: dataRoot(), dbPath: dbPath() })
