import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { isDeepStrictEqual as equal } from 'node:util'
import type { BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import type { TridentRun, TridentRunStore } from './store.ts'
import { parseBuildModeState } from './build-mode-state.ts'
import { evidenceReader } from './settled-review-recovery.ts'
import { validateTrailer } from './gates/result-contract.ts'
import { ORCHESTRATOR_RECOVERY_STAGE } from './orchestrator-recovery-contract.ts'
import { githubWebUrlFromRemote } from './repo-web-url.ts'
import type { HostCommandResult } from './git-mode.ts'

const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const reservationPrefix = new Map([['anthropic', 'claude'], ['openai-codex', 'codex'], ['pi', 'pi']])

/** The project launcher's preparation-refusal message, as `String(error)` of the
 * throw in `prepareProjectBuild` after it recorded its worktree-add diagnostic. */
const PREPARATION_REFUSAL_PREFIX = 'Error: Build worktree creation was not confirmed ('
const PREPARATION_REFUSAL_SUFFIX = '; diagnostic_recorded=true)'
/** The only stage event a retry refused at preparation itself records: the one
 * worktree-add diagnostic. Every other stage (a checkpoint, a settled driver, a
 * retry source, a recovery, an invalidated seed, a dependency interval) means it
 * was not that retry. */
export const PREPARATION_REFUSAL_EVENTS: readonly string[] = ['build-worktree-add-failed']
/** Launch and dispatch telemetry the production composition stamps on EVERY
 * launch around the fire, before and independently of preparation: the
 * orchestrator's `launch()` (`launch-start`, `fire-dispatched`, `fire-settled`,
 * `fire-unconfirmed`, `fire-unobserved-launch`, `fire-confirmed`, `fire-drained`,
 * `fire-cancelled`; `gateway/composition/build-core-modules.ts` wires
 * `record_stage`) and the agent-native `work_board_start` dispatch. None of them
 * is worker, checkpoint or recovery evidence, so they neither qualify nor
 * disqualify a preparation-refused attempt. */
export const LAUNCH_TELEMETRY_EVENTS: readonly string[] = [
  'launch-start', 'fire-dispatched', 'fire-settled', 'fire-unconfirmed', 'fire-unobserved-launch',
  'fire-confirmed', 'fire-drained', 'fire-cancelled', 'work-board-start-dispatched',
]

/**
 * Whether a newer terminal card attempt is provably a retry the project
 * launcher refused at PREPARATION, before its first worker (#1476 round 2).
 * The launcher reserves `inner_result` before `prepare` and, when `prepare`
 * throws, overwrites its own reservation with exactly
 * `{ ok: false, checkpoint: 'inner-error', terminalCause }`. A driver rejection
 * writes the same three keys, so the shape alone is not evidence: the attempt
 * must also carry the single `build-worktree-add-failed` diagnostic that
 * preparation records before it throws, the matching bounded refusal message,
 * no other stage event except launch telemetry (`LAUNCH_TELEMETRY_EVENTS`), and
 * no PR receipt but the card's own. The caller separately requires no attempt
 * rows and no inner checkpoint.
 */
function preparationRefused(candidate: TridentRun, events: ReturnType<TridentRunStore['stageEvents']>,
  published: number): boolean {
  let parsed: unknown
  try { parsed = JSON.parse(candidate.inner_result ?? 'null') } catch { return false }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const result = parsed as Record<string, unknown>
  const cause = result.terminalCause
  if (!equal(Object.keys(result).sort(), ['checkpoint', 'ok', 'terminalCause']) || result.ok !== false
    || result.checkpoint !== 'inner-error' || typeof cause !== 'string'
    || !cause.startsWith(PREPARATION_REFUSAL_PREFIX) || !cause.endsWith(PREPARATION_REFUSAL_SUFFIX)) return false
  const evidence = events.filter(event => !LAUNCH_TELEMETRY_EVENTS.includes(event.stage))
  if (evidence.length !== 1 || !PREPARATION_REFUSAL_EVENTS.includes(evidence[0]!.stage)) return false
  return candidate.pr === null || candidate.pr === published
}

/** What an owned published retry may adopt at outer launch. It names the
 * predecessor's settled work; it never carries its checkpoint, round, findings,
 * approval or suite receipt. */
export interface PublishedRetryHandoff {
  prior: TridentRun
  item_id: string
  priorBase: string
  settledHead: string
  holderWorktree: string
  stepId: string
  role: 'build' | 'fix'
  request: BoundedWorkRequest
  resultPath: string
}

/** The run fields the authority reads. Outer launch hands it the tick's
 * snapshot of the row; an unrelated write to any other column (a heartbeat,
 * a progress stamp) between that read and this step must not turn an owned
 * retry into a refusal, while any change to these fields still refuses. */
function authorityFields(run: TridentRun | null) {
  return run === null ? null : {
    id: run.id, phase: run.phase, project_slug: run.project_slug, repo_path: run.repo_path, branch: run.branch,
    merge_mode: run.merge_mode, published_pr: run.published_pr, bound_pr: run.bound_pr,
    inner_checkpoint: run.inner_checkpoint, base_sha: run.base_sha,
  }
}

/** Composition-supplied settlement facts only the host process can observe:
 * the live trailer validator and native-child leases. Absent means refused. */
export type PublishedRetrySettlement = (handoff: PublishedRetryHandoff) => boolean

/**
 * Authority for a fresh card retry to adopt the retained branch of its terminal
 * predecessor, composed from existing exact checks (#1476). Every fact is
 * re-read here; no field is trusted from dispatch except as a value to match.
 *
 * - the run's `published_pr` is the exact same-card lineage receipt;
 * - the predecessor is the card's newest terminal attempt that holds a host
 *   checkpoint, on the same project, repository, branch and PR mode, with an oid
 *   base pin; newer attempts are passed over only when each is provably a retry
 *   refused before its first worker on that same branch: refused at outer
 *   launch (no inner result), or refused at preparation in exactly the shape
 *   `preparationRefused` admits;
 * - its latest host checkpoint records a pending build or fix whose ORIGINAL
 *   request, journal, armed reservation and completed result agree, with
 *   attempt accounting completed, unfinished or `unknown` (never rewritten);
 * - no other run or reservation owns the branch.
 *
 * Returns null for every other shape, including any read failure. Nothing is
 * written. Settlement never makes the pending checkpoint a retry source.
 */
export function publishedRetryHandoff(store: TridentRunStore, run: TridentRun): PublishedRetryHandoff | null {
  try {
    const published = run.published_pr
    if (run.merge_mode !== 'pr' || typeof published !== 'number' || !Number.isSafeInteger(published) || published <= 0
      || run.inner_checkpoint !== null || run.bound_pr !== null || typeof run.branch !== 'string' || run.branch.length === 0) return null
    const ownEvents = store.stageEvents(run.id)
    if (ownEvents.some(event => event.stage === 'build-retry-source' || event.stage === ORCHESTRATOR_RECOVERY_STAGE
      || event.stage === 'build-mode-state') || store.orchestratorRecovery(run.id) !== null) return null
    const card = store.linkedCardAttempts(run.project_slug, run.id)
    if (!card) return null
    // The predecessor is the card's newest terminal attempt that holds a host
    // checkpoint. A newer attempt is passed over only when it is provably a
    // retry refused before its first worker on this same branch: terminal, no
    // checkpoint, no recovery, no worker accounting, and either no receipt or
    // this exact one. A refused retry (including a transient UNKNOWN refusal of
    // this very path) must not end the card's recovery; anything else refuses.
    const sameLane = (candidate: TridentRun) => ['failed', 'stopped'].includes(candidate.phase)
      && candidate.project_slug === run.project_slug && candidate.repo_path === run.repo_path
      && candidate.branch === run.branch && candidate.merge_mode === 'pr' && store.orchestratorRecovery(candidate.id) === null
    const passed: { run: TridentRun; events: ReturnType<TridentRunStore['stageEvents']> }[] = []
    let prior: TridentRun | null = null
    let events: ReturnType<TridentRunStore['stageEvents']> = []
    for (const id of card.run_ids) {
      const candidate = id === run.id ? null : store.get(id)
      if (!candidate || !sameLane(candidate)) return null
      const seen = store.stageEvents(id)
      if (seen.some(row => row.stage === 'build-mode-state')) { prior = candidate; events = seen; break }
      if (seen.some(row => row.stage === 'build-retry-source' || row.stage === ORCHESTRATOR_RECOVERY_STAGE)
        || store.attempts(id).length > 0 || candidate.inner_checkpoint !== null
        || (candidate.inner_result !== null && !preparationRefused(candidate, seen, published))
        || candidate.bound_pr !== null || (candidate.published_pr !== null && candidate.published_pr !== published)) return null
      passed.push({ run: candidate, events: seen })
    }
    if (!prior || !prior.base_sha || !oid.test(prior.base_sha)) return null
    // The receipt dispatch carried, re-derived from the same exact link.
    const receipt = prior.published_pr ?? store.earlierCardPublication(
      run.project_slug, card.item_id, prior.id, run.repo_path, run.branch)
    if (receipt !== published) return null

    const event = events.filter(row => row.stage === 'build-mode-state').at(-1)
    if (!event) return null
    const state = parseBuildModeState(event.meta ?? null, prior, true)
    const pending = state.checkpoint.pending
    const recovery = pending?.recovery
    const worktree = (state as typeof state & { worktree: string }).worktree
    if (!pending || !recovery || (pending.phase !== 'build' && pending.phase !== 'fix')) return null
    const role = pending.phase
    const request = recovery.request
    const root = dirname(request.result.path)
    if (request.run_id !== prior.id || request.step_id !== pending.step_id || request.role !== role
      || basename(root) !== encodeURIComponent(prior.id) || request.result.path !== join(root, `${role}.result`)
      || request.result.schema !== 'project-build' || request.cwd !== worktree || request.writable !== true) return null
    const provider = recovery.inputs.workers[role]?.provider
    const prefix = reservationPrefix.get(provider ?? '')
    if (!provider || !prefix) return null

    const evidence = evidenceReader()
    evidence.directory(root)
    const json = (path: string): any => JSON.parse(evidence.read(path))
    const journal = json(join(root, `attempt-request-${digest([prior.id, request.step_id, 'dispatch'])}.json`))
    if (!equal(journal.request, request) || journal.provider !== provider
      || evidence.read(join(root, `${prefix}-step-${digest([prior.id, request.step_id])}.json`))
        !== JSON.stringify(request) + '\n#dispatch-armed\n') return null

    const attempts = store.attempts(prior.id)
    const rows = attempts.filter(row => row.step_id === request.step_id && row.attempt_id === 'dispatch')
    if (rows.length !== 1) return null
    const row = rows[0]!
    const accounted = row.outcome === 'completed' ? row.ended_at !== null
      : row.outcome === 'unknown' || (row.outcome === null && row.ended_at === null)
    if (row.run_id !== prior.id || row.role !== role || row.resolved_model !== request.model_id
      || row.provider !== provider || journal.placement !== row.placement
      || row.prepared_at === null || row.started_at === null || !accounted) return null
    // Any other unfinished worker of the predecessor is a writer we cannot settle.
    if (attempts.some(other => other !== row && other.ended_at === null && other.outcome === null)) return null

    const result = json(request.result.path)
    const head = result?.result?.head
    if (result?.kind !== 'completed' || result.schema !== 'project-build' || result.run_id !== prior.id
      || result.step_id !== request.step_id || typeof head !== 'string' || !oid.test(head)) return null
    const payload = validateTrailer('forge', result.result.payload)
    if (!payload.ok || payload.value.commitSha !== head || payload.value.branch !== prior.branch
      || payload.value.worktreePath !== request.cwd || payload.value.deviatedFromSpec === true) return null

    if (store.branchOwnedByAnother(run.id, run.repo_path, run.branch)) return null
    if (!evidence.stable() || !equal(store.get(prior.id), prior) || !equal(store.stageEvents(prior.id), events)
      || !equal(store.attempts(prior.id), attempts) || !equal(authorityFields(store.get(run.id)), authorityFields(run))
      || !equal(store.linkedCardAttempts(run.project_slug, run.id), card)
      || passed.some(skipped => !equal(store.get(skipped.run.id), skipped.run)
        || !equal(store.stageEvents(skipped.run.id), skipped.events) || store.attempts(skipped.run.id).length > 0)) return null
    return { prior, item_id: card.item_id, priorBase: prior.base_sha, settledHead: head,
      holderWorktree: worktree, stepId: request.step_id, role, request, resultPath: request.result.path }
  } catch { return null }
}

/**
 * Whether this run's row carries the base pin outer launch writes when it ADOPTS
 * an owned published retry's retained branch (#1476 round 2). Outer launch
 * persists no separate adoption marker: adoption is the one launch path that
 * pins `base_sha` to the predecessor's own base pin. That pin alone is not
 * distinctive, so the row must also be an owned-published fresh retry (PR mode,
 * a positive receipt, no checkpoint, no bound PR) and the pin must equal the
 * base pin of the card's newest same-lane attempt whose latest checkpoint still
 * records a pending build or fix, the only predecessor the authority adopts.
 *
 * The run must still be fresh: its own `build-mode-state`, `build-retry-source`
 * or recovery means it already ran past adoption, and answers false (the same
 * exclusions the authority applies).
 *
 * Preparation consults this only when the authority itself is null: a row that
 * outer launch adopted must then refuse UNKNOWN rather than attach the branch
 * unchecked. A read failure on such a candidate row answers true.
 */
export function adoptedPublishedRetryPin(store: TridentRunStore, run: TridentRun): boolean {
  const published = run.published_pr
  if (run.merge_mode !== 'pr' || typeof published !== 'number' || !Number.isSafeInteger(published) || published <= 0
    || run.inner_checkpoint !== null || run.bound_pr !== null || typeof run.branch !== 'string' || run.branch.length === 0
    || typeof run.base_sha !== 'string' || !oid.test(run.base_sha)) return false
  try {
    // Scoped to a FRESH retry, the only state outer launch adopts: once the run
    // holds its own checkpoint, retry source or recovery, the authority is null
    // by design and a same-run re-preparation keeps its existing path.
    if (store.stageEvents(run.id).some(event => event.stage === 'build-retry-source'
      || event.stage === ORCHESTRATOR_RECOVERY_STAGE || event.stage === 'build-mode-state')
      || store.orchestratorRecovery(run.id) !== null) return false
    const card = store.linkedCardAttempts(run.project_slug, run.id)
    if (!card) return false
    for (const id of card.run_ids) {
      if (id === run.id) continue
      const candidate = store.get(id)
      if (!candidate || candidate.repo_path !== run.repo_path || candidate.branch !== run.branch) continue
      const event = store.stageEvents(id).filter(row => row.stage === 'build-mode-state').at(-1)
      if (!event) continue
      if (candidate.base_sha !== run.base_sha) return false
      const pending = parseBuildModeState(event.meta ?? null, candidate, true).checkpoint.pending
      return pending?.phase === 'build' || pending?.phase === 'fix'
    }
    return false
  } catch { return true }
}

/** The composed reader: trident authority AND the host's own settlement view.
 * A missing composition witness refuses. */
export function readPublishedRetryHandoff(store: TridentRunStore, settled: PublishedRetrySettlement | undefined,
  run: TridentRun): PublishedRetryHandoff | null {
  const handoff = publishedRetryHandoff(store, run)
  if (!handoff || !settled) return null
  try { return settled(handoff) ? handoff : null } catch { return null }
}

/** Observe the owned PR for an adopted retained branch. The settled head may be
 * unpushed, so the PR head must be CONTAINED in the branch, not equal to it. */
export async function observeOwnedPublication(
  run: Pick<TridentRun, 'repo_path' | 'branch' | 'published_pr'>, base: string,
  host: (argv: string[], cwd: string) => Promise<HostCommandResult>,
): Promise<{ verdict: 'ok'; head: string } | { verdict: 'refused' | 'unknown'; detail: string }> {
  const origin = await host(['git', '-C', run.repo_path, 'remote', 'get-url', 'origin'], run.repo_path)
  if (!origin.ok || origin.timed_out === true) return { verdict: 'unknown', detail: 'the origin remote could not be read' }
  const repository = githubWebUrlFromRemote(origin.stdout)
  if (!repository) return { verdict: 'refused', detail: 'the origin remote is not a GitHub repository' }
  const observed = await host(['gh', 'pr', 'view', String(run.published_pr), '--repo', repository, '--json',
    'number,url,headRefOid,state,headRefName,baseRefName,isCrossRepository'], run.repo_path)
  if (!observed.ok || observed.timed_out === true) return { verdict: 'unknown', detail: 'the published PR could not be read' }
  let pr: any
  try { pr = JSON.parse(observed.stdout) } catch { return { verdict: 'unknown', detail: 'the published PR answer was malformed' } }
  const prHead = typeof pr?.headRefOid === 'string' ? pr.headRefOid.toLowerCase() : ''
  if (pr?.number !== run.published_pr || pr.state !== 'OPEN' || pr.headRefName !== run.branch
    || pr.isCrossRepository !== false || pr.baseRefName !== base || !oid.test(prHead)) {
    return { verdict: 'refused', detail: 'the published PR is not open on this branch and base' }
  }
  return { verdict: 'ok', head: prHead }
}
