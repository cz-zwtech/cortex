/**
 * The consume protocol — emptying the scratchpad, safely.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONSUME DROPS BY PROOF, NOT BY FILE
 *
 * The earlier shape was `consume(source)` — "this file was ingested, empty it" —
 * and it was safe only because it was called from one place. That is correctness
 * BY POSITION: nothing in the type or the contract stopped a second caller from
 * emptying a scratchpad whose content had been DECLINED, and since quarantine
 * deliberately keeps no copy, the scratchpad is the only copy.
 *
 * So the contract changed instead of being guarded. **Consume requires a TICKET,
 * and a ticket is minted only by a durable ingest.** It names the content HASHES
 * that reached the journal and the graph, and consume may drop nothing else. A
 * declined memory has no ticket entry, so no consume call — however wrongly
 * placed — can remove it. The invariant lives in the signature and the drop
 * criterion rather than in call-site discipline.
 *
 * Three things fall out for free:
 *
 *   PARTIAL CONSUME IS AUTOMATIC. A file holding two clean memories and one
 *   declined: the ticket carries two hashes, the rewrite retains the third. No
 *   special case.
 *
 *   THE CONCURRENCY ANSWER SIMPLIFIES. A memory appended while ingest was
 *   running has a hash that is not in the ticket, so it survives BY IDENTITY
 *   rather than by timing. The copy-diff-drop is still the file-level
 *   MECHANICS — portable, no locks, no rename atomicity — while the ticket
 *   defines WHAT to drop. They compose; nothing already ruled is overturned.
 *
 *   THE TICKET IS THE RECEIPT'S TWIN. One emission, two artifacts: the receipt
 *   feeds the rung-0 corroboration pipeline, the ticket authorises the drop.
 */

import fs from 'node:fs'
import path from 'node:path'

import { runScript } from '../../../core/paths.js'
import { hashContent } from './journal.js'

/**
 * Proof that specific content is durably ingested.
 *
 * Mintable only by the ingest path. Consume's authority comes entirely from it,
 * which is why it carries hashes rather than a file path: a path says "something
 * here was ingested", a hash says exactly what.
 */
export type ConsumeTicket = {
  source: string
  /** Body hashes that reached BOTH the journal and the graph. */
  hashes: string[]
  mintedAt: number
}

/** One memory as it sits in a scratchpad. */
export type Block = { raw: string; body: string; hash: string }

const FRONTMATTER_START = /^---\s*$/

/**
 * The decline receipt, written INTO the scratchpad.
 *
 * The quarantine table and `status` tell the SYSTEM that a memory was held. The
 * party who can actually fix it — rephrase without the value, or call it a false
 * positive — is the writer, and the writer looks at the FILE. Without this, the
 * queue depends on someone thinking to check status, and a queue nobody reads
 * turns false positives into a silent recall gap.
 *
 * It is the same receipt mechanism ingest already emits, with the opposite
 * verdict.
 *
 * MUST BE INVISIBLE TO HASHING. `bodyOf` strips it, so annotating a block does
 * not change its hash.
 *
 * THE CHAIN, not just the conclusion — because someone will eventually want the
 * marker inside the hashed content for auditability, and this is the answer:
 *
 *   annotating changes the block hash
 *     → every re-scan sees content it has never seen before
 *       → the decline is no longer idempotent, so the table grows every cycle
 *       → edit-to-fix never matches its own decline row, so the row never closes
 *       → the marker is re-added forever, stacking notices on every pass
 *
 * The marker is a record ABOUT the memory. Folding it into the memory's identity
 * makes the record change the thing it describes.
 */
const HELD_MARKER = /<!-- cortex:held[\s\S]*?-->\n*/g

/**
 * What a consumed memory leaves behind: one generic line, identical in every file.
 *
 * Emptying the file to 0 bytes was correct for Cortex and wrong for everything
 * else that reads it: a session that opens it finds nothing and is told nothing.
 *
 * It deliberately says NOTHING about the memory that was there
 * (2026-10-13). Per-memory detail in the file would let a session answer from
 * the stub instead of asking Cortex, which costs a read before the graph is
 * even queried, can pass a one-line description off as the whole answer, and
 * hides the signal for how recall needs to evolve. Restore works from the
 * journal, which records each memory's source, never from the stub.
 *
 * The line is its own marker: the splitter strips exactly this line, so a stub
 * is never ingested or hashed and a stub-only file is not an inbox.
 */
export const STUB_LINE = '<!-- cortex:stub --> This memory lives in Cortex. Use Cortex for any memory search.'

const STUB_MARKER = new RegExp(
  `^[ \\t]*${STUB_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*(?:\\n|$)\\n*`,
  'gm',
)

