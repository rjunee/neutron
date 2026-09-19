import { readFileSync, realpathSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { bootstrapCodexOwner, readCodexOwnerBinding, type CodexOwnerBootstrap } from '@neutronai/runtime/adapters/codex-cli/persistent/project-control-bootstrap.ts'
import { createCodexConversationalSubstrate, type CodexConversationHost } from '@neutronai/runtime/adapters/codex-cli/persistent/conversational-substrate.ts'
import { createCodexActingTurn, type CodexActingSession } from '@neutronai/runtime/workers/codex-acting-turn.ts'
import type { ProjectActingTurn } from '@neutronai/runtime/workers/project-runners.ts'
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

/** One host-owned authority per full project id, shared by chat and builds.
 * Failed opening and uncertain delivery remain fenced for this host's lifetime.
 * The frozen factory refuses existing journals: this draft cannot recover owners.
 */
export class CodexOwnerBindings {
  private readonly owners = new Map<string, Promise<{ owner: CodexOwnerBootstrap; project: CodexOwnerProject }>>()
  private readonly busy = new Set<string>()
  private readonly refused = new Set<string>()
  private readonly decodingBuilds = new Set<string>()
  private readonly builds = new Map<string, {
    session: NonNullable<CodexActingSession['session']>
    input?: Parameters<ProjectActingTurn>[0]
  }>()
  private closed = false
  private readonly ownerProjects = new WeakMap<CodexOwnerBootstrap, string>()
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
    fence: projectId => { this.refused.add(projectId) },
  })
  readonly host: CodexConversationHost = {
    acquireTurn: async (options, signal) => {
      signal.throwIfAborted()
      const { owner, project } = await this.resolve(options.projectId)
      signal.throwIfAborted()
      if (realpathSync(options.cwd) !== project.cwd) throw new Error('Codex owner project directory changed')
      if (this.refused.has(options.projectId)) throw new Error('Codex owner requires native reconciliation')
      if (this.busy.has(options.projectId) || this.controls.isSwitching(options.projectId) || owner.broker.state().phase !== 'idle') throw new Error('Codex owner is busy or requires recovery')
      const facts = this.readBinding(owner.binding)
      const gateway = owner.broker.gateway(`owner-turn-${++this.sequence}`)
      this.busy.add(options.projectId)
      let released = false
      let submitted = false
      let turnId: string | undefined
      const control = this.controls.register(options.projectId, owner, gateway, question => {
        this.questionSinks.get(options.projectId)?.(question)
        if (this.onOwnerQuestion) fireAndForget('codex-owner.question', Promise.resolve().then(() => this.onOwnerQuestion!(options.projectId, question)),
          () => { this.refused.add(options.projectId) })
      })
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
          if (outcome !== 'completed' || owner.broker.state().phase !== 'idle') this.refused.add(options.projectId)
          control.close(); gateway.close(); this.busy.delete(options.projectId)
        },
      }
    },
  }
  private sequence = 0

  constructor(private readonly project: (projectId: string) => Promise<CodexOwnerProject>,
    private readonly bootstrap: typeof bootstrapCodexOwner = bootstrapCodexOwner,
    private readonly readBinding: typeof readCodexOwnerBinding = readCodexOwnerBinding) {}

  private resolve(projectId: string): Promise<{ owner: CodexOwnerBootstrap; project: CodexOwnerProject }> {
    if (this.closed) return Promise.reject(new Error('Codex owner host is closed'))
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(projectId)) return Promise.reject(new Error('Codex owner requires a full project id'))
    let pending = this.owners.get(projectId)
    if (!pending) {
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
        const owner = await this.bootstrap({ binary: 'codex', socketPath: join(project.codexHome, 'owner.sock'),
          cwd: project.cwd, codexHome: project.codexHome, env })
        try {
          const facts = this.readBinding(owner.binding)
          if (this.closed || facts.cwd !== project.cwd || facts.codexHome !== project.codexHome) {
            throw new Error('Codex factory returned a foreign or closed project binding')
          }
        } catch (error) {
          await owner.close()
          throw error
        }
        this.ownerProjects.set(owner, projectId)
        return { owner, project }
      })()
      this.owners.set(projectId, pending)
    }
    return pending
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.owners.values()].map(async pending => { await (await pending).owner.close() }))
  }

  /** The host schema decoder runs after the acting bridge. Its uncertainty
   * must fence this same owner even when native parent/envelope checks passed. */
  guardBuildRunner(projectId: string, worker: WorkerRunner): WorkerRunner {
    return { ...worker, run: async (request, placement, signal) => {
      if (this.decodingBuilds.has(projectId)) return { kind: 'unknown', detail: 'Codex owner build result is still pending' }
      this.decodingBuilds.add(projectId)
      try {
        const outcome = await worker.run(request, placement, signal)
        if (outcome.kind === 'unknown' || outcome.kind === 'failed') this.refused.add(projectId)
        return outcome
      } catch (error) {
        this.refused.add(projectId)
        throw error
      } finally { this.decodingBuilds.delete(projectId) }
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
      try {
        const outcome = await createCodexActingTurn({ project_id: projectId, topic_id: topicId, thread_id: facts.threadId, cwd: project.cwd,
          grants: { tools: 'edit-and-run', writable: true, network: true, roots }, session: build.session })(turn)
        // A native parent can finish while its child remains unresolved. Fence
        // chat as well as subsequent builds until the host reconciles that child.
        if (outcome.kind !== 'turn-ended') this.refused.add(projectId)
        return outcome
      } catch (error) {
        this.refused.add(projectId)
        throw error
      } finally { delete build.input }
    }
  }
}
