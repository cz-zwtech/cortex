import {
  Permission,
  PermissionModes,
  type Entity,
  type PermissionMode,
} from '@/ontology'
import { settingsPath, type Location } from './paths'
import { fs, readJsonOrNull } from './fs'

interface PermissionsBlock {
  allow?: string[]
  deny?: string[]
  ask?: string[]
  [k: string]: unknown
}

interface SettingsShape {
  permissions?: PermissionsBlock
  [k: string]: unknown
}

const scopeKey = (loc: Location) =>
  loc.scope.type === 'user' ? 'user' : loc.scope.projectId

const readArray = (block: PermissionsBlock | undefined, mode: PermissionMode): string[] => {
  const arr = block?.[mode]
  return Array.isArray(arr) ? arr.map((v) => String(v)) : []
}

export const readPermissions = async (
  loc: Location,
): Promise<Entity<Permission>[]> => {
  const path = settingsPath(loc)
  const settings = await readJsonOrNull<SettingsShape>(path)
  const out: Entity<Permission>[] = []
  if (!settings?.permissions) return out
  for (const mode of PermissionModes) {
    const arr = readArray(settings.permissions, mode)
    arr.forEach((pattern, index) => {
      const value: Permission = { mode, pattern, index }
      out.push({
        id: `permission:${scopeKey(loc)}:${mode}::${index}`,
        kind: 'permission',
        scope: loc.scope,
        path,
        value,
        origin: value,
        raw: pattern,
      })
    })
  }
  return out
}

const ensurePermissions = (settings: SettingsShape): PermissionsBlock => {
  if (!settings.permissions) settings.permissions = {}
  const block = settings.permissions
  for (const mode of PermissionModes) {
    if (!Array.isArray(block[mode])) block[mode] = []
  }
  return block
}

export const writePermission = async (
  loc: Location,
  original: Entity<Permission> | null,
  next: Permission,
): Promise<void> => {
  const path = settingsPath(loc)
  const settings: SettingsShape = (await readJsonOrNull<SettingsShape>(path)) ?? {}
  const block = ensurePermissions(settings)

  if (original) {
    const origin = original.origin
    const sourceArr = block[origin.mode] as string[]
    if (origin.mode === next.mode) {
      // Same-mode update: just replace at index.
      if (sourceArr[origin.index] !== undefined) {
        sourceArr[origin.index] = next.pattern
      } else {
        sourceArr.push(next.pattern)
      }
    } else {
      // Mode changed: remove from old, append to new.
      if (sourceArr[origin.index] !== undefined) {
        sourceArr.splice(origin.index, 1)
      }
      const targetArr = block[next.mode] as string[]
      targetArr.push(next.pattern)
    }
  } else {
    const targetArr = block[next.mode] as string[]
    targetArr.push(next.pattern)
  }

  await fs.writeJson(path, settings)
}

export const deletePermission = async (
  loc: Location,
  entity: Entity<Permission>,
): Promise<void> => {
  const path = settingsPath(loc)
  const settings = (await readJsonOrNull<SettingsShape>(path)) ?? {}
  const arr = settings.permissions?.[entity.origin.mode]
  if (!Array.isArray(arr)) return
  arr.splice(entity.origin.index, 1)
  await fs.writeJson(path, settings)
}
