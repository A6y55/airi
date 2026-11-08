import type { Event, WebContents } from 'electron'

import type { CompanionGateway } from './companion-gateway'

import NodeWebSocket from 'crossws/websocket'

import { defineInvokeHandler } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/main'
import { MinimaxSpeechSession } from '@proj-airi/provider-inference/minimax-speech'
import { BrowserWindow, ipcMain } from 'electron'
import { maxLength, minLength, parse, pipe, strictObject, string } from 'valibot'

import { minimaxSpeechAppend, minimaxSpeechCancel, minimaxSpeechEvent, minimaxSpeechFinish, minimaxSpeechStart } from '../../../shared/eventa/minimax-speech'

const identity = pipe(string(), minLength(1), maxLength(128))
const sessionSchema = strictObject({ id: identity })
const startSchema = strictObject({ id: identity, model: pipe(string(), minLength(1), maxLength(128)), voice: pipe(string(), minLength(1), maxLength(512)) })
const appendSchema = strictObject({ id: identity, text: string() })

interface Session {
  owner: WebContents
  speech?: MinimaxSpeechSession
  close: () => void
}

function endpoint(baseUrl: string) {
  const url = new URL(baseUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
    || !['api.minimax.cn', 'api.minimax.io', 'api-bj.minimaxi.com'].includes(url.hostname)
    || !['/', '/v1', '/v1/'].includes(url.pathname)) {
    throw new Error('MiniMax streaming speech requires an official HTTPS API endpoint.')
  }
  return `wss://${url.hostname}/ws/v1/t2a_v2_bidi`
}

/**
 * Installs the authenticated desktop transport. Each session belongs to one renderer and closes on reload, crash, or shutdown.
 * Renderer text → Eventa → saved provider credentials → MiniMaxSpeechSession → targeted PCM events.
 */
export function setupMinimaxSpeech(gateway: Promise<CompanionGateway>): () => void {
  const { context, dispose } = createContext(ipcMain)
  const sessions = new Map<string, Session>()
  let disposed = false

  function owned(id: string, owner: WebContents | undefined) {
    const session = sessions.get(id)
    if (!session || session.owner !== owner)
      throw new Error('MiniMax speech session does not belong to this window.')
    return session
  }

  const unregister = [
    defineInvokeHandler(context, minimaxSpeechStart, async (input, options) => {
      const { id, model, voice } = parse(startSchema, input)
      const owner = options?.raw.ipcMainEvent.sender
      const window = owner && BrowserWindow.fromWebContents(owner)
      if (disposed || !owner || !window || owner.isDestroyed())
        throw new Error('MiniMax speech requires a live application window.')
      if (sessions.has(id))
        throw new Error('MiniMax speech session already exists.')
      const events = createContext(ipcMain, window, { onlySameWindow: true })
      // Reserve the ID before reading the vault. Cancellation can arrive while initialization awaits storage.
      const session: Session = {
        owner,
        close() {
          if (sessions.get(id) !== session)
            return
          sessions.delete(id)
          session.speech?.cancel()
          owner.off('destroyed', session.close)
          owner.off('render-process-gone', session.close)
          owner.off('did-start-navigation', navigate)
          events.dispose()
        },
      }
      function navigate(_event: Event, _url: string, isInPlace: boolean, isMainFrame: boolean) {
        if (isMainFrame && !isInPlace)
          session.close()
      }
      sessions.set(id, session)
      owner.once('destroyed', session.close)
      owner.once('render-process-gone', session.close)
      owner.on('did-start-navigation', navigate)
      try {
        const config = await (await gateway).getMinimaxSpeechConfig()
        if (sessions.get(id) !== session)
          return
        // crossws selects its bundled Node ws client when the third argument supplies header options.
        // Its public constructor type contains only browser arguments, so Reflect passes the supported Node options.
        const socket = Reflect.construct(NodeWebSocket, [endpoint(config.baseUrl), [], {
          headers: { Authorization: `Bearer ${config.apiKey}` },
          handshakeTimeout: 30_000,
          followRedirects: false,
        }]) as WebSocket
        session.speech = new MinimaxSpeechSession(socket, { model, voice }, (event) => {
          if (sessions.get(id) !== session || owner.isDestroyed())
            return
          if (event.type === 'error')
            event = { ...event, message: event.message.split(config.apiKey).join('[credential removed]') }
          try {
            events.context.emit(minimaxSpeechEvent, { id, event })
          }
          catch {
            session.close()
          }
          if (event.type === 'finished' || event.type === 'error')
            session.close()
        })
      }
      catch {
        session.close()
        // Configuration and socket errors can include credentials. Return a fixed message across IPC.
        throw new Error('MiniMax streaming speech could not open. Check the saved provider key and official API endpoint.')
      }
    }),
    defineInvokeHandler(context, minimaxSpeechAppend, (input, options) => {
      const { id, text } = parse(appendSchema, input)
      const session = owned(id, options?.raw.ipcMainEvent.sender)
      if (!session.speech)
        throw new Error('MiniMax speech has not opened yet.')
      session.speech.appendText(text)
    }),
    defineInvokeHandler(context, minimaxSpeechFinish, (input, options) => {
      const { id } = parse(sessionSchema, input)
      const session = owned(id, options?.raw.ipcMainEvent.sender)
      if (!session.speech)
        throw new Error('MiniMax speech has not opened yet.')
      session.speech.finish()
    }),
    defineInvokeHandler(context, minimaxSpeechCancel, (input, options) => {
      const { id } = parse(sessionSchema, input)
      const session = sessions.get(id)
      // Late cancellation is harmless. Another window cannot cancel a matching ID.
      if (session && session.owner === options?.raw.ipcMainEvent.sender)
        session.close()
    }),
  ]
  return () => {
    disposed = true
    for (const session of sessions.values())
      session.close()
    unregister.forEach(remove => remove())
    dispose()
  }
}
