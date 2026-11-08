import type { MinimaxSpeechConnection, MinimaxSpeechEvent, MinimaxSpeechOptions } from '@proj-airi/provider-inference/minimax-speech'

import { defineInvoke } from '@moeru/eventa'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'
import { configureMinimaxSpeech } from '@proj-airi/stage-ui/libs/speech/minimax-speech'

import { minimaxSpeechAppend, minimaxSpeechCancel, minimaxSpeechEvent, minimaxSpeechFinish, minimaxSpeechStart } from '../../shared/eventa/minimax-speech'

/** Installs the desktop speech transport before the shared speech store captures output settings. */
export function initializeMinimaxSpeech() {
  configureMinimaxSpeech(options => new DesktopSpeechConnection(options))
}

// The listener exists before start invokes main. UUID + main's WebContents ownership isolates every response and renderer.
class DesktopSpeechConnection implements MinimaxSpeechConnection {
  private readonly id = crypto.randomUUID()
  private readonly context = getElectronEventaContext()
  private readonly append = defineInvoke(this.context, minimaxSpeechAppend)
  private readonly end = defineInvoke(this.context, minimaxSpeechFinish)
  private readonly abort = defineInvoke(this.context, minimaxSpeechCancel)
  private readonly started: Promise<void>
  private readonly unsubscribe: () => void
  private controller!: ReadableStreamDefaultController<MinimaxSpeechEvent>
  private closed = false
  readonly events = new ReadableStream<MinimaxSpeechEvent>({
    start: (controller) => { this.controller = controller },
    cancel: () => this.cancel(),
  })

  constructor(options: MinimaxSpeechOptions) {
    this.unsubscribe = this.context.on(minimaxSpeechEvent, ({ body }) => {
      if (this.closed || body?.id !== this.id)
        return
      this.controller.enqueue(body.event)
      if (body.event.type === 'finished' || body.event.type === 'error') {
        this.controller.close()
        this.dispose()
      }
    })
    window.addEventListener('pagehide', this.cancel, { once: true })
    this.started = defineInvoke(this.context, minimaxSpeechStart)({ id: this.id, ...options })
    void this.started.catch((error: unknown) => {
      if (this.closed)
        return
      this.controller.error(error)
      this.cancel()
    })
  }

  async appendText(text: string) {
    await this.started
    if (!this.closed)
      await this.append({ id: this.id, text })
  }

  async finish() {
    await this.started
    if (!this.closed)
      await this.end({ id: this.id })
  }

  readonly cancel = () => {
    if (this.closed)
      return
    this.dispose()
    // Main reserves the ID before awaiting storage, so cancellation also stops a pending start.
    void this.abort({ id: this.id }).catch(() => {
      // A disconnected renderer cannot send IPC. Main also closes sessions on renderer loss and navigation.
    })
  }

  private dispose() {
    this.closed = true
    this.unsubscribe()
    window.removeEventListener('pagehide', this.cancel)
  }
}
