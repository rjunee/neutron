import type { BoundedWorkOutcome, BoundedWorkRequest, Placement, ProviderObservation, WorkerRunner } from '@neutronai/runtime/bounded-work.ts'
import { createLogger } from '@neutronai/logger'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import { createHash } from 'node:crypto'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { TridentAttemptLedger, type AttemptIdentity, type AttemptKey, type AttemptReceipt } from './attempt-ledger.ts'

const log = createLogger('trident')

export interface AttemptAttribution {
  phase: string
  task_id: string
  head_sha: string
  review_seat: string | null
  requested_model: string
}

/** Accounting observes dispatch; neither receipts nor a previous outcome authorize reuse. */
export class AttemptAccounting {
  constructor(readonly ledger: TridentAttemptLedger,
    private readonly requestRoot: string,
    private readonly event: (stage: string, meta: string) => Promise<unknown>,
    private readonly now: () => number = Date.now) {}

  /** Stage diagnostics are advisory; an unavailable sink cannot veto work. */
  async recordEvent(stage: string, data: unknown): Promise<void> {
    try { await this.event(stage, JSON.stringify(data)) }
    catch { log.error('attempt-accounting-event-unavailable', { stage }) }
  }

  async interval<T>(stage: string, identity: Record<string, unknown>, operation: () => Promise<T>): Promise<T> {
    const started_at = this.now()
    await this.recordEvent('build-stage-started', { ...identity, stage, started_at })
    try { return await operation() }
    finally { await this.recordEvent('build-stage-ended', { ...identity, stage, started_at, ended_at: this.now() }) }
  }

  private key(request: BoundedWorkRequest): AttemptKey {
    // The bounded-work contract makes step_id the actual-call idempotency key.
    // A provider retry is a new step, not a second receipt for this step.
    return { run_id: request.run_id, step_id: request.step_id, attempt_id: 'dispatch' }
  }

  private requestPath(key: AttemptKey): string {
    return join(this.requestRoot, `attempt-request-${createHash('sha256').update(JSON.stringify([key.run_id, key.step_id, key.attempt_id])).digest('hex')}.json`)
  }

  /** Reconcile spend independently of the pending-result state machine. */
  async reconcile(runId: string, runnerFor: (provider: string) => WorkerRunner | undefined): Promise<void> {
    for (const row of this.ledger.list(runId)) {
      const runner = runnerFor(row.provider)
      if (!runner?.observe || runner.provider !== row.provider) continue
      try {
        const path = this.requestPath(row)
        if (!(await lstat(path)).isFile()) throw Error('Request journal is not a regular file')
        const saved = JSON.parse(await readFile(path, 'utf8'))
        const request = saved.request as BoundedWorkRequest
        if (request.run_id !== row.run_id || request.step_id !== row.step_id || request.role !== row.role
          || request.model_id !== row.resolved_model || saved.provider !== row.provider || saved.placement !== row.placement
          || ['phase', 'task_id', 'head_sha', 'review_seat', 'requested_model'].some(field => saved.attribution[field] !== row[field as keyof typeof row])) {
          throw Error('Request journal does not match ledger ownership')
        }
        const observation = await runner.observe(request)
        if (observation) await this.observe(row, observation)
      } catch { await this.recordEvent('attempt-reconciliation-unavailable', { run_id: row.run_id, step_id: row.step_id }) }
    }
  }

