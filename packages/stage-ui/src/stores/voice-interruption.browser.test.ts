import type { StreamingTranscriber, TranscriptionEvent } from '@proj-airi/core-agent'
import type { PcmBlock } from '@proj-airi/pipelines-audio'
import type { SpeakerTracker } from '@sherpaw/speaker-diarization'

import { AudioInput, Playback } from '@proj-airi/pipelines-audio'
import { createPinia, disposePinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import { createI18n } from 'vue-i18n'

import { useChatStore } from './chat'
import { useHearingStore } from './modules/hearing'
import { useSettingsAudioDevice } from './settings/audio-device'
import { useVoiceStore } from './voice'
import { useVoiceprintStore } from './voiceprint'

// Model boundaries return a score encoded by the test audio. Capture, rules, playback, and stores are real.
vi.mock('../workers/vad/silero-vad', () => ({ SileroVad: class {
  async score() { return 0.9 }
  async close() {}
} }))
const model = vi.hoisted(() => ({
  segmentation: false,
  similarity: vi.fn(async (samples: Float32Array) => new Float32Array([samples[0]])),
  reset: async () => {},
  enrollVoiceprint: async () => 0,
  dispose: () => {},
  track: vi.fn(),
  peek: vi.fn(),
  enroll: vi.fn(),
  voiceprint: vi.fn(),
  inspect: vi.fn(),
  speech: vi.fn(),
} satisfies SpeakerTracker))
vi.mock('../libs/voice/speaker-model', () => ({ loadSpeakerTracker: async () => model }))
const cleanup: (() => void)[] = []
afterEach(() => {
  cleanup.splice(0).reverse().forEach(dispose => dispose())
  vi.restoreAllMocks()
  vi.clearAllMocks()
  localStorage.clear()
})

async function host(recognitionEnabled: boolean, enrolled = true, initialResponse = true) {
  const pinia = createPinia()
  let voice!: ReturnType<typeof useVoiceStore>
  let devices!: ReturnType<typeof useSettingsAudioDevice>
  let source!: ReadableStreamDefaultController<PcmBlock>
  const app = createApp({ setup() {
    devices = useSettingsAudioDevice()
    voice = useVoiceStore()
    return () => null
  } }).use(pinia).use(createI18n({ legacy: false, locale: 'en', messages: { en: {} }, missingWarn: false, fallbackWarn: false }))
  app.mount(document.createElement('div'))
  cleanup.push(() => {
    app.unmount()
    disposePinia(pinia)
  })
  const hearing = useHearingStore(pinia)
  hearing.speakerRecognitionEnabled = recognitionEnabled
  hearing.endJudgeEnabled = false
  hearing.rephraseEnabled = false
  if (enrolled)
    useVoiceprintStore(pinia).save({ embedding: new Float32Array([1, 0]), seconds: 8 }, Date.now() + 1)
  const transcribe = vi.fn<StreamingTranscriber['transcribe']>(() => new ReadableStream())
  vi.spyOn(hearing, 'createTranscriber').mockReturnValue({ transcribe })
  const record = vi.spyOn(useChatStore(pinia), 'receiveInterruption').mockResolvedValue({ status: 'acknowledged' })
  const stopped = vi.fn(async () => ({ throughMs: 100 }))
  const played = vi.fn(() => ({ done: new Promise<{ throughMs: number }>(() => {}), stop: stopped }))
  let synthesisSignal: AbortSignal | undefined
  cleanup.push(voice.connectOutput(() => ({
    playback: new Playback({ nowMs: () => 0, play: played }),
    stream: async (_text, signal) => {
      synthesisSignal = signal
      return new ReadableStream({ start(output) {
        output.enqueue({ audio: new Blob(['speech']), text: 'The pet is speaking.' })
      } })
    },
  })))
  const turn = { sessionId: 'owner', turnId: 'speaking' }
  if (initialResponse) {
    voice.startResponse(turn)
    await voice.getSpeech(turn)!.write('The pet is speaking.')
    await expect.poll(() => played.mock.calls.length).toBe(1)
  }
  // Device discovery replaces the shared input. Install the fixture only after that transition settles.
  expect(await devices.askPermission()).toBe(true)
  await expect.poll(() => devices.selectedAudioInput).not.toBe('')
  devices.input = new AudioInput({ live: true, open: () => new ReadableStream({ start(output) {
    source = output
  } }) }, { historyMs: 360 })
  let woke = false
  voice.startListening({
    acceptSpeech: async () => true,
    detectWakeWord: async () => {
      if (woke)
        return undefined
      woke = true
      // An external wake detector cannot authorize playback interruption itself.
      return { sessionId: turn.sessionId, interruptTurns: [turn] }
    },
  })
  let frame = 0
  function push(value: number, frames: number) {
    source.enqueue({ range: { sourceId: 'mic', startFrame: frame, endFrame: frame + frames }, sampleRate: 16000, channels: [new Float32Array(frames).fill(value)] })
    frame += frames
  }
  await expect.poll(() => !!source).toBe(true)
  push(0.1, 512)
  await expect.poll(() => voice.state?.phase).toBe('pending')
  push(0.1, 512)
  await expect.poll(() => voice.state?.phase).toBe('capturing')
  if (enrolled)
    push(0.1, 15488)
  return { voice, hearing, push, stopped, record, transcribe, turn, synthesisSignal }
}

it.each([true, false])('requires the owner before an external wake can interrupt, recognition setting=%s', async (enabled) => {
  const { voice, push, stopped, record, transcribe, turn, synthesisSignal } = await host(enabled)
  push(0.15, 32000)
  await expect.poll(() => model.similarity.mock.calls.length).toBeGreaterThanOrEqual(2)
  expect(stopped).not.toHaveBeenCalled()
  expect(record).not.toHaveBeenCalled()
  expect(transcribe).not.toHaveBeenCalled()
  expect(voice.activeTurns).toEqual([turn])
  expect(synthesisSignal?.aborted).toBe(false)

  push(0.8, 8000)
  await expect.poll(() => stopped.mock.calls.length).toBe(1)
  expect(synthesisSignal?.aborted).toBe(true)
  expect(voice.state?.phase).toBe('capturing')
  await expect.poll(() => transcribe.mock.calls.length).toBe(1)
  expect(record).toHaveBeenCalledWith(expect.objectContaining({ turn, cause: 'speech-input' }))
})

it('keeps playback when no owner voiceprint is available', async () => {
  const { voice, push, stopped, transcribe, turn } = await host(false, false)
  push(0.9, 32000)
  await expect.poll(() => voice.state?.phase).toBe('settled')
  expect(stopped).not.toHaveBeenCalled()
  expect(transcribe).not.toHaveBeenCalled()
  expect(voice.activeTurns).toEqual([turn])
})

it.each([true, false])('retains verified speech when a response starts during verification, captured response=%s', async (initialResponse) => {
  const { voice, hearing, push, stopped, transcribe } = await host(true, true, initialResponse)
  hearing.autoSendEnabled = false
  transcribe.mockImplementation(request => new ReadableStream<TranscriptionEvent>({ async start(output) {
    await request.audio.pipeTo(new WritableStream())
    output.enqueue({ type: 'update', revision: 1, segments: [{ id: 'owner', revision: 1, text: 'The screen is shared now.', tokens: [], final: true }] })
    output.enqueue({ type: 'complete', revision: 1 })
    output.close()
  } }))
  const input = voice.controller.activeInput!
  const newer = { sessionId: 'owner', turnId: 'newer' }
  voice.startResponse(newer)
  push(0.8, 32000)
  await expect.poll(() => transcribe.mock.calls.length).toBe(1)
  expect(stopped).toHaveBeenCalledTimes(initialResponse ? 1 : 0)
  expect(voice.activeTurns).toEqual([newer])
  expect(await input.end()).toEqual({ status: 'drafted', draftId: input.id })
  expect(voice.drafts).toContainEqual(expect.objectContaining({ id: input.id, text: 'The screen is shared now.' }))
  expect(voice.activeTurns).toEqual([newer])
})

it.each(['cancelled', 'rejected', 'provider-failed'] as const)('accepts the next input after an input is %s', async (failure) => {
  const { voice, hearing, push, transcribe } = await host(true, true, false)
  hearing.autoSendEnabled = false
  const first = voice.controller.activeInput!
  if (failure === 'cancelled') {
    first.cancel('Owner cancelled the input')
  }
  else if (failure === 'rejected') {
    void first.end()
  }
  else {
    transcribe.mockImplementationOnce(() => new ReadableStream({ start(output) {
      output.error(new Error('Remote sent 429 response: conn limit (1041)'))
    } }))
    push(0.8, 32000)
  }
  expect(await first.done).toMatchObject(failure === 'provider-failed'
    ? { status: 'failed', stage: 'transcription', error: expect.objectContaining({ message: 'Remote sent 429 response: conn limit (1041)' }) }
    : { status: 'cancelled' })
  expect(voice.drafts).toEqual([])

  transcribe.mockImplementation(request => new ReadableStream<TranscriptionEvent>({ async start(output) {
    await request.audio.pipeTo(new WritableStream())
    output.enqueue({ type: 'update', revision: 1, segments: [{ id: 'owner', revision: 1, text: 'Please continue.', tokens: [], final: true }] })
    output.enqueue({ type: 'complete', revision: 1 })
    output.close()
  } }))
  const next = voice.beginInput({ sessionId: 'owner', cause: 'speech', interruptTurns: [], start: { kind: 'after-silence' } })
  push(0.8, 16000)
  await expect.poll(() => next.state.phase).toBe('capturing')
  expect(await next.end()).toEqual({ status: 'drafted', draftId: next.id })
  expect(voice.drafts).toEqual([expect.objectContaining({ id: next.id, text: 'Please continue.' })])
  expect(voice.error).toBeUndefined()
})
