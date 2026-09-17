import { mkdtemp, readFile, rm, writeFile, rename, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { BuildRunDeps, BuildSnapshot, GateResult, Measurement, BuildModeHost, ResumeCheckpoint } from './build-run.ts'
import { classifyCiRollup, confirmConfigurationError, type CiRunObservation, type RequiredCheckObservation } from './ci-readiness.ts'
import { briefIntegrity } from './gates/brief-integrity.ts'
import type { AdmissionSource } from './gates/project-admission.ts'
import { pinnedMergeReadiness, publicationReadiness } from './gates/release-readiness.ts'
import { unknownCause } from './gates/unknown-cause.ts'
import { mergeLocalReviewed } from './merge.ts'
import { gitRangeArgv } from './git-range.ts'
import type { EnvCapableHostRunner } from './git-mode.ts'
import type { TridentRun, TridentRunStore } from './store.ts'
import { isTerminalPhase } from './state-machine.ts'
import { TRIDENT_SCRIPT_DIR } from './script-dir.ts'

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
  /** The repo's declared workflow; undefined means CI configuration is unknown. */
  ciWorkflow: string | undefined
  ciSource?: ProductionCiSource
  ciNow?: () => number
  publication: (snapshot: BuildSnapshot) => Promise<{ title: string; bodyFile: string }>
}

export interface ProductionCiSource {
  required(baseBranch: string): Promise<RequiredCheckObservation>
  readiness(pr: number): Promise<{ headSha: unknown; mergeable: unknown; rows: unknown; checksComplete?: boolean } | { unreadable: string }>
}

export type CleanupOutcome =
  | { kind: 'cleaned'; detail: string }
  | { kind: 'preserved'; detail: string }
  | { kind: 'failed'; detail: string }

const CI_CONFIGURATION_GRACE_MS = 600_000
const missingResponse = (result: { exit_code: number; stderr: string; stdout: string }) =>
  result.exit_code === 1 && /(?:HTTP 404|Not Found|Branch not protected)/i.test(`${result.stdout}\n${result.stderr}`)

