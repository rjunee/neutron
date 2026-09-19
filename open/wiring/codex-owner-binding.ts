import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { readCodexOwnerBinding, type CodexOwnerBootstrap, type CodexOwnerAttachment, type CodexOwnerBindingFacts } from '@neutronai/runtime/adapters/codex-cli/persistent/project-control-bootstrap.ts'
import { openDurableCodexOwner, type OwnerLaunch } from './codex-durable-owner.ts'
import { createCodexConversationalSubstrate, type CodexConversationHost } from '@neutronai/runtime/adapters/codex-cli/persistent/conversational-substrate.ts'
import { createCodexActingTurn, type CodexActingSession } from '@neutronai/runtime/workers/codex-acting-turn.ts'
import { decodeProjectTrailer, type ProjectActingTurn } from '@neutronai/runtime/workers/project-runners.ts'
import type { AgentSpec } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { WorkerRunner } from '@neutronai/runtime/bounded-work.ts'
import { CODEX_CLI_AUTH_ENV_VARS } from '@neutronai/runtime/adapters/codex-cli/auth.ts'
import { CodexOwnerControls, type NativeOwnerQuestion } from './codex-owner-controls.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import type { ReviewPermissionLease } from '@neutronai/runtime/adapters/codex-cli/persistent/project-review-permissions.ts'
import { ReviewPermissionBusy } from '@neutronai/runtime/adapters/codex-cli/persistent/project-control-broker.ts'
import { CodexRolloutObserver } from '@neutronai/runtime/adapters/codex-cli/persistent/rollout-observer.ts'

export interface CodexOwnerProject {
  cwd: string
  codexHome: string
  env: NodeJS.ProcessEnv
}

async function refreshOwner(owner: CodexOwnerBootstrap): Promise<void> {
  const remote = owner as Partial<CodexOwnerAttachment>
  if (remote.refreshState) await remote.refreshState()
}

/** One host-owned authority per full project id, shared by chat and builds.
 * Failed opening and uncertain delivery remain fenced for this host's lifetime.
 * Production attaches only to an independently hosted durable native owner.
 */
