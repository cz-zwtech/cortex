import { Hook, type Entity, type HookHandler } from '@/ontology'
import { settingsPath, type Location } from './paths'
import { fs, readJsonOrNull } from './fs'

interface SettingsShape {
  hooks?: Record<string, Array<{ matcher?: string; hooks?: HookHandler[] }>>
  [k: string]: unknown
}

const scopeKey = (loc: Location) =>
  loc.scope.type === 'user' ? 'user' : loc.scope.projectId

export const readHooks = async (loc: Location): Promise<Entity<Hook>[]> => {
  const path = settingsPath(loc)
  const settings = await readJsonOrNull<SettingsShape>(path)
  const out: Entity<Hook>[] = []
  if (!settings?.hooks) return out
  for (const [event, groups] of Object.entries(settings.hooks)) {
    groups.forEach((group, index) => {
      const value: Hook = {
        event: event as Hook['event'],
        matcher: group.matcher ?? '',
        index,
        handlers: (group.hooks ?? []).map((h) => ({
          type: h.type ?? 'command',
          command: h.command ?? '',
          timeout: h.timeout,
        })),
      }
      out.push({
        id: `hook:${scopeKey(loc)}:${event}::${value.matcher}::${index}`,
        kind: 'hook',
        scope: loc.scope,
        path,
        value,
        origin: value,
        raw: JSON.stringify(group),
      })
    })
  }
  return out
}

export const writeHook = async (
  loc: Location,
  original: Entity<Hook> | null,
  next: Hook,
): Promise<void> => {
  const path = settingsPath(loc)
  const settings: SettingsShape = (await readJsonOrNull<SettingsShape>(path)) ?? {}
  settings.hooks ??= {}

  if (original) {
    const origin = original.origin
    const arr = settings.hooks[origin.event] ?? []
    if (origin.event === next.event && arr[origin.index]) {
      arr[origin.index] = { matcher: next.matcher, hooks: next.handlers }
      settings.hooks[origin.event] = arr
    } else {
      if (arr[origin.index]) {
        arr.splice(origin.index, 1)
        settings.hooks[origin.event] = arr
      }
      settings.hooks[next.event] ??= []
      settings.hooks[next.event]!.push({ matcher: next.matcher, hooks: next.handlers })
    }
  } else {
    settings.hooks[next.event] ??= []
    settings.hooks[next.event]!.push({ matcher: next.matcher, hooks: next.handlers })
  }

  await fs.writeJson(path, settings)
}

export const deleteHook = async (
  loc: Location,
  entity: Entity<Hook>,
): Promise<void> => {
  const path = settingsPath(loc)
  const settings = (await readJsonOrNull<SettingsShape>(path)) ?? {}
  const origin = entity.origin
  const arr = settings.hooks?.[origin.event]
  if (!arr) return
  arr.splice(origin.index, 1)
  if (arr.length === 0) delete settings.hooks![origin.event]
  await fs.writeJson(path, settings)
}
