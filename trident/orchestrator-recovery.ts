import { isDeepStrictEqual } from 'node:util'
import type { TridentRun, TridentRunStore } from './store.ts'
import { parseBuildModeState, type BuildModeState } from './build-mode-state.ts'
import { reviewProgress } from './gates/review-progress.ts'
import { validReviewProgress } from './build-run.ts'
import { validateTrailer } from './gates/result-contract.ts'
import { isPlainBranchName } from './mutation-prover.ts'
import type { EnvCapableHostRunner } from './git-mode.ts'
import { githubWebUrlFromRemote } from './repo-web-url.ts'
import { detectBaseBranch } from './merge.ts'
import { ORCHESTRATOR_RECOVERY_STAGE, type OrchestratorRecoveryDecision, type OrchestratorRecoveryRequest } from './orchestrator-recovery-contract.ts'

const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const refuse = (reason: string): never => { throw new Error(`Orchestrator recovery refused: ${reason}`) }

export interface RecoveryCard {
  id: string
  project_slug: string
  linked_run_id: string | null
  status: string
  updated_at: string
  inline_active: number
  task_iteration: number
  max_task_iterations: number | null
  execution_strategy: string | null
}

export function parseOrchestratorRecoveryRequest(value: unknown): OrchestratorRecoveryRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse('request must be an object')
  const r = value as OrchestratorRecoveryRequest
  const keys = ['board_item_id', 'source_run_id', 'source_event_id', 'expected_head', 'expected_base', 'published_pr', 'direction']
  if (Object.keys(r).some(key => !keys.includes(key))
    || !['board_item_id', 'source_run_id', 'direction'].every(key => typeof (r as any)[key] === 'string' && (r as any)[key].trim())
    || r.direction.length > 16_384 || typeof r.expected_head !== 'string' || !oid.test(r.expected_head)
    || typeof r.expected_base !== 'string' || !oid.test(r.expected_base)
    || !Number.isSafeInteger(r.source_event_id) || r.source_event_id <= 0
    || !Number.isSafeInteger(r.published_pr) || r.published_pr <= 0) return refuse('request pins or planning direction are invalid')
  return structuredClone(r)
}

/** Latest events and exact board membership, never a slug/title lookup. */
export function rejectedRecoverySource(store: TridentRunStore, project: string, request: OrchestratorRecoveryRequest):
  { prior: TridentRun; state: BuildModeState; meta: string; card: RecoveryCard } {
  const card = store.recoveryCard(project, request.board_item_id)
  if (!card || !['failed', 'blocked', 'upcoming'].includes(card.status) || card.inline_active !== 0) return refuse('card is absent or not idle')
  const prior = store.get(request.source_run_id)
  const history = store.recoveryHistory(project, card.id)
  if (!prior || prior.project_slug !== project || prior.phase !== 'failed'
    || !history.includes(prior.id) || prior.merge_mode !== 'pr' || prior.bound_pr !== null
    || !prior.branch || !isPlainBranchName(prior.branch) || prior.base_sha !== request.expected_base
    || prior.published_pr !== request.published_pr || prior.execution_strategy === null
    || card.execution_strategy !== prior.execution_strategy) return refuse('source is not this card\'s published terminal implementation')
  if (card.linked_run_id && !history.includes(card.linked_run_id)) return refuse('current binding has no terminal ownership record')
  const event = store.stageEvents(prior.id).filter(e => e.stage === 'build-mode-state').at(-1)
  if (!event || event.id !== request.source_event_id || !event.meta) return refuse('source checkpoint is no longer latest')
  const state = parseBuildModeState(event.meta, prior, true)
  const c = state.checkpoint
  const stop = c.reviewStop
  if (c.stage !== 'rejected' || c.head !== request.expected_head || c.pending !== undefined || c.handoff !== undefined
    || !stop || stop.round !== c.round || c.round < 1 || c.replansUsed !== 0
    || c.reviewBaseline !== 'required' || !validReviewProgress(stop.previous) || !validReviewProgress(stop.current)
    || !isDeepStrictEqual(stop.current, c.previousReview)
    || (stop.reviewedHead === undefined ? stop.panelDecision !== undefined
      : stop.reviewedHead !== c.head || !['approve', 'fix', 're-plan', 'blocked'].includes(stop.panelDecision ?? '')))
    return refuse('source does not carry an unspent, valid arithmetic veto')
  const arithmetic = reviewProgress(stop.previous, stop.current)
  if (arithmetic.kind !== 'blocked' || arithmetic.reviewStop?.trigger !== stop.trigger) return refuse('source arithmetic does not establish its veto')
  let plan: any
  try { plan = JSON.parse(prior.strategy_plan ?? 'null') } catch { return refuse('accepted plan is unreadable') }
  if (!validateTrailer('plan', plan).ok || plan.strategy !== prior.execution_strategy || plan.remainingTasks !== 0
    || c.remainingTasks !== 0) return refuse('source does not establish completed implementation')
  // A later headless planning failure may obscure the link. Any later completed
  // work, reservation of a mutating worker, retry import or veto supersedes it.
  for (const id of history) {
    const later = store.get(id)
    if (!later || later.project_slug !== project) return refuse('attempt history is unreadable')
    if (later.id === prior.id || later.started_at < prior.started_at) continue
    if (later.started_at === prior.started_at) return refuse('attempt ordering is ambiguous')
    const events = store.stageEvents(later.id)
    const latest = events.filter(e => e.stage === 'build-mode-state').at(-1)
    const mode = latest ? parseBuildModeState(latest.meta, later, true) : null
    if (!['failed', 'stopped'].includes(later.phase) || later.published_pr !== null
      || events.some(e => e.stage === 'build-retry-source' || e.stage === 'build-orchestrator-recovery')
      || (mode && (mode.checkpoint.head !== null || mode.checkpoint.reviewStop !== undefined
        || (mode.checkpoint.pending && mode.checkpoint.pending.phase !== 'plan')))) return refuse('a later attempt supersedes this checkpoint')
  }
  return { prior, state, meta: event.meta, card }
}

