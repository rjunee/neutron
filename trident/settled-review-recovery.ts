import { constants, openSync, closeSync, fstatSync, readSync, readdirSync, lstatSync, type Stats } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import type { BuildModeState } from './build-mode-state.ts'
import type { TridentRun, TridentRunStore } from './store.ts'
import { briefIntegrity } from './gates/brief-integrity.ts'
import { validateTrailer } from './gates/result-contract.ts'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Synchronous because retry-source admission and its launch-time revalidation
 * share the synchronous store boundary. Never follow a result symlink or wait
 * on a pipe; bound both each file and the complete evidence collection. */
function evidenceReader() {
  let remaining = 32 * 1024 * 1024
  const measured = new Map<string, Stats>()
  const unchanged = (before: Stats, after: Stats) => before.dev === after.dev && before.ino === after.ino
    && before.mode === after.mode && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
  const directory = (path: string) => {
    const before = lstatSync(path)
    if (!before.isDirectory()) throw Error('Unsafe review directory')
    measured.set(path, before)
  }
  const read = (path: string): string => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = fstatSync(fd)
      if (!before.isFile() || before.size > Math.min(8 * 1024 * 1024, remaining)) throw Error('Unsafe review evidence')
      remaining -= before.size
      const bytes = Buffer.alloc(before.size + 1)
      let length = 0
      while (length < bytes.length) {
        const read = readSync(fd, bytes, length, bytes.length - length, null)
        if (!read) break
        length += read
      }
      const after = fstatSync(fd)
      if (length !== before.size || !unchanged(before, after)) throw Error('Review evidence changed')
      if (measured.has(path) && !unchanged(measured.get(path)!, after)) throw Error('Review evidence changed between reads')
      measured.set(path, after)
      return bytes.subarray(0, length).toString('utf8')
    } finally { closeSync(fd) }
  }
  return { read, directory, stable: () => [...measured].every(([path, before]) => unchanged(before, lstatSync(path))) }
}

/** Reconcile an old terminal checkpoint, never an active worker or an approval.
 * The durable attempt ledger is the independent census: deleting a seat's files
 * cannot make the remaining receipts look like a complete panel. Historical
 * configuration is not reconstructed from current settings. Every admitted
 * seat must settle; the next run purchases its own full configured panel. */
