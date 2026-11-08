import type { SerializableDesktopCapturerSource } from '@proj-airi/electron-screen-capture'
import type { Pinia } from 'pinia'

import messages from '@proj-airi/i18n/locales'

import { useLLM } from '@proj-airi/stage-ui/stores/ai/chat-llm/llm'
import { useModsServerChannelStore } from '@proj-airi/stage-ui/stores/mods/api/channel-server'
import { useVisionActivityStore, useVisionProcessingStore, useVisionStore } from '@proj-airi/stage-ui/stores/modules/vision'
import { useProviderStore } from '@proj-airi/stage-ui/stores/providers/provider'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { render } from 'vitest-browser-vue'
import { effectScope, h, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'

import VisionCapture from '../../components/vision-capture.vue'
import VisionCaptureEntry from './vision.vue'

import { useVisionScreenCapture } from '../../composables/use-vision-screen-capture'
import { useVisionCaptureSettingsStore } from '../../stores/vision-capture-settings'

const captureIpc = vi.hoisted(() => ({
  getSources: vi.fn<() => Promise<SerializableDesktopCapturerSource[]>>(),
  setSource: vi.fn<() => Promise<string>>(),
  resetSource: vi.fn<() => Promise<void>>(),
  checkMacOSPermission: vi.fn<() => Promise<string>>(),
  requestMacOSPermission: vi.fn<() => Promise<void>>(),
  openWindow: vi.fn<() => Promise<void>>(),
}))

vi.mock('@proj-airi/electron-vueuse', () => ({
  getElectronEventaContext: () => ({}),
  useElectronEventaInvoke: () => captureIpc.openWindow,
}))

vi.mock('@proj-airi/electron-screen-capture/vue', () => ({
  useElectronScreenCapture: () => captureIpc,
}))

function source(id: string, name: string): SerializableDesktopCapturerSource {
  return { id, name, catalogId: 'catalog', display_id: '', thumbnail: new Uint8Array() }
}

function canvasStream(drawFrames = true) {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 40
  const stream = canvas.captureStream(10)
  let frame: number | undefined
  if (drawFrames) {
    const context = canvas.getContext('2d')!
    const draw = () => {
      context.fillStyle = '#ff0000'
      context.fillRect(0, 0, canvas.width, canvas.height)
      frame = requestAnimationFrame(draw)
    }
    draw()
  }
  onTestFinished(() => {
    if (frame !== undefined)
      cancelAnimationFrame(frame)
    stream.getTracks().forEach(track => track.stop())
  })
  return stream
}

function previewVideo() {
  const video = document.createElement('video')
  document.body.append(video)
  onTestFinished(() => {
    video.pause()
    video.srcObject = null
    video.remove()
  })
  return video
}

async function mountCapture() {
  const scope = effectScope()
  const capture = scope.run(() => useVisionScreenCapture({ types: ['screen', 'window'] }))!
  onTestFinished(() => scope.stop())
  await capture.refetchSources()
  capture.activeSourceId.value = 'screen:0:0'
  return { capture, scope }
}

async function mountPage(selectFirst = true, configure?: (pinia: Pinia) => void) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const screen = render({ setup() {
    const vision = useVisionStore(pinia)
    vision.activeProvider = ''
    vision.activeModel = ''
    configure?.(pinia)
    return () => h(VisionCapture)
  } }, {
    global: {
      plugins: [pinia, createI18n({ legacy: false, locale: 'en', messages, missingWarn: false, fallbackWarn: false })],
    },
  })
  const vision = useVisionStore(pinia)
  const processing = useVisionProcessingStore(pinia)
  let mounted = true
  function unmount() {
    if (mounted) {
      screen.unmount()
      mounted = false
    }
  }
  onTestFinished(() => {
    unmount()
    disposePinia(pinia)
  })
  if (selectFirst) {
    await screen.getByText('First display', { exact: true }).click()
    await expect.element(screen.getByRole('button', { name: 'Start ticker', exact: true })).toBeEnabled()
  }
  return { screen, processing, unmount, vision, pinia, settings: useVisionCaptureSettingsStore(pinia) }
}

