/**
 * Who may talk to the daemon: private addresses only (rule: no auth
 * between the owner's machines, which always reach each other over LAN, VLAN or VPN).
 * A request from any public address is refused before it is read.
 */
const v4 = (a: string) => a.replace(/^::ffff:/, '')

export const isPrivateAddress = (addr: string | undefined): boolean => {
  if (!addr) return false
  const a = v4(addr)
  if (a === '::1' || /^127\./.test(a)) return true
  if (/^10\./.test(a) || /^192\.168\./.test(a) || /^169\.254\./.test(a)) return true
  const m = /^(\d+)\.(\d+)\./.exec(a)
  if (m) {
    const [x, y] = [Number(m[1]), Number(m[2])]
    if (x === 172 && y >= 16 && y <= 31) return true
    if (x === 100 && y >= 64 && y <= 127) return true // CGNAT range: Tailscale and similar VPNs
    return false
  }
  return /^f[cd]/i.test(a) || /^fe[89ab]/i.test(a) // IPv6 unique-local and link-local
}
