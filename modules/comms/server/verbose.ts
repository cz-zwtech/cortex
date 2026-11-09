/**
 * How much comms says. Normal output is the message and who sent it; anything
 * that would change what the sender does next (an error, no such role or
 * member, queued with nobody live) is always shown. Verbose restores delivery
 * status, liveness, recipients and claim detail, for working out why a message
 * did not arrive. On with CKN_COMMS_VERBOSE=1, --verbose, or `cortex-role debug on`.
 */
import fs from 'node:fs'
import path from 'node:path'

const flagFile = (dataDir: string) => path.join(dataDir, 'verbose')

export const isVerbose = (dataDir: string, env: NodeJS.ProcessEnv = process.env): boolean =>
  env.CKN_COMMS_VERBOSE === '1' || fs.existsSync(flagFile(dataDir))

export const setVerbose = (dataDir: string, on: boolean): void => {
  if (on) {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(flagFile(dataDir), '')
  } else fs.rmSync(flagFile(dataDir), { force: true })
}
