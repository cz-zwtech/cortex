/**
 * Runtime, reachability-aware acquisition of the fleet mesh token (FR-7 D2).
 *
 * Normally CKN_MESH_TOKEN is injected at launch (the `bao-run` wrap). But a node
 * that booted with NO reachable OpenBao (laptop off-VPN, NAT box) has no token, so
 * the mesh stays off until a restart. To make membership a continuous reachability
 * test (D1), the membership controller fetches the token at RUNTIME when one isn't
 * in the env: it runs `CKN_MESH_TOKEN_CMD` — a command that PRINTS the token to
 * stdout (CKN_API_KEY_CMD-style; e.g. `bao-run CKN_MESH_TOKEN -- printenv CKN_MESH_TOKEN`)
 * — and caches the result via setRuntimeMeshToken so the whole tier (all of which
 * routes through meshToken()) activates without a restart. Retried by the controller
 * when it fails (OpenBao unreachable). The token is NEVER logged or written to disk;
 * only the (non-secret) command string is.
 */
import { execFile } from 'node:child_process'
import { meshToken, setRuntimeMeshToken } from './meshAuth.js'

/** Token-fetch timeout — a full bao-run AppRole login round-trip, bounded so an
 *  unreachable OpenBao fails fast (the controller retries) instead of hanging. */
const FETCH_TIMEOUT_MS = 10_000

/** The runtime token-fetch command, or '' when not configured. */
export function tokenCmd(): string {
  return process.env.CKN_MESH_TOKEN_CMD ?? ''
}

// Injection seam: tests stub the exec so acquisition is deterministic + offline.
type RunFn = (cmd: string, timeoutMs: number) => Promise<string>
const defaultRun: RunFn = (cmd, timeoutMs) =>
  new Promise<string>((resolve) => {
    const child = execFile('sh', ['-c', cmd], { timeout: timeoutMs }, (err, stdout) => {
      resolve(err ? '' : String(stdout).trim())
    })
    child.on('error', () => resolve(''))
  })
let runImpl: RunFn = defaultRun
/** Test seam: inject the command runner (null restores the real exec). */
export function _setRunner(fn: RunFn | null): void {
  runImpl = fn ?? defaultRun
}

/**
 * Ensure a mesh token is available. Returns true if one is already present (env or
 * previously cached), OR if a fresh fetch via CKN_MESH_TOKEN_CMD succeeds. Returns
 * false when there's no env token, no command, or the fetch fails/empties — the
 * caller retries on its next reachability tick. Never throws; never logs the token.
 */
export async function acquireMeshToken(): Promise<boolean> {
  if (meshToken()) return true // env or already-cached — nothing to fetch
  const cmd = tokenCmd()
  if (!cmd) return false // no runtime source configured → stay fail-closed
  const token = await runImpl(cmd, FETCH_TIMEOUT_MS)
  if (!token) return false // unreachable / empty → caller retries
  setRuntimeMeshToken(token)
  return true
}
