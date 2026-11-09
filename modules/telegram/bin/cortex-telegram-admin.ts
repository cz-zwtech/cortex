#!/usr/bin/env tsx
/**
 * cortex-telegram-admin: run as the service account, on the service node.
 *
 *   init --bot <id> --username @name --token bao:<path>#<KEY>|env:<NAME>
 *        --operator <name> --chat bao:<path>#<KEY>|env:<NAME> [--publish bao:..|env:..] [--force] [--no-verify]
 *                                          write telegram.json for one bot, explicitly: nothing has a default.
 *                                          Then check every reference resolves, and that Telegram reports
 *                                          the named username for the token (getMe). Refuses to overwrite
 *                                          an existing telegram.json without --force
 *   check                                  validate telegram.json, and say for each secret reference
 *                                          whether it resolves (yes or no, never the value)
 *   migrate --secrets-path P --username <bot>=@name [...] [--apply]
 *                                          rewrite a telegram.json of the old shape (tokenEnv, chatEnv)
 *                                          into the explicit one: each env name becomes an OpenBao reference
 *                                          under P, each bot gets the identity it must report. Prints the
 *                                          result; --apply writes it, keeping the old file beside it
 *   import <legacy.sqlite3> [--bot dev]     copy the earlier gateway's store in as one bot (read-only on the
 *     [--operator name]                    source, idempotent); run while cortex-host is stopped. The operator
 *                                          is the bot's fallbackTo, or --operator when no config names one
 *   unit                                   print cortex-host.service. The module reads its own secrets
 *                                          from OpenBao, so the unit passes none: it only carries the
 *                                          bootstrap file bao-run logs in with
 */
import fs from 'node:fs'
import path from 'node:path'

import { tsxBin } from '../../../core/paths.js'

import { dataRoot } from '../../../core/paths.js'
import { configFile, defaultBot, loadConfig, parseConfig } from '../server/config.js'
import { describeRef, resolver, type SecretRef } from '../server/secrets.js'
import { TelegramChannel } from '../server/channel.js'
import { openDb } from '../server/db.js'
import { importLegacyGateway } from '../server/importer.js'

const dir = path.join(dataRoot(), 'telegram')
const [verb, src] = process.argv.slice(2)
const out = (v: unknown) => console.log(JSON.stringify(v, null, 1))

