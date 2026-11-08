import { defineInvokeEventa } from '@moeru/eventa'

/** Local setup state. The token grants access only to this running app's loopback gateway. */
export interface CompanionConfig {
  baseURL: string
  token: string
  jevConfigured: boolean
  memoryEnabled: boolean
  binaryPath: string
  archivePath: string
  sagVersion: string
  sagError: string
}

/** Reuses a renderer provider for this app session. The main process never persists this credential. */
export interface CompanionJevProvider {
  baseURL: string
  /** An empty key uses anonymous access only for OpenCode's official jev-1.13-free endpoint. */
  apiKey: string
  model: string
}

/** Completed, public dialogue text. Provider reasoning and attachment bytes do not belong in this record. */
export interface CompanionMemoryTurn {
  characterId: string
  sessionId: string
  messageId: string
  recordedAt: string
  user: string
  assistant: string
}

export interface CompanionMemoryDocument {
  id: string
  title: string
}

export const companionProviderStorageKeys = ['settings/providers/configured', 'settings/credentials/providers'] as const

/** Serialized provider state travels through IPC and stays encrypted on disk. */
export type CompanionProviderStorage = Partial<Record<typeof companionProviderStorageKeys[number], string | null>>

/** Existing encrypted state takes precedence over migration candidates from renderer storage. */
export const companionInitializeProviderStorage = defineInvokeEventa<CompanionProviderStorage, CompanionProviderStorage>('eventa:invoke:companion:initialize-provider-storage')
export const companionWriteProviderStorage = defineInvokeEventa<void, {
  key: typeof companionProviderStorageKeys[number]
  value: string | null
}>('eventa:invoke:companion:write-provider-storage')

export const companionGetConfig = defineInvokeEventa<CompanionConfig>('eventa:invoke:companion:get-config')
export const companionSaveConfig = defineInvokeEventa<CompanionConfig, {
  memoryEnabled?: boolean
  binaryPath?: string
}>('eventa:invoke:companion:save-config')
export const companionSetJevProvider = defineInvokeEventa<CompanionConfig, CompanionJevProvider | null>('eventa:invoke:companion:set-jev-provider')
export const companionTestProvider = defineInvokeEventa<string, { provider: 'jev' }>('eventa:invoke:companion:test-provider')
export const companionAppendMemory = defineInvokeEventa<void, CompanionMemoryTurn>('eventa:invoke:companion:append-memory')
export const companionSearchMemory = defineInvokeEventa<{ context: string, sourceCount: number }, {
  characterId: string
  query: string
}>('eventa:invoke:companion:search-memory')
export const companionListMemories = defineInvokeEventa<CompanionMemoryDocument[], { characterId: string }>('eventa:invoke:companion:list-memories')
export const companionReadMemory = defineInvokeEventa<string, { characterId: string, id: string }>('eventa:invoke:companion:read-memory')
export const companionWriteMemory = defineInvokeEventa<void, { characterId: string, id: string, content: string }>('eventa:invoke:companion:write-memory')
export const companionRemoveMemory = defineInvokeEventa<void, { characterId: string, id: string }>('eventa:invoke:companion:remove-memory')
export const companionClearMemories = defineInvokeEventa<void, { characterId: string }>('eventa:invoke:companion:clear-memories')
export const companionExportMemories = defineInvokeEventa<string | null, { characterId: string }>('eventa:invoke:companion:export-memories')
