import type { AnyEntity, Scope } from '@/ontology'
import { createEntity, type WriteContext } from '@/adapters'

export const copyEntity = async (
  entity: AnyEntity,
  targetContext: WriteContext,
  _targetScope: Scope,
): Promise<void> => {
  await createEntity(targetContext, entity.kind, entity.value)
}