export class CodexOwnerBindings {
  private readonly owners = new Map<string, Promise<{ owner: CodexOwnerBootstrap; project: CodexOwnerProject }>>()
  private readonly busy = new Set<string>()
  private readonly refused = new Set<string>()
  private readonly decodingBuilds = new Set<string>()
  private readonly reviewReady = new Set<string>()
  private readonly reviews = new Map<string, ReviewPermissionLease>()
  private readonly reviewQueue = new Map<string, Promise<void>>()
  private readonly cleanReviewRefusals = new Set<string>()
  private readonly buildObservations = new Map<string, { attempted: boolean; terminal: boolean; closed: boolean }>()
  private readonly nativeDispatches = new Map<string, number>()
  private readonly conversationHosts = new Map<string, CodexConversationHost>()
  private readonly builds = new Map<string, {
    session: NonNullable<CodexActingSession['session']>
    input?: Parameters<ProjectActingTurn>[0]
  }>()
  private closed = false
  private readonly ownerProjects = new WeakMap<CodexOwnerBootstrap, string>()
  private readonly ownerFacts = new WeakMap<CodexOwnerBootstrap, CodexOwnerBindingFacts>()
  private readonly resolvedOwners = new Map<string, CodexOwnerBootstrap>()
  private readonly questionSinks = new Map<string, (question: NativeOwnerQuestion) => void>()
  onOwnerQuestion?: (projectId: string, question: NativeOwnerQuestion) => Promise<void>
  readonly controls = new CodexOwnerControls({
    lookup: async projectId => {
      const entry = await this.owners.get(projectId)
      if (entry && JSON.parse(readFileSync(join(entry.project.codexHome, 'project-owner.json'), 'utf8')) !== projectId) {
        throw new Error('Codex owner credential home belongs to another project')
      }
      return entry?.owner
    },
    facts: owner => {
      const facts = this.readBinding(owner.binding)
      const projectId = this.ownerProjects.get(owner)
      if (!projectId || JSON.parse(readFileSync(join(facts.codexHome, 'project-owner.json'), 'utf8')) !== projectId) {
        throw new Error('Codex owner credential home identity changed')
      }
      return facts
    },
    busy: projectId => this.busy.has(projectId) || !!this.builds.get(projectId)?.input || this.decodingBuilds.has(projectId),
    refused: projectId => this.closed || this.refused.has(projectId),
    fence: projectId => { this.fence(projectId) },
  })
  readonly host: CodexConversationHost = {
    acquireTurn: async (options, signal) => {
      const observation = this.buildObservations.get(options.projectId)
      const conversationHost = this.conversationHosts.get(options.projectId)
      signal.throwIfAborted()
      const { owner, project } = await this.resolve(options.projectId)
      await refreshOwner(owner)
      signal.throwIfAborted()
      if (realpathSync(options.cwd) !== project.cwd) throw new Error('Codex owner project directory changed')
      if (this.refused.has(options.projectId)) throw new Error('Codex owner requires native reconciliation')
      if (this.busy.has(options.projectId) || this.controls.isSwitching(options.projectId) || owner.broker.state().phase !== 'idle') throw new Error('Codex owner is busy or requires recovery')
      const facts = this.readBinding(owner.binding)
      const clientId = `owner-turn-${++this.sequence}`
      const gateway = owner.broker.gateway(clientId)
      this.busy.add(options.projectId)
      let released = false
      let submitted = false
      let deliveryAttempted = false
      let turnId: string | undefined
      const control = this.controls.register(options.projectId, owner, gateway, question => {
        this.questionSinks.get(options.projectId)?.(question)
        if (this.onOwnerQuestion) fireAndForget('codex-owner.question', Promise.resolve().then(() => this.onOwnerQuestion!(options.projectId, question)),
          () => { this.fence(options.projectId) })
      }, clientId)
      const current = (): boolean => {
        try {
          if (JSON.parse(readFileSync(join(project.codexHome, 'project-owner.json'), 'utf8')) !== options.projectId) return false
          const now = this.readBinding(owner.binding)
          return !released && now.bindingRevision === facts.bindingRevision
            && owner.broker.state().phase !== 'closed' && !this.refused.has(options.projectId)
        } catch { return false }
      }
      return {
        identity: { projectId: options.projectId, ...facts },
        isLive: current,
        submitLine: async prompt => {
          signal.throwIfAborted()
          if (!current() || submitted) throw new Error('Codex owner lease is unavailable or already submitted')
          submitted = true
          const epoch = owner.broker.state().epoch
          const model = await this.controls.turnModel(owner, gateway)
          signal.throwIfAborted()
          if (!current() || owner.broker.state().epoch !== epoch) throw new Error('Codex native model selection changed before dispatch')
          if (observation?.closed) throw new Error('Codex build preflight is no longer current')
          const priorAttempt = observation?.attempted ?? false
          this.beginWork(owner)
          deliveryAttempted = true
          if (observation) observation.attempted = true
          const bounded = this.builds.get(options.projectId)?.input
          const restricted = bounded && (bounded.request.role === 'review' || bounded.request.role === 'synthesis')
          let response: { turn?: { id?: unknown } }
          if (restricted) {
            const prepare = owner.broker.reviewPermissions
            if (!prepare || !this.reviewReady.has(options.projectId)) throw new Error('Native restricted review capability unavailable')
            let lease: ReviewPermissionLease
            try { lease = await prepare({ stageDir: dirname(bounded.request.result.path), network: bounded.request.network }, epoch) }
            catch (error) {
              if (error instanceof ReviewPermissionBusy) {
                deliveryAttempted = false
                if (observation) observation.attempted = priorAttempt
                this.finishWork(options.projectId, owner)
                this.cleanReviewRefusals.add(options.projectId)
              }
              throw error
            }
            this.reviews.set(options.projectId, lease)
            signal.throwIfAborted()
            if (observation?.closed) throw new Error('Restricted review admission expired')
            this.nativeDispatches.set(options.projectId, (this.nativeDispatches.get(options.projectId) ?? 0) + 1)
            const receipt = await lease.start([{ type: 'text', text: prompt }])
            response = { turn: { id: receipt.turnId } }
          } else {
            this.nativeDispatches.set(options.projectId, (this.nativeDispatches.get(options.projectId) ?? 0) + 1)
            response = await gateway.request('turn/start', {
              threadId: facts.threadId, model, input: [{ type: 'text', text: prompt }],
              cwd: project.cwd, approvalPolicy: 'on-request',
              sandboxPolicy: { type: 'workspaceWrite', writableRoots: [project.cwd], networkAccess: true },
            }, epoch) as { turn?: { id?: unknown } }
          }
          if (typeof response.turn?.id !== 'string' || !response.turn.id) throw new Error('Codex native turn receipt missing')
          turnId = response.turn.id
          control.receipt(turnId)
          return { threadId: facts.threadId, turnId, rolloutPath: facts.rolloutPath, bindingRevision: facts.bindingRevision }
        },
        interrupt: async id => {
          if (released || id !== turnId) throw new Error('Codex interruption requires this lease native turn')
          // A completed turn cannot be interrupted; never target its successor.
          if (owner.broker.state().activeTurnId === id) await gateway.request('turn/interrupt',
            { threadId: facts.threadId, turnId: id }, owner.broker.state().epoch)
        },
        release: async outcome => {
          if (released) return
          released = true
          try {
            await refreshOwner(owner)
            // Rollout task_complete can precede the broker's native turn/completed
            // event. Reconcile only this exact finished turn, without a write or
            // replay; idle from a single prematurely sampled RPC is not guaranteed.
            const deadline = Date.now() + 2_000
            while (outcome === 'completed' && turnId && owner.broker.state().phase === 'turn'
              && owner.broker.state().activeTurnId === turnId && Date.now() < deadline) {
              await Bun.sleep(25)
              await refreshOwner(owner)
            }
            if (deliveryAttempted && (outcome !== 'completed' || !this.reviews.has(options.projectId) && owner.broker.state().phase !== 'idle')) this.fence(options.projectId)
          } catch (error) { if (deliveryAttempted) this.fence(options.projectId); throw error }
          finally { control.close(); gateway.close(); this.busy.delete(options.projectId) }
          if (!deliveryAttempted && !this.refused.has(options.projectId) && owner.broker.state().phase === 'idle') {
            this.readBinding(owner.binding)
            // The runtime fences a failed lease's host view. This lease proved
            // zero native delivery, so renew only its view, not the native owner.
            if (this.conversationHosts.get(options.projectId) === conversationHost) this.conversationHosts.delete(options.projectId)
          }
          if (!this.builds.get(options.projectId)?.input && !this.decodingBuilds.has(options.projectId)) this.finishWork(options.projectId, owner)
        },
      }
    },
  }
  private sequence = 0