/** Credentialed GitHub acquisition; command results remain distinguishable from empty payloads. */
export function productionCiSource(run: EnvCapableHostRunner, repo: string): ProductionCiSource {
  const api = (path: string) => run(['gh', 'api', path], repo)
  const json = (text: string): unknown => JSON.parse(text)
  const names = (result: Awaited<ReturnType<typeof api>>, field: 'check_runs' | 'statuses', name: 'name' | 'context'): string[] | null => {
    if (!result.ok || result.timed_out) return null
    const value: any = json(result.stdout)
    if (!value || !Number.isSafeInteger(value.total_count) || !Array.isArray(value[field])) return null
    const out = value[field].map((row: any) => row?.[name])
    return out.every((entry: unknown) => typeof entry === 'string') && out.length === value.total_count ? out : null
  }
  return {
    async required(base) {
      try {
        const encoded = encodeURIComponent(base)
        const [protection, branch, rules, runs, statuses] = await Promise.all([
          api(`repos/{owner}/{repo}/branches/${encoded}/protection/required_status_checks`),
          api(`repos/{owner}/{repo}/branches/${encoded}`),
          api(`repos/{owner}/{repo}/rules/branches/${encoded}`),
          api(`repos/{owner}/{repo}/commits/${encoded}/check-runs?per_page=100`),
          api(`repos/{owner}/{repo}/commits/${encoded}/status?per_page=100`),
        ])
        const required: string[] = []
        const appBound: string[] = []
        const add = (entry: any) => {
          const context = typeof entry === 'string' ? entry : entry?.context
          if (typeof context !== 'string' || context === '') return
          if (!required.includes(context)) required.push(context)
          const binding = entry?.app_id ?? entry?.appId ?? entry?.integration_id
          if (binding !== undefined && binding !== null && binding !== -1 && !appBound.includes(context)) appBound.push(context)
        }
        let branchValue: any = null
        if (branch.ok && !branch.timed_out) branchValue = json(branch.stdout)
        if (protection.ok && !protection.timed_out) {
          const value: any = json(protection.stdout)
          if (!value || !Array.isArray(value.contexts) || !Array.isArray(value.checks)) throw new Error('classic protection payload is malformed')
          value.contexts.forEach(add); value.checks.forEach(add)
        } else if (missingResponse(protection)) {
          const contexts = branchValue?.protection?.required_status_checks?.contexts
          const checks = branchValue?.protection?.required_status_checks?.checks
          if (Array.isArray(contexts)) contexts.forEach(add)
          if (Array.isArray(checks)) checks.forEach(add)
        } else return { kind: 'unknown', reason: 'classic protection could not be read' }
        if (rules.ok && !rules.timed_out) {
          const value: any = json(rules.stdout)
          if (!Array.isArray(value)) throw new Error('rules payload is malformed')
          for (const rule of value) if (rule?.type === 'required_status_checks') {
            const checks = rule?.parameters?.required_status_checks
            if (!Array.isArray(checks)) throw new Error('required rules payload is malformed')
            checks.forEach(add)
          }
        } else if (!missingResponse(rules)) return { kind: 'unknown', reason: 'branch rules could not be read' }
        else if (missingResponse(protection) && branchValue?.protected !== false
          && branchValue?.protection?.enabled !== false && required.length === 0) {
          return { kind: 'unknown', reason: 'neither protection source nor independent branch evidence established required checks' }
        }
        const runNames = names(runs, 'check_runs', 'name')
        const statusNames = names(statuses, 'statuses', 'context')
        return { kind: 'resolved', required, appBound, produced: runNames === null || statusNames === null
          ? null : [...new Set([...runNames, ...statusNames])] }
      } catch (error) { return { kind: 'unknown', reason: String(error) } }
    },
    async readiness(pr) {
      try {
        const result = await run(['gh', 'pr', 'view', String(pr), '--json', 'headRefOid,mergeable'], repo)
        if (!result.ok || result.timed_out) return { unreadable: 'PR readiness could not be read' }
        const value: any = json(result.stdout)
        if (typeof value?.headRefOid !== 'string' || !oid.test(value.headRefOid)) return { unreadable: 'PR head is malformed' }
        // Read both lists at the measured revision. A bounded page is evidence only
        // when its authoritative count equals its length; never infer a count.
        const readList = async (path: string, field: 'check_runs' | 'statuses'): Promise<unknown[] | null> => {
          try {
            const result = await api(path)
            if (!result.ok || result.timed_out) return null
            const payload: any = json(result.stdout)
            return payload && Number.isSafeInteger(payload.total_count) && Array.isArray(payload[field])
              && payload.total_count === payload[field].length ? payload[field] : null
          } catch { return null }
        }
        const [runs, statuses] = await Promise.all([
          readList(`repos/{owner}/{repo}/commits/${value.headRefOid}/check-runs?per_page=100`, 'check_runs'),
          readList(`repos/{owner}/{repo}/commits/${value.headRefOid}/status?per_page=100`, 'statuses'),
        ])
        const checksComplete = runs !== null && statuses !== null
        return { headSha: value.headRefOid, mergeable: value.mergeable, checksComplete,
          rows: checksComplete ? [...runs!, ...statuses!] : [] }
      } catch (error) { return { unreadable: String(error) } }
    },
  }
}

/** The brief remains immutable; each turn reads this host-written context file. */
export const workContextPath = (briefPath: string): string => `${briefPath}.context.json`

