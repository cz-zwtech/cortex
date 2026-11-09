/**
 * Where a Cortex checkout may be installed from (16 Oct 2026): on Linux,
 * anything installed takes multiple users into account. The checkout every
 * hook and daemon runs from lives where every user can run and update it
 * (home: /srv/cortex/cortex-v2-deploy, group developers). Only when the machine
 * has a single human user (a WSL box such as the hub or the laptop) does a
 * checkout in that user's home do; --single-user says so explicitly.
 *
 * Each user's data (memories, mesh log, comms) stays under their own state
 * dir, whoever's checkout runs it.
 */
import path from 'node:path'

/** Human login users from /etc/passwd: uid 1000-59999 with a real shell. */
export const humanUsers = (passwd: string): { name: string; uid: number; home: string }[] =>
  passwd
    .split('\n')
    .map((l) => l.split(':'))
    .filter((f) => f.length >= 7)
    .map(([name, , uid, , , home, shell]) => ({ name: name!, uid: Number(uid), home: home!, shell: shell! }))
    .filter((u) => u.uid >= 1000 && u.uid < 60000 && !/(nologin|false)$/.test(u.shell))
    .map(({ name, uid, home }) => ({ name, uid, home }))

export type LocationCheck = { ok: true; note?: string } | { ok: false; reason: string }

export const checkInstallLocation = (o: {
  platform: NodeJS.Platform
  repoRoot: string
  home: string
  /** cortex: that account already runs Cortex (its state dir exists), as far as this account can see. */
  users: { name: string; uid: number; home: string; cortex?: boolean }[]
  singleUser: boolean
}): LocationCheck => {
  if (o.platform !== 'linux') return { ok: true }
  const inHome = path.resolve(o.repoRoot).startsWith(path.resolve(o.home) + path.sep)
  if (!inHome) return { ok: true }
  if (o.singleUser) return { ok: true, note: 'single-user install from your home (--single-user)' }
  const others = o.users.filter((u) => path.resolve(u.home) !== path.resolve(o.home))
  // A checkout in one home is wrong only for a machine where another account runs Cortex too: they
  // could not run or update it. Other accounts that do not (a container image's `node`, a family
  // member) are no reason to refuse a one-person install.
  const sharing = others.filter((u) => u.cortex)
  if (!sharing.length) {
    return others.length
      ? { ok: true, note: `installing from your home; other accounts here (${others.map((u) => u.name).join(', ')}) do not run Cortex. If they will, use a shared checkout (INSTALL.md)` }
      : { ok: true, note: 'single-user machine: installing from your home' }
  }
  return {
    ok: false,
    reason:
      `${sharing.map((u) => u.name).join(', ')} also run${sharing.length === 1 ? 's' : ''} Cortex on this machine, and ${o.repoRoot} is in your home, ` +
      `where they cannot run or update it. Install from a shared checkout instead ` +
      `(group-writable, outside any home; see INSTALL.md), or pass --single-user ` +
      `if this account's Cortex is to be its own.`,
  }
}
