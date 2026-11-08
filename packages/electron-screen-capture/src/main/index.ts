// SPDX-FileCopyrightText: Copyright (c) Alec Armbruster, Licensed under MIT License
// SPDX-FileCopyrightText: Copyright (c) Moeru AI Project AIRI Team

import type { Format, LogLevelString } from '@guiiai/logg'
import type { MutexInterface } from 'async-mutex'
import type { BrowserWindow, DesktopCapturerSource, Session, SourcesOptions, Streams } from 'electron'

import { useLogg } from '@guiiai/logg'
import { defineInvokeHandler } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/main'
import { Mutex, withTimeout } from 'async-mutex'
import { app, desktopCapturer, ipcMain } from 'electron'
import { nanoid } from 'nanoid'

import { screenCapture } from '..'
import {
  checkMacOSScreenCapturePermission,
  requestMacOSScreenCapturePermission,
  toSerializableDesktopCapturerSource,
} from './utils'

export const defaultSourcesOptions: SourcesOptions = { types: ['screen'] }

export const featureSwitchKey = 'enable-features' as const

export enum LoopbackAudioTypes {
  Loopback = 'loopback',
  LoopbackWithMute = 'loopbackWithMute',
}

enum DefaultFeatureFlags {
  PulseaudioLoopbackForScreenShare = 'PulseaudioLoopbackForScreenShare',
  /**
   * Note(Makito): Some discussions on this flag can be found here:
   *
   * - {@link https://issues.chromium.org/issues/355308245}
   * - {@link https://issues.chromium.org/issues/394329567}
   */
  MacLoopbackAudioForScreenShare = 'MacLoopbackAudioForScreenShare',
}

enum CoreAudioTapFeatureFlags {
  MacCoreAudioTapSystemAudioLoopbackOverride = 'MacCatapSystemAudioLoopbackCapture',
}

enum ScreenCaptureKitFeatureFlags {
  MacScreenCaptureKitSystemAudioLoopbackOverride = 'MacSckSystemAudioLoopbackOverride',
}

export function buildFeatureFlags({
  otherEnabledFeatures,
  forceCoreAudioTap,
}: {
  otherEnabledFeatures?: string[]
  forceCoreAudioTap?: boolean
}): string {
  const featureFlags = [...Object.values(DefaultFeatureFlags), ...(otherEnabledFeatures ?? [])]

  if (forceCoreAudioTap) {
    featureFlags.push(CoreAudioTapFeatureFlags.MacCoreAudioTapSystemAudioLoopbackOverride)
  }
  else {
    featureFlags.push(ScreenCaptureKitFeatureFlags.MacScreenCaptureKitSystemAudioLoopbackOverride)
  }

  return featureFlags.join(',')
}

let initMainCalled = false

export interface InitMainOptions {
  forceCoreAudioTap?: boolean
  mutexAcquireTimeout?: number
  loggerOptions?: {
    logLevel?: string
    format?: 'json' | 'plain'
  }
}

export interface InitWindowOptions {
  loopbackWithMute?: boolean
  sourcesOptions?: SourcesOptions
  onAfterGetSources?: (sources: DesktopCapturerSource[]) => DesktopCapturerSource[]
  loggerOptions?: {
    logLevel?: string
    format?: 'json' | 'plain'
  }
}

export interface GetLoopbackAudioMediaStreamOptions {
  removeVideo?: boolean
}

interface CaptureSelection {
  handle: string
  windowId: number
  session: Session
  release: MutexInterface.Releaser
  timeout?: NodeJS.Timeout
  started: boolean
}

// A selection owns the session handler until reset or owner disposal. Only an unused selection expires.
// The window catalog ID rejects stale selections. The handle and frame bind one media request to its owner.
let setSourceMutex: MutexInterface
let activeSelection: CaptureSelection | undefined

