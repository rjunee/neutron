import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

export interface NativeModelResolutionInput {
  /** A host-selected, protected executable, not a worker-selected command. */
  executable: { path: string; sha256: string }
  selector: string
  cwd: string
  /** The intended parent's complete environment. Never implicitly inherit ours. */
  env: NodeJS.ProcessEnv
  /** JSON settings and source order from the intended parent launch. */
  settingsJson: string
  settingSources: readonly ('user' | 'project' | 'local')[]
  /** Caller-owned epoch covering account, provider, settings and environment.
   * This is not a credential hash. A changed epoch invalidates any cached result. */
  profileId: string
  signal?: AbortSignal
  timeoutMs?: number
}

export type NativeModelResolution = {
  status: 'resolved'
  source: 'native-local-model-command'
  selector: string
  modelId: string
  profileId: string
  sessionId: string
  executableSha256: string
  observedAtMs: number
  /** Native init does not attest every settings/helper/descriptor auth route. */
  authEvidence: { status: 'unknown'; reason: 'native-init-incomplete'; apiKeySource?: string }
} | { status: 'unknown'; reason: 'invalid-profile' | 'executable-mismatch' | 'cancelled' | 'protocol' | 'process' }

const OUTPUT_LIMIT = 1024 * 1024
const EXECUTABLE_LIMIT = 512 * 1024 * 1024
const concreteModel = (value: unknown): value is string => typeof value === 'string'
  && /^claude-[a-z][a-z0-9-]*-\d[a-z0-9.-]*$/.test(value) && value.length <= 127
const object = (value: unknown): value is Record<string, unknown> => value !== null
  && typeof value === 'object' && !Array.isArray(value)

async function executableIdentity(path: string, signal: AbortSignal): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile() || !(before.mode & 0o111) || before.size > EXECUTABLE_LIMIT) throw new Error('invalid executable')
    const hash = createHash('sha256'), buffer = Buffer.alloc(256 * 1024)
    let offset = 0
    while (offset < before.size) {
      signal.throwIfAborted()
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset)
      if (!bytesRead) throw new Error('short executable')
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead
    }
    const after = await file.stat(), named = await lstat(path)
    if ([after, named].some(info => !info.isFile() || info.dev !== before.dev || info.ino !== before.ino
      || info.size !== before.size || info.mtimeMs !== before.mtimeMs || info.ctimeMs !== before.ctimeMs)) throw new Error('changed executable')
    signal.throwIfAborted()
    return hash.digest('hex')
  } finally { await file.close() }
}

/** A metadata probe, never an LLM-dispatch backend. The local slash command
 * produces system/init before a zero-turn result. Neither model prose nor a
 * worker-writable transcript is consumed. Startup may still perform native
 * account/configuration housekeeping; zero inference is not zero network I/O.
 *
 * The caller must use this same profile for a NEW parent and pin modelId in its
 * actual native model configuration. This receipt cannot upgrade an old parent,
 * prove a child used that model, or prove which account served a request. */
