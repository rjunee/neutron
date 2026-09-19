import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { readCodexOwnerBinding, type CodexOwnerBootstrap, type CodexOwnerAttachment } from '@neutronai/runtime/adapters/codex-cli/persistent/project-control-bootstrap.ts'
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
  private readonly buildObservations = new Map<string, { invoked: boolean; terminal: boolean }>()
  private readonly builds = new Map<string, {
    session: NonNullable<CodexActingSession['session']>
    input?: Parameters<ProjectActingTurn>[0]
  }>()
  private closed = false
  private readonly ownerProjects = new WeakMap<CodexOwnerBootstrap, string>()
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
      this.beginWork(owner)
      let released = false
      let submitted = false
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
          const response = await gateway.request('turn/start', {
            threadId: facts.threadId, model, input: [{ type: 'text', text: prompt }],
            cwd: project.cwd, approvalPolicy: 'on-request',
            sandboxPolicy: { type: 'workspaceWrite', writableRoots: [project.cwd], networkAccess: true },
          }, epoch) as { turn?: { id?: unknown } }
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
            if (outcome !== 'completed' || owner.broker.state().phase !== 'idle') this.refused.add(options.projectId)
          } catch (error) { this.refused.add(options.projectId); throw error }
          finally { control.close(); gateway.close(); this.busy.delete(options.projectId) }
          if (!this.builds.get(options.projectId)?.input && !this.decodingBuilds.has(options.projectId)) this.finishWork(options.projectId, owner)
        },
      }
    },
  }
  private sequence = 0

  constructor(private readonly project: (projectId: string) => Promise<CodexOwnerProject>,
    private readonly bootstrap: (options: OwnerLaunch) => Promise<CodexOwnerBootstrap> = openDurableCodexOwner,
    private readonly readBinding: typeof readCodexOwnerBinding = readCodexOwnerBinding) {}

  private resolve(projectId: string): Promise<{ owner: CodexOwnerBootstrap; project: CodexOwnerProject }> {
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
    const facts = this.readBinding(owner.binding)
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
    // Capture failures in owner controls as well as active build/chat leases.
    const owner = this.resolvedOwners.get(projectId)
    if (owner) this.beginWork(owner)
  }

  /** The host schema decoder runs after the acting bridge. Its uncertainty
   * must fence this same owner even when native parent/envelope checks passed. */
  guardBuildRunner(projectId: string, worker: WorkerRunner): WorkerRunner {
    return { ...worker, run: async (request, placement, signal) => {
      // Positive no-dispatch proof: no runner/acting-turn call has occurred.
      // A cancelled admission must not create a durable owner uncertainty marker.
      if (signal.aborted || request.budget.wall_ms <= 0) return { kind: 'unknown', detail: 'Cancelled or out of time before owner dispatch.' }
      if (this.decodingBuilds.has(projectId)) return { kind: 'unknown', detail: 'Codex owner build result is still pending' }
      this.decodingBuilds.add(projectId)
      const observation = { invoked: false, terminal: false }
      this.buildObservations.set(projectId, observation)
      try {
        const outcome = await worker.run(request, placement, signal)
        if (outcome.kind === 'unknown' || outcome.kind === 'failed') {
          // Tags alone cannot establish delivery or terminal settlement. No
          // acting-turn invocation is positive no-dispatch evidence. A failed
          // host result after exact parent + child terminal evidence is safe
          // only if no independent uncertainty fence or active lease remains.
          if (!observation.invoked) return outcome
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
        else { const entry = await this.owners.get(projectId); if (entry) this.finishWork(projectId, entry.owner) }
        return outcome
      } catch (error) {
        this.refused.add(projectId)
        throw error
      } finally { this.decodingBuilds.delete(projectId); this.buildObservations.delete(projectId) }
    } }
  }

  start(projectId: string | undefined, spec: AgentSpec): SessionHandle {
    return this.startTurn(projectId, spec)
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
        if (!buildDispatch && (bindings.builds.get(projectId)?.input || bindings.decodingBuilds.has(projectId))) {
          throw new Error('Codex owner build result is still pending')
        }
        inner = createCodexConversationalSubstrate({ projectId, cwd: project.cwd, env: project.env, host: bindings.host }).start(spec)
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
      if (observation) observation.invoked = true
      const { owner, project } = await this.resolve(projectId)
      if (realpathSync(cwd) !== project.cwd) throw new Error('Codex build project directory changed')
      if (roots.some(root => relative(project.cwd, realpathSync(root)).split(sep)[0] === '..')) {
        throw new Error('Codex build worktree is outside the owner workspace grants')
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
          submitLine: async prompt => {
            const active = this.builds.get(projectId)?.input
            if (!active) throw new Error('Codex build session has no active dispatch')
            const handle = this.startTurn(projectId, { ...active.spec, prompt, session: { id: facts.threadId, last_active_at: Date.now() },
              turn_absolute_ceiling_ms: Math.min(active.timeout_ms, active.request.budget.wall_ms) }, true)
            const cancel = (): void => { void handle.cancel().catch(() => {}) }
            active.signal.addEventListener('abort', cancel, { once: true })
            try {
              if (active.signal.aborted) await handle.cancel()
              let completed = false
              for await (const event of handle.events) {
                if (event.kind === 'error') throw new Error(event.message)
                if (event.kind === 'completion') completed = true
              }
              if (!completed) throw new Error('Codex build native completion missing')
            } finally { active.signal.removeEventListener('abort', cancel) }
          },
        }
        build = { session }; this.builds.set(projectId, build)
      }
      if (build.input) return { kind: 'unknown', detail: 'Codex owner build dispatch is already awaiting its child trailer' }
      build.input = turn
      this.beginWork(owner)
      try {
        const outcome = await createCodexActingTurn({ project_id: projectId, topic_id: topicId, thread_id: facts.threadId, cwd: project.cwd,
          grants: { tools: 'edit-and-run', writable: true, network: true, roots }, session: build.session })(turn)
        // A native parent can finish while its child remains unresolved. Fence
        // chat as well as subsequent builds until the host reconciles that child.
        if (outcome.kind !== 'turn-ended') this.refused.add(projectId)
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
        this.refused.add(projectId)
        throw error
      } finally { delete build.input }
    }
  }
}
