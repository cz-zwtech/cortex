/**
 * The domain key: one ed25519 key per gateway, with a self-signed certificate
 * for TLS. Peers pin each other by the SHA-256 of the public key (SPKI), set
 * by hand over a channel the owners trust: no trust on first use (trust doc 2).
 *
 * The private key never leaves the gateway's data dir (0600) and is never
 * printed. Records crossing to a peer are signed with it, so the receiving
 * gateway knows which domain vouches for them.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const keyFile = (dir: string) => path.join(dir, 'domain.key')
export const certFile = (dir: string) => path.join(dir, 'domain.crt')

/** The pin of a public key: base64 SHA-256 of its SPKI DER. */
export const pinOf = (key: crypto.KeyObject): string =>
  crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('base64')

export const pinOfCert = (pemOrDer: string | Buffer): string => pinOf(new crypto.X509Certificate(pemOrDer).publicKey)

/** Make the domain key and certificate if absent; never overwrites. Returns the pin and whether it was new. */
export const ensureDomainKey = (dir: string, domain: string): { pin: string; minted: boolean } => {
  fs.mkdirSync(dir, { recursive: true })
  let minted = false
  if (!fs.existsSync(keyFile(dir))) {
    const { privateKey } = crypto.generateKeyPairSync('ed25519')
    fs.writeFileSync(keyFile(dir), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    fs.rmSync(certFile(dir), { force: true })
    minted = true
  }
  if (!fs.existsSync(certFile(dir))) {
    // Node has no API to make an X.509 certificate; openssl is on every target (Pi OS, Ubuntu, the lab image).
    const r = spawnSync('openssl', ['req', '-new', '-x509', '-key', keyFile(dir), '-out', certFile(dir), '-days', '3650', '-subj', `/CN=cortex-gateway-${domain}`], { encoding: 'utf-8' })
    if (r.status !== 0) throw new Error(`could not make the gateway certificate with openssl: ${(r.stderr || r.error?.message || '').trim()}`)
  }
  return { pin: pinOfCert(fs.readFileSync(certFile(dir))), minted }
}

export type DomainKey = { key: Buffer; cert: Buffer; privateKey: crypto.KeyObject; pin: string }

export const loadDomainKey = (dir: string): DomainKey => {
  const key = fs.readFileSync(keyFile(dir))
  const cert = fs.readFileSync(certFile(dir))
  const privateKey = crypto.createPrivateKey(key)
  const pin = pinOfCert(cert)
  if (pin !== pinOf(crypto.createPublicKey(privateKey))) throw new Error(`${certFile(dir)} does not match ${keyFile(dir)}`)
  return { key, cert, privateKey, pin }
}

/** A stable byte form of a record for signing: keys sorted, no signature field. */
export const canonical = (o: Record<string, unknown>): string =>
  JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'sig').sort(([a], [b]) => a.localeCompare(b))))

export const sign = (o: Record<string, unknown>, k: crypto.KeyObject): string => crypto.sign(null, Buffer.from(canonical(o)), k).toString('base64')

export const verify = (o: Record<string, unknown> & { sig?: unknown }, publicKey: crypto.KeyObject): boolean => {
  if (typeof o.sig !== 'string') return false
  try {
    return crypto.verify(null, Buffer.from(canonical(o)), publicKey, Buffer.from(o.sig, 'base64'))
  } catch {
    return false
  }
}
