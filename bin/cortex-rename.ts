#!/usr/bin/env tsx
/**
 * cortex-rename <name> [extension args...] [--force]
 *
 * Core's session naming (19 Oct 2026). Works with no module installed: the
 * name is recorded as pending, and the next prompt's hook hands it to the
 * harness as the session title. Installed modules follow through the
 * `session.renamed` event, and may take extra arguments they declared in their
 * manifest (`extends`), such as comms' `[role]`.
 *
 * Run from inside Claude Code: the session is CLAUDE_CODE_SESSION_ID.
 */
import { EventBus } from '../core/events.js'
import { Lifecycle } from '../core/lifecycle.js'
import { dataRoot, dbPath, modulesDir, stateDir } from '../core/paths.js'
import { RENAMED, SessionNames, TITLE_RE, type Renamed, type RenamedResult } from '../core/sessionNames.js'
import { Storage } from '../core/storage.js'
import { exitOnHelp } from '../core/help.js'

exitOnHelp(`usage: cortex-rename <name> [extension args...] [--force]
  names this session (run from inside Claude Code); modules may add arguments, such as comms' [role]`)

const die = (msg: string, code = 1): never => {
  console.error(msg)
  process.exit(code)
}

const argv = process.argv.slice(2)
const force = argv.includes('--force')
const [name, ...extra] = argv.filter((a) => a !== '--force')
if (!name) die('usage: cortex-rename <name> [--force]', 2)
if (!TITLE_RE.test(name!)) die(`"${name}" is not a usable session name: letters, digits, spaces, dots, dashes; at most 64`, 2)
const sessionId = process.env.CLAUDE_CODE_SESSION_ID
if (!sessionId) die('cortex-rename needs a session: run it from inside Claude Code')

const events = new EventBus()
const storage = new Storage(dbPath())
const lifecycle = new Lifecycle({ modulesDir: modulesDir(), dataRoot: dataRoot(), dbPath: storage.path, events, storage, log: () => {} })
await lifecycle.run()

// Extra arguments are only those a running module declared; anything more is refused before anything changes.
const extensions = lifecycle.started.flatMap((m) => m.manifest.extends.filter((e) => e.command === 'rename').map((e) => ({ ...e, module: m.manifest.name })))
if (extra.length > extensions.length) {
  await lifecycle.stopAll()
  storage.close()
  die(
    extensions.length
      ? `cortex-rename takes <name> ${extensions.map((e) => e.args).join(' ')}; got ${extra.length} extra argument(s)`
      : `cortex-rename takes one name; "${extra.join(' ')}" would need a module that extends it (comms adds [role])`,
    2,
  )
}

const names = SessionNames.at(stateDir())
const payload: Renamed = { sessionId: sessionId!, from: names.get(sessionId!).title, to: name!, args: extra, force, source: 'cli' }
const result = await events.publish(RENAMED, payload)
await lifecycle.stopAll()
storage.close()

names.setPending(sessionId!, name!)
for (const r of result.results) for (const line of (r.value as RenamedResult)?.lines ?? []) console.log(line)
for (const f of result.failures) console.error(`${f.module} could not follow the rename: ${f.error.message}`)
console.log(`the session title becomes ${name} at your next prompt`)
