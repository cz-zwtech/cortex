import { z } from 'zod'

export const Settings = z.object({
  anthropic: z
    .object({
      apiKey: z.string().default(''),
    })
    .default({ apiKey: '' }),
  markdownDefaultMode: z.enum(['edit', 'read']).default('edit'),
  /** Plugin ids (`<name>@<marketplace>`) the user has flagged for an upcoming update. */
  markedPlugins: z.array(z.string()).default([]),
  sharedMind: z
    .object({
      /** Filesystem path of the shared-mind working clone. Empty = use server default (~/.config/ckn/shared-mind). */
      localPath: z.string().default(''),
      /** Git remote URL (SSH or HTTPS). Empty until the user pairs to a remote. */
      remoteUrl: z.string().default(''),
      /** Display name written to the manifest; used as `shared:<name>` scope on import. */
      name: z.string().default(''),
      /** Optional description of what this shared mind is for. */
      description: z.string().default(''),
    })
    .default({ localPath: '', remoteUrl: '', name: '', description: '' }),
})
export type Settings = z.infer<typeof Settings>

export const defaultSettings = (): Settings => Settings.parse({})
