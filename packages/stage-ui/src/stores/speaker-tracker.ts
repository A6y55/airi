import type { StreamingTranscriber, TranscriptionEvent } from '@proj-airi/core-agent'
import type { AudioWindow, PcmBlock } from '@proj-airi/pipelines-audio'
import type { SpeakerTracker } from '@sherpaw/speaker-diarization'

import type { OwnerSpeechActivity } from '../libs/voice/owner-speech'
import type { SpeakerTrackerPreparation } from '../libs/voice/speaker-tracker'

import { defineStore } from 'pinia'
import { onScopeDispose, shallowRef, watch } from 'vue'

import { toMonoSamples } from '../libs/voice/mono-samples'
import { prepareOwnerSpeech } from '../libs/voice/owner-speech'
import { loadSpeakerTracker } from '../libs/voice/speaker-model'
import { SpeakerTrackerRuntime } from '../libs/voice/speaker-tracker'
import { useVoiceprintStore } from './voiceprint'

/** The owner stays speaker 0. A temporary playback reference, when present, is speaker 1. */
const OWNER_SPEAKER = 0

/**
 * Owns the voice host's speaker tracker Worker and exposes its preparation for UI.
 *
 * The CAM++ model downloads and the Worker starts only when a feature calls `acquire`.
 * The tracker enrolls the saved voiceprint as speaker 0, and follows each change of it.
 * Each `acquire` holds the Worker until its matching `release`. The last release terminates it.
 */