/** The stub, once, when the file holds it. */
const HAS_STUB = new RegExp(STUB_MARKER.source, 'm') // not global: .test on a /g regex is stateful
export const stubsIn = (text: string): string[] => (HAS_STUB.test(text) ? [STUB_LINE] : [])

/** For the held note, which does name a command: releasing is an action, not recall. */
const REPO = path.resolve(import.meta.dirname, '..', '..', '..')

const withStubs = (stubs: string[], blocks: string[]): string => {
  const parts = [...new Set(stubs), ...blocks]
  return parts.length ? parts.join('\n\n') + '\n' : ''
}

/**
 * Split a scratchpad into memory blocks.
 *
 * A block starts at a frontmatter fence that is at the start of the file or
 * preceded by a blank line. Text before the first fence is a block too — a
 * memory written without frontmatter is still a memory, and dropping it as
 * unparseable would lose it.
 */
export const splitScratchpad = (text: string): Block[] => {
  // Decline markers are METADATA, not content, so they are removed before the
  // file is divided rather than after. Leaving them in made them structural:
  // with no blank line after one the following fence stopped starting a block
  // (two memories merged into one); with a blank line the marker became a
  // LEADING block of its own. Both are the same mistake — letting a record
  // ABOUT the content participate in deciding what the content is.
  const content = text.replace(HELD_MARKER, '').replace(STUB_MARKER, '')
  const lines = content.split('\n')
  const starts: number[] = []

  // A `---` inside a code fence is content, not a boundary. V1 pattern memories
  // carry captured error output in fences; splitting there turned one memory
  // into nameless fragments, each ingested on its own (laptop Stage A).
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i] ?? '')) inFence = !inFence
    if (inFence || !FRONTMATTER_START.test(lines[i] ?? '')) continue
    if (i === 0 || (lines[i - 1] ?? '').trim() === '') starts.push(i)
  }

  if (!starts.length) {
    return content.trim() ? [block(content)] : []
  }

  const blocks: Block[] = []
  if (starts[0]! > 0) {
    const lead = lines.slice(0, starts[0]!).join('\n')
    if (lead.trim()) blocks.push(block(lead))
  }
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1]! : lines.length
    const raw = lines.slice(starts[i]!, end).join('\n')
    if (raw.trim()) blocks.push(block(raw))
  }
  return blocks
}

/**
 * The body a block hashes to — frontmatter stripped.
 *
 * Ingest hashes the body, so consume must hash it identically or no block would
 * ever match its own ticket entry and the scratchpad would never empty.
 */
export const bodyOf = (raw: string): string => {
  const stripped = raw.replace(HELD_MARKER, '').replace(STUB_MARKER, '')
  const m = stripped.match(/^---\s*\n[\s\S]*?\n---\s*\n?([\s\S]*)$/)
  return (m ? m[1]! : stripped).trim()
}

const block = (raw: string): Block => {
  const body = bodyOf(raw)
  return { raw, body, hash: hashContent(body) }
}

export type DeclineNotice = {
  /** Body hash of the block being annotated. Identifies it across rewrites. */
  hash: string
  /** Why it is held: a credential (the default), or text appended to a stub that no single memory owns. */
  reason?: 'secret' | 'appended-to-stub'
  /** Non-revealing. `kind` and `line` only — never the matched value. */
  findings: { kind: string; line: number; hint: string }[]
}

const renderMarker = (n: DeclineNotice): string => {
  if (n.reason === 'appended-to-stub')
    return [
      '<!-- cortex:held',
      '  THIS TEXT WAS NOT INDEXED: it was added below a stub, and Cortex cannot tell',
      '  which memory it updates (this file stands for none, or for several).',
      '',
      '  To update a memory, rewrite this file with the WHOLE memory again: its',
      '  frontmatter (same name:), its text, then the new part. To add a new memory,',
      '  give this text its own frontmatter.',
      '',
      '  This note is ignored by Cortex and is safe to delete.',
      '-->',
      '',
      '',
    ].join('\n')
  const lines = n.findings.map((f) => `  · line ${f.line}: ${f.hint}`).join('\n')
  return [
    '<!-- cortex:held',
    '  THIS MEMORY WAS NOT INDEXED AND HAS NOT LEFT THIS MACHINE.',
    '  It looks like it contains a credential:',
    lines,
    '',
    '  To fix: remove the value and save again. Secrets belong in the secret',
    '  store; a memory should say WHERE a credential lives, not what it is.',
    '  If this is a false positive, release it and sweep again:',
    `    ${runScript(REPO, 'cortex-memory.ts')} release ${n.hash.slice(0, 12)}`,
    '',
    '  This note is ignored by Cortex and is safe to delete.',
    '-->',
    '',
    '', // BLANK LINE REQUIRED — see below.
  ].join('\n')
}

