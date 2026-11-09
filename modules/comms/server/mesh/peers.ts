/** The static peer list: three machines need no discovery. */
import fs from 'node:fs'
import path from 'node:path'

export const peersFile = (dir: string) => path.join(dir, 'peers.json')

export const readPeers = (dir: string): string[] => {
  try {
    return (JSON.parse(fs.readFileSync(peersFile(dir), 'utf-8')) as { peers: string[] }).peers ?? []
  } catch {
    return []
  }
}

const write = (dir: string, peers: string[]) => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(peersFile(dir), JSON.stringify({ peers: [...new Set(peers)].sort() }, null, 2) + '\n')
}

export const normalisePeer = (url: string): string => {
  const u = new URL(/^https?:\/\//.test(url) ? url : `http://${url}`)
  return `${u.protocol}//${u.host}`
}

export const addPeer = (dir: string, url: string): string => {
  const p = normalisePeer(url)
  write(dir, [...readPeers(dir), p])
  return p
}

export const removePeer = (dir: string, url: string): boolean => {
  const p = normalisePeer(url)
  const before = readPeers(dir)
  write(dir, before.filter((x) => x !== p))
  return before.includes(p)
}
