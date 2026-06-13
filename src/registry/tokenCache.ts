import { fs, join, readJsonOrNull } from '@/adapters'

type TokenCache = Record<string, number>

let cache: TokenCache = {}
let home = ''
let saveTimer: ReturnType<typeof setTimeout> | null = null

const cachePath = (h: string) => join(h, '.config', 'ckn', 'token-cache.json')

export const initTokenCache = async (userHome: string): Promise<void> => {
  home = userHome
  const raw = await readJsonOrNull<TokenCache>(cachePath(home))
  cache = raw ?? {}
}

const debouncedSave = () => {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    if (!home) return
    void fs.writeJson(cachePath(home), cache)
  }, 500)
}

export const getCachedTokens = (hash: string): number | undefined => cache[hash]

export const setCachedTokens = (hash: string, count: number): void => {
  cache[hash] = count
  debouncedSave()
}
