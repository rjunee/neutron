import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { BoundedWorkRequest } from '../bounded-work.ts'
import type { ReplSession } from '../adapters/claude-code/persistent/repl-session.ts'
import { sessionJsonlPath } from '../adapters/claude-code/persistent/jsonl-resumability.ts'
import { readNativeParentLaunchEvidence } from '../adapters/claude-code/persistent/native-parent-launch-evidence.ts'
import { isProcessIdentity, readProcessIdentity } from '../adapters/claude-code/persistent/process-identity.ts'
import { knownLaunch, digestPrefix, readBoundary, type NativeTranscriptBoundary } from './claude-native-continuation.ts'
import { verifyNativeDispatchChildBound, type NativeDispatchLease, type SignedNativeDispatchRecord } from './claude-native-dispatch-receipt.ts'
import { readArmedTrailerReservation } from './trailer-slot.ts'
import { claudeComposerEmpty } from './claude-composer.ts'
import { SUBAGENT_STOP_TOOL_NAME } from './claude-tool-contract.ts'
import { bindNativeChildWorkspace, nativeChildContinuationCensusKnown, ownsNativeChildWorkspace, type NativeChildWorkspace } from './native-child-workspace.ts'

/** The DB owns this intent and its one input spend; worker files cannot mint it. */
export interface NativeCancellationAuthority {
  lease: NativeDispatchLease
  current(): boolean
  read(): string | undefined
  claim(preparation: string): Promise<boolean>
  complete(preparation: string, acknowledgement: string): Promise<boolean>
}
interface Preparation {
  version: 1
  request: BoundedWorkRequest
  lease: NativeDispatchLease
  receiptSignature: string
  sessionId: string
  agentId: string
  nonce: string
  boundary: NativeTranscriptBoundary
  transcript: string
}
export const NATIVE_CANCELLATION_MS = 35_000
export type NativeCancellationOutcome = { kind: 'stopped' }
  | { kind: 'unknown'; reason: 'identity' | 'tool-unavailable' | 'submission' | 'acknowledgement' }

function preparationMatches(saved: Preparation, request: BoundedWorkRequest, receipt: SignedNativeDispatchRecord, lease: NativeDispatchLease): boolean {
  return saved?.version === 1 && isDeepStrictEqual(saved.request, request) && isDeepStrictEqual(saved.lease, lease)
    && saved.receiptSignature === receipt.signature && saved.sessionId === receipt.body.parent?.sessionId
    && saved.agentId === receipt.body.nativeAgentId && typeof saved.nonce === 'string' && saved.nonce.length > 0
    && typeof saved.transcript === 'string' && saved.transcript.length > 0
}

/** Passive recovery works after the original parent exits. The DB-held path and
 * boundary were measured before actuation; no worker-selected path is consumed. */
export async function reconcileClaudeNativeCancellation(request: BoundedWorkRequest, receipt: unknown,
  authority: NativeCancellationAuthority): Promise<NativeCancellationOutcome | undefined> {
  try {
    if (!verifyNativeDispatchChildBound(receipt, request, authority.lease) || !authority.current()) return
    const raw = authority.read()
    if (raw === undefined) return
    const saved: Preparation = JSON.parse(raw)
    if (!preparationMatches(saved, request, receipt as SignedNativeDispatchRecord, authority.lease)) return { kind: 'unknown', reason: 'identity' }
    const acknowledgement = await readNativeStopAcknowledgement(saved.transcript, saved)
    return acknowledgement && authority.current() && await authority.complete(raw, acknowledgement)
      ? { kind: 'stopped' } : { kind: 'unknown', reason: 'acknowledgement' }
  } catch { return { kind: 'unknown', reason: 'acknowledgement' } }
}

/** A native tool result, linked to its exact tool invocation, is required.
 * Queued notifications, assistant prose, copied IDs and tool errors cannot stop
 * ownership. Read only the stable suffix after the host's immutable boundary. */
