import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { readCodexOwnerBinding, type CodexOwnerBootstrap, type CodexOwnerAttachment, type CodexOwnerBindingFacts, type CodexOwnerRetirement } from '@neutronai/runtime/adapters/codex-cli/persistent/project-control-bootstrap.ts'
import { CodexOwnerRecoveryUnavailable, durableOwnerPathExists, locateDurableOwnerGeneration, openDurableCodexOwner, type OwnerLaunch } from './codex-durable-owner.ts'
import { createCodexConversationalSubstrate, type CodexConversationHost } from '@neutronai/runtime/adapters/codex-cli/persistent/conversational-substrate.ts'
import { createCodexActingTurn, type CodexActingSession } from '@neutronai/runtime/workers/codex-acting-turn.ts'
import { decodeProjectTrailer, type ProjectActingTurn } from '@neutronai/runtime/workers/project-runners.ts'
import type { AgentSpec } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { BoundedWorkRequest, WorkerRunner } from '@neutronai/runtime/bounded-work.ts'
import { CODEX_CLI_AUTH_ENV_VARS } from '@neutronai/runtime/adapters/codex-cli/auth.ts'
import { CodexOwnerControls, type NativeOwnerQuestion } from './codex-owner-controls.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import type { ReviewPermissionLease } from '@neutronai/runtime/adapters/codex-cli/persistent/project-review-permissions.ts'
import { ReviewPermissionBusy } from '@neutronai/runtime/adapters/codex-cli/persistent/project-control-broker.ts'
import { CodexRolloutObserver } from '@neutronai/runtime/adapters/codex-cli/persistent/rollout-observer.ts'
import { DurableOwnerMcp } from '@neutronai/runtime/adapters/codex-cli/persistent/durable-owner-mcp.ts'
import type { ResolvedOwnerMcpServer } from '@neutronai/runtime/mcp-servers.ts'
import { assertOwnerScope, privatePath } from '@neutronai/runtime/adapters/codex-cli/persistent/project-owner-helper-protocol.ts'
import { abortAccountHandoff, completeAccountHandoff, prepareAccountHandoff, readGeneralOwnerAuthority } from '@neutronai/runtime/adapters/codex-cli/persistent/project-owner-account-handoff.ts'
import { probeCodexAccountViability } from '@neutronai/runtime/adapters/codex-cli/persistent/project-account-probe.ts'

class CodexWorkRecoveryRequired extends Error {}
interface BoundedOwnerWork {
  version: 1
  kind: 'bounded-work'
  projectId: string
  credentialIdentity: string
  facts: CodexOwnerBindingFacts
  request: BoundedWorkRequest
  nativeRequest: BoundedWorkRequest
  turnId: string | null
  epoch: number | null
}
function ownerWorkBytes(home: string): string {
  const path = join(home, '.neutron-owner-work.json')
  privatePath(path, 'file')
  if (lstatSync(path).size > 256 * 1024) throw new Error('Codex work evidence exceeds its bound')
  return readFileSync(path, 'utf8')
}

function assertWorkProjection(projectId: string, cwd: string, request: BoundedWorkRequest, nativeRequest: BoundedWorkRequest): void {
  const key = createHash('sha256').update(JSON.stringify([projectId, request.run_id, request.step_id])).digest('hex')
  const projected = { ...request, result: { ...request.result, path: join(cwd, '.neutron', 'build-results', key, 'result.json') } }
  if (!isDeepStrictEqual(nativeRequest, request) && !isDeepStrictEqual(nativeRequest, projected)) {
    throw new Error('Codex native work projection does not match its guarded request')
  }
}

export interface CodexOwnerProject {
  cwd: string
  codexHome: string
  credentialIdentity: string
  env: NodeJS.ProcessEnv
  /** Fixed instance locator, independent of the selected global credential home. */
  generalAuthorityPath?: string
}

async function refreshOwner(owner: CodexOwnerBootstrap): Promise<void> {
  const remote = owner as Partial<CodexOwnerAttachment>
  if (remote.refreshState) await remote.refreshState()
}

/** One host-owned authority per explicit scope: null General or full project id.
 * Project chat and builds share their authority; General never gains a project grant.
 * Failed opening and uncertain delivery remain fenced for this host's lifetime.
 * Production attaches only to an independently hosted durable native owner.
 */
