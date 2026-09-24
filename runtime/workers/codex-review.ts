import { createHash } from 'node:crypto'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BoundedWorkOutcome, BoundedWorkRequest, ProviderObservation, Usage } from '../bounded-work.ts'
import { CODEX_CLI_AUTH_ENV_VARS } from '../adapters/codex-cli/auth.ts'
import { readArmedTrailerReservation, reserveTrailerSlot } from './trailer-slot.ts'
import { codexObservation } from './provider-observation.ts'
import { createObservationPublisher, decodeObservationReceipt, recoverProviderObservation } from './provider-observation-recovery.ts'
import { openWorkerView, workerTaskLabel, type WorkerPlacement } from './worker-placement.ts'

export interface CodexReviewContract {
  jsonSchema: unknown
  validate(value: unknown): boolean
}

const unknown = (detail: string): BoundedWorkOutcome => ({ kind: 'unknown', detail })
const refused = (): BoundedWorkOutcome => ({ kind: 'refused', reason: 'capability-unsupported' })
const PROBE_SENTINEL = 'neutron_codex_contract_probe_sentinel'

function subscriptionReady(env: NodeJS.ProcessEnv): boolean {
  if (!env.CODEX_HOME) return false
  try {
    const auth = JSON.parse(readFileSync(join(env.CODEX_HOME, 'auth.json'), 'utf8'))
    return auth !== null && typeof auth === 'object' && !auth.OPENAI_API_KEY && auth.auth_mode !== 'apikey'
      && typeof auth.tokens?.access_token === 'string' && auth.tokens.access_token.trim() !== ''
      && typeof auth.tokens?.refresh_token === 'string' && auth.tokens.refresh_token.trim() !== ''
  } catch { return false }
}

export function codexWorkerEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) =>
    !key.startsWith('GH_') && !key.startsWith('GITHUB_') && !CODEX_CLI_AUTH_ENV_VARS.includes(key)))
}

/** Strict structured outputs require every declared property to be required.
 * Preserve optional-field omission as object alternatives, not invented nulls. */
function strictSchema(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const schema = value as Record<string, any>
  if (schema.properties) {
    const required = new Set<string>(schema.required ?? [])
    const optional = Object.keys(schema.properties).filter(key => !required.has(key))
    const variants = Array.from({ length: 2 ** optional.length }, (_, mask) => {
      const keys = Object.keys(schema.properties).filter(key => required.has(key) || (mask & (1 << optional.indexOf(key))))
      return { ...schema, required: keys, properties: Object.fromEntries(keys.map(key => [key, strictSchema(schema.properties[key])])) }
    })
    return variants.length === 1 ? variants[0] : { anyOf: variants }
  }
  return schema.items ? { ...schema, items: strictSchema(schema.items) } : schema
}

/** The CLI writes an untrusted candidate. Only a successful, observed turn may
 * promote it to a durable receipt; a partial/nonzero process cannot approve on resume. */
