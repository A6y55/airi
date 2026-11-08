import type { SerializableDesktopCapturerSource } from '@proj-airi/electron-screen-capture'
import type { SourcesOptions } from 'electron'
import type { MaybeRefOrGetter } from 'vue'

import { useElectronScreenCapture } from '@proj-airi/electron-screen-capture/vue'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'
import { computed, onScopeDispose, ref, shallowRef, toRaw, toValue, watch } from 'vue'

import { createObjectUrlFromBytes } from '../utils/create-object-url-from-bytes'

interface ScreenCaptureSource extends SerializableDesktopCapturerSource {
  appIconURL?: string
  thumbnailURL?: string
}

/**
 * Owns source previews and one screen-capture request for the current Vue scope.
 * Stop, source changes, and scope disposal cancel callers immediately and close late streams.
 */
export function useVisionScreenCapture(sourcesOptions: MaybeRefOrGetter<SourcesOptions>) {
  const sources = ref<ScreenCaptureSource[]>([])
  const isRefetching = ref(false)
  const hasFetchedOnce = ref(false)
  const activeSourceId = ref('')
  const activeStream = shallowRef<MediaStream | null>(null)
  const activeStreamSourceId = ref('')

  let disposed = false
  let pendingStart: Promise<MediaStream> | undefined
  let startController: AbortController | undefined
  let releasePendingSource: (() => Promise<void>) | undefined
  let detachStreamLifecycle: (() => void) | undefined
  let cancelPreview: (() => void) | undefined

  watch(activeSourceId, stopStream, { flush: 'sync' })

  const {
    getSources,
    setSource,
    resetSource,
  } = useElectronScreenCapture(getElectronEventaContext(), sourcesOptions)

  const activeSource = computed(() => sources.value.find(source => source.id === activeSourceId.value) || null)

  function isActiveStream(stream: MediaStream | null | undefined) {
    if (!stream)
      return false

    return stream.getVideoTracks().some(track => track.readyState === 'live')
  }

  function clearActiveStream() {
    cancelPreview?.()
    detachStreamLifecycle?.()
    detachStreamLifecycle = undefined
    const stream = activeStream.value
    activeStream.value = null
    activeStreamSourceId.value = ''
    stream?.getTracks().forEach(track => track.stop())
  }

  function revokeSourceObjectUrls(entries: ScreenCaptureSource[]) {
    entries.forEach((source) => {
      if (source.appIconURL)
        URL.revokeObjectURL(source.appIconURL)
      if (source.thumbnailURL)
        URL.revokeObjectURL(source.thumbnailURL)
    })
  }

  function attachStreamLifecycle(stream: MediaStream) {
    const tracks = stream.getVideoTracks()
    const onEnded = () => {
      if (activeStream.value === stream)
        clearActiveStream()
    }
    tracks.forEach(track => track.addEventListener('ended', onEnded))
    stream.addEventListener('inactive', onEnded)
    detachStreamLifecycle = () => {
      tracks.forEach(track => track.removeEventListener('ended', onEnded))
      stream.removeEventListener('inactive', onEnded)
    }
  }

  /** Returns the current native-picker selection, if this request completed one instead of listing available sources. */
  async function refetchSources() {
    try {
      isRefetching.value = true
      const nextSources = (await getSources())
        .sort((a, b) => {
          const aIsScreen = a.id.startsWith('screen:')
          const bIsScreen = b.id.startsWith('screen:')
          if (aIsScreen !== bIsScreen)
            return aIsScreen ? -1 : 1
          return a.name.localeCompare(b.name)
        })
      if (disposed)
        return

      revokeSourceObjectUrls(sources.value)

      sources.value = nextSources.map(source => ({
        ...source,
        appIconURL: source.appIcon && source.appIcon.length > 0 ? createObjectUrlFromBytes(source.appIcon, 'image/png') : undefined,
        thumbnailURL: source.thumbnail && source.thumbnail.length > 0 ? createObjectUrlFromBytes(source.thumbnail, 'image/jpeg') : undefined,
      }))

      const hasActiveSource = sources.value.some(source => source.id === activeSourceId.value)
      // A catalog lists possible sources. It does not authorize its first entry, including a new catalog after restart.
      if (!hasActiveSource)
        activeSourceId.value = ''

      // Chromium marks native-picker sessions with :s. Electron resolves delegated catalogs only after the user selects a source.
      // https://github.com/chromium/chromium/blob/150.0.7871.250/content/public/browser/desktop_media_id.cc
      // https://github.com/electron/electron/blob/v43.8.4/shell/browser/api/electron_api_desktop_capturer.cc
      const selectedSource = sources.value.length === 1 ? sources.value[0] : undefined
      if (selectedSource && /^(?:screen|window):-?\d+:-?\d+:s$/.test(selectedSource.id))
        return selectedSource
    }
    finally {
      isRefetching.value = false
      hasFetchedOnce.value = true
    }
  }

  function startStream(): Promise<MediaStream> {
    if (disposed)
      return Promise.reject(new DOMException('Screen capture window closed', 'AbortError'))

    if (pendingStart) {
      if (startController?.signal.aborted)
        return Promise.reject(new Error('The previous capture request is closing. Close the system sharing dialog and try again.'))
      return pendingStart
    }

    const source = activeSource.value
    if (!source)
      return Promise.reject(new Error('No active source selected'))

    if (isActiveStream(activeStream.value) && activeStreamSourceId.value === source.id)
      return Promise.resolve(activeStream.value!)

    clearActiveStream()
    const controller = new AbortController()
    startController = controller
    const { signal } = controller
    const cancelled = Promise.withResolvers<never>()
    const rejectAbort = () => cancelled.reject(signal.reason)
    signal.addEventListener('abort', rejectAbort, { once: true })

    // Cancellation settles the caller now. The native request owns its slot until it returns and releases its selection.
    const request = Promise.resolve().then(async () => {
      let stream: MediaStream | undefined
      try {
        signal.throwIfAborted()
        const handle = await setSource({
          sourceId: source.id,
          catalogId: source.catalogId,
          options: toRaw(toValue(sourcesOptions)),
        })
        let released: Promise<void> | undefined
        const release = () => released ??= resetSource(handle)
        releasePendingSource = release
        try {
          signal.throwIfAborted()
          stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
        }
        finally {
          await release()
        }

        signal.throwIfAborted()
        if (!isActiveStream(stream))
          throw new Error('Selected source did not provide a live video track')

        activeStream.value = stream
        activeStreamSourceId.value = source.id
        attachStreamLifecycle(stream)
        return stream
      }
      catch (error) {
        stream?.getTracks().forEach(track => track.stop())
        throw error
      }
      finally {
        releasePendingSource = undefined
        pendingStart = undefined
        startController = undefined
      }
    })

    pendingStart = Promise.race([request, cancelled.promise]).finally(() => {
      signal.removeEventListener('abort', rejectAbort)
    })
    return pendingStart
  }

  function stopStream() {
    startController?.abort()
    void releasePendingSource?.().catch(error => console.error('Failed to release screen capture selection', error))
    clearActiveStream()
  }

  function cleanup() {
    disposed = true
    stopStream()
    revokeSourceObjectUrls(sources.value)
    sources.value = []
  }

  onScopeDispose(cleanup)

  /** Plays the active stream and waits for a decoded frame, including one that arrived before this call. */
  function playStream(video: HTMLVideoElement, signal: AbortSignal) {
    cancelPreview?.()
    const selectedStream = activeStream.value
    if (!selectedStream || !isActiveStream(selectedStream))
      return Promise.reject(new Error('Screen sharing ended before the first video frame'))
    const stream = selectedStream

    const ready = Promise.withResolvers<void>()
    let settled = false
    let playing = false
    const tracks = stream.getVideoTracks()
    const timeout = setTimeout(() => {
      finish(new Error('No video frame arrived within 15 seconds. Check the system sharing dialog and capture permissions.'))
    }, 15_000)

    function finish(error?: unknown) {
      if (settled)
        return
      settled = true
      cancelPreview = undefined
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      video.removeEventListener('loadeddata', onFrame)
      video.removeEventListener('canplay', onFrame)
      video.removeEventListener('error', onError)
      video.removeEventListener('emptied', onReplaced)
      stream.removeEventListener('inactive', onEnded)
      tracks.forEach(track => track.removeEventListener('ended', onEnded))
      if (error)
        ready.reject(error)
      else
        ready.resolve()
    }

    function onFrame() {
      if (playing && video.srcObject === stream && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0)
        finish()
    }
    function onAbort() {
      finish(signal.reason)
    }
    function onError() {
      finish(new Error(video.error?.message ?? 'Failed to play the screen capture preview'))
    }
    function onEnded() {
      finish(new Error('Screen sharing ended before the first video frame'))
    }
    function onReplaced() {
      if (video.srcObject !== stream)
        onEnded()
    }

    cancelPreview = () => finish(new DOMException('Screen capture stopped', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    video.addEventListener('loadeddata', onFrame)
    video.addEventListener('canplay', onFrame)
    video.addEventListener('error', onError)
    tracks.forEach(track => track.addEventListener('ended', onEnded))
    stream.addEventListener('inactive', onEnded)
    if (signal.aborted) {
      onAbort()
      return ready.promise
    }

    video.muted = true
    video.playsInline = true
    if (video.srcObject !== stream)
      video.srcObject = stream
    video.addEventListener('emptied', onReplaced)
    void video.play().then(() => {
      playing = true
      onFrame()
    }, finish)
    return ready.promise
  }

  function captureFrame(video: HTMLVideoElement, quality = 0.82, maxWidth = 1280, maxHeight = 720) {
    if (!video || video.readyState < 2)
      return null

    const canvas = document.createElement('canvas')
    const sourceWidth = video.videoWidth
    const sourceHeight = video.videoHeight
    if (sourceWidth <= 0 || sourceHeight <= 0)
      return null

    const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight, 1)
    canvas.width = Math.round(sourceWidth * scale)
    canvas.height = Math.round(sourceHeight * scale)

    const ctx = canvas.getContext('2d')
    if (!ctx)
      throw new Error('Failed to create canvas context')

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', quality)
  }

  return {
    sources,
    activeSourceId,
    activeSource,
    activeStream,
    isRefetching,
    hasFetchedOnce,
    refetchSources,
    startStream,
    playStream,
    stopStream,
    cleanup,
    captureFrame,
  }
}
