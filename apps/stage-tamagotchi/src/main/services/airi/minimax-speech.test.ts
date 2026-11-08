import type { BrowserWindow, WebContents } from 'electron'

import type { CompanionGateway } from './companion-gateway'

import { EventEmitter } from 'node:events'

import { defineInvoke } from '@moeru/eventa'
import { ipcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { minimaxSpeechAppend, minimaxSpeechCancel, minimaxSpeechEvent, minimaxSpeechFinish, minimaxSpeechStart } from '../../../shared/eventa/minimax-speech'
import { createWindowIpc } from '../../libs/electron/testing/window-ipc'
import { setupMinimaxSpeech } from './minimax-speech'

const boundary = vi.hoisted(() => {
  const sockets: Socket[] = []
  class Socket extends EventTarget {
    readonly readyState = 1
    readonly close = vi.fn()
    readonly sent: Array<{ event: string, text?: string }> = []
    readonly send = vi.fn((value: string) => { this.sent.push(JSON.parse(value)) })

    constructor(readonly url: string, _protocols: string[], readonly options: { headers: { Authorization: string } }) {
      super()
      sockets.push(this)
    }

    receive(event: string, payload: object = {}) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ event, ...payload }) }))
    }
  }
  return { sockets, Socket, windows: new Map<WebContents, BrowserWindow>() }
})

vi.mock('crossws/websocket', () => ({ default: boundary.Socket }))
vi.mock('electron', async () => {
  // Vitest hoists this Electron mock before static imports initialize, so the boundary mock loads its EventEmitter here.
  const { EventEmitter } = await import('node:events')
  return {
    ipcMain: new EventEmitter(),
    BrowserWindow: { fromWebContents: (sender: WebContents) => boundary.windows.get(sender) },
  }
})

const disposers: Array<() => void> = []

function openWindow() {
  const page = createWindowIpc(ipcMain)
  const lifecycle = new EventEmitter()
  Object.assign(page.window.webContents, {
    on: lifecycle.on.bind(lifecycle),
    once: lifecycle.once.bind(lifecycle),
    off: lifecycle.off.bind(lifecycle),
  })
  boundary.windows.set(page.window.webContents, page.window)
  const received: unknown[] = []
  disposers.push(page.context.on(minimaxSpeechEvent, event => received.push(event.body)))
  return { ...page, lifecycle, received }
}

function vault(getMinimaxSpeechConfig: CompanionGateway['getMinimaxSpeechConfig']): CompanionGateway {
  return {
    baseURL: 'http://127.0.0.1:1',
    token: 'test-loopback',
    status: () => ({ jevConfigured: false }),
    setJevProvider: vi.fn(),
    initializeProviderStorage: vi.fn(),
    writeProviderStorage: vi.fn(),
    getMinimaxSpeechConfig,
    close: vi.fn(),
  }
}

beforeEach(() => {
  boundary.sockets.length = 0
  boundary.windows.clear()
})

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse())
    dispose()
  ipcMain.removeAllListeners()
})

describe('desktop MiniMax speech transport', () => {
  it('uses the saved key only in a header and keeps another window out of its session', async () => {
    disposers.push(setupMinimaxSpeech(Promise.resolve(vault(async () => ({ apiKey: 'test-vault-key', baseUrl: 'https://api.minimax.cn' })))))
    const owner = openWindow()
    const other = openWindow()
    await defineInvoke(owner.context, minimaxSpeechStart)({ id: 'first', model: 'speech-2.8-turbo', voice: 'Japanese_GracefulMaiden' })
    const socket = boundary.sockets[0]
    expect(socket.url).toBe('wss://api.minimax.cn/ws/v1/t2a_v2_bidi')
    expect(socket.options.headers.Authorization).toBe('Bearer test-vault-key')
    await expect(defineInvoke(other.context, minimaxSpeechAppend)({ id: 'first', text: 'injected' })).rejects.toThrow('does not belong')
    await defineInvoke(other.context, minimaxSpeechCancel)({ id: 'first' })
    expect(socket.close).not.toHaveBeenCalled()
    await defineInvoke(owner.context, minimaxSpeechAppend)({ id: 'first', text: '原始文本。' })
    socket.receive('connected_success')
    socket.receive('task_started')
    socket.receive('sentence_start')
    socket.receive('task_continued', { data: { audio: '0000' } })
    expect(owner.received).toEqual([
      { id: 'first', event: { type: 'sentence-start' } },
      { id: 'first', event: { type: 'audio', pcm: new Uint8Array([0, 0]) } },
    ])
    expect(other.received).toEqual([])
    expect(socket.sent.filter(frame => frame.event === 'task_continue')).toEqual([{ event: 'task_continue', text: '原始文本。' }])
    await defineInvoke(owner.context, minimaxSpeechFinish)({ id: 'first' })
    socket.receive('sentence_end')
    socket.receive('task_finished')
    expect(owner.received.at(-1)).toEqual({ id: 'first', event: { type: 'finished' } })
  })

  it.each([
    'https://example.com',
    'https://api.minimax.cn@attacker.invalid',
    'https://api.minimax.cn/?key=test',
    'http://api.minimax.cn',
    'https://api.minimax.cn:8443',
  ])('does not send stored credentials to %s', async (baseUrl) => {
    disposers.push(setupMinimaxSpeech(Promise.resolve(vault(async () => ({ apiKey: 'test-vault-key', baseUrl })))))
    const owner = openWindow()
    await expect(defineInvoke(owner.context, minimaxSpeechStart)({ id: 'bad-host', model: 'speech-2.8-turbo', voice: 'test-voice' })).rejects.toThrow('official API endpoint')
    expect(boundary.sockets).toEqual([])
  })

  it('cancels a pending vault read before it creates any upstream connection', async () => {
    const pending = Promise.withResolvers<{ apiKey: string, baseUrl: string }>()
    const reading = Promise.withResolvers<void>()
    disposers.push(setupMinimaxSpeech(Promise.resolve(vault(() => {
      reading.resolve()
      return pending.promise
    }))))
    const owner = openWindow()
    const start = defineInvoke(owner.context, minimaxSpeechStart)({ id: 'pending', model: 'speech-2.8-turbo', voice: 'test-voice' })
    await reading.promise
    await defineInvoke(owner.context, minimaxSpeechCancel)({ id: 'pending' })
    pending.resolve({ apiKey: 'test-key', baseUrl: 'https://api.minimax.cn' })
    await start
    expect(boundary.sockets).toEqual([])
  })

  it.each(['destroyed', 'render-process-gone', 'did-start-navigation'])('closes synthesis on renderer %s', async (event) => {
    disposers.push(setupMinimaxSpeech(Promise.resolve(vault(async () => ({ apiKey: 'test-key', baseUrl: 'https://api.minimax.io' })))))
    const owner = openWindow()
    await defineInvoke(owner.context, minimaxSpeechStart)({ id: 'gone', model: 'speech-2.8-turbo', voice: 'test-voice' })
    const socket = boundary.sockets[0]
    socket.receive('connected_success')
    socket.receive('task_started')
    owner.lifecycle.emit(event, {}, 'https://localhost', false, true)
    expect(socket.close).toHaveBeenCalledOnce()
    socket.receive('sentence_start')
    socket.receive('task_continued', { data: { audio: '0000' } })
    expect(owner.received).toEqual([])
  })
})
