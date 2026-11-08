import type { CompanionConfig } from '../../../shared/eventa/companion'

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { env } from 'node:process'

import { defineInvokeHandler } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/main'
import { errorMessageFrom } from '@moeru/std'
import { app, dialog, ipcMain } from 'electron'
import { boolean, maxLength, minLength, nullable, object, optional, parse, picklist, pipe, string } from 'valibot'

import {
  companionAppendMemory,
  companionClearMemories,
  companionExportMemories,
  companionGetConfig,
  companionInitializeProviderStorage,
  companionListMemories,
  companionReadMemory,
  companionRemoveMemory,
  companionSaveConfig,
  companionSearchMemory,
  companionSetJevProvider,
  companionTestProvider,
  companionWriteMemory,
  companionWriteProviderStorage,
} from '../../../shared/eventa/companion'
import { onAppBeforeQuit } from '../../libs/bootkit/lifecycle'
import { createCompanionGateway } from './companion-gateway'
import { setupMinimaxSpeech } from './minimax-speech'
import { SagMemory } from './sag-memory'

const identity = pipe(string(), minLength(1), maxLength(512))
const characterSchema = object({ characterId: identity })
const documentSchema = object({ characterId: identity, id: identity })
const settingsSchema = object({
  binaryPath: pipe(string(), minLength(1), maxLength(4096)),
  memoryEnabled: boolean(),
})

