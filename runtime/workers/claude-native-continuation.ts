import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import type { BoundedWorkOutcome, BoundedWorkRequest } from '../bounded-work.ts'
import type { ReplSession } from '../adapters/claude-code/persistent/repl-session.ts'
import { sessionJsonlPath } from '../adapters/claude-code/persistent/jsonl-resumability.ts'
import { readNativeParentLaunchEvidence, type NativeParentLaunchEvidence } from '../adapters/claude-code/persistent/native-parent-launch-evidence.ts'
import { isProcessIdentity, readProcessIdentity } from '../adapters/claude-code/persistent/process-identity.ts'
import { claudeComposerEmpty } from './claude-composer.ts'
import { SUBAGENT_CONTINUATION_TOOL_NAME } from './claude-tool-contract.ts'
import { verifyNativeDispatchChildBound, type NativeDispatchLease, type SignedNativeDispatchRecord } from './claude-native-dispatch-receipt.ts'
import { readArmedTrailerReservation } from './trailer-slot.ts'
import type { ProjectTrailerOutcome } from './project-runners.ts'
import { bindNativeChildWorkspace, nativeChildContinuationCensusKnown, ownsNativeChildWorkspace, type NativeChildWorkspace } from './native-child-workspace.ts'
import { acquireClaudeCapacity, controlClaudeContinuation, nativeQuotaEpisodeId, nativeRelayScopeCurrent,
  type AcquireClaudeCapacity, type ClaudeCapacityInput, type ClaudeCapacityReceipt, type ClaudeContinuationIntent, type ControlClaudeContinuation } from './claude-capacity-client.ts'

export type NativeTranscriptBoundary = { offset: number; dev: number; ino: number; prefixDigest: string }
type Boundary = NativeTranscriptBoundary
interface Preparation {
  version: 2
  request: BoundedWorkRequest
  lease: NativeDispatchLease
  receiptSignature: string
  sessionId: string
  childGeneration: string
  agentId: string
  quota: { requestId: string; digest: string }
  nonce: string
  args: { to: string; message: string }
  boundary: Boundary
  capacity: ClaudeCapacityReceipt
  intent: ClaudeContinuationIntent
}
export type ClaudeContinuationOutcome = { kind: 'result'; outcome: BoundedWorkOutcome }
  | { kind: 'not-eligible' }
  | { kind: 'submitted'; evidence: 'terminal-acknowledgement' | 'exact-tool-invocation' }
  | { kind: 'unknown'; reason: 'tool-unavailable' | 'launch-unknown' | 'identity-unknown' | 'submission-unknown' | 'budget-expired' | 'capacity-unavailable' | 'capacity-waiting' }
export type ClaudeQuotaState = { kind: 'waiting'; childId: string; retryAtMs: number | null; episodeId: string }
  | { kind: 'resumed' | 'ended'; childId: string; episodeId?: string }

export interface ClaudeContinuationOptions {
  request: BoundedWorkRequest
  receipt: unknown
  authority: { lease: NativeDispatchLease; current(): boolean; read(): string | undefined; claim(episodeId: string, preparation: string): Promise<boolean> }
  stateDir: string
  session: Pick<ReplSession, 'sessionId' | 'childGeneration' | 'cwd' | 'child' | 'toolSurface' | 'acquireContinuationTurn' | 'hasChildExited'>
  workspace: NativeChildWorkspace
  projectsDir?: string
  deadline: number
  signal: AbortSignal
  decodeTrailer(bytes: string, request: BoundedWorkRequest): ProjectTrailerOutcome
  capacity?: { acquire?: AcquireClaudeCapacity; control?: ControlClaudeContinuation }
  onQuotaState?(state: ClaudeQuotaState): Promise<void>
}

const message = (nonce: string) => `Continue the original bounded task with its original request, brief, worktree and result contract. Preserve completed work and write the original result. Continuation receipt: ${nonce}`
const cancellationWatches = new WeakMap<AbortSignal, Map<string, () => void>>()

/** Work cancellation outlives one observation call. It tombstones the newest
 * immutable intent; it never revokes unrelated work in the same parent. */
