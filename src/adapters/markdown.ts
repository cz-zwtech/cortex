import type { DirEntry } from './fs'
import type { Entity, Kind, Scope } from '@/ontology'
import { fs, basename, join, stripExt } from './fs'
import { parse, stringify } from './frontmatter'
import { getCachedFile, setCachedFile, type FileStamp } from '@/registry'

export interface MarkdownReadOptions<T> {
  dir: string
  scope: Scope
  kind: Kind
  recursive?: boolean
  build: (input: {
    rawData: Record<string, unknown>
    body: string
    path: string
    relativePath: string
    fileName: string
  }) => T
  idOf: (value: T) => string
}

const stampOf = (e: DirEntry): FileStamp => ({ mtime: e.mtime, size: e.size })

const scopeSlug = (scope: Scope): string =>
  scope.type === 'user' ? 'user' : scope.projectId

const relativeOf = (entryPath: string, dir: string, fallback: string): string =>
  entryPath.startsWith(dir)
    ? entryPath.slice(dir.length + 1).replace(/\\/g, '/')
    : fallback

const buildEntity = <T>(
  raw: string,
  entry: DirEntry,
  opts: MarkdownReadOptions<T>,
): Entity<T> => {
  const relative = relativeOf(entry.path, opts.dir, entry.name)
  try {
    const { data, body } = parse(raw)
    const value = opts.build({
      rawData: data as Record<string, unknown>,
      body,
      path: entry.path,
      relativePath: relative,
      fileName: stripExt(basename(entry.path), '.md'),
    })
    return {
      id: `${opts.kind}:${scopeSlug(opts.scope)}:${opts.idOf(value)}`,
      kind: opts.kind,
      scope: opts.scope,
      path: entry.path,
      value,
      origin: value,
      raw,
    }
  } catch (err) {
    const empty = {} as T
    return {
      id: `${opts.kind}:${scopeSlug(opts.scope)}:${relative}`,
      kind: opts.kind,
      scope: opts.scope,
      path: entry.path,
      value: empty,
      origin: empty,
      raw,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

const readOne = async <T>(
  entry: DirEntry,
  opts: MarkdownReadOptions<T>,
): Promise<Entity<T> | null> => {
  const stamp = stampOf(entry)
  const cached = getCachedFile<Entity<T>>(entry.path, stamp)
  if (cached) return cached
  const raw = await fs.readText(entry.path).catch(() => null)
  if (raw === null) return null
  const entity = buildEntity(raw, entry, opts)
  // Only persist successful parses. Caching a parse error would freeze the
  // broken entity's `{} as T` value on disk across launches and cause UI
  // crashes on fields that expect strings.
  if (!entity.error) setCachedFile(entry.path, stamp, entity)
  return entity
}

export const readMarkdownDir = async <T>(
  opts: MarkdownReadOptions<T>,
): Promise<Entity<T>[]> => {
  if (!(await fs.pathExists(opts.dir))) return []
  const entries = opts.recursive
    ? await fs.listDirRecursive(opts.dir, 8)
    : await fs.listDir(opts.dir)
  const markdownFiles = entries.filter(
    (e) => e.is_file && e.name.endsWith('.md'),
  )
  const results = await Promise.all(markdownFiles.map((e) => readOne(e, opts)))
  return results.filter((x): x is Entity<T> => x !== null)
}

export const writeMarkdown = async (
  path: string,
  data: Record<string, unknown>,
  body: string,
): Promise<void> => {
  await fs.writeText(path, stringify(data, body))
}

export { join }
