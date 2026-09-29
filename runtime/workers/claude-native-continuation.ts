import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { BoundedWorkOutcome, BoundedWorkRequest } from '../bounded-work.ts'
import type { ReplSession } from '../adapters/claude-code/persistent/repl-session.ts'
import { sessionJsonlPath } from '../adapters/claude-code/persistent/jsonl-resumability.ts'
import { claudeComposerEmpty } from './claude-composer.ts'
import { claudeChildQuotaEvent } from './claude-child-rate-limit.ts'
import { SUBAGENT_CONTINUATION_TOOL_NAME } from './claude-tool-contract.ts'
import { verifyNativeDispatchChildBound, type NativeDispatchLease, type SignedNativeDispatchRecord } from './claude-native-dispatch-receipt.ts'
import { readArmedTrailerReservation } from './trailer-slot.ts'
import type { ProjectTrailerOutcome } from './project-runners.ts'
import { nativeChildContinuationCensusKnown, ownsNativeChildWorkspace, type NativeChildWorkspace } from './native-child-workspace.ts'

type Boundary = { offset: number; dev: number; ino: number; prefixDigest: string }
interface Preparation {
  version: 1
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
}
export type ClaudeContinuationOutcome = { kind: 'result'; outcome: BoundedWorkOutcome }
  | { kind: 'not-eligible' }
  | { kind: 'submitted'; evidence: 'terminal-acknowledgement' | 'exact-tool-invocation' }
  | { kind: 'unknown'; reason: 'tool-unavailable' | 'catalog-unknown' | 'identity-unknown' | 'submission-unknown' | 'budget-expired' }

export interface ClaudeContinuationOptions {
  request: BoundedWorkRequest
  receipt: unknown
  authority: { lease: NativeDispatchLease; read(): string | undefined; claim(preparation: string): Promise<boolean> }
  stateDir: string
  session: Pick<ReplSession, 'sessionId' | 'childGeneration' | 'cwd' | 'child' | 'toolSurface' | 'acquireContinuationTurn' | 'probeNativeToolCatalog' | 'hasChildExited'>
  workspace: NativeChildWorkspace
  projectsDir?: string
  deadline: number
  signal: AbortSignal
  decodeTrailer(bytes: string, request: BoundedWorkRequest): ProjectTrailerOutcome
}

