import {
  Marketplace,
  emptyMarketplace,
  formatMarketplaceSource,
} from '@/ontology'
import { refreshMarketplace } from '@/adapters/marketplaceAdapter'
import { runCliOp } from '@/app/cliOp'
import { useStore } from '@/app/store'
import { Field } from '@/ui-primitives'
import type { UiDescriptor } from './types'

const ReadOnlyText = ({ value, mono = false }: { value: string; mono?: boolean }) => (
  <div className={`text-sm text-zinc-300 ${mono ? 'font-mono break-all' : 'whitespace-pre-wrap'}`}>
    {value}
  </div>
)

export const refreshOpKey = (name: string) => `refresh-marketplace:${name}`

const doRefresh = (name: string) =>
  runCliOp({
    key: refreshOpKey(name),
    loading: `Refreshing ${name}…`,
    success: `Refreshed ${name}`,
    action: () => refreshMarketplace(name),
  }).catch(() => {})

export const marketplaceDescriptor: UiDescriptor<Marketplace> = {
  kind: 'marketplace',
  newLabel: 'Add Marketplace',
  newPromptLabel: 'github repo (owner/name), URL, or local path',
  newDefault: (input) => emptyMarketplace(input),
  listLabel: (v) => v.name,
  listSublabel: (v) => formatMarketplaceSource(v.source),
  headerSubtitle: (v) => formatMarketplaceSource(v.source),
  customActions: (entity) => {
    const pending = useStore.getState().pendingOps.has(refreshOpKey(entity.value.name))
    return [
      {
        label: pending ? 'Refreshing…' : 'Refresh',
        disabled: pending,
        onSelect: () => doRefresh(entity.value.name),
      },
    ]
  },
  Editor: ({ value }) => (
    <>
      <Field label="Source">
        <ReadOnlyText value={formatMarketplaceSource(value.source)} mono />
      </Field>
      {value.installLocation && (
        <Field label="Install Location">
          <ReadOnlyText value={value.installLocation} mono />
        </Field>
      )}
      {value.lastUpdated && (
        <Field label="Last Updated">
          <ReadOnlyText value={value.lastUpdated} mono />
        </Field>
      )}
    </>
  ),
}
