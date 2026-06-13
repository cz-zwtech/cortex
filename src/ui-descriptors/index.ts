import type { Kind } from '@/ontology'
import type { UiDescriptor } from './types'
import { agentDescriptor } from './agent'
import { commandDescriptor } from './command'
import { skillDescriptor } from './skill'
import { ruleDescriptor } from './rule'
import { hookDescriptor } from './hook'
import { permissionDescriptor } from './permission'
import { mcpDescriptor } from './mcp'
import { pluginDescriptor } from './plugin'
import { marketplaceDescriptor } from './marketplace'
import { claudemdDescriptor } from './claudemd'
import { memoryDescriptor } from './memory'
import { conversationDescriptor } from './conversation'
import { symbolDescriptor } from './symbol'

export * from './types'
export * from './knowledge'

export const descriptors: Record<Kind, UiDescriptor<any>> = {
  claudemd: claudemdDescriptor,
  memory: memoryDescriptor,
  agent: agentDescriptor,
  command: commandDescriptor,
  skill: skillDescriptor,
  rule: ruleDescriptor,
  hook: hookDescriptor,
  permission: permissionDescriptor,
  mcp: mcpDescriptor,
  plugin: pluginDescriptor,
  marketplace: marketplaceDescriptor,
  conversation: conversationDescriptor,
  symbol: symbolDescriptor,
}

export const descriptorFor = <T = any>(kind: Kind): UiDescriptor<T> =>
  descriptors[kind] as UiDescriptor<T>
