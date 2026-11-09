#!/usr/bin/env tsx
/**
 * cortex-rules: standing rules, which are memories of kind `rule`
 * (modules/memory/server/rules.ts).
 *
 *   list                   every rule: scope, when, enforce, and its reason
 *   show <name>            one rule in full
 *   check <file|->         every checkable rule against a draft, quotes and code exempt;
 *                          exit 1 when anything is found (`-` reads stdin)
 *   render                 the rules.md text the user's CLAUDE.md imports
 *   review [--days N]      stale, noisy and violated rules, conditions to re-check,
 *                          and reasons that no longer hold
 *   allow <rule> --once | --for <30m|2h|1d>
 *                          let a deny rule pass: one call, or for a while. Terminal only:
 *                          an agent's tool call has no TTY, so it can never lift a rule itself
 *   overrides              the overrides now in force
 *
 * Rules are edited as memory files, then swept; allow is the one thing written here.
 */
import fs from 'node:fs'
import path from 'node:path'

import { EventBus } from '../core/events.js'
import { Lifecycle } from '../core/lifecycle.js'
import { dataRoot, dbPath, modulesDir } from '../core/paths.js'
import { Storage } from '../core/storage.js'
import { checkText, renderRulesMd, type Rule } from '../modules/memory/server/rules.js'
import { review, type Said } from '../modules/memory/server/ruleReview.js'
import { ContextStore } from '../modules/memory/server/context/store.js'
import { addOverride, parseDuration, readOverrides } from '../modules/memory/server/ruleOverrides.js'

// The whole point of a deny is that the session cannot lift it: only a person at a terminal can.
// Checked before any module loads, so the refusal never depends on what is installed.
if (process.argv[2] === 'allow' && (!process.stdin.isTTY || !process.stdout.isTTY)) {
  console.error('cortex-rules allow runs only in a terminal (no TTY here). A session cannot lift a rule; the person runs this themselves.')
  process.exit(3)
}

const events = new EventBus()
const storage = new Storage(dbPath())
const lifecycle = new Lifecycle({ modulesDir: modulesDir(), dataRoot: dataRoot(), dbPath: storage.path, events, storage, log: () => {} })
await lifecycle.run()
const finish = async (code = 0) => {
  await lifecycle.stopAll()
  storage.close()
  process.exit(code)
}

const rulesCap = lifecycle.capabilities.get<{ list: () => Rule[]; exists: (link: string) => boolean }>('memory.rules')
const memoryGet = lifecycle.capabilities.get<(id: string) => { content: string } | null>('memory.get')
if (!rulesCap) {
  console.error('the memory module is not available (no memory.rules capability). Try /cortex-status.')
  await finish(1)
}
const rules = rulesCap!.list()
const [verb = 'list', ...rest] = process.argv.slice(2)

switch (verb) {
  case 'list': {
    if (!rules.length) console.log('no rules yet: a rule is a memory file with "kind: rule" (see cortex-rules show for the fields)')
    for (const r of rules) {
      console.log(`${r.name}  [${r.scope}; when ${r.when}; ${r.enforce}${r.valid === 'always' ? '' : `; ${r.valid}`}]`)
      console.log(`    ${r.do}${r.why ? ` (${r.why})` : ''}`)
    }
    break
  }
  case 'show': {
    const name = rest[0]
    const r = rules.find((x) => x.name === name || x.id === name)
    if (!r) {
      console.error(`no rule named ${name}`)
      await finish(1)
    }
    for (const [k, v] of Object.entries(r!)) console.log(`${k}: ${Array.isArray(v) ? v.map((s) => `[[${s}]]`).join(', ') : v}`)
    const body = memoryGet?.(r!.id)?.content
    if (body) console.log(`\n${body}`)
    break
  }
  case 'check': {
    const src = rest[0] ?? '-'
    const text = src === '-' ? fs.readFileSync(0, 'utf-8') : fs.readFileSync(path.resolve(src), 'utf-8')
    const found = checkText(text, rules)
    if (!found.length) {
      console.log(`OK: no checkable rule is broken (${rules.filter((r) => r.check.startsWith('regex:')).length} checked; quotes and code exempt)`)
      break
    }
    console.log(`${found.length} finding(s); quotes and code are exempt:`)
    for (const f of found) {
      const r = rules.find((x) => x.name === f.rule)!
      console.log(`  line ${f.line}, col ${f.col}: ${r.do}${r.why ? ` (${r.why})` : ''}`)
      console.log(`      ${f.excerpt}`)
    }
    await finish(1)
    break
  }
  case 'render': {
    process.stdout.write(renderRulesMd(rules))
    break
  }
  case 'review': {
    const di = rest.indexOf('--days')
    const days = di >= 0 ? Number(rest[di + 1]) : 30
    // What the user said in the window, from captured dialogue: the corrections a repeat offence shows in.
    let said: Said[] = []
    const contextFile = path.join(dataRoot(), 'memory', 'context.sqlite')
    if (fs.existsSync(contextFile)) {
      const context = new ContextStore(contextFile)
      try {
        said = context.userSince(Date.now() - days * 86_400_000)
      } finally {
        context.close()
      }
    }
    for (const line of review(rules, path.join(dataRoot(), 'memory', 'rule-fires.jsonl'), { days, sourceExists: rulesCap!.exists, said })) console.log(line)
    break
  }
  case 'allow': {
    const name = rest[0]
    const once = rest.includes('--once')
    const fi = rest.indexOf('--for')
    const span = fi >= 0 ? parseDuration(rest[fi + 1] ?? '') : undefined
    if (!name || once === (span !== undefined)) {
      console.error('usage: cortex-rules allow <rule> --once | --for <30m|2h|1d>')
      await finish(2)
    }
    const rule = rules.find((r) => r.name === name)
    if (!rule) {
      console.error(`no rule named ${name}; cortex-rules list shows them`)
      await finish(1)
    }
    if (rule!.enforce !== 'deny') console.error(`note: ${name} is enforce: ${rule!.enforce}, so it does not deny anything to allow`)
    const now = Date.now()
    addOverride(path.join(dataRoot(), 'memory'), { rule: name!, at: now, ...(once ? { once: true } : { until: now + span! }) }, now)
    console.log(once ? `${name}: allowed for the next call it would deny` : `${name}: allowed until ${new Date(now + span!).toISOString()}`)
    break
  }
  case 'overrides': {
    const live = readOverrides(path.join(dataRoot(), 'memory')).filter((o) => o.once || (o.until ?? 0) > Date.now())
    if (!live.length) console.log('no overrides in force')
    for (const o of live) console.log(`${o.rule}: ${o.once ? 'next call' : `until ${new Date(o.until!).toISOString()}`} (set ${new Date(o.at).toISOString()})`)
    break
  }
  default:
    console.error('usage: cortex-rules list | show <name> | check <file|-> | render | review [--days N] | allow <rule> --once|--for <dur> | overrides')
    await finish(2)
}
await finish(0)