/** Remote equality is independently rechecked at launch; no PR discovery grants ownership. */
export async function verifyRecoveryRemote(run: Pick<TridentRun, 'repo_path' | 'branch' | 'published_pr'>,
  head: string, host: EnvCapableHostRunner,
  expected?: Pick<OrchestratorRecoveryDecision, 'repository' | 'base_branch'>): Promise<{ repository: string; base_branch: string }> {
  if (!run.branch || !isPlainBranchName(run.branch) || !oid.test(head) || !run.published_pr) return refuse('remote pins are invalid')
  const origin = await host(['git', '-C', run.repo_path, 'remote', 'get-url', 'origin'], run.repo_path)
  const repository = origin.ok && !origin.timed_out ? githubWebUrlFromRemote(origin.stdout) : null
  const base_branch = await detectBaseBranch(host, run.repo_path)
  if (!repository || !isPlainBranchName(base_branch)
    || (expected && (expected.repository !== repository || expected.base_branch !== base_branch))) return refuse('repository or base identity changed')
  const observed = await host(['gh', 'pr', 'view', String(run.published_pr), '--repo', repository, '--json',
    'number,url,headRefOid,state,headRefName,baseRefName,isCrossRepository'], run.repo_path)
  if (!observed.ok || observed.timed_out) return refuse('published PR is unreadable')
  let pr: any
  try { pr = JSON.parse(observed.stdout) } catch { return refuse('published PR is malformed') }
  if (pr?.number !== run.published_pr || pr.url !== `${repository}/pull/${run.published_pr}` || pr.state !== 'OPEN' || pr.headRefOid !== head
    || pr.headRefName !== run.branch || pr.isCrossRepository !== false
    || pr.baseRefName !== base_branch) return refuse('published PR identity or head changed')
  const remote = await host(['git', '-C', run.repo_path, 'ls-remote', '--exit-code', 'origin', `refs/heads/${run.branch}`], run.repo_path)
  if (!remote.ok || remote.timed_out || remote.stdout.trim() !== `${head}\trefs/heads/${run.branch}`) return refuse('remote branch does not hold the published head')
  return { repository, base_branch }
}

