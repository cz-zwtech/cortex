/**
 * renderResumeHead — the resume-and-stop control surface for `/cortex-continue`
 * (ratified [[cortex-resume-ux-and-parallelism-design]]).
 *
 * A resume must re-orient the HUMAN and STOP — it must NOT auto-execute the
 * thread's next_step (that auto-pilot once ran ~4 min unattended, messaging peers
 * and editing files). The next_step is a note for the human to act on together,
 * not a command the session runs by itself.
 *
 * The guard lives in CODE here, not only in the editable command-body prose that
 * drifted into auto-pilot once already: the resume output itself prints just the
 * HEAD (status + next_step + the LIST of link slugs, NOT their contents) and
 * carries the STOP directive + the intent-driven depth paths.
 */
export interface ResumeHeadInput {
  id: string
  description: string
  state: {
    status: string
    nextStep: string
    links: string[]
    repo?: string
    branch?: string
    pushed?: boolean
  }
}

export function renderResumeHead(thread: ResumeHeadInput, claimState: string): string {
  const s = thread.state
  const lines = [
    `RESUMED ${thread.id} (${claimState})`,
    `status:    ${s.status}`,
    `next_step: ${s.nextStep || '(none recorded)'}`,
  ]
  if (s.links.length) lines.push(`links:     ${s.links.join(', ')}`)
  if (s.repo)
    lines.push(
      `repo:      ${s.repo}${s.branch ? `  branch: ${s.branch}` : ''}  pushed: ${s.pushed ? 'yes' : 'no'}`,
    )
  lines.push(`summary:   ${thread.description}`)
  lines.push('')
  lines.push('— Resumed + claimed by THIS session. Re-orient with this head, then STOP.')
  lines.push('  do NOT auto-run next_step — it is a note for you + the human, not a command.')
  lines.push('  Next, on the human\'s intent:')
  lines.push('    "keep going"          → load only enough to finish the open step, then proceed WITH them.')
  lines.push('    "how did we get here?" → pull the linked memories above for the back-story, then summarize.')
  return lines.join('\n')
}
