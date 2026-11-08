import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

interface Options {
  binaryPath: string
  dataPath: string
  archivePath: string
  jevURL: string
  model: string
  token: string
}

interface Entry {
  characterId: string
  sessionId: string
  messageId: string
  recordedAt: string
  user: string
  assistant: string
}

const entryName = /^[a-f0-9]{64}\.md$/

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Archives final conversation text before indexing it with the official SAG CLI.
 * Callers supply a dedicated data directory, a loopback Jev gateway, and its local token.
 * Callers must exclude upstream credentials and separate reasoning or image fields.
 * Operations serialize filesystem changes and index updates. Close cancels CLI requests and rejects queued operations.
 */
export class SagMemory {
  private readonly options: Options
  private queue: Promise<void> = Promise.resolve()
  private readonly children = new Map<ChildProcessWithoutNullStreams, () => void>()
  private closed = false
  private serviceUsed = false
  private closing?: Promise<void>

  constructor(options: Options) {
    const url = new URL(options.jevURL)
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash) {
      throw new Error('SAG requires a local HTTP Jev gateway without URL credentials.')
    }
    if (!options.token || /[\r\n]/.test(options.token))
      throw new Error('SAG requires a local gateway token without line breaks.')
    if (!options.model.trim())
      throw new Error('SAG requires the selected Jev model.')
    if (!options.binaryPath || !options.dataPath || !options.archivePath)
      throw new Error('SAG executable, data, and archive paths are required.')
    this.options = {
      ...options,
      binaryPath: resolve(options.binaryPath),
      dataPath: resolve(options.dataPath),
      archivePath: resolve(options.archivePath),
    }
    if (this.options.dataPath === this.options.archivePath)
      throw new Error('SAG data and conversation archives require separate directories.')
  }

  /** Configures only the dedicated SAG instance. The gateway token goes through stdin. */
  configure(): Promise<string> {
    return this.enqueue(async () => {
      await this.prepare()
      const version = (await this.run(['--version'], 'version', 10_000)).trim()
      if (!/^sag\s+\S+/.test(version))
        throw new Error('The configured executable did not report a SAG version.')
      await this.run(['config', '--url', this.options.jevURL, '--model', this.options.model, '--auth', 'bearer', '--key-stdin'], 'configuration', 20_000, `${this.options.token}\n`)
      return version
    })
  }

  /** Existing message files win over repeated appends, including manual edits. Index failures leave the archive intact. */
  append(input: Entry): Promise<void> {
    return this.enqueue(async () => {
      const directory = await this.characterDirectory(input.characterId)
      const id = `${hash(JSON.stringify([input.sessionId, input.messageId]))}.md`
      const path = join(directory, id)
      const date = new Date(input.recordedAt)
      if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(input.recordedAt) || !Number.isFinite(date.getTime()))
        throw new Error('Memory timestamps require a valid date and an explicit time zone.')
      if (await this.isEntry(`${path}.deleted`))
        return
      const clearedPath = join(directory, '.cleared-at')
      if (await this.isEntry(clearedPath)) {
        const clearedAt = Date.parse(await readFile(clearedPath, 'utf8'))
        if (!Number.isFinite(clearedAt))
          throw new Error('The memory clear record is damaged.')
        if (date.getTime() <= clearedAt)
          return
      }
      if (!await this.isEntry(path)) {
        const metadata = (value: string) => JSON.stringify(this.text(value))
        const content = [
          `# Conversation — ${date.toISOString()}`,
          '',
          `Recorded at (UTC): ${date.toISOString()}`,
          `Recorded at (original time zone): ${metadata(input.recordedAt)}`,
          `Character ID: ${metadata(input.characterId)}`,
          `Session ID: ${metadata(input.sessionId)}`,
          `Message ID: ${metadata(input.messageId)}`,
          '',
          '## User — original words',
          '',
          this.text(input.user),
          '',
          '## Character — final reply',
          '',
          this.text(input.assistant),
          '',
        ].join('\n')
        await this.atomicWrite(path, content, false)
      }
      await this.index(directory)
    })
  }

  /** Returns at most 12,000 characters of cited SAG evidence. Retrieval failures reject instead of returning empty memory. */
  search(input: { characterId: string, query: string }): Promise<{ context: string, sourceCount: number }> {
    return this.enqueue(async () => {
      const directory = await this.characterDirectory(input.characterId)
      // Reindex persisted files after interrupted appends, edits, or deletions before exposing search results.
      await this.index(directory)
      const output = await this.run(['-c', '--path', directory, '-m', '5', '--json', '--timeout', '20', '--', input.query], 'search', 25_000)
      const parsed: unknown = this.parse(output, 'search')
      if (!object(parsed) || parsed.protocol_version !== 2 || parsed.scope !== directory || !Array.isArray(parsed.results))
        throw new Error('SAG returned an invalid search response or another character scope.')
      let context = ''
      const sources = new Set<string>()
      for (const result of parsed.results) {
        if (!object(result) || typeof result.absolute_path !== 'string' || !isAbsolute(result.absolute_path)
          || typeof result.content !== 'string' || typeof result.start_line !== 'number' || typeof result.end_line !== 'number'
          || !Number.isSafeInteger(result.start_line) || !Number.isSafeInteger(result.end_line)
          || result.start_line < 1 || result.end_line < result.start_line) {
          throw new Error('SAG returned invalid source content or line numbers.')
        }
        const path = resolve(result.absolute_path)
        if (dirname(path) !== directory || !entryName.test(basename(path)))
          throw new Error('SAG returned a source outside the selected character archive.')
        if (sources.has(path))
          continue
        if (!await this.isEntry(path))
          throw new Error('A SAG source no longer exists. Search again to refresh the index.')
        const prefix = `${context ? '\n\n' : ''}Source: ${path}\nSAG match: lines ${result.start_line}-${result.end_line}\n`
        const remaining = 12_000 - context.length - prefix.length
        if (remaining <= 0)
          break
        // A matched line can omit its speaker and date. Keep the cited turn's original headers with the evidence.
        const content = this.text(await readFile(path, 'utf8')).slice(0, remaining)
        context += prefix + content
        sources.add(path)
        if (context.length >= 12_000)
          break
      }
      return { context, sourceCount: sources.size }
    })
  }

  list(characterId: string): Promise<Array<{ id: string, title: string }>> {
    return this.enqueue(async () => {
      const directory = await this.characterDirectory(characterId)
      const entries: Array<{ id: string, title: string }> = []
      for (const id of (await readdir(directory)).sort()) {
        if (!entryName.test(id))
          continue
        const path = join(directory, id)
        if (await this.isEntry(path)) {
          const content = await readFile(path, 'utf8')
          const title = content.split('\n', 1)[0].replace(/^#+\s*/, '').slice(0, 200)
          entries.push({ id, title: this.text(title) })
        }
      }
      return entries
    })
  }

  read(characterId: string, id: string): Promise<string> {
    return this.enqueue(async () => {
      const path = this.entryPath(await this.characterDirectory(characterId), id)
      await this.requireEntry(path)
      return this.text(await readFile(path, 'utf8'))
    })
  }

  /** Atomically replaces an existing entry, then refreshes its character index. */
  write(characterId: string, id: string, content: string): Promise<void> {
    return this.enqueue(async () => {
      const directory = await this.characterDirectory(characterId)
      const path = this.entryPath(directory, id)
      await this.requireEntry(path)
      await this.atomicWrite(path, this.text(content), true)
      await this.index(directory)
    })
  }

  /** Removes the actual source file. Reindexing removes its stale evidence from SAG. */
  remove(characterId: string, id: string): Promise<void> {
    return this.enqueue(async () => {
      const directory = await this.characterDirectory(characterId)
      const path = this.entryPath(directory, id)
      // A retry of the same chat turn must respect the user's deletion after a restart.
      await this.atomicWrite(`${path}.deleted`, new Date().toISOString(), false)
      if (await this.isEntry(path))
        await rm(path)
      await this.index(directory)
    })
  }

  /** Clears only the selected character directory and its SAG root. Application chat history is outside this module. */
  clear(characterId: string): Promise<void> {
    return this.enqueue(async () => {
      const directory = await this.characterDirectory(characterId)
      await this.atomicWrite(join(directory, '.cleared-at'), new Date().toISOString(), true)
      for (const entry of await readdir(directory)) {
        if (entry !== '.cleared-at')
          await rm(join(directory, entry), { recursive: true, force: true })
      }
      await this.run(['remove', directory, '--json'], 'index removal', 20_000)
    })
  }

  /** Cancels child commands, drains archive writes, then stops only the dedicated SAG_DATA_DIR service. */
  close(): Promise<void> {
    if (this.closing)
      return this.closing
    this.closed = true
    for (const cancel of this.children.values())
      cancel()
    this.closing = (async () => {
      await this.queue
      if (this.serviceUsed)
        await this.run(['service', 'stop'], 'service shutdown', 15_000, undefined, true)
    })()
    return this.closing
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      if (this.closed)
        throw new Error('SAG memory is closed.')
      return operation()
    })
    // A failed operation must not block later archive writes or a retry of its index update.
    this.queue = result.then(() => {}, () => {})
    return result
  }

  private async privateDirectory(path: string): Promise<string> {
    await mkdir(path, { recursive: true, mode: 0o700 })
    if (!(await lstat(path)).isDirectory())
      throw new Error('The memory directory must be a real directory, not a symbolic link.')
    await chmod(path, 0o700)
    return realpath(path)
  }

  private async prepare(): Promise<void> {
    await this.privateDirectory(this.options.archivePath)
    await this.privateDirectory(this.options.dataPath)
  }

  private async characterDirectory(characterId: string): Promise<string> {
    const root = await this.privateDirectory(this.options.archivePath)
    return this.privateDirectory(join(root, hash(characterId)))
  }

  private entryPath(directory: string, id: string): string {
    if (!entryName.test(id))
      throw new Error('Memory entry IDs must be generated SHA256 Markdown filenames.')
    return join(directory, id)
  }

  private async isEntry(path: string): Promise<boolean> {
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.nlink !== 1)
        throw new Error('Memory entries must be regular files without symbolic or hard links.')
      await chmod(path, 0o600)
      return true
    }
    catch (error) {
      if (hasCode(error, 'ENOENT'))
        return false
      throw error
    }
  }

  private async requireEntry(path: string): Promise<void> {
    if (!await this.isEntry(path))
      throw new Error('The memory entry does not exist.')
  }

  private async atomicWrite(path: string, content: string, replace: boolean): Promise<void> {
    const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(content, 'utf8')
        await handle.sync()
      }
      finally {
        await handle.close()
      }
      if (replace) {
        await rename(temporary, path)
      }
      else {
        try {
          // A hard link publishes the complete file without replacing a concurrent append or manual edit.
          await link(temporary, path)
        }
        catch (error) {
          if (!hasCode(error, 'EEXIST'))
            throw error
          await this.requireEntry(path)
        }
      }
    }
    finally {
      await rm(temporary, { force: true })
    }
  }

  private text(value: string): string {
    if (value.includes(this.options.token))
      throw new Error('Memory text contains the local gateway token. Remove credentials before archiving.')
    if (/data:image\/[^\s,]+,/i.test(value))
      throw new Error('Memory accepts text only. Remove image attachments before archiving.')
    return value
  }

  private parse(output: string, operation: string): unknown {
    try {
      return JSON.parse(output)
    }
    catch {
      throw new Error(`SAG returned invalid JSON during ${operation}.`)
    }
  }

  private async index(directory: string): Promise<void> {
    const checked = this.parse(await this.run(['check', directory, '--json'], 'index status', 10_000), 'index status')
    if (!object(checked) || checked.path !== directory)
      throw new Error('SAG returned an invalid index status or another character scope.')
    const args = ['add', directory, '--json']
    // Plain add waits for startup indexing. Reapplying --types during that work fails because it changes the index settings.
    if (!Array.isArray(checked.extensions) || checked.extensions.length !== 1 || checked.extensions[0] !== 'md')
      args.push('--types', 'md')
    const parsed = this.parse(await this.run(args, 'index update', 25_000), 'index update')
    if (!object(parsed) || parsed.path !== directory || parsed.index_status !== 'ready' || parsed.cli_authorized !== true)
      throw new Error('The archive is saved, but the SAG index is not ready. Retry the operation.')
  }

  private async run(args: string[], operation: string, timeout: number, input?: string, closing = false): Promise<string> {
    if (this.closed && !closing)
      throw new Error('SAG memory is closed. Saved archive files remain available.')
    try {
      await access(this.options.binaryPath, constants.X_OK)
    }
    catch {
      throw new Error(`SAG executable is missing or cannot run: ${this.options.binaryPath}. Saved archive files remain available.`)
    }
    const dataPath = await this.privateDirectory(this.options.dataPath)
    if (this.closed && !closing)
      throw new Error('SAG memory is closed. Saved archive files remain available.')
    if (args[0] !== '--version' && !closing)
      this.serviceUsed = true
    return new Promise<string>((resolvePromise, reject) => {
      const child = spawn(this.options.binaryPath, args, {
        shell: false,
        windowsHide: true,
        cwd: dataPath,
        env: { ...process.env, SAG_DATA_DIR: dataPath, SAG_DESKTOP_DATA_DIR: dataPath },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let bytes = 0
      let failure: Error | undefined
      let force: NodeJS.Timeout | undefined
      const stop = (message: string) => {
        if (failure)
          return
        failure = new Error(message)
        // SAG handles SIGINT by cancelling its active request. SIGKILL bounds an unresponsive CLI, never another SAG instance.
        child.kill('SIGINT')
        force = setTimeout(() => child.kill('SIGKILL'), 1_000)
      }
      const timer = setTimeout(stop, timeout, `SAG ${operation} timed out. Saved archive files remain available.`)
      this.children.set(child, () => stop('SAG memory closed and cancelled the active command.'))
      const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 1024 * 1024) {
          stop(`SAG ${operation} exceeded the output limit.`)
          return
        }
        chunks.push(chunk)
      }
      child.stdout.on('data', collect(stdout))
      child.stderr.on('data', collect(stderr))
      child.on('error', () => {
        failure ??= new Error(`SAG ${operation} could not start. Check the executable path and permissions.`)
      })
      child.stdin.on('error', () => stop(`SAG ${operation} could not receive its input.`))
      child.on('close', (code) => {
        clearTimeout(timer)
        if (force)
          clearTimeout(force)
        this.children.delete(child)
        if (failure) {
          reject(failure)
        }
        // Check exits 1 for valid JSON describing empty, unregistered, or pending indexes. Execution errors exit 2.
        else if (code !== 0 && (args[0] !== 'check' || code !== 1)) {
          const detail = Buffer.concat(stderr).toString('utf8').split(this.options.token).join('[token removed]').trim().slice(0, 2_000)
          reject(new Error(`SAG ${operation} failed (${code ?? 'signal'}). ${detail || 'The command returned no error details.'}`))
        }
        else {
          resolvePromise(Buffer.concat(stdout).toString('utf8'))
        }
      })
      child.stdin.end(input)
    })
  }
}
