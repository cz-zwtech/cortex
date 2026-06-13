import { z } from 'zod'

/**
 * String-array field that tolerates Claude's wire format.
 *
 * Frontmatter for agents, commands, skills and rules may write a list as
 * either a YAML array (`[Read, Write]`) or a comma-separated string
 * (`Read, Write`). Authored-by-hand files trend toward the latter; tools
 * that emit YAML trend toward the former. Both are valid inputs — they
 * get normalised to `string[]` here.
 *
 * Empty strings produce an empty array, not a singleton `[""]`, so an
 * accidental trailing comma doesn't leak an empty tool name.
 */
export const LooseStringArray = z.preprocess((input) => {
  if (typeof input === 'string') {
    return input
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return input
}, z.array(z.string()))
