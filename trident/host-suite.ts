import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogger } from '@neutronai/logger'
import type { HostCommandResult } from './git-mode.ts'

interface SuiteCleanupReport {
  event: 'lane-process-cleanup'
  token: string
  owner_pid: number
  signal: 2 | 15 | null
  exit_code: number
  foreground_exit: number | null
  status: 'confirmed' | 'unknown'
  reaped: number[]
  survived: number[]
  unknown: number
  live: number
}

type SuiteCommandResult = HostCommandResult & { cleanup?: SuiteCleanupReport }
export type SuiteCommandRunner = (argv: string[], cwd?: string, env?: Record<string, string>,
  timeoutMs?: number, signal?: AbortSignal) => Promise<SuiteCommandResult>

/** Governed suites use an explicit non-login shell. Inherited startup hooks
 * must not add unmeasured commands or change the suite environment. */
export const HOST_SUITE_ENV = Object.freeze({ BASH_ENV: '' })

const log = createLogger('trident')
const ownershipError = () => new Error('Host suite process ownership or cleanup was not confirmed')

function readCleanupReport(path: string, token: string, pid: number, exitCode: number): SuiteCleanupReport {
  try {
    const report = JSON.parse(readFileSync(path, 'utf8')) as SuiteCleanupReport
    const code = (value: unknown) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 255
    const count = (value: unknown) => Number.isInteger(value) && Number(value) >= 0
    const pids = (value: unknown) => Array.isArray(value) && value.every(pid => Number.isInteger(pid) && pid > 1)
    if (report.event !== 'lane-process-cleanup' || report.token !== token || report.owner_pid !== pid
      || !code(report.exit_code) || report.exit_code !== exitCode
      || ![null, 2, 15].includes(report.signal)
      || (report.foreground_exit !== null && !code(report.foreground_exit))
      || !['confirmed', 'unknown'].includes(report.status)
      || !pids(report.reaped) || !pids(report.survived) || !count(report.unknown) || !count(report.live)
      || (report.signal === null && report.foreground_exit !== exitCode)
      || (report.signal !== null && exitCode !== 128 + report.signal)
      || (report.status === 'confirmed' && (report.foreground_exit === null
        || report.reaped.length !== 0 || report.survived.length !== 0 || report.unknown !== 0))) throw ownershipError()
    return report
  } catch { throw ownershipError() }
}

/** Each suite receives the existing lane owner's unique claim. The owner handles
 * TERM by reaping only that claim through pidfds, including detached descendants. */
const spawnOwnedSuite: SuiteCommandRunner = async (argv, cwd, env, timeoutMs, signal) => {
  const started = performance.now()
  if (signal?.aborted) throw new Error('Host suite cancelled before process creation')
  const owner = fileURLToPath(new URL('./lane-processes.py', import.meta.url))
  const reportDir = mkdtempSync(join(tmpdir(), 'host-suite-owner-'))
  const reportPath = join(reportDir, 'cleanup.json'), reportToken = randomUUID()
  const child = (() => {
    try {
      return Bun.spawn(['python3', '-B', owner, 'run', '--report-path', reportPath, '--report-token', reportToken, '--', ...argv], {
        ...(cwd === undefined ? {} : { cwd }),
        ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
        stdout: 'pipe', stderr: 'pipe',
      })
    } catch (error) {
      rmSync(reportDir, { recursive: true, force: true })
      throw error
    }
  })()
  let timedOut = false
  const stop = () => { if (child.exitCode === null) child.kill('SIGTERM') }
  const timeout = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
  signal?.addEventListener('abort', stop, { once: true })
  if (signal?.aborted) stop()
  const capture = (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    const text = (async () => {
      const decoder = new TextDecoder()
      let value = ''
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) return value + decoder.decode()
        value += decoder.decode(chunk.value, { stream: true })
      }
    })()
    return { text, cancel: () => reader.cancel() }
  }
  const stdoutCapture = capture(child.stdout), stderrCapture = capture(child.stderr)
  let drainTimeout: ReturnType<typeof setTimeout> | undefined
  try {
    const exitCode = await child.exited
    // An unconfirmed descendant can retain these pipes after the owner exits.
    // Bound the drain independently of its cooperation; never mint evidence.
    const [stdout, stderr] = await Promise.race([
      Promise.all([stdoutCapture.text, stderrCapture.text]),
      new Promise<never>((_resolve, reject) => {
        drainTimeout = setTimeout(() => reject(new Error('Host suite pipes remained open after process owner exit')), 1_000)
      }),
    ])
    const cleanup = readCleanupReport(reportPath, reportToken, child.pid, exitCode)
    log.info('host_suite_process_observed', { owner_pid: child.pid, exit_code: exitCode,
      timed_out: timedOut, aborted: signal?.aborted === true, timeout_ms: timeoutMs,
      elapsed_ms: Math.round(performance.now() - started), cleanup_status: cleanup.status,
      owner_signal: cleanup.signal, foreground_exit: cleanup.foreground_exit })
    if (cleanup.status === 'unknown') log.warn('host_suite_cleanup_unknown', { owner_pid: cleanup.owner_pid, report: JSON.stringify(cleanup) })
    // A valid ordinary exit remains usable even if unrelated process metadata
    // was unreadable. Interruption requires the separate, known closure proof.
    if ((cleanup.signal !== null || signal?.aborted || timedOut) && cleanup.status !== 'confirmed') throw ownershipError()
    if (cleanup.signal !== null && !timedOut) throw new Error('Host suite was interrupted')
    return { ok: exitCode === 0 && !timedOut, exit_code: exitCode, stdout: stdout.trim(), stderr: stderr.trim(),
      cleanup,
      ...(timedOut ? { timed_out: true } : {}) }
  } finally {
    clearTimeout(timeout)
    clearTimeout(drainTimeout)
    signal?.removeEventListener('abort', stop)
    await Promise.allSettled([stdoutCapture.cancel(), stderrCapture.cancel()])
    rmSync(reportDir, { recursive: true, force: true })
  }
}

/** Observe the durable run, not a process-local cancel registry: distinct store
 * instances and the served terminal-transition path refer to the same row. */
export async function runHostSuite(options: {
  argv: string[]
  cwd: string
  env?: Record<string, string>
  timeoutMs: number
  signal: AbortSignal
  isRunActive(): boolean
  run?: SuiteCommandRunner
}): Promise<SuiteCommandResult> {
  const controller = new AbortController()
  const observe = () => {
    try {
      if (options.signal.aborted || !options.isRunActive()) controller.abort('Host suite run was cancelled or is terminal')
    } catch { controller.abort('Host suite run authority is unreadable') }
  }
  observe()
  if (controller.signal.aborted) throw new Error(String(controller.signal.reason))
  options.signal.addEventListener('abort', observe, { once: true })
  const poll = setInterval(observe, 100)
  poll.unref()
  try {
    const result = await (options.run ?? spawnOwnedSuite)(options.argv, options.cwd, options.env, options.timeoutMs, controller.signal)
    // Cancellation concurrent with a zero exit cannot mint a success receipt.
    observe()
    if (controller.signal.aborted) throw new Error(String(controller.signal.reason))
    return result
  } finally {
    clearInterval(poll)
    options.signal.removeEventListener('abort', observe)
  }
}
