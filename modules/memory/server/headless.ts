/**
 * A headless run (claude -p, the Agent SDK) is usually a one-turn judgement.
 * Injected memories and a "use /cortex-memory" line pull it off its task: V1's
 * prompt hooks made such runs reach for tools they did not have and corrupt
 * their output. So memory injects nothing there. Ingest still runs, since a
 * headless session can write memories. CKN_MEMORY_HEADLESS=1 opts back in.
 */
export const injectsInto = (env: NodeJS.ProcessEnv = process.env): boolean =>
  !(env.CLAUDE_CODE_ENTRYPOINT ?? '').startsWith('sdk') || env.CKN_MEMORY_HEADLESS === '1'
