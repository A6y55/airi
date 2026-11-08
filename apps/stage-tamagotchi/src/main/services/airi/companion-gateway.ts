import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

import type { InferOutput } from 'valibot'

import type { CompanionJevProvider, CompanionProviderStorage } from '../../../shared/eventa/companion'

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import { request as requestHttps } from 'node:https'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import { safeStorage } from 'electron'
import { literal, looseObject, maxLength, nullable, object, optional, parse, picklist, pipe, regex, safeParse, strictObject, string } from 'valibot'

import { companionProviderStorageKeys } from '../../../shared/eventa/companion'

const keySchema = pipe(string(), maxLength(16384), regex(/^[\x21-\x7E]*$/))
const providerStorageValueSchema = nullable(pipe(string(), maxLength(4 * 1024 * 1024)))
const providerStorageSchema = strictObject({
  [companionProviderStorageKeys[0]]: optional(providerStorageValueSchema),
  [companionProviderStorageKeys[1]]: optional(providerStorageValueSchema),
})
const providerStorageWriteSchema = strictObject({ key: picklist(companionProviderStorageKeys), value: providerStorageValueSchema })
const keysSchema = strictObject({ minimax: optional(keySchema), jev: optional(keySchema), providerStorage: optional(providerStorageSchema) })
const requestSchema = looseObject({ model: string() })
type Keys = InferOutput<typeof keysSchema>

/** Main-process access to the saved MiniMax endpoint and key. Never send this value through speech IPC. */
export interface MinimaxSpeechCredentials {
  apiKey: string
  baseUrl: string
}

/** Owns encrypted credentials and one authenticated loopback listener in the main process. */
export interface CompanionGateway {
  readonly baseURL: string
  readonly token: string
  status: () => { jevConfigured: boolean }
  setJevProvider: (input: CompanionJevProvider | null) => void
  /** Migration commits once. Later calls return the latest committed snapshot. */
  initializeProviderStorage: (input: CompanionProviderStorage) => Promise<CompanionProviderStorage>
  /** Merges one key into the latest queued state. Null removes the persisted field. */
  writeProviderStorage: (input: { key: typeof companionProviderStorageKeys[number], value: string | null }) => Promise<void>
  /** Waits for preceding settings writes, then reads the configured MiniMax Speech provider. */
  getMinimaxSpeechConfig: () => Promise<MinimaxSpeechCredentials>
  /** Stops requests, closes sockets, and waits for queued vault writes. */
  close: () => Promise<void>
}

class GatewayError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message)
  }
}

function requireEncryption(): void {
  if (!safeStorage.isEncryptionAvailable()
    || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
    throw new Error('Secure credential storage is unavailable. Unlock the system keyring and restart AIRI.')
  }
}

async function loadKeys(directory: string): Promise<Keys> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const directoryStat = await lstat(directory)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
    throw new Error('The credential vault directory is unsafe.')
  await chmod(directory, 0o700)

  let file
  try {
    file = await open(join(directory, 'keys.enc'), constants.O_RDONLY | constants.O_NOFOLLOW)
  }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return {}
    throw new Error('The credential vault cannot be opened. The existing file was not replaced.')
  }
  try {
    const stat = await file.stat()
    // Two 4 MiB strings can each expand sixfold through JSON escapes. The remainder covers credentials and encryption overhead.
    if (!stat.isFile() || stat.size > 48 * 1024 * 1024 + 128 * 1024)
      throw new Error('Invalid vault file')
    await file.chmod(0o600)
    requireEncryption()
    const encrypted = await file.readFile()
    const parsed = safeParse(keysSchema, JSON.parse(safeStorage.decryptString(encrypted)))
    if (!parsed.success)
      throw new Error('Invalid vault data')
    return parsed.output
  }
  catch {
    throw new Error('The credential vault cannot be decrypted or is damaged. Unlock the keyring or restore the vault before restarting.')
  }
  finally {
    await file.close()
  }
}

function allowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === 'null')
    return true
  try {
    const url = new URL(origin)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
      && url.origin === origin
  }
  catch {
    return false
  }
}

function routeFor(path: string | undefined, jev: CompanionJevProvider | undefined) {
  switch (path) {
    case '/jev/v1/systemone':
      if (!jev)
        throw new GatewayError(503, 'Select a configured Jev provider in AIRI settings.')
      return { method: 'POST', provider: 'jev', url: jev.baseURL, model: jev.model } as const
  }
}