/** Additive host implementation. External write uncertainty is never a success. */
export function createProductionHostEffects(options: ProductionHostOptions) {
  const { store, runId, repo, worktree, branch, baseBranch, runHost } = options
  const cleanupMode = store.get(runId)?.merge_mode
  const git = (...args: string[]) => runHost(['git', '-C', repo, ...args], repo)
  function row(): TridentRun {
    const current = store.get(runId)
    // NAME THE FIELD, NOT THE CATEGORY. This guard compares four things, and the
    // message used to name all four with no way to tell which one moved — so a live
    // failure said "identity, branch or worktree is missing or changed" and left the
    // operator to guess. That cost a whole acceptance dispatch on 2026-09-15: by the
    // time the row could be inspected, cleanup had already nulled `worktree`, so the
    // post-hoc state could not distinguish the field that actually mismatched from one
    // mutated afterwards.
    //
    // The VALUES are deliberately not interpolated — they are filesystem paths, and this
    // string reaches `inner_result` and the owner's chat. The field name is the fact that
    // changes what you do next; the path is not.
    if (!current) throw new Error('Build run row is missing')
    const moved = (['project_slug', 'repo_path', 'worktree', 'branch'] as const).filter(field =>
      current[field] !== ({ project_slug: options.projectSlug, repo_path: repo, worktree, branch })[field])
    if (moved.length > 0) {
      throw new Error(`Build run identity changed: ${moved.join(', ')} no longer match${moved.length === 1 ? 'es' : ''} the bound build`)
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
  const ciSource = options.ciSource ?? productionCiSource(runHost, repo)
  const ciNow = options.ciNow ?? Date.now
  let missingSince: number | null = null
  async function observeCi(snapshot: BuildSnapshot): Promise<CiRunObservation> {
    try {
      row()
      if (typeof options.ciWorkflow !== 'string' || options.ciWorkflow.trim() === '') throw new Error('Repository CI workflow is missing from project-repos.json')
      if (!oid.test(snapshot.head) || !snapshot.pr) throw new Error('CI PR or full head is missing')
      const [config, readiness] = await Promise.all([ciSource.required(baseBranch), ciSource.readiness(snapshot.pr.number)])
      if ('unreadable' in readiness) throw new Error(readiness.unreadable)
      if (readiness.headSha !== snapshot.head) throw new Error('CI readiness head is missing or mismatched')
      const elapsed = missingSince === null ? 0 : Math.max(0, ciNow() - missingSince)
      const classify = (value: RequiredCheckObservation) => classifyCiRollup(snapshot.head, readiness.mergeable, readiness.rows, value, elapsed, CI_CONFIGURATION_GRACE_MS)
      let observed = classify(config)
      if (observed.kind === 'absent' && missingSince === null) missingSince = ciNow()
      if (observed.kind === 'configuration-error') observed = confirmConfigurationError(observed,
        await ciSource.required(baseBranch), fresh => classify(fresh))
      if (observed.kind !== 'absent') missingSince = null
      return observed
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
      const ready = await publicationReadiness(runHost, repo, branch, current.base_sha!, snapshot, runId)
      if (ready.kind !== 'allow') return ready
      const publication = await options.publication(snapshot)
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
          '--title', publication.title, '--body-file', publication.bodyFile], repo)
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
      if (current.merge_mode === 'local') return mergeLocalReviewed(runHost, repo, branch, baseBranch, worktree, snapshot.head, runId)
      const ready = await pinnedMergeReadiness(runHost, repo, snapshot, runId)
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
      } catch (error) {
        return unknownCause('Remote merge base-risk evidence could not be persisted', error, runId)
      }
      const result = await runHost(['gh', 'pr', 'merge', String(snapshot.pr!.number), '--squash',
        '--match-head-commit', snapshot.head], repo)
      if (!result.ok || result.timed_out) return unknown('Pinned PR merge was not confirmed')
      const pr = await readPr(current)
      if (pr?.state !== 'MERGED' || pr.number !== snapshot.pr!.number || pr.head !== snapshot.head) return unknown('Merged PR was not witnessed')
      return { kind: 'allow' }
    } catch (error) { return unknown(String(error)) }
  }
  async function cleanup(): Promise<CleanupOutcome> {
    try {
      if (cleanupMode !== 'pr' && cleanupMode !== 'local') return { kind: 'failed', detail: 'Cleanup mode is missing' }
      const mode = cleanupMode === 'pr' ? 'delete-branch' : 'keep-branch'
      const result = await runHost(['bash', join(TRIDENT_SCRIPT_DIR, 'worktree-cleanup.sh'), repo, branch, mode], repo)
      const detail = [result.stdout, result.stderr].filter(Boolean).join('\n')
      const summary = result.stdout.match(/^RESULT preserved=(\d+) removed=(\d+)$/m)
      if (!result.timed_out && result.ok && result.exit_code === 0 && summary?.[1] === '0') return { kind: 'cleaned', detail }
      if (!result.timed_out && !result.ok && result.exit_code === 3 && summary && Number(summary[1]) > 0) return { kind: 'preserved', detail }
      return { kind: 'failed', detail: detail || `Cleanup returned exit ${result.exit_code} without evidence` }
    } catch (error) {
      return { kind: 'failed', detail: String(error) }
    }
  }
  const requireAllow = async (gate: Promise<GateResult>) => {
    const result = await gate
    if (result.kind !== 'allow') throw new Error(result.kind === 'unknown' ? result.detail : result.on)
  }
  const effects: Pick<BuildRunDeps, 'prepareWork' | 'measure' | 'publish' | 'merge' | 'recordReviewApproval'> = {
    measure,
    async recordReviewApproval() {
      row()
      await store.update(runId, { inner_verdict: 'APPROVE' })
    },
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
  return { effects, modes, ralphIteration, admission, observeCi, publishChecked, mergeChecked, cleanup }
}