export function settledReviewRecovery(store: TridentRunStore, run: TridentRun, state: BuildModeState): boolean {
  try {
    const checkpoint = state.checkpoint
    const pending = checkpoint.pending
    const recovery = pending?.recovery
    if (run.phase !== 'failed' || !['built', 'fixed'].includes(checkpoint.stage)
      || (checkpoint.stage === 'built' && run.execution_strategy === 'task_sequence' && checkpoint.remainingTasks !== 0)
      || pending?.phase !== 'review' || !recovery
      || checkpoint.round < 1 || recovery.round !== checkpoint.round
      || recovery.snapshot.head !== checkpoint.head || recovery.executionStrategy !== run.execution_strategy
      || Reflect.get(recovery.inputs, 'run_id') !== run.id || Reflect.get(recovery.inputs, 'mode') !== 'implementation'
      || Reflect.get(recovery.inputs, 'merge_mode') !== run.merge_mode || recovery.inputs.taskIteration !== state.iteration) return false
    const request = recovery.request
    const root = dirname(request.result.path)
    if (basename(root) !== encodeURIComponent(run.id) || !lstatSync(root).isDirectory()
      || request.result.path !== join(root, 'review.result') || request.result.schema !== 'project-review'
      || request.run_id !== run.id || request.step_id !== pending.step_id || request.role !== 'review'
      || request.writable !== false || request.tools !== 'read-only' || request.needs_approval_decision !== false
      || dirname(request.brief.path) !== root || !recovery.snapshot.diff.trim()
      || request.cwd !== (state as BuildModeState & { worktree?: string }).worktree
      || !isDeepStrictEqual(request, { ...recovery.inputs.workers.review?.request,
        run_id: run.id, step_id: pending.step_id, role: 'review', needs_approval_decision: false })
      || pending.step_id !== `${run.id}${run.execution_strategy === 'task_sequence' ? `:task:${state.iteration}` : ''}:review:${checkpoint.round}:head:${checkpoint.head}`
      || recovery.reviewBaseline !== checkpoint.reviewBaseline
      || !isDeepStrictEqual(recovery.previousReview, checkpoint.previousReview)) return false
    const evidence = evidenceReader()
    const { read } = evidence
    evidence.directory(root)
    const inventory = readdirSync(root).sort()
    if (inventory.length > 4096) return false
    const json = (path: string): any => JSON.parse(read(path))
    const attempts = store.attempts(run.id)
    const standalone = attempts.find(row => row.step_id === request.step_id && row.attempt_id === 'dispatch')
    if (!standalone || standalone.outcome !== 'completed' || standalone.review_seat !== null) return false
    // Journaling precedes ledger admission. A crash in that interval is unknown,
    // not proof that the rest of the directory constitutes the entire panel.
    for (const name of inventory.filter(name => /^attempt-request-[a-f0-9]{64}\.json$/.test(name))) {
      const saved = json(join(root, name))
      if (saved.request?.run_id !== run.id
        || name !== `attempt-request-${digest([run.id, saved.request.step_id, 'dispatch'])}.json`) return false
      if (saved.request.role === 'review' && !attempts.some(row => row.step_id === saved.request.step_id
        && row.attempt_id === 'dispatch')) return false
    }
    const journal = (req: BoundedWorkRequest) => json(join(root,
      `attempt-request-${digest([run.id, req.step_id, 'dispatch'])}.json`))
    const checkAttempt = (req: BoundedWorkRequest, row: typeof standalone) => {
      const saved = journal(req)
      return row.run_id === run.id && row.role === 'review' && row.resolved_model === req.model_id
        && row.head_sha === checkpoint.head && row.prepared_at !== null && row.started_at !== null
        && row.ended_at !== null && row.outcome !== null && isDeepStrictEqual(saved.request, req)
        && saved.provider === row.provider && saved.placement === row.placement
        && ['phase', 'task_id', 'head_sha', 'review_seat', 'requested_model'].every(key =>
          saved.attribution?.[key] === row[key as keyof typeof row])
    }
    if (!checkAttempt(request, standalone) || standalone.provider !== recovery.inputs.workers.review?.provider
      || request.cwd !== recovery.inputs.workers.review?.request.cwd) return false
    const prefix = new Map([['anthropic', 'claude'], ['openai-codex', 'codex'], ['pi', 'pi']]).get(standalone.provider)
    if (!prefix || standalone.placement !== 'in-repl' || standalone.provider !== Reflect.get(recovery.inputs, 'repl_provider')
      || read(join(root, `${prefix}-step-${digest([run.id, request.step_id])}.json`))
        !== JSON.stringify(request) + '\n#dispatch-armed\n') return false
    const standaloneBrief = read(request.brief.path)
    if (briefIntegrity(standaloneBrief) !== request.brief.integrity
      || !standaloneBrief.includes(`${request.brief.path}.context.json`)) return false
    const context = json(`${request.brief.path}.context.json`)
    if (!isDeepStrictEqual(context.request, request) || !isDeepStrictEqual(context.snapshot, recovery.snapshot)) return false
    const trailer = json(request.result.path)
    if (trailer.kind !== 'completed' || trailer.schema !== request.result.schema
      || trailer.run_id !== run.id || trailer.step_id !== request.step_id
      || !validateTrailer('verdict', trailer.result?.payload).ok
      || !isDeepStrictEqual({ head: trailer.result.head, diff: trailer.result.diff, pr: trailer.result.pr }, recovery.snapshot)) return false

    const rows = attempts.filter(row => row.role === 'review' && row.review_seat !== null
      && row.step_id.endsWith(`:${checkpoint.round}:0`))
    if (rows.length === 0 || new Set(rows.map(row => row.review_seat)).size !== rows.length) return false
    // Any admitted sibling without a proven end retains the reservation, even
    // when its files are absent. Deferred retries are outside this narrow repair.
    if (attempts.some(row => row.role === 'review' && row.step_id !== request.step_id
      && (row.ended_at === null || (row.head_sha === checkpoint.head
        && row.step_id.endsWith(`:${checkpoint.round}:1`))))) return false
    const names = inventory.filter(name => /^review-[a-f0-9]{64}$/.test(name))
    if (names.length > 128) return false
    const seen = new Set<string>()
    let rateLimit = false
    for (const name of names) {
      const directory = join(root, name)
      evidence.directory(directory)
      const receipt = json(join(directory, 'receipt.json'))
      const req = json(join(directory, 'request.json')) as BoundedWorkRequest
      if (receipt.version !== 1 || receipt.identity !== name.slice(7) || receipt.state !== 'settled'
        || receipt.invalidated !== undefined || receipt.requestHash !== digest(req) || req.run_id !== run.id) return false
      const briefText = read(join(directory, 'brief.json'))
      const brief = JSON.parse(briefText)
      if (req.brief.path !== join(directory, 'brief.json') || req.brief.integrity !== briefIntegrity(briefText)
        || req.result.path !== join(directory, 'result.json') || req.result.schema !== 'verdict'
        || !['review', 'synthesis'].includes(req.role) || req.cwd !== request.cwd || req.writable !== false || req.tools !== 'read-only'
        || req.needs_approval_decision !== false || ![0, 1].some(attempt => req.step_id === `${name}:${brief.round}:${attempt}`)) return false
      if (brief.round !== checkpoint.round || brief.snapshot?.head !== checkpoint.head) continue
      if (req.role !== 'review' || req.step_id !== `${name}:${checkpoint.round}:0`) return false
      const row = rows.find(row => row.step_id === req.step_id)
      const observed = receipt.observation
      if (!row || !checkAttempt(req, row) || seen.has(req.step_id)
        || brief.project !== run.project_slug || brief.seat !== row.review_seat
        || !isDeepStrictEqual(brief.snapshot, recovery.snapshot)
        || observed?.runId !== run.id || observed.head !== checkpoint.head || observed.round !== checkpoint.round
        || observed.provider !== row.provider || observed.modelId !== row.resolved_model) return false
      if (observed.status === 'rate-limited' && row.outcome === 'failed') rateLimit = true
      else if (observed.status !== 'completed' || row.outcome !== 'completed'
        || !validateTrailer('verdict', observed.payload).ok) return false
      seen.add(req.step_id)
    }
    return rateLimit && seen.size === rows.length && evidence.stable()
      && isDeepStrictEqual(readdirSync(root).sort(), inventory)
      && isDeepStrictEqual(store.attempts(run.id), attempts) && store.get(run.id)?.phase === 'failed'
  } catch { return false }
}
