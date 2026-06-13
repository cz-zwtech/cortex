import { Settings, defaultSettings } from '@/ontology'
import { fs, join, readJsonOrNull } from '@/adapters'

const settingsPath = (home: string): string => join(home, '.config', 'ckn', 'config.json')

export const loadSettings = async (home: string): Promise<Settings> => {
  const raw = await readJsonOrNull<unknown>(settingsPath(home))
  const parsed = Settings.safeParse(raw ?? {})
  return parsed.success ? parsed.data : defaultSettings()
}

export const saveSettings = async (home: string, settings: Settings): Promise<void> => {
  await fs.writeJson(settingsPath(home), settings)
}
