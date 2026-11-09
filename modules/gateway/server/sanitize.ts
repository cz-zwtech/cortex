/**
 * The sanitizer, outbound, on every record that leaves (trust doc 5). The
 * first slice ships the deterministic stage only ("ship without" the
 * classifier): the memory module's secret gate, then the owner's deny list. A
 * hit HOLDS the record: it does not leave, and the sender is told only that it
 * is held for review, never why, because the reason may be the sensitive part.
 * Nothing is ever passed on an error.
 */
import { scanForSecrets } from '../../../core/secrets.js'

export type Verdict = { ok: true } | { ok: false; rule: string }

export const sanitize = (text: string, denyList: string[]): Verdict => {
  try {
    const secrets = scanForSecrets(text)
    if (secrets.length) return { ok: false, rule: `secret gate: ${secrets.map((s) => s.kind).join(', ')}` }
    const lower = text.toLowerCase()
    const hit = denyList.find((d) => lower.includes(d.toLowerCase()))
    if (hit) return { ok: false, rule: 'deny list' }
    return { ok: true }
  } catch (err) {
    return { ok: false, rule: `sanitizer error: ${err instanceof Error ? err.message : String(err)}` }
  }
}
