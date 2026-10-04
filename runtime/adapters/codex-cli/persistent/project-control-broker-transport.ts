import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { readFileSync, realpathSync } from 'node:fs'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import { nativeBunEnvironment } from './native-bun-cache.ts'
import { acquireCodexAccountWriteLease, codexAccountWriterLauncher, CodexAccountWriterError, type CodexAccountWriteLease } from '../account-writer-lock.ts'

export interface ProjectControlTransport {
  send(message: Record<string, unknown>): void
  listen(message: (value: unknown) => void, disconnect: (error: Error) => void): void
  close(): void
  /** Exact spawned child exit; absent on transports that cannot prove death. */
  readonly exited?: Promise<NativeProcessExit>
  /** Captured at spawn, before any native request; also survives in the attestation. */
  readonly processIdentity?: { pid: number; boot: string; start: string }
}

export interface NativeProcessExit { pid: number; boot: string; start: string; code: number | null; signal: NodeJS.Signals | null }

export const BROKER_MAX_MESSAGE_BYTES = 4 * 1024 * 1024

/** The child has no network listener: every native request crosses this pipe. */
export function createProjectControlStdioTransport(options: {
  binary: string
  cwd: string
  codexHome: string
  env: Readonly<Record<string, string>>
  configOverrides?: readonly string[]
  accountWriteLease?: CodexAccountWriteLease
}): ProjectControlTransport {
  if (!isAbsolute(options.cwd) || !isAbsolute(options.codexHome)) throw new Error('Explicit project paths required')
  const env = nativeBunEnvironment(options.env)
  const lease = options.accountWriteLease ?? acquireCodexAccountWriteLease(options.codexHome)
  if (lease.canonicalHome !== realpathSync(options.codexHome)) {
    throw new CodexAccountWriterError('accountAdmissionUnknown', 'Account writer lease belongs to a different home')
  }
  const child = (() => {
    try {
      return spawn('python3', ['-B', codexAccountWriterLauncher, '--home', options.codexHome,
        '--inherited-lock-fd', '3', '--', options.binary, 'app-server', '--listen', 'stdio://',
        ...(options.configOverrides ?? []).flatMap(value => ['-c', value])], {
        cwd: options.cwd, env: { ...env, CODEX_HOME: options.codexHome }, stdio: ['pipe', 'pipe', 'pipe', lease.fd],
      }) as ChildProcessWithoutNullStreams
    } finally { lease.close() }
  })()
  let receive: ((value: unknown) => void) | undefined
  let disconnect: ((error: Error) => void) | undefined
  let failure: Error | undefined
  let buffer = ''
  let identity: { pid: number; boot: string; start: string } | undefined
  try {
    if (child.pid !== undefined) {
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
      const stat = readFileSync(`/proc/${child.pid}/stat`, 'utf8')
      const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
      if (boot && start && /^\d+$/.test(start)) identity = { pid: child.pid, boot, start }
    }
  } catch { /* An unobserved process identity cannot yield a retirement receipt. */ }
  const exited = new Promise<NativeProcessExit>((resolve, reject) => {
    child.once('exit', (code, signal) => {
      if (!identity) reject(new Error('Native child identity missing'))
      else resolve({ ...identity, code, signal })
    })
    child.once('error', reject)
  })
  // Ordinary close callers need not consume the optional exit proof.
  fireAndForget('codex-cli.project-control-transport.exit', exited)
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
    exited,
    ...(identity ? { processIdentity: identity } : {}),
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