function watchCancellation(options: ClaudeContinuationOptions, workSignal: AbortSignal, common: ClaudeCapacityInput,
  control: ControlClaudeContinuation): () => void {
  let watched = cancellationWatches.get(workSignal)
  if (!watched) { watched = new Map(); cancellationWatches.set(workSignal, watched) }
  const existing = watched.get(common.leaseId)
  if (existing) return existing
  const cancel = () => {
    clearTimeout(expiry); workSignal.removeEventListener('abort', cancel)
    try {
      const raw = options.authority.read()
      if (!raw) return
      const saved: Preparation = JSON.parse(raw)
      if (saved.version !== 2 || !isDeepStrictEqual(saved.request, options.request)
        || !isDeepStrictEqual(saved.lease, options.authority.lease)
        || saved.receiptSignature !== (options.receipt as SignedNativeDispatchRecord).signature) return
      // The work signal is already aborted; cancellation has a separate bounded
      // control exchange and cannot enable any model request.
      fireAndForget('claude-native-continuation.cancel', control({ ...common, ...saved.intent, action: 'cancel', signal: AbortSignal.timeout(1000), deadline: Date.now() + 1000 }))
    } catch { /* A missing cancellation acknowledgement grants no new input. */ }
  }
  const expiry = setTimeout(cancel, Math.max(1, common.deadlineMs - Date.now()))
  expiry.unref()
  watched.set(common.leaseId, cancel)
  workSignal.addEventListener('abort', cancel, { once: true })
  if (workSignal.aborted) cancel()
  return cancel
}

/** Launch-input compatibility pin, NOT a served catalog or account witness.
 * Upgrading this profile requires the same native continuation controls. */
export const CLAUDE_CONTINUATION_PROFILE = Object.freeze({ version: '2.1.285',
  sha256: '33dad1ec615a2e08cc78b494f05c110e49916de2c79d78ec8799ebf46b233d29' })

export function knownLaunch(launch: NativeParentLaunchEvidence | undefined, sessionId: string, generation: string, projectId: string | null): boolean {
  if (!launch || launch.version !== 1 || launch.sessionId !== sessionId || launch.childGeneration !== generation
    || !projectId || launch.projectId !== projectId || launch.executable?.version !== CLAUDE_CONTINUATION_PROFILE.version
    || launch.executable.sha256 !== CLAUDE_CONTINUATION_PROFILE.sha256 || !launch.executable.realPath
    || !Array.isArray(launch.argv) || typeof launch.argv[0] !== 'string' || !launch.argv[0] || !Array.isArray(launch.tools)) return false
  const grants = launch.argv.flatMap((arg, index) => arg === '--tools' ? [launch.argv[index + 1]] : [])
  const sessions = launch.argv.flatMap((arg, index) => arg === '--session-id' || arg === '--resume' ? [launch.argv[index + 1]] : [])
  return grants.length === 1 && typeof grants[0] === 'string' && isDeepStrictEqual(grants[0].split(','), launch.tools)
    && sessions.length === 1 && sessions[0] === sessionId && launch.tools.includes('Agent') && launch.tools.includes(SUBAGENT_CONTINUATION_TOOL_NAME)
}

