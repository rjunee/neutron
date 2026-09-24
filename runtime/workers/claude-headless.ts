import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, rename, writeFile, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { BoundedWorkOutcome, BoundedWorkRequest, ProviderObservation, Usage, WorkerRunner } from '../bounded-work.ts'
import { readArmedTrailerReservation, reserveTrailerSlot } from './trailer-slot.ts'
import { claudeObservation } from './provider-observation.ts'
import { createObservationPublisher, decodeObservationReceipt, recoverProviderObservation } from './provider-observation-recovery.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import { openWorkerView, workerTaskLabel, type WorkerPlacement, type WorkerViewSession } from './worker-placement.ts'

export interface ClaudeHeadlessRunnerOptions {
  /** Explicit host-selected authentication environment. Never defaults to process.env. */
  env: NodeJS.ProcessEnv
  cwd: string
  /** Existing, host-owned per-run directory, outside the worker's writable roots. */
  state_dir: string
  readable_roots?: readonly string[]
  schemas: ReadonlyMap<string, (result: unknown) => boolean>
  cliPath?: string
  /** Visible task-view tab in the dispatch's project Herdr workspace. The worker
   * stays this runner's native child: the tab shows a copy of its stdout and is
   * never consulted for the result, usage, exit status or cancellation. */
  placement?: WorkerPlacement
  /** Short task name for the tab label, e.g. the card slug. */
  taskName?: string
}

const ROLES = new Set(['plan', 'review', 'synthesis'])
const FLAGS = ['--safe-mode', '--restricted', '--permission-prompts', '--permission-mode', '--tools',
  '--strict-mcp-config', '--mcp-config', '--disable-slash-commands', '--session-id', '--resume',
  '--setting-sources', '--model', '--effort', '--output-format', '--json-schema', '--add-dir']
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MODEL_CLASSES = new Set(['opus', 'sonnet', 'haiku', 'fable'])
const unknown = (detail: string): BoundedWorkOutcome => ({ kind: 'unknown', detail })
const within = (root: string, path: string) => {
  const suffix = relative(root, path)
  return !isAbsolute(suffix) && suffix.split(sep)[0] !== '..'
}

/** Only the selected Claude credential and minimal process environment cross this boundary.
 * In particular, no owner channel, GitHub credential, provider endpoint, injected Node
 * loader, plugin, or inherited permission setting enters the child. */
function childEnvironment(options: ClaudeHeadlessRunnerOptions): NodeJS.ProcessEnv | undefined {
  const source = options.env
  const tokenName = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']
    .find(name => typeof source[name] === 'string' && source[name]!.trim() !== '')
  const config = source.CLAUDE_CONFIG_DIR || (source.HOME ? join(source.HOME, '.claude') : undefined)
  if (!tokenName && !config) return undefined
  const env: NodeJS.ProcessEnv = { PATH: source.PATH ?? '/usr/bin:/bin',
    HOME: tokenName ? options.state_dir : source.HOME ?? options.state_dir,
    CLAUDE_CONFIG_DIR: tokenName ? join(options.state_dir, 'claude-headless-auth') : config,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_SAFE_MODE: '1' }
  if (tokenName) env[tokenName] = source[tokenName]
  return env
}

/** Config paths can change accounts without changing names. When the selected
 * CLI cannot attest stable account identity, bind the credential bytes and
 * conservatively refuse refresh/rotation. Never persist the credential itself. */
function credentialIdentity(env: NodeJS.ProcessEnv | undefined): string | undefined {
  if (!env) return undefined
  const token = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']
    .find(name => env[name])
  if (token) return createHash('sha256').update(JSON.stringify([token, env[token]])).digest('hex')
  try {
    const bytes = readFileSync(join(env.CLAUDE_CONFIG_DIR!, '.credentials.json'))
    if (!bytes.length) return undefined
    return createHash('sha256').update(bytes).digest('hex')
  } catch { return undefined }
}

