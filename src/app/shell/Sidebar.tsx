import { useState, useRef } from 'react'
import { type Scope } from '@/ontology'
import { useStore } from '@/app/store'
import { openScanDialog, prompt, TagEditorPortal } from '@/ui-primitives'
import { pickDirectory } from '@/adapters/dialog'
import { fs } from '@/adapters'
import { toast } from 'sonner'
import { buildHierarchy, type HierarchyNode } from '@/engine/hierarchy'

export function Sidebar() {
  const scope = useStore((s) => s.scope)
  const projects = useStore((s) => s.projects)
  const home = useStore((s) => s.home)
  const setScope = useStore((s) => s.setScope)
  const addProject = useStore((s) => s.addProject)
  const removeProject = useStore((s) => s.removeProject)
  const projectTags = useStore((s) => s.projectTags)
  const hiddenTags = useStore((s) => s.hiddenTags)
  const updateProjectTags = useStore((s) => s.updateProjectTags)
  const toggleHiddenTag = useStore((s) => s.toggleHiddenTag)

  const tree = buildHierarchy(projects)

  const allTags = Array.from(
    new Set(Object.values(projectTags).flat())
  ).sort()

  const isVisible = (node: HierarchyNode): boolean => {
    if (hiddenTags.size === 0) return true
    const scope = node.scope
    if (scope.type !== 'project') return true
    const tags = projectTags[scope.projectId] ?? []
    if (tags.length === 0) return true
    return !tags.some((t) => hiddenTags.has(t))
  }

  const handleAdd = async () => {
    const path = await pickDirectory()
    if (!path) return
    const name = await prompt('Project name (optional)', {
      initialValue: '',
      placeholder: path.split(/[\\/]/).pop() ?? '',
    })
    await addProject(path, name || undefined)
  }

  const handleScan = async () => {
    const root = await pickDirectory()
    if (!root) return
    await openScanDialog(root, (r) => fs.scanForProjects(r))
    toast.message('Scanning…', { description: root })
  }

  const isActive = (s: Scope) => {
    if (s.type === 'user') return scope.type === 'user'
    return scope.type === 'project' && scope.projectId === s.projectId
  }

  return (
    <aside
      className="shrink-0 border-r border-[var(--color-line)] flex flex-col"
      style={{ width: 'var(--pane-narrow)', background: 'var(--color-bg-1)' }}
    >
      {/* ── Scopes header ─────────────────────────────────────────────────── */}
      <div className="shrink-0 px-3.5 pt-2.5 pb-2 border-b border-[var(--color-line)] flex items-center gap-1.5">
        <span className="t-ghost text-[10px] tracking-[0.25em] flex-1">// SCOPES</span>
        <button
          onClick={handleScan}
          className="t-ghost btn text-xs leading-none"
          title="Scan for projects"
        >
          <ScanIcon />
        </button>
        <button
          onClick={handleAdd}
          className="t-ghost btn text-sm leading-none"
          title="Add project"
        >
          +
        </button>
      </div>

      {/* ── Tag filter ────────────────────────────────────────────────────── */}
      {allTags.length > 0 && (
        <div className="shrink-0 px-3 py-1.5 border-b border-[var(--color-line)] flex flex-wrap gap-1.5 items-center">
          {allTags.map((tag) => {
            const hidden = hiddenTags.has(tag)
            return (
              <button
                key={tag}
                onClick={() => toggleHiddenTag(tag)}
                title={hidden ? `Show "${tag}" scopes` : `Hide "${tag}" scopes`}
                className="tag"
                style={{
                  fontSize: 9,
                  opacity: hidden ? 0.45 : 1,
                  borderColor: hidden ? 'var(--color-line)' : 'var(--color-amber-dim)',
                  color: hidden ? 'var(--color-dim)' : 'var(--color-amber)',
                }}
              >
                {hidden ? '○' : '◉'} {tag}
              </button>
            )
          })}
          {hiddenTags.size > 0 && (
            <button
              onClick={() => Array.from(hiddenTags).forEach((t) => toggleHiddenTag(t))}
              className="t-ghost text-[10px] hover:text-[color:var(--color-mid)] transition-colors"
              title="Show all"
            >
              show all
            </button>
          )}
        </div>
      )}

      {/* ── Scope tree — scrollable ───────────────────────────────────────── */}
      <div className="flex-1 overflow-auto min-h-0 py-2">
        <ScopeRow
          name="global"
          path={home ? `${home.replace(/\\/g, '/')}/.claude` : undefined}
          active={isActive({ type: 'user' })}
          depth={-1}
          tags={[]}
          onSelect={() => setScope({ type: 'user' })}
          onTagsChange={() => {}}
        />

        {tree.map((node) => (
          <TreeNode
            key={node.path}
            node={node}
            activeScope={scope}
            projectTags={projectTags}
            hiddenTags={hiddenTags}
            isVisible={isVisible}
            onSelect={(s) => setScope(s)}
            onRemove={(s) => {
              const p = projects.find((p) => s.type === 'project' && p.id === s.projectId)
              if (p) removeProject(p)
            }}
            onTagsChange={(projectId, tags) => updateProjectTags(projectId, tags)}
          />
        ))}

        {projects.length === 0 && (
          <div className="px-3 py-3 t-dim text-[11px] italic">No projects.</div>
        )}
      </div>
    </aside>
  )
}

// ── Tree node ─────────────────────────────────────────────────────────────────

