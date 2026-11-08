import type { PcmBlock } from '@proj-airi/pipelines-audio'

import { toMonoSamples } from './mono-samples'

/** Sherpaw focus uses one-second comparisons and a cosine threshold of 0.35. */
const OWNER_THRESHOLD = 0.35

/** Short leading speech can need more context to identify its speaker. Keep at most three seconds before admission. */
const ADMISSION_HISTORY_SECONDS = 3

/** Complete speaker comparisons let the host end automatic inputs without trusting raw VAD activity. */
export interface OwnerSpeechActivity {
  readonly matches: boolean
  /** Duration of captured frames, excluding context borrowed for a final partial window. */
  readonly durationMs: number
}

/**
 * Holds captured PCM until the enrolled voice matches. Later rejected windows become silence.
 * Recording completion checks the remaining samples, so releasing Push to Talk does not lose its last words.
 * No accepted window returns no stream. Model errors and cancellation reject without exposing unchecked samples.
 */
export async function prepareOwnerSpeech(
  audio: ReadableStream<PcmBlock>,
  signal: AbortSignal,
  compare: (window: PcmBlock, signal: AbortSignal) => Promise<number>,
  onClose?: () => void,
  /** @default speech. Interrupt admission uses half-second windows so short owner utterances can stop playback. */
  admission: 'speech' | 'interrupt' = 'speech',
  /** Runs synchronously for complete windows. Sealing capture here preserves queued audio. Never await transcription completion here. */
  onActivity?: (activity: OwnerSpeechActivity) => void,
): Promise<ReadableStream<PcmBlock> | undefined> {
  const cancelled = new AbortController()
  const active = AbortSignal.any([signal, cancelled.signal])
  const reader = audio.getReader()
  let closed = false
  const close = () => {
    if (closed)
      return
    closed = true
    onClose?.()
  }
  const abort = () => {
    void reader.cancel(active.reason).catch(() => {})
    close()
  }
  active.addEventListener('abort', abort, { once: true })

  async function* windows() {
    let samples: Float32Array | undefined
    let used = 0
    let startFrame = 0
    let format: PcmBlock | undefined
    let accepted = false
    let previous: Float32Array | undefined
    const pending: PcmBlock[] = []
    let pendingFrames = 0

    async function decide(): Promise<PcmBlock | undefined> {
      active.throwIfAborted()
      const channel = samples!.subarray(0, used)
      const block: PcmBlock = {
        range: { sourceId: format!.range.sourceId, startFrame, endFrame: startFrame + used },
        sampleRate: format!.sampleRate,
        channels: [channel],
      }
      // CAM++ requires at least 250 ms. A final short tail borrows earlier samples only for comparison, never for output.
      const minimumFrames = Math.ceil(block.sampleRate / 4)
      let comparison = block
      if (used < minimumFrames && previous && previous.length >= minimumFrames - used) {
        const context = new Float32Array(minimumFrames)
        context.set(previous.subarray(previous.length - (minimumFrames - used)))
        context.set(channel, minimumFrames - used)
        comparison = { ...block, range: { ...block.range, startFrame: block.range.endFrame - minimumFrames }, channels: [context] }
      }
      const score = comparison.channels[0].length >= minimumFrames ? await compare(comparison, active) : Number.NaN
      previous = channel
      active.throwIfAborted()
      let matches = Number.isFinite(score) && score >= OWNER_THRESHOLD
      let output = block
      if (!accepted) {
        pending.push(block)
        pendingFrames += used
        while (pending.length > 1 && pendingFrames > block.sampleRate * ADMISSION_HISTORY_SECONDS)
          pendingFrames -= pending.shift()!.channels[0].length
        if (pending.length > 1) {
          const channels = new Float32Array(pendingFrames)
          let offset = 0
          for (const part of pending) {
            channels.set(part.channels[0], offset)
            offset += part.channels[0].length
          }
          const candidate: PcmBlock = {
            range: { ...block.range, startFrame: pending[0].range.startFrame },
            sampleRate: block.sampleRate,
            channels: [channels],
          }
          const admissionScore = await compare(candidate, active)
          active.throwIfAborted()
          // Replaying the prefix requires a match for that entire buffered interval, not just its last window.
          if (Number.isFinite(admissionScore) && admissionScore >= OWNER_THRESHOLD) {
            matches = true
            output = candidate
          }
        }
      }
      if (used === samples!.length)
        onActivity?.({ matches, durationMs: used * 1000 / block.sampleRate })
      active.throwIfAborted()
      if (matches) {
        accepted = true
        pending.length = 0
        pendingFrames = 0
        return output
      }
      if (!accepted)
        return undefined
      // Keep time after the first accepted speech, including pauses and rejected speakers.
      channel.fill(0)
      return block
    }

    try {
      active.throwIfAborted()
      while (true) {
        const next = await reader.read()
        active.throwIfAborted()
        if (next.done)
          break
        const block = next.value
        format ??= block
        const mono = toMonoSamples(block)
        for (let offset = 0; offset < mono.length;) {
          if (!samples) {
            samples = new Float32Array(Math.round(block.sampleRate * (admission === 'interrupt' ? 0.5 : 1)))
            startFrame = block.range.startFrame + offset
          }
          const length = Math.min(samples.length - used, mono.length - offset)
          samples.set(mono.subarray(offset, offset + length), used)
          used += length
          offset += length
          if (used === samples.length) {
            const output = await decide()
            if (output)
              yield output
            samples = undefined
            used = 0
          }
        }
      }
      if (used) {
        const output = await decide()
        if (output)
          yield output
      }
    }
    finally {
      active.removeEventListener('abort', abort)
      await reader.cancel().catch(() => {})
      reader.releaseLock()
      close()
    }
  }

  const iterator = windows()
  const first = await iterator.next()
  if (first.done)
    return undefined
  return new ReadableStream<PcmBlock>({
    start: output => output.enqueue(first.value),
    async pull(output) {
      try {
        const next = await iterator.next()
        if (next.done)
          output.close()
        else
          output.enqueue(next.value)
      }
      catch (error) {
        output.error(error)
      }
    },
    async cancel(reason) {
      cancelled.abort(reason)
      await iterator.return()
    },
  })
}