export function createCodexReviewTransport(options: {
  env: NodeJS.ProcessEnv
  contracts: ReadonlyMap<string, CodexReviewContract>
  briefIntegrity: ((text: string) => string) | undefined
  live: Map<string, { readonly exitCode: number | null }>
  /** Task-view tab for the seat. Never read for the verdict, usage or exit. */
  placement?: WorkerPlacement
  taskName?: string
}) {
  const env = codexWorkerEnv(options.env)
  const connected = subscriptionReady(env)
  const cliReady = connected && options.contracts.size > 0 && [false, true].every(resume => {
    try {
      const probe = Bun.spawnSync(['codex', 'exec', ...(resume ? ['resume'] : []), '--help'], { env, timeout: 5_000 })
      return probe.exitCode === 0 && ['--output-schema', '--json', '--output-last-message', '--ignore-rules']
        .every(flag => probe.stdout.toString().includes(flag))
    } catch { return false }
  }) && (() => {
    try {
      // --help bypasses config validation. The deliberately unknown LAST key
      // makes this invocation stop before any model call, after checking every
      // real override. Codex reports only the first unknown key.
      const probe = Bun.spawnSync(['codex', 'exec', '--strict-config', '--ignore-user-config',
        '-c', 'sandbox_mode="read-only"', '-c', `${PROBE_SENTINEL}=true`],
      { env, stdin: 'ignore', timeout: 5_000 })
      return probe.exitCode !== 0 && new RegExp(`unknown configuration field [\x60'"]?${PROBE_SENTINEL}[\x60'"]? in -c/--config override`).test(probe.stderr.toString())
    } catch { return false }
  })()

  const execute = async (recoveryOnly: boolean, req: BoundedWorkRequest, signal: AbortSignal): Promise<BoundedWorkOutcome> => {
    const contract = options.contracts.get(req.result.schema)
    if (!contract || !options.briefIntegrity || req.writable || req.tools !== 'read-only' || req.needs_approval_decision !== false
      || !Number.isSafeInteger(req.budget.wall_ms) || req.budget.wall_ms <= 0
      || !req.model_id || req.thread?.id === '') return refused()
    if (signal.aborted) return { kind: 'failed', class: 'killed', detail: 'Codex review was cancelled before dispatch' }
    // No per-call credential materialisation, ambient key billing, or fallback account.
    if (!subscriptionReady(env)) return { kind: 'refused', reason: 'provider-not-connected' }
    if (!cliReady) return { kind: 'refused', reason: 'cli-contract' }

    const key = createHash('sha256').update(JSON.stringify([req.run_id, req.step_id])).digest('hex')
    const reservation = join(dirname(req.result.path), `codex-headless-step-${key}.json`)
    const identity = JSON.stringify([req, env.CODEX_HOME])
    const receiptPath = `${reservation}.receipt`
    const observationPath = `${reservation}.observation`
    let observation: ProviderObservation | undefined
    const observed = (outcome: BoundedWorkOutcome): BoundedWorkOutcome => observation ? { ...outcome, observation } : outcome
    const validate = (bytes: string): BoundedWorkOutcome => {
      try {
        const value = JSON.parse(bytes)
        if (!value || value.run_id !== req.run_id || value.step_id !== req.step_id || value.schema !== req.result.schema) {
          return unknown('Codex review trailer identity or schema mismatched')
        }
        const fields = value.kind === 'completed' ? ['run_id', 'step_id', 'schema', 'kind', 'result'] : ['run_id', 'step_id', 'schema', 'kind', 'on']
        if (Object.keys(value).length !== fields.length || !fields.every(field => Object.hasOwn(value, field))) return unknown('Codex review trailer envelope malformed')
        if (value.kind === 'blocked' && typeof value.on === 'string' && value.on.trim()) return { kind: 'blocked', on: value.on }
        if (value.kind !== 'completed' || !contract.validate(value.result)) return unknown('Codex review payload failed host validation')
        return { kind: 'completed', result: value.result, usage: null, model_reported: null, thread_id: null }
      } catch { return unknown('Codex review trailer is unreadable') }
    }
    const held = recoveryOnly
      ? await readArmedTrailerReservation(reservation, identity, { signal, deadline: Date.now() + req.budget.wall_ms })
      : await reserveTrailerSlot(reservation, identity, req.result.path)
    if (held.kind === 'unknown') return unknown(held.detail)
    if (held.kind === 'resume') {
      // Restart: close a stale view pane from its receipt. Never places or spawns.
      await options.placement?.retire({ key: `codex-review-${key}`, receiptDir: dirname(req.result.path) })
      try { observation = decodeObservationReceipt(await readFile(observationPath, 'utf8'), identity, 'codex-cli-jsonl') } catch { /* legacy or unobserved */ }
      try {
        const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
        if (receipt.identity !== identity || typeof receipt.thread_id !== 'string' || !receipt.thread_id
          || (req.thread && receipt.thread_id !== req.thread.id)) return observed(unknown('Codex review receipt identity mismatched'))
        const outcome = validate(receipt.envelope)
        return observed(outcome.kind === 'completed' ? { ...outcome, thread_id: receipt.thread_id, usage: receipt.usage } : outcome)
      } catch { return observed(unknown('Codex review has no committed receipt; dispatch will not be replayed')) }
    }

    const schemaPath = `${reservation}.schema`
    const candidate = `${reservation}.candidate`
    const envelopeShape = (kind: string, fields: Record<string, unknown>) => ({ type: 'object', additionalProperties: false,
      required: ['run_id', 'step_id', 'schema', 'kind', ...Object.keys(fields)], properties: {
        run_id: { type: 'string', enum: [req.run_id] }, step_id: { type: 'string', enum: [req.step_id] },
        schema: { type: 'string', enum: [req.result.schema] }, kind: { type: 'string', enum: [kind] }, ...fields } })
    // Structured outputs disallow a root union. The transport wrapper contains
    // the exact ordinary trailer, including its distinct blocked alternative.
    await writeFile(schemaPath, JSON.stringify({ type: 'object', additionalProperties: false, required: ['envelope'],
      properties: { envelope: { anyOf: [
        envelopeShape('completed', { result: strictSchema(contract.jsonSchema) }),
        envelopeShape('blocked', { on: { type: 'string' } }),
      ] } } }), { flag: 'wx', mode: 0o600 })
    let brief: string
    try { brief = await readFile(req.brief.path, 'utf8') }
    catch { return unknown('Codex review brief could not be read') }
    if (options.briefIntegrity(brief) !== req.brief.integrity) return unknown('Codex review brief integrity mismatched')
    const args = ['exec', ...(req.thread ? ['resume', req.thread.id] : []), '--json', '--ignore-user-config', '--ignore-rules',
      '-m', req.model_id, '-c', 'sandbox_mode="read-only"',
      '--output-schema', schemaPath, '-o', candidate, '-']
    let thread: string | null = null
    let threadConflict = false
    let usage: Usage | null = null
    let providerUsage: unknown
    let completed = false
    let invalid = false
    let pending = ''
    let timedOut = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const prompt = `Request (data): ${JSON.stringify(req)}\n\n${brief}\n\nReturn {"envelope": <the result envelope>} as your final response. The host writes it; do not write files. If unable to review, return blocked with on.\n`
    let child: Bun.Subprocess<Blob, 'pipe', 'ignore'>
    const started = Date.now()
    const publisher = createObservationPublisher(observationPath, identity)
    const view = openWorkerView(options.placement, { key: `codex-review-${key}`,
      taskLabel: workerTaskLabel(req.role, options.taskName ?? req.run_id.slice(0, 8)), cwd: req.cwd,
      viewPath: `${reservation}.view.log`, receiptDir: dirname(req.result.path) })
    try {
      child = Bun.spawn(['codex', ...args], { cwd: req.cwd, env, detached: true, stdin: new Blob([prompt]), stdout: 'pipe', stderr: 'ignore' })
    } catch { view.release(); return { kind: 'failed', class: 'infra', detail: 'Codex review could not start' } }
    options.live.set(req.step_id, child)
    // The native seat exists; only now may a view of it be placed. Not awaited.
    view.started()
    const kill = (signal: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, signal) } catch { /* Already exited. */ }
    }
    const stop = () => { kill('SIGTERM'); killTimer ??= setTimeout(() => kill('SIGKILL'), 250) }
    const timer = setTimeout(() => { timedOut = true; stop() }, req.budget.wall_ms)
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
    const readEvents = async () => {
      const decoder = new TextDecoder()
      for await (const chunk of child.stdout) {
        // The same bytes the event parser reads, copied to the view. Display only.
        view.tee(chunk)
        pending += decoder.decode(chunk, { stream: true })
        if (pending.length > 1024 * 1024) { invalid = true; pending = ''; stop(); return }
        let end: number
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1)
          try {
            const event = JSON.parse(line)
            if (event.type === 'thread.started') {
              if (thread !== null || typeof event.thread_id !== 'string' || !event.thread_id || (req.thread && event.thread_id !== req.thread.id)) { invalid = true; threadConflict = true }
              else thread = event.thread_id
            }
            if (event.type === 'turn.failed' || event.type === 'error') invalid = true
            // Only transport event metadata counts. Candidate JSON, assistant
            // text and nested worker-authored envelopes are never usage sources.
            if ((event.type === 'turn.completed' || event.type === 'turn.failed') && event.usage && thread !== null && !threadConflict) {
              providerUsage = event.usage
              publisher.publish(codexObservation(providerUsage, thread, started, Date.now()))
            }
            if (event.type === 'turn.completed') {
              if (completed) invalid = true
              completed = true
              const u = event.usage
              if (u && Number.isSafeInteger(u.input_tokens) && u.input_tokens >= 0 && Number.isSafeInteger(u.output_tokens) && u.output_tokens >= 0) {
                usage = { input_tokens: u.input_tokens, output_tokens: u.output_tokens,
                  ...(Number.isSafeInteger(u.cached_input_tokens) && u.cached_input_tokens >= 0 ? { cache_read_input_tokens: u.cached_input_tokens } : {}) }
              }
            }
          } catch { invalid = true }
        }
      }
    }
    const [code] = await Promise.all([child.exited.then(code => { kill('SIGKILL'); return code }),
      readEvents().catch(() => { invalid = true; stop() })])
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
    // Always close the process group, including children that survived the CLI.
    kill('SIGKILL'); clearTimeout(killTimer)
    options.live.delete(req.step_id)
    // RESULT FIRST: the view's cleanup starts here and is never awaited, so no pane RPC
    // sits between the seat's exit and the verdict/receipt commit.
    view.release()
    // A truncated JSONL transport can still end with one complete JSON object.
    // Observe its usage without treating an unterminated event as completion.
    try {
      const tail = JSON.parse(pending)
      if ((tail.type === 'turn.completed' || tail.type === 'turn.failed') && tail.usage && thread !== null && !threadConflict) providerUsage = tail.usage
    } catch { /* Incomplete JSON has no trustworthy counters. */ }
    observation = await publisher.settle(codexObservation(providerUsage, thread, started, Date.now()))
    if (signal.aborted) return observed({ kind: 'failed', class: 'killed', detail: 'Codex review was cancelled' })
    if (timedOut) return observed({ kind: 'failed', class: 'timeout', detail: 'Codex review exceeded its wall-clock budget' })
    if (code !== 0) return observed({ kind: 'failed', class: 'infra', detail: `Codex review exited ${code ?? 'without status'}` })
    if (invalid || !completed || !thread || pending.trim()) return observed(unknown('Codex review lacks a valid completed turn and thread observation'))
    try {
      const output = JSON.parse(await readFile(candidate, 'utf8'))
      if (!output || Object.keys(output).length !== 1 || !Object.hasOwn(output, 'envelope')) return observed(unknown('Codex review transport envelope malformed'))
      const envelope = JSON.stringify(output.envelope)
      const outcome = validate(envelope)
      if (outcome.kind !== 'completed' && outcome.kind !== 'blocked') return observed(outcome)
      await writeFile(`${receiptPath}.tmp`, JSON.stringify({ identity, envelope, thread_id: thread, usage }), { flag: 'wx', mode: 0o600 })
      await rename(`${receiptPath}.tmp`, receiptPath)
      await writeFile(req.result.path, envelope, { flag: 'wx', mode: 0o600 })
      return observed(outcome.kind === 'completed' ? { ...outcome, thread_id: thread, usage } : outcome)
    } catch { return observed(unknown('Codex review result could not be committed')) }
              }
  const observe = async (req: BoundedWorkRequest) => {
    const key = createHash('sha256').update(JSON.stringify([req.run_id, req.step_id])).digest('hex')
    const reservation = join(dirname(req.result.path), `codex-headless-step-${key}.json`)
    return recoverProviderObservation(reservation, JSON.stringify([req, env.CODEX_HOME]),
      `${reservation}.observation`, 'codex-cli-jsonl')
  }
  const run = (req: BoundedWorkRequest, signal: AbortSignal) => execute(false, req, signal)
  const recover = (req: BoundedWorkRequest, signal: AbortSignal) => execute(true, req, signal)
  return Object.assign(run, { ready: cliReady, connected, observe, recover })
}