/** Results can be worker-written: a FIFO, link or changing snapshot is unknown. */
export async function readClaudeContinuationResult(options: Pick<ClaudeContinuationOptions, 'request' | 'decodeTrailer'>): Promise<ClaudeContinuationOutcome | undefined> {
  const unknown: ClaudeContinuationOutcome = { kind: 'unknown', reason: 'identity-unknown' }
  try {
    const file = await open(options.request.result.path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    try {
      const before = await file.stat()
      if (!before.isFile() || before.size > 16 * 1024 * 1024) return unknown
      const bytes = Buffer.alloc(before.size)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      const after = await file.stat()
      if (bytesRead !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return unknown
      const outcome = options.decodeTrailer(bytes.toString('utf8'), options.request)
      return outcome.kind === 'not-current-step' ? undefined : { kind: 'result', outcome }
    } finally { await file.close() }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : unknown
  }
}

/** One continuation of an authenticated native child. This NEVER invokes Agent,
 * grants capacity, changes credentials, releases admission or validates a result
 * differently. A claim surviving any interruption permanently forbids resending. */
export async function continueClaudeNativeChild(options: ClaudeContinuationOptions): Promise<ClaudeContinuationOutcome> {
  // A restarted observer may receive an already-cancelled work signal. Restoring
  // cancellation of a signed spent intent grants no model-input authority.
  try {
    const receipt = options.receipt as SignedNativeDispatchRecord, relay = receipt.body.parent?.launch?.relay
    if (relay && Number.isSafeInteger(receipt.body.deadlineMs) && options.authority.read() !== undefined
      && verifyNativeDispatchChildBound(receipt, options.request, options.authority.lease)) {
      watchCancellation(options, options.signal, { request: options.request, leaseId: options.authority.lease.token,
        childId: receipt.body.nativeAgentId!, relay, eventDigest: createHash('sha256').update(receipt.signature).digest('hex'),
        deadlineMs: receipt.body.deadlineMs!, budgetDigest: createHash('sha256').update(JSON.stringify(options.request.budget)).digest('hex'),
        fenceDigest: createHash('sha256').update(JSON.stringify(options.authority.lease)).digest('hex'),
        signal: options.signal, deadline: options.deadline }, options.capacity?.control ?? controlClaudeContinuation)
    }
  } catch { /* Malformed retained evidence cannot authorize a cancellation. */ }
  const timer = new AbortController()
  const signal = AbortSignal.any([options.signal, timer.signal])
  let onAbort!: () => void
  const cancelled = new Promise<ClaudeContinuationOutcome>(resolve => {
    onAbort = () => resolve({ kind: 'unknown', reason: 'budget-expired' })
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  const timeout = setTimeout(() => timer.abort(), Math.max(1, options.deadline - Date.now()))
  let waitingChild: string | undefined
  let waitingEpisode: string | undefined
  const promotedEpisodes = new Set<string>()
  const onQuotaState = async (state: ClaudeQuotaState) => {
    if (state.kind === 'resumed' && state.episodeId) {
      if (promotedEpisodes.has(state.episodeId)) return
      promotedEpisodes.add(state.episodeId)
    }
    await options.onQuotaState?.(state)
  }
  const run = async (): Promise<ClaudeContinuationOutcome> => {
    while (!signal.aborted && Date.now() < options.deadline) {
      const outcome = await continuationAttempt({ ...options, signal, onQuotaState }, options.signal)
      if (outcome.kind !== 'waiting') {
        if (waitingChild) {
          // Acknowledging parent input leaves the durable wait visible while
          // HTTP is quarantined. Only verified promotion (below) resumes it.
          if (outcome.kind !== 'submitted') await options.onQuotaState?.({ kind: outcome.kind === 'result' ? 'resumed' : 'ended', childId: waitingChild,
            ...(outcome.kind === 'result' || !waitingEpisode ? {} : { episodeId: waitingEpisode }) })
          waitingChild = undefined
        }
        return outcome
      }
      waitingChild = outcome.childId
      waitingEpisode = outcome.episodeId
      await options.onQuotaState?.(outcome)
      // Retry hints inform capacity cadence (at most once per second, at least
      // every 30 seconds to observe newly authorized accounts). Result harvesting
      // continues each second and never holds the parent's input slot while idle.
      const nextProbe = Math.min(options.deadline, outcome.deadline, Date.now() + Math.max(1000, Math.min(30_000,
        outcome.retryAtMs === null ? 5000 : outcome.retryAtMs - Date.now())))
      while (!signal.aborted && Date.now() < nextProbe) {
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
          const timer = setTimeout(finish, Math.max(1, Math.min(1000, nextProbe - Date.now())))
          signal.addEventListener('abort', finish, { once: true })
          if (signal.aborted) finish()
        })
        if (signal.aborted) return { kind: 'unknown', reason: 'budget-expired' }
        const harvested = await readClaudeContinuationResult(options)
        if (harvested) {
          await options.onQuotaState?.({ kind: harvested.kind === 'result' ? 'resumed' : 'ended', childId: waitingChild })
          waitingChild = undefined
          return harvested
        }
        const parent = (options.receipt as SignedNativeDispatchRecord).body.parent
        if (!options.authority.current() || options.session.hasChildExited() || !parent?.launch?.relay
          || !nativeRelayScopeCurrent(parent.launch.relay) || parent.pid !== options.session.child.pid
          || parent.sessionId !== options.session.sessionId) return { kind: 'unknown', reason: 'capacity-unavailable' }
      }
    }
    return { kind: 'unknown', reason: 'budget-expired' }
  }
  try { return await Promise.race([run(), cancelled]) }
  catch { return { kind: 'unknown', reason: 'submission-unknown' } }
  finally {
    clearTimeout(timeout); timer.abort(); signal.removeEventListener('abort', onAbort)
    if (waitingChild) {
      const childId = waitingChild; waitingChild = undefined
      try { await options.onQuotaState?.({ kind: 'ended', childId, ...(waitingEpisode ? { episodeId: waitingEpisode } : {}) }) } catch { /* Waiting stays visible when its durable writer is unavailable. */ }
    }
  }
}

async function continuationAttempt(options: ClaudeContinuationOptions, workSignal: AbortSignal): Promise<ClaudeContinuationOutcome | { kind: 'waiting'; childId: string; retryAtMs: number | null; deadline: number; episodeId: string }> {
  const { request, session, authority, signal } = options
  const unknown = (reason: Extract<ClaudeContinuationOutcome, { kind: 'unknown' }>['reason']): ClaudeContinuationOutcome => ({ kind: 'unknown', reason })
  const expired = () => signal.aborted || Date.now() >= options.deadline || session.hasChildExited()
  const result = () => readClaudeContinuationResult(options)
  try {
    // The original armed identity is required even for a late result.
    const key = createHash('sha256').update(JSON.stringify([request.run_id, request.step_id])).digest('hex')
    if ((await readArmedTrailerReservation(join(options.stateDir, `claude-step-${key}.json`), JSON.stringify(request), { signal, deadline: options.deadline })).kind !== 'resume') return unknown('identity-unknown')
    const completed = await result()
    if (completed) return completed
    if (expired()) return unknown('budget-expired')
    if (!verifyNativeDispatchChildBound(options.receipt, request, authority.lease)) return unknown('identity-unknown')
    const receipt = options.receipt as SignedNativeDispatchRecord
    if (!Number.isSafeInteger(receipt.body.deadlineMs)) return unknown('budget-expired')
    options.deadline = Math.min(options.deadline, receipt.body.deadlineMs!)
    if (expired()) return unknown('budget-expired')
    const agentId = receipt.body.nativeAgentId!
    if (receipt.body.parent?.sessionId !== session.sessionId || !/^[A-Za-z0-9_-]+$/.test(agentId)
      || !ownsNativeChildWorkspace(options.workspace, session, request) || !nativeChildContinuationCensusKnown(options.workspace)) return unknown('identity-unknown')
    const transcript = sessionJsonlPath(session.sessionId, session.cwd, options.projectsDir)
    const existing = authority.read()
    const saved: Preparation | undefined = existing === undefined ? undefined : JSON.parse(existing)
    if (saved) {
      if (!Number.isSafeInteger(saved.intent?.deadlineMs)) return unknown('identity-unknown')
      // Retain the original deadline across successor claims and gateway restart.
      options.deadline = Math.min(options.deadline, saved.intent.deadlineMs)
      if (expired()) return unknown('budget-expired')
      if (saved.version !== 2 || !isDeepStrictEqual(saved.request, request) || !isDeepStrictEqual(saved.lease, authority.lease)
        || saved.receiptSignature !== receipt.signature || saved.sessionId !== session.sessionId || saved.agentId !== agentId
        || !saved.nonce || !isDeepStrictEqual(saved.args, { to: agentId, message: message(saved.nonce) })
        || saved.intent.hostMessage !== saved.args.message || saved.intent.intentId !== saved.nonce || saved.intent.deadlineMs !== receipt.body.deadlineMs
        || saved.intent.budgetDigest !== createHash('sha256').update(JSON.stringify(request.budget)).digest('hex')
        || saved.intent.fenceDigest !== createHash('sha256').update(JSON.stringify(authority.lease)).digest('hex')) return unknown('identity-unknown')
    }
    const arrived = await result()
    if (arrived) return arrived
    if (!session.toolSurface.split(',').includes(SUBAGENT_CONTINUATION_TOOL_NAME)) return unknown('tool-unavailable')
    const parent = receipt.body.parent!
    if (!knownLaunch(parent.launch, parent.sessionId, parent.childGeneration, authority.lease.scope.projectId)) return unknown('launch-unknown')
    const exactSurvivor = () => parent.sessionId === session.sessionId && parent.pid === session.child.pid
      && isProcessIdentity(parent.processIdentity) && isDeepStrictEqual(readProcessIdentity(session.child.pid), parent.processIdentity)
    const currentParentKnown = () => {
      const currentLaunch = readNativeParentLaunchEvidence(session)
      return session.toolSurface.split(',').includes(SUBAGENT_CONTINUATION_TOOL_NAME) && (currentLaunch
        ? knownLaunch(currentLaunch, session.sessionId, session.childGeneration, authority.lease.scope.projectId)
        : parent.pid === session.child.pid && isProcessIdentity(parent.processIdentity)
          && isDeepStrictEqual(readProcessIdentity(session.child.pid), parent.processIdentity))
    }
    if (!currentParentKnown()) return unknown('launch-unknown')
    if (!session.child.submitLine || expired()) return unknown('budget-expired')
    // Original authority must still be live before it can bind reconstructed
    // workspace ownership or enter the parent queue.
    const relay = parent.launch?.relay
    const auth = { current: () => authority.current() && exactSurvivor() && !!relay && nativeRelayScopeCurrent(relay)
      && relay.registration.body.parentSessionId === session.sessionId && relay.registration.body.parentPid === session.child.pid }
    if (!relay || !auth.current()) return unknown('capacity-unavailable')
    // The verified original dispatch above also binds a reconstructed local
    // workspace. This authorizes compatible-peer queue admission, not new work.
    bindNativeChildWorkspace(options.workspace)
    // Native workspace authorization passes only this admitted child through the
    // session's serialization. Recheck after queue acquisition and before input.
    const release = await session.acquireContinuationTurn(options.workspace, signal)
    try {
      if (expired()) return unknown('budget-expired')
      const completed = await result()
      if (completed) return completed
      if (!ownsNativeChildWorkspace(options.workspace, session, request) || !nativeChildContinuationCensusKnown(options.workspace)) return unknown('identity-unknown')
      if (!currentParentKnown()) return unknown('launch-unknown')
      // The original signed scope survives a gateway restart, never a parent
      // replacement. Account and model facts come only from native HTTP at the host.
      if (!auth.current()) return unknown('capacity-unavailable')
      const common = { request, leaseId: authority.lease.token, relay, childId: agentId,
        eventDigest: createHash('sha256').update(receipt.signature).digest('hex'), signal, deadline: options.deadline,
        deadlineMs: receipt.body.deadlineMs!, budgetDigest: createHash('sha256').update(JSON.stringify(request.budget)).digest('hex'),
        fenceDigest: createHash('sha256').update(JSON.stringify(authority.lease)).digest('hex') }
      const control = options.capacity?.control ?? controlClaudeContinuation
      if (saved) watchCancellation(options, workSignal, common, control)
      const toolUseId = saved ? await exactInvocation(transcript, saved) : undefined
      if (saved && (!toolUseId || expired() || !auth.current()
        || !await control({ ...common, ...saved.intent, action: 'promote', toolUseId, resumedAgentId: agentId })
        || expired() || !auth.current())) return unknown('submission-unknown')
      if (saved) await options.onQuotaState?.({ kind: 'resumed', childId: agentId, episodeId: saved.intent.episodeId })
      const afterPromotion = await result()
      if (afterPromotion) return afterPromotion
      const capacity = await (options.capacity?.acquire ?? acquireClaudeCapacity)(common)
      // A reconciled send can now run; absent a later authenticated quota there is
      // no successor input to spend, only passive original-result observation.
      if (saved && capacity.kind === 'unknown') return { kind: 'submitted', evidence: 'exact-tool-invocation' }
      if (capacity.kind !== 'unknown') {
        const observed = capacity.receipt.body.observations.at(-1)!
        const expectedEpisode = nativeQuotaEpisodeId(authority.lease.token, common.eventDigest, toolUseId ?? null)
        if (saved && observed.episodeId === saved.intent.episodeId) {
          if (capacity.kind === 'available') capacity.release()
          return { kind: 'submitted', evidence: 'exact-tool-invocation' }
        }
        if (observed.episodeId !== expectedEpisode || observed.predecessorToolUseId !== (toolUseId ?? null)
          || observed.intentId !== (saved?.nonce ?? null)) {
          if (capacity.kind === 'available') capacity.release()
          return unknown('identity-unknown')
        }
      }
      if (capacity.kind !== 'available') return capacity.kind === 'waiting'
        ? { kind: 'waiting', childId: agentId, retryAtMs: capacity.receipt.body.capacity.retryAtMs, deadline: options.deadline,
          episodeId: capacity.receipt.body.observations.at(-1)!.episodeId } : unknown('capacity-unavailable')
      try {
      const afterCapacity = await result()
      if (afterCapacity) return afterCapacity
      if (!auth.current() || !capacity.current()) return unknown('capacity-unavailable')
      const observed = capacity.receipt.body.observations.at(-1)!
      const quota = { requestId: observed.bodyDigest, digest: createHash('sha256').update(JSON.stringify(observed)).digest('hex') }
      const boundary = await readBoundary(transcript)
      if (!boundary) return unknown('submission-unknown')
      const nonce = randomUUID()
      const args = { to: agentId, message: message(nonce) }
      const intent: ClaudeContinuationIntent = { episodeId: observed.episodeId, intentId: nonce, hostMessage: args.message,
        deadlineMs: common.deadlineMs, budgetDigest: common.budgetDigest, fenceDigest: common.fenceDigest }
      const preparation: Preparation = { version: 2, request, lease: authority.lease, receiptSignature: receipt.signature,
        sessionId: session.sessionId, childGeneration: session.childGeneration, agentId, quota, nonce, args, boundary, capacity: capacity.receipt, intent }
      const line = `Invoke ${SUBAGENT_CONTINUATION_TOOL_NAME} exactly once with these JSON arguments, then end this parent turn: ${JSON.stringify(args)}`
      const before = async () => {
        if (expired() || !currentParentKnown() || !auth.current() || !capacity.current()) throw new Error('Continuation budget, capacity or parent identity unavailable')
        if (session.child.paneHandle !== undefined && (!session.child.readScreen || !claudeComposerEmpty(await session.child.readScreen()))) throw new Error('Composer unavailable')
        // Commit before Enter. Failure, timeout or restart never refunds this claim.
        if (expired() || !auth.current() || !capacity.current() || !await authority.claim(intent.episodeId, JSON.stringify(preparation))
          || expired() || !auth.current() || !capacity.current()) throw new Error('Continuation already claimed, fenced or expired')
        const cancel = watchCancellation(options, workSignal, common, control)
        if (!await control({ ...common, ...intent, action: 'prepare' }) || expired() || !auth.current() || !capacity.current()) {
          cancel()
          throw new Error('Continuation intent unavailable')
        }
      }
      const timeout = AbortSignal.timeout(Math.max(1, options.deadline - Date.now()))
      const stopped = AbortSignal.any([signal, timeout])
      if (session.child.paneHandle !== undefined) {
        if (!session.child.submitLineGuarded) return unknown('submission-unknown')
        await session.child.submitLineGuarded(line, before, stopped)
      } else { await before(); await session.child.submitLine(line, stopped) }
      return { kind: 'submitted', evidence: 'terminal-acknowledgement' }
      } finally { capacity.release() }
    } finally { release() }
  } catch { return unknown('submission-unknown') }
}

export async function readBoundary(path: string): Promise<Boundary | undefined> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile()) return undefined
    const prefixDigest = await digestPrefix(file, info.size)
    const after = await file.stat()
    return prefixDigest && info.size === after.size && info.mtimeMs === after.mtimeMs && info.ctimeMs === after.ctimeMs
      ? { offset: info.size, dev: info.dev, ino: info.ino, prefixDigest } : undefined
  } finally { await file.close() }
}