export function initScreenCaptureForMain(options: InitMainOptions = {}): void {
  const {
    forceCoreAudioTap = false,
    mutexAcquireTimeout = 5000,
  } = options

  let log = useLogg('screen-capture').useGlobalConfig()
  if (options?.loggerOptions?.logLevel) {
    log = log.withLogLevelString((options?.loggerOptions?.logLevel ?? 'info') as LogLevelString)
  }
  if (options?.loggerOptions?.format) {
    log = log.withFormat((options?.loggerOptions?.format ?? 'plain') as Format)
  }

  if (mutexAcquireTimeout <= 0 || !Number.isFinite(mutexAcquireTimeout) || Number.isNaN(mutexAcquireTimeout)) {
    throw new Error('mutexAcquireTimeout must be a positive finite number')
  }

  if (initMainCalled) {
    log.warn('initScreenCaptureForMain should only be called once')
    return
  }
  initMainCalled = true
  setSourceMutex = withTimeout(new Mutex(), mutexAcquireTimeout)

  // Get other enabled features from the command line.
  const otherEnabledFeatures = app.commandLine.getSwitchValue(featureSwitchKey)?.split(',')

  // Remove the switch if it exists.
  if (app.commandLine.hasSwitch(featureSwitchKey)) {
    app.commandLine.removeSwitch(featureSwitchKey)
  }

  // Add the feature flags to the command line with any other user-enabled features concatenated.
  const currentFeatureFlags = buildFeatureFlags({
    otherEnabledFeatures,
    forceCoreAudioTap,
  })

  app.commandLine.appendSwitch(featureSwitchKey, currentFeatureFlags)
}

function releaseSelection(selection: CaptureSelection) {
  if (activeSelection !== selection)
    return

  activeSelection = undefined
  clearTimeout(selection.timeout)
  try {
    selection.session.setDisplayMediaRequestHandler(null)
  }
  catch (error) {
    useLogg('screen-capture').withError(error).error('Failed to reset the display media handler')
  }
  finally {
    selection.release()
  }
}

/**
 * Reports whether a renderer-selected capture source is currently being served.
 *
 * Use when:
 * - A permission handler has to tell AIRI's own display capture flow apart from an unsolicited request
 *
 * Expects:
 * - `initScreenCaptureForWindow` installed the invoke handlers that own the selection mutex
 *
 * Returns:
 * - Whether `setDisplayMediaRequestHandler` is currently bound to a source picked by a renderer
 */
export function hasSelectedScreenCaptureSource(): boolean {
  return activeSelection !== undefined
}

const initializedWindows = new WeakSet<BrowserWindow>()

// NOTICE: use this to guard to prevent handling destroyed window
// especially when trying to get window title,
// but window.id is another story as window.id is stable and unique even
// after window is destroyed
function tryWindowTitle(window: BrowserWindow, previous?: string): string {
  if (window.isDestroyed()) {
    return previous || '<destroyed>'
  }

  const title = window.getTitle()
  return title
}