export async function readNativeStopAcknowledgement(path: string, saved: Preparation): Promise<string | undefined> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const before = await file.stat(), boundary = saved.boundary
    if (!before.isFile() || !Number.isSafeInteger(boundary.offset) || boundary.offset < 0
      || before.dev !== boundary.dev || before.ino !== boundary.ino || before.size < boundary.offset
      || before.size - boundary.offset > 4 * 1024 * 1024
      || await digestPrefix(file, boundary.offset) !== boundary.prefixDigest) return
    const bytes = Buffer.alloc(before.size - boundary.offset)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, boundary.offset)
    const after = await file.stat()
    if (bytesRead !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return
    const text = bytes.toString('utf8'), invocations = new Map<string, string>()
    const acknowledged: string[] = []
    for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n')) {
      if (!line) continue
      const row = JSON.parse(line)
      if (row.sessionId !== saved.sessionId || row.isSidechain !== false || !Array.isArray(row.message?.content)) continue
      for (const block of row.message.content) {
        if (row.type === 'assistant' && row.message.role === 'assistant' && block.type === 'tool_use'
          && block.name === SUBAGENT_STOP_TOOL_NAME && isDeepStrictEqual(block.input, { task_id: saved.agentId })
          && typeof block.id === 'string' && typeof row.uuid === 'string') {
          if (invocations.has(block.id) && invocations.get(block.id) !== row.uuid) return
          invocations.set(block.id, row.uuid)
        }
        if (row.type !== 'user' || row.message.role !== 'user' || block.type !== 'tool_result'
          || !invocations.has(block.tool_use_id)) continue
        if (block.is_error === true || row.sourceToolAssistantUUID !== invocations.get(block.tool_use_id)) return
        const content = block.content
        const result = JSON.parse(typeof content === 'string' ? content
          : Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' ? content[0].text : '')
        if (!result || result.task_id !== saved.agentId || result.task_type !== 'local_agent'
          || typeof result.message !== 'string' || !result.message.startsWith(`Successfully stopped task: ${saved.agentId} `)
          || !isDeepStrictEqual(row.toolUseResult, result)) return
        acknowledged.push(block.tool_use_id)
      }
    }
    return invocations.size === 1 && acknowledged.length === 1
      ? JSON.stringify({ version: 1, sessionId: saved.sessionId, agentId: saved.agentId,
        toolUseId: acknowledged[0], sourceToolAssistantUUID: invocations.get(acknowledged[0]!) }) : undefined
  } finally { await file.close() }
}

/** Stops one authenticated existing child. A spent input is never resent, even
 * after lost acknowledgement or restart. This never fabricates a worker result,
 * authorizes implementation, or stops the enclosing project conversation. */