function sendError(response: ServerResponse, status: number, message: string): void {
  if (response.destroyed || response.writableEnded)
    return
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Connection': 'close' })
  response.end(JSON.stringify({ error: { message, type: 'companion_gateway_error' } }))
}

function readBody(request: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  const limit = 64 * 1024 * 1024
  const declaredLength = request.headers['content-length']
  if (declaredLength !== undefined && Number(declaredLength) > limit)
    return Promise.reject(new GatewayError(413, 'The request body exceeds 64 MiB.'))

  const { promise, resolve, reject } = Promise.withResolvers<Buffer>()
  const chunks: Buffer[] = []
  let size = 0
  function cleanup() {
    request.off('data', onData)
    request.off('end', onEnd)
    request.off('error', onError)
    signal.removeEventListener('abort', onAbort)
  }
  function onError() {
    cleanup()
    reject(new GatewayError(400, 'The request body could not be read.'))
  }
  function onAbort() {
    cleanup()
    reject(new GatewayError(408, 'The request was cancelled or timed out.'))
  }
  function onData(chunk: Buffer) {
    size += chunk.length
    if (size > limit) {
      request.pause()
      cleanup()
      reject(new GatewayError(413, 'The request body exceeds 64 MiB.'))
      return
    }
    chunks.push(chunk)
  }
  function onEnd() {
    cleanup()
    resolve(Buffer.concat(chunks, size))
  }
  request.on('data', onData)
  request.once('end', onEnd)
  request.once('error', onError)
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted)
    onAbort()
  return promise
}

// Memory holds the last committed vault state. A queue serializes atomic replacements.
// Each request owns an abort controller. Disconnect, timeout, and shutdown cancel its upstream connection.
class LoopbackGateway implements CompanionGateway {
  readonly token = randomBytes(32).toString('hex')
  private readonly authorization = Buffer.from(`Bearer ${this.token}`)
  private readonly server = createServer((request, response) => {
    void this.handleRequest(request, response)
  })

  private readonly sockets = new Set<Socket>()
  private readonly controllers = new Set<AbortController>()
  private writes: Promise<void> = Promise.resolve()
  private closing?: Promise<void>
  private closed = false
  private address = ''
  private jevProvider?: CompanionJevProvider

  constructor(private readonly directory: string, private keys: Keys) {
    this.server.headersTimeout = 30_000
    this.server.requestTimeout = 120_000
    this.server.keepAliveTimeout = 5_000
    this.server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
    this.server.on('clientError', (_, socket) => {
      socket.destroy()
    })
  }

  get baseURL(): string {
    return this.address
  }

