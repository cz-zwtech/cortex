#!/usr/bin/env tsx
/**
 * cortex-uat: the baseline acceptance run for a V2 install, on any machine.
 *
 * Runs the cases asked for before V2 goes on home and hub:
 *
 *   1. comms between two sessions in one role (direct message and reply)
 *   2. a role message, and a claim on it
 *   3. a message queued while the only member is offline, waiting when it returns
 *   4. role create and end (delete), with unhandled work returned to its sender
 *   5. memory write and recall
 *
 * Every simulated session gets its own throwaway state dir, and roles are named
 * `uat-<random>`, so the run never touches a real member, role or memory. It
 * talks to the bus at CKN_SERVER_URL (default the local V1 server) through the
 * real CLIs, not library calls, because the CLI is what a session uses.
 *
 * Nothing it writes is secret. On a live bus the uat roles stay in the log as
 * deleted roles; that is the cost of testing the real transport.
 *
 *   npx tsx bin/cortex-uat.ts            run everything
 *   npx tsx bin/cortex-uat.ts --keep     keep the temp dirs for inspection
 */

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exitOnHelp } from '../core/help.js'

exitOnHelp(`usage: cortex-uat [--keep]
  the baseline acceptance run: comms between sessions, role messages and claims, queued delivery,
  role create and delete, memory write and recall, each in throwaway state dirs.
  --keep keeps the temp dirs. CKN_SERVER_URL names the bus; CKN_COMMS_TRANSPORT=mesh uses the mesh`)

const repo = path.resolve(import.meta.dirname, '..')
const tsx = path.join(repo, 'node_modules', '.bin', 'tsx')
const keep = process.argv.includes('--keep')
const tag = crypto.randomBytes(3).toString('hex')
const root = fs.mkdtempSync(path.join(os.tmpdir(), `cortex-uat-${tag}-`))

// CKN_COMMS_TRANSPORT=mesh runs the comms cases on the mesh message bus with no
// V1 server: every simulated session on this "machine" shares one mesh log.
const meshShared = process.env.CKN_COMMS_TRANSPORT === 'mesh' ? fs.mkdtempSync(path.join(os.tmpdir(), `cortex-uat-mesh-${tag}-`)) : undefined
const SETTLE_MS = 1_000
const LIVE_MS = 3_000

type Run = { code: number; out: string }