export function initScreenCaptureForWindow(window: BrowserWindow, options?: InitWindowOptions): void {
  let log = useLogg('screen-capture').useGlobalConfig()
  if (options?.loggerOptions?.logLevel) {
    log = log.withLogLevelString((options?.loggerOptions?.logLevel ?? 'info') as LogLevelString)
  }
  if (options?.loggerOptions?.format) {
    log = log.withFormat((options?.loggerOptions?.format ?? 'plain') as Format)
  }

  const windowId = window.id
  const windowTitle = tryWindowTitle(window)

  log.withFields({ windowId, windowTitle: tryWindowTitle(window, windowTitle) }).debug(`init for window`)

  if (!initMainCalled) {
    // Throwing an error because this is unlikely to be recoverable.
    throw new Error('initScreenCaptureForMain must be called before calling initScreenCaptureForWindow')
  }
  if (initializedWindows.has(window)) {
    log.withFields({ windowId, windowTitle: tryWindowTitle(window, windowTitle) }).warn('initScreenCaptureForWindow should only be called once per window')
    return
  }

  initializedWindows.add(window)

  const { context, dispose } = createContext(ipcMain, window, { onlySameWindow: true })
  const webContents = window.webContents
  const session = webContents.session
  const catalog = new Map<string, DesktopCapturerSource>()
  let catalogId: string | undefined
  let generation = 0

  function isWindowAvailable() {
    return !window.isDestroyed() && !webContents.isDestroyed() && !webContents.isCrashed()
  }

  function invalidateWindow() {
    generation++
    catalogId = undefined
    catalog.clear()
    if (activeSelection?.windowId === windowId)
      releaseSelection(activeSelection)
  }

  webContents.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument)
      invalidateWindow()
  })
  webContents.on('render-process-gone', invalidateWindow)
  webContents.once('destroyed', () => {
    invalidateWindow()
    dispose()
  })
  window.once('closed', invalidateWindow)

  defineInvokeHandler(context, screenCapture.checkMacOSPermission, async () => checkMacOSScreenCapturePermission())
  defineInvokeHandler(context, screenCapture.requestMacOSPermission, async () => requestMacOSScreenCapturePermission())

  defineInvokeHandler(context, screenCapture.getSources, async (sourcesOptions, eventaOptions) => {
    const sender = eventaOptions?.raw.ipcMainEvent
    if (!isWindowAvailable() || sender?.sender !== webContents || sender.senderFrame !== webContents.mainFrame)
      throw new Error('Screen sources require the current window main frame')

    const frame = webContents.mainFrame
    const requestedCatalogId = nanoid()
    catalogId = requestedCatalogId
    catalog.clear()

    try {
      // PipeWire opens its system picker here. Keep this native snapshot for the later media request.
      // Electron accepts its source ID and name without another enumeration: docs/api/session.md.
      const sources = await desktopCapturer.getSources(sourcesOptions)
      if (!isWindowAvailable() || webContents.mainFrame !== frame || catalogId !== requestedCatalogId)
        throw new Error('The screen source selection is no longer current')

      const result = sources.map(source => toSerializableDesktopCapturerSource(source, requestedCatalogId))
      for (const source of sources)
        catalog.set(source.id, source)
      return result
    }
    catch (error) {
      if (catalogId === requestedCatalogId) {
        catalogId = undefined
        catalog.clear()
      }
      throw error
    }
  })

  defineInvokeHandler(context, screenCapture.setSource, async (request, eventaOptions) => {
    const sender = eventaOptions?.raw.ipcMainEvent
    if (!isWindowAvailable() || sender?.sender !== webContents || sender.senderFrame !== webContents.mainFrame)
      throw new Error('Screen capture requires the current window main frame')

    const { timeout } = request
    if (typeof timeout === 'number' && (timeout <= 0 || !Number.isFinite(timeout)))
      throw new Error('timeout must be a positive finite number')

    const frame = webContents.mainFrame
    const requestGeneration = generation
    const source = catalog.get(request.sourceId)
    if (!source || request.catalogId !== catalogId)
      throw new Error('The selected screen source is not in the current window catalog')

    const release = await setSourceMutex.acquire()
    if (!isWindowAvailable() || generation !== requestGeneration || webContents.mainFrame !== frame || request.catalogId !== catalogId) {
      release()
      throw new Error('The screen source selection is no longer current')
    }

    const selection: CaptureSelection = { handle: nanoid(), windowId, session, release, started: false }
    activeSelection = selection

    try {
      session.setDisplayMediaRequestHandler((mediaRequest, callback) => {
        let answered = false
        let ownsRequest = false
        function answer(streams: Streams | null) {
          if (answered)
            return
          answered = true
          // NOTICE:
          // Electron 43 accepts null to deny a request, but its declaration omits null.
          // Source: electron v43.8.4 shell/browser/electron_browser_context.cc, DisplayMediaDeviceChosen.
          // Remove this assertion when Electron's callback declaration includes null.
          const respond = callback as (streams: Streams | null) => void
          respond(streams)
        }

        try {
          if (activeSelection !== selection || selection.started || !isWindowAvailable()
            || generation !== requestGeneration || mediaRequest.frame !== frame) {
            answer(null)
            return
          }
          ownsRequest = true
          if (catalogId !== request.catalogId) {
            answer(null)
            releaseSelection(selection)
            return
          }

          selection.started = true
          clearTimeout(selection.timeout)
          selection.timeout = undefined
          const streams: Streams = { video: source }
          if (mediaRequest.audioRequested)
            streams.audio = options?.loopbackWithMute ? LoopbackAudioTypes.LoopbackWithMute : LoopbackAudioTypes.Loopback
          answer(streams)
        }
        catch (error) {
          log.withFields({ windowId }).withError(error).error('Display media request failed')
          try {
            answer(null)
          }
          catch (denialError) {
            log.withFields({ windowId }).withError(denialError).error('Display media rejection failed')
          }
          if (ownsRequest)
            releaseSelection(selection)
        }
      })

      selection.timeout = setTimeout(() => {
        if (activeSelection !== selection || selection.started)
          return
        releaseSelection(selection)
        log.withFields({ windowId }).warn('Unused screen capture selection expired before getDisplayMedia started')
      }, timeout ?? 5000)

      return selection.handle
    }
    catch (error) {
      releaseSelection(selection)
      throw error
    }
  })

  defineInvokeHandler(context, screenCapture.resetSource, async (handle, eventaOptions) => {
    if (!isWindowAvailable() || eventaOptions?.raw.ipcMainEvent.sender !== webContents
      || eventaOptions.raw.ipcMainEvent.senderFrame !== webContents.mainFrame) {
      return
    }
    if (activeSelection?.windowId !== windowId || activeSelection.handle !== handle)
      return
    releaseSelection(activeSelection)
  })
}