/** Bounded snapshot hashing: refuse oversized histories rather than use a weak
 * inode/offset boundary that accepts same-inode truncation followed by regrowth. */
export async function digestPrefix(file: FileHandle, size: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(size) || size < 0 || size > 64 * 1024 * 1024) return undefined
  const digest = createHash('sha256'), bytes = Buffer.alloc(64 * 1024)
  for (let offset = 0; offset < size;) {
    const length = Math.min(bytes.length, size - offset)
    const { bytesRead } = await file.read(bytes, 0, length, offset)
    if (bytesRead !== length) return undefined
    digest.update(bytes.subarray(0, length))
    offset += length
  }
  return digest.digest('hex')
}

/** The pinned native tool retains exact arguments and adds presentation fields.
 * Decorations never replace the full recipient/message authority. */
function exactNativeMessageInput(input: unknown, args: Preparation['args']): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const value = input as Record<string, unknown>, keys = Object.keys(value).sort().join(',')
  if (value.to !== args.to || value.message !== args.message) return false
  if (keys === 'message,to') return true
  if (keys !== 'content,message,recipient,to,type' || value.type !== 'message' || value.recipient !== args.to
    || typeof value.content !== 'string') return false
  // Pinned native evidence covers this host's long ASCII continuation template;
  // do not generalize its preview transform to short or Unicode messages.
  return /^[\x20-\x7e]+$/.test(args.message) && args.message.length > 49
    && value.content === args.message.slice(0, 49) + '…'
}

