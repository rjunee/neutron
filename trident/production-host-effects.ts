import { mkdtemp, readFile, rm, writeFile, rename, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { BuildRunDeps, BuildSnapshot, GateResult, Measurement, BuildModeHost, ResumeCheckpoint } from './build-run.ts'
import type { CiRunObservation } from './ci-readiness.ts'
import { briefIntegrity } from './gates/brief-integrity.ts'
import type { AdmissionSource } from './gates/project-admission.ts'
import { pinnedMergeReadiness, publicationReadiness } from './gates/release-readiness.ts'
import { mergeLocalReviewed } from './merge.ts'
import { gitRangeArgv } from './git-range.ts'
import type { EnvCapableHostRunner } from './git-mode.ts'
import type { TridentRun, TridentRunStore } from './store.ts'
import { isTerminalPhase } from './state-machine.ts'

const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const unknown = (detail: string): GateResult => ({ kind: 'unknown', detail })
const blocked = (on: string): GateResult => ({ kind: 'blocked', on })

export interface ProductionHostOptions {
  store: TridentRunStore
  runId: string
  projectSlug: string
  repo: string
  worktree: string
  branch: string
  baseBranch: string
  runHost: EnvCapableHostRunner
  /** The required workflow, as configured by the project. */
  ciWorkflow: string
  publication: { title: string; bodyFile: string }
}

/** The brief remains immutable; each turn reads this host-written context file. */
export const workContextPath = (briefPath: string): string => `${briefPath}.context.json`

/** Additive host implementation. External write uncertainty is never a success. */
export function createProductionHostEffects(options: ProductionHostOptions) {
  const { store, runId, repo, worktree, branch, baseBranch, runHost } = options
  const git = (...args: string[]) => runHost(['git', '-C', repo, ...args], repo)
  function row(): TridentRun {
    const current = store.get(runId)
    if (!current || current.project_slug !== options.projectSlug || current.repo_path !== repo
      || current.worktree !== worktree || current.branch !== branch) {
      throw new Error('Build run identity, branch or worktree is missing or changed')
    }
    if (isTerminalPhase(current.phase)) throw new Error('Build run is terminal')
    return current
  }
  async function head(): Promise<string> {
    const result = await git('rev-parse', '--verify', `refs/heads/${branch}^{commit}`)
    if (!result.ok && !result.timed_out) {
      const exists = await git('show-ref', '--verify', '--quiet', `refs/heads/${branch}`)
      if (!exists.ok && !exists.timed_out && exists.exit_code === 1) return 'absent'
    }
    if (!result.ok || result.timed_out || !oid.test(result.stdout.trim())) throw new Error('Build branch head is unreadable')
    return result.stdout.trim()
  }
  async function readPr(current: TridentRun): Promise<BuildSnapshot['pr']> {
    if (current.merge_mode === 'local') {
      if (current.pr !== null) throw new Error('Local run unexpectedly has a persisted PR')
      return null
    }
    const fields = 'number,headRefOid,state,headRefName,baseRefName,isCrossRepository'
    const result = await runHost(current.pr === null
      ? ['gh', 'pr', 'list', '--head', branch, '--state', 'all', '--limit', '100', '--json', fields]
      : ['gh', 'pr', 'view', String(current.pr), '--json', fields], repo)
    if (!result.ok || result.timed_out) throw new Error('PR observation is unreadable')
    const parsed: unknown = JSON.parse(result.stdout)
    const candidates = current.pr === null ? parsed : [parsed]
    if (!Array.isArray(candidates) || candidates.length > 1) throw new Error('PR observation is ambiguous or malformed')
    if (candidates.length === 0) return null
    const pr = candidates[0]
    if (!pr || !Number.isSafeInteger(pr.number) || pr.number <= 0 || typeof pr.headRefOid !== 'string' || !oid.test(pr.headRefOid)
      || !['OPEN', 'CLOSED', 'MERGED'].includes(pr.state) || pr.headRefName !== branch
      || pr.baseRefName !== baseBranch || pr.isCrossRepository !== false
      || (current.pr !== null && current.pr !== pr.number)) throw new Error('PR identity or revision is malformed or mismatched')
    return { number: pr.number, head: pr.headRefOid, state: pr.state }
  }
  async function readDiff(base: string, tip: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'build-observation-'))
    try {
      const output = join(directory, 'change.diff')
      const result = await runHost(gitRangeArgv({ repo_path: repo, subcommand: 'diff',
        flags: ['--binary', '--no-ext-diff', '--no-textconv', '--full-index', `--output=${output}`],
        base, head: tip, dots: '...',
      }), repo)
      if (!result.ok || result.timed_out) throw new Error('Pinned build diff is unreadable')
      return await readFile(output, 'utf8')
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
  async function measure(): Promise<Measurement> {
    try {
      const current = row()
      if (!current.base_sha || !oid.test(current.base_sha)) throw new Error('Pinned launch base is missing')
      const tip = await head()
      if (tip === 'absent') return { kind: 'known', value: { head: tip, diff: '', pr: await readPr(current) } }
      const checkedOut = await runHost(['git', '-C', worktree, 'rev-parse', '--verify', 'HEAD^{commit}'], worktree)
      if (!checkedOut.ok || checkedOut.timed_out || checkedOut.stdout.trim() !== tip) throw new Error('Worktree head does not match the build branch')
      const diff = await readDiff(current.base_sha, tip)
      const pr = await readPr(current)
      if (await head() !== tip) throw new Error('Build branch moved during measurement')
      const after = row()
      if (after.base_sha !== current.base_sha || after.pr !== current.pr || after.merge_mode !== current.merge_mode) throw new Error('Persisted pins changed during measurement')
      return { kind: 'known', value: { head: tip, diff, pr } }
    } catch (error) { return { kind: 'unknown', detail: String(error) } }
  }
  type ModeState = { checkpoint: ResumeCheckpoint; iteration: number; consumed?: { round: number; head: string } }
  let modeVersion: number | null = null
  let modeState: ModeState | null = null
  const latestModeEvent = () => store.stageEvents(runId).filter(event => event.stage === 'build-mode-state').at(-1)
  function readModeState(): ModeState | null {
    row()
    const event = latestModeEvent()
    if (!event) return null
    const state = JSON.parse(event.meta ?? 'null')
    const c = state?.checkpoint
    if (state?.runId !== runId || state?.branch !== branch || state?.base !== row().base_sha || state.repo !== repo || state.worktree !== worktree || state.projectSlug !== options.projectSlug || state.mergeMode !== row().merge_mode
      || !Number.isSafeInteger(state.iteration) || state.iteration < 0
      || !c || (c.head !== null && (typeof c.head !== 'string' || !oid.test(c.head)))
      || !['built', 'approved', 'rejected', 'fixed', 'ralph-task-built', 'ralph-task-built-deviated'].includes(c.stage)
      || !Number.isSafeInteger(c.round) || c.round < 0 || ![0, 1].includes(c.replansUsed)
      || !Array.isArray(c.findings) || !c.findings.every((f: any) => f && ['code', 'lane'].includes(f.kind) && typeof f.actionable === 'boolean' && typeof f.text === 'string')
      || !Array.isArray(c.previousFindings) || !c.previousFindings.every((f: unknown) => typeof f === 'string')
      || (c.previousBlockingCount !== undefined && (!Number.isSafeInteger(c.previousBlockingCount) || c.previousBlockingCount < 0))
      || (state.consumed !== undefined && (!Number.isSafeInteger(state.consumed?.round) || state.consumed.round < 0
        || typeof state.consumed.head !== 'string' || !oid.test(state.consumed.head)))
      || (c.pending !== undefined && (!c.pending || !['plan', 'build', 'review', 'fix'].includes(c.pending.phase) || typeof c.pending.step_id !== 'string' || !c.pending.step_id.startsWith(`${runId}:`)))) {
      throw new Error('Host mode checkpoint is missing valid identity or state')
    }
    modeVersion = event.id
    return state
  }
  async function saveModeState(state: ModeState) {
    const current = row()
    const saved = await store.appendBuildModeState(runId, modeVersion,
      JSON.stringify({ ...state, runId, branch, base: current.base_sha, repo, worktree, projectSlug: options.projectSlug, mergeMode: current.merge_mode }))
    if (!saved) throw new Error('Host mode checkpoint changed concurrently or run stopped')
    modeVersion = saved
    modeState = structuredClone(state)
  }
  const modes: BuildModeHost = {
    async loadResume() {
      modeState = readModeState()
      if (!modeState) throw new Error('Host resume checkpoint is missing')
      return structuredClone(modeState.checkpoint)
    },
    async saveCheckpoint(checkpoint) {
      await saveModeState({ ...modeState, checkpoint, iteration: modeState?.iteration ?? row().ralph_round })
    },
    async regenerateDiff(tip) {
      try {
        const base = row().base_sha
        if (!base || !oid.test(base) || !oid.test(tip)) throw new Error('Resume diff requires full base and head')
        return { kind: 'known', diff: await readDiff(base, tip) }
      } catch (error) { return { kind: 'unknown', detail: String(error) } }
    },
    async probePlan(tip) {
      row()
      if (!oid.test(tip)) throw new Error('Committed plan requires a full head')
      const directory = await mkdtemp(join(tmpdir(), 'build-plan-'))
      try {
        // File output avoids the host runner's stdout truncation boundary.
        const path = join(directory, 'plan.tar')
        const result = await runHost(['git', '-C', repo, 'archive', '--format=tar', `--output=${path}`, tip, 'IMPLEMENTATION_PLAN.md'], repo)
        if (!result.ok || result.timed_out) throw new Error('Committed plan is missing or unreadable')
        const extracted = await runHost(['tar', '-xf', path, '-C', directory, 'IMPLEMENTATION_PLAN.md'], repo)
        if (!extracted.ok || extracted.timed_out) throw new Error('Committed plan extraction is unreadable')
        const planPath = join(directory, 'IMPLEMENTATION_PLAN.md')
        if (!(await lstat(planPath)).isFile()) throw new Error('Committed plan is not a regular file')
        const body = await readFile(planPath, 'utf8')
        const blob = await git('rev-parse', '--verify', `${tip}:IMPLEMENTATION_PLAN.md`)
        const expected = blob.stdout.trim()
        // Archive attributes may transform content. Only the exact committed blob
        // may supply the continuation planner's independently measured bytes.
        if (!blob.ok || blob.timed_out || !oid.test(expected) || createHash(expected.length === 40 ? 'sha1' : 'sha256')
          .update(`blob ${Buffer.byteLength(body)}\0`).update(body).digest('hex') !== expected) throw new Error('Committed plan blob could not be verified')
        return { found: true, body, sha256: createHash('sha256').update(body).digest('hex'),
          uncheckedCount: body.split('\n').filter(line => /^\s*- \[ \]\s+/.test(line)).length }
      } finally { await rm(directory, { recursive: true, force: true }) }
    },
    async advanceRalph(value) {
      try {
        const current = row()
        const observed = await sameSnapshot(value.snapshot)
        if (observed.kind !== 'allow') return observed
        if (value.run_id !== runId || !current.ralph || !Number.isSafeInteger(value.round)
          || value.round < 0 || !Number.isSafeInteger(value.remainingTasks) || value.remainingTasks <= 0) return unknown('Ralph handoff identity or count is missing')
        const state = readModeState()
        if (!state) return unknown('Ralph build checkpoint is missing')
        if (state.consumed?.round === value.round && state.consumed.head === value.snapshot.head) return { kind: 'allow' }
        if (state.iteration !== value.round || state.checkpoint.pending || state.checkpoint.stage !== 'built'
          || state.checkpoint.head !== value.snapshot.head) return unknown('Ralph handoff does not match the completed build')
        await saveModeState({ iteration: value.round + 1, consumed: { round: value.round, head: value.snapshot.head },
          checkpoint: { ...state.checkpoint, stage: 'ralph-task-built', round: 0 } })
        return { kind: 'allow' }
      } catch (error) { return unknown(String(error)) }
    },
  }
  function ralphIteration() { return readModeState()?.iteration ?? row().ralph_round }
  async function observeCi(snapshot: BuildSnapshot): Promise<CiRunObservation> {
    try {
      row()
      if (!options.ciWorkflow || !oid.test(snapshot.head)) throw new Error('CI workflow or full head is missing')
      const result = await runHost(['gh', 'run', 'list', '--workflow', options.ciWorkflow, '--commit', snapshot.head,
        '--limit', '1', '--json', 'headSha,status,conclusion'], repo)
      if (!result.ok || result.timed_out) throw new Error('CI run could not be read')
      const runs: unknown = JSON.parse(result.stdout)
      if (!Array.isArray(runs) || runs.length > 1) throw new Error('CI response is malformed')
      if (runs.length === 0) return { kind: 'absent' }
      const run = runs[0]
      if (!run || typeof run.headSha !== 'string' || !oid.test(run.headSha) || !['queued', 'in_progress', 'waiting', 'pending', 'requested', 'completed'].includes(run.status)) throw new Error('CI run identity or status is missing')
      if (run.status !== 'completed') return { kind: 'running', headSha: run.headSha }
      if (!['success', 'failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped', 'stale', 'startup_failure'].includes(run.conclusion)) throw new Error('CI conclusion is missing')
      return { kind: 'completed', headSha: run.headSha, conclusion: run.conclusion === 'success' ? 'success' : 'failure' }
    } catch (error) { return { kind: 'unreadable', reason: String(error) } }
  }
  const admission: AdmissionSource = {
    run: runHost,
    async observe(input) {
      if (input.run_id !== runId) return null
      const current = row()
      return { runId, repo, branch, baseBranch, prior: current.base_sha
        ? { base: current.base_sha, head: current.inner_checkpoint_head } : null }
    },
  }
  async function sameSnapshot(snapshot: BuildSnapshot): Promise<GateResult> {
    const observed = await measure()
    if (observed.kind === 'unknown') return unknown(observed.detail)
    const value = observed.value
    if (value.head !== snapshot.head || value.diff !== snapshot.diff
      || (value.pr === null ? snapshot.pr !== null : snapshot.pr === null
        || value.pr.number !== snapshot.pr.number || value.pr.head !== snapshot.pr.head || value.pr.state !== snapshot.pr.state)) return blocked('Host observation changed since the gate')
    return { kind: 'allow' }
  }
  async function publishChecked(snapshot: BuildSnapshot): Promise<GateResult> {
    try {
      const current = row()
      if (current.merge_mode !== 'pr') return blocked('Publication requires PR mode')
      const fresh = await sameSnapshot(snapshot)
      if (fresh.kind !== 'allow') return fresh
      const ready = await publicationReadiness(runHost, repo, branch, current.base_sha!, snapshot)
      if (ready.kind !== 'allow') return ready
      const remote = await git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`)
      if (!remote.ok || remote.timed_out) return unknown('Publication lease is unreadable')
      const lines = remote.stdout.trim()
      const expected = lines === '' ? '' : lines.split(/\s+/)[0]!
      if (lines !== '' && (!oid.test(expected) || lines.split(/\s+/).length !== 2 || lines.split(/\s+/)[1] !== `refs/heads/${branch}`)) return unknown('Publication lease is malformed')
      const pushed = await git('push', `--force-with-lease=refs/heads/${branch}:${expected}`, 'origin', `${snapshot.head}:refs/heads/${branch}`)
      if (!pushed.ok || pushed.timed_out) return unknown('Publication push was not confirmed')
      const witness = await git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`)
      if (!witness.ok || witness.timed_out || witness.stdout.trim().split(/\s+/).join(' ') !== `${snapshot.head} refs/heads/${branch}`) return unknown('Published head was not witnessed')
      let pr = await readPr(current)
      if (pr === null) {
        const created = await runHost(['gh', 'pr', 'create', '--head', branch, '--base', baseBranch,
          '--title', options.publication.title, '--body-file', options.publication.bodyFile], repo)
        if (!created.ok || created.timed_out) return unknown('PR creation was not confirmed')
        pr = await readPr(current)
      }
      if (!pr || pr.state !== 'OPEN' || pr.head !== snapshot.head) return unknown('Published PR does not match the reviewed head')
      if (!await store.update(runId, { pr: pr.number })) return unknown('Published PR could not be persisted')
      return { kind: 'allow' }
    } catch (error) { return unknown(String(error)) }
  }
  async function mergeChecked(snapshot: BuildSnapshot): Promise<GateResult> {
    try {
      const current = row()
      const fresh = await sameSnapshot(snapshot)
      if (fresh.kind !== 'allow') return fresh
      if (current.merge_mode === 'local') return mergeLocalReviewed(runHost, repo, branch, baseBranch, worktree, snapshot.head)
      const ready = await pinnedMergeReadiness(runHost, repo, snapshot)
      if (ready.kind !== 'allow') return ready
      // gh pr merge exposes --match-head-commit, but no expected-base option.
      // Readiness above is an observation, not an atomic base precondition:
      // the remote base can move before GitHub accepts this merge. Persist that
      // limitation before writing; neither the head pin nor the merged witness
      // below proves the base stayed fixed. This event is not a merge result.
      try {
        await store.recordStageEvent(runId, 'build-remote-merge-attempt', JSON.stringify({
          pr: snapshot.pr!.number,
          head: snapshot.head,
          baseBranch,
          basePrecondition: 'not-enforced',
          detail: 'Remote base may move between readiness assessment and merge; only the head is pinned',
        }))
      } catch {
        return unknown('Remote merge base-risk evidence could not be persisted')
      }
      const result = await runHost(['gh', 'pr', 'merge', String(snapshot.pr!.number), '--squash',
        '--match-head-commit', snapshot.head], repo)
      if (!result.ok || result.timed_out) return unknown('Pinned PR merge was not confirmed')
      const pr = await readPr(current)
      if (pr?.state !== 'MERGED' || pr.number !== snapshot.pr!.number || pr.head !== snapshot.head) return unknown('Merged PR was not witnessed')
      return { kind: 'allow' }
    } catch (error) { return unknown(String(error)) }
  }
  const requireAllow = async (gate: Promise<GateResult>) => {
    const result = await gate
    if (result.kind !== 'allow') throw new Error(result.kind === 'unknown' ? result.detail : result.on)
  }
  const effects: Pick<BuildRunDeps, 'prepareWork' | 'measure' | 'publish' | 'merge'> = {
    measure,
    async prepareWork(request, context) {
      row()
      if (request.run_id !== runId || request.cwd !== worktree) throw new Error('Worker request does not belong to this build')
      const brief = await readFile(request.brief.path, 'utf8')
      if (briefIntegrity(brief) !== request.brief.integrity || !brief.includes(workContextPath(request.brief.path))) throw new Error('Worker brief lacks its verified host context reference')
      const fresh = await sameSnapshot(context.snapshot)
      if (fresh.kind !== 'allow') throw new Error('Worker preparation could not verify the current snapshot')
      const path = workContextPath(request.brief.path)
      const temporary = `${path}.tmp`
      await writeFile(temporary, JSON.stringify({ request, ...context }), { mode: 0o600 })
      await rename(temporary, path)
      await store.recordStageEvent(runId, 'build-work-prepared', JSON.stringify({ step_id: request.step_id, head: context.snapshot.head }))
    },
    publish: snapshot => requireAllow(publishChecked(snapshot)),
    merge: snapshot => requireAllow(mergeChecked(snapshot)),
  }
  return { effects, modes, ralphIteration, admission, observeCi, publishChecked, mergeChecked }
}
