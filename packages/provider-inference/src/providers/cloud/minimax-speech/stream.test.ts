import type { MinimaxSpeechEvent } from './stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { MinimaxSpeechSession } from './stream'

class Socket extends EventTarget {
  readonly readyState = 1
  readonly sent: Array<{ event: string, text?: string }> = []
  readonly close = vi.fn()
  readonly send = vi.fn((data: string) => {
    this.sent.push(JSON.parse(data))
  })

  receive(event: string | undefined, payload: object = {}) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ event, ...payload }) }))
  }
}

const sessions: MinimaxSpeechSession[] = []

function open() {
  const socket = new Socket()
  const events: MinimaxSpeechEvent[] = []
  const session = new MinimaxSpeechSession(socket, { model: 'speech-2.8-turbo', voice: 'Japanese_GracefulMaiden' }, event => events.push(event))
  sessions.push(session)
  return { socket, session, events }
}

function ready(socket: Socket) {
  socket.receive('connected_success')
  socket.receive('task_started')
}

afterEach(() => {
  for (const session of sessions.splice(0))
    session.cancel()
})

describe('minimax bidirectional speech', () => {
  it('preserves queued text order and flushes EOF only after task_started', () => {
    const { socket, session } = open()
    session.appendText('第一')
    session.appendText('句。')
    session.finish()
    expect(socket.sent).toEqual([])
    socket.receive('connected_success')
    expect(socket.sent.map(frame => frame.event)).toEqual(['task_start'])
    socket.receive('task_started')
    expect(socket.sent.slice(1)).toEqual([
      { event: 'task_continue', text: '第一' },
      { event: 'task_continue', text: '句。' },
      { event: 'task_finish' },
    ])
  })

  it('releases PCM before text EOF and does not confuse is_final with session completion', () => {
    const { socket, session, events } = open()
    ready(socket)
    session.appendText('先说这句。')
    socket.receive('sentence_start')
    socket.receive(undefined, { data: { audio: '00800040' }, is_final: true })
    expect(events).toEqual([{ type: 'sentence-start' }, { type: 'audio', pcm: new Uint8Array([0, 128, 0, 64]) }])
    expect(socket.close).not.toHaveBeenCalled()
    expect(socket.sent.some(frame => frame.event === 'task_finish')).toBe(false)
    socket.receive('sentence_end')
    session.appendText('还没有标点的尾句')
    session.finish()
    socket.receive('sentence_start')
    socket.receive('task_continued', { data: { audio: 'ff7f' } })
    socket.receive('sentence_end')
    socket.receive('task_finished')
    expect(events.slice(2)).toEqual([
      { type: 'sentence-end' },
      { type: 'sentence-start' },
      { type: 'audio', pcm: new Uint8Array([255, 127]) },
      { type: 'sentence-end' },
      { type: 'finished' },
    ])
    expect(socket.close).toHaveBeenCalledOnce()
  })

  it('keeps every character when one input chunk exceeds the frame limit', () => {
    const { socket, session } = open()
    ready(socket)
    const text = `${'甲'.repeat(9999)}😀${'乙'.repeat(10001)}`
    session.appendText(text)
    const parts = socket.sent.filter(frame => frame.event === 'task_continue').map(frame => frame.text!)
    expect(parts.join('')).toBe(text)
    expect(parts.map(part => part.length)).toEqual([9999, 10000, 3])
    expect(parts.every(part => part.isWellFormed())).toBe(true)
  })

  it.each(['connecting', 'ready'] as const)('cancels a %s session and ignores late audio', (state) => {
    const { socket, session, events } = open()
    if (state === 'ready')
      ready(socket)
    session.appendText('取消后不能播放。')
    session.cancel()
    socket.receive('task_started')
    socket.receive('sentence_start')
    socket.receive('task_continued', { data: { audio: 'ff7f' } })
    socket.dispatchEvent(new Event('error'))
    expect(events).toEqual([])
    expect(socket.close).toHaveBeenCalledOnce()
    expect(socket.sent.filter(frame => frame.event === 'task_cancel')).toHaveLength(state === 'ready' ? 1 : 0)
  })

  it.each([1004, 2204, 2205])('fails explicitly for provider refusal %s instead of reporting truncated success', (code) => {
    const { socket, session, events } = open()
    ready(socket)
    session.appendText('不允许静默丢掉。')
    socket.receive('task_continued', { base_resp: { status_code: code, status_msg: 'provider rejected text' } })
    socket.receive('task_finished')
    expect(events).toEqual([{ type: 'error', message: `MiniMax speech ${code}: provider rejected text` }])
    expect(socket.close).toHaveBeenCalledOnce()
  })

  it('rejects a disconnect after audio without task_finished', () => {
    const { socket, session, events } = open()
    ready(socket)
    session.appendText('不完整。')
    session.finish()
    socket.receive('sentence_start')
    socket.receive('task_continued', { data: { audio: '0000' } })
    socket.receive('sentence_end')
    socket.dispatchEvent(new Event('close'))
    expect(events.at(-1)).toEqual({ type: 'error', message: 'MiniMax speech disconnected before task_finished.' })
  })

  it('fails a malformed audio frame before passing bytes to playback', () => {
    const { socket, events } = open()
    ready(socket)
    socket.receive('sentence_start')
    socket.receive('task_continued', { data: { audio: 'zz01' } })
    expect(events).toEqual([
      { type: 'sentence-start' },
      { type: 'error', message: 'MiniMax speech returned invalid hexadecimal audio.' },
    ])
  })
})
