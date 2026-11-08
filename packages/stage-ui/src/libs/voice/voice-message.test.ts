import type { PcmBlock } from '@proj-airi/pipelines-audio'

import { fileSource } from '@proj-airi/audio/encoding'
import { AudioInput } from '@proj-airi/pipelines-audio'
import { createPushStream } from '@proj-airi/stream-kit'
import { expect, it, vi } from 'vitest'

import { prepareOwnerSpeech } from './owner-speech'
import { VoiceMessage } from './voice-message'

it('retains an explicitly sent preview after failure and retries with the same session and message identity', async () => {
  const source = createPushStream<PcmBlock>()
  const submit = vi.fn<(draft: { messageId: string, sessionId: string, audio: Blob }) => Promise<{ messageId: string }>>()
  const message = new VoiceMessage('message-1', 'alice', new AudioInput({ live: true, open: () => source.stream }), submit)
  source.write({ range: { sourceId: 'mic', startFrame: 0, endFrame: 1600 }, sampleRate: 16000, channels: [new Float32Array(1600).fill(0.25)] })
  await expect.poll(() => message.snapshot.phase).toBe('capturing')
  await message.finish()
  await expect.poll(() => message.snapshot.phase).toBe('ready')
  expect(submit).not.toHaveBeenCalled()
  submit.mockRejectedValueOnce(new Error('Persistence failed'))
  await expect(message.send()).rejects.toThrow('Persistence failed')
  expect(message.snapshot.phase).toBe('ready')
  let recorded = 0
  for await (const block of fileSource(message.snapshot.audio!).open(new AbortController().signal))
    recorded += block.channels[0].length
  expect(recorded).toBe(1600)
  const persisted = Promise.withResolvers<{ messageId: string }>()
  submit.mockReturnValueOnce(persisted.promise)
  const first = message.send()
  expect(message.send()).toBe(first)
  expect(message.cancel()).toBe('closed')
  persisted.resolve({ messageId: 'message-1' })
  await first
  await message.send()
  expect(submit).toHaveBeenCalledTimes(2)
  expect(submit.mock.calls.map(([draft]) => [draft.messageId, draft.sessionId])).toEqual([['message-1', 'alice'], ['message-1', 'alice']])
  expect(message.snapshot.phase).toBe('sent')
})

it('cancels a recording that is still waiting for audio without submitting or creating a preview', async () => {
  const released = vi.fn()
  const submit = vi.fn()
  const message = new VoiceMessage('pending', 'bob', new AudioInput({ live: true, open: (signal) => {
    signal.addEventListener('abort', released)
    return createPushStream<PcmBlock>().stream
  } }), submit)
  expect(message.snapshot.phase).toBe('pending')
  message.cancel()
  expect(message.snapshot.phase).toBe('cancelled')
  expect(message.snapshot.audio).toBeUndefined()
  await expect(message.send()).rejects.toThrow('not ready')
  expect(submit).not.toHaveBeenCalled()
  await expect.poll(() => released.mock.calls.length).toBe(1)
})

it('sends the transcript that was recognized while recording', async () => {
  const source = createPushStream<PcmBlock>()
  const submit = vi.fn(async (draft: { messageId: string }) => ({ messageId: draft.messageId }))
  const transcribe = vi.fn(async (audio: ReadableStream<PcmBlock>) => {
    let frames = 0
    for await (const block of audio)
      frames += block.channels[0].length
    return frames ? 'hello there' : undefined
  })
  const message = new VoiceMessage('spoken', 'alice', new AudioInput({ live: true, open: () => source.stream }), submit, transcribe)
  source.write({ range: { sourceId: 'mic', startFrame: 0, endFrame: 1600 }, sampleRate: 16000, channels: [new Float32Array(1600).fill(0.25)] })
  await expect.poll(() => message.snapshot.phase).toBe('capturing')
  await message.finish()
  await expect.poll(() => message.snapshot.phase).toBe('ready')

  await message.send('see this')

  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'spoken', text: 'see this', transcript: 'hello there' }))
})

it('sends without a transcript when transcription fails', async () => {
  const source = createPushStream<PcmBlock>()
  const submit = vi.fn(async (draft: { messageId: string }) => ({ messageId: draft.messageId }))
  const message = new VoiceMessage('silent', 'alice', new AudioInput({ live: true, open: () => source.stream }), submit, async () => {
    throw new Error('Provider unavailable')
  })
  source.write({ range: { sourceId: 'mic', startFrame: 0, endFrame: 1600 }, sampleRate: 16000, channels: [new Float32Array(1600).fill(0.25)] })
  await expect.poll(() => message.snapshot.phase).toBe('capturing')
  await message.finish()
  await expect.poll(() => message.snapshot.phase).toBe('ready')

  await message.send()

  expect(submit.mock.calls[0][0]).not.toHaveProperty('transcript')
})

it('does not send a recording in which the transcriber recognized no speech', async () => {
  const source = createPushStream<PcmBlock>()
  const submit = vi.fn(async (draft: { messageId: string }) => ({ messageId: draft.messageId }))
  const message = new VoiceMessage('quiet', 'alice', new AudioInput({ live: true, open: () => source.stream }), submit, async (audio) => {
    await audio.pipeTo(new WritableStream())
    return ''
  })
  source.write({ range: { sourceId: 'mic', startFrame: 0, endFrame: 1600 }, sampleRate: 16000, channels: [new Float32Array(1600)] })
  await expect.poll(() => message.snapshot.phase).toBe('capturing')
  await message.finish()
  await expect.poll(() => message.snapshot.phase).toBe('ready')

  await expect(message.send('see this')).rejects.toThrow('No speech')

  expect(submit).not.toHaveBeenCalled()
  expect(message.snapshot).toMatchObject({ phase: 'cancelled', error: 'No speech was recognized in the recording' })
  expect(message.snapshot.audio).toBeUndefined()
})