function probe(cli: string, env: NodeJS.ProcessEnv | undefined): ReturnType<WorkerRunner['supports']> {
  if (!env) return { ok: false, reason: 'provider-not-connected', detail: 'No Claude credential environment was selected.' }
  const help = spawnSync(cli, ['--help'], { env, encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024 })
  if (help.error || help.status !== 0) return { ok: false, reason: 'provider-not-connected', detail: 'Claude CLI is unavailable.' }
  if (!FLAGS.every(flag => help.stdout.includes(flag))) return { ok: false, reason: 'cli-contract', detail: 'Claude CLI lacks the required headless isolation or structured result contract.' }
  const auth = spawnSync(cli, ['--safe-mode', 'auth', 'status', '--json'], { env, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 })
  try {
    if (!auth.error && auth.status === 0 && JSON.parse(auth.stdout).loggedIn === true) return { ok: true }
  } catch { /* Unreadable authentication is not a connected provider. */ }
  return { ok: false, reason: 'provider-not-connected', detail: 'Selected Claude authentication is unavailable.' }
}

// The byte-count/FNV-1a receipt belongs to the bounded brief protocol. Runtime
// cannot import the higher-level trident implementation of that protocol.
function integrity(text: string): string {
  const bytes = Buffer.from(text)
  let hash = 0x811c9dc5
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
  return `${bytes.length}:${hash.toString(16).padStart(8, '0')}`
}

/** A receipt proves child exit, but not that the publishing host has stopped.
 * Only recover its lock after observing the owning process is gone. A permanent
 * per-generation recovery claim prevents two replacement hosts taking it over. */
async function acquireThreadLock(path: string, key: string, recover: boolean): Promise<(() => Promise<void>) | undefined> {
  const owner = JSON.stringify({ key, pid: process.pid, token: randomUUID() })
  try { await writeFile(path, owner, { mode: 0o600, flag: 'wx' }) }
  catch (error) {
    if (!recover || (error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined
    const previous = await readFile(path, 'utf8')
    const parsed = JSON.parse(previous)
    if (parsed?.key !== key || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0
      || typeof parsed.token !== 'string' || !/^[a-f0-9-]{36}$/.test(parsed.token)) return undefined
    try { process.kill(parsed.pid, 0); return undefined }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return undefined }
    try { await writeFile(`${path}.recovered-${parsed.token}`, owner, { mode: 0o600, flag: 'wx' }) }
    catch { return undefined }
    if (await readFile(path, 'utf8') !== previous) return undefined
    await writeFile(path, owner, { mode: 0o600 })
  }
  return async () => { await unlink(path) }
}

function envelopeSchema(req: BoundedWorkRequest) {
  return { type: 'object', properties: {
    schema: { type: 'string', const: req.result.schema }, run_id: { type: 'string', const: req.run_id },
    step_id: { type: 'string', const: req.step_id }, kind: { type: 'string', enum: ['completed', 'blocked'] },
    result: { type: 'object' }, on: { type: 'string' },
  }, required: ['schema', 'run_id', 'step_id', 'kind'], additionalProperties: false }
}

function decode(bytes: string, req: BoundedWorkRequest, sessionId: string, validate: (result: unknown) => boolean):
  { outcome: BoundedWorkOutcome; envelope?: string } {
  try {
    const receipt = JSON.parse(bytes)
    if (receipt?.type !== 'result' || receipt.subtype !== 'success' || receipt.is_error !== false || receipt.session_id !== sessionId) {
      return { outcome: unknown('Claude did not report a successful structured result.') }
    }
    if (!Array.isArray(receipt.permission_denials) || receipt.permission_denials.length !== 0) {
      return { outcome: { kind: 'blocked', on: 'Claude could not complete within the granted tool permissions.' } }
    }
    const value = receipt.structured_output
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.run_id !== req.run_id || value.step_id !== req.step_id || value.schema !== req.result.schema) {
      return { outcome: unknown('Claude structured result identity or schema did not match the dispatched step.') }
    }
    const keys = Object.keys(value).sort().join(',')
    if (value.kind === 'blocked' && keys === 'kind,on,run_id,schema,step_id'
      && typeof value.on === 'string' && value.on.trim()) {
      return { outcome: { kind: 'blocked', on: value.on }, envelope: JSON.stringify(value) }
    }
    if (value.kind !== 'completed' || keys !== 'kind,result,run_id,schema,step_id' || !validate(value.result)) {
      return { outcome: unknown('Claude structured result failed host payload validation.') }
    }
    const reported = Object.keys(receipt.modelUsage ?? {})
    if (reported.length !== 1 || (MODEL_CLASSES.has(req.model_id)
      ? !new RegExp(`^claude-${req.model_id}-[a-z0-9.-]+$`).test(reported[0]!)
      : reported[0] !== req.model_id)) {
      return { outcome: unknown('Claude did not attest the selected model or model class.') }
    }
    const measured = receipt.usage
    const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    let usage: Usage | null = null
    if (measured && count(measured.input_tokens) && count(measured.output_tokens)) {
      usage = { input_tokens: measured.input_tokens, output_tokens: measured.output_tokens,
        ...(count(measured.cache_read_input_tokens) ? { cache_read_input_tokens: measured.cache_read_input_tokens } : {}) }
    }
    return { outcome: { kind: 'completed', result: value.result, usage, model_reported: reported[0]!, thread_id: sessionId },
      envelope: JSON.stringify(value) }
  } catch { return { outcome: unknown('Claude structured result or host validator was unreadable.') } }
}

