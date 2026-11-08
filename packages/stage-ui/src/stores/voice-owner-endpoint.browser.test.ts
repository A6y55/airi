import type { SpeechInputAttempt, StreamingTranscriber } from '@proj-airi/core-agent'
import type { PcmBlock } from '@proj-airi/pipelines-audio'
import type { SpeakerTracker } from '@sherpaw/speaker-diarization'

import { AudioInput } from '@proj-airi/pipelines-audio'
import { createPinia, disposePinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import { createI18n } from 'vue-i18n'

import { useChatStore } from './chat'
import { useHearingStore } from './modules/hearing'
import { useSettingsAudioDevice } from './settings/audio-device'
import { useVoiceStore } from './voice'
import { useVoiceprintStore } from './voiceprint'

// Model boundaries supply scores. Capture, input rules, filtering, and submission use the real stores.
const detection = vi.hoisted(() => ({ score: 0.9 }))
vi.mock('../workers/vad/silero-vad', () => ({ SileroVad: class {
  async score() { return detection.score }
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
  model.similarity.mockImplementation(async samples => new Float32Array([samples[0]]))
  detection.score = 0.9
  localStorage.clear()
})

async function host(cause: 'wake-word' | 'control' = 'wake-word', firstValue = 0.8) {
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
  hearing.inputMode = 'wake-word'
  hearing.speakerRecognitionEnabled = true
  hearing.endJudgeEnabled = false
  hearing.rephraseEnabled = false
  hearing.autoSendEnabled = true
  useVoiceprintStore(pinia).save({ embedding: new Float32Array([1, 0]), seconds: 8 }, Date.now() + 1)
  const recordings: PcmBlock[][] = []
  const transcribe = vi.fn<StreamingTranscriber['transcribe']>(request => new ReadableStream({ async start(output) {
    const blocks: PcmBlock[] = []
    recordings.push(blocks)
    try {
      for await (const block of request.audio)
        blocks.push(block)
      request.signal.throwIfAborted()
      output.enqueue({ type: 'update', revision: 1, segments: [{ id: 'speech', revision: 1, text: 'Owner request.', tokens: [], final: true }] })
      output.enqueue({ type: 'complete', revision: 1 })
      output.close()
    }
    catch (error) {
      output.error(error)
    }
  } }))
  vi.spyOn(hearing, 'createTranscriber').mockReturnValue({ transcribe })
  const submit = vi.spyOn(useChatStore(pinia), 'submit').mockResolvedValue({ sessionId: 'owner', messageId: 'accepted' })
  expect(await devices.askPermission()).toBe(true)
  await expect.poll(() => devices.selectedAudioInput).not.toBe('')
  devices.input = new AudioInput({ live: true, open: () => new ReadableStream({ start(output) {
    source = output
  } }) }, { historyMs: 360 })
  let woke = false
  voice.startListening({
    acceptSpeech: async () => true,
    detectWakeWord: async () => {
      if (cause === 'control' || woke)
        return undefined
      woke = true
      return { sessionId: 'owner', interruptTurns: [] }
    },
  })
  let frame = 0
  function push(value: number, frames = 16000) {
    source.enqueue({ range: { sourceId: 'mic', startFrame: frame, endFrame: frame + frames }, sampleRate: 16000, channels: [new Float32Array(frames).fill(value)] })
    frame += frames
  }
  await expect.poll(() => !!source).toBe(true)
  let input: SpeechInputAttempt
  if (cause === 'control') {
    input = voice.beginManual('owner')!
  }
  else {
    push(0.1, 512)
    await expect.poll(() => voice.state?.phase).toBe('pending')
    input = voice.controller.activeInput!
  }
  push(firstValue)
  await expect.poll(() => input.state.phase).toBe('capturing')
  if (firstValue >= 0.35)
    await expect.poll(() => recordings[0]?.length).toBe(1)
  return { voice, hearing, push, input, recordings, transcribe, submit }
}

// Raw VAD kept a real input capturing for 901 seconds. Only verified owner activity can extend its speaker silence limit.
it.each([false, true])('seals and submits when the owner stops despite continuous raw VAD speech, end judge=%s', async (judge) => {
  const { hearing, push, input, recordings, submit } = await host()
  hearing.endJudgeEnabled = judge
  const rejectedWindows = judge ? 5 : 2
  for (let index = 1; index < rejectedWindows; index++) {
    push(0.1)
    await expect.poll(() => recordings[0].length).toBe(index + 1)
    expect(input.state.phase).toBe('capturing')
  }
  push(0.1)
  await expect(input.done).resolves.toEqual({ status: 'committed', messageId: 'accepted' })
  expect(submit).toHaveBeenCalledOnce()
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'owner', text: 'Owner request.' }))
  expect(recordings[0][0].channels[0]).toEqual(new Float32Array(16000).fill(0.8))
  expect(recordings[0].slice(1).map(block => block.channels[0])).toEqual(Array.from({ length: rejectedWindows }, () => new Float32Array(16000)))
})