/** Registers the local companion settings and the SAG adapter before any renderer loads. */
export function setupCompanion() {
  const { context } = createContext(ipcMain)
  const root = join(app.getPath('userData'), 'companion')
  const archivePath = join(root, 'memories')
  const configPath = join(root, 'settings.json')
  let settings = {
    binaryPath: env.AIRI_SAG_BINARY?.trim() || join(homedir(), '.local', 'bin', 'sag'),
    memoryEnabled: true,
  }
  let memory: SagMemory
  let sagVersion = ''
  let sagError = ''
  let jevModel = 'jev-1.13-free'
  let configuring: Promise<void> = Promise.resolve()

  const gatewayReady = (async () => {
    await mkdir(root, { recursive: true, mode: 0o700 })
    try {
      settings = parse(settingsSchema, JSON.parse(await readFile(configPath, 'utf8')))
    }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT')
        throw error
    }
    return createCompanionGateway({ dataPath: root })
  })()
  const stopMinimaxSpeech = setupMinimaxSpeech(gatewayReady)

  async function configureMemory() {
    const gateway = await gatewayReady
    await memory?.close()
    memory = new SagMemory({
      binaryPath: settings.binaryPath,
      dataPath: join(root, 'sag'),
      archivePath,
      jevURL: `${gateway.baseURL}/jev/v1/systemone`,
      model: jevModel,
      token: gateway.token,
    })
    sagVersion = ''
    sagError = ''
    try {
      sagVersion = await memory.configure()
    }
    catch (error) {
      sagError = errorMessageFrom(error) ?? 'SAG could not start.'
    }
  }

  configuring = configureMemory()

  async function status(): Promise<CompanionConfig> {
    const gateway = await gatewayReady
    await configuring
    return {
      baseURL: gateway.baseURL,
      token: gateway.token,
      ...gateway.status(),
      ...settings,
      archivePath,
      sagVersion,
      sagError,
    }
  }

  defineInvokeHandler(context, companionGetConfig, status)
  defineInvokeHandler(context, companionInitializeProviderStorage, async input => (await gatewayReady).initializeProviderStorage(input))
  defineInvokeHandler(context, companionWriteProviderStorage, async input => (await gatewayReady).writeProviderStorage(input))
  defineInvokeHandler(context, companionSaveConfig, async (input) => {
    const values = parse(object({
      memoryEnabled: optional(boolean()),
      binaryPath: optional(pipe(string(), minLength(1), maxLength(4096))),
    }), input)
    await configuring
    const next = { binaryPath: values.binaryPath ?? settings.binaryPath, memoryEnabled: values.memoryEnabled ?? settings.memoryEnabled }
    await writeFile(`${configPath}.tmp`, JSON.stringify(next), { mode: 0o600 })
    await rename(`${configPath}.tmp`, configPath)
    settings = next
    configuring = configureMemory()
    return status()
  })

  defineInvokeHandler(context, companionSetJevProvider, async (input) => {
    const provider = parse(nullable(object({
      baseURL: pipe(string(), minLength(1), maxLength(4096)),
      apiKey: pipe(string(), maxLength(16384)),
      model: pipe(string(), minLength(1), maxLength(512)),
    })), input)
    const gateway = await gatewayReady
    await configuring
    gateway.setJevProvider(provider)
    if (provider && provider.model !== jevModel) {
      jevModel = provider.model
      configuring = configureMemory()
    }
    return status()
  })

  defineInvokeHandler(context, companionTestProvider, async (input) => {
    const { provider } = parse(object({ provider: picklist(['jev']) }), input)
    const gateway = await gatewayReady
    const response = await fetch(`${gateway.baseURL}/jev/v1/systemone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${gateway.token}` },
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({ model: jevModel, state: 'Connection test', questions: { test: { type: 'noul', instructions: { question: 'Is this a connection test?' }, criteria: { true: 'It is a connection test.', false: 'It is not a connection test.' } } } }),
    })
    if (!response.ok) {
      const failure: unknown = await response.json().catch(() => undefined)
      if (failure && typeof failure === 'object' && 'error' in failure && failure.error && typeof failure.error === 'object'
        && 'message' in failure.error && typeof failure.error.message === 'string') {
        throw new Error(failure.error.message)
      }
      throw new Error(`${provider}: HTTP ${response.status}`)
    }
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json'))
      throw new Error(`${provider}: The endpoint did not return JSON.`)
    const data: unknown = await response.json()
    if (!data || typeof data !== 'object' || !('answers' in data) || !data.answers || typeof data.answers !== 'object' || !('test' in data.answers))
      throw new Error('Jev did not return a decision.')
    const answer = data.answers.test
    if (!answer || typeof answer !== 'object' || !('type' in answer) || answer.type !== 'noul'
      || !('noul' in answer) || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
      throw new Error('Jev did not return a valid noul score.')
    }
    return 'OK'
  })

  defineInvokeHandler(context, companionAppendMemory, async (input) => {
    const turn = parse(object({
      characterId: identity,
      sessionId: identity,
      messageId: identity,
      recordedAt: pipe(string(), maxLength(64)),
      user: pipe(string(), maxLength(200000)),
      assistant: pipe(string(), maxLength(200000)),
    }), input)
    await configuring
    if (settings.memoryEnabled)
      await memory.append(turn)
  })
  defineInvokeHandler(context, companionSearchMemory, async (input) => {
    const query = parse(object({ characterId: identity, query: pipe(string(), minLength(1), maxLength(2000)) }), input)
    await configuring
    if (!settings.memoryEnabled)
      return { context: '', sourceCount: 0 }
    if (!(await gatewayReady).status().jevConfigured)
      throw new Error('Select a configured Jev provider in AIRI settings.')
    if (sagError)
      throw new Error(sagError)
    return memory.search(query)
  })
  defineInvokeHandler(context, companionListMemories, async (input) => {
    await configuring
    return memory.list(parse(characterSchema, input).characterId)
  })
  defineInvokeHandler(context, companionReadMemory, async (input) => {
    const { characterId, id } = parse(documentSchema, input)
    await configuring
    return memory.read(characterId, id)
  })
  defineInvokeHandler(context, companionWriteMemory, async (input) => {
    const { characterId, id, content } = parse(object({ characterId: identity, id: identity, content: pipe(string(), maxLength(500000)) }), input)
    await configuring
    await memory.write(characterId, id, content)
  })
  defineInvokeHandler(context, companionRemoveMemory, async (input) => {
    const { characterId, id } = parse(documentSchema, input)
    await configuring
    await memory.remove(characterId, id)
  })
  defineInvokeHandler(context, companionClearMemories, async (input) => {
    await configuring
    await memory.clear(parse(characterSchema, input).characterId)
  })
  defineInvokeHandler(context, companionExportMemories, async (input) => {
    const { characterId } = parse(characterSchema, input)
    await configuring
    const destination = await dialog.showSaveDialog({ defaultPath: 'airi-memories.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (destination.canceled || !destination.filePath)
      return null
    const documents = await memory.list(characterId)
    const exported = await Promise.all(documents.map(async document => ({ ...document, content: await memory.read(characterId, document.id) })))
    await writeFile(destination.filePath, JSON.stringify({ characterId, documents: exported }, null, 2), { mode: 0o600 })
    return destination.filePath
  })

  onAppBeforeQuit(async () => {
    stopMinimaxSpeech()
    await configuring.catch(() => undefined)
    await memory?.close()
    await (await gatewayReady).close()
  })

  return configuring
}