async function execute(cli: string, args: string[], env: NodeJS.ProcessEnv, cwd: string,
  prompt: string, signal: AbortSignal, wallMs: number, observe: (child: { pid: number; exitCode: number | null } | null) => void,
  observeBytes: (bytes: string) => void, view: WorkerViewSession):
  Promise<{ bytes: string; outcome?: BoundedWorkOutcome }> {
  if (signal.aborted || wallMs <= 0) return { bytes: '', outcome: unknown('Claude dispatch expired before process creation.') }
  return new Promise(resolveResult => {
    const child = Bun.spawn([cli, ...args], { cwd, env, detached: true, stdin: new Blob([prompt]), stdout: 'pipe', stderr: 'ignore' })
    observe(child)
    // The native worker exists; only now may a view of it be placed. Not awaited:
    // placement runs beside the read path and cannot delay or gate it.
    view.started()
    const chunks: Buffer[] = []
    let size = 0
    let stopped: 'killed' | 'timeout' | 'output' | undefined
    let killWait: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = (result: { bytes: string } | { outcome: BoundedWorkOutcome }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killWait)
      signal.removeEventListener('abort', abort)
      observe(null)
      resolveResult({ bytes: Buffer.concat(chunks).toString('utf8'), ...result })
    }
    const stop = (why: typeof stopped) => {
      if (stopped || settled) return
      stopped = why
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* Close must confirm death. */ }
      killWait = setTimeout(() => finish({ outcome: unknown('Claude process termination was not confirmed.') }), 2_000)
    }
    const abort = () => stop('killed')
    const timer = setTimeout(() => stop('timeout'), wallMs)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const read = async () => {
      const reader = child.stdout.getReader()
      try {
        while (true) {
          const item = await reader.read()
          if (item.done) break
          size += item.value.length
          if (size > MAX_OUTPUT_BYTES) stop('output')
          else {
            chunks.push(Buffer.from(item.value))
            // The SAME bytes the host decodes below, copied to the view. Display only.
            view.tee(item.value)
            // JSON output may be complete while the CLI remains alive. Only a
            // complete provider object supplies usage; partial text is unknown.
            if (Buffer.from(item.value).toString('utf8').trimEnd().endsWith('}')) observeBytes(Buffer.concat(chunks).toString('utf8'))
          }
        }
      } finally { reader.releaseLock() }
    }
    Promise.all([child.exited, read()]).then(([code]) => {
      if (stopped === 'output') return finish({ outcome: unknown('Claude result exceeded the host output limit.') })
      if (stopped) return finish({ outcome: { kind: 'failed', class: stopped, detail: 'Claude process stopped before bounded completion.' } })
      if (code !== 0) return finish({ outcome: { kind: 'failed', class: 'infra', detail: 'Claude process did not exit successfully.' } })
      finish({ bytes: Buffer.concat(chunks).toString('utf8') })
    }).catch(() => finish({ outcome: unknown('Claude process exit or output could not be observed.') }))
  })
}

