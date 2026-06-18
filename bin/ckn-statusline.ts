#!/usr/bin/env tsx
/**
 * ckn-statusline — opt-in installer for the Cortex statusline dots (bus + the
 * binary mesh dot). Cortex ships NO statusline by default; this runs only when the
 * human invokes it, and writes only on explicit consent. Adaptive routing:
 *   - an existing `statusLine` in ~/.claude/settings.json → print the paste-in
 *     SNIPPET, never touch their script or settings;
 *   - no statusLine + consent (--yes or an interactive yes) → SCAFFOLD a minimal
 *     dots-only script at ~/.config/ckn/statusline.sh (Cortex's own dir) and wire
 *     the key, preserving every other settings key;
 *   - no statusLine + no consent / non-TTY → print the snippet + a pointer, write
 *     NOTHING (ship-none holds).
 * Flags: --dots bus,mesh (default both) | --yes (consent) | --snippet (force print).
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { BUS_DOT_FN, MESH_DOT_FN, COLOR_DEFS, composeScaffold } from './_statuslineSnippets.js'

/** True only when settings.json defines a non-empty `statusLine`. Tolerant of a
 *  missing/invalid file (→ false). */
export const detectStatusLine = (settingsJson: string): boolean => {
  try {
    const s = JSON.parse(settingsJson) as { statusLine?: unknown }
    const sl = s?.statusLine
    if (sl == null) return false
    if (typeof sl === 'object' && !Array.isArray(sl) && Object.keys(sl as object).length === 0) return false
    return true
  } catch {
    return false
  }
}

const parseDots = (argv: string[]): string[] => {
  const i = argv.indexOf('--dots')
  const raw = i >= 0 ? argv[i + 1] ?? '' : 'bus,mesh'
  const dots = raw
    .split(',')
    .map((d) => d.trim())
    .filter((d) => d === 'bus' || d === 'mesh')
  return dots.length ? dots : ['bus', 'mesh']
}

/** The paste-in snippet: the chosen dot function(s) + render lines + a one-line guide. */
const snippetText = (dots: string[]): string => {
  const parts: string[] = ['# --- Cortex statusline dots — paste into your existing statusline ---', COLOR_DEFS]
  if (dots.includes('bus')) {
    parts.push(BUS_DOT_FN)
    parts.push(
      `if bus_watcher_armed "$SESSION_ID"; then BUS_SEG="\${GREEN}● bus\${RST}"; else BUS_SEG="\${RED}● bus off\${RST}"; fi`,
    )
  }
  if (dots.includes('mesh')) {
    parts.push(MESH_DOT_FN)
    parts.push('MESH_SEG=$(mesh_seg)')
  }
  parts.push('# Parse SESSION_ID from stdin (jq -r .session_id) and add ${BUS_SEG} / ${MESH_SEG} to your printf line.')
  return parts.join('\n')
}

const safeParse = (s: string): Record<string, unknown> => {
  try {
    return s ? (JSON.parse(s) as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const promptYesNo = (q: string): Promise<boolean> =>
  new Promise((resolve) => {
    process.stdout.write(q)
    process.stdin.resume()
    process.stdin.once('data', (d: Buffer) => {
      try {
        process.stdin.pause()
      } catch {
        /* noop */
      }
      resolve(/^y(es)?$/i.test(String(d).trim()))
    })
  })

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2)
  const dots = parseDots(argv)
  const yes = argv.includes('--yes')
  const forceSnippet = argv.includes('--snippet')
  const home = os.homedir()
  const settingsPath = path.join(home, '.claude', 'settings.json')
  let settingsRaw = ''
  try {
    settingsRaw = fs.readFileSync(settingsPath, 'utf8')
  } catch {
    /* no settings.json yet */
  }
  const hasStatusLine = detectStatusLine(settingsRaw)

  // Snippet path — never modify an existing statusLine (the 5c4dee7/6095fcc lesson).
  if (hasStatusLine || forceSnippet) {
    console.log(snippetText(dots))
    if (hasStatusLine) {
      console.log('\n# You already have a statusLine — Cortex will not modify it. Paste the dot(s) above in.')
    }
    return
  }

  // No statusLine → scaffold only on explicit consent.
  let consent = yes
  if (!consent && process.stdin.isTTY) {
    consent = await promptYesNo(
      'No statusline found. Scaffold a minimal Cortex dots-only one at ~/.config/ckn/statusline.sh and enable it? [y/N] ',
    )
  }
  if (!consent) {
    console.log(snippetText(dots))
    console.log('\n# Cortex ships no statusline. To add these dots, paste the above into your statusline,')
    console.log('# or run `ckn-statusline --yes` to scaffold a minimal one at ~/.config/ckn/statusline.sh.')
    return
  }

  // Consent given (and no pre-existing statusLine) → write the scaffold + wire the key.
  const slPath = path.join(home, '.config', 'ckn', 'statusline.sh')
  fs.mkdirSync(path.dirname(slPath), { recursive: true })
  fs.writeFileSync(slPath, composeScaffold(dots), 'utf8')
  fs.chmodSync(slPath, 0o755)
  const settings = safeParse(settingsRaw)
  settings.statusLine = { type: 'command', command: slPath }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8')
  console.log(`[ckn-statusline] wrote ${slPath} and enabled it in ${settingsPath}`)
  console.log(`[ckn-statusline] dots: ${dots.join(' + ')}. Open a new prompt to see it.`)
}

// Auto-run only as the entry script (not when imported by the test for detectStatusLine).
const isEntry = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntry) {
  void main().catch((e) => {
    console.error('[ckn-statusline] fatal:', e instanceof Error ? e.message : String(e))
    process.exit(1)
  })
}
