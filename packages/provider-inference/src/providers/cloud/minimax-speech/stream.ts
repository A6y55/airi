import { errorMessageFrom } from '@moeru/std'
import { number, object, optional, parse, string } from 'valibot'

/** Public synthesis settings. The desktop host resolves credentials and the endpoint separately. */
export interface MinimaxSpeechOptions {
  model: string
  voice: string
}

/** Ordered output from one connection. Sentence boundaries enclose mono PCM16 audio at 32 kHz. */
export type MinimaxSpeechEvent
  = | { type: 'sentence-start' }
    | { type: 'audio', pcm: Uint8Array }
    | { type: 'sentence-end' }
    | { type: 'finished' }
    | { type: 'error', message: string }

/** A platform transport owns its connection and releases it when either stream is cancelled. */
export interface MinimaxSpeechConnection {
  events: ReadableStream<MinimaxSpeechEvent>
  appendText: (text: string) => Promise<void>
  finish: () => Promise<void>
  cancel: () => void
}

const serverEvent = object({
  event: optional(string()),
  data: optional(object({ audio: optional(string()) })),
  base_resp: optional(object({ status_code: optional(number()), status_msg: optional(string()) })),
})

/**
 * Owns one MiniMax bidi session on an authenticated socket.
 * Connecting → starting → ready → finishing → closed. Text queues until task_started.
 * Only task_finished completes the session. is_final completes one synthesis request, not the connection.
 * Source: https://platform.minimax.io/docs/api-reference/speech-t2a-websocket-bidi
 */
export class MinimaxSpeechSession {
  private state: 'connecting' | 'starting' | 'ready' | 'finishing' | 'closed' = 'connecting'
  private readonly pending: string[] = []
  private textEnded = false
  private sentenceOpen = false
  private readonly startupTimeout: ReturnType<typeof setTimeout>

  constructor(
    private readonly socket: Pick<WebSocket, 'send' | 'close' | 'readyState' | 'addEventListener' | 'removeEventListener'>,
    private readonly options: MinimaxSpeechOptions,
    private readonly onEvent: (event: MinimaxSpeechEvent) => void,
  ) {
    socket.addEventListener('message', this.receive)
    socket.addEventListener('error', this.socketError)
    socket.addEventListener('close', this.socketClose)
    this.startupTimeout = setTimeout(() => this.fail('MiniMax speech did not start within 30 seconds.'), 30_000)
  }