export async function resolveNativeModel(input: NativeModelResolutionInput): Promise<NativeModelResolution> {
  const unknown = (reason: Extract<NativeModelResolution, { status: 'unknown' }>['reason']): Extract<NativeModelResolution, { status: 'unknown' }> => ({ status: 'unknown', reason })
  let settings: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(input.settingsJson)
    if (!object(parsed) || !isAbsolute(input.executable.path) || !isAbsolute(input.cwd)
      || !/^[a-f0-9]{64}$/.test(input.executable.sha256) || !/^(fable|opus|sonnet|haiku)$/.test(input.selector)
      || !/^[A-Za-z0-9_-]{1,128}$/.test(input.profileId) || !object(input.env)
      || Object.values(input.env).some(value => value !== undefined && typeof value !== 'string')
      || !Array.isArray(input.settingSources) || input.settingSources.some(value => !['user', 'project', 'local'].includes(value))
      || new Set(input.settingSources).size !== input.settingSources.length
      || input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)) return unknown('invalid-profile')
    settings = { ...parsed, disableAllHooks: true }
  } catch { return unknown('invalid-profile') }
  // Snapshot parity inputs before the first await; a caller cannot rewrite an
  // in-flight probe's environment or relabel its result with another profile.
  const executable = { ...input.executable }, env = { ...input.env }, cwd = input.cwd
  const selector = input.selector, profileId = input.profileId, settingSources = input.settingSources.join(',')
  const sessionId = randomUUID()
  const deadline = AbortSignal.timeout(Math.max(1, Math.min(input.timeoutMs ?? 15_000, 30_000)))
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline
  try {
    if (await executableIdentity(executable.path, signal) !== executable.sha256) return unknown('executable-mismatch')
  } catch { return unknown(signal.aborted ? 'cancelled' : 'executable-mismatch') }
  if (signal.aborted) return unknown('cancelled')
  const args = ['-p', '--verbose', '--output-format', 'stream-json',
    '--model', selector, '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', settingSources, '--settings', JSON.stringify(settings), '--no-session-persistence',
    '--session-id', sessionId, '--max-turns', '1', '--max-budget-usd', '0.01', `/model ${selector}`]
  const observed = await new Promise<{ modelId: string; apiKeySource?: string } | Extract<NativeModelResolution, { status: 'unknown' }>>(resolve => {
    let child: ReturnType<typeof spawn>
    try { child = spawn(executable.path, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch { resolve({ status: 'unknown', reason: 'process' }); return }
    let bytes = 0, pending = '', modelId: string | undefined, apiKeySource: string | undefined, completed = false, settled = false
    const finish = (value: { modelId: string; apiKeySource?: string } | Extract<NativeModelResolution, { status: 'unknown' }>, kill = false) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      if (kill) child.kill('SIGKILL')
      resolve(value)
    }
    const abort = () => finish(unknown('cancelled'), true)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    const refuse = () => finish(unknown('protocol'), true)
    const consume = (line: string) => {
      if (settled) return
      let row: unknown
      try { row = JSON.parse(line) } catch { refuse(); return }
      if (!object(row) || row.session_id !== sessionId || completed) { refuse(); return }
      if (row.type === 'system' && row.subtype === 'init') {
        if (modelId !== undefined || !concreteModel(row.model)
          || row.apiKeySource !== undefined && (typeof row.apiKeySource !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.apiKeySource))) { refuse(); return }
        modelId = row.model
        apiKeySource = row.apiKeySource as string | undefined
      } else if (row.type === 'assistant') {
        // A local-command display frame has no provider model (the native CLI
        // labels it <synthetic>). Any actual
        // provider message, tool invocation or pre-init frame fails closed.
        if (!modelId || !object(row.message) || row.message.model !== undefined && row.message.model !== '<synthetic>'
          || row.isApiErrorMessage === true
          || !Array.isArray(row.message.content) || row.message.content.some(block => !object(block) || block.type !== 'text')) refuse()
      } else if (row.type === 'result') {
        if (!modelId || row.subtype !== 'success' || row.is_error !== false
          || row.duration_api_ms !== 0 || row.num_turns !== 0 || row.total_cost_usd !== 0) { refuse(); return }
        completed = true
      } else refuse()
    }
    child.stdout!.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > OUTPUT_LIMIT) { refuse(); return }
      pending += chunk.toString('utf8')
      while (pending.includes('\n') && !settled) {
        const end = pending.indexOf('\n'), line = pending.slice(0, end)
        pending = pending.slice(end + 1)
        consume(line)
      }
    })
    child.stderr!.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > OUTPUT_LIMIT) refuse() })
    child.on('error', () => finish(unknown('process'), true))
    child.on('close', (code, exitSignal) => {
      if (code !== 0 || exitSignal !== null) finish(unknown('process'))
      else if (!completed || pending.length !== 0 || !modelId) finish(unknown('protocol'))
      else finish({ modelId, ...(apiKeySource === undefined ? {} : { apiKeySource }) })
    })
  })
  if ('status' in observed) return observed
  try {
    if (await executableIdentity(executable.path, signal) !== executable.sha256) return unknown('executable-mismatch')
  } catch { return unknown(signal.aborted ? 'cancelled' : 'executable-mismatch') }
  return { status: 'resolved', source: 'native-local-model-command', selector, modelId: observed.modelId,
    profileId, sessionId, executableSha256: executable.sha256, observedAtMs: Date.now(),
    authEvidence: { status: 'unknown', reason: 'native-init-incomplete',
      ...(observed.apiKeySource === undefined ? {} : { apiKeySource: observed.apiKeySource }) } }
}
