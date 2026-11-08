import type { SerializableDesktopCapturerSource } from '@proj-airi/electron-screen-capture'
import type { BrowserWindow, DesktopCapturerSource, DisplayMediaRequestHandlerHandlerRequest, Session, SourcesOptions, Streams, WebFrameMain } from 'electron'

import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'

import { createContext } from '@moeru/eventa/adapters/electron/renderer'
import { hasSelectedScreenCaptureSource, initScreenCaptureForMain, initScreenCaptureForWindow } from '@proj-airi/electron-screen-capture/main'
import { setupElectronScreenCapture } from '@proj-airi/electron-screen-capture/renderer'
import { ipcMain } from 'electron'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type DisplayHandler = NonNullable<Parameters<Session['setDisplayMediaRequestHandler']>[0]>
type RendererIpc = Parameters<typeof createContext>[0]
type SourceFixture = Pick<DesktopCapturerSource, 'id' | 'name' | 'display_id'> & {
  appIcon: null
  thumbnail: Pick<DesktopCapturerSource['thumbnail'], 'toJPEG'>
}

const electron = vi.hoisted(() => ({
  getSources: vi.fn<(options: SourcesOptions) => Promise<SourceFixture[]>>(),
  handler: null as DisplayHandler | null,
  setHandler: vi.fn<(handler: DisplayHandler | null) => void>(),
}))

vi.mock('electron', async () => {
  // Vitest runs this Electron boundary factory before the file's static imports.
  const { EventEmitter } = await import('node:events')
  return {
    app: { commandLine: { getSwitchValue: () => '', hasSwitch: () => false, appendSwitch: vi.fn() } },
    desktopCapturer: { getSources: electron.getSources },
    ipcMain: new EventEmitter(),
    shell: {},
    systemPreferences: {},
  }
})

const sourceOptions: SourcesOptions = { types: ['screen', 'window'] }
const windows: CaptureWindow[] = []
let nextWindowId = 0

/** The IPC and session boundary uses real Eventa adapters and the public capture entry points. */
class CaptureWindow extends EventEmitter {
  readonly id = ++nextWindowId
  readonly rendererIpc = new EventEmitter()
  readonly webContents = Object.assign(new EventEmitter(), {
    id: this.id,
    mainFrame: { routingId: this.id } as WebFrameMain,
    session: { setDisplayMediaRequestHandler: electron.setHandler },
    isDestroyed: () => this.destroyed,
    isCrashed: () => this.crashed,
    send: (channel: string, payload: unknown) => this.rendererIpc.emit(channel, {}, payload),
  })

  destroyed = false
  crashed = false
  readonly rendererBridge: RendererIpc = {
    on: (channel, listener) => {
      this.rendererIpc.on(channel, listener)
      return () => this.rendererIpc.off(channel, listener)
    },
    once: (channel, listener) => {
      this.rendererIpc.once(channel, listener)
      return () => this.rendererIpc.off(channel, listener)
    },
    removeAllListeners: channel => this.rendererIpc.removeAllListeners(channel),
    removeListener: (channel, listener) => {
      this.rendererIpc.removeListener(channel, listener)
      return this.rendererBridge
    },
    send: (channel, ...args) => ipcMain.emit(channel, {
      sender: this.webContents,
      senderFrame: this.webContents.mainFrame,
    }, ...args),
    invoke: vi.fn<RendererIpc['invoke']>(),
    postMessage: vi.fn<RendererIpc['postMessage']>(),
    sendSync: vi.fn<RendererIpc['sendSync']>(),
    sendTo: vi.fn<RendererIpc['sendTo']>(),
    sendToHost: vi.fn<RendererIpc['sendToHost']>(),
  }

  readonly adapter = createContext(this.rendererBridge)

  readonly capture = setupElectronScreenCapture(this.adapter.context)

  constructor() {
    super()
    initScreenCaptureForWindow(this as unknown as BrowserWindow)
    windows.push(this)
  }

  isDestroyed() { return this.destroyed }
  getTitle() { return 'Synthetic capture window' }

  close() {
    this.destroyed = true
    this.webContents.emit('destroyed')
    this.emit('closed')
    this.adapter.dispose()
  }

  request(): DisplayMediaRequestHandlerHandlerRequest {
    return {
      frame: this.webContents.mainFrame,
      securityOrigin: 'file://',
      videoRequested: true,
      audioRequested: false,
      userGesture: true,
    }
  }

  async select(source?: SerializableDesktopCapturerSource) {
    const selected = source ?? (await this.capture.getSources(sourceOptions))[0]
    return this.capture.setSource({
      options: sourceOptions,
      sourceId: selected.id,
      catalogId: selected.catalogId,
    })
  }
}