function TreeNode({
  node,
  activeScope,
  projectTags,
  hiddenTags,
  isVisible,
  onSelect,
  onRemove,
  onTagsChange,
}: {
  node: HierarchyNode
  activeScope: Scope
  projectTags: Record<string, string[]>
  hiddenTags: Set<string>
  isVisible: (node: HierarchyNode) => boolean
  onSelect: (s: Scope) => void
  onRemove: (s: Scope) => void
  onTagsChange: (projectId: string, tags: string[]) => void
}) {
  const containsActive = nodeContainsScope(node, activeScope)
  const [expanded, setExpanded] = useState(containsActive || node.depth === 0)
  const hasVisibleChildren = node.children.some((c) => isVisible(c))

  if (!isVisible(node)) return null

  const projectId = node.scope.type === 'project' ? node.scope.projectId : null
  const tags = projectId ? (projectTags[projectId] ?? []) : []

  const isActive =
    activeScope.type === 'project' &&
    node.scope.type === 'project' &&
    activeScope.projectId === node.scope.projectId

  return (
    <div>
      <ScopeRow
        name={node.name}
        path={node.path}
        active={isActive}
        depth={node.depth}
        tags={tags}
        hasChildren={hasVisibleChildren}
        expanded={expanded}
        onToggle={hasVisibleChildren ? () => setExpanded((v) => !v) : undefined}
        onSelect={() => onSelect(node.scope)}
        onRemove={() => onRemove(node.scope)}
        onTagsChange={projectId ? (t) => onTagsChange(projectId, t) : undefined}
      />
      {hasVisibleChildren && expanded && (
        <div>
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              activeScope={activeScope}
              projectTags={projectTags}
              hiddenTags={hiddenTags}
              isVisible={isVisible}
              onSelect={onSelect}
              onRemove={onRemove}
              onTagsChange={onTagsChange}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function nodeContainsScope(node: HierarchyNode, scope: Scope): boolean {
  if (scope.type === 'project' && node.scope.type === 'project') {
    if (node.scope.projectId === scope.projectId) return true
  }
  return node.children.some((c) => nodeContainsScope(c, scope))
}

// ── Scope row ─────────────────────────────────────────────────────────────────

function ScopeRow({
  name,
  path,
  active,
  depth,
  tags,
  hasChildren,
  expanded,
  onToggle,
  onSelect,
  onRemove,
  onTagsChange,
}: {
  name: string
  path?: string
  active: boolean
  depth: number
  tags: string[]
  hasChildren?: boolean
  expanded?: boolean
  onToggle?: () => void
  onSelect: () => void
  onRemove?: () => void
  onTagsChange?: (tags: string[]) => void
}) {
  const indent = depth < 0 ? 0 : (depth + 1) * 12
  const [editorAnchor, setEditorAnchor] = useState<DOMRect | null>(null)
  const tagBtnRef = useRef<HTMLButtonElement | null>(null)

  const openEditor = () => {
    const r = tagBtnRef.current?.getBoundingClientRect()
    if (r) setEditorAnchor(r)
  }

  return (
    <div className="relative">
      <div
        className="group flex items-center gap-1 pr-2 transition-colors hover:bg-[rgba(176,112,255,0.06)]"
        style={{
          paddingLeft: indent,
          borderLeft: active ? '2px solid var(--color-phos)' : '2px solid transparent',
          background: active ? 'linear-gradient(90deg, rgba(176,112,255,0.14), transparent 70%)' : undefined,
        }}
      >
        {/* Chevron */}
        {hasChildren ? (
          <button
            onClick={(e) => { e.stopPropagation(); onToggle?.() }}
            className="shrink-0 t-ghost hover:text-[color:var(--color-mid)] w-4 flex items-center justify-center transition-colors"
          >
            <ChevronIcon expanded={!!expanded} />
          </button>
        ) : (
          depth >= 0 && <span className="shrink-0 w-4" />
        )}

        {/* Name + path */}
        <button onClick={onSelect} className="flex-1 min-w-0 py-1 text-left">
          <div
            className="text-[12px] truncate"
            style={{ color: active ? 'var(--color-pale)' : 'var(--color-mid)' }}
          >
            {name}
          </div>
          {path && (
            <div className="text-[9px] truncate" style={{ color: 'var(--color-ghost)' }}>{path}</div>
          )}
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-0.5">
              {tags.map((t) => (
                <span key={t} className="tag" style={{ fontSize: 9 }}>
                  {t}
                </span>
              ))}
            </div>
          )}
        </button>

        {onTagsChange && (
          <button
            ref={tagBtnRef}
            onClick={(e) => {
              e.stopPropagation()
              if (editorAnchor) setEditorAnchor(null)
              else openEditor()
            }}
            className="opacity-0 group-hover:opacity-100 t-ghost hover:text-[color:var(--color-amber)] px-1 text-xs transition-colors"
            title="Edit tags"
          >
            #
          </button>
        )}

        {onRemove && (
          <button
            onClick={(e) => { e.stopPropagation(); onRemove() }}
            className="opacity-0 group-hover:opacity-100 t-ghost hover:text-[color:var(--color-rose)] text-xs px-1 transition-colors"
            title="Remove from list"
          >
            ×
          </button>
        )}
      </div>

      {editorAnchor && onTagsChange && (
        <TagEditorPortal
          anchor={editorAnchor}
          tags={tags}
          onChange={onTagsChange}
          onClose={() => setEditorAnchor(null)}
        />
      )}
    </div>
  )
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="10" height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
    >
      <path d="M3 2 L7 5 L3 8" />
    </svg>
  )
}

function ScanIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

