/**
 * Dialogue feeds (core/dialogue.ts) into blocks. A feed record is one block in
 * a channel session `<source>:<member>`: the member's conversation on that
 * channel, kept beside its transcript sessions and linked to them by member.
 */
import fs from 'node:fs'
import path from 'node:path'

import type { DialogueRecord } from '../../../../core/dialogue.js'
import type { TranscriptFile } from './capture.js'
import type { BlockPart } from './transcript.js'

export type FeedLine = { session: string; source: string; member: string; part: BlockPart }

export const parseFeedLine = (line: string): FeedLine | undefined => {
  let r: DialogueRecord
  try {
    r = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!r || r.v !== 1 || typeof r.id !== 'string' || typeof r.at !== 'number' || typeof r.text !== 'string' || !r.text.trim()) return undefined
  if (typeof r.source !== 'string' || typeof r.member !== 'string' || !r.from?.name) return undefined
  const speaker = r.from.kind === 'operator' ? 'operator' : r.from.name === r.member ? 'member' : 'peer'
  return { session: `${r.source}:${r.member}`, source: r.source, member: r.member, part: { key: r.id, uuid: r.id, speaker, at: r.at, text: r.text, party: r.from.name } }
}

/** Every feed file of every installed module that declares `"dialogue": true`. */
export const feedFiles = (modulesDir: string, dataRoot: string): TranscriptFile[] => {
  const out: TranscriptFile[] = []
  let mods: string[] = []
  try {
    mods = fs.readdirSync(modulesDir)
  } catch {
    return out
  }
  for (const m of mods) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(modulesDir, m, 'module.json'), 'utf-8')) as { name?: string; dialogue?: boolean }
      if (!manifest.dialogue) continue
      const dir = path.join(dataRoot, manifest.name ?? m, 'dialogue')
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.ndjson')) out.push({ path: path.join(dir, f), session: `feed:${manifest.name ?? m}`, kind: 'feed' })
    } catch {
      /* no manifest, or no feed yet */
    }
  }
  return out
}
