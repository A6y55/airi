import type { SpeechAudio, SpeechOutput } from '@proj-airi/core-agent'
import type { PcmBlock } from '@proj-airi/pipelines-audio'
import type { MinimaxSpeechConnection, MinimaxSpeechEvent, MinimaxSpeechOptions } from '@proj-airi/provider-inference/minimax-speech'
import type { StreamController } from '@proj-airi/stream-kit'

import { toFloat32FromPCM16 } from '@proj-airi/audio/encoding'
import { createPushStream } from '@proj-airi/stream-kit'
import { nanoid } from 'nanoid/non-secure'

let connect: ((options: MinimaxSpeechOptions) => MinimaxSpeechConnection) | undefined

/** The desktop entry installs its authenticated transport before creating stores. Other clients keep HTTP speech. */
export function configureMinimaxSpeech(transport: (options: MinimaxSpeechOptions) => MinimaxSpeechConnection) {
  connect = transport
}

/** Captures the installed transport. Audio reaches playback while the input text reader is still open. */
export function createMinimaxSpeechStream(options: MinimaxSpeechOptions): Extract<SpeechOutput, { stream: unknown }>['stream'] | undefined {
  const transport = connect
  if (!transport)
    return
  return async (text, signal) => {
    signal.throwIfAborted()
    return new SpeechSession(transport(options), text, signal).output.stream
  }
}

// Text and provider events advance independently. Each sentence owns one live PCM stream, never a collected audio buffer.
// Abort, reader cancellation, and transport failure close both pumps. Only finished after text EOF is successful completion.
class SpeechSession {
  readonly output = createPushStream<SpeechAudio>(() => this.stop(new DOMException('Speech output cancelled', 'AbortError')))
  private readonly textReader: ReadableStreamDefaultReader<string>
  private readonly eventReader: ReadableStreamDefaultReader<MinimaxSpeechEvent>
  private readonly sourceId = nanoid()
  private frame = 0
  private closed = false
  private textEnded = false
  private sentence: StreamController<PcmBlock> | undefined
  private sentencePublished = false
  private pendingByte: number | undefined

  constructor(private readonly connection: MinimaxSpeechConnection, text: ReadableStream<string>, private readonly signal: AbortSignal) {
    this.textReader = text.getReader()
    this.eventReader = connection.events.getReader()
    signal.addEventListener('abort', this.abort, { once: true })
    if (signal.aborted)
      this.abort()
    void this.sendText()
    void this.receiveAudio()
  }

  private async sendText() {
    try {
      while (!this.closed) {
        const next = await this.textReader.read()
        if (this.closed)
          return
        if (next.done) {
          this.textEnded = true
          await this.connection.finish()
          return
        }
        await this.connection.appendText(next.value)
      }
    }
    catch (error) {
      this.stop(error)
    }
    finally {
      this.textReader.releaseLock()
    }
  }

  private async receiveAudio() {
    try {
      while (!this.closed) {
        const next = await this.eventReader.read()
        if (this.closed)
          return
        if (next.done)
          throw new Error('MiniMax speech transport ended before synthesis finished.')
        const event = next.value
        switch (event.type) {
          case 'sentence-start':
            if (this.sentence)
              throw new Error('MiniMax speech overlapped sentence boundaries.')
            this.sentence = createPushStream<PcmBlock>(() => this.stop(new DOMException('Speech playback cancelled', 'AbortError')))
            this.sentencePublished = false
            break
          case 'audio':
            this.writeAudio(event.pcm)
            break
          case 'sentence-end':
            if (!this.sentence || this.pendingByte !== undefined)
              throw new Error('MiniMax speech ended an incomplete PCM sentence.')
            this.sentence.close()
            this.sentence = undefined
            break
          case 'finished':
            if (!this.textEnded || this.sentence)
              throw new Error('MiniMax speech finished before its input or audio ended.')
            this.stop()
            return
          case 'error':
            throw new Error(event.message)
        }
      }
    }
    catch (error) {
      this.stop(error)
    }
    finally {
      this.eventReader.releaseLock()
    }
  }

  private writeAudio(bytes: Uint8Array) {
    if (!this.sentence)
      throw new Error('MiniMax speech audio has no sentence.')
    if (this.pendingByte !== undefined) {
      const combined = new Uint8Array(bytes.byteLength + 1)
      combined[0] = this.pendingByte
      combined.set(bytes, 1)
      bytes = combined
      this.pendingByte = undefined
    }
    if (bytes.byteLength % 2) {
      this.pendingByte = bytes[bytes.byteLength - 1]
      bytes = bytes.subarray(0, -1)
    }
    if (!bytes.byteLength)
      return
    const samples = toFloat32FromPCM16(bytes)
    const block: PcmBlock = {
      range: { sourceId: this.sourceId, startFrame: this.frame, endFrame: this.frame + samples.length },
      sampleRate: 32000,
      channels: [samples],
    }
    this.frame += samples.length
    this.sentence.write(block)
    if (!this.sentencePublished) {
      this.sentencePublished = true
      // MiniMax sentence boundaries carry no text. SpeechAudio permits audio without a display-text projection.
      this.output.write({ audio: this.sentence.stream })
    }
  }

  private readonly abort = () => this.stop(this.signal.reason ?? new DOMException('Speech synthesis cancelled', 'AbortError'))

  private stop(error?: unknown) {
    if (this.closed)
      return
    this.closed = true
    this.signal.removeEventListener('abort', this.abort)
    this.connection.cancel()
    // A reader can already be released after normal input EOF. Cancellation then rejects without owning further resources.
    void this.textReader.cancel(error).catch(() => {})
    void this.eventReader.cancel(error).catch(() => {})
    if (error !== undefined) {
      this.sentence?.error(error)
      this.output.error(error)
    }
    else {
      this.output.close()
    }
    this.sentence = undefined
  }
}