it('resets the silence interval when the owner resumes', async () => {
  const { push, input, recordings } = await host()
  for (const value of [0.1, 0.8, 0.1]) {
    const nextLength = recordings[0].length + 1
    push(value)
    await expect.poll(() => recordings[0].length).toBe(nextLength)
    expect(input.state.phase).toBe('capturing')
  }
  push(0.1)
  await expect(input.done).resolves.toMatchObject({ status: 'committed' })
  expect(recordings[0].map(block => block.channels[0][0])).toEqual([Math.fround(0.8), 0, Math.fround(0.8), 0, 0])
})

it('never submits a non-owner recording when VAD eventually ends it', async () => {
  const { push, input, transcribe, submit, voice } = await host('wake-word', 0.1)
  push(0.1, 32000)
  expect(input.state.phase).toBe('capturing')
  detection.score = 0
  push(0, 24064)
  await expect(input.done).resolves.toMatchObject({ status: 'cancelled' })
  expect(transcribe).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
  expect(voice.drafts).toEqual([])
})

it('keeps manual input open until its explicit stop', async () => {
  const { voice, push, input, recordings, submit } = await host('control')
  push(0.1, 48000)
  await expect.poll(() => recordings[0].length).toBe(4)
  expect(input.state.phase).toBe('capturing')
  expect(submit).not.toHaveBeenCalled()
  await expect(voice.endInput()).resolves.toEqual({ status: 'committed', messageId: 'accepted' })
})

it('ignores a cancelled input comparison and starts the next silence interval from zero', async () => {
  const { voice, push, input, recordings, submit } = await host()
  push(0.1)
  await expect.poll(() => recordings[0].length).toBe(2)
  const pending = Promise.withResolvers<Float32Array<ArrayBuffer>>()
  model.similarity.mockImplementation(async samples => samples.every(value => value === 0.125) ? pending.promise : new Float32Array([samples[0]]))
  push(0.125)
  await expect.poll(() => model.similarity.mock.calls.some(([samples]) => samples.every(value => value === 0.125))).toBe(true)
  input.cancel('Replaced recording')
  await expect(input.done).resolves.toMatchObject({ status: 'cancelled' })
  const next = voice.beginInput({ sessionId: 'owner', cause: 'speech', start: { kind: 'after-silence' }, interruptTurns: [] })
  push(0.8)
  await expect.poll(() => recordings[1]?.length).toBe(1)
  pending.resolve(new Float32Array([0.1]))
  push(0.1)
  await expect.poll(() => recordings[1].length).toBe(2)
  expect(next.state.phase).toBe('capturing')
  expect(submit).not.toHaveBeenCalled()
  push(0.1)
  await expect(next.done).resolves.toEqual({ status: 'committed', messageId: 'accepted' })
  expect(submit).toHaveBeenCalledOnce()
})
