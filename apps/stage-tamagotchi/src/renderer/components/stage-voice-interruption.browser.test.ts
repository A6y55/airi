import type { GenerationProvider } from '@proj-airi/provider-inference'

import en from '@proj-airi/i18n/locales/en'

import { WidgetStage } from '@proj-airi/stage-ui/components/scenes'
import { setupSynced } from '@proj-airi/stage-ui/libs/pinia'
import { useLLM } from '@proj-airi/stage-ui/stores/ai/chat-llm/llm'
import { useChatStore } from '@proj-airi/stage-ui/stores/chat'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useModsServerChannelStore } from '@proj-airi/stage-ui/stores/mods/api/channel-server'
import { useConsciousnessStore } from '@proj-airi/stage-ui/stores/modules/consciousness'
import { useSettings } from '@proj-airi/stage-ui/stores/settings'
import { useSpeechOutputControlStore } from '@proj-airi/stage-ui/stores/speech-output-control'
import { useVoiceStore } from '@proj-airi/stage-ui/stores/voice'
import { createPinia, disposePinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h } from 'vue'
import { createI18n } from 'vue-i18n'

const cleanup: (() => void)[] = []
afterEach(() => {
  cleanup.splice(0).reverse().forEach(dispose => dispose())
  vi.restoreAllMocks()
  localStorage.clear()
})

const provider: GenerationProvider = {
  generation: model => ({ protocol: 'chat-completions', config: { model, baseURL: 'https://example.com/' } }),
}

async function stage() {
  const modules = {
    consciousness: { provider: 'openai', model: 'test-model' },
    vision: { provider: '', model: '' },
    speech: { provider: '', model: '', voice_id: '' },
  }
  localStorage.setItem('airi-cards', JSON.stringify([['default', { name: 'Character', version: '1.0', extensions: { airi: { agents: {}, modules } } }]]))
  localStorage.setItem('airi-card-module-defaults', JSON.stringify(modules))
  const pinia = createPinia()
  const runtime = setupSynced({ leadership: 'leader-only' })
  pinia.use(runtime.pinia)
  const app = createApp({ setup() {
    // Keep the external context channel inside this test. No request reaches the user's desktop server.
    void useModsServerChannelStore().initialize({ connector: () => ({
      connect: async events => ({
        send: () => true,
        close: () => events.close({ code: 1000, reason: 'Test finished', wasClean: true }),
        pong: () => true,
      }),
    }) })
    useSettings().stageModelRenderer = 'disabled'
    useSpeechOutputControlStore().speechMuted = true
    return () => h(WidgetStage)
  } }).use(runtime.vue).use(pinia).use(createI18n({ legacy: false, locale: 'en', messages: { en } }))
  app.mount(document.createElement('div'))
  const chat = useChatStore(pinia)
  cleanup.push(() => {
    useModsServerChannelStore(pinia).dispose()
    chat.dispose()
    app.unmount()
    disposePinia(pinia)
  })
  const sessions = useChatSessionStore(pinia)
  await sessions.initialize()
  await sessions.createSession('default')
  vi.spyOn(useConsciousnessStore(pinia), 'getChatProviderInstance').mockResolvedValue(provider)
  return { pinia, chat, sessions, voice: useVoiceStore(pinia), sessionId: sessions.activeSessionId }
}

// ROOT CAUSE:
// Stage exposed speech before asynchronous prompt hooks finished and before the user message persisted.
// A following input cancelled that response and discarded the first input. Speech now starts after persistence.
it('preserves consecutive spoken messages during prompt preparation and isolates old cancellation from the new reply', async () => {
  const { pinia, chat, sessions, voice, sessionId } = await stage()
  const memory = Promise.withResolvers<void>()
  const composing = Promise.withResolvers<void>()
  const nextReply = Promise.withResolvers<void>()
  const nextStarted = Promise.withResolvers<AbortSignal>()
  let requests = 0
  vi.spyOn(useLLM(pinia), 'stream').mockImplementation(async (_model, _provider, _context, options) => {
    const signal = options?.abortSignal
    if (!signal)
      throw new Error('Missing chat cancellation signal')
    requests++
    if (requests === 1) {
      await options?.onStreamEvent?.({ type: 'text-delta', text: 'The earlier answer is still speaking.' })
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      return
    }
    if (requests === 3) {
      nextStarted.resolve(signal)
      await nextReply.promise
    }
    await options?.onStreamEvent?.({ type: 'text-delta', text: requests === 2 ? 'First answer.' : 'Second answer.' })
    await options?.onStreamEvent?.({ type: 'finish' })
  })
  cleanup.push(chat.onBeforeMessageComposed(async (_message, context) => {
    if (context.turnId !== 'first-input')
      return
    composing.resolve()
    await memory.promise
    context.systemPromptSupplement = 'Retrieved context.'
  }))

  const oldTurn = { sessionId, turnId: 'old-answer' }
  const old = chat.ingest('Earlier question.', { model: 'test-model', chatProvider: provider, messageId: oldTurn.turnId, stickers: [] }, sessionId)
  await expect.poll(() => requests).toBe(1)
  const interrupted = [...voice.activeTurns]
  expect(interrupted).toContainEqual(oldTurn)
  await voice.interrupt(interrupted, 'speech-input').done
  await old

  const first = chat.submit({ sessionId, messageId: 'first-input', text: 'You can now.' })
  void first.catch(() => {})
  await composing.promise
  const nextInputTargets = [...voice.activeTurns]
  const second = chat.submit({ sessionId, messageId: 'second-input', text: 'The screen is shared now.' })
  void second.catch(() => {})
  try {
    await voice.interrupt(nextInputTargets, 'speech-input').done
    memory.resolve()
    await expect(first).resolves.toEqual({ sessionId, messageId: 'first-input' })
    await expect(second).resolves.toEqual({ sessionId, messageId: 'second-input' })
    const nextSignal = await nextStarted.promise
    await voice.interrupt(interrupted, 'speech-input').done
    await voice.interrupt(interrupted, 'speech-input').done
    expect(nextSignal.aborted).toBe(false)
    nextReply.resolve()
    await expect.poll(() => sessions.getSessionMessages(sessionId).filter(message => message.role === 'assistant' && !message.interrupted).map(message => message.content)).toEqual(['First answer.', 'Second answer.'])
    expect(sessions.getSessionMessages(sessionId).filter(message => message.role === 'user')).toMatchObject([
      { content: 'Earlier question.' },
      { id: 'first-input', content: 'You can now.' },
      { id: 'second-input', content: 'The screen is shared now.' },
    ])
    expect(voice.error).toBeUndefined()
  }
  finally {
    memory.resolve()
    nextReply.resolve()
    await chat.cancelPendingSends(sessionId)
    await Promise.allSettled([first, second])
  }
})