/** One simulated session = one state dir. */
const session = (name: string) => {
  const state = path.join(root, name)
  fs.mkdirSync(state, { recursive: true })
  const env = {
    ...process.env,
    CKN_STATE_DIR: state,
    // Fail closed: under this flag no Cortex root may resolve outside the temp dir.
    CORTEX_UNDER_TEST: '1',
    CLAUDE_CONFIG_DIR: path.join(state, 'claude'),
    ...(meshShared ? { CKN_MESH_DIR: meshShared } : {}),
    CKN_COMMS_SETTLE_MS: String(SETTLE_MS),
    CKN_COMMS_LIVE_MS: String(LIVE_MS),
    CLAUDE_CODE_SESSION_ID: `uat-${tag}-${name}`,
  }
  const run = (bin: string, ...args: string[]): Run => {
    const r = spawnSync(tsx, [path.join(repo, 'bin', bin), ...args], { env, encoding: 'utf-8' })
    return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}`.trim() }
  }
  return {
    state,
    role: (...a: string[]) => run('cortex-role.ts', ...a),
    memory: (...a: string[]) => run('cortex-memory.ts', ...a),
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const results: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${detail.replace(/\n/g, '\n      ')}`}`)
}
const idOf = (out: string) => out.match(/sent ([^\s:]+)/)?.[1] ?? ''

console.log(`cortex uat  run ${tag}  bus ${meshShared ? `mesh (${meshShared})` : process.env.CKN_SERVER_URL ?? 'http://127.0.0.1:3001'}\n`)

const roleA = `uat-${tag}`
const roleOff = `uat-off-${tag}`
const a = session('a')
const b = session('b')
const c = session('c')

// ── 0. bus reachable ────────────────────────────────────────────────────────
const probe = a.role('list')
check('bus reachable', probe.code === 0, probe.out)
if (probe.code !== 0) {
  console.log('\nThe bus is not reachable; nothing else can run. Start the Cortex server first.')
  process.exit(1)
}

// ── 1. two sessions in one role ─────────────────────────────────────────────
const ja = a.role('join', roleA, '--create', '--as', `${roleA}-a`)
const jb = b.role('join', roleA, '--as', `${roleA}-b`)
check('two sessions join one role', ja.code === 0 && jb.code === 0, `${ja.out}\n${jb.out}`)

const show = a.role('show', roleA)
check('manifest lists both members', show.out.includes(`${roleA}-a`) && show.out.includes(`${roleA}-b`), show.out)

const direct = a.role('send', `${roleA}/${roleA}-b`, `hello from a ${tag}`)
const bInbox = b.role('inbox')
check('direct message arrives with sender as role/member, and no delivery narration', direct.code === 0 && !direct.out.includes('delivered') && bInbox.out.includes(`${roleA}/${roleA}-a`) && bInbox.out.includes(`hello from a ${tag}`), `${direct.out}\n${bInbox.out}`)

const reply = b.role('reply', idOf(direct.out), `ack from b ${tag}`)
const aInbox = a.role('inbox')
check('reply reaches the sender', reply.code === 0 && aInbox.out.includes(`ack from b ${tag}`), `${reply.out}\n${aInbox.out}`)

// Text a shell would mangle, sent through --body-file: the V1 BUS-11 case.
const tricky = path.join(root, 'tricky.txt')
fs.writeFileSync(tricky, 'cost is $(echo 5) dollars, run `id`, path ${HOME}\n')
const t1 = a.role('send', `${roleA}/${roleA}-b`, '--body-file', tricky)
const t2 = b.role('inbox')
check('a body with $(), backticks and ${} arrives intact', t1.code === 0 && t2.out.includes('$(echo 5)') && t2.out.includes('`id`') && t2.out.includes('${HOME}'), t2.out)

// ── 2. role message and a claim ─────────────────────────────────────────────
const work = a.role('send', roleA, `work item ${tag}`)
const seen = b.role('inbox')
check('role message reaches the other member as unclaimed work', seen.out.includes(`work item ${tag}`) && seen.out.includes('[work: claim before acting]'), seen.out)

const claim = b.role('claim', idOf(work.out))
check('claim wins and is announced', claim.code === 0 && claim.out.startsWith('WON'), claim.out)
const fence = b.role('check', idOf(work.out))
check('fencing check confirms ownership', fence.code === 0, fence.out)
const late = a.role('claim', idOf(work.out))
check('a later claim on started work loses', late.code !== 0 && late.out.includes(`${roleA}-b owns it`), late.out)

// ── 3. queued while offline ─────────────────────────────────────────────────
const jc = c.role('join', roleOff, '--create', '--as', `${roleOff}-c`)
a.role('join', roleOff, '--as', `${roleA}-a`)
await sleep(LIVE_MS + 1_000) // c goes quiet: no beats past the live window
a.role('leave', roleOff) // a only needed membership to address the role
const queued = a.role('send', roleOff, `waiting for you ${tag}`)
check('message to a role with no live member is queued, and says so', jc.code === 0 && queued.out.includes('queued for role'), `${jc.out}\n${queued.out}`)
const back = c.role('inbox')
check('the returning member finds it waiting', back.out.includes(`waiting for you ${tag}`), back.out)

// ── 4. role end ─────────────────────────────────────────────────────────────
const pending = a.role('send', roleA, `never handled ${tag}`)
const del = a.role('delete', roleA)
check('delete returns unhandled work to its sender', pending.code === 0 && del.out.includes('1 unhandled message(s) returned'), `${pending.out}\n${del.out}`)
const after = a.role('send', roleA, 'too late')
check('a send to a deleted role is refused', after.code !== 0 && after.out.includes(`no such role: ${roleA}`), after.out)
c.role('delete', roleOff)

// ── 5. memory write and recall ──────────────────────────────────────────────
const mem = session('mem')
const memDir = path.join(root, 'memory-src', 'memory')
fs.mkdirSync(memDir, { recursive: true })
fs.writeFileSync(
  path.join(memDir, `uat-${tag}.md`),
  `---\nname: uat-${tag}\ndescription: uat marker ${tag} for the baseline run\n---\n\nThe uat marker ${tag} proves memory write and recall work end to end on this machine.\n`,
)
const memEnv = (bin: 'sweep' | 'recall', ...rest: string[]) => {
  const r = spawnSync(tsx, [path.join(repo, 'bin', 'cortex-memory.ts'), bin, ...rest], {
    env: { ...process.env, CORTEX_UNDER_TEST: '1', CLAUDE_CONFIG_DIR: path.join(mem.state, 'claude'), CKN_STATE_DIR: mem.state, CKN_MEMORY_DIRS: memDir, CKN_MODULES_DIR: path.join(repo, 'modules') },
    encoding: 'utf-8',
  })
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}`.trim() }
}
const sw = memEnv('sweep')
const rc = memEnv('recall', 'uat', 'marker', tag, 'memory', 'recall')
check('memory sweep ingests a written memory', sw.code === 0, sw.out)
check('memory recall finds it', rc.code === 0 && rc.out.includes(`uat-${tag}`), rc.out)

// ── summary ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length ? 'FAILED' : 'ALL PASS'}: ${results.length - failed.length}/${results.length}`)
if (!keep) {
  fs.rmSync(root, { recursive: true, force: true })
  if (meshShared) fs.rmSync(meshShared, { recursive: true, force: true })
}
else console.log(`kept: ${root}`)
process.exit(failed.length ? 1 : 0)
