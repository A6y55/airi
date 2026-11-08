import type { PcmBlock } from '@proj-airi/pipelines-audio'

import { describe, expect, it, vi } from 'vitest'

import { prepareOwnerSpeech } from './owner-speech'

function block(value: number, startFrame: number, frames = 16000): PcmBlock {
  return { range: { sourceId: 'microphone', startFrame, endFrame: startFrame + frames }, sampleRate: 16000, channels: [new Float32Array(frames).fill(value)] }
}

function audio(...blocks: PcmBlock[]) {
  return new ReadableStream<PcmBlock>({ start(output) {
    blocks.forEach(value => output.enqueue(value))
    output.close()
  } })
}

async function collect(stream: ReadableStream<PcmBlock>) {
  const blocks: PcmBlock[] = []
  for await (const value of stream)
    blocks.push(value)
  return blocks
}

describe('owner speech before transcription', () => {
  it.each([0.12, Number.NaN, Number.POSITIVE_INFINITY])('rejects an entire recording with score %s', async (score) => {
    const close = vi.fn()
    const filtered = await prepareOwnerSpeech(audio(block(0.4, 0)), new AbortController().signal, async () => score, close)
    expect(filtered).toBeUndefined()
    expect(close).toHaveBeenCalledOnce()
  })

  it('keeps owner speech, replaces later bystanders with silence, and never changes source samples', async () => {
    const before = block(0.1, 4000)
    const owner = block(0.7, 20000)
    const other = block(0.2, 36000)
    const filtered = await prepareOwnerSpeech(audio(before, owner, other), new AbortController().signal, async window => window.channels[0][0])
    const output = await collect(filtered!)
    expect(output.map(value => value.range)).toEqual([owner.range, other.range])
    expect(output[0].channels[0]).toEqual(owner.channels[0])
    expect(output[1].channels[0]).toEqual(new Float32Array(16000))
    expect(other.channels[0]).toEqual(new Float32Array(16000).fill(0.2))
  })

  it('replays the leading words after the buffered prefix verifies the owner', async () => {
    const beginning = block(0.2, 0)
    const continuation = block(0.8, 16000)
    const compare = vi.fn(async (window: PcmBlock) => window.channels[0].length === 32000 ? 0.8 : window.channels[0][0])
    const filtered = await prepareOwnerSpeech(audio(beginning, continuation), new AbortController().signal, compare)
    const output = await collect(filtered!)
    expect(output.map(value => value.range)).toEqual([{ sourceId: 'microphone', startFrame: 0, endFrame: 32000 }])
    expect(output[0].channels[0].subarray(0, 16000)).toEqual(beginning.channels[0])
    expect(output[0].channels[0].subarray(16000)).toEqual(continuation.channels[0])
    expect(compare.mock.calls.some(([window]) => window.range.startFrame === 0 && window.range.endFrame === 32000)).toBe(true)
  })

  it('keeps unconfirmed history bounded and does not replay a prefix that fails verification', async () => {
    const blocks = Array.from({ length: 8 }, (_, index) => block(index === 7 ? 0.8 : 0.1, index * 16000))
    const compare = vi.fn(async (window: PcmBlock) => window.channels[0][0])
    const filtered = await prepareOwnerSpeech(audio(...blocks), new AbortController().signal, compare)
    const output = await collect(filtered!)
    expect(output.map(value => value.range)).toEqual([blocks[7].range])
    expect(output[0].channels[0]).toEqual(blocks[7].channels[0])
    expect(Math.max(...compare.mock.calls.map(([window]) => window.channels[0].length))).toBeLessThanOrEqual(48000)
  })

  it('does not release cached leading audio when cancellation interrupts its verification', async () => {
    const pending = Promise.withResolvers<number>()
    const compare = vi.fn(async (window: PcmBlock) => window.channels[0].length > 16000 ? pending.promise : window.channels[0][0])
    const abort = new AbortController()
    const result = prepareOwnerSpeech(audio(block(0.1, 0), block(0.8, 16000)), abort.signal, compare)
    const rejected = expect(result).rejects.toThrow('Prefix verification cancelled')
    await vi.waitFor(() => expect(compare).toHaveBeenCalledTimes(3))
    abort.abort(new Error('Prefix verification cancelled'))
    pending.resolve(0.9)
    await rejected
  })

  it('verifies the final partial window after a manual recording ends', async () => {
    const first = block(0.6, 0, 512)
    const last = block(0.6, 512, 7488)
    const compared = vi.fn(async () => 0.6)
    const filtered = await prepareOwnerSpeech(audio(first, last), new AbortController().signal, compared)
    const output = await collect(filtered!)
    expect(compared.mock.calls).toHaveLength(1)
    expect(output[0].range).toEqual({ sourceId: 'microphone', startFrame: 0, endFrame: 8000 })
    expect(output[0].channels[0]).toEqual(new Float32Array(8000).fill(0.6))
  })

  it('exposes no audio when the model fails', async () => {
    const close = vi.fn()
    await expect(prepareOwnerSpeech(audio(block(0.7, 0)), new AbortController().signal, async () => {
      throw new Error('Speaker worker failed')
    }, close)).rejects.toThrow('Speaker worker failed')
    expect(close).toHaveBeenCalledOnce()
  })

  it('discards a successful comparison that arrives after cancellation', async () => {
    const pending = Promise.withResolvers<number>()
    const compared = vi.fn(() => pending.promise)
    const controller = new AbortController()
    const close = vi.fn()
    const activity = vi.fn()
    const result = prepareOwnerSpeech(audio(block(0.7, 0)), controller.signal, compared, close, 'speech', activity)
    const rejected = expect(result).rejects.toThrow('Recording cancelled')
    await vi.waitFor(() => expect(compared).toHaveBeenCalledOnce())
    controller.abort(new Error('Recording cancelled'))
    expect(close).toHaveBeenCalledOnce()
    pending.resolve(0.9)
    await rejected
    expect(close).toHaveBeenCalledOnce()
    expect(activity).not.toHaveBeenCalled()
  })

  it.each([0.1, Number.NaN, Number.POSITIVE_INFINITY])('rejects non-owner interruption audio with score %s', async (score) => {
    const filtered = await prepareOwnerSpeech(audio(block(0.4, 0, 8000)), new AbortController().signal, async () => score, undefined, 'interrupt')
    expect(filtered).toBeUndefined()
  })

  it('admits a half-second owner utterance without waiting for two seconds or end of input', async () => {
    const owner = block(0.6, 0, 8000)
    const source = new ReadableStream<PcmBlock>({ start(output) {
      output.enqueue(owner)
    } })
    const filtered = await prepareOwnerSpeech(source, new AbortController().signal, async () => 0.6, undefined, 'interrupt')
    const reader = filtered!.getReader()
    expect((await reader.read()).value).toEqual(owner)
    await reader.cancel()
  })

  it('rejects an utterance shorter than the model minimum without invoking the model', async () => {
    const compare = vi.fn(async () => 0.8)
    const filtered = await prepareOwnerSpeech(audio(block(0.8, 0, 2000)), new AbortController().signal, compare, undefined, 'interrupt')
    expect(filtered).toBeUndefined()
    expect(compare).not.toHaveBeenCalled()
  })

  it('checks a short tail with earlier audio while outputting each original sample once', async () => {
    const compare = vi.fn(async (window: PcmBlock) => {
      expect(window.channels[0].length).toBeGreaterThanOrEqual(4000)
      return 0.8
    })
    const filtered = await prepareOwnerSpeech(audio(block(0.8, 0, 18000)), new AbortController().signal, compare)
    const output = await collect(filtered!)
    expect(output.map(value => value.channels[0].length)).toEqual([16000, 2000])
    expect(compare.mock.calls.map(([window]) => window.channels[0].length)).toEqual([16000, 4000])
    expect(output[1].range).toEqual({ sourceId: 'microphone', startFrame: 16000, endFrame: 18000 })
  })

  it.each([['speech', 16000], ['interrupt', 8000]] as const)('drains accepted audio when %s verification seals its own capture', async (admission, frames) => {
    let source!: ReadableStreamDefaultController<PcmBlock>
    const stream = new ReadableStream<PcmBlock>({ start(output) {
      source = output
      output.enqueue(block(0.8, 0, frames))
      output.enqueue(block(0.1, frames, frames * 2))
    } })
    let rejectedMs = 0
    const filtered = await prepareOwnerSpeech(stream, new AbortController().signal, async window => window.channels[0][0], undefined, admission, (activity) => {
      rejectedMs = activity.matches ? 0 : rejectedMs + activity.durationMs
      if (rejectedMs >= frames * 2 * 1000 / 16000)
        source.close()
    })
    const output = await collect(filtered!)
    expect(output.map(value => value.range)).toEqual([
      { sourceId: 'microphone', startFrame: 0, endFrame: frames },
      { sourceId: 'microphone', startFrame: frames, endFrame: frames * 2 },
      { sourceId: 'microphone', startFrame: frames * 2, endFrame: frames * 3 },
    ])
    expect(output[0].channels[0]).toEqual(new Float32Array(frames).fill(0.8))
    expect(output.slice(1).map(value => value.channels[0])).toEqual([new Float32Array(frames), new Float32Array(frames)])
  })

  it('keeps the first accepted window and its borrowed-context tail when activity seals capture during preparation', async () => {
    let source!: ReadableStreamDefaultController<PcmBlock>
    const stream = new ReadableStream<PcmBlock>({ start(output) {
      source = output
      output.enqueue(block(0.8, 0, 18000))
    } })
    const filtered = await prepareOwnerSpeech(stream, new AbortController().signal, async () => 0.8, undefined, 'speech', () => {
      // Only the complete window reports activity. Reporting the borrowed tail again closes an already closed capture.
      source.close()
    })
    const output = await collect(filtered!)
    expect(output.map(value => value.range)).toEqual([
      { sourceId: 'microphone', startFrame: 0, endFrame: 16000 },
      { sourceId: 'microphone', startFrame: 16000, endFrame: 18000 },
    ])
    expect(output[0].channels[0]).toEqual(new Float32Array(16000).fill(0.8))
    expect(output[1].channels[0]).toEqual(new Float32Array(2000).fill(0.8))
  })
})