export async function cancelClaudeNativeChild(options: {
  request: BoundedWorkRequest
  receipt: unknown
  authority: NativeCancellationAuthority
  stateDir: string
  session: Pick<ReplSession, 'sessionId' | 'childGeneration' | 'cwd' | 'child' | 'toolSurface' | 'hasChildExited' | 'acquireContinuationTurn'>
  workspace: NativeChildWorkspace
  projectsDir?: string
  deadline: number
  signal: AbortSignal
}): Promise<NativeCancellationOutcome> {
  const { request, authority, session } = options
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(Math.max(1, Math.min(NATIVE_CANCELLATION_MS, options.deadline - Date.now())))])
  const unknown = (reason: Extract<NativeCancellationOutcome, { kind: 'unknown' }>['reason']): NativeCancellationOutcome => ({ kind: 'unknown', reason })
  const expired = () => signal.aborted || Date.now() >= options.deadline
  try {
    if (!verifyNativeDispatchChildBound(options.receipt, request, authority.lease)) return unknown('identity')
    const receipt = options.receipt as SignedNativeDispatchRecord, parent = receipt.body.parent
    const agentId = receipt.body.nativeAgentId!
    if (!parent || parent.sessionId !== session.sessionId || !isProcessIdentity(parent.processIdentity)
      || !/^[A-Za-z0-9_-]+$/.test(agentId) || !authority.current()) return unknown('identity')
    const key = createHash('sha256').update(JSON.stringify([request.run_id, request.step_id])).digest('hex')
    if ((await readArmedTrailerReservation(join(options.stateDir, `claude-step-${key}.json`), JSON.stringify(request),
      { signal, deadline: options.deadline })).kind !== 'resume') return unknown('identity')
    const transcript = sessionJsonlPath(session.sessionId, session.cwd, options.projectsDir)
    const retained = authority.read()
    let saved: Preparation | undefined = retained === undefined ? undefined : JSON.parse(retained)
    if (saved && (!preparationMatches(saved, request, receipt, authority.lease) || saved.transcript !== transcript)) return unknown('identity')
    const observe = async (): Promise<NativeCancellationOutcome | undefined> => {
      if (!saved || !authority.current()) return
      const acknowledgement = await readNativeStopAcknowledgement(transcript, saved)
      if (!acknowledgement) return
      return authority.current() && await authority.complete(JSON.stringify(saved), acknowledgement) ? { kind: 'stopped' } : unknown('identity')
    }
    const prior = await observe()
    if (prior) return prior
    if (saved) return unknown('acknowledgement')
    const currentParent = () => !session.hasChildExited() && parent.pid === session.child.pid
      && isDeepStrictEqual(readProcessIdentity(parent.pid), parent.processIdentity)
      && knownLaunch(parent.launch, parent.sessionId, parent.childGeneration, authority.lease.scope.projectId)
      && knownLaunch(readNativeParentLaunchEvidence(session), session.sessionId, session.childGeneration, authority.lease.scope.projectId)
    if (!currentParent() || !ownsNativeChildWorkspace(options.workspace, session, request)
      || !nativeChildContinuationCensusKnown(options.workspace)) return unknown('identity')
    const launch = parent.launch
    if (!launch?.tools.includes(SUBAGENT_STOP_TOOL_NAME) || !readNativeParentLaunchEvidence(session)?.tools.includes(SUBAGENT_STOP_TOOL_NAME)
      || !session.toolSurface.split(',').includes(SUBAGENT_STOP_TOOL_NAME)) return unknown('tool-unavailable')
    bindNativeChildWorkspace(options.workspace)
    const release = await session.acquireContinuationTurn(options.workspace, signal)
    try {
      if (!saved) {
        const boundary = await readBoundary(transcript)
        if (!boundary || expired()) return unknown('submission')
        saved = { version: 1, request, lease: authority.lease, receiptSignature: receipt.signature,
          sessionId: session.sessionId, agentId, nonce: randomUUID(), boundary, transcript }
        const before = async () => {
          if (expired() || !authority.current() || !currentParent()) throw Error('Cancellation authority changed')
          if (session.child.paneHandle !== undefined && (!session.child.readScreen || !claudeComposerEmpty(await session.child.readScreen()))) throw Error('Composer unavailable')
          if (expired() || !await authority.claim(JSON.stringify(saved)) || !authority.current() || !currentParent()) throw Error('Cancellation input already spent')
        }
        const line = `Invoke ${SUBAGENT_STOP_TOOL_NAME} exactly once with these JSON arguments, then end this parent turn: ${JSON.stringify({ task_id: agentId })}. Cancellation receipt: ${saved.nonce}`
        if (session.child.paneHandle !== undefined) {
          if (!session.child.submitLineGuarded) return unknown('submission')
          await session.child.submitLineGuarded(line, before, signal)
        } else {
          if (!session.child.submitLine) return unknown('submission')
          await before(); await session.child.submitLine(line, signal)
        }
      }
      while (!expired() && authority.current()) {
        const outcome = await observe()
        if (outcome) return outcome
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
          const timer = setTimeout(done, 25)
          signal.addEventListener('abort', done, { once: true })
          if (signal.aborted) done()
        })
      }
      return unknown('acknowledgement')
    } finally { release() }
  } catch { return unknown('submission') }
}
