import type { StreamingTranscriber } from '@proj-airi/core-agent'
import type { PcmBlock } from '@proj-airi/pipelines-audio'
import type { SpeakerMap, SpeakerTracker, SpeakerTurn } from '@sherpaw/speaker-diarization'

import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useSpeakerTrackerStore } from './speaker-tracker'
import { useVoiceprintStore } from './voiceprint'

/** A tracker Worker that scores every comparison 0.42. Calls that the store must not make reject. */
const tracker = vi.hoisted(() => {
  const unused = () => Promise.reject(new Error('The store must not call this'))
  return {
    segmentation: false,
    track: vi.fn(async (): Promise<SpeakerTurn> => ({ index: 0, speaker: null, score: 0, confidence: 'low', pending: true, mixed: false, overlap: false, revisions: [] })),
    peek: unused,
    enroll: unused,
    voiceprint: unused,
    inspect: vi.fn(async (): Promise<SpeakerMap> => ({ units: [{ index: 0, seconds: 1.5, speaker: null, embedding: new Float32Array([0, 1]) }], speakers: [] })),
    speech: unused,
    similarity: vi.fn(async (_samples: Float32Array, _sampleRate: number, _speaker: number) => new Float32Array([0.42])),
    reset: vi.fn(async () => {}),
    enrollVoiceprint: vi.fn(async () => 0),
    dispose: vi.fn(),
  }
})

// The real loader downloads the 28 MB CAM++ pack and starts a WebAssembly Worker. The test replaces that model boundary.
const loadSpeakerTracker = vi.hoisted(() => vi.fn(async (): Promise<SpeakerTracker> => tracker satisfies SpeakerTracker))
vi.mock('../libs/voice/speaker-model', () => ({ loadSpeakerTracker }))

afterEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  tracker.similarity.mockImplementation(async () => new Float32Array([0.42]))
})

/** A 16 kHz mono window. */
function audioWindow(channel: Float32Array) {
  return { sampleRate: 16000, channels: [channel] }
}

function createStores() {
  const pinia = createPinia()
  setActivePinia(pinia)
  return { trackers: useSpeakerTrackerStore(), voiceprints: useVoiceprintStore(), dispose: () => disposePinia(pinia) }
}

