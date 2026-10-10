import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { isDeepStrictEqual as equal } from 'node:util'
import type { BuildModeState } from './build-mode-state.ts'
import type { TridentRun, TridentRunStore } from './store.ts'
import { evidenceReader } from './settled-review-recovery.ts'
import { briefIntegrity } from './gates/brief-integrity.ts'
import { validateTrailer } from './gates/result-contract.ts'

/** A completed legacy worker whose measured instructions changed needs a new
 * step. This authorizes neither checkpoint import nor reusing its old result. */
export function invalidatedLegacyBuildSettled(store: TridentRunStore, run: TridentRun,
  eventId: number, state: BuildModeState): boolean {
  try {
    const pending = state.checkpoint.pending
    const recovery = pending?.recovery
    if (run.phase !== 'failed' || !pending || pending.phase !== 'build' || !recovery) return false
    const request = recovery.request
    const root = dirname(request.result.path)
    if (request.run_id !== run.id || request.step_id !== pending.step_id || request.role !== 'build'
      || request.writable !== true || request.tools !== 'edit-and-run' || request.result.schema !== 'project-build'
      || basename(root) !== encodeURIComponent(run.id) || request.result.path !== join(root, 'build.result')
      || request.brief.path !== join(root, 'build.strategy-v2.brief.build.host')
      || request.cwd !== (state as BuildModeState & { worktree?: string }).worktree) return false
    const events = store.stageEvents(run.id)
    const reconciled = events.filter(event => event.stage === 'build-legacy-brief-reconciled')
      .map(event => ({ id: event.id, meta: JSON.parse(event.meta ?? 'null') }))
      .filter(event => event.meta?.role === 'build').at(-1)
    const meta = reconciled?.meta
    if (!reconciled || reconciled.id <= eventId || meta?.decision !== 'invalidated' || meta.cause !== 'reflection'
      || !Array.isArray(meta.rendered) || meta.rendered.length !== 2
      || !meta.rendered.every((value: unknown) => typeof value === 'string' && /^[0-9]+:[a-f0-9]{8}$/.test(value) && value !== meta.stored)) return false

    const evidence = evidenceReader()
    evidence.directory(root)
    if (briefIntegrity(evidence.read(join(root, 'build.strategy-v2.brief'))) !== meta.stored
      || briefIntegrity(evidence.read(request.brief.path)) !== request.brief.integrity) return false
    const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const journal = JSON.parse(evidence.read(join(root, 'attempt-request-' + digest([run.id, request.step_id, 'dispatch']) + '.json')))
    const rows = store.attempts(run.id)
    const attempt = rows.find(row => row.step_id === request.step_id && row.attempt_id === 'dispatch')
    if (!attempt || attempt.role !== 'build' || attempt.outcome !== 'completed' || attempt.ended_at === null
      || attempt.prepared_at === null || attempt.started_at === null || attempt.resolved_model !== request.model_id
      || !equal(journal.request, request) || journal.provider !== attempt.provider || journal.placement !== attempt.placement
      || rows.some(row => row.ended_at === null)) return false
    const prefix = new Map([['anthropic', 'claude'], ['openai-codex', 'codex'], ['pi', 'pi']]).get(attempt.provider)
    if (!prefix || evidence.read(join(root, prefix + '-step-' + digest([run.id, request.step_id]) + '.json'))
      !== JSON.stringify(request) + '\n#dispatch-armed\n') return false
    const result = JSON.parse(evidence.read(request.result.path))
    if (result.kind !== 'completed' || result.run_id !== run.id || result.step_id !== request.step_id
      || result.schema !== request.result.schema || typeof result.result?.head !== 'string'
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result.result.head)) return false
    const payload = validateTrailer('forge', result.result?.payload)
    return payload.ok && payload.value.commitSha === result.result.head && payload.value.branch === run.branch
      && payload.value.worktreePath === request.cwd && payload.value.deviatedFromSpec !== true
      && evidence.stable() && equal(store.get(run.id), run) && equal(store.attempts(run.id), rows)
      && equal(store.stageEvents(run.id), events)
  } catch { return false }
}