  async listen(): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    this.server.once('error', reject)
    this.server.listen(0, '127.0.0.1', () => {
      this.server.off('error', reject)
      resolve()
    })
    await promise
    const address = this.server.address()
    if (address === null || typeof address === 'string')
      throw new Error('The local provider gateway could not start.')
    this.address = `http://127.0.0.1:${address.port}`
  }

  status() {
    return { jevConfigured: Boolean(this.jevProvider) }
  }

  setJevProvider(input: CompanionJevProvider | null): void {
    if (this.closed)
      throw new Error('The local provider gateway is closed.')
    if (!input) {
      this.jevProvider = undefined
      return
    }
    const key = safeParse(keySchema, input.apiKey)
    if (!key.success || !input.model.trim())
      throw new Error('The Jev provider requires a valid credential value and a model.')
    const url = new URL(input.baseURL)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new Error('The Jev provider requires an HTTPS base URL without credentials, query parameters, or fragments.')
    const path = url.pathname.replace(/\/+$/, '')
    // Explicit SystemOne and Decisions endpoints retain their provider-specific paths.
    url.pathname = /\/(?:systemone|decisions)$/.test(path) ? path : `${path || '/v1'}/systemone`
    const publicFreeModel = url.href === 'https://opencode.ai/inference/systemone/v1/systemone' && input.model === 'jev-1.13-free'
    if (!key.output && !publicFreeModel)
      throw new Error('This Jev provider requires an API key.')
    this.jevProvider = { baseURL: url.href, apiKey: key.output, model: input.model }
  }

  async initializeProviderStorage(input: CompanionProviderStorage): Promise<CompanionProviderStorage> {
    const parsed = safeParse(providerStorageSchema, input)
    if (!parsed.success)
      throw new Error('The provider settings have an invalid format or exceed the storage limit.')
    return this.queueWrite(async () => {
      if (this.keys.providerStorage !== undefined)
        return { ...this.keys.providerStorage }
      await this.commitKeys({ ...this.keys, providerStorage: parsed.output })
      return { ...parsed.output }
    })
  }

  async writeProviderStorage(input: { key: typeof companionProviderStorageKeys[number], value: string | null }): Promise<void> {
    const parsed = safeParse(providerStorageWriteSchema, input)
    if (!parsed.success)
      throw new Error('The provider settings have an invalid key, value, or size.')
    await this.queueWrite(async () => {
      if (this.keys.providerStorage === undefined)
        throw new Error('Initialize secure provider storage before saving provider settings.')
      const providerStorage = { ...this.keys.providerStorage }
      const { key, value } = parsed.output
      if (value === null)
        delete providerStorage[key]
      else
        providerStorage[key] = value
      await this.commitKeys({ ...this.keys, providerStorage })
    })
  }

  async getMinimaxSpeechConfig(): Promise<MinimaxSpeechCredentials> {
    await this.writes
    if (this.closed)
      throw new Error('Secure provider storage is closed.')
    const stored = this.keys.providerStorage?.['settings/providers/configured']
    if (!stored)
      throw new Error('Configure MiniMax Speech before starting synthesis.')
    const providers = parse(object({
      'minimax-speech': object({
        definitionId: literal('minimax-speech'),
        config: object({ apiKey: keySchema, baseUrl: optional(string(), 'https://api.minimax.io') }),
      }),
    }), JSON.parse(stored))
    const config = providers['minimax-speech'].config
    if (!config.apiKey.trim())
      throw new Error('MiniMax Speech requires an API key.')
    return { apiKey: config.apiKey.trim(), baseUrl: config.baseUrl }
  }

  private queueWrite<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed)
      return Promise.reject(new Error('The local provider gateway is closed.'))
    const write = this.writes.then(operation)
    this.writes = write.then(() => undefined, () => {
      // A failed write leaves the committed keys intact and permits a later save attempt.
    })
    return write
  }

  private async commitKeys(next: Keys): Promise<void> {
    requireEncryption()
    const temporary = join(this.directory, `keys-${randomBytes(12).toString('hex')}.tmp`)
    try {
      const encrypted = safeStorage.encryptString(JSON.stringify(next))
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(encrypted)
        await file.sync()
      }
      finally {
        await file.close()
      }
      await rename(temporary, join(this.directory, 'keys.enc'))
      this.keys = next
    }
    catch {
      throw new Error('The credential vault could not be saved. The previous credentials remain active.')
    }
    finally {
      await unlink(temporary).catch(() => {
        // A successful rename removes the temporary path. Cleanup never changes the committed vault.
      })
    }
  }

  close(): Promise<void> {
    if (this.closing)
      return this.closing
    this.closed = true
    for (const controller of this.controllers)
      controller.abort()
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    this.server.close(error => error ? reject(new Error('The local provider gateway could not close.')) : resolve())
    for (const socket of this.sockets)
      socket.destroy()
    this.closing = promise.finally(async () => {
      await this.writes
      this.keys = {}
      this.jevProvider = undefined
    })
    return this.closing
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const controller = new AbortController()
    this.controllers.add(controller)
    const abort = () => controller.abort()
    const timeout = setTimeout(abort, 120_000)
    timeout.unref()
    request.once('aborted', abort)
    request.on('error', abort)
    response.once('close', abort)
    try {
      if (this.closed)
        throw new GatewayError(503, 'The local provider gateway is closed.')
      const origin = request.headers.origin
      if (!allowedOrigin(origin))
        throw new GatewayError(403, 'Only local application origins are allowed.')
      if (origin !== undefined) {
        response.setHeader('Access-Control-Allow-Origin', origin)
        response.setHeader('Vary', 'Origin')
      }
      const route = routeFor(request.url, this.jevProvider)
      if (!route)
        throw new GatewayError(404, 'The provider route does not exist.')
      // Browser preflight cannot carry a bearer token. Authentication remains mandatory on the actual request.
      if (request.method === 'OPTIONS') {
        const headers = request.headers['access-control-request-headers']
        if (request.headers['access-control-request-method'] !== route.method
          || (headers !== undefined && headers.split(',').some(header => !['authorization', 'content-type', 'accept'].includes(header.trim().toLowerCase())))) {
          throw new GatewayError(403, 'The requested CORS method or headers are not allowed.')
        }
        response.writeHead(204, {
          'Access-Control-Allow-Methods': route.method,
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
          'Access-Control-Max-Age': '600',
        })
        response.end()
        return
      }
      const authorization = Buffer.from(request.headers.authorization ?? '')
      if (authorization.length !== this.authorization.length || !timingSafeEqual(authorization, this.authorization))
        throw new GatewayError(401, 'The local gateway token is missing or invalid.')
      if (request.method !== route.method)
        throw new GatewayError(405, 'The request method is not allowed.')
      const key = this.jevProvider?.apiKey
      if (key === undefined)
        throw new GatewayError(503, 'Jev is not configured.')

      let body: string | undefined
      if (route.method === 'POST') {
        if (request.headers['content-encoding'] !== undefined && request.headers['content-encoding'] !== 'identity')
          throw new GatewayError(415, 'Compressed request bodies are not supported.')
        if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')
          throw new GatewayError(415, 'The request body must use application/json.')
        const bytes = await readBody(request, controller.signal)
        let json: unknown
        try {
          json = JSON.parse(bytes.toString('utf8'))
        }
        catch {
          throw new GatewayError(400, 'The request body must contain valid JSON.')
        }
        const parsed = safeParse(requestSchema, json)
        if (!parsed.success || parsed.output.model !== route.model)
          throw new GatewayError(400, `This route only accepts model ${route.model}.`)
        body = JSON.stringify(parsed.output)
      }
      const { promise, resolve, reject } = Promise.withResolvers<IncomingMessage>()
      const outgoing = requestHttps(route.url, {
        method: route.method,
        signal: controller.signal,
        headers: {
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
          Accept: 'application/json, text/event-stream',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }),
        },
      }, resolve)
      outgoing.once('error', reject)
      outgoing.end(body)
      const upstream = await promise
      const status = upstream.statusCode ?? 502
      if (status < 200 || status >= 300) {
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of upstream) {
          size += chunk.length
          if (size > 64 * 1024) {
            chunks.length = 0
            break
          }
          chunks.push(chunk)
        }
        let detail = ''
        try {
          const parsed = safeParse(looseObject({ error: optional(looseObject({ message: string() })), message: optional(string()) }), JSON.parse(Buffer.concat(chunks).toString('utf8')))
          if (parsed.success) {
            const message = parsed.output.error?.message ?? parsed.output.message ?? ''
            const redacted = key ? message.split(key).join('[credential removed]') : message
            detail = redacted.split(this.token).join('[token removed]').slice(0, 1_000)
          }
        }
        catch {
          // Non-JSON or oversized error responses retain the HTTP status without exposing response bytes.
        }
        throw new GatewayError(status >= 400 && status <= 599 ? status : 502, `The ${route.provider} provider rejected the request (HTTP ${status}).${detail ? ` ${detail}` : ''}`)
      }
      response.writeHead(status, {
        'Content-Type': upstream.headers['content-type'] ?? 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      // Forward response bytes unchanged. Reasoning and tool calls never become spoken content here.
      await pipeline(upstream, response, { signal: controller.signal })
    }
    catch (error) {
      if (error instanceof GatewayError)
        sendError(response, error.statusCode, error.message)
      else
        sendError(response, controller.signal.aborted ? 504 : 502, controller.signal.aborted ? 'The provider request was cancelled or timed out.' : 'The provider connection failed.')
    }
    finally {
      clearTimeout(timeout)
      controller.abort()
      this.controllers.delete(controller)
      request.off('aborted', abort)
      request.off('error', abort)
      response.off('close', abort)
    }
  }
}

/** Call after Electron is ready. Corrupt or inaccessible vaults reject startup without replacing saved credentials. */
export async function createCompanionGateway(options: { dataPath: string }): Promise<CompanionGateway> {
  const directory = join(options.dataPath, 'companion-vault')
  const keys = await loadKeys(directory)
  const gateway = new LoopbackGateway(directory, keys)
  await gateway.listen()
  return gateway
}