  appendText(text: string) {
    if (this.state === 'closed' || this.textEnded)
      throw new Error('MiniMax speech no longer accepts text.')
    // The protocol rejects one frame above 10,000 characters. Split only at a code point boundary.
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(offset + 10_000, text.length)
      const last = text.charCodeAt(end - 1)
      if (end < text.length && last >= 0xD800 && last <= 0xDBFF)
        end--
      const part = text.slice(offset, end)
      if (this.state === 'ready')
        this.send({ event: 'task_continue', text: part })
      else
        this.pending.push(part)
      offset = end
    }
  }

  /** Text EOF flushes the last unpunctuated sentence before the server closes the connection. */
  finish() {
    if (this.state === 'closed' || this.textEnded)
      return
    this.textEnded = true
    if (this.state === 'ready')
      this.finishReady()
  }

  /** Cancellation never waits for an acknowledgement and never publishes subsequent socket events. */
  cancel() {
    if (this.state === 'closed')
      return
    if (this.state === 'ready' || this.state === 'finishing') {
      try {
        this.socket.send(JSON.stringify({ event: 'task_cancel' }))
      }
      catch {
        // Closing the connection also cancels synthesis when the cancel frame cannot be sent.
      }
    }
    this.close()
  }

  private finishReady() {
    this.state = 'finishing'
    this.send({ event: 'task_finish' })
  }

  private send(message: object) {
    try {
      this.socket.send(JSON.stringify(message))
    }
    catch {
      const message = 'MiniMax speech could not send a WebSocket frame.'
      this.fail(message)
      throw new Error(message)
    }
  }

  private readonly receive = (message: MessageEvent) => {
    if (this.state === 'closed')
      return
    try {
      if (typeof message.data !== 'string')
        throw new Error('MiniMax speech returned a non-JSON frame.')
      const event = parse(serverEvent, JSON.parse(message.data))
      const code = event.base_resp?.status_code
      if (code !== undefined && code !== 0) {
        // No per-text acknowledgement identifies a rejected frame. Fail explicitly instead of losing or duplicating spoken text.
        // This includes soft refusals 2204 and 2205. Never treat a partial reply as successful speech.
        this.fail(`MiniMax speech ${code}: ${event.base_resp?.status_msg ?? 'Synthesis rejected.'}`)
        return
      }
      switch (event.event) {
        case 'connected_success':
          if (this.state !== 'connecting')
            throw new Error('MiniMax speech repeated its connection handshake.')
          this.state = 'starting'
          this.send({
            event: 'task_start',
            model: this.options.model,
            voice_setting: { voice_id: this.options.voice, speed: 1, vol: 1, pitch: 0 },
            audio_setting: { sample_rate: 32000, format: 'pcm', channel: 1 },
          })
          break
        case 'task_started':
          if (this.state !== 'starting')
            throw new Error('MiniMax speech returned an unexpected task_started event.')
          clearTimeout(this.startupTimeout)
          this.state = 'ready'
          for (const text of this.pending) {
            if (this.state !== 'ready')
              break
            this.send({ event: 'task_continue', text })
          }
          this.pending.length = 0
          if (this.textEnded && this.state === 'ready')
            this.finishReady()
          break
        case 'sentence_start':
          if ((this.state !== 'ready' && this.state !== 'finishing') || this.sentenceOpen)
            throw new Error('MiniMax speech returned an unexpected sentence boundary.')
          this.sentenceOpen = true
          this.onEvent({ type: 'sentence-start' })
          break
        // The official task_continued example omits event. Its data.audio still belongs to the open sentence.
        case undefined:
        case 'task_continued':
          if (event.data?.audio) {
            if (!this.sentenceOpen)
              throw new Error('MiniMax speech returned audio outside a sentence.')
            const hex = event.data.audio
            if (hex.length % 2 || /[^\da-f]/i.test(hex))
              throw new Error('MiniMax speech returned invalid hexadecimal audio.')
            const pcm = new Uint8Array(hex.length / 2)
            for (let index = 0; index < pcm.length; index++)
              pcm[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
            this.onEvent({ type: 'audio', pcm })
          }
          break
        case 'sentence_end':
          if (!this.sentenceOpen)
            throw new Error('MiniMax speech ended a sentence that never started.')
          this.sentenceOpen = false
          this.onEvent({ type: 'sentence-end' })
          break
        case 'task_finished':
          if (this.state !== 'finishing' || this.sentenceOpen)
            throw new Error('MiniMax speech finished before its text or sentence ended.')
          this.close()
          this.onEvent({ type: 'finished' })
          break
        case 'task_failed':
        case 'task_canceled':
          this.fail(`MiniMax speech stopped unexpectedly: ${event.event}.`)
          break
      }
    }
    catch (error) {
      this.fail(errorMessageFrom(error) ?? 'MiniMax speech returned an invalid event.')
    }
  }

  private readonly socketError = () => this.fail('MiniMax speech WebSocket connection failed.')
  private readonly socketClose = () => this.fail('MiniMax speech disconnected before task_finished.')

  private fail(message: string) {
    if (this.state === 'closed')
      return
    this.close()
    this.onEvent({ type: 'error', message })
  }

  private close() {
    this.state = 'closed'
    this.pending.length = 0
    clearTimeout(this.startupTimeout)
    this.socket.removeEventListener('message', this.receive)
    this.socket.removeEventListener('close', this.socketClose)
    // Keep the error listener through close. Node ws can emit an error when a connecting socket is cancelled.
    try {
      this.socket.close()
    }
    catch {
      // The socket can already be closed after a transport error.
    }
  }
}
