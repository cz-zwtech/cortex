/**
 * Project-scope helpers shared by the SessionStart capability sheet and the
 * recall route. A memory written under `~/.claude/projects/<encoded-cwd>/` is
 * stored with scope `project:<encoded-cwd>`; Claude Code often launches from a
 * parent dir, so we walk cwd → ancestors and emit a scope for each so a query
 * captures every plausible parent.
 */
export const encodeCwd = (cwd: string): string => cwd.replace(/[/\\:]/g, '-')

export const ancestorProjectScopes = (cwd: string): string[] => {
  const out: string[] = []
  let p = cwd
  while (p && p !== '/' && p.length > 1) {
    out.push(`project:${encodeCwd(p)}`)
    const i = p.lastIndexOf('/')
    if (i <= 0) break
    p = p.slice(0, i)
  }
  return out
}