function configureInference(pinia: Pinia, result: Promise<string>) {
  const vision = useVisionStore(pinia)
  vision.activeProvider = 'openai'
  vision.activeModel = 'vision-test'
  vi.spyOn(useProviderStore(pinia), 'getChatProviderInstance').mockResolvedValue({
    generation: model => ({
      protocol: 'responses',
      webSearch: false,
      config: { model, apiKey: 'test-key', baseURL: 'https://example.com/v1/' },
    }),
  })
  vi.spyOn(useLLM(pinia), 'stream').mockImplementation(async (_model, _provider, _conversation, options) => {
    await options?.onStreamEvent?.({ type: 'text-delta', text: await result })
  })
  vi.spyOn(useModsServerChannelStore(pinia), 'sendContextUpdate').mockImplementation(() => {})
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('settings/vision/enabled', 'true')
  vi.stubGlobal('platform', 'linux')
  captureIpc.getSources.mockResolvedValue([
    source('screen:0:0', 'First display'),
    source('screen:1:0', 'Second display'),
  ])
  captureIpc.setSource.mockResolvedValue('selection')
  captureIpc.resetSource.mockResolvedValue(undefined)
  captureIpc.checkMacOSPermission.mockResolvedValue('granted')
  captureIpc.requestMacOSPermission.mockResolvedValue(undefined)
  captureIpc.openWindow.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('vision screen capture lifecycle', () => {
  it('decodes the first canvas frame and reuses a preview whose frame already arrived', async () => {
    const stream = canvasStream()
    const display = vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockResolvedValue(stream)
    const { capture } = await mountCapture()
    expect(display).not.toHaveBeenCalled()

    const first = capture.startStream()
    expect(capture.startStream()).toBe(first)
    await first
    const video = previewVideo()
    await capture.playStream(video, new AbortController().signal)
    await capture.playStream(video, new AbortController().signal)

    const image = new Image()
    image.src = capture.captureFrame(video)!
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext('2d')!
    context.drawImage(image, 0, 0, 1, 1)
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data
    expect(red).toBeGreaterThan(240)
    expect(green).toBeLessThan(10)
    expect(blue).toBeLessThan(10)
    expect(captureIpc.getSources).toHaveBeenCalledTimes(1)
    expect(display).toHaveBeenCalledTimes(1)
    capture.stopStream()
    expect(stream.getVideoTracks()[0].readyState).toBe('ended')
    expect(capture.activeStream.value).toBeNull()
  })

  it('settles cancellation before native capture returns and closes its late stream', async () => {
    const pending = Promise.withResolvers<MediaStream>()
    const display = vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockReturnValue(pending.promise)
    const { capture } = await mountCapture()
    const start = capture.startStream()
    await expect.poll(() => display.mock.calls.length).toBe(1)
    const cancelled = expect(start).rejects.toMatchObject({ name: 'AbortError' })
    capture.stopStream()
    await cancelled
    await expect(capture.startStream()).rejects.toThrow('previous capture request is closing')

    const stream = canvasStream()
    pending.resolve(stream)
    await expect.poll(() => stream.getVideoTracks()[0].readyState).toBe('ended')
    expect(capture.activeStream.value).toBeNull()
    expect(display).toHaveBeenCalledTimes(1)
  })

  it('cancels the old source and requires an explicit start for the new source', async () => {
    const pending = Promise.withResolvers<MediaStream>()
    const display = vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockReturnValueOnce(pending.promise)
    const { capture } = await mountCapture()
    const start = capture.startStream()
    await expect.poll(() => display.mock.calls.length).toBe(1)
    const cancelled = expect(start).rejects.toMatchObject({ name: 'AbortError' })
    capture.activeSourceId.value = 'screen:1:0'
    await cancelled
    const oldStream = canvasStream()
    pending.resolve(oldStream)
    await expect.poll(() => oldStream.getVideoTracks()[0].readyState).toBe('ended')
    expect(capture.activeStream.value).toBeNull()
    expect(display).toHaveBeenCalledTimes(1)

    const nextStream = canvasStream()
    display.mockResolvedValueOnce(nextStream)
    await capture.startStream()
    expect(capture.activeStream.value).toBe(nextStream)
    expect(nextStream.getVideoTracks()[0].readyState).toBe('live')
  })

  it('closes a stream that arrives after its Vue scope leaves', async () => {
    const pending = Promise.withResolvers<MediaStream>()
    const display = vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockReturnValue(pending.promise)
    const { capture, scope } = await mountCapture()
    const start = capture.startStream()
    await expect.poll(() => display.mock.calls.length).toBe(1)
    const cancelled = expect(start).rejects.toMatchObject({ name: 'AbortError' })
    scope.stop()
    await cancelled
    const stream = canvasStream()
    pending.resolve(stream)
    await expect.poll(() => stream.getVideoTracks()[0].readyState).toBe('ended')
    expect(capture.activeStream.value).toBeNull()
    await expect(capture.startStream()).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('keeps a stream without frames pending until cancellation', async () => {
    vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockResolvedValue(canvasStream(false))
    const { capture } = await mountCapture()
    await capture.startStream()
    const video = previewVideo()
    const controller = new AbortController()
    const ready = capture.playStream(video, controller.signal)
    const cancelled = expect(ready).rejects.toMatchObject({ name: 'AbortError' })
    const rendered = Promise.withResolvers<void>()
    requestAnimationFrame(() => rendered.resolve())
    await rendered.promise
    expect(video.readyState).toBeLessThan(HTMLMediaElement.HAVE_CURRENT_DATA)
    controller.abort()
    await cancelled
    capture.stopStream()
  })

  it('reports a missing first frame instead of leaving startup unresolved', async () => {
    vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockResolvedValue(canvasStream(false))
    const { capture } = await mountCapture()
    await capture.startStream()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const failure = expect(capture.playStream(previewVideo(), new AbortController().signal)).rejects.toThrow('No video frame arrived')
    await vi.advanceTimersByTimeAsync(15_000)
    await failure
  })

  it('settles a native play rejection while the first frame is pending', async () => {
    vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockResolvedValue(canvasStream(false))
    const { capture } = await mountCapture()
    await capture.startStream()
    const video = previewVideo()
    const ready = capture.playStream(video, new AbortController().signal)
    const rejected = expect(ready).rejects.toMatchObject({ name: 'AbortError' })
    video.pause()
    await rejected
  })

  it('settles a pending first frame when the native video track stops', async () => {
    const stream = canvasStream(false)
    vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockResolvedValue(stream)
    const { capture } = await mountCapture()
    await capture.startStream()
    const waiting = capture.playStream(previewVideo(), new AbortController().signal)
    const stopped = expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    stream.getVideoTracks()[0].stop()
    await stopped
    expect(capture.activeStream.value).toBeNull()
  })

  it('cancels before selection returns without opening native capture', async () => {
    const selection = Promise.withResolvers<string>()
    captureIpc.setSource.mockReturnValueOnce(selection.promise)
    const display = vi.spyOn(navigator.mediaDevices, 'getDisplayMedia')
    const { capture } = await mountCapture()
    const start = capture.startStream()
    await expect.poll(() => captureIpc.setSource.mock.calls.length).toBe(1)
    const cancelled = expect(start).rejects.toMatchObject({ name: 'AbortError' })
    capture.stopStream()
    await cancelled
    selection.resolve('late-selection')
    await expect.poll(() => captureIpc.resetSource.mock.calls.length).toBe(1)
    expect(display).not.toHaveBeenCalled()
  })
})

describe('vision capture page', () => {
  it('resumes the system-selected source, publishes its first frame, and keeps a later catalog stopped', async () => {
    localStorage.setItem('settings/vision/restore-on-startup', 'true')
    localStorage.setItem('settings/vision/publish-context', 'true')
    localStorage.setItem('settings/vision/capture-interval-ms', '60000')
    captureIpc.getSources.mockResolvedValue([source('window:2:0:s', 'Portal desktop')])
    const stream = canvasStream()
    const display = vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockResolvedValue(stream)
    const { screen, processing, pinia } = await mountPage(false, pinia => configureInference(pinia, Promise.resolve('A red desktop.')))
    const channel = useModsServerChannelStore(pinia)
    await expect.element(screen.getByRole('button', { name: 'Stop ticker', exact: true })).toBeEnabled()
    await expect.poll(() => useVisionActivityStore(pinia).contextUpdateCount).toBe(1)
    expect(document.querySelector('video')?.srcObject).toBe(stream)
    expect(document.querySelector('video')?.videoWidth).toBe(64)
    expect(channel.sendContextUpdate).toHaveBeenCalledWith(expect.objectContaining({
      contextId: 'vision:screen:interpret:window:2:0:s',
      text: 'A red desktop.',
      content: expect.arrayContaining([{ type: 'text', text: 'A red desktop.' }]),
      metadata: expect.objectContaining({ sourceId: 'window:2:0:s' }),
    }))
    expect(captureIpc.setSource).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'window:2:0:s', catalogId: 'catalog' }))
    expect(captureIpc.getSources).toHaveBeenCalledTimes(1)

    await screen.getByRole('button', { name: 'Stop ticker', exact: true }).click()
    expect(stream.getVideoTracks()[0].readyState).toBe('ended')
    captureIpc.getSources.mockResolvedValueOnce([{ ...source('window:3:0:s', 'Next portal selection'), catalogId: 'next-catalog' }])
    await screen.getByRole('button', { name: 'Refetch', exact: true }).click()
    await expect.element(screen.getByText('Next portal selection', { exact: true })).toBeVisible()
    expect(display).toHaveBeenCalledTimes(1)
    expect(processing.isRunning).toBe(false)

    const nextStream = canvasStream()
    display.mockResolvedValueOnce(nextStream)
    await screen.getByText('Next portal selection', { exact: true }).click()
    await screen.getByRole('button', { name: 'Start ticker', exact: true }).click()
    await expect.element(screen.getByRole('button', { name: 'Stop ticker', exact: true })).toBeEnabled()
    expect(captureIpc.setSource).toHaveBeenLastCalledWith(expect.objectContaining({ sourceId: 'window:3:0:s', catalogId: 'next-catalog' }))
    expect(document.querySelector('video')?.srcObject).toBe(nextStream)
  })

  it('requires a source click for a single ordinary catalog entry during startup', async () => {
    localStorage.setItem('settings/vision/restore-on-startup', 'true')
    captureIpc.getSources.mockResolvedValue([source('screen:0:0', 'First display')])
    const display = vi.spyOn(navigator.mediaDevices, 'getDisplayMedia')
    const { screen, processing } = await mountPage(false)
    await expect.element(screen.getByText('First display', { exact: true })).toBeVisible()
    expect(display).not.toHaveBeenCalled()
    expect(processing.isRunning).toBe(false)
    await expect.element(screen.getByRole('button', { name: 'Start ticker', exact: true })).toBeDisabled()
  })

  it.each(['cancel', 'disable', 'close'] as const)('does not resume a late system selection after %s', async (action) => {
    localStorage.setItem('settings/vision/restore-on-startup', 'true')
    const portal = Promise.withResolvers<SerializableDesktopCapturerSource[]>()
    captureIpc.getSources.mockReturnValueOnce(portal.promise)
    const display = vi.spyOn(navigator.mediaDevices, 'getDisplayMedia')
    const { screen, processing, vision, unmount } = await mountPage(false)
    await expect.poll(() => captureIpc.getSources.mock.calls.length).toBe(1)
    if (action === 'cancel')
      await screen.getByRole('button', { name: 'Cancel capture', exact: true }).click()
    else if (action === 'disable')
      vision.enabled = false
    else
      unmount()

    portal.resolve([source('window:2:0:s', 'Late portal selection')])
    await portal.promise
    await nextTick()
    expect(captureIpc.setSource).not.toHaveBeenCalled()
    expect(display).not.toHaveBeenCalled()
    expect(processing.isRunning).toBe(false)
    expect(document.querySelector('video')).toBeNull()
  })

  it('leaves startup stopped when the system picker is dismissed', async () => {
    localStorage.setItem('settings/vision/restore-on-startup', 'true')
    captureIpc.getSources.mockRejectedValueOnce(new Error('Portal cancelled'))
    const display = vi.spyOn(navigator.mediaDevices, 'getDisplayMedia')
    const { screen, processing } = await mountPage(false)
    await expect.element(screen.getByText('Failed to load sources: Portal cancelled', { exact: true })).toBeVisible()
    expect(captureIpc.setSource).not.toHaveBeenCalled()
    expect(display).not.toHaveBeenCalled()
    expect(processing.isRunning).toBe(false)
  })

  it('discards an inference that completes after automatic observation stops', async () => {
    localStorage.setItem('settings/vision/restore-on-startup', 'true')
    localStorage.setItem('settings/vision/publish-context', 'true')
    captureIpc.getSources.mockResolvedValue([source('window:2:0:s', 'Portal desktop')])
    const result = Promise.withResolvers<string>()
    const stream = canvasStream()
    vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockResolvedValue(stream)
    const { screen, processing, pinia } = await mountPage(false, pinia => configureInference(pinia, result.promise))
    await expect.poll(() => vi.mocked(useLLM(pinia).stream).mock.calls.length).toBe(1)
    await screen.getByRole('button', { name: 'Stop ticker', exact: true }).click()
    result.resolve('A late observation.')
    await expect.poll(() => processing.isProcessing).toBe(false)
    expect(useModsServerChannelStore(pinia).sendContextUpdate).not.toHaveBeenCalled()
    expect(useVisionActivityStore(pinia).contextUpdateCount).toBe(0)
    expect(processing.isRunning).toBe(false)
    expect(stream.getVideoTracks()[0].readyState).toBe('ended')
  })

  it('waits for a source click in a multi-source catalog before resuming saved observation options', async () => {
    localStorage.setItem('settings/vision/restore-on-startup', 'true')
    localStorage.setItem('settings/vision/publish-context', 'true')
    localStorage.setItem('settings/vision/capture-workload', 'screen:understand')
    localStorage.setItem('settings/vision/capture-downscale-percent', '50')
    localStorage.setItem('settings/vision/capture-interval-ms', '5000')
    const stream = canvasStream()
    const display = vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockResolvedValue(stream)
    const { screen, processing, settings } = await mountPage(false)
    await expect.element(screen.getByText('First display', { exact: true })).toBeVisible()
    await expect.element(screen.getByRole('button', { name: 'Start ticker', exact: true })).toBeDisabled()
    expect(display).not.toHaveBeenCalled()
    expect(settings.sendContextUpdates).toBe(true)
    expect(settings.selectedWorkload).toBe('screen:understand')
    expect(settings.captureDownscalePercent).toBe(50)
    expect(processing.captureIntervalMs).toBe(5000)

    await screen.getByText('Second display', { exact: true }).click()
    await expect.element(screen.getByRole('button', { name: 'Stop ticker', exact: true })).toBeEnabled()
    expect(stream.getVideoTracks()[0].readyState).toBe('live')
    await screen.getByRole('button', { name: 'Stop ticker', exact: true }).click()
    processing.captureIntervalMs = 1000
    settings.sendContextUpdates = false
    await nextTick()
    expect(settings.restoreOnStartup).toBe(true)
    expect(processing.isRunning).toBe(false)
    expect(stream.getVideoTracks()[0].readyState).toBe('ended')
    expect(display).toHaveBeenCalledTimes(1)
  })

  it('keeps capture alive when the settings entry closes, then stops when Vision is disabled', async () => {
    const stream = canvasStream()
    const display = vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockResolvedValue(stream)
    const { screen, processing, vision, pinia } = await mountPage()
    await screen.getByRole('button', { name: 'Start ticker', exact: true }).click()
    await expect.element(screen.getByRole('button', { name: 'Stop ticker', exact: true })).toBeEnabled()
    const entry = render(VisionCaptureEntry, {
      global: { plugins: [pinia, createI18n({ legacy: false, locale: 'en', messages })] },
    })
    entry.unmount()
    expect(processing.isRunning).toBe(true)
    expect(stream.getVideoTracks()[0].readyState).toBe('live')

    vision.enabled = false
    await nextTick()
    expect(processing.isRunning).toBe(false)
    expect(stream.getVideoTracks()[0].readyState).toBe('ended')
    vision.enabled = true
    await nextTick()
    expect(display).toHaveBeenCalledTimes(1)
    expect(processing.isRunning).toBe(false)
  })

  it('shows missing macOS permission before a startup source request', async () => {
    vi.stubGlobal('platform', 'darwin')
    localStorage.setItem('settings/vision/restore-on-startup', 'true')
    captureIpc.checkMacOSPermission.mockResolvedValue('denied')
    const display = vi.spyOn(navigator.mediaDevices, 'getDisplayMedia')
    const { screen, processing } = await mountPage(false)
    await expect.element(screen.getByText('Screen capture permissions are required to use vision capture.')).toBeVisible()
    expect(captureIpc.getSources).not.toHaveBeenCalled()
    expect(display).not.toHaveBeenCalled()
    expect(processing.isRunning).toBe(false)
  })

  it('does not ask for screen permission or sources while Vision is disabled', async () => {
    vi.stubGlobal('platform', 'darwin')
    localStorage.setItem('settings/vision/enabled', 'false')
    localStorage.setItem('settings/vision/restore-on-startup', 'true')
    const { screen } = await mountPage(false)
    await expect.element(screen.getByText('Vision is disabled. Enable it in module settings to observe the screen.')).toBeVisible()
    expect(captureIpc.checkMacOSPermission).not.toHaveBeenCalled()
    expect(captureIpc.getSources).not.toHaveBeenCalled()
  })

  it('starts only on click, uses its visible preview, and stops the ticker with its tracks', async () => {
    const stream = canvasStream()
    const display = vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockResolvedValue(stream)
    const { screen, processing } = await mountPage()
    expect(display).not.toHaveBeenCalled()
    expect(processing.isRunning).toBe(false)

    await screen.getByRole('button', { name: 'Start ticker', exact: true }).click()
    await expect.element(screen.getByRole('button', { name: 'Stop ticker', exact: true })).toBeEnabled()
    expect(processing.isRunning).toBe(true)
    const videos = document.querySelectorAll('video')
    expect(videos).toHaveLength(1)
    expect(videos[0].srcObject).toBe(stream)
    expect(videos[0].muted).toBe(true)
    expect(videos[0].playsInline).toBe(true)
    expect(videos[0].videoWidth).toBe(64)

    await screen.getByRole('button', { name: 'Stop ticker', exact: true }).click()
    expect(processing.isRunning).toBe(false)
    expect(stream.getVideoTracks()[0].readyState).toBe('ended')
    expect(document.querySelector('video')).toBeNull()
  })

  it('shows cancellation during startup and never restarts from a late response', async () => {
    const pending = Promise.withResolvers<MediaStream>()
    const display = vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockReturnValue(pending.promise)
    const { screen, processing } = await mountPage()
    await screen.getByRole('button', { name: 'Start ticker', exact: true }).click()
    await expect.poll(() => display.mock.calls.length).toBe(1)
    await expect.element(screen.getByRole('button', { name: 'Starting capture...', exact: true })).toBeDisabled()
    await screen.getByRole('button', { name: 'Cancel capture', exact: true }).click()
    const stream = canvasStream()
    pending.resolve(stream)
    await expect.poll(() => stream.getVideoTracks()[0].readyState).toBe('ended')
    expect(processing.isRunning).toBe(false)
    await expect.element(screen.getByRole('button', { name: 'Start ticker', exact: true })).toBeEnabled()
    expect(document.querySelector('video')).toBeNull()
  })

  it('cancels startup when the selected source changes', async () => {
    const pending = Promise.withResolvers<MediaStream>()
    const display = vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockReturnValue(pending.promise)
    const { screen, processing } = await mountPage()
    await screen.getByRole('button', { name: 'Start ticker', exact: true }).click()
    await expect.poll(() => display.mock.calls.length).toBe(1)
    await screen.getByText('Second display', { exact: true }).click()
    const stream = canvasStream()
    pending.resolve(stream)
    await expect.poll(() => stream.getVideoTracks()[0].readyState).toBe('ended')
    expect(processing.isRunning).toBe(false)
    expect(display).toHaveBeenCalledTimes(1)
  })

  it('cancels startup when the observation host closes', async () => {
    const pending = Promise.withResolvers<MediaStream>()
    const display = vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockReturnValue(pending.promise)
    const { screen, processing, unmount } = await mountPage()
    await screen.getByRole('button', { name: 'Start ticker', exact: true }).click()
    await expect.poll(() => display.mock.calls.length).toBe(1)
    unmount()
    const stream = canvasStream()
    pending.resolve(stream)
    await expect.poll(() => stream.getVideoTracks()[0].readyState).toBe('ended')
    expect(processing.isRunning).toBe(false)
  })

  it('cancels the first-frame wait and closes its live track', async () => {
    const stream = canvasStream(false)
    vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockResolvedValue(stream)
    const { screen, processing } = await mountPage()
    await screen.getByRole('button', { name: 'Start ticker', exact: true }).click()
    await expect.poll(() => document.querySelector('video')?.srcObject).toBe(stream)
    await expect.element(screen.getByRole('button', { name: 'Starting capture...', exact: true })).toBeDisabled()
    await screen.getByRole('button', { name: 'Cancel capture', exact: true }).click()
    expect(stream.getVideoTracks()[0].readyState).toBe('ended')
    expect(processing.isRunning).toBe(false)
    expect(document.querySelector('video')).toBeNull()
  })

  it('stops an active ticker when the source changes without opening another capture', async () => {
    const stream = canvasStream()
    const display = vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockResolvedValue(stream)
    const { screen, processing } = await mountPage()
    await screen.getByRole('button', { name: 'Start ticker', exact: true }).click()
    await expect.element(screen.getByRole('button', { name: 'Stop ticker', exact: true })).toBeEnabled()
    await screen.getByText('Second display', { exact: true }).click()
    expect(processing.isRunning).toBe(false)
    expect(stream.getVideoTracks()[0].readyState).toBe('ended')
    expect(display).toHaveBeenCalledTimes(1)
    await expect.element(screen.getByRole('button', { name: 'Start ticker', exact: true })).toBeEnabled()
  })

  it('shows permission errors beside the operation controls', async () => {
    vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockRejectedValue(new DOMException('Screen sharing was denied', 'NotAllowedError'))
    const { screen, processing } = await mountPage()
    await screen.getByRole('button', { name: 'Start ticker', exact: true }).click()
    await expect.element(screen.getByText('Failed to start stream: Screen sharing was denied')).toBeVisible()
    expect(processing.isRunning).toBe(false)
    await expect.element(screen.getByRole('button', { name: 'Start ticker', exact: true })).toBeEnabled()
  })

  it('shows a native picker selection without starting when startup observation is off', async () => {
    captureIpc.getSources.mockResolvedValue([source('window:2:0:s', 'Portal desktop')])
    const display = vi.spyOn(navigator.mediaDevices, 'getDisplayMedia')
    const { screen } = await mountPage(false)
    await expect.element(screen.getByText('Portal desktop', { exact: true })).toBeVisible()
    expect(display).not.toHaveBeenCalled()
    await expect.element(screen.getByRole('button', { name: 'Start ticker', exact: true })).toBeDisabled()
  })
})