/** Cross-provider read-only work. The harness's structured result is the only
 * completion authority; the host publishes its validated envelope outside the
 * worker's tool grants. No reply-text parsing or uncertain-step redispatch. */
export function createClaudeHeadlessRunner(input: ClaudeHeadlessRunnerOptions): WorkerRunner {
  const options = { ...input, env: { ...input.env }, schemas: new Map(input.schemas), readable_roots: [...input.readable_roots ?? []] }
  const cli = options.cliPath ?? 'claude'
  const env = childEnvironment(options)
  const credential = credentialIdentity(env)
  const startup = credential ? probe(cli, env) : { ok: false as const, reason: 'provider-not-connected' as const,
    detail: 'Selected Claude credential identity is unavailable.' }
  const live = new Map<string, { pid: number; exitCode: number | null }>()
  const keyFor = (req: { run_id: string; step_id: string }) => createHash('sha256').update(JSON.stringify([req.run_id, req.step_id])).digest('hex')
  const supports: WorkerRunner['supports'] = (role, placement) => placement !== 'headless'
    ? { ok: false, reason: 'placement-unavailable', detail: 'Claude headless work requires a different-provider project REPL.' }
    : !ROLES.has(role) ? { ok: false, reason: 'capability-unsupported', detail: 'Claude headless supports plan, review and synthesis only.' } : startup
  const runner: WorkerRunner = { provider: 'anthropic', supports,
    async observe(req) {
      if (!env || !credential) return undefined
      const key = keyFor(req)
      const state = resolve(options.state_dir)
      return recoverProviderObservation(join(state, `claude-step-${key}.json`), JSON.stringify(req),
        join(state, `claude-headless-receipt-${key}.json.observation`), 'claude-cli-json', async read => {
          const binding = JSON.stringify([req.run_id, await realpath(options.cwd), req.model_id,
            createHash('sha256').update(JSON.stringify([env, credential])).digest('hex')])
          const session = await read(join(state, `claude-headless-session-${key}.json`))
          if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(session) || (req.thread && req.thread.id !== session)) return false
          return await read(join(state, `claude-headless-thread-${session}.json`)) === binding
        })
    },
    run: (...args) => executeWork(false, ...args),
    recover: (...args) => executeWork(true, ...args),
    async liveness(handle) {
      const child = live.get(keyFor(handle))
      return child && child.exitCode === null ? 'activity' : 'unknown'
    },
  }
  const executeWork = async (recoveryOnly: boolean, ...[req, placement, signal]: Parameters<WorkerRunner['run']>): Promise<BoundedWorkOutcome> => {
      const supported = supports(req.role, placement)
      if (!supported.ok) return { kind: 'refused', reason: supported.reason }
      const validate = options.schemas.get(req.result.schema)
      if (!validate || (req.thread !== null && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(req.thread.id)) || req.needs_approval_decision !== false
        || (!MODEL_CLASSES.has(req.model_id) && !/^claude-[a-z0-9.-]+$/.test(req.model_id))
        || !['none', 'read-only', 'edit', 'edit-and-run'].includes(req.tools)
        || (req.effort !== null && !['low', 'medium', 'high', 'xhigh', 'max'].includes(req.effort))
        || !Number.isSafeInteger(req.budget.wall_ms) || req.budget.wall_ms <= 0) {
        return { kind: 'refused', reason: 'capability-unsupported' }
      }
      const deadline = Date.now() + req.budget.wall_ms
      const expired = () => signal.aborted || Date.now() >= deadline
      if (expired()) return unknown('Claude dispatch expired before reservation.')
      // Recovery may inspect credentials, but must not launch even CLI probes.
      if (credentialIdentity(env) !== credential || (!recoveryOnly && !probe(cli, env).ok)) {
        return { kind: 'refused', reason: 'provider-not-connected' }
      }
      let observation: ProviderObservation | undefined
      const observed = (outcome: BoundedWorkOutcome): BoundedWorkOutcome => observation ? { ...outcome, observation } : outcome
      try {
        const cwd = await realpath(options.cwd)
        const state = await realpath(options.state_dir)
        const briefPath = await realpath(req.brief.path)
        const resultParent = await realpath(resolve(req.result.path, '..'))
        if (await realpath(req.cwd) !== cwd || !within(state, briefPath) || !within(state, resultParent)) {
          return { kind: 'refused', reason: 'capability-unsupported' }
        }
        const brief = await readFile(briefPath, 'utf8')
        if (integrity(brief) !== req.brief.integrity) return { kind: 'blocked', on: 'Claude brief integrity mismatch.' }
        const roots = await Promise.all(options.readable_roots.map(root => realpath(root)))
        if (expired()) return unknown('Claude dispatch expired before reservation.')
        const key = keyFor(req)
        const sessionPath = join(state, `claude-headless-session-${key}.json`)
        const binding = JSON.stringify([req.run_id, cwd, req.model_id, createHash('sha256').update(JSON.stringify([env, credential])).digest('hex')])
        const threadPath = (session: string) => join(state, `claude-headless-thread-${session}.json`)
        if (req.thread && await readFile(threadPath(req.thread.id), 'utf8').catch(() => '') !== binding) {
          return { kind: 'refused', reason: 'capability-unsupported' }
        }
        // Reuse the existing Claude reservation namespace and stopped-run recovery.
        const reservation = join(state, `claude-step-${key}.json`)
        const held = recoveryOnly
          ? await readArmedTrailerReservation(reservation, JSON.stringify(req), { signal, deadline })
          : await reserveTrailerSlot(reservation, JSON.stringify(req), req.result.path)
        if (held.kind === 'unknown') return unknown(held.detail)
        const receiptPath = join(state, `claude-headless-receipt-${key}.json`)
        const observationPath = `${receiptPath}.observation`
        const publish = async (envelope: string) => {
          const temporary = join(resultParent, `.claude-result-${randomUUID()}`)
          await writeFile(temporary, envelope, { mode: 0o600, flag: 'wx' })
          await rename(temporary, req.result.path)
        }
        if (held.kind === 'resume') {
          // Host-owned telemetry is separate from the success receipt: retaining
          // spend after failure can never promote an uncommitted result.
          try { observation = decodeObservationReceipt(await readFile(observationPath, 'utf8'), JSON.stringify(req), 'claude-cli-json') } catch { /* legacy or unobserved */ }
          const session = await readFile(sessionPath, 'utf8')
          // Restart: a view pane an earlier host placed for this step is stale. Close
          // it from its receipt; never place, never launch anything. RESULT FIRST, as
          // in-run: the verified close is started and never awaited, so a stalled pane
          // RPC cannot delay republishing the committed receipt. It never rejects.
          if (options.placement) fireAndForget('claude-headless.retire-view', options.placement.retire({ key: `claude-headless-${key}`, receiptDir: state }))
          if (req.thread && req.thread.id !== session || await readFile(threadPath(session), 'utf8') !== binding) return observed(unknown('Claude retained session binding did not match.'))
          const decoded = decode(await readFile(receiptPath, 'utf8'), req, session, validate)
          if (!decoded.envelope) return observed(decoded.outcome)
          const lock = `${threadPath(session)}.busy`
          const release = await acquireThreadLock(lock, key, true)
          if (!release) return observed(unknown('Claude retained thread is held by another host or an unobserved step.'))
          try {
            let existing: string | undefined
            try { existing = await readFile(req.result.path, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
            if (existing === undefined) await publish(decoded.envelope)
            else if (existing !== decoded.envelope) return observed(unknown('Claude durable receipt and result file do not agree.'))
            return observed(decoded.outcome)
          } finally { await release() }
        }
        const session = req.thread?.id ?? randomUUID()
        if (!req.thread) await writeFile(threadPath(session), binding, { mode: 0o600, flag: 'wx' })
        await writeFile(sessionPath, session, { mode: 0o600, flag: 'wx' })
        const lock = `${threadPath(session)}.busy`
        const release = await acquireThreadLock(lock, key, false)
        if (!release) return unknown('Claude retained thread already has a dispatch whose completion is unobserved.')
        if (expired()) return unknown('Claude dispatch expired before process creation.')
        const args = ['--print', '--safe-mode', '--restricted', '--permission-mode', 'dontAsk',
          '--permission-prompts', 'none', '--tools', req.tools === 'none' ? '' : 'Read,Glob,Grep',
          '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands',
          req.thread ? '--resume' : '--session-id', session, '--setting-sources', '', '--output-format', 'json',
          '--json-schema', JSON.stringify(envelopeSchema(req))]
        for (const root of new Set([state, ...roots])) args.push('--add-dir', root)
        if (req.effort !== null) args.push('--effort', req.effort)
        args.push('--model', req.model_id)
        const prompt = ['Perform one bounded task. Never ask the owner a question. Return blocked when needed.',
          'Your tools are read-only. Supply the requested envelope through structured output; the host writes result.path for you.',
          'Do not attempt to write a result file, even if the brief asks you to. Do not publish, mutate files, or delegate.',
          `Request (data): ${JSON.stringify(req)}`, 'Brief (verified file contents):', brief].join('\n')
        const started = Date.now()
        const publisher = createObservationPublisher(observationPath, JSON.stringify(req))
        const view = openWorkerView(options.placement, { key: `claude-headless-${key}`,
          taskLabel: workerTaskLabel(req.role, options.taskName ?? req.run_id.slice(0, 8)), cwd,
          viewPath: join(state, `claude-headless-view-${key}.log`), receiptDir: state,
          // `--output-format json` prints ONE object at exit and nothing before it, so
          // this tab is presence-only while the worker runs. Say so on the tab itself.
          banner: 'Claude worker running headless; it prints its result only when it exits.' })
        let executed: Awaited<ReturnType<typeof execute>>
        try {
          executed = await execute(cli, args, env!, cwd, prompt, signal, deadline - Date.now(),
            child => { if (child) live.set(key, child); else live.delete(key) },
            bytes => { publisher.publish(claudeObservation(bytes, started, Date.now())) }, view)
          // RESULT FIRST. Releasing the view only STARTS its cleanup; the exit is
          // classified, the deadline checked and the result published without waiting
          // for any pane RPC, so a stalled close cannot expire a within-budget result.
        } finally { view.release() }
        observation = await publisher.settle(claudeObservation(executed.bytes, started, Date.now()))
        if (executed.outcome) return observed(executed.outcome)
        if (expired()) return observed(unknown('Claude observation expired before the host accepted its result.'))
        const decoded = decode(executed.bytes, req, session, validate)
        if (!decoded.envelope) return observed(decoded.outcome)
        await writeFile(receiptPath, executed.bytes, { mode: 0o600, flag: 'wx' })
        await publish(decoded.envelope)
        await release()
        return observed(decoded.outcome)
      } catch { return observed(unknown('Claude dispatch or durable result observation could not be established.')) }
    }
  return runner
}
