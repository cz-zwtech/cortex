/**
 * Operator conversation as dialogue (core/dialogue.ts), recorded on the
 * session's side: the session that sent or received the text is the one that
 * took part, so that is where the record belongs. The service's own store is
 * the delivery record and stays as it is.
 */
import crypto from 'node:crypto'

import { appendDialogue, type DialogueRecord } from '../../../core/dialogue.js'

type Row = { id?: unknown; at?: unknown; text?: unknown; operator?: unknown; bot?: unknown; reply_to?: unknown; owner?: unknown }

/** The session's text to an operator. */
/** Inbound and outbound ids are unique in the service's store, whichever bot carried them. */
export const sentRecord = (member: string, text: string, opts: { to?: string; replyTo?: string; outboundId?: string; at?: number }): DialogueRecord => {
  const at = opts.at ?? Date.now()
  const id = opts.outboundId ? `out:${opts.outboundId}` : `out:${crypto.createHash('sha256').update(`${member}\n${at}\n${text}`).digest('hex').slice(0, 24)}`
  return {
    v: 1, id, at, source: 'telegram',
    from: { kind: 'member', name: member },
    to: { kind: 'operator', name: opts.to ?? 'operator' },
    text,
    ...(opts.replyTo ? { replyTo: `in:${opts.replyTo}` } : {}),
    member,
  }
}

export const recordSent = (member: string, text: string, opts: { to?: string; replyTo?: string; outboundId?: string; bot?: string }): void =>
  appendDialogue('telegram', 'session', [sentRecord(member, text, opts)])

/** Operator messages the session received. A row seen twice is one record: its id is the inbound id. */
export const receivedRecords = (member: string, rows: Row[]): DialogueRecord[] => {
  const records: DialogueRecord[] = []
  for (const r of rows) {
    if (typeof r.text !== 'string' || !r.text.trim() || r.id === undefined) continue
    const at = typeof r.at === 'string' ? Date.parse(r.at) || Date.now() : typeof r.at === 'number' ? r.at : Date.now()
    records.push({
      v: 1, id: `in:${String(r.id)}`, at, source: 'telegram',
      from: { kind: 'operator', name: typeof r.operator === 'string' ? r.operator : 'operator' },
      to: { kind: 'member', name: member },
      text: r.text,
      member,
    })
  }
  return records
}

export const recordReceived = (member: string, rows: Row[]): void => appendDialogue('telegram', 'session', receivedRecords(member, rows))