export const useSpeakerTrackerStore = defineStore('speaker-tracker', () => {
  const preparation = shallowRef<SpeakerTrackerPreparation>('idle')
  const error = shallowRef<string>()
  const voiceprints = useVoiceprintStore()
  const runtime = new SpeakerTrackerRuntime({
    createTracker: loadSpeakerTracker,
    onPreparationChange: (value, message) => {
      preparation.value = value
      error.value = message
    },
  })

  // Enrollment and comparisons share one Worker. Keep resets outside every complete comparison.
  let operation = Promise.resolve()
  function serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = operation.then(run)
    operation = result.then(() => {}, () => {})
    return result
  }

  let playbackWindow: Pick<AudioWindow, 'channels' | 'sampleRate'> | undefined
  let enrolledPlayback: typeof playbackWindow
  let playbackSamples: Float32Array | undefined
  let playbackSampleRate = 0
  let playbackFrames = 0
  let playbackRequired = false
  let newPlayback = true
  let playbackActive = false

  /** The next audible response replaces the reference. Keep the old reference through the preceding room echo. */
  function beginPlaybackReference(): void {
    newPlayback = true
  }

  /** Short responses can end before a reference forms. They must not block the next user input. */
  function endPlaybackReference(): void {
    playbackActive = false
    if (!playbackWindow && playbackSamples && playbackFrames >= playbackSampleRate)
      playbackWindow = { channels: [playbackSamples.subarray(0, playbackFrames)], sampleRate: playbackSampleRate }
  }

  /** Borrows scheduled speech PCM. Only a bounded, in-memory reference reaches the existing speaker model. */
  function observePlayback(buffer: AudioBuffer): void {
    if (!voiceprints.voiceprint)
      return
    playbackActive = true
    if (newPlayback || playbackSampleRate !== buffer.sampleRate) {
      newPlayback = false
      playbackWindow = undefined
      playbackSamples = undefined
      playbackFrames = 0
      playbackSampleRate = buffer.sampleRate
    }
    playbackRequired = true
    // Sherpaw tracks utterances of at least one second. Its speaker windows use 1.5 seconds.
    playbackSamples ??= new Float32Array(Math.ceil(buffer.sampleRate * 1.5))
    const length = Math.min(buffer.length, playbackSamples.length - playbackFrames)
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index).subarray(0, length))
    playbackSamples.set(toMonoSamples({ channels }), playbackFrames)
    playbackFrames += length
    if (playbackFrames === playbackSamples.length) {
      playbackWindow = { channels: [playbackSamples], sampleRate: buffer.sampleRate }
      playbackSamples = undefined
      playbackFrames = 0
    }
  }

  // A failed enrollment releases the tracker and reports `error` through `onPreparationChange`.
  watch(() => voiceprints.voiceprint, voiceprint => serialize(async () => {
    enrolledPlayback = undefined
    await runtime.setVoiceprints(voiceprint ? [voiceprint] : [])
  }).catch(() => {}), { immediate: true })

  let holders = 0

  /** Retains the shared tracker after it has enrolled the current voiceprint. Pair each call with `release`. */
  function acquire(): Promise<SpeakerTracker> {
    holders++
    return runtime.acquire()
  }

  /** Counts releases, so a comparison can tell that a release ended it. */
  let releases = 0

  function release(): void {
    holders = Math.max(0, holders - 1)
    if (holders)
      return
    releases++
    runtime.dispose()
  }

  /**
   * The cosine between the saved voiceprint and the audio window, compared as one window.
   * NaN when the window has no embedding, for example digital silence.
   * The comparison uses the window as mono PCM clamped to [-1, 1], because the tracker rejects other samples.
   * Uses only a ready tracker, so a comparison never loads a released tracker again. Before `ready`, the result is NaN.
   * While the tracker enrolls a replaced voiceprint, the comparison waits. A comparison that `release` ends is NaN.
   * Rejects when no voiceprint is enrolled.
   */
  function compareOwner(window: Pick<AudioWindow, 'channels' | 'sampleRate'>): Promise<number> {
    return compare(window, false)
  }

  async function compare(window: Pick<AudioWindow, 'channels' | 'sampleRate'>, excludePlayback: boolean): Promise<number> {
    const released = releases
    try {
      const comparison = await serialize(async () => {
        if (preparation.value !== 'ready' || releases !== released)
          return { score: Number.NaN }
        const tracker = await runtime.acquire()
        if (excludePlayback && playbackRequired) {
          const reference = playbackWindow
          // Do not authorize an interruption before the first playback reference can be compared.
          if (!reference)
            return { score: playbackActive ? Number.NaN : compareScore(tracker, window, false) }
          if (enrolledPlayback !== reference) {
            const turn = await tracker.track(reference.channels[0], reference.sampleRate)
            const map = await tracker.inspect()
            const unit = map.units.find(unit => unit.index === turn.index)
            if (!unit || !voiceprints.voiceprint)
              return { score: Number.NaN }
            await runtime.setVoiceprints([voiceprints.voiceprint, { embedding: unit.embedding, seconds: unit.seconds }])
            enrolledPlayback = reference
          }
        }
        // Dispatch both read-only comparisons before the next reset. A cancelled input's result must not block new inputs.
        return { score: compareScore(tracker, window, excludePlayback && playbackRequired) }
      })
      return await comparison.score
    }
    catch (error) {
      // Releasing the Worker cancels its comparisons. Other model failures remain visible to the caller.
      if (releases !== released)
        return Number.NaN
      throw error
    }
  }

  async function compareScore(tracker: SpeakerTracker, window: Pick<AudioWindow, 'channels' | 'sampleRate'>, excludePlayback: boolean): Promise<number> {
    const samples = toMonoSamples(window)
    const seconds = samples.length / window.sampleRate
    const options = { windowSeconds: seconds, stepSeconds: seconds }
    const owner = tracker.similarity(samples, window.sampleRate, OWNER_SPEAKER, options)
    if (excludePlayback) {
      const playback = tracker.similarity(samples, window.sampleRate, 1, options)
      const [[cosine], [echo]] = await Promise.all([owner, playback])
      // A positive owner score alone cannot distinguish a false match on the character's voice.
      return Number.isFinite(echo) && cosine > echo ? cosine : Number.NaN
    }
    const [cosine] = await owner
    return cosine ?? Number.NaN
  }

  /** A filter retains the tracker until its captured audio ends, independently of continuous listening. */
  function prepare(audio: ReadableStream<PcmBlock>, signal: AbortSignal, admission: 'speech' | 'interrupt' = 'speech', onActivity?: (activity: OwnerSpeechActivity) => void) {
    const enrolled = voiceprints.voiceprint
    let retained = false
    return prepareOwnerSpeech(audio, signal, async (window, active) => {
      if (!enrolled || enrolled !== voiceprints.voiceprint)
        throw new Error('Voiceprint is missing or changed. Enroll your voice before using speaker recognition.')
      if (!retained) {
        retained = true
        await acquire()
      }
      active.throwIfAborted()
      const score = await compare(window, true)
      active.throwIfAborted()
      if (enrolled !== voiceprints.voiceprint)
        throw new Error('Voiceprint changed during speech recognition')
      return score
    }, () => {
      if (retained)
        release()
    }, admission, onActivity)
  }

  /** No provider or automatic interruption starts before a match. The host cancels rejected inputs without creating drafts. */
  function filterTranscriber(provider: StreamingTranscriber, onMatch?: () => Promise<void>, onReject?: () => void, admission: 'speech' | 'interrupt' = 'speech', onActivity?: (activity: OwnerSpeechActivity) => void): StreamingTranscriber {
    return {
      transcribe(request) {
        const cancelled = new AbortController()
        const signal = AbortSignal.any([request.signal, cancelled.signal])
        return new ReadableStream<TranscriptionEvent>({
          async start(output) {
            try {
              const audio = await prepare(request.audio, signal, admission, onActivity)
              signal.throwIfAborted()
              if (audio) {
                await onMatch?.()
                signal.throwIfAborted()
                for await (const event of provider.transcribe({ audio, signal })) {
                  signal.throwIfAborted()
                  output.enqueue(event)
                }
              }
              else {
                onReject?.()
                signal.throwIfAborted()
                output.enqueue({ type: 'complete', revision: 0 })
              }
              output.close()
            }
            catch (error) {
              if (!cancelled.signal.aborted)
                output.error(error)
            }
            finally {
              cancelled.abort('Speaker-filtered transcription ended')
            }
          },
          cancel: reason => cancelled.abort(reason),
        })
      },
    }
  }

  onScopeDispose(() => {
    holders = 0
    release()
  })

  return { preparation, error, acquire, release, compareOwner, prepare, filterTranscriber, beginPlaybackReference, observePlayback, endPlaybackReference }
})