switch (verb) {
  case 'check': {
    const c = loadConfig(dir)
    if (!c) {
      out({ error: `no ${configFile(dir)}` })
      process.exit(1)
    }
    const resolve = resolver()
    const refs = [
      ...(c.http.publishToken ? [{ what: 'http.publishToken', ref: c.http.publishToken }] : []),
      ...c.bots.flatMap((b) => [{ what: `${b.id}.token`, ref: b.token }, ...b.operators.map((o) => ({ what: `${b.id}.${o.name}.chat`, ref: o.chat }))]),
    ]
    const resolved = refs.map((r) => ({ what: r.what, from: describeRef(r.ref), resolves: !!resolve(r.ref) }))
    out({ ok: resolved.every((r) => r.resolves), bots: c.bots.map((b) => `${b.id} (${b.identity.username})`), secrets: resolved })
    break
  }
  case 'init': {
    const flag = (name: string) => {
      const i = process.argv.indexOf(name)
      return i >= 0 ? process.argv[i + 1] : undefined
    }
    const ref = (v: string | undefined, what: string) => {
      const bao = v?.match(/^bao:([^#]+)#([A-Z][A-Z0-9_]*)$/)
      const env = v?.match(/^env:([A-Z][A-Z0-9_]*)$/)
      if (bao) return { from: 'bao', path: bao[1], key: bao[2] }
      if (env) return { from: 'env', name: env[1] }
      out({ error: `${what}: give bao:<path>#<KEY> or env:<NAME> (there is no default)` })
      process.exit(2)
    }
    const file = configFile(dir)
    if (fs.existsSync(file) && !process.argv.includes('--force')) {
      out({ error: `${file} exists; run check, or pass --force to replace it` })
      process.exit(1)
    }
    const id = flag('--bot')
    const username = flag('--username')
    const operator = flag('--operator')
    if (!id || !username || !operator) {
      out({ error: 'init needs --bot <id>, --username @its_bot_name and --operator <name>' })
      process.exit(2)
    }
    const publish = flag('--publish')
    const next = {
      http: publish ? { publishToken: ref(publish, '--publish') } : { listen: [] },
      bots: [{ id, default: true, poll: true, identity: { username }, token: ref(flag('--token'), '--token'), operators: [{ name: operator, chat: ref(flag('--chat'), '--chat') }], fallbackTo: operator }],
    }
    const c = parseConfig(next)
    const resolve = resolver()
    const b = c.bots[0]!
    const token = resolve(b.token)
    const report: Record<string, unknown> = { token: { from: describeRef(b.token), resolves: !!token }, chat: { from: describeRef(b.operators[0]!.chat), resolves: !!resolve(b.operators[0]!.chat) } }
    if (token && !process.argv.includes('--no-verify')) {
      try {
        const got = await new TelegramChannel(token).me()
        report.identity = { telegram: `@${got}`, config: b.identity.username, match: got.toLowerCase() === b.identity.username.replace(/^@/, '').toLowerCase() }
      } catch (err) {
        report.identity = { error: err instanceof Error ? err.message : String(err) }
      }
    }
    const ok = !!token && (process.argv.includes('--no-verify') || (report.identity as { match?: boolean } | undefined)?.match === true)
    if (!ok) {
      out({ written: false, ...report, why: 'a reference does not resolve, or Telegram reports another bot: nothing written' })
      process.exit(1)
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    out({ written: file, ...report, next: 'restart cortex-host' })
    break
  }
  case 'migrate': {
    const file = configFile(dir)
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>
    const pi = process.argv.indexOf('--secrets-path')
    const secretsPath = pi >= 0 ? process.argv[pi + 1] : undefined
    const names = Object.fromEntries(
      process.argv.flatMap((a, i) => (process.argv[i - 1] === '--username' ? [a.split('=') as [string, string]] : [])),
    )
    if (!secretsPath) {
      out({ error: 'migrate needs --secrets-path <OpenBao path>: there is no default' })
      process.exit(2)
    }
    const bao = (key: string) => ({ from: 'bao', path: secretsPath, key })
    const bots = ((raw.bots as Record<string, unknown>[]) ?? []).map((b) => {
      const { tokenEnv, operators, ...rest } = b as { id?: string; tokenEnv?: string; operators?: { name: string; chatEnv?: string }[] }
      const username = names[String(rest.id)]
      if (!username) {
        out({ error: `bot ${String(rest.id)}: give its identity with --username ${String(rest.id)}=@its_bot_name` })
        process.exit(2)
      }
      return {
        ...rest,
        identity: { username },
        token: tokenEnv ? bao(tokenEnv) : (b as { token?: unknown }).token,
        operators: (operators ?? []).map((o) => ({ name: o.name, chat: o.chatEnv ? bao(o.chatEnv) : (o as { chat?: unknown }).chat })),
      }
    })
    const http = { ...((raw.http as Record<string, unknown>) ?? {}) }
    const publish = http.publishTokenEnv as string | undefined
    delete http.publishTokenEnv
    const next = { ...raw, http: { ...http, ...(publish ? { publishToken: bao(publish) } : {}) }, bots }
    parseConfig(next)
    if (!process.argv.includes('--apply')) {
      out({ dryRun: true, file, next })
      break
    }
    const kept = `${file}.before-explicit-${new Date().toISOString().replace(/[:.]/g, '-')}`
    fs.copyFileSync(file, kept)
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    out({ applied: true, file, kept })
    break
  }
  case 'import': {
    if (!src) {
      out({ error: 'usage: import <legacy.sqlite3> [--bot id] [--operator name]' })
      process.exit(2)
    }
    const c = loadConfig(dir)
    const i = process.argv.indexOf('--bot')
    const bot = i >= 0 ? process.argv[i + 1]! : c ? defaultBot(c).id : 'dev'
    const oi = process.argv.indexOf('--operator')
    const operator = (oi >= 0 ? process.argv[oi + 1] : undefined) ?? c?.bots.find((b) => b.id === bot)?.fallbackTo
    if (!operator) {
      out({ error: 'import needs --operator <name>: no telegram.json names a fallbackTo operator for this bot' })
      process.exit(2)
    }
    const db = openDb(path.join(dir, 'telegram.sqlite'))
    out({ bot, operator, ...importLegacyGateway(db, path.resolve(src), bot, operator) })
    db.close()
    break
  }
  case 'unit': {
    const c = loadConfig(dir)
    if (!c) {
      out({ error: `no ${configFile(dir)}` })
      process.exit(1)
    }
    const repo = path.resolve(import.meta.dirname, '..', '..', '..')
    // Every secret reference in the config, to say what the unit must provide: OpenBao is optional.
    const refs: SecretRef[] = []
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>
        if (o.from === 'bao' || o.from === 'env') refs.push(o as SecretRef)
        else Object.values(o).forEach(walk)
      }
    }
    walk(c)
    const envNames = [...new Set(refs.flatMap((r) => (r.from === 'env' ? [r.name] : [])))]
    process.stdout.write(
      [
        '[Unit]',
        'Description=Cortex host (host-only modules: telegram)',
        'After=cortex-mesh.service',
        '',
        '[Service]',
        // The module reads OpenBao references itself (secrets.ts); bao-run logs in with the bootstrap
        // creds in this file. Only when a reference uses OpenBao. No secret is passed here.
        ...(refs.some((r) => r.from === 'bao') ? ['EnvironmentFile=%h/.claude/.env'] : []),
        // env references: a file you create (chmod 600) holding these names, never written by Cortex.
        ...(envNames.length ? [`# provides ${envNames.join(', ')}`, 'EnvironmentFile=%h/.config/ckn/telegram.env'] : []),
        // Core's status port, off the default 3011, which other services may hold.
        'Environment=CKN_PORT=3023',
        `ExecStart=/bin/bash -lc 'exec ${tsxBin(repo)} ${path.join(repo, 'core', 'index.ts')}'`,
        'Restart=always',
        'RestartSec=10',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
      ].join('\n'),
    )
    break
  }
  default:
    out({ error: 'usage: cortex-telegram-admin check | import <legacy.sqlite3> [--bot id] | unit [--secrets-path P]' })
    process.exit(2)
}
