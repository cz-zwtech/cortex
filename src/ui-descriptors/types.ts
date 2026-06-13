import type { ReactNode } from 'react'
import type { Entity, Kind, Project, Scope } from '@/ontology'
import type { ContextMenuItem } from '@/ui-primitives'

export interface EditorContext {
  knownAgents: string[]
  knownCommands: string[]
}

export interface ActionContext {
  scope: Scope
  projects: Project[]
  home: string
  createIn: (kind: Kind, value: any, scope: Scope) => Promise<void>
  remove: (entity: Entity<any>) => Promise<void>
}

export interface ListTab<T> {
  id: string
  label: string
  predicate: (v: T) => boolean
}

export interface UiDescriptor<T> {
  kind: Kind
  newDefault: (name: string) => T
  newLabel: string
  newPromptLabel: string
  listLabel: (v: T) => ReactNode
  listSublabel?: (v: T) => ReactNode
  /** Overrides `listLabel` for the inspector header title (e.g. include version). */
  headerTitle?: (v: T) => ReactNode
  /** Overrides the default subtitle (entity.path) shown in the inspector header. */
  headerSubtitle?: (v: T) => ReactNode
  /** Optional tab strip rendered under the list-pane search box. First tab is the default. */
  tabs?: ListTab<T>[]
  /** Per-entity predicate that suppresses the default Delete action when false. Defaults to `!spec.readOnly`. */
  canDelete?: (v: T) => boolean
  Editor: React.ComponentType<{
    value: T
    onChange: (next: T) => void
    ctx: EditorContext
  }>
  customActions?: (entity: Entity<T>, ctx: ActionContext) => ContextMenuItem[]
  /**
   * Inspector header buttons. Overrides `customActions` for the header only.
   * Use when the two surfaces (header toggle buttons vs. menu action verbs)
   * need different shapes — e.g. a stateful "Enabled" toggle in the header
   * vs. an "Enable"/"Disable" verb in the menu.
   */
  headerActions?: (entity: Entity<T>, ctx: ActionContext) => ContextMenuItem[]
}