  constructor(private readonly project: (projectId: string) => Promise<CodexOwnerProject>,
    private readonly bootstrap: (options: OwnerLaunch) => Promise<CodexOwnerBootstrap> = openDurableCodexOwner,
    private readonly readBinding: typeof readCodexOwnerBinding = readCodexOwnerBinding) {}

  private resolve(projectId: string, beforeOpening?: (project: CodexOwnerProject) => void): Promise<{ owner: CodexOwnerBootstrap; project: CodexOwnerProject }> {
    if (this.closed) return Promise.reject(new Error('Codex owner host is closed'))
    if (this.refused.has(projectId)) return Promise.reject(new Error('Codex owner requires native reconciliation'))
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(projectId)) return Promise.reject(new Error('Codex owner requires a full project id'))
    let pending = this.owners.get(projectId)
    if (!pending) {
      let openingAttempted = false
      pending = (async () => {
        const raw = await this.project(projectId)
        const project = { ...raw, cwd: realpathSync(raw.cwd), codexHome: realpathSync(raw.codexHome) }
        if (JSON.parse(readFileSync(join(project.codexHome, 'project-owner.json'), 'utf8')) !== projectId) {
          throw new Error('Codex owner credential home belongs to another project')
        }
        const env: Record<string, string> = {}
        for (const [key, value] of Object.entries(project.env)) {
          if (value !== undefined && !CODEX_CLI_AUTH_ENV_VARS.includes(key)) env[key] = value
        }
        env.CODEX_HOME = project.codexHome
        beforeOpening?.(project)
        openingAttempted = true
        const owner = await this.bootstrap({ projectId, binary: 'codex', socketPath: join(project.codexHome, 'owner.sock'),
          cwd: project.cwd, codexHome: project.codexHome, env })
        try {
          const facts = this.readBinding(owner.binding)
          if (existsSync(join(project.codexHome, '.neutron-owner-work.json'))) throw new Error('Codex interrupted host work requires native reconciliation')
          await refreshOwner(owner)
          // Active work after restart has no reconstructed host consumer. Never
          // replay a prompt or approval, and never create a replacement owner.
          if (owner.broker.state().phase !== 'idle') throw new Error('Codex surviving turn requires native reconciliation')
          if (this.closed || facts.cwd !== project.cwd || facts.codexHome !== project.codexHome) {
            throw new Error('Codex factory returned a foreign or closed project binding')
          }
          this.ownerFacts.set(owner, facts)
        } catch (error) {
          await owner.close()
          throw error
        }
        this.ownerProjects.set(owner, projectId)
        this.resolvedOwners.set(projectId, owner)
        return { owner, project }
      })().catch(error => {
        // A failed credential lookup never acquired native authority. Retry that
        // read after connection, but retain uncertainty once opening was attempted.
        if (!openingAttempted) this.owners.delete(projectId)
        throw error
      })
      this.owners.set(projectId, pending)
    }
    return pending
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.owners.values()].map(async pending => { await (await pending).owner.close() }))
  }

  /** Boot recovery never creates cold owners. Missing journals remain lazy. */
  async reconcile(projectIds: readonly string[]): Promise<void> {
    for (const projectId of projectIds) {
      let project: CodexOwnerProject
      try { project = await this.project(projectId) }
      catch { continue } // No authorized home is not evidence of an uncertain owner.
      if (!existsSync(join(project.codexHome, '.neutron-owner-launch.json'))) continue
      try { await this.resolve(projectId) }
      catch { this.refused.add(projectId) }
    }
  }

  private beginWork(owner: CodexOwnerBootstrap): void {
    if (!('refreshState' in owner)) return
    // Quarantine must remain durable even when a lost helper response closes its
    // live attestation. This is the already-attested home, never a new authority.
    const facts = this.ownerFacts.get(owner) ?? this.readBinding(owner.binding)
    const path = join(facts.codexHome, '.neutron-owner-work.json')
    if (!existsSync(path)) writeFileSync(path, JSON.stringify({ threadId: facts.threadId, bindingRevision: facts.bindingRevision }), { flag: 'wx', mode: 0o600 })
  }

  private finishWork(projectId: string, owner: CodexOwnerBootstrap): void {
    if (!('refreshState' in owner) || this.refused.has(projectId)) return
    const path = join(this.readBinding(owner.binding).codexHome, '.neutron-owner-work.json')
    if (existsSync(path)) unlinkSync(path)
  }

  private fence(projectId: string): void {
    this.refused.add(projectId)
    this.reviews.get(projectId)?.abandon()
    // Capture failures in owner controls as well as active build/chat leases.
    const owner = this.resolvedOwners.get(projectId)
    if (owner) this.beginWork(owner)
  }

  /** The host schema decoder runs after the acting bridge. Its uncertainty
   * must fence this same owner even when native parent/envelope checks passed. */
  guardBuildRunner(projectId: string, worker: WorkerRunner): WorkerRunner {
    const supports: WorkerRunner['supports'] = (role, placement) => (role === 'review' || role === 'synthesis') && !this.reviewReady.has(projectId)
      ? { ok: false, reason: 'capability-unsupported', detail: 'Codex owner lacks attested read-only child execution with isolated result output' }
      : worker.supports(role, placement)
    const guarded: WorkerRunner = { ...worker, supports, run: async (request, placement, signal) => {
      const deadline = Date.now() + request.budget.wall_ms
      const supported = supports(request.role, placement)
      if (!supported.ok) return { kind: 'refused', reason: supported.reason }
      if (this.closed || this.refused.has(projectId)) return { kind: 'unknown', detail: 'Codex owner requires native reconciliation' }
      // Positive no-dispatch proof: no runner/acting-turn call has occurred.
      // A cancelled admission must not create a durable owner uncertainty marker.
      if (signal.aborted || request.budget.wall_ms <= 0) return { kind: 'unknown', detail: 'Cancelled or out of time before owner dispatch.' }
      if (this.decodingBuilds.has(projectId)) return { kind: 'unknown', detail: 'Codex owner build result is still pending' }
      if (this.busy.has(projectId)) return { kind: 'unknown', detail: 'Codex owner has an active host turn' }
      this.decodingBuilds.add(projectId)
      const observation = { attempted: false, terminal: false, closed: false }
      this.buildObservations.set(projectId, observation)
      try {
        // A canonical ARMED reservation can resume without an acting turn. Check
        // host authority here too; a trailer never reconciles uncertain owner work.
        let project: CodexOwnerProject
        const admissionTimer = new AbortController()
        try {
          project = await Promise.race([
            this.project(projectId),
            delay(request.budget.wall_ms, undefined, { signal: AbortSignal.any([signal, admissionTimer.signal]) })
              .then(() => { throw new Error('Owner admission expired') }),
          ])
        } catch { return { kind: 'unknown', detail: 'Owner authority was unavailable before dispatch' } }
        finally { admissionTimer.abort() }
        if (this.closed || this.refused.has(projectId)) return { kind: 'unknown', detail: 'Codex owner requires native reconciliation' }
        if (this.busy.has(projectId)) return { kind: 'unknown', detail: 'Codex owner has an active host turn' }
        if (existsSync(join(project.codexHome, '.neutron-owner-work.json'))) {
          this.refused.add(projectId)
          return { kind: 'unknown', detail: 'Codex interrupted host work requires native reconciliation' }
        }
        const owner = this.resolvedOwners.get(projectId)
        if (!owner && existsSync(join(project.codexHome, '.neutron-owner-launch.json'))) {
          return { kind: 'unknown', detail: 'Existing Codex owner must be reattached before build admission' }
        }
        if (owner) {
          this.readBinding(owner.binding)
          await refreshOwner(owner)
          if (this.busy.has(projectId)) return { kind: 'unknown', detail: 'Codex owner has an active host turn' }
          if (owner.broker.state().phase === 'turn' || owner.broker.state().phase === 'mutation') {
            return { kind: 'unknown', detail: 'Codex native owner is busy' }
          }
          if (owner.broker.state().phase !== 'idle') {
            this.fence(projectId)
            return { kind: 'unknown', detail: 'Codex surviving turn requires native reconciliation' }
          }
        }
        if (request.role === 'review' || request.role === 'synthesis') {
          if (!owner) return { kind: 'refused', reason: 'capability-unsupported' }
          const facts = this.readBinding(owner.binding)
          try { lstatSync(facts.rolloutPath) }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'refused', reason: 'capability-unsupported' }
            this.fence(projectId)
            return { kind: 'unknown', detail: 'Restricted review owner rollout is unreadable' }
          }
          try { new CodexRolloutObserver({ projectId, ...facts }, 'restricted review preflight').close() }
          catch {
            this.fence(projectId)
            return { kind: 'unknown', detail: 'Restricted review owner rollout does not attest this conversation' }
          }
        }
        const outcome = await worker.run(request, placement, signal)
        if (outcome.kind === 'unknown' || outcome.kind === 'failed') {
          // Tags alone cannot establish delivery or terminal settlement. No
          // opening/native-delivery attempt is positive no-side-effect evidence. A failed
          // host result after exact parent + child terminal evidence is safe
          // only if no independent uncertainty fence or active lease remains.
          if (!observation.attempted) return outcome
          const owner = this.resolvedOwners.get(projectId)
          if (outcome.kind === 'failed' && observation.terminal && owner && !this.refused.has(projectId)) {
            await refreshOwner(owner)
            if (!this.busy.has(projectId) && !this.builds.get(projectId)?.input && owner.broker.state().phase === 'idle') {
              this.finishWork(projectId, owner)
              return outcome
            }
          }
          this.fence(projectId)
        }
        else {
          const review = this.reviews.get(projectId)
          if (review) {
            if ((outcome.kind !== 'completed' && outcome.kind !== 'blocked') || signal.aborted || this.refused.has(projectId)) {
              this.fence(projectId)
              return { kind: 'unknown', detail: 'Restricted review outcome requires reconciliation' }
            }
            try {
              const remaining = Math.min(60_000, deadline - Date.now())
              if (remaining <= 0) throw new Error('Restricted review tree is unsettled')
              const timer = new AbortController()
              try {
                const settled = await Promise.race([review.waitSettled(remaining), delay(remaining, false,
                  { signal: AbortSignal.any([signal, timer.signal]) })])
                if (!settled) throw new Error('Restricted review tree is unsettled')
              } finally { timer.abort() }
              signal.throwIfAborted()
              await review.restore()
              signal.throwIfAborted()
              await review.release()
              signal.throwIfAborted()
              if (Date.now() >= deadline) throw new Error('Restricted review acknowledgement exceeded the host budget')
              this.reviews.delete(projectId)
            } catch {
              this.fence(projectId)
              return { kind: 'unknown', detail: 'Restricted review restoration or acknowledgement is uncertain' }
            }
          }
          const entry = await this.owners.get(projectId); if (entry) this.finishWork(projectId, entry.owner)
        }
        return outcome
      } catch (error) {
        if (observation.attempted) this.fence(projectId)
        throw error
      } finally { observation.closed = true; this.decodingBuilds.delete(projectId); this.buildObservations.delete(projectId) }
    } }
    return { ...guarded, run: async (request, placement, signal) => {
      if (request.role !== 'review' && request.role !== 'synthesis') return guarded.run(request, placement, signal)
      const previous = this.reviewQueue.get(projectId) ?? Promise.resolve()
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const tail = previous.then(() => gate)
      this.reviewQueue.set(projectId, tail)
      const timer = new AbortController()
      const stopped = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, request.budget.wall_ms))])
      try {
        await Promise.race([previous, delay(Math.max(1, request.budget.wall_ms), undefined, { signal: AbortSignal.any([stopped, timer.signal]) })
          .then(() => { throw new Error('Review queue budget expired') })])
        stopped.throwIfAborted()
        return await guarded.run(request, placement, stopped)
      } catch { return { kind: 'unknown', detail: 'Restricted review queue or execution was interrupted' } }
      finally { timer.abort(); release(); if (this.reviewQueue.get(projectId) === tail) this.reviewQueue.delete(projectId) }
    } }
  }

  start(projectId: string | undefined, spec: AgentSpec): SessionHandle {
    return this.startTurn(projectId, spec)
  }

  /** Readiness attests the existing owner capability; it does not grant permissions. */
  async prepareReview(projectId: string): Promise<void> {
    const { owner } = await this.resolve(projectId)
    if (!owner.broker.reviewPermissions) throw new Error('Codex owner lacks attested read-only child execution with isolated result output')
    this.reviewReady.add(projectId)
  }

  private startTurn(projectId: string | undefined, spec: AgentSpec, buildDispatch = false): SessionHandle {
    const abort = new AbortController()
    let inner: SessionHandle | undefined
    const events = (async function* (bindings: CodexOwnerBindings) {
      try {
        if (projectId === undefined) throw new Error('Codex owner chat requires a project selection')
        if (!buildDispatch && (bindings.builds.get(projectId)?.input || bindings.decodingBuilds.has(projectId))) {
          throw new Error('Codex owner build result is still pending')
        }
        const { project } = await bindings.resolve(projectId)
        abort.signal.throwIfAborted()
        if (bindings.cleanReviewRefusals.has(projectId)) {
          const owner = bindings.resolvedOwners.get(projectId)!
          await refreshOwner(owner)
          if (!bindings.busy.has(projectId) && owner.broker.state().phase === 'idle') {
            bindings.conversationHosts.delete(projectId)
            bindings.cleanReviewRefusals.delete(projectId)
          }
        }
        if (!buildDispatch && (bindings.builds.get(projectId)?.input || bindings.decodingBuilds.has(projectId))) {
          throw new Error('Codex owner build result is still pending')
        }
        let host = bindings.conversationHosts.get(projectId)
        if (!host) { host = { acquireTurn: bindings.host.acquireTurn }; bindings.conversationHosts.set(projectId, host) }
        inner = createCodexConversationalSubstrate({ projectId, cwd: project.cwd, env: project.env, host }).start(spec)
        const pending: Event[] = []
        let wake: (() => void) | undefined
        const sink = (question: NativeOwnerQuestion): void => {
          pending.push({ kind: 'tool_call', tool_name: 'codex_owner_question', call_id: String(question.requestId), args: question })
          pending.push({ kind: 'status', message: 'Codex is waiting for your answer in this project’s native controls.' })
          wake?.()
        }
        if (bindings.questionSinks.has(projectId)) throw new Error('Codex owner conversation is already active')
        bindings.questionSinks.set(projectId, sink)
        const iterator = inner.events[Symbol.asyncIterator]()
        let next = iterator.next()
        try {
          while (true) {
            while (pending.length) yield pending.shift()!
            const changed = new Promise<'question'>(resolve => { wake = () => resolve('question') })
            const result = await Promise.race([next, changed])
            wake = undefined
            if (result === 'question') continue
            if (result.done) break
            yield result.value
            next = iterator.next()
          }
        } finally {
          if (bindings.questionSinks.get(projectId) === sink) bindings.questionSinks.delete(projectId)
          try { await inner.cancel() }
          finally { await iterator.return?.() }
        }
      } catch (error) {
        yield { kind: 'error' as const, message: error instanceof Error ? error.message : 'Codex owner unavailable', retryable: false }
      }
    })(this)
    return { events, tool_resolution: 'internal', async cancel() { abort.abort(); await inner?.cancel() },
      async respondToTool() { throw new Error('Codex resolves tools internally') } }
  }

  actingTurn(projectId: string, topicId: string, cwd: string, roots: readonly string[]): ProjectActingTurn {
    return async turn => {
      const observation = this.buildObservations.get(projectId)
      const deadline = Date.now() + Math.min(turn.timeout_ms, turn.request.budget.wall_ms)
      const preflight = (): void => {
        turn.signal.throwIfAborted()
        if (observation?.closed || Date.now() >= deadline) throw new Error('Codex build preflight is no longer current')
      }
      const validatePaths = (project: CodexOwnerProject): void => {
        if (realpathSync(cwd) !== project.cwd) throw new Error('Codex build project directory changed')
        if (roots.some(root => relative(project.cwd, realpathSync(root)).split(sep)[0] === '..')) {
          throw new Error('Codex build worktree is outside the owner workspace grants')
        }
      }
      preflight()
      const restricted = turn.request.role === 'review' || turn.request.role === 'synthesis'
      if (restricted ? !this.reviewReady.has(projectId) || !observation || turn.request.writable || turn.request.tools !== 'read-only'
        : turn.request.writable === false || turn.request.tools === 'read-only' || turn.request.tools === 'none') {
        return { kind: 'refused', reason: 'capability-unsupported', detail: 'Codex owner lacks attested read-only child execution with isolated result output' }
      }
      const { owner, project } = await this.resolve(projectId, canonicalProject => {
        preflight()
        validatePaths(canonicalProject)
        if (observation) observation.attempted = true
      })
      preflight()
      // Recheck after asynchronous attachment, and for an already-resolved owner.
      validatePaths(project)
      if (restricted) {
        const key = createHash('sha256').update(JSON.stringify([projectId, turn.request.run_id, turn.request.step_id])).digest('hex')
        const stage = join(project.cwd, '.neutron', 'build-results', key)
        if (turn.request.result.path !== join(stage, 'result.json') || realpathSync(stage) !== stage || !owner.broker.reviewPermissions) {
          return { kind: 'refused', reason: 'capability-unsupported', detail: 'Restricted review requires the exact host-staged result path' }
        }
      }
      const facts = this.readBinding(owner.binding)
      // Native feature evidence is sealed by the factory before the first turn.
      // A requested feature flag is not an attestation of native availability.
      if (!('capabilities' in facts) || typeof facts.capabilities !== 'object' || facts.capabilities === null
        || !('multiAgentV2' in facts.capabilities) || facts.capabilities.multiAgentV2 !== true
        || !('evidence' in facts.capabilities) || facts.capabilities.evidence !== 'native-thread-feature-report') {
        return { kind: 'refused', reason: 'capability-unsupported', detail: 'Codex owner lacks attested native subagent capability' }
      }
      let build = this.builds.get(projectId)
      if (!build) {
        const session: NonNullable<CodexActingSession['session']> = {
          projectId, isLive: () => !this.refused.has(projectId) && owner.broker.state().phase === 'idle',
          screenPrompt: () => undefined, answerApproval: async () => { throw new Error('Codex bounded approval refused') },
          submitLine: async (prompt, dispatch) => {
            const active = this.builds.get(projectId)?.input
            if (!active) throw new Error('Codex build session has no active dispatch')
            dispatch.signal.throwIfAborted()
            const handle = this.startTurn(projectId, { ...active.spec, prompt, session: { id: facts.threadId, last_active_at: Date.now() },
              turn_absolute_ceiling_ms: dispatch.timeout_ms }, true)
            const cancel = (): void => { fireAndForget('codex-owner-binding.cancel', handle.cancel()) }
            dispatch.signal.addEventListener('abort', cancel, { once: true })
            try {
              if (dispatch.signal.aborted) await handle.cancel()
              let completed = false
              for await (const event of handle.events) {
                if (event.kind === 'error') throw new Error(event.message)
                if (event.kind === 'completion') completed = true
              }
              if (!completed) throw new Error('Codex build native completion missing')
            } finally { dispatch.signal.removeEventListener('abort', cancel) }
          },
        }
        build = { session }; this.builds.set(projectId, build)
      }
      if (build.input) return { kind: 'unknown', detail: 'Codex owner build dispatch is already awaiting its child trailer' }
      build.input = turn
      const beforeDispatch = this.nativeDispatches.get(projectId) ?? 0
      const dispatched = () => (this.nativeDispatches.get(projectId) ?? 0) !== beforeDispatch
      try {
        const outcome = await createCodexActingTurn({ project_id: projectId, topic_id: topicId, thread_id: facts.threadId, cwd: project.cwd,
          grants: { tools: 'edit-and-run', writable: true, network: true, roots }, session: build.session })(turn)
        // A native parent can finish while its child remains unresolved. Fence
        // chat as well as subsequent builds until the host reconciles that child.
        if (outcome.kind !== 'turn-ended') { if (dispatched()) this.fence(projectId) }
        else {
          if (observation) {
            const terminal = decodeProjectTrailer(readFileSync(turn.request.result.path, 'utf8'), turn.request,
              { schemas: new Map([[turn.request.result.schema, value => value !== undefined]]), metadata: () => undefined })
            observation.terminal = terminal.kind === 'completed' || terminal.kind === 'blocked'
          }
          if (!this.decodingBuilds.has(projectId)) this.finishWork(projectId, owner)
        }
        return outcome
      } catch (error) {
        if (dispatched()) this.fence(projectId)
        throw error
      } finally {
        delete build.input
        // The bridge may fence its wrapper before native delivery. A new wrapper
        // is safe only after host-observed zero native attempts, never after a write.
        if (!dispatched() && this.builds.get(projectId) === build) this.builds.delete(projectId)
      }
    }
  }
}