/** Parent text, tool-name mentions and another recipient are not consumption. */
async function exactInvocation(path: string, saved: Preparation): Promise<string | undefined> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    const boundary = saved.boundary
    if (!info.isFile() || !Number.isSafeInteger(boundary.offset) || boundary.offset < 0
      || info.dev !== boundary.dev || info.ino !== boundary.ino || info.size < boundary.offset || info.size - boundary.offset > 4 * 1024 * 1024) return undefined
    if (typeof boundary.prefixDigest !== 'string' || await digestPrefix(file, boundary.offset) !== boundary.prefixDigest) return undefined
    const bytes = Buffer.alloc(info.size - boundary.offset)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, boundary.offset)
    const after = await file.stat()
    if (bytesRead !== bytes.length || info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) return undefined
    const text = bytes.toString('utf8')
    const matches: string[] = []
    const results: { id: string; valid: boolean }[] = []
    for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n')) {
      if (!line) continue
      const row = JSON.parse(line)
      if (row.sessionId !== saved.sessionId || !Array.isArray(row.message?.content)) continue
      if (row.type === 'user' && row.message.role === 'user') {
        for (const block of row.message.content) {
          if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
          const content = block.content
          let result: unknown
          try { result = JSON.parse(typeof content === 'string' ? content : content.length === 1 && content[0].type === 'text' ? content[0].text : '') } catch { /* Invalid native result. */ }
          results.push({ id: block.tool_use_id, valid: block.is_error !== true && matches.includes(block.tool_use_id)
            && !!result && typeof result === 'object' && (result as { success?: unknown }).success === true
            && (result as { resumedAgentId?: unknown }).resumedAgentId === saved.agentId
            && row.toolUseResult?.success === true && row.toolUseResult.resumedAgentId === saved.agentId })
        }
        continue
      }
      if (row.type !== 'assistant' || row.message.role !== 'assistant') continue
      for (const block of row.message.content) {
        // A copied receipt nonce with altered recipient or message is a
        // conflicting actuation, not unrelated conversation to skip past.
        if (block.type === 'tool_use' && block.name === SUBAGENT_CONTINUATION_TOOL_NAME
          && typeof block.input?.message === 'string' && block.input.message.includes(saved.nonce)
          && !exactNativeMessageInput(block.input, saved.args)) return undefined
        if (block.type === 'tool_use' && block.name === SUBAGENT_CONTINUATION_TOOL_NAME
          && typeof block.id === 'string' && exactNativeMessageInput(block.input, saved.args)) matches.push(block.id)
      }
    }
    const ids = [...new Set(matches)], linked = results.filter(result => result.id === ids[0])
    return ids.length === 1 && linked.length > 0 && linked.every(result => result.valid) ? ids[0] : undefined
  } finally { await file.close() }
}
