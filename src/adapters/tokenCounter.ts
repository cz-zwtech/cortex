import Anthropic from '@anthropic-ai/sdk'
import { getCachedTokens, setCachedTokens } from '@/registry/tokenCache'

const hashText = async (text: string): Promise<string> => {
  const data = new TextEncoder().encode(text)
  const buf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export const countTokens = async (text: string, apiKey: string): Promise<number | null> => {
  if (!apiKey || !text) return null

  const hash = await hashText(text)
  const cached = getCachedTokens(hash)
  if (cached !== undefined) return cached

  try {
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
    const response = await client.messages.countTokens({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: text }],
    })
    const count = response.input_tokens
    setCachedTokens(hash, count)
    return count
  } catch {
    return null
  }
}