const message = (nonce: string) => `Continue the original bounded task with its original request, brief, worktree and result contract. Preserve completed work and write the original result. Continuation receipt: ${nonce}`

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
  const timer = new AbortController()
  const signal = AbortSignal.any([options.signal, timer.signal])
  let onAbort!: () => void
  const cancelled = new Promise<ClaudeContinuationOutcome>(resolve => {
    onAbort = () => resolve({ kind: 'unknown', reason: 'budget-expired' })
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  const timeout = setTimeout(() => timer.abort(), Math.max(1, options.deadline - Date.now()))
  try { return await Promise.race([continuationAttempt({ ...options, signal }), cancelled]) }
  finally { clearTimeout(timeout); timer.abort(); signal.removeEventListener('abort', onAbort) }
}

async function continuationAttempt(options: ClaudeContinuationOptions): Promise<ClaudeContinuationOutcome> {
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
    const agentId = receipt.body.nativeAgentId!
    if (receipt.body.parent?.sessionId !== session.sessionId || !/^[A-Za-z0-9_-]+$/.test(agentId)
      || !ownsNativeChildWorkspace(options.workspace, session, request) || !nativeChildContinuationCensusKnown(options.workspace)) return unknown('identity-unknown')
    const transcript = sessionJsonlPath(session.sessionId, session.cwd, options.projectsDir)
    const childTranscript = join(transcript.slice(0, -'.jsonl'.length), 'subagents', `agent-${agentId}.jsonl`)
    const existing = authority.read()
    if (existing !== undefined) {
      const saved: Preparation = JSON.parse(existing)
      if (saved.version !== 1 || !isDeepStrictEqual(saved.request, request) || !isDeepStrictEqual(saved.lease, authority.lease)
        || saved.receiptSignature !== receipt.signature || saved.sessionId !== session.sessionId || saved.agentId !== agentId
        || !saved.nonce || !isDeepStrictEqual(saved.args, { to: agentId, message: message(saved.nonce) })) return unknown('identity-unknown')
      return await exactInvocation(transcript, saved) ? { kind: 'submitted', evidence: 'exact-tool-invocation' } : unknown('submission-unknown')
    }
    const quota = await claudeChildQuotaEvent(childTranscript, agentId, session.sessionId, request)
    if (!quota) return { kind: 'not-eligible' }
    const catalog = await session.probeNativeToolCatalog?.()
    const arrived = await result()
    if (arrived) return arrived
    if (!catalog || catalog.status !== 'observed' || catalog.source !== 'native-provider-catalog'
      || catalog.sessionId !== session.sessionId || catalog.childGeneration !== session.childGeneration) return unknown('catalog-unknown')
    if (!catalog.names.includes(SUBAGENT_CONTINUATION_TOOL_NAME)
      || !session.toolSurface.split(',').includes(SUBAGENT_CONTINUATION_TOOL_NAME)) return unknown('tool-unavailable')
    if (!session.child.submitLine || expired()) return unknown('budget-expired')
    // Native workspace authorization passes only this admitted child through the
    // session's serialization. Recheck after queue acquisition and before input.
    const release = await session.acquireContinuationTurn(options.workspace)
    try {
      if (expired()) return unknown('budget-expired')
      const completed = await result()
      if (completed) return completed
      if (!ownsNativeChildWorkspace(options.workspace, session, request) || !nativeChildContinuationCensusKnown(options.workspace)
        || !isDeepStrictEqual(await claudeChildQuotaEvent(childTranscript, agentId, session.sessionId, request), quota)) return unknown('identity-unknown')
      const boundary = await readBoundary(transcript)
      if (!boundary) return unknown('submission-unknown')
      const nonce = randomUUID()
      const args = { to: agentId, message: message(nonce) }
      const preparation: Preparation = { version: 1, request, lease: authority.lease, receiptSignature: receipt.signature,
        sessionId: session.sessionId, childGeneration: session.childGeneration, agentId, quota, nonce, args, boundary }
      const line = `Invoke ${SUBAGENT_CONTINUATION_TOOL_NAME} exactly once with these JSON arguments, then end this parent turn: ${JSON.stringify(args)}`
      const before = async () => {
        if (expired()) throw new Error('Continuation budget expired')
        if (session.child.paneHandle !== undefined && (!session.child.readScreen || !claudeComposerEmpty(await session.child.readScreen()))) throw new Error('Composer unavailable')
        // Commit before Enter. Failure, timeout or restart never refunds this claim.
        if (expired() || !await authority.claim(JSON.stringify(preparation)) || expired()) throw new Error('Continuation already claimed, fenced or expired')
      }
      const timeout = AbortSignal.timeout(Math.max(1, options.deadline - Date.now()))
      const stopped = AbortSignal.any([signal, timeout])
      if (session.child.paneHandle !== undefined) {
        if (!session.child.submitLineGuarded) return unknown('submission-unknown')
        await session.child.submitLineGuarded(line, before, stopped)
      } else { await before(); await session.child.submitLine(line, stopped) }
      return { kind: 'submitted', evidence: 'terminal-acknowledgement' }
    } finally { release() }
  } catch { return unknown('submission-unknown') }
}

async function readBoundary(path: string): Promise<Boundary | undefined> {
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
async function digestPrefix(file: FileHandle, size: number): Promise<string | undefined> {
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

/** Parent text, tool-name mentions and another recipient are not consumption. */
async function exactInvocation(path: string, saved: Preparation): Promise<boolean> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    const boundary = saved.boundary
    if (!info.isFile() || !Number.isSafeInteger(boundary.offset) || boundary.offset < 0
      || info.dev !== boundary.dev || info.ino !== boundary.ino || info.size < boundary.offset || info.size - boundary.offset > 4 * 1024 * 1024) return false
    if (typeof boundary.prefixDigest !== 'string' || await digestPrefix(file, boundary.offset) !== boundary.prefixDigest) return false
    const bytes = Buffer.alloc(info.size - boundary.offset)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, boundary.offset)
    const after = await file.stat()
    if (bytesRead !== bytes.length || info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) return false
    const text = bytes.toString('utf8')
    const matches: string[] = []
    for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n')) {
      if (!line) continue
      const row = JSON.parse(line)
      if (row.sessionId !== saved.sessionId || row.type !== 'assistant' || row.message?.role !== 'assistant' || !Array.isArray(row.message.content)) continue
      for (const block of row.message.content) {
        // A copied continuation nonce sent to another native recipient is a
        // conflicting actuation, not unrelated conversation to skip past.
        if (block.type === 'tool_use' && block.name === SUBAGENT_CONTINUATION_TOOL_NAME
          && block.input?.message === saved.args.message && !isDeepStrictEqual(block.input, saved.args)) return false
        if (block.type === 'tool_use' && block.name === SUBAGENT_CONTINUATION_TOOL_NAME
          && typeof block.id === 'string' && isDeepStrictEqual(block.input, saved.args)) matches.push(block.id)
      }
    }
    return new Set(matches).size === 1
  } finally { await file.close() }
}