export class CodexOwnerBindings {
  resolveApprovedServers?: (projectId: string | null) => Promise<readonly ResolvedOwnerMcpServer[]>
  private readonly installedMcp = new Map<string | null, DurableOwnerMcp>()
  private readonly owners = new Map<string | null, Promise<{ owner: CodexOwnerBootstrap; project: CodexOwnerProject }>>()
  private readonly busy = new Set<string | null>()
  private readonly retiring = new Set<string | null>()
  private readonly refused = new Set<string | null>()
  private readonly decodingBuilds = new Set<string | null>()
  private readonly reviewReady = new Set<string | null>()
  private readonly reviews = new Map<string | null, ReviewPermissionLease>()
  private readonly reviewQueue = new Map<string | null, Promise<void>>()
  private readonly cleanReviewRefusals = new Set<string | null>()
  private readonly buildObservations = new Map<string | null, { attempted: boolean; terminal: boolean; closed: boolean; request: BoundedWorkRequest }>()
  private readonly nativeDispatches = new Map<string | null, number>()
  private readonly conversationHosts = new Map<string | null, CodexConversationHost>()
  private readonly builds = new Map<string | null, {
    session: NonNullable<CodexActingSession['session']>
    input?: Parameters<ProjectActingTurn>[0]
  }>()
  private closed = false
  private readonly ownerProjects = new WeakMap<CodexOwnerBootstrap, string | null>()
  private readonly ownerFacts = new WeakMap<CodexOwnerBootstrap, CodexOwnerBindingFacts>()
  private readonly resolvedOwners = new Map<string | null, CodexOwnerBootstrap>()
  private readonly questionSinks = new Map<string | null, (question: NativeOwnerQuestion) => void>()
  onOwnerQuestion?: (projectId: string | null, question: NativeOwnerQuestion) => Promise<void>
  readonly controls = new CodexOwnerControls({
    lookup: async projectId => {
      const entry = await this.owners.get(projectId)
      if (entry) assertOwnerScope(entry.project.codexHome, projectId)
      return entry?.owner
    },
    authorize: async projectId => {
      const entry = await this.owners.get(projectId)
      if (entry) await this.revalidateProject(projectId, entry.project)
    },
    facts: owner => {
      const facts = this.readBinding(owner.binding)
      const projectId = this.ownerProjects.get(owner)
      if (projectId === undefined) throw new Error('Codex owner credential home identity changed')
      assertOwnerScope(facts.codexHome, projectId)
      return facts
    },
    busy: projectId => this.retiring.has(projectId) || this.busy.has(projectId) || !!this.builds.get(projectId)?.input || this.decodingBuilds.has(projectId),
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
      if (this.retiring.has(options.projectId) || this.busy.has(options.projectId) || this.controls.isSwitching(options.projectId) || owner.broker.state().phase !== 'idle') throw new Error('Codex owner is busy or requires recovery')
      const facts = this.readBinding(owner.binding)
      const clientId = `owner-turn-${++this.sequence}`
      const gateway = owner.broker.gateway(clientId)
      this.busy.add(options.projectId)
      let released = false
      let submitted = false
      let deliveryAttempted = false
      let turnId: string | undefined
      let workBytes: string | undefined
      let receiptReady!: () => void
      const receipt = new Promise<void>(resolve => { receiptReady = resolve })
      let mcp: DurableOwnerMcp | undefined
      const control = this.controls.register(options.projectId, owner, gateway, question => {
        this.questionSinks.get(options.projectId)?.(question)
        if (this.onOwnerQuestion) fireAndForget('codex-owner.question', Promise.resolve().then(() => this.onOwnerQuestion!(options.projectId, question)),
          () => { this.fence(options.projectId) })
      }, clientId, request => {
        const reply = (result: unknown): void => {
          fireAndForget('codex-owner.installed-tool.reply', (async () => {
            // Even a refusal belongs only to its original native writer/turn.
            if (!current() || request.params.turnId !== turnId || owner.broker.state().activeTurnId !== turnId) return
            const attachment = owner as Partial<CodexOwnerAttachment>
            if (attachment.replyApproval) await attachment.replyApproval(clientId, request.id, result, owner.broker.state().epoch)
            else gateway.reply(request.id, result, owner.broker.state().epoch)
          })(), () => { if (current()) this.fence(options.projectId) })
        }
        fireAndForget('codex-owner.installed-tool', (async () => {
          await receipt
          const assertTurn = () => {
            signal.throwIfAborted()
            if (!current() || !turnId || request.params.turnId !== turnId || owner.broker.state().activeTurnId !== turnId
              || this.builds.get(options.projectId)?.input || this.decodingBuilds.has(options.projectId)) throw new Error('Owner MCP requires the exact conversational turn')
          }
          assertTurn()
          if (!mcp) throw new Error('Owner MCP is unavailable on this binding')
          reply(await mcp.handle(request, clientId, assertTurn))
        })(), () => {
          reply({ success: false, contentItems: [{ type: 'inputText', text: 'Owner MCP authority is unavailable or the request was refused.' }] })
        })
      })
      const current = (): boolean => {
        try {
          assertOwnerScope(project.codexHome, options.projectId)
          const now = this.readBinding(owner.binding)
          return !released && now.bindingRevision === facts.bindingRevision
            && owner.broker.state().phase !== 'closed' && !this.refused.has(options.projectId)
        } catch { return false }
      }
      try {
        if (this.resolveApprovedServers && !this.builds.get(options.projectId)?.input && !this.decodingBuilds.has(options.projectId)) {
          if (facts.capabilities.ownerInstalledMcp !== true) {
            if ((await this.resolveApprovedServers(options.projectId)).length) throw new Error('Existing native owner lacks the installed MCP gateway; explicit upgrade is required')
          } else {
            mcp = this.installedMcp.get(options.projectId)
            if (!mcp) {
              mcp = new DurableOwnerMcp(() => this.resolveApprovedServers!(options.projectId))
              this.installedMcp.set(options.projectId, mcp)
            }
            const assertOwner = () => {
              signal.throwIfAborted()
              if (!current() || this.builds.get(options.projectId)?.input || this.decodingBuilds.has(options.projectId)) throw new Error('Owner MCP conversation authority changed')
            }
            const epoch = owner.broker.state().epoch
            await mcp.prepare({ projectId: options.projectId, sessionId: facts.sessionId, threadId: facts.threadId,
              generation: facts.bindingRevision, leaseId: clientId, phase: 'active', idle: true }, signal,
              () => { assertOwner(); if (owner.broker.state().phase !== 'idle' || owner.broker.state().epoch !== epoch) throw new Error('Owner MCP preparation lost native idle binding') },
              () => { assertOwner(); if (owner.broker.state().phase !== 'turn' || !turnId || owner.broker.state().activeTurnId !== turnId) throw new Error('Owner MCP turn is not active') })
          }
        }
      } catch (error) {
        released = true; receiptReady(); control.close(); gateway.close(); this.busy.delete(options.projectId)
        throw error
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
          const bounded = this.builds.get(options.projectId)?.input
          const guardedRequest = observation?.request ?? bounded?.request
          if (bounded && guardedRequest && options.projectId !== null) assertWorkProjection(options.projectId, project.cwd, guardedRequest, bounded.request)
          workBytes = this.beginWork(owner, bounded && options.projectId !== null
            ? { projectId: options.projectId, credentialIdentity: project.credentialIdentity, request: guardedRequest!, nativeRequest: bounded.request } : undefined)
          deliveryAttempted = true
          if (observation) observation.attempted = true
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
          if (workBytes && bounded) {
            const work = JSON.parse(workBytes)
            if (work.kind === 'bounded-work') {
              if (ownerWorkBytes(project.codexHome) !== workBytes) throw new Error('Codex work evidence changed during dispatch')
              workBytes = JSON.stringify({ ...work, turnId, epoch: owner.broker.state().epoch })
              writeFileSync(join(project.codexHome, '.neutron-owner-work.json'), workBytes, { mode: 0o600 })
            }
          }
          control.receipt(turnId)
          receiptReady()
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
          receiptReady()
          mcp?.retireTurn(clientId)
          try {
            // Only an acknowledged owner control may make a correlated native
            // abort reusable. Build cancellation never proves child settlement.
            const settled = outcome === 'completed' || outcome === 'interrupted'
              && !this.builds.get(options.projectId)?.input && !this.decodingBuilds.has(options.projectId)
              && await control.interrupted()
            await refreshOwner(owner)
            // Rollout terminal records can precede the broker's native turn/completed
            // event. Reconcile only this exact finished turn, without a write or
            // replay; idle from a single prematurely sampled RPC is not guaranteed.
            const deadline = Date.now() + 2_000
            while (settled && turnId && owner.broker.state().phase === 'turn'
              && owner.broker.state().activeTurnId === turnId && Date.now() < deadline) {
              await Bun.sleep(25)
              await refreshOwner(owner)
            }
            if (deliveryAttempted && (!settled || !this.reviews.has(options.projectId) && owner.broker.state().phase !== 'idle')) this.fence(options.projectId)
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

  private async revalidateProject(projectId: string | null, previous: CodexOwnerProject, supplied?: CodexOwnerProject): Promise<void> {
    const raw = supplied ?? await this.scopeProject(projectId)
    const current = { ...raw, cwd: realpathSync(raw.cwd), codexHome: realpathSync(raw.codexHome) }
    if (current.cwd !== previous.cwd || current.codexHome !== previous.codexHome
      || !current.credentialIdentity || current.credentialIdentity !== previous.credentialIdentity) {
      throw new Error('Codex owner project credential identity changed; explicit reconciliation required')
    }
    assertOwnerScope(current.codexHome, projectId)
  }

  constructor(private readonly project: (projectId: string) => Promise<CodexOwnerProject>,
    private readonly bootstrap: (options: OwnerLaunch) => Promise<CodexOwnerBootstrap> = openDurableCodexOwner,
    private readonly readBinding: typeof readCodexOwnerBinding = readCodexOwnerBinding,
    private readonly general?: (retainedHome?: string) => Promise<CodexOwnerProject>) {}

  private scopeProject(projectId: string | null): Promise<CodexOwnerProject> {
    if (projectId !== null) return this.project(projectId)
    if (!this.general) return Promise.reject(new Error('Codex General owner credential is unavailable'))
    return this.general().then(async raw => {
      const selected = { ...raw, cwd: realpathSync(raw.cwd), codexHome: realpathSync(raw.codexHome) }
      let authority = selected.generalAuthorityPath ? readGeneralOwnerAuthority(selected.generalAuthorityPath) : undefined
      if (authority?.preparing) {
        // Missing or uncertain retirement evidence throws. Never ordinary-resume
        // the source account across a gateway crash in the handoff transaction.
        completeAccountHandoff(authority.preparing.locator)
        authority = readGeneralOwnerAuthority(selected.generalAuthorityPath!)
      }
      if (!authority) return selected
      const retainedRaw = authority.scope.codexHome === selected.codexHome ? selected : await this.general!(authority.scope.codexHome)
      const retained = { ...retainedRaw, cwd: realpathSync(retainedRaw.cwd), codexHome: realpathSync(retainedRaw.codexHome) }
      if (retained.codexHome !== authority.scope.codexHome || retained.cwd !== authority.scope.cwd
        || retained.credentialIdentity !== authority.scope.credential || retained.generalAuthorityPath !== selected.generalAuthorityPath) {
        throw new Error('Retained General account grant or identity changed')
      }
      return retained
    })
  }

  private resolve(projectId: string | null, beforeOpening?: (project: CodexOwnerProject) => void, recoveringWork?: string): Promise<{ owner: CodexOwnerBootstrap; project: CodexOwnerProject }> {
    if (this.retiring.has(projectId)) return Promise.reject(new Error('Codex owner is retiring'))
    if (this.closed) return Promise.reject(new Error('Codex owner host is closed'))
    if (this.refused.has(projectId)) return Promise.reject(new Error('Codex owner requires native reconciliation'))
    if (projectId !== null && !/^[A-Za-z0-9_.-]{1,128}$/.test(projectId)) return Promise.reject(new Error('Codex owner requires a full project id'))
    let pending = this.owners.get(projectId)
    if (pending) return pending.then(async entry => {
      await this.revalidateProject(projectId, entry.project)
      if (existsSync(join(entry.project.codexHome, '.neutron-owner-work.json'))
        && ownerWorkBytes(entry.project.codexHome) !== recoveringWork) {
        throw new CodexWorkRecoveryRequired('Codex interrupted host work requires native reconciliation')
      }
      return projectId === null ? this.handoffGeneral(entry) : entry
    })
    if (!pending) {
      let openingAttempted = false
      pending = (async () => {
        const raw = await this.scopeProject(projectId)
        if (!raw.credentialIdentity) throw new Error('Codex owner requires a credential identity')
        const project = { ...raw, cwd: realpathSync(raw.cwd), codexHome: realpathSync(raw.codexHome) }
        assertOwnerScope(project.codexHome, projectId)
        const env: Record<string, string> = {}
        for (const [key, value] of Object.entries(project.env)) {
          if (value !== undefined && !CODEX_CLI_AUTH_ENV_VARS.includes(key)) env[key] = value
        }
        env.CODEX_HOME = project.codexHome
        beforeOpening?.(project)
        openingAttempted = true
        const owner = await this.bootstrap({ projectId, binary: 'codex', socketPath: join(project.codexHome, 'owner.sock'),
          cwd: project.cwd, codexHome: project.codexHome, env,
          ...(projectId === null ? { generalAuthorityPath: project.generalAuthorityPath } : {}) })
        try {
          const facts = this.readBinding(owner.binding)
          if (existsSync(join(project.codexHome, '.neutron-owner-work.json'))) {
            const bytes = ownerWorkBytes(project.codexHome)
            if (recoveringWork !== bytes) {
              if (JSON.parse(bytes)?.kind === 'bounded-work') throw new CodexWorkRecoveryRequired('Codex interrupted host work requires native reconciliation')
              throw new Error('Codex interrupted host work requires native reconciliation')
            }
          } else if (recoveringWork !== undefined) throw new Error('Codex recovery work evidence disappeared')
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
        if (!openingAttempted || error instanceof CodexOwnerRecoveryUnavailable || error instanceof CodexWorkRecoveryRequired) this.owners.delete(projectId)
        throw error
      })
      this.owners.set(projectId, pending)
    }
    return pending.then(entry => projectId === null ? this.handoffGeneral(entry) : entry)
  }

  /** A selected seat is only a candidate. Native ownership changes under the
   * same host admission fence as complete retirement and acknowledged resume. */
  private async handoffGeneral(entry: { owner: CodexOwnerBootstrap; project: CodexOwnerProject }): Promise<typeof entry> {
    const raw = await this.general!()
    const target = { ...raw, cwd: realpathSync(raw.cwd), codexHome: realpathSync(raw.codexHome) }
    if (target.codexHome === entry.project.codexHome) {
      await this.revalidateProject(null, entry.project, target)
      return entry
    }
    if (!target.generalAuthorityPath || target.generalAuthorityPath !== entry.project.generalAuthorityPath
      || target.cwd !== entry.project.cwd || !target.credentialIdentity || target.credentialIdentity === entry.project.credentialIdentity) {
      throw new Error('General account transition requires distinct configured authority')
    }
    assertOwnerScope(target.codexHome, null)
    if (this.closed || this.refused.has(null)) throw new Error('Codex owner requires native reconciliation')
    if (this.retiring.has(null) || this.busy.has(null) || this.controls.isSwitching(null) || this.decodingBuilds.has(null)
      || this.builds.get(null)?.input || this.reviews.has(null) || this.reviewQueue.has(null) || this.buildObservations.has(null)) {
      throw new Error('General account transition requires idle host admission')
    }
    if (!entry.owner.retire) throw new Error('General account transition has no complete native retirement authority')
    this.retiring.add(null)
    let retirementAttempted = false
    try {
      await this.revalidateProject(null, entry.project)
      for (const home of [entry.project.codexHome, target.codexHome]) {
        if (durableOwnerPathExists(join(home, '.neutron-owner-work.json'))) throw new Error('General account transition has unresolved work')
      }
      const authority = readGeneralOwnerAuthority(target.generalAuthorityPath)
      if (!authority || authority.pending || authority.preparing) throw new Error('General account transition already reserved or unknown')
      const previous = locateDurableOwnerGeneration(entry.project.codexHome, entry.project.cwd, authority.rootDirectory)
      const facts = this.ownerFacts.get(entry.owner) ?? this.readBinding(entry.owner.binding)
      const vacancy = locateDurableOwnerGeneration(target.codexHome, target.cwd)
      if (['.neutron-owner-launch.json', '.neutron-owner-helper.json', '.neutron-owner-authority.json', '.neutron-owner-retiring.json']
        .some(file => durableOwnerPathExists(join(vacancy.stateDirectory, file)))) throw new Error('Target account has unresolved native ownership')
      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries(target.env)) {
        if (value !== undefined && !CODEX_CLI_AUTH_ENV_VARS.includes(key)) env[key] = value
      }
      env.CODEX_HOME = target.codexHome
      await probeCodexAccountViability({ binary: 'codex', cwd: target.cwd, codexHome: target.codexHome, env,
        credentialIdentity: target.credentialIdentity })
      await this.revalidateProject(null, entry.project)
      await this.revalidateProject(null, target, await this.general!())
      await refreshOwner(entry.owner)
      const preparation = prepareAccountHandoff(target.generalAuthorityPath,
        { projectId: null, cwd: entry.project.cwd, codexHome: entry.project.codexHome, credential: entry.project.credentialIdentity },
        { projectId: null, cwd: target.cwd, codexHome: target.codexHome, credential: target.credentialIdentity }, previous.stateDirectory, facts)
      retirementAttempted = true
      const outcome = entry.owner.recoverRetirement?.() ?? await entry.owner.retire(entry.owner.broker.state().epoch)
      if (outcome.status === 'busy') {
        // The authenticated busy reply and still-current original binding are
        // both needed; an unknown/lost reply can never release preparation.
        abortAccountHandoff(preparation, this.readBinding(entry.owner.binding))
        retirementAttempted = false
        throw new Error('General account transition has native work')
      }
      if (outcome.status !== 'retired' || !isDeepStrictEqual(outcome.receipt.facts, facts)) throw new Error('General account retirement is unproven')
      completeAccountHandoff(preparation)
      await this.installedMcp.get(null)?.close()
      this.installedMcp.delete(null)
      // Recheck the configured target after retirement, before native launch.
      await this.revalidateProject(null, target, await this.general!())
      const owner = await this.bootstrap({ projectId: null, binary: 'codex', socketPath: join(target.codexHome, 'owner.sock'),
        cwd: target.cwd, codexHome: target.codexHome, env, generalAuthorityPath: target.generalAuthorityPath })
      try {
        const successor = this.readBinding(owner.binding)
        const committed = readGeneralOwnerAuthority(target.generalAuthorityPath)
        if (!committed || committed.pending || committed.scope.codexHome !== target.codexHome
          || committed.scope.credential !== target.credentialIdentity || successor.threadId !== facts.threadId
          || successor.sessionId !== facts.sessionId || successor.credentialIdentity !== target.credentialIdentity) {
          throw new Error('General native successor acknowledgement is missing')
        }
        await refreshOwner(owner)
        if (owner.broker.state().phase !== 'idle' || this.closed) throw new Error('General native successor is not idle')
        this.ownerProjects.set(owner, null); this.ownerFacts.set(owner, successor)
      } catch (error) { await owner.close(); throw error }
      this.ownerProjects.delete(entry.owner); this.ownerFacts.delete(entry.owner)
      this.resolvedOwners.set(null, owner)
      const successor = { owner, project: target }
      this.owners.set(null, Promise.resolve(successor))
      this.conversationHosts.delete(null)
      return successor
    } catch (error) {
      // Durable preparation owns this uncertainty. No model input was dispatched;
      // do not invent a conversation-work marker in the retired account.
      if (retirementAttempted) this.refused.add(null)
      throw error
    } finally { this.retiring.delete(null) }
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.installedMcp.values()].map(surface => surface.close()))
    await Promise.allSettled([...this.owners.values()].map(async pending => { await (await pending).owner.close() }))
  }

  /** Exact native retirement authority for provider handoff and project sleep.
   * This never opens a cold conversation to make it eligible for retirement.
   */
  async retireScope(projectId: string | null): Promise<CodexOwnerRetirement | { status: 'absent' }> {
    if (this.closed || this.refused.has(projectId)) return { status: 'unknown', reason: 'Codex owner requires native reconciliation' }
    if (this.retiring.has(projectId) || this.busy.has(projectId) || this.controls.isSwitching(projectId)
      || this.decodingBuilds.has(projectId) || this.builds.get(projectId)?.input || this.reviews.has(projectId)
      || this.reviewQueue.has(projectId) || this.buildObservations.has(projectId)) {
      return { status: 'busy', reason: 'Codex owner has admitted work' }
    }
    if (!this.owners.has(projectId)) {
      this.retiring.add(projectId)
      try {
        const project = await this.scopeProject(projectId)
        assertOwnerScope(project.codexHome, projectId)
        const general = projectId === null && project.generalAuthorityPath ? readGeneralOwnerAuthority(project.generalAuthorityPath) : undefined
        const generation = locateDurableOwnerGeneration(project.codexHome, project.cwd, general?.rootDirectory)
        if (['.neutron-owner-launch.json', '.neutron-owner-helper.json', '.neutron-owner-authority.json', '.neutron-owner-retiring.json']
          .some(file => durableOwnerPathExists(join(generation.stateDirectory, file)))) {
          return { status: 'unknown', reason: 'Durable Codex owner requires attachment before retirement' }
        }
        if (this.owners.has(projectId)) return { status: 'busy', reason: 'Codex owner admission began before retirement inspection' }
        return { status: 'absent' }
      } catch (error) {
        return { status: 'unknown', reason: error instanceof Error ? error.message : 'Durable Codex owner presence is unknown' }
      } finally { this.retiring.delete(projectId) }
    }
    const owner = this.resolvedOwners.get(projectId)
    if (!owner) return { status: 'busy', reason: 'Codex owner admission is still pending' }
    if (!owner.retire) return { status: 'unknown', reason: 'Codex owner has no native retirement authority' }
    this.retiring.add(projectId)
    try {
      const entry = await this.owners.get(projectId)!
      await this.revalidateProject(projectId, entry.project)
      const facts = this.ownerFacts.get(owner) ?? this.readBinding(owner.binding)
      let outcome = owner.recoverRetirement?.()
      if (outcome === undefined) {
        await refreshOwner(owner)
        outcome = await owner.retire(owner.broker.state().epoch)
      }
      if (outcome.status !== 'retired') return outcome
      if (!isDeepStrictEqual(outcome.receipt.facts, facts)) return { status: 'unknown', reason: 'Codex retirement receipt names another owner' }
      await this.installedMcp.get(projectId)?.close()
      this.installedMcp.delete(projectId)
      this.owners.delete(projectId)
      this.resolvedOwners.delete(projectId)
      this.reviewReady.delete(projectId)
      this.cleanReviewRefusals.delete(projectId)
      this.builds.delete(projectId)
      this.ownerFacts.delete(owner)
      this.ownerProjects.delete(owner)
      return outcome
    } catch (error) {
      return { status: 'unknown', reason: error instanceof Error ? error.message : 'Codex retirement failed' }
    } finally { this.retiring.delete(projectId) }
  }

  async retireRevokedMcpServers(): Promise<void> {
    await Promise.all([...this.installedMcp.values()].map(surface => surface.retireRevoked()))
  }

  /** Boot admission is restricted to a previously awake owner. An explicit
   * completed retirement without a successor remains asleep. No turn is sent. */
  async recoverExisting(projectId: string | null): Promise<
    { status: 'adopted' | 'resumed' | 'skipped' } | { status: 'refused'; reason: string; retryable: boolean }
  > {
    let project: CodexOwnerProject
    try { project = await this.scopeProject(projectId) }
    catch { return { status: 'skipped' } }
    try {
      if (this.closed || this.refused.has(projectId)) throw new Error('Codex owner requires native reconciliation')
      if (this.retiring.has(projectId)) return { status: 'skipped' }
      const cached = this.resolvedOwners.get(projectId)
      if (cached) {
        await this.revalidateProject(projectId, (await this.owners.get(projectId)!).project, project)
        try {
          this.readBinding(cached.binding)
          await refreshOwner(cached)
          if (cached.broker.state().phase === 'closed') throw new Error('Codex owner frontend is closed')
          if (durableOwnerPathExists(join(project.codexHome, '.neutron-owner-work.json'))) {
            throw new CodexWorkRecoveryRequired('Codex interrupted host work requires native reconciliation')
          }
          return { status: 'adopted' }
        } catch (error) {
          // A detached idle frontend may be replaced; durable work and admitted
          // consumers never are. Native ownership is re-proved by openDurable.
          if (this.refused.has(projectId) || this.retiring.has(projectId) || this.busy.has(projectId)
            || this.controls.isSwitching(projectId) || this.decodingBuilds.has(projectId)
            || this.builds.get(projectId)?.input || this.reviews.has(projectId)
            || this.reviewQueue.has(projectId) || this.buildObservations.has(projectId)
            || durableOwnerPathExists(join(project.codexHome, '.neutron-owner-work.json'))) throw error
          this.retiring.add(projectId)
          try {
            await cached.close()
            await this.installedMcp.get(projectId)?.close()
            this.installedMcp.delete(projectId)
            this.owners.delete(projectId)
            this.resolvedOwners.delete(projectId)
            this.ownerFacts.delete(cached)
            this.ownerProjects.delete(cached)
            this.reviewReady.delete(projectId)
          } finally { this.retiring.delete(projectId) }
        }
      }
      const general = projectId === null && project.generalAuthorityPath ? readGeneralOwnerAuthority(project.generalAuthorityPath) : undefined
      const generation = locateDurableOwnerGeneration(project.codexHome, project.cwd, general?.rootDirectory)
      if (!durableOwnerPathExists(join(generation.stateDirectory, '.neutron-owner-launch.json'))
        && !(generation.resume && 'kind' in generation.resume.receipt && generation.resume.receipt.kind === 'crash')) {
        return { status: 'skipped' }
      }
      const { owner } = await this.resolve(projectId)
      return { status: owner.recoveryKind ?? 'adopted' }
    } catch (error) {
      const retryable = error instanceof CodexOwnerRecoveryUnavailable || error instanceof CodexWorkRecoveryRequired
      if (!retryable) this.refused.add(projectId)
      return { status: 'refused', reason: error instanceof Error ? error.message : 'Codex recovery evidence unavailable', retryable }
    }
  }

  async reconcile(projectIds: readonly (string | null)[]): Promise<void> {
    for (const projectId of projectIds) await this.recoverExisting(projectId)
  }

  private beginWork(owner: CodexOwnerBootstrap, bounded?: Pick<BoundedOwnerWork, 'projectId' | 'credentialIdentity' | 'request' | 'nativeRequest'>): string | undefined {
    if (!('refreshState' in owner)) return
    // Quarantine must remain durable even when a lost helper response closes its
    // live attestation. This is the already-attested home, never a new authority.
    const facts = this.ownerFacts.get(owner) ?? this.readBinding(owner.binding)
    const path = join(facts.codexHome, '.neutron-owner-work.json')
    if (bounded && existsSync(path)) throw new Error('Codex interrupted host work requires native reconciliation')
    if (!existsSync(path)) writeFileSync(path, JSON.stringify(bounded
      ? { version: 1, kind: 'bounded-work', ...bounded, facts, turnId: null, epoch: null }
      : { threadId: facts.threadId, bindingRevision: facts.bindingRevision }), { flag: 'wx', mode: 0o600 })
    return ownerWorkBytes(facts.codexHome)
  }

  /** Reconcile only the exact recorded generation and request. Native history
   * proves parent/child settlement; the worker still owns result validation. */
  private async inspectWork(projectId: string, project: CodexOwnerProject, request: BoundedWorkRequest,
    bytes: string, signal: AbortSignal): Promise<{ owner: CodexOwnerBootstrap; assertCurrent(): Promise<void> }> {
    const work = JSON.parse(bytes) as BoundedOwnerWork
    if (work?.version !== 1 || work.kind !== 'bounded-work' || work.projectId !== projectId
      || work.credentialIdentity !== project.credentialIdentity || !isDeepStrictEqual(work.request, request)
      || request.role === 'review' || request.role === 'synthesis' || typeof work.turnId !== 'string' || !work.turnId
      || !Number.isSafeInteger(work.epoch) || work.epoch! < 0) throw new Error('Codex work recovery identity is incomplete or mismatched')
    assertWorkProjection(projectId, project.cwd, request, work.nativeRequest)
    const { owner, project: boundProject } = await this.resolve(projectId, undefined, bytes)
    const assertCurrent = async () => {
      signal.throwIfAborted()
      await this.revalidateProject(projectId, boundProject)
      await refreshOwner(owner)
      const state = owner.broker.state()
      if (this.closed || this.retiring.has(projectId) || this.busy.has(projectId) || this.refused.has(projectId)
        || !isDeepStrictEqual(this.readBinding(owner.binding), work.facts)
        || state.phase !== 'idle' || state.unresolved !== null || state.activeTurnId !== null
        || state.epoch !== work.epoch || ownerWorkBytes(project.codexHome) !== bytes) {
        throw new Error('Codex work recovery authority changed or remains unresolved')
      }
    }
    await assertCurrent()
    const gateway = owner.broker.gateway(`work-recovery-${++this.sequence}`)
    try {
      let cursor: string | null = null
      const cursors = new Set<string>(), turns = new Set<string>(), children = new Set<string>()
      let lastTurn: string | undefined
      for (let page = 0; page < 1000; page++) {
        const response = await gateway.request('thread/turns/list', { threadId: work.facts.threadId,
          itemsView: 'full', sortDirection: 'asc', cursor, limit: 100 }) as { data?: unknown[]; nextCursor?: unknown }
        await assertCurrent()
        if (!Array.isArray(response?.data) || !(response.nextCursor === null || typeof response.nextCursor === 'string')) throw new Error('Codex work recovery history is incomplete')
        for (const raw of response.data) {
          const turn = raw as { id?: unknown; status?: unknown; itemsView?: unknown; items?: unknown[] }
          if (!turn || typeof turn.id !== 'string' || !turn.id || turns.has(turn.id)
            || turn.itemsView !== 'full' || !Array.isArray(turn.items)
            || !['completed', 'interrupted', 'failed'].includes(String(turn.status))) throw new Error('Codex work recovery turn is unresolved')
          turns.add(turn.id); lastTurn = turn.id
          if (turn.id === work.turnId && turn.status !== 'completed') throw new Error('Codex work recovery parent did not complete')
          for (const rawItem of turn.items) {
            const item = rawItem as Record<string, unknown>
            if (!item || typeof item !== 'object') throw new Error('Codex work recovery child evidence is malformed')
            if (item.type !== 'subAgentActivity') continue
            if (typeof item.agentThreadId !== 'string' || !item.agentThreadId
              || typeof item.agentPath !== 'string' || !item.agentPath) throw new Error('Codex work recovery child identity is incomplete')
            const key = JSON.stringify([turn.id, item.agentThreadId, item.agentPath])
            if (item.kind === 'started' && !children.has(key)) children.add(key)
            else if (item.kind === 'completed' && children.delete(key)) { /* Native paired child settlement. */ }
            else throw new Error('Codex work recovery child lifecycle is unresolved')
          }
        }
        if (response.nextCursor === null) {
          if (lastTurn !== work.turnId || children.size) throw new Error('Codex work recovery lacks exact settled native work')
          return { owner, assertCurrent }
        }
        if (!response.nextCursor || cursors.has(response.nextCursor)) throw new Error('Codex work recovery history cursor repeated')
        cursor = response.nextCursor; cursors.add(cursor)
      }
      throw new Error('Codex work recovery history exceeded its bound')
    } finally { gateway.close() }
  }

  private finishWork(projectId: string | null, owner: CodexOwnerBootstrap): void {
    if (!('refreshState' in owner) || this.refused.has(projectId)) return
    const path = join(this.readBinding(owner.binding).codexHome, '.neutron-owner-work.json')
    if (existsSync(path)) unlinkSync(path)
  }

  private fence(projectId: string | null): void {
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
    const execute = (recovery: boolean): WorkerRunner['run'] => async (request, placement, signal) => {
      if (this.retiring.has(projectId)) return { kind: 'unknown', detail: 'Codex owner is retiring' }
      if (recovery && !worker.recover) return { kind: 'unknown', detail: 'Codex worker has no recovery capability' }
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
      const observation = { attempted: false, terminal: false, closed: false, request: structuredClone(request) }
      this.buildObservations.set(projectId, observation)
      try {
        // A canonical ARMED reservation can resume without an acting turn. Check
        // host authority here too; a trailer never reconciles uncertain owner work.
        let project: CodexOwnerProject
        const admissionTimer = new AbortController()
        try {
          project = await Promise.race([
            this.scopeProject(projectId),
            delay(request.budget.wall_ms, undefined, { signal: AbortSignal.any([signal, admissionTimer.signal]) })
              .then(() => { throw new Error('Owner admission expired') }),
          ])
        } catch { return { kind: 'unknown', detail: 'Owner authority was unavailable before dispatch' } }
        finally { admissionTimer.abort() }
        if (this.retiring.has(projectId) || this.closed || this.refused.has(projectId)) return { kind: 'unknown', detail: 'Codex owner requires native reconciliation' }
        if (this.busy.has(projectId)) return { kind: 'unknown', detail: 'Codex owner has an active host turn' }
        if (existsSync(join(project.codexHome, '.neutron-owner-work.json'))) {
          if (recovery) {
            const timer = new AbortController()
            const stopped = AbortSignal.any([signal, timer.signal])
            try {
              const bytes = ownerWorkBytes(project.codexHome)
              return await Promise.race([
                (async () => {
                  const proof = await this.inspectWork(projectId, project, request, bytes, stopped)
                  const outcome = await worker.recover!(request, placement, stopped)
                  await proof.assertCurrent()
                  if (outcome.kind !== 'completed' && outcome.kind !== 'blocked') return outcome
                  // No await between the final byte comparison and removal. A
                  // replacement marker is never this request's to settle.
                  stopped.throwIfAborted()
                  if (ownerWorkBytes(project.codexHome) !== bytes) throw new Error('Codex work recovery marker was replaced')
                  unlinkSync(join(project.codexHome, '.neutron-owner-work.json'))
                  return outcome
                })(),
                delay(Math.max(1, deadline - Date.now()), undefined, { signal: stopped })
                  .then(() => { throw new Error('Codex work recovery budget expired') }),
              ])
            } catch { return { kind: 'unknown', detail: 'Codex interrupted host work requires exact native reconciliation' } }
            finally { timer.abort() }
          }
          this.refused.add(projectId)
          return { kind: 'unknown', detail: 'Codex interrupted host work requires native reconciliation' }
        }
        const owner = this.resolvedOwners.get(projectId)
        if (!owner && existsSync(join(project.codexHome, '.neutron-owner-launch.json'))) {
          return { kind: 'unknown', detail: 'Existing Codex owner must be reattached before build admission' }
        }
        if (owner) {
          const cached = await this.owners.get(projectId)
          if (!cached) return { kind: 'unknown', detail: 'Codex owner project authority is unavailable' }
          try { await this.revalidateProject(projectId, cached.project, project) }
          catch { return { kind: 'unknown', detail: 'Codex owner project credential identity changed' } }
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
        const outcome = await (recovery ? worker.recover!(request, placement, signal) : worker.run(request, placement, signal))
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
    }
    const queued = (operation: WorkerRunner['run']): WorkerRunner['run'] => async (request, placement, signal) => {
      if (request.role !== 'review' && request.role !== 'synthesis') return operation(request, placement, signal)
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
        return await operation(request, placement, stopped)
      } catch { return { kind: 'unknown', detail: 'Restricted review queue or execution was interrupted' } }
      finally { timer.abort(); release(); if (this.reviewQueue.get(projectId) === tail) this.reviewQueue.delete(projectId) }
    }
    return { ...worker, supports, run: queued(execute(false)), recover: queued(execute(true)) }
  }

  start(projectId: string | undefined, spec: AgentSpec): SessionHandle {
    return this.startTurn(projectId ?? null, spec)
  }

  /** Readiness attests the existing owner capability; it does not grant permissions. */
  async prepareReview(projectId: string): Promise<void> {
    const { owner } = await this.resolve(projectId)
    if (!owner.broker.reviewPermissions) throw new Error('Codex owner lacks attested read-only child execution with isolated result output')
    this.reviewReady.add(projectId)
  }

  private startTurn(projectId: string | null, spec: AgentSpec, buildDispatch = false): SessionHandle {
    const abort = new AbortController()
    let inner: SessionHandle | undefined
    const events = (async function* (bindings: CodexOwnerBindings) {
      try {
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
          projectId, isLive: () => !this.retiring.has(projectId) && !this.refused.has(projectId) && owner.broker.state().phase === 'idle',
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
