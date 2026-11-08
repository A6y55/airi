import process from 'node:process'

import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { SagMemory } from './sag-memory'

it.skipIf(!process.env.AIRI_SAG_BINARY)('keeps corrected and deleted memories stable across replay and restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'airi-sag-lifecycle-'))
  const settingsPath = join(root, 'settings.json')
  const settings = { character: 'saved-character', provider: 'minimax', voice: 'saved-voice', speakerRecognition: true }
  await writeFile(settingsPath, JSON.stringify(settings))
  const options = {
    binaryPath: process.env.AIRI_SAG_BINARY!,
    dataPath: join(root, 'sag'),
    archivePath: join(root, 'archive'),
    jevURL: 'http://127.0.0.1:1/jev/v1/systemone',
    model: 'jev-1.13-free',
    token: 'isolated-memory-test-token',
  }
  let memory = new SagMemory(options)
  const alice = { characterId: 'alice', sessionId: 'session', messageId: 'one', recordedAt: '2026-10-01T12:00:00+08:00', user: 'I prefer tea.', assistant: 'Tea it is.' }
  const bob = { ...alice, characterId: 'bob', user: 'I prefer coffee.' }
  try {
    await memory.configure()
    await memory.append(alice)
    await memory.append(bob)
    const [document] = await memory.list('alice')
    const corrected = '# Corrected preference\n\nI prefer water.\n'
    await memory.write('alice', document!.id, corrected)
    await memory.append(alice)
    expect(await memory.read('alice', document!.id)).toBe(corrected)
    await memory.remove('alice', document!.id)
    await memory.append(alice)
    expect(await memory.list('alice')).toEqual([])
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual(settings)
    await memory.append({ ...alice, messageId: 'two' })
    await memory.clear('alice')
    await memory.close()
    memory = new SagMemory(options)
    await memory.configure()
    await memory.append(alice)
    expect(await memory.list('alice')).toEqual([])
    const [bobDocument] = await memory.list('bob')
    expect(await memory.read('bob', bobDocument!.id)).toContain('I prefer coffee.')
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual(settings)
  }
  finally {
    await memory.close()
    await rm(root, { recursive: true, force: true })
  }
}, 60000)

it.skipIf(!process.env.AIRI_SAG_BINARY)('keeps dates and speaker labels when SAG selects fragments from a turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'airi-sag-evidence-'))
  const server = createServer(async (request, response) => {
    const chunks: Uint8Array[] = []
    for await (const chunk of request)
      chunks.push(chunk)
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!payload || typeof payload !== 'object' || !('questions' in payload) || !payload.questions || typeof payload.questions !== 'object') {
      response.writeHead(400).end()
      return
    }
    const answers = Object.fromEntries(Object.keys(payload.questions).map(id => [id, { type: 'noul', noul: 0.99 }]))
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ answers }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('The scoring fixture did not bind a local port.')
  const memory = new SagMemory({
    binaryPath: process.env.AIRI_SAG_BINARY!,
    dataPath: join(root, 'sag'),
    archivePath: join(root, 'archive'),
    jevURL: `http://127.0.0.1:${address.port}/systemone`,
    model: 'jev-1.13-free',
    token: 'isolated-evidence-test-token',
  })
  try {
    await memory.configure()
    await memory.append({ characterId: 'alice', sessionId: 'one', messageId: 'one', recordedAt: '2026-10-01T12:00:00+08:00', user: 'I prefer water.', assistant: 'I prefer tea.' })
    const result = await memory.search({ characterId: 'alice', query: 'water' })
    expect(result.sourceCount).toBe(1)
    expect(result.context).toContain('Recorded at (UTC): 2026-10-01T04:00:00.000Z')
    expect(result.context).toContain('Recorded at (original time zone): "2026-10-01T12:00:00+08:00"')
    expect(result.context).toContain('## User — original words\n\nI prefer water.')
    expect(result.context).toContain('## Character — final reply\n\nI prefer tea.')
  }
  finally {
    await memory.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 60000)
