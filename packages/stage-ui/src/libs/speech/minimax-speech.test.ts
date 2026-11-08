import type { PcmBlock } from '@proj-airi/pipelines-audio'
import type { MinimaxSpeechConnection, MinimaxSpeechEvent } from '@proj-airi/provider-inference/minimax-speech'

import { VoiceController } from '@proj-airi/core-agent'
import { Playback } from '@proj-airi/pipelines-audio'
import { createPushStream } from '@proj-airi/stream-kit'
import { describe, expect, it, vi } from 'vitest'

import { configureMinimaxSpeech, createMinimaxSpeechStream } from './minimax-speech'

function transport() {
  const eventsCancelled = vi.fn()
  const events = createPushStream<MinimaxSpeechEvent>(eventsCancelled)
  const firstText = Promise.withResolvers<void>()
  const eof = Promise.withResolvers<void>()
  const texts: string[] = []
  const connection: MinimaxSpeechConnection = {
    events: events.stream,
    appendText: async (text) => {
      texts.push(text)
      firstText.resolve()
    },
    finish: vi.fn(async () => { eof.resolve() }),
    cancel: vi.fn(),
  }
  configureMinimaxSpeech(() => connection)
  const stream = createMinimaxSpeechStream({ model: 'speech-2.8-turbo', voice: 'Japanese_GracefulMaiden' })!
  return { events, eventsCancelled, firstText: firstText.promise, eof: eof.promise, texts, connection, stream }
}

