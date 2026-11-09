/** The gateway's status.json, written by the running gateway and read by cortex-gate and cortex-status. */
import fs from 'node:fs'
import path from 'node:path'

export type GatewayStatus = {
  domain: string
  pin: string
  port: number
  updatedAt: number
  peers: { domain: string; address?: string; linked: boolean }[]
  paths: number
  mailbox: number
  banned: string[]
  /** The audit chain at its last check; absent from a gateway that predates slice 6. */
  audit?: { ok: boolean; lines: number; broken?: string }
}

export const statusFile = (dir: string) => path.join(dir, 'status.json')

export const writeGatewayStatus = (dir: string, s: GatewayStatus): void => {
  const tmp = `${statusFile(dir)}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2))
  fs.renameSync(tmp, statusFile(dir))
}

/** The last status, or undefined when the gateway has not run (or stopped more than a minute ago). */
export const readGatewayStatus = (dir: string, now = Date.now()): GatewayStatus | undefined => {
  try {
    const s = JSON.parse(fs.readFileSync(statusFile(dir), 'utf-8')) as GatewayStatus
    return now - s.updatedAt < 60_000 ? s : undefined
  } catch {
    return undefined
  }
}