  async prepare(request: BoundedWorkRequest, provider: string, placement: Placement,
    attribution: AttemptAttribution, prepare: () => Promise<void>): Promise<void> {
    const key = this.key(request)
    const existing = this.ledger.get(key)
    const journal = JSON.stringify({ request, provider, placement, attribution })
    const path = this.requestPath(key)
    try { await writeFile(path, journal, { flag: 'wx', mode: 0o600 }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await lstat(path)).isFile()
        || await readFile(path, 'utf8') !== journal) throw Error('Bounded attempt request journal conflict')
    }
    const identity: AttemptIdentity = { ...key, ...attribution, provider, placement,
      role: request.role, resolved_model: request.model_id, queued_at: existing?.queued_at ?? this.now() }
    await this.ledger.admit(identity)
    try {
      await prepare()
      if (this.ledger.get(key)!.prepared_at === null) await this.ledger.lifecycle(key, { prepared_at: this.now() })
    } catch (error) {
      if (this.ledger.get(key)!.ended_at === null) await this.ledger.lifecycle(key, { ended_at: this.now(), outcome: 'failed' })
      throw error
    }
  }

  async run(runner: WorkerRunner, request: BoundedWorkRequest, placement: Placement, signal: AbortSignal): Promise<BoundedWorkOutcome> {
    const key = this.key(request)
    const admitted = this.ledger.get(key)
    if (!admitted || admitted.provider !== runner.provider || admitted.role !== request.role
      || admitted.resolved_model !== request.model_id || admitted.placement !== placement || admitted.prepared_at === null) {
      throw new Error('Bounded attempt lacks matching host preparation')
    }
    if (admitted.started_at === null && admitted.ended_at === null) await this.ledger.lifecycle(key, { started_at: this.now() })
    let interruption: Promise<void> | undefined
    const interrupted = () => {
      interruption ??= this.ledger.get(key)!.ended_at === null
        ? this.ledger.lifecycle(key, { ended_at: this.now(), outcome: 'interrupted' }) : Promise.resolve()
      // The awaiting path below observes write failure. An aborted provider may
      // remain pending, so attach a handler now to avoid an unhandled rejection.
      fireAndForget('attempt-accounting.interruption', interruption)
    }
    signal.addEventListener('abort', interrupted, { once: true })
    if (signal.aborted) interrupted()
    let outcome: BoundedWorkOutcome
    try { outcome = await runner.run(request, placement, signal) }
    catch (error) {
      await interruption
      if (runner.observe) {
        try {
          const observed = await runner.observe(request)
          if (observed) await this.observe(key, observed)
        } catch { await this.recordEvent('attempt-reconciliation-unavailable', key) }
      }
      if (this.ledger.get(key)!.ended_at === null) await this.ledger.lifecycle(key, {
        ended_at: this.now(), outcome: signal.aborted ? 'interrupted' : 'failed',
      })
      throw error
    }
    finally { signal.removeEventListener('abort', interrupted) }
    await interruption
    await this.recordOutcome(key, outcome, signal)
    return outcome
  }

  /** A pending step can only inspect its already-started, exactly journaled call. */
  async recover(runner: WorkerRunner, request: BoundedWorkRequest, placement: Placement, signal: AbortSignal): Promise<BoundedWorkOutcome> {
    const key = this.key(request)
    const unavailable = (): BoundedWorkOutcome => ({ kind: 'unknown', detail: 'Bounded attempt recovery lacks matching started request evidence' })
    const admitted = this.ledger.get(key)
    if (!runner.recover || !admitted || admitted.provider !== runner.provider || admitted.role !== request.role
      || admitted.resolved_model !== request.model_id || admitted.placement !== placement
      || admitted.prepared_at === null || admitted.started_at === null) return unavailable()
    try {
      const path = this.requestPath(key)
      if (!(await lstat(path)).isFile()) return unavailable()
      const saved = JSON.parse(await readFile(path, 'utf8'))
      if (!isDeepStrictEqual(saved.request, request) || saved.provider !== runner.provider || saved.placement !== placement
        || ['phase', 'task_id', 'head_sha', 'review_seat', 'requested_model'].some(field => saved.attribution?.[field] !== admitted[field as keyof typeof admitted])) return unavailable()
    } catch { return unavailable() }
    const outcome = await runner.recover(request, placement, signal)
    // The adapter validates result authority. Uncertainty does not end an attempt.
    if (outcome.kind === 'completed') await this.recordOutcome(key, outcome, signal)
    else if (outcome.observation) await this.observe(key, outcome.observation)
    return outcome
  }

  private async recordOutcome(key: AttemptKey, outcome: BoundedWorkOutcome, signal: AbortSignal): Promise<void> {
    const observation = outcome.observation
    const completed = outcome.kind === 'completed' ? outcome : null
    // A validated completion may attest its model while the provider omitted
    // counts. The reported model is still attribution; its counters stay unknown.
    if (observation || completed?.usage || completed?.model_reported) {
      const receipt: AttemptReceipt = {
        receipt_id: JSON.stringify([key.run_id, key.step_id, key.attempt_id]),
        source: observation?.source ?? 'bounded-worker-metadata',
        observed_at: observation?.observed_at_ms ?? this.now(),
        model_reported: observation?.model_reported ?? completed?.model_reported ?? null,
        input_tokens: observation ? observation.usage.input_tokens : completed!.usage?.input_tokens ?? null,
        output_tokens: observation ? observation.usage.output_tokens : completed!.usage?.output_tokens ?? null,
        cache_read_tokens: observation ? observation.usage.cache_read_input_tokens : completed!.usage?.cache_read_input_tokens ?? null,
        cache_creation_tokens: observation?.usage.cache_creation_input_tokens ?? null,
        cost_usd: observation?.usage.cost_usd ?? null,
      }
      await this.storeReceipt(key, receipt)
      if (observation) await this.recordEvent('attempt-provider-observed', { ...key,
        started_at: observation.started_at_ms, ended_at: observation.finished_at_ms,
        observed_at: observation.observed_at_ms, source: observation.source })
    }
    if (this.ledger.get(key)!.ended_at === null) await this.ledger.lifecycle(key, {
      ended_at: this.now(), outcome: signal.aborted && outcome.kind !== 'completed' ? 'interrupted' : outcome.kind,
    })
  }

  private async observe(key: AttemptKey, observation: ProviderObservation): Promise<void> {
    await this.storeReceipt(key, {
      receipt_id: JSON.stringify([key.run_id, key.step_id, key.attempt_id]), source: observation.source,
      observed_at: observation.observed_at_ms, model_reported: observation.model_reported,
      input_tokens: observation.usage.input_tokens, output_tokens: observation.usage.output_tokens,
      cache_read_tokens: observation.usage.cache_read_input_tokens,
      cache_creation_tokens: observation.usage.cache_creation_input_tokens, cost_usd: observation.usage.cost_usd,
    })
  }

  private async storeReceipt(key: AttemptKey, receipt: AttemptReceipt): Promise<void> {
    const previous = this.ledger.receipt(key)
    // A recovery may expose only part of the original absolute observation.
    // Preserve known fields; never add the same call's counters a second time.
    if (previous) {
      for (const field of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'cost_usd', 'model_reported'] as const) {
        if (receipt[field] === null) Object.assign(receipt, { [field]: previous[field] })
      }
    }
    try {
      await this.ledger.observe(key, receipt)
    } catch {
      // Invalid telemetry cannot establish or veto the worker's result. Retain
      // the previous receipt and an explicit accounting fault for inspection.
      await this.recordEvent('attempt-accounting-refused', key)
    }
  }
}
