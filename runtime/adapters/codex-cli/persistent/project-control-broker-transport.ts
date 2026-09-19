import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'

export interface ProjectControlTransport {
  send(message: Record<string, unknown>): void
  listen(message: (value: unknown) => void, disconnect: (error: Error) => void): void
  close(): void
}

export const BROKER_MAX_MESSAGE_BYTES = 4 * 1024 * 1024

/** The child has no network listener: every native request crosses this pipe. */
export function createProjectControlStdioTransport(options: {
  binary: string
  cwd: string
  codexHome: string
  env: Readonly<Record<string, string>>
  configOverrides?: readonly string[]
}): ProjectControlTransport {
  if (!isAbsolute(options.cwd) || !isAbsolute(options.codexHome)) throw new Error('Explicit project paths required')
  const child = spawn(options.binary, ['app-server', '--listen', 'stdio://',
    ...(options.configOverrides ?? []).flatMap(value => ['-c', value])], {
    cwd: options.cwd, env: { ...options.env, CODEX_HOME: options.codexHome }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let receive: ((value: unknown) => void) | undefined
  let disconnect: ((error: Error) => void) | undefined
  let failure: Error | undefined
  let buffer = ''
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const fail = (error: Error): void => {
    if (failure) return
    failure = error
    child.kill()
    disconnect?.(error)
  }
  child.stdout.on('data', (chunk: Buffer) => {
    try {
      buffer += decoder.decode(chunk, { stream: true })
      let end: number
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (Buffer.byteLength(line) > BROKER_MAX_MESSAGE_BYTES) throw new Error('Oversized native message')
        if (line.trim()) receive?.(JSON.parse(line) as unknown)
      }
      if (Buffer.byteLength(buffer) > BROKER_MAX_MESSAGE_BYTES) throw new Error('Oversized native message')
    } catch { fail(new Error('Invalid native protocol stream')) }
  })
  child.stdout.on('error', () => fail(new Error('Native output failed')))
  child.stdin.on('error', () => fail(new Error('Native input failed')))
  child.stderr.resume()
  child.on('error', () => fail(new Error('Native child could not start')))
  child.on('close', () => fail(new Error('Native child disconnected')))
  return {
    listen(message, onDisconnect) { receive = message; disconnect = onDisconnect; if (failure) disconnect(failure) },
    send(message) {
      if (failure) throw failure
      const line = JSON.stringify(message)
      if (Buffer.byteLength(line) > BROKER_MAX_MESSAGE_BYTES) throw new Error('Oversized native request')
      child.stdin.write(`${line}\n`)
    },
    close() { fail(new Error('Native transport closed')) },
  }
}