describe('speaker tracker store', () => {
  it('compares the window with the owner as one window', async () => {
    const { trackers, voiceprints, dispose } = createStores()
    voiceprints.save({ embedding: new Float32Array([1, 0]), seconds: 8 }, Date.now() + 1)
    await trackers.acquire()

    expect(await trackers.compareOwner(audioWindow(new Float32Array(16000)))).toBeCloseTo(0.42)

    expect(tracker.similarity).toHaveBeenCalledWith(new Float32Array(16000), 16000, 0, { windowSeconds: 1, stepSeconds: 1 })
    dispose()
  })

  it('clamps the samples, because the tracker rejects samples outside [-1, 1]', async () => {
    const { trackers, voiceprints, dispose } = createStores()
    voiceprints.save({ embedding: new Float32Array([1, 0]), seconds: 8 }, Date.now() + 1)
    await trackers.acquire()
    const channel = new Float32Array(16000)
    channel.set([1.5, -1.5, Number.NaN, 0.25])

    await trackers.compareOwner(audioWindow(channel))

    expect(tracker.similarity.mock.calls[0]![0].slice(0, 4)).toEqual(new Float32Array([1, -1, 0, 0.25]))
    dispose()
  })

  it('returns NaN for a comparison that a release ends', async () => {
    const { trackers, voiceprints, dispose } = createStores()
    voiceprints.save({ embedding: new Float32Array([1, 0]), seconds: 8 }, Date.now() + 1)
    await trackers.acquire()
    const comparing = Promise.withResolvers<Float32Array<ArrayBuffer>>()
    tracker.similarity.mockImplementationOnce(async () => comparing.promise)

    const result = trackers.compareOwner(audioWindow(new Float32Array(16000)))
    await vi.waitFor(() => expect(tracker.similarity).toHaveBeenCalledOnce())
    trackers.release()
    // Sherpaw rejects the calls that still run when the tracker is disposed.
    comparing.reject(new Error('Speaker tracker has been disposed'))

    expect(await result).toBeNaN()
    dispose()
  })

  it('rejects a comparison that fails without a release', async () => {
    const { trackers, voiceprints, dispose } = createStores()
    voiceprints.save({ embedding: new Float32Array([1, 0]), seconds: 8 }, Date.now() + 1)
    await trackers.acquire()
    tracker.similarity.mockRejectedValueOnce(new Error('Speaker 0 has no voice to compare with yet'))

    await expect(trackers.compareOwner(audioWindow(new Float32Array(16000)))).rejects.toThrow('Speaker 0 has no voice to compare with yet')
    dispose()
  })

  it('returns NaN without loading a tracker that is not ready', async () => {
    const { trackers, dispose } = createStores()

    expect(await trackers.compareOwner(audioWindow(new Float32Array(16000)))).toBeNaN()

    expect(loadSpeakerTracker).not.toHaveBeenCalled()
    expect(trackers.preparation).toBe('idle')
    dispose()
  })

  it('does not load a released tracker again', async () => {
    const { trackers, dispose } = createStores()
    await trackers.acquire()
    trackers.release()

    expect(await trackers.compareOwner(audioWindow(new Float32Array(16000)))).toBeNaN()

    expect(loadSpeakerTracker).toHaveBeenCalledOnce()
    expect(trackers.preparation).toBe('idle')
    dispose()
  })

  it.each([0.1, Number.NaN])('does not open the transcription provider for a rejected score %s', async (score) => {
    const { trackers, voiceprints, dispose } = createStores()
    voiceprints.save({ embedding: new Float32Array([1, 0]), seconds: 8 }, Date.now() + 1)
    tracker.similarity.mockResolvedValueOnce(new Float32Array([score]))
    const provider = { transcribe: vi.fn<StreamingTranscriber['transcribe']>() }
    const onMatch = vi.fn(async () => {})
    const onReject = vi.fn()
    const audio = new ReadableStream<PcmBlock>({ start(output) {
      output.enqueue({ range: { sourceId: 'mic', startFrame: 0, endFrame: 16000 }, sampleRate: 16000, channels: [new Float32Array(16000).fill(0.2)] })
      output.close()
    } })
    const events = []
    for await (const event of trackers.filterTranscriber(provider, onMatch, onReject).transcribe({ audio, signal: new AbortController().signal }))
      events.push(event)
    expect(provider.transcribe).not.toHaveBeenCalled()
    expect(onMatch).not.toHaveBeenCalled()
    expect(onReject).toHaveBeenCalledOnce()
    expect(events).toEqual([{ type: 'complete', revision: 0 }])
    expect(trackers.preparation).toBe('idle')
    dispose()
  })

  it('blocks transcription when the saved voiceprint is missing', async () => {
    const { trackers, dispose } = createStores()
    const provider = { transcribe: vi.fn<StreamingTranscriber['transcribe']>() }
    const audio = new ReadableStream<PcmBlock>({ start(output) {
      output.enqueue({ range: { sourceId: 'mic', startFrame: 0, endFrame: 8000 }, sampleRate: 16000, channels: [new Float32Array(8000).fill(0.2)] })
      output.close()
    } })
    await expect(trackers.filterTranscriber(provider).transcribe({ audio, signal: new AbortController().signal }).pipeTo(new WritableStream())).rejects.toThrow('Voiceprint is missing')
    expect(provider.transcribe).not.toHaveBeenCalled()
    expect(loadSpeakerTracker).not.toHaveBeenCalled()
    dispose()
  })

  it('keeps the model alive for a recording after continuous listening releases it', async () => {
    const { trackers, voiceprints, dispose } = createStores()
    voiceprints.save({ embedding: new Float32Array([1, 0]), seconds: 8 }, Date.now() + 1)
    await trackers.acquire()
    let source!: ReadableStreamDefaultController<PcmBlock>
    const audio = new ReadableStream<PcmBlock>({ start(output) {
      source = output
    } })
    source.enqueue({ range: { sourceId: 'mic', startFrame: 0, endFrame: 16000 }, sampleRate: 16000, channels: [new Float32Array(16000).fill(0.2)] })
    const filtered = await trackers.prepare(audio, new AbortController().signal)
    trackers.release()
    expect(trackers.preparation).toBe('ready')
    expect(tracker.dispose).not.toHaveBeenCalled()
    source.close()
    await filtered!.pipeTo(new WritableStream())
    expect(trackers.preparation).toBe('idle')
    expect(tracker.dispose).toHaveBeenCalledOnce()
    dispose()
  })

  it('waits for a voice match before interruption and transcription', async () => {
    const { trackers, voiceprints, dispose } = createStores()
    voiceprints.save({ embedding: new Float32Array([1, 0]), seconds: 8 }, Date.now() + 1)
    const score = Promise.withResolvers<Float32Array<ArrayBuffer>>()
    tracker.similarity.mockReturnValueOnce(score.promise)
    const onMatch = vi.fn(async () => {})
    const onReject = vi.fn()
    let frames = 0
    const provider: StreamingTranscriber = { transcribe: vi.fn(request => new ReadableStream({ async start(output) {
      for await (const block of request.audio)
        frames += block.channels[0].length
      output.enqueue({ type: 'complete', revision: 0 })
      output.close()
    } })) }
    const audio = new ReadableStream<PcmBlock>({ start(output) {
      output.enqueue({ range: { sourceId: 'mic', startFrame: 0, endFrame: 16000 }, sampleRate: 16000, channels: [new Float32Array(16000).fill(0.2)] })
      output.close()
    } })
    const done = trackers.filterTranscriber(provider, onMatch, onReject).transcribe({ audio, signal: new AbortController().signal }).pipeTo(new WritableStream())
    await vi.waitFor(() => expect(tracker.similarity).toHaveBeenCalledOnce())
    expect(onMatch).not.toHaveBeenCalled()
    expect(provider.transcribe).not.toHaveBeenCalled()
    score.resolve(new Float32Array([0.8]))
    await done
    expect(onMatch).toHaveBeenCalledOnce()
    expect(onReject).not.toHaveBeenCalled()
    expect(provider.transcribe).toHaveBeenCalledOnce()
    expect(frames).toBe(16000)
    dispose()
  })

  it.each([0.85, 0.42, Number.NaN])('does not interrupt or transcribe playback with an owner score of 0.42 and reference score %s', async (echo) => {
    const { trackers, voiceprints, dispose } = createStores()
    voiceprints.save({ embedding: new Float32Array([1, 0]), seconds: 8 }, Date.now() + 1)
    trackers.beginPlaybackReference()
    const playback = new AudioBuffer({ length: 24000, sampleRate: 16000 })
    playback.getChannelData(0).fill(0.2)
    trackers.observePlayback(playback)
    tracker.similarity.mockImplementation(async (_samples, _rate, speaker) => new Float32Array([speaker === 0 ? 0.42 : echo]))
    const onMatch = vi.fn(async () => {})
    const provider = { transcribe: vi.fn<StreamingTranscriber['transcribe']>() }
    const audio = new ReadableStream<PcmBlock>({ start(output) {
      output.enqueue({ range: { sourceId: 'mic', startFrame: 0, endFrame: 8000 }, sampleRate: 16000, channels: [new Float32Array(8000).fill(0.2)] })
      output.close()
    } })
    await trackers.filterTranscriber(provider, onMatch, undefined, 'interrupt').transcribe({ audio, signal: new AbortController().signal }).pipeTo(new WritableStream())
    expect(onMatch).not.toHaveBeenCalled()
    expect(provider.transcribe).not.toHaveBeenCalled()
    dispose()
  })

  it('admits half a second of owner speech over a weaker playback match', async () => {
    const { trackers, voiceprints, dispose } = createStores()
    voiceprints.save({ embedding: new Float32Array([1, 0]), seconds: 8 }, Date.now() + 1)
    const playback = new AudioBuffer({ length: 24000, sampleRate: 16000 })
    playback.getChannelData(0).fill(0.2)
    trackers.observePlayback(playback)
    tracker.similarity.mockImplementation(async (_samples, _rate, speaker) => new Float32Array([speaker === 0 ? 0.8 : 0.2]))
    let capture!: ReadableStreamDefaultController<PcmBlock>
    const audio = new ReadableStream<PcmBlock>({ start(output) {
      capture = output
    } })
    capture.enqueue({ range: { sourceId: 'mic', startFrame: 0, endFrame: 8000 }, sampleRate: 16000, channels: [new Float32Array(8000).fill(0.2)] })
    const filtered = await trackers.prepare(audio, new AbortController().signal, 'interrupt')
    const reader = filtered!.getReader()
    expect((await reader.read()).value?.range).toEqual({ sourceId: 'mic', startFrame: 0, endFrame: 8000 })
    await reader.cancel()
    expect(trackers.preparation).toBe('idle')
    dispose()
  })

  it('blocks an incomplete playback reference while playing and releases the next user input after a short response', async () => {
    const { trackers, voiceprints, dispose } = createStores()
    voiceprints.save({ embedding: new Float32Array([1, 0]), seconds: 8 }, Date.now() + 1)
    const playback = new AudioBuffer({ length: 4000, sampleRate: 16000 })
    playback.getChannelData(0).fill(0.2)
    trackers.observePlayback(playback)
    const capture = () => new ReadableStream<PcmBlock>({ start(output) {
      output.enqueue({ range: { sourceId: 'mic', startFrame: 0, endFrame: 8000 }, sampleRate: 16000, channels: [new Float32Array(8000).fill(0.2)] })
      output.close()
    } })
    expect(await trackers.prepare(capture(), new AbortController().signal, 'interrupt')).toBeUndefined()
    trackers.endPlaybackReference()
    const filtered = await trackers.prepare(capture(), new AbortController().signal, 'interrupt')
    const reader = filtered!.getReader()
    expect((await reader.read()).value?.range.endFrame).toBe(8000)
    await reader.cancel()
    dispose()
  })
})