describe('minimax streaming speech output', () => {
  it('plays the first PCM while VoiceController still accepts text, then plays the complete tail', async () => {
    const server = transport()
    const firstFrame = Promise.withResolvers<PcmBlock>()
    const played: number[] = []
    const playback = new Playback({ nowMs: () => 0, play: (clip) => {
      const reader = (clip.audio as ReadableStream<PcmBlock>).getReader()
      return {
        done: (async () => {
          try {
            while (true) {
              const part = await reader.read()
              if (part.done)
                return { throughMs: played.length / 32 }
              played.push(...part.value.channels[0])
              firstFrame.resolve(part.value)
            }
          }
          finally {
            reader.releaseLock()
          }
        })(),
        stop: async () => {
          await reader.cancel().catch(() => {})
          return { throughMs: played.length / 32 }
        },
      }
    } })
    const voice = new VoiceController({ speech: () => ({ playback, stream: server.stream }) })
    const response = voice.openResponse({ sessionId: 'streaming', turnId: 'early-pcm' })
    const speech = response.openSpeech({ purpose: 'answer' })
    speech.write('第一句。')
    speech.flush()
    await server.firstText
    server.events.write({ type: 'sentence-start' })
    server.events.write({ type: 'audio', pcm: new Uint8Array([0, 128, 0, 64]) })
    const first = await firstFrame.promise
    expect(first.sampleRate).toBe(32000)
    expect(Array.from(first.channels[0])).toEqual([-1, 0.5])
    expect(server.connection.finish).not.toHaveBeenCalled()
    expect(speech.write('尾句没有标点').status).toBe('accepted')
    speech.end()
    await server.eof
    server.events.write({ type: 'sentence-end' })
    server.events.write({ type: 'sentence-start' })
    server.events.write({ type: 'audio', pcm: new Uint8Array([255, 127]) })
    server.events.write({ type: 'sentence-end' })
    server.events.write({ type: 'finished' })
    expect(await response.finish()).toBe('finished')
    expect(played).toEqual([-1, 0.5, 32767 / 32768])
    expect(server.texts.join('')).toBe('第一句。尾句没有标点')
    await voice.close()
  })

  it('joins a split PCM16 sample across frames without buffering a complete sentence', async () => {
    const server = transport()
    const text = createPushStream<string>()
    const output = (await server.stream(text.stream, new AbortController().signal)).getReader()
    text.write('音频样本。')
    await server.firstText
    server.events.write({ type: 'sentence-start' })
    server.events.write({ type: 'audio', pcm: new Uint8Array([0]) })
    server.events.write({ type: 'audio', pcm: new Uint8Array([128, 0, 64]) })
    const sentence = await output.read()
    const audio = (sentence.value!.audio as ReadableStream<PcmBlock>).getReader()
    const first = await audio.read()
    expect(Array.from(first.value!.channels[0])).toEqual([-1, 0.5])
    expect(first.value!.range.startFrame).toBe(0)
    expect(first.value!.range.endFrame).toBe(2)
    text.close()
    await server.eof
    server.events.write({ type: 'audio', pcm: new Uint8Array([0, 0]) })
    server.events.write({ type: 'sentence-end' })
    server.events.write({ type: 'finished' })
    const last = await audio.read()
    expect(last.value!.range.startFrame).toBe(2)
    expect(last.value!.range.endFrame).toBe(3)
    expect((await audio.read()).done).toBe(true)
    expect((await output.read()).done).toBe(true)
    expect(text.stream.locked).toBe(false)
  })

  it('aborts both readers and active PCM before any later provider audio can play', async () => {
    const server = transport()
    const inputCancelled = vi.fn()
    const text = createPushStream<string>(inputCancelled)
    const abort = new AbortController()
    const output = (await server.stream(text.stream, abort.signal)).getReader()
    text.write('正在说话。')
    await server.firstText
    server.events.write({ type: 'sentence-start' })
    server.events.write({ type: 'audio', pcm: new Uint8Array([0, 0]) })
    const sentence = await output.read()
    const audio = (sentence.value!.audio as ReadableStream<PcmBlock>).getReader()
    await audio.read()
    const nextAudio = expect(audio.read()).rejects.toThrow('owner interruption')
    const nextSentence = expect(output.read()).rejects.toThrow('owner interruption')
    abort.abort(new Error('owner interruption'))
    server.events.write({ type: 'audio', pcm: new Uint8Array([255, 127]) })
    await nextAudio
    await nextSentence
    expect(server.connection.cancel).toHaveBeenCalledOnce()
    expect(inputCancelled).toHaveBeenCalledOnce()
    expect(server.eventsCancelled).toHaveBeenCalledOnce()
    expect(text.stream.locked).toBe(false)
    expect(server.events.stream.locked).toBe(false)
  })

  it('cancels synthesis when playback cancels its live sentence reader', async () => {
    const server = transport()
    const text = createPushStream<string>()
    const output = (await server.stream(text.stream, new AbortController().signal)).getReader()
    server.events.write({ type: 'sentence-start' })
    server.events.write({ type: 'audio', pcm: new Uint8Array([0, 0]) })
    const sentence = await output.read()
    const rejection = expect(output.read()).rejects.toMatchObject({ name: 'AbortError' })
    await (sentence.value!.audio as ReadableStream<PcmBlock>).cancel()
    await rejection
    expect(server.connection.cancel).toHaveBeenCalledOnce()
    expect(text.stream.locked).toBe(false)
  })

  it('propagates a queue refusal to both playback and the speech producer', async () => {
    const server = transport()
    const text = createPushStream<string>()
    const output = (await server.stream(text.stream, new AbortController().signal)).getReader()
    server.events.write({ type: 'sentence-start' })
    server.events.write({ type: 'audio', pcm: new Uint8Array([0, 0]) })
    const sentence = await output.read()
    const audio = (sentence.value!.audio as ReadableStream<PcmBlock>).getReader()
    await audio.read()
    const pcmFailure = expect(audio.read()).rejects.toThrow('2205')
    const producerFailure = expect(output.read()).rejects.toThrow('2205')
    server.events.write({ type: 'error', message: 'MiniMax speech 2205: queue busy' })
    await pcmFailure
    await producerFailure
    expect(server.connection.cancel).toHaveBeenCalledOnce()
  })
})