function nativeSource(id = 'window:1:0'): SourceFixture {
  return {
    id,
    name: 'Synthetic source',
    display_id: '1',
    appIcon: null,
    thumbnail: { toJPEG: () => Buffer.from('synthetic thumbnail') },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((accept, deny) => {
    resolve = accept
    reject = deny
  })
  return { promise, resolve, reject }
}

function currentHandler(): DisplayHandler {
  if (!electron.handler)
    throw new Error('No display media handler is installed')
  return electron.handler
}

describe('electron screen capture lifecycle', () => {
  beforeAll(() => {
    initScreenCaptureForMain()
  })

  beforeEach(() => {
    vi.useFakeTimers()
    electron.getSources.mockReset()
    electron.getSources.mockResolvedValue([nativeSource()])
    electron.setHandler.mockReset()
    electron.setHandler.mockImplementation((handler) => {
      electron.handler = handler
    })
  })

  afterEach(() => {
    for (const window of windows.splice(0))
      window.close()
    vi.useRealTimers()
  })

  it('finishes a slow portal selection and media startup without another picker or an active lease timeout', async () => {
    const window = new CaptureWindow()
    const portal = deferred<SourceFixture[]>()
    const media = deferred<string>()
    const source = nativeSource()
    electron.getSources.mockReturnValueOnce(portal.promise)
    const capture = window.capture.selectWithSource(
      sources => sources[0].id,
      () => {
        currentHandler()(window.request(), (streams) => {
          expect(streams.video).toBe(source)
          expect(streams).not.toHaveProperty('audio')
        })
        return media.promise
      },
      { sourcesOptions: sourceOptions },
    )

    await vi.advanceTimersByTimeAsync(6000)
    portal.resolve([source])
    await vi.advanceTimersByTimeAsync(0)
    expect(hasSelectedScreenCaptureSource()).toBe(true)
    await vi.advanceTimersByTimeAsync(6000)
    expect(hasSelectedScreenCaptureSource()).toBe(true)
    expect(electron.getSources).toHaveBeenCalledTimes(1)
    media.resolve('synthetic media ready')
    await expect(capture).resolves.toBe('synthetic media ready')
    expect(hasSelectedScreenCaptureSource()).toBe(false)
    expect(electron.handler).toBeNull()
  })

  it('rejects cancelled catalogs and missing sources without reserving the media handler', async () => {
    const window = new CaptureWindow()
    electron.getSources.mockRejectedValueOnce(new Error('Portal cancelled'))
    await expect(window.capture.getSources(sourceOptions)).rejects.toThrow('Portal cancelled')
    const [source] = await window.capture.getSources(sourceOptions)
    await expect(window.capture.setSource({
      options: sourceOptions,
      sourceId: 'missing',
      catalogId: source.catalogId,
    })).rejects.toThrow('current window catalog')
    expect(hasSelectedScreenCaptureSource()).toBe(false)
    const handle = await window.select(source)
    await window.capture.resetSource(handle)
    expect(hasSelectedScreenCaptureSource()).toBe(false)
  })

  it('keeps catalogs, reset handles and media grants isolated between windows', async () => {
    const owner = new CaptureWindow()
    const other = new CaptureWindow()
    const [selected] = await owner.capture.getSources(sourceOptions)
    await other.capture.getSources(sourceOptions)
    await expect(other.select(selected)).rejects.toThrow('current window catalog')
    const handle = await owner.select(selected)
    const handler = currentHandler()
    const denied = vi.fn()
    handler(other.request(), denied)
    expect(denied).toHaveBeenCalledExactlyOnceWith(null)
    await other.capture.resetSource(handle)
    expect(hasSelectedScreenCaptureSource()).toBe(true)
    const granted = vi.fn()
    handler(owner.request(), granted)
    expect(granted).toHaveBeenCalledTimes(1)
    expect(granted.mock.calls[0][0].video.id).toBe(selected.id)
    await owner.capture.resetSource(handle)
  })

  it('rejects a previous catalog even when the native source ID is unchanged', async () => {
    const window = new CaptureWindow()
    const [previous] = await window.capture.getSources(sourceOptions)
    const [current] = await window.capture.getSources(sourceOptions)
    expect(previous.catalogId).not.toBe(current.catalogId)
    await expect(window.select(previous)).rejects.toThrow('current window catalog')
    const handle = await window.select(current)
    await window.capture.resetSource(handle)
  })

  it('rejects late catalog results instead of replacing a newer selection', async () => {
    const window = new CaptureWindow()
    const portal = deferred<SourceFixture[]>()
    electron.getSources.mockReturnValueOnce(portal.promise)
    const previous = window.capture.getSources(sourceOptions)
    const rejected = expect(previous).rejects.toThrow('no longer current')
    const [current] = await window.capture.getSources(sourceOptions)
    portal.resolve([nativeSource('window:old:0')])
    await rejected
    const handle = await window.select(current)
    const granted = vi.fn()
    currentHandler()(window.request(), granted)
    expect(granted.mock.calls[0][0].video.id).toBe(current.id)
    await window.capture.resetSource(handle)
  })

  it('expires unused selections and rejects their late callbacks without releasing the next request', async () => {
    const window = new CaptureWindow()
    const previous = await window.select()
    const oldHandler = currentHandler()
    await vi.advanceTimersByTimeAsync(5001)
    expect(hasSelectedScreenCaptureSource()).toBe(false)
    const current = await window.select()
    const handler = currentHandler()
    const denied = vi.fn()
    oldHandler(window.request(), denied)
    expect(denied).toHaveBeenCalledExactlyOnceWith(null)
    await window.capture.resetSource(previous)
    expect(currentHandler()).toBe(handler)
    expect(hasSelectedScreenCaptureSource()).toBe(true)
    await window.capture.resetSource(current)
  })

  it('denies a cancelled selection and permits a subsequent request', async () => {
    const window = new CaptureWindow()
    const previous = await window.select()
    const oldHandler = currentHandler()
    await window.capture.resetSource(previous)
    const current = await window.select()
    const denied = vi.fn()
    oldHandler(window.request(), denied)
    expect(denied).toHaveBeenCalledExactlyOnceWith(null)
    expect(hasSelectedScreenCaptureSource()).toBe(true)
    const granted = vi.fn()
    currentHandler()(window.request(), granted)
    expect(granted.mock.calls[0][0].video.id).toBe('window:1:0')
    await window.capture.resetSource(current)
  })

  it('grants only one request per selected handle', async () => {
    const window = new CaptureWindow()
    const handle = await window.select()
    const handler = currentHandler()
    const first = vi.fn()
    const second = vi.fn()
    handler(window.request(), first)
    handler(window.request(), second)
    expect(first).toHaveBeenCalledTimes(1)
    expect(first.mock.calls[0][0].video.id).toBe('window:1:0')
    expect(second).toHaveBeenCalledExactlyOnceWith(null)
    expect(hasSelectedScreenCaptureSource()).toBe(true)
    await window.capture.resetSource(handle)
  })

  it.each(['navigation', 'crash', 'close'] as const)('releases %s owners and prevents stale work from changing another window', async (event) => {
    const owner = new CaptureWindow()
    const other = new CaptureWindow()
    await owner.select()
    const oldHandler = currentHandler()
    if (event === 'navigation') {
      owner.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    }
    else if (event === 'crash') {
      owner.crashed = true
      owner.webContents.emit('render-process-gone')
    }
    else {
      owner.close()
    }
    expect(hasSelectedScreenCaptureSource()).toBe(false)
    const handle = await other.select()
    const handler = currentHandler()
    const denied = vi.fn()
    oldHandler(owner.request(), denied)
    expect(denied).toHaveBeenCalledExactlyOnceWith(null)
    owner.webContents.emit('render-process-gone')
    expect(currentHandler()).toBe(handler)
    await other.capture.resetSource(handle)
  })

  it('rejects catalog completion after the renderer navigates', async () => {
    const window = new CaptureWindow()
    const portal = deferred<SourceFixture[]>()
    electron.getSources.mockReturnValueOnce(portal.promise)
    const pending = window.capture.getSources(sourceOptions)
    const rejected = expect(pending).rejects.toThrow('no longer current')
    await vi.advanceTimersByTimeAsync(0)
    window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    portal.resolve([nativeSource()])
    await rejected
    expect(hasSelectedScreenCaptureSource()).toBe(false)
  })

  it('rejects a selection queued by a page that navigates before the mutex is available', async () => {
    const owner = new CaptureWindow()
    const waiting = new CaptureWindow()
    const handle = await owner.select()
    const [source] = await waiting.capture.getSources(sourceOptions)
    const queued = waiting.select(source)
    const rejected = expect(queued).rejects.toThrow('no longer current')
    await vi.advanceTimersByTimeAsync(0)
    waiting.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    await owner.capture.resetSource(handle)
    await rejected
    expect(hasSelectedScreenCaptureSource()).toBe(false)
    const next = await owner.select()
    await owner.capture.resetSource(next)
  })

  it('releases a failed native callback without invoking it twice', async () => {
    const window = new CaptureWindow()
    await window.select()
    const callback = vi.fn((_streams: Streams) => {
      throw new Error('Native request ended')
    })
    expect(() => currentHandler()(window.request(), callback)).not.toThrow()
    expect(callback).toHaveBeenCalledTimes(1)
    expect(hasSelectedScreenCaptureSource()).toBe(false)
    const next = await window.select()
    await window.capture.resetSource(next)
  })

  it('does not release the selected owner when another frame rejects its callback', async () => {
    const owner = new CaptureWindow()
    const other = new CaptureWindow()
    const handle = await owner.select()
    const denied = vi.fn(() => {
      throw new Error('Foreign frame closed')
    })
    currentHandler()(other.request(), denied)
    expect(denied).toHaveBeenCalledExactlyOnceWith(null)
    expect(hasSelectedScreenCaptureSource()).toBe(true)
    await owner.capture.resetSource(handle)
  })

  it('releases the mutex when Electron cannot install the request handler', async () => {
    const window = new CaptureWindow()
    electron.setHandler.mockImplementationOnce(() => {
      throw new Error('Session unavailable')
    })
    await expect(window.select()).rejects.toThrow('Session unavailable')
    expect(hasSelectedScreenCaptureSource()).toBe(false)
    const handle = await window.select()
    await window.capture.resetSource(handle)
  })
})