// ROOT CAUSE:
//
// With a slow Hearing provider, a sent voice message had no bubble for up to 8 seconds, and cancel did nothing.
// `send` waited for the transcript before the submit.
//
// We fixed this by submitting at once and delivering the transcript later.
it('submits at once while the transcript is still coming, then delivers it', async () => {
  const source = createPushStream<PcmBlock>()
  const submit = vi.fn(async (draft: { messageId: string }) => ({ messageId: draft.messageId }))
  const transcript = Promise.withResolvers<string | undefined>()
  const deliver = vi.fn(async () => {})
  const message = new VoiceMessage('slow', 'alice', new AudioInput({ live: true, open: () => source.stream }), submit, async () => transcript.promise, deliver)
  source.write({ range: { sourceId: 'mic', startFrame: 0, endFrame: 1600 }, sampleRate: 16000, channels: [new Float32Array(1600).fill(0.25)] })
  await expect.poll(() => message.snapshot.phase).toBe('capturing')
  await message.finish()
  await expect.poll(() => message.snapshot.phase).toBe('ready')

  await message.send()

  expect(submit.mock.calls[0][0]).toMatchObject({ messageId: 'slow', transcriptPending: true })
  expect(submit.mock.calls[0][0]).not.toHaveProperty('transcript')
  expect(message.snapshot.phase).toBe('transcribing')

  transcript.resolve('hello there')

  await expect.poll(() => message.snapshot.phase).toBe('sent')
  expect(deliver).toHaveBeenCalledWith({ messageId: 'slow', sessionId: 'alice', transcript: 'hello there' })
})

it('removes a submitted message when its late transcript has no speech', async () => {
  const source = createPushStream<PcmBlock>()
  const submit = vi.fn(async (draft: { messageId: string }) => ({ messageId: draft.messageId }))
  const transcript = Promise.withResolvers<string | undefined>()
  const deliver = vi.fn(async () => {})
  const message = new VoiceMessage('late-silent', 'alice', new AudioInput({ live: true, open: () => source.stream }), submit, async () => transcript.promise, deliver)
  source.write({ range: { sourceId: 'mic', startFrame: 0, endFrame: 1600 }, sampleRate: 16000, channels: [new Float32Array(1600)] })
  await expect.poll(() => message.snapshot.phase).toBe('capturing')
  await message.finish()
  await expect.poll(() => message.snapshot.phase).toBe('ready')
  await message.send()

  transcript.resolve('')

  await expect.poll(() => message.snapshot.phase).toBe('cancelled')
  expect(message.snapshot.error).toBe('No speech was recognized in the recording')
  expect(deliver).toHaveBeenCalledWith({ messageId: 'late-silent', sessionId: 'alice', transcript: '' })
})

it('rejects a bystander recording before transcription, attachment encoding, or submission', async () => {
  const source = createPushStream<PcmBlock>()
  const submit = vi.fn(async (draft: { messageId: string }) => ({ messageId: draft.messageId }))
  const transcribe = vi.fn(async () => 'bystander')
  const message = new VoiceMessage('bystander', 'alice', new AudioInput({ live: true, open: () => source.stream }), submit, transcribe, undefined, (audio, signal) => prepareOwnerSpeech(audio, signal, async () => 0.12))
  source.write({ range: { sourceId: 'mic', startFrame: 0, endFrame: 16000 }, sampleRate: 16000, channels: [new Float32Array(16000).fill(0.25)] })
  await expect.poll(() => message.snapshot.phase).toBe('capturing')
  await message.finish()
  await expect.poll(() => message.snapshot.phase).toBe('failed')
  expect(transcribe).not.toHaveBeenCalled()
  expect(message.snapshot.audio).toBeUndefined()
  await expect(message.send()).rejects.toThrow('not ready')
  expect(submit).not.toHaveBeenCalled()
})

it('keeps the verified final partial window in the voice attachment and transcript', async () => {
  const source = createPushStream<PcmBlock>()
  const submit = vi.fn(async (draft: { messageId: string }) => ({ messageId: draft.messageId }))
  const recognized: number[] = []
  const message = new VoiceMessage('owner', 'alice', new AudioInput({ live: true, open: () => source.stream }), submit, async (audio) => {
    for await (const block of audio)
      recognized.push(block.channels[0].length)
    return 'owner speech'
  }, undefined, (audio, signal) => prepareOwnerSpeech(audio, signal, async () => 0.8))
  source.write({ range: { sourceId: 'mic', startFrame: 0, endFrame: 24000 }, sampleRate: 16000, channels: [new Float32Array(24000).fill(0.25)] })
  await expect.poll(() => message.snapshot.phase).toBe('capturing')
  await message.finish()
  await expect.poll(() => message.snapshot.phase).toBe('ready')
  let frames = 0
  for await (const block of fileSource(message.snapshot.audio!).open(new AbortController().signal))
    frames += block.channels[0].length
  expect(frames).toBe(24000)
  expect(recognized).toEqual([16000, 8000])
  await message.send()
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ transcript: 'owner speech' }))
})