export function importedRecoveryCheckpoint(decision: OrchestratorRecoveryDecision, state: BuildModeState): BuildModeState {
  const c = state.checkpoint
  return { iteration: decision.task_iteration, checkpoint: {
    head: c.head, stage: 'built', round: c.round + 1, replansUsed: 1,
    previousFindings: [...c.reviewStop!.current.findings], previousBlockingCount: c.reviewStop!.current.blockingCount,
    previousReview: structuredClone(c.reviewStop!.current), reviewBaseline: 'required',
    findings: structuredClone(c.findings), remainingTasks: c.remainingTasks,
    orchestratorReplan: { direction: decision.request.direction },
  } }
}

/** The table is the one-use authority; an event or model-created checkpoint alone is not. */
export function readOrchestratorRecovery(store: TridentRunStore, run: TridentRun): BuildModeState | null {
  const event = store.stageEvents(run.id).filter(e => e.stage === ORCHESTRATOR_RECOVERY_STAGE).at(-1)
  const decision = store.orchestratorRecovery(run.id)
  if (!decision && !event) return null
  if (!decision || !event || JSON.stringify(decision) !== event.meta) return refuse('authorization record disagrees with its source event')
  const request = parseOrchestratorRecoveryRequest(decision.request)
  const source = store.get(request.source_run_id)
  const latest = source && store.stageEvents(source.id).filter(e => e.stage === 'build-mode-state').at(-1)
  if (!source || latest?.id !== request.source_event_id || latest.meta !== decision.source_meta
    || source.project_slug !== run.project_slug || source.repo_path !== run.repo_path || source.branch !== run.branch
    || source.task !== run.task || source.base_sha !== run.base_sha || source.execution_strategy !== run.execution_strategy
    || source.published_pr !== run.published_pr || run.published_pr !== request.published_pr
    || run.merge_mode !== 'pr' || run.bound_pr !== null || decision.authority.project_scope !== run.project_slug
    || run.task_iteration < decision.task_iteration || run.max_task_iterations > decision.max_task_iterations
    || run.max_rounds > decision.max_rounds) return refuse('authorized recovery identity or original source changed')
  const original = parseBuildModeState(decision.source_meta, source, true)
  if (original.checkpoint.stage !== 'rejected' || original.checkpoint.head !== request.expected_head
    || !original.checkpoint.reviewStop || original.checkpoint.replansUsed !== 0) return refuse('authorized source no longer has its rejected checkpoint')
  return importedRecoveryCheckpoint(decision, original)
}

/** An absent local branch may be reconstructed, never an existing different head. */
export async function prepareRecoveryBranch(run: TridentRun, head: string, host: EnvCapableHostRunner,
  expected?: Pick<OrchestratorRecoveryDecision, 'repository' | 'base_branch'>): Promise<void> {
  await verifyRecoveryRemote(run, head, host, expected)
  const assertBase = async () => {
    if (!run.base_sha || !oid.test(run.base_sha)) return refuse('original base is missing')
    const ancestry = await host(['git', '-C', run.repo_path, 'merge-base', '--is-ancestor', run.base_sha, head], run.repo_path)
    if (!ancestry.ok || ancestry.timed_out) return refuse('published implementation does not descend from its original base')
  }
  const local = await host(['git', '-C', run.repo_path, 'rev-parse', '--verify', `refs/heads/${run.branch}^{commit}`], run.repo_path)
  if (local.ok && !local.timed_out) {
    if (local.stdout.trim() !== head) return refuse('local branch moved from the authorized head')
    await assertBase()
    return
  }
  const absent = await host(['git', '-C', run.repo_path, 'show-ref', '--verify', '--quiet', `refs/heads/${run.branch}`], run.repo_path)
  if (absent.ok || absent.timed_out || absent.exit_code !== 1) return refuse('local branch is unreadable')
  const fetched = await host(['git', '-C', run.repo_path, 'fetch', '--no-tags', 'origin', `refs/heads/${run.branch}`], run.repo_path)
  const fetchedHead = await host(['git', '-C', run.repo_path, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}'], run.repo_path)
  if (!fetched.ok || fetched.timed_out || !fetchedHead.ok || fetchedHead.timed_out || fetchedHead.stdout.trim() !== head)
    return refuse('published head changed or could not be fetched')
  await verifyRecoveryRemote(run, head, host, expected)
  await assertBase()
  const restored = await host(['git', '-C', run.repo_path, 'update-ref', `refs/heads/${run.branch}`, head, ''], run.repo_path)
  if (!restored.ok || restored.timed_out) return refuse('branch reconstruction lost its compare-and-swap')
}