/**
 * That trailing blank line is not formatting.
 *
 * `splitScratchpad` starts a block at a `---` fence that is at the start of the
 * file OR preceded by a blank line. Without the blank line the marker's closing
 * `-->` sits immediately above the fence, the fence stops being a block start,
 * and the annotated memory MERGES INTO THE ONE ABOVE IT — two memories become
 * one, with a new hash that matches no ticket and no decline row.
 *
 * Found by the first test that ran the whole sweep against a real directory. It
 * was invisible to every unit test in this module, because each of them
 * exercised annotation and splitting separately and both were individually
 * correct. Same family as the redaction record that survived the rewrite it was
 * tested against and not the restore it existed for: a proof of each part is not
 * a proof of the seam.
 */

/**
 * Write (or refresh) decline receipts in a scratchpad.
 *
 * Idempotent by construction: existing markers are stripped before new ones are
 * written, so re-scanning unchanged content rewrites the same bytes rather than
 * stacking notices. A block whose hash is no longer declined simply loses its
 * marker — which is what makes edit-to-fix clean up after itself.
 */
export const annotateDeclines = (
  source: string,
  notices: DeclineNotice[],
  opts: { readFile?: typeof fs.readFileSync; writeFile?: typeof fs.writeFileSync } = {},
): { annotated: number; cleared: number } => {
  const read = opts.readFile ?? fs.readFileSync
  const write = opts.writeFile ?? fs.writeFileSync

  const before = read(source, 'utf-8') as string
  const byHash = new Map(notices.map((n) => [n.hash, n]))

  const hadMarkers = (before.match(HELD_MARKER) ?? []).length
  let annotated = 0

  // splitScratchpad has already stripped any existing markers, so this rebuilds
  // them from `notices` rather than editing them in place — which is what makes
  // re-annotating unchanged content produce identical bytes instead of stacking.
  const out = splitScratchpad(before).map((b) => {
    const notice = byHash.get(b.hash)
    if (!notice) return b.raw.trim()
    annotated++
    return renderMarker(notice) + b.raw.trim()
  })

  const next = withStubs(stubsIn(before), out)
  if (next !== before) write(source, next, 'utf-8')

  return { annotated, cleared: Math.max(0, hadMarkers - annotated) }
}

export type ConsumeOutcome = {
  dropped: number
  retained: number
  /** How many times a concurrent append forced a re-run. */
  retries: number
}

/**
 * Copy → diff → drop → verify, converging rather than locking.
 *
 * This shape's advantage is easy to miss unless stated: it needs
 * NEITHER rename atomicity NOR locks, both of which are unreliable across this
 * fleet's filesystem mix. The residual it leaves is the read-modify-write gap
 * between the final diff and rewriting the source — an append landing inside it
 * would be lost, and without locks you cannot exclude it.
 *
 * So it is closed CONVERGENTLY: after rewriting, immediately re-read and compare
 * against what we wrote. A mismatch means a concurrent append slipped in, so run
 * the whole thing again. No locks, no atomicity assumptions, portable.
 */
export const consume = (
  ticket: ConsumeTicket,
  opts: {
    maxRetries?: number
    readFile?: typeof fs.readFileSync
    writeFile?: typeof fs.writeFileSync
    /** Leave STUB_LINE where blocks were dropped. Without it, they just go. */
    stub?: boolean
  } = {},
): ConsumeOutcome => {
  const read = opts.readFile ?? fs.readFileSync
  const write = opts.writeFile ?? fs.writeFileSync
  const maxRetries = opts.maxRetries ?? 5
  const authorised = new Set(ticket.hashes)

  let retries = 0
  for (;;) {
    const before = read(ticket.source, 'utf-8') as string
    const blocks = splitScratchpad(before)

    // The ticket is the ONLY drop criterion. Anything it does not name — a
    // declined memory, a concurrent append — is retained by identity.
    const retained = blocks.filter((b) => !authorised.has(b.hash))
    const dropped = blocks.length - retained.length

    if (dropped === 0) return { dropped: 0, retained: blocks.length, retries }

    const stubs = opts.stub ? [STUB_LINE] : stubsIn(before)
    const next = withStubs(stubs, retained.map((b) => b.raw.trim()))
    write(ticket.source, next, 'utf-8')

    // The convergence check. Re-read and compare against what we wrote; a
    // mismatch means an append landed inside the read-modify-write gap.
    const after = read(ticket.source, 'utf-8') as string
    if (after === next) return { dropped, retained: retained.length, retries }

    retries++
    if (retries > maxRetries) {
      // Give up rather than loop forever, and give up in the SAFE direction:
      // the scratchpad keeps whatever is there. Re-running ingest is idempotent
      // (rung 2), so nothing is lost by leaving it.
      return { dropped, retained: retained.length, retries }
    }
  }
}
