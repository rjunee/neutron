import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { spawnCapture, type HostCommandResult } from './git-mode.ts'
import type { FireOutcome, InnerLoopInput } from './inner-loop.ts'
import { parseCheckpointFindings } from './checkpoint-findings.ts'
import {
  FIRE_PUBLISHED_REASON_MARKER,
  FIRE_SETTLE_TIMEOUT_ERROR,
  pickWorkflowOwned,
} from './fire-evidence.ts'
import { buildSimFirer, SIM_REVIEWED_HEAD, type SimPlan, buildSimMutationProofGate } from './inner-loop-sim.ts'
import { interpretFailure } from './delivery.ts'
import {
  buildTridentOrchestrator,
  isInfraDeath,
  isTridentHarvestTerminal,
  remoteAlreadyAtPublishHead,
  resolveClaimedCommit,
  sanitizeLeakAnnotation,
  resolveResumeLiveHead,
  RESUME_HEAD_RETRY_DELAYS_MS,
  sweepStrandedFailures,
} from './orchestrator.ts'
import {
  NO_NOMINATION_REFUSAL,
  parseMutationClaim,
  type MutationGateInput,
  type MutationGateOutcome,
} from './mutation-prover.ts'
import { mutationClaimArtifactPath } from './mutation-claim-artifact.ts'
import { MAX_CONFLICT_ROUNDS, runWorktreePath } from './merge.ts'
import { isTerminalPhase } from './state-machine.ts'
import { TridentRunStore, type MergeMode, type TridentRun } from './store.ts'
import { TridentTickLoop, type TridentTerminalHook } from './tick.ts'
import { NexusStore } from '@neutronai/gateway/nexus/nexus-store.ts'
import { emitTridentTerminalEvents } from '@neutronai/gateway/nexus/nexus-emit.ts'
import { buildTestStrategyDetail, readHostBudget } from './test-strategy.ts'
import { buildTridentDelivery, composeTerminalDelivery, type OutboundSink } from './delivery.ts'
import { makeTridentRun } from './testing/make-trident-run.ts'

/**
 * Trident v2 (Work Board Phase 2a exec-model) — the orchestrator step now FIRES
 * one CC Dynamic Workflow per run (the launching turn settles immediately) and
 * HARVESTS the workflow's TYPED terminal result from `code_trident_runs.
 * inner_result` by runId, server-gating a merge-eligible APPROVE against the
 * recorded `inner_checkpoint='argus-approved'`. These tests inject a FAKE firer
 * (`buildSimFirer`) whose simulated workflow writes its result to the DB on a
 * `complete()` drain — no live `claude` / `Workflow` tool.
 */

let tmp: string
let db: ProjectDb
let store: TridentRunStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-trident-orch-'))
  seedMigratedDb(join(tmp, 'project.db'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  store = new TridentRunStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const ok = (stdout = ''): HostCommandResult => ({ ok: true, stdout, stderr: '', exit_code: 0 })

/** The PR-mode replay runs `sh -c 'gh pr diff <n> > "<file>"'` — the bytes go to DISK, never
 *  through a captured string, because `spawnCapture` trims and a trim silently truncates a patch
 *  whose last line is context for a blank line (run 63b16fb1, `corrupt patch at line 746`). The
 *  stub therefore has to honour the redirect: returning the diff as stdout would fake a contract
 *  the production path deliberately no longer uses. */
const ghPrDiffTo = (joined: string, body: string): HostCommandResult => {
  const target = joined.match(/>\s*"([^"]+)"\s*$/)?.[1]
  if (target === undefined) throw new Error(`gh pr diff was not redirected to a file: ${joined}`)
  writeFileSync(target, body)
  return ok('')
}

/**
 * The DEFAULT host answers the #542 drift probes as a healthy repo whose base
 * has NOT moved: every ref resolves and the fork point IS the base tip. A host
 * that answers `rev-parse` with an empty string is not a neutral stub — it is a
 * repo the gate cannot assess, which pr mode now HOLDS on (it has no loud local
 * failure to fall back on, since `gh pr merge` runs on GitHub). Tests about
 * anything other than drift want a repo the gate can actually read.
 */
const NO_DRIFT_SHA = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f'
const driftFreeHost = (cmd: string[]): HostCommandResult =>
  (cmd.includes('rev-parse') && cmd.includes('--verify')) || cmd.includes('merge-base')
    ? ok(NO_DRIFT_SHA)
    : // …and the PR's head lives in THIS repository, not a fork, on the base it
      // says it targets. pr mode cannot score a fork head against `origin` (so
      // it holds one) and will not guess a base GitHub declines to name — a stub
      // that answers this probe with an empty string reads as both.
      cmd.includes('headRefName,baseRefName,isCrossRepository')
      ? ok('feat-x\nmain\nfalse')
      : ok()

interface Harness {
  loop: TridentTickLoop
  step: import('./orchestrator.ts').TridentStep
  /** Flush queued workflow completions (write their `inner_result` to the DB). */
  complete: () => Promise<void>
  hostCalls: string[][]
  inputs: InnerLoopInput[]
  /** RALPH RE-FIRE (#362) — every atomic reset patch `persist_refire_reset` was
   *  called with (assert the crash-safe bundle: inner_result + slot + ralph_round). */
  refirePatches: import('./store.ts').TridentRunUpdate[]
}

function buildHarness(opts: {
  prove_mutation?: Parameters<typeof buildTridentOrchestrator>[0]['prove_mutation']
  plan: (input: InnerLoopInput) => SimPlan
  hostResponder?: (cmd: string[]) => HostCommandResult
  on_orphaned_session?: 'redispatch' | 'wait' | 'fail'
  mint_run_id?: () => string
  now?: () => string
  max_inflight_ms?: number
  no_advance_hang_ms?: number
  latest_stage_event_at?: (run_id: string) => string | null
  probe_run_alive?: (run: TridentRun) => 'alive' | 'dead' | 'unknown' | Promise<'alive' | 'dead' | 'unknown'>
  gather_run_evidence?: import('./run-evidence.ts').RunEvidenceGatherer
  gather_fire_evidence?: import('./fire-evidence.ts').FireEvidenceGatherer
  probe_branch_holder?: (
    repo_path: string,
    branch: string,
  ) => Promise<import('./fire-evidence-probes.ts').BranchHolderProbe | null>
  codex_home?: string | null
  resolve_codex_home?: (run: TridentRun) => string | null
  resolve_reflection_context?: (run: TridentRun) => string | null
  resolve_active_runs?: () => number
  record_stage?: (run_id: string, stage: string, meta?: string | null) => void
  resolve_conflict?: import('./merge.ts').MergeConflictResolver
  fix_leak_findings?: import('./leak-preflight.ts').LeakPreflightFixer
  fold_as_built?: (
    run: TridentRun,
    base: string,
  ) => Promise<import('./as-built-appender.ts').FoldStagedAsBuiltEntriesResult>
  merge_deps?: import('./git-mode.ts').MergeCleanupDeps
  on_terminal?: TridentTerminalHook
  /** null exercises production base detection instead of the usual deterministic test base. */
  base_branch?: string | null
  /** Local build ref returned to launch's pre-fire leftover-branch probe; absent by default. */
  local_branch_tip?: string | null
}): Harness {
  const hostCalls: string[][] = []
  const refirePatches: import('./store.ts').TridentRunUpdate[] = []
  const now = opts.now ?? (() => new Date(0).toISOString())
  // Bind the store to the SAME clock as the orchestrator so `last_advanced_at`
  // (re-stamped by store.save) and the orchestrator's stall computation share one
  // time base — production runs both on wall-clock; the tests run both on the
  // fake clock (mismatched clocks would make `elapsedSinceAdvance` meaningless).
  store = new TridentRunStore(db, now)
  const sim = buildSimFirer(db, store, opts.plan)
  const host = async (cmd: string[]): Promise<HostCommandResult> => {
    hostCalls.push(cmd)
    const joined = cmd.join(' ')
    // THE DEPTH PROBE IS STUBBABLE, and defaults to a COMPLETE checkout. The launch ancestry
    // guard reads it to decide whether `merge-base --is-ancestor` exit 1 is a proven "no" or a
    // shallow boundary lying — so a scenario must be able to say "this clone is shallow". The
    // default stays 'false' because every pre-existing scenario means a complete history, and
    // an empty-but-ok answer from a catch-all responder is not an override, on the same terms
    // the gate's own probes use below.
    if (joined.includes('rev-parse --is-shallow-repository')) {
      const depth = opts.hostResponder?.(cmd)
      return depth !== undefined && (!depth.ok || depth.stdout.trim() !== '') ? depth : ok('false')
    }
    // `^{commit}` EXCLUDED ON PURPOSE. Two different probes both open with
    // `rev-parse --verify --quiet refs/heads/…`: the launch path's local-tip
    // check (`orchestrator.ts:3090`, no suffix) and #542's ref resolution
    // (`merge.ts` → `revParseCommit`, which ALWAYS appends `^{commit}`).
    // Without the exclusion the gate's branch lookup gets this stub's exit-1
    // whenever a test leaves `local_branch_tip` unset; the gate then cannot
    // resolve the branch, fails closed, and the run ends `failed`.
    if (
      joined.includes('rev-parse --verify --quiet refs/heads/') &&
      !joined.includes('^{commit}')
    ) {
      return opts.local_branch_tip === undefined || opts.local_branch_tip === null
        ? { ok: false, stdout: '', stderr: '', exit_code: 1 }
        : ok(opts.local_branch_tip)
    }
    const stubbed = opts.hostResponder?.(cmd)
    // A responder's answer wins EXCEPT an empty-but-ok answer to one of the
    // gate's OWN probes. An unreadable ref is not a neutral stub — it is a repo
    // the gate cannot assess, which pr mode HOLDS on, so tests written before
    // #542 would fail on a hold they never meant to exercise.
    // A `^{commit}` resolution of a BARE SHA is the publish path resolving the
    // build's claimed commit, NOT the drift gate resolving a ref. Answering it
    // with a canned sha makes the publisher see claim≠branch and refuse, which
    // is a real guard doing its job against a stub that lied to it. The gate
    // only ever resolves NAMED refs (`origin/main^{commit}`,
    // `refs/heads/<branch>^{commit}`), so the ref shape discriminates cleanly.
    //
    // `merge-base` MUST stay in this list. Dropping it on the theory that an
    // unresolvable ref "fails open" costs 33 tests (vs 5 with it): the gate
    // fails CLOSED when materiality is unassessable, which is correct — it
    // guards `gh pr merge`, a SERVER-side call with no downstream check to catch
    // what it waves through, so "could not check" must never read as "checked
    // and fine".
    const resolvesBareSha = /\b[0-9a-f]{7,40}\^\{commit\}/.test(joined)
    const driftProbe =
      (joined.includes('^{commit}') && !resolvesBareSha) ||
      joined.includes('merge-base') ||
      joined.includes('headRefName,baseRefName,isCrossRepository')
    if (driftProbe && (stubbed === undefined || (stubbed.ok && stubbed.stdout.trim() === ''))) {
      // Board-shaped PR runs pin before every first fire; most tests do not care
      // which base commit was observed, so hand back a valid fetched tip.
      if (joined.includes('rev-parse --verify refs/remotes/origin/main^{commit}')) {
        return ok('0'.repeat(40))
      }
      if (joined.includes('headRefName,baseRefName,isCrossRepository')) {
        return ok('feat-x\nmain\nfalse')
      }
      // THE FORK POINT IS THE BASE TIP — derived, never canned. The gate calls
      // drift when `merge-base(base, branch)` differs from `base^{commit}`, so a
      // fixed sha here silently becomes "the base the review saw" and reports
      // drift against whatever tip the scenario actually set. The hold message
      // then names this constant as the reviewed base, which is how the fake
      // gives itself away. Ask the test's own responder what the base resolves
      // to and echo it, so "no drift" means no drift against THIS scenario.
      if (cmd[3] === 'merge-base') {
        const baseRef = cmd[4] ?? ''
        const tip = opts.hostResponder?.([
          'git',
          '-C',
          cmd[2] ?? '',
          'rev-parse',
          '--verify',
          '--quiet',
          `${baseRef}^{commit}`,
        ])
        const sha = tip !== undefined && tip.ok ? tip.stdout.trim() : ''
        return ok(sha !== '' ? sha : NO_DRIFT_SHA)
      }
      return ok(NO_DRIFT_SHA)
    }
    return stubbed ?? ok()
  }
  const o: Parameters<typeof buildTridentOrchestrator>[0] = {
    fire_workflow: sim.fire_workflow,
    db_path: join(tmp, 'project.db'),
    run_host: host,
    now,
    // The resume head-read retries are SPACED in production (a `pr`-mode read is a
    // network call). The suite injects a no-op wait so those attempts stay free.
    sleep: async () => {},
    // RALPH RE-FIRE (#362) — persist the re-fire reset atomically out-of-band so a
    // re-fired run isn't re-harvested (production wires the identical seam). The spy
    // records each patch to assert the crash-safe bundle, then applies it for real.
    persist_refire_reset: (id, patch) => {
      refirePatches.push(patch)
      return store.update(id, patch).then(() => {})
    },
  }
  if (opts.base_branch !== null) o.base_branch = opts.base_branch ?? 'main'
  if (opts.on_orphaned_session !== undefined) o.on_orphaned_session = opts.on_orphaned_session
  if (opts.mint_run_id !== undefined) o.mint_run_id = opts.mint_run_id
  if (opts.max_inflight_ms !== undefined) o.max_inflight_ms = opts.max_inflight_ms
  if (opts.no_advance_hang_ms !== undefined) o.no_advance_hang_ms = opts.no_advance_hang_ms
  if (opts.latest_stage_event_at !== undefined) o.latest_stage_event_at = opts.latest_stage_event_at
  if (opts.probe_run_alive !== undefined) o.probe_run_alive = opts.probe_run_alive
  if (opts.gather_run_evidence !== undefined) o.gather_run_evidence = opts.gather_run_evidence
  if (opts.gather_fire_evidence !== undefined) o.gather_fire_evidence = opts.gather_fire_evidence
  if (opts.probe_branch_holder !== undefined) o.probe_branch_holder = opts.probe_branch_holder
  if (opts.codex_home !== undefined) o.codex_home = opts.codex_home
  if (opts.resolve_codex_home !== undefined) o.resolve_codex_home = opts.resolve_codex_home
  if (opts.resolve_reflection_context !== undefined)
    o.resolve_reflection_context = opts.resolve_reflection_context
  if (opts.resolve_active_runs !== undefined) o.resolve_active_runs = opts.resolve_active_runs
  if (opts.record_stage !== undefined) o.record_stage = opts.record_stage
  if (opts.resolve_conflict !== undefined) o.resolve_conflict = opts.resolve_conflict
  if (opts.fix_leak_findings !== undefined) o.fix_leak_findings = opts.fix_leak_findings
  // Keep unrelated orchestrator tests hermetic: production defaults to the real
  // appender, while the focused wiring tests below inject their own observable seam.
  o.fold_as_built = opts.fold_as_built ?? (async () => ({ ok: true, folded: 0 }))
  // THE MUTATION PROVER IS SUBSTITUTED FOR EVERY HARNESS RUN. The real gate
  // provisions a git worktree at the branch head and runs the guard, which cannot
  // work against this harness's `/repo` path — left unset it refuses every
  // APPROVE and 41 unrelated tests fail on a PUBLISH error that is really the gate
  // blocking the merge two steps later.
  o.prove_mutation = opts.prove_mutation ?? buildSimMutationProofGate()
  if (opts.merge_deps !== undefined) o.merge_deps = opts.merge_deps
  const orch = buildTridentOrchestrator(o)
  const loop = new TridentTickLoop({
    store,
    step: orch.step,
    ...(opts.on_terminal !== undefined ? { on_terminal: opts.on_terminal } : {}),
  })
  return { loop, step: orch.step, complete: sim.drain, hostCalls, inputs: sim.inputs, refirePatches }
}

/** Tick, then simulate the in-flight workflow finishing (write its result), so a
 *  fired run reaches its harvest on the next tick. */
async function runToTerminal(h: Harness, run_id: string, max_ticks = 20): Promise<TridentRun> {
  for (let i = 0; i < max_ticks; i++) {
    await h.loop.runOnce()
    await h.complete()
    const r = store.get(run_id)
    if (r !== null && isTerminalPhase(r.phase)) return r
  }
  const r = store.get(run_id)
  throw new Error(`run did not terminate (last phase: ${r?.phase})`)
}

async function createRun(over: Partial<Parameters<TridentRunStore['create']>[0]> = {}) {
  return store.create({
    slug: 'add-thing',
    project_slug: 't1',
    repo_path: '/repo',
    task: 'Add a thing',
    branch: 'feat-x',
    ...over,
  })
}

describe('orchestrator — wave child built terminal', () => {
  test('a child built result ends done without merge, re-fire, review provenance, or owner delivery', async () => {
    const commitSha = 'abcdef0123456789abcdef0123456789abcdef01'
    const memberBranch = 'trident/card--wT3'
    const h = buildHarness({
      plan: () => {
        throw new Error('a harvested child result must not launch another workflow')
      },
    })
    const child = makeTridentRun({
      id: 'child-T3',
      slug: 'card--wT3',
      parent_run_id: 'parent-1',
      wave_task_id: 'T3',
      chat_id: null,
      branch: 'trident/card',
      subagent_run_id: 'member-agent',
      subagent_status: 'completed',
      inner_checkpoint: 'built',
      inner_verdict: 'REQUEST_CHANGES',
      inner_result: JSON.stringify({
        ok: true,
        built: true,
        commitSha,
        branch: memberBranch,
        verdict: null,
        round: 1,
        checkpoint: 'built',
        remainingTasks: 0,
      }),
    })

    const outcome = await h.step(child)
    expect(outcome.run.phase).toBe('done')
    expect(outcome.run.branch).toBe(memberBranch)
    expect(outcome.run.inner_checkpoint).toBe('built')
    expect(outcome.run.inner_verdict).toBeNull()
    expect(outcome.run.failure_reason).toBeNull()
    expect(outcome.run.harvested_at).not.toBeNull()
    expect(h.hostCalls).toEqual([])
    expect(h.refirePatches).toEqual([])
    expect(h.inputs).toEqual([])

    let ownerDeliveries = 0
    const sink: OutboundSink = {
      send: async () => {
        ownerDeliveries += 1
        return 'unexpected-delivery'
      },
    }
    await buildTridentDelivery({ sink }).onTerminal(outcome.run)
    expect(ownerDeliveries).toBe(0)
  })

  test('a non-child built-shaped result retains the legacy terminal-failure path', async () => {
    const h = buildHarness({
      plan: () => {
        throw new Error('a harvested result must not launch another workflow')
      },
    })
    const ordinary = makeTridentRun({
      subagent_run_id: 'ordinary-agent',
      subagent_status: 'completed',
      inner_checkpoint: 'built',
      inner_result: JSON.stringify({
        ok: true,
        built: true,
        commitSha: 'abcdef0123456789abcdef0123456789abcdef01',
        branch: 'trident/card--wT3',
        verdict: null,
        round: 1,
        checkpoint: 'built',
      }),
    })

    const outcome = await h.step(ordinary)
    expect(outcome.run.phase).toBe('failed')
    expect(outcome.note).toBe('inner loop ended without APPROVE → failed')
    expect(h.hostCalls).toEqual([])
    expect(h.refirePatches).toEqual([])
  })
})

// REMOVED WITH ITS BEHAVIOUR, NOT WITH ITS COVERAGE. This asserted task 1's
// FAIL-CLOSED stop — a bound run terminal-FAILED with "review-only … no branch,
// no commit" — which task 2 replaces with the real review executor, so the run
// now lands `done`. Its successor is `trident/review-run.test.ts` "a bound run
// lands done without a build fire or host fallthrough", which makes the same two
// assertions that mattered here (zero build fires, zero host commands) against
// the new outcome, and is joined there by a CONTROL proving an unbound run still
// fires the ordinary build workflow — so the build path cannot quietly die.
describe('orchestrator — APPROVE → done → merge (server-gated)', () => {
  test('pr mode publishes in the outer loop and confirms origin before re-firing review', async () => {
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    // The remote is BEHIND the local head, so this exercises the real lease push; a remote
    // already AT the head is the no-op-success path, tested below.
    const stale = '9'.repeat(40)
    let fires = 0
    let prLists = 0
    let lsRemotes = 0
    const h = buildHarness({
      plan: () => {
        fires += 1
        return fires === 1
          ? { result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', checkpoint: 'forge-done', publishRequested: true, publishHead: head } }
          : { result: { verdict: 'APPROVE', prNumber: 42, branch: 'feat-x' } }
      },
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) {
          lsRemotes += 1
          return ok(lsRemotes === 1 ? `${stale}\trefs/heads/feat-x` : `${head}\trefs/heads/feat-x`)
        }
        if (joined.includes('diff --name-only')) return ok('changed.ts')
        if (joined.includes('gh pr list')) {
          prLists += 1
          return ok(prLists > 1 ? '42' : '')
        }
        return ok()
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    const calls = h.hostCalls.map((c) => c.join(' '))
    expect(calls).toContain(
      `git -C /repo push --force-with-lease=refs/heads/feat-x:${stale} origin refs/heads/feat-x:refs/heads/feat-x`,
    )
    const pushAt = calls.findIndex((c) => c.includes(' push '))
    // The WITNESS is the ls-remote AFTER the push. There is now also one BEFORE it (the lease
    // observation), so `findIndex` would match the wrong call and assert nothing.
    const witnessAt = calls.map((c) => c.includes('ls-remote --heads origin')).lastIndexOf(true)
    expect(witnessAt).toBeGreaterThan(pushAt)
    expect(h.inputs).toHaveLength(2)
    expect(h.inputs[1]!.resume_checkpoint).toBe(`outer-published:${head}:0:1`)
  })

  test('an intermediate Ralph publish handoff defers publishing and atomically renames the checkpoint', async () => {
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    const h = buildHarness({
      plan: () => ({
        result: {
          verdict: 'REQUEST_CHANGES',
          branch: 'feat-x',
          checkpoint: 'forge-done',
          publishRequested: true,
          publishHead: head,
          remainingTasks: 2,
        },
      }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode, ralph: true })
    await store.update(run.id, { inner_checkpoint_head: head })

    await h.loop.runOnce()
    await h.complete()
    await h.loop.runOnce()

    const calls = h.hostCalls.map((c) => c.join(' '))
    expect(calls.some((c) => c.includes(' push '))).toBe(false)
    expect(calls.some((c) => c.includes('gh pr create'))).toBe(false)
    expect(h.refirePatches).toHaveLength(1)
    expect(h.refirePatches[0]?.inner_checkpoint).toBe('ralph-task-built')
    expect('inner_checkpoint_head' in h.refirePatches[0]!).toBe(false)
    expect(store.get(run.id)?.inner_checkpoint_head).toBe(head)
  })

  /** Deviation now crosses the process boundary as the checkpoint NAME. The
   * intermediate task is not published, so there is deliberately no
   * `outer-published:*:deviated` handoff to carry it. */
  test('a deviated intermediate Ralph handoff uses the deviated checkpoint name without publishing', async () => {
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    const h = buildHarness({
      plan: () => ({
        result: {
          verdict: 'REQUEST_CHANGES',
          branch: 'feat-x',
          checkpoint: 'forge-done',
          publishRequested: true,
          publishHead: head,
          remainingTasks: 2,
          deviatedFromSpec: true,
        },
      }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode, ralph: true })
    await store.update(run.id, { inner_checkpoint_head: head })

    await h.loop.runOnce()
    await h.complete()
    await h.loop.runOnce()

    const calls = h.hostCalls.map((c) => c.join(' '))
    expect(calls.some((c) => c.includes(' push '))).toBe(false)
    expect(calls.some((c) => c.includes('gh pr create'))).toBe(false)
    expect(h.refirePatches).toHaveLength(1)
    expect(h.refirePatches[0]?.inner_checkpoint).toBe('ralph-task-built-deviated')
    expect('inner_checkpoint_head' in h.refirePatches[0]!).toBe(false)
    expect(store.get(run.id)?.inner_checkpoint_head).toBe(head)
  })

  /**
   * THE REVIEW DIFF IS TAKEN AGAINST THE OBSERVED BASE TIP, NOT THE LOCAL `main` REF.
   *
   * MEASURED (Argus r4, run 25b2327d): the published artifact was 15,154 lines / ~100 files
   * while the branch's own work was 20 files / 1,738 lines. The shared build checkout's local
   * `main` was 8 merges behind `origin/main`, so `git diff main..<head>` presented every
   * commit merged in between as part of this card — ~87% already-merged unrelated code. One
   * reviewer diffed that stale base and vetoed the branch over files it does not touch; the
   * round was lost. `rebaseOntoObservedBase` already ls-remotes the true base tip, so the
   * publisher uses THAT sha and never the local ref name.
   */
  test('the published review diff is computed from the ls-remote-observed base tip, never the local base ref', async () => {
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    const stale = '9'.repeat(40)
    const baseTip = '7'.repeat(40)
    let lsRemotes = 0
    let prLists = 0
    const h = buildHarness({
      plan: () => ({
        result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', checkpoint: 'forge-done', publishRequested: true, publishHead: head },
      }),
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
        if (joined.includes('ls-remote --heads origin refs/heads/main')) return ok(`${baseTip}\trefs/heads/main`)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) {
          lsRemotes += 1
          return ok(lsRemotes === 1 ? `${stale}\trefs/heads/feat-x` : `${head}\trefs/heads/feat-x`)
        }
        // The branch ALREADY contains the observed base tip → no replay, and git could only
        // have answered that by reading the object, so it is local and diffable.
        if (joined.includes('merge-base --is-ancestor')) return ok()
        if (joined.includes('diff --name-only')) return ok('changed.ts')
        if (joined.includes('gh pr list')) {
          prLists += 1
          return ok(prLists > 1 ? '42' : '')
        }
        return ok()
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await h.loop.runOnce()
    await h.complete()
    await h.loop.runOnce()
    const calls = h.hostCalls.map((c) => c.join(' '))
    const diffs = calls.filter((c) => c.includes(' diff ') && c.includes(`..${head}`))
    expect(diffs.length).toBeGreaterThan(0)
    for (const c of diffs) expect(c).toContain(`${baseTip}..${head}`)
    // The positive control for the defect: not one of them names the local ref.
    expect(calls.some((c) => c.includes(`main..${head}`))).toBe(false)
    expect(calls.some((c) => c.includes(`--output=/tmp/trident-outer-published-${run.id}.diff`))).toBe(true)
  })

  test('a successful push without a matching origin witness fails closed', async () => {
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    const other = '1111111111111111111111111111111111111111'
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', publishRequested: true, publishHead: head } }),
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) return ok(`${other}\trefs/heads/feat-x`)
        return ok()
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('could not confirm')
    expect(h.inputs).toHaveLength(1)
    expect(h.hostCalls.map((c) => c.join(' ')).some((c) => c.includes('gh pr create'))).toBe(false)
  })

  // THE GATE MUST ACTUALLY REFUSE. Everything else about the mutation prover can be
  // wired and green while it never blocks anything - which is the failure mode the
  // prover exists to prevent, reproduced one level up. So this pins the refusal
  // itself: an APPROVE whose proof comes back not-ok does NOT merge.
  test('an APPROVE whose mutation proof FAILS does not merge — and is not blamed on the reviewer', async () => {
    const h = buildHarness({
      prove_mutation: buildSimMutationProofGate({ ok: false, reason: 'guard stayed GREEN under the mutation' }),
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x', checkpoint: 'argus-approved' } }),
    })
    const final = await runToTerminal(h, (await createRun({ merge_mode: 'local' as MergeMode })).id)

    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('guard stayed GREEN under the mutation')
    // The review really did APPROVE, and its provenance is the audit trail. A missing
    // PROOF is not a reviewer's finding, so the verdict must not be rewritten to make
    // the row look like a rejection.
    expect(final.inner_verdict).toBe('APPROVE')
    // …and nothing merged.
    expect(h.hostCalls.map((c) => c.join(' ')).some((c) => c.includes('merge'))).toBe(false)
  })

  test('the outer publisher refuses a commit that is not the local branch tip — naming BOTH values', async () => {
    const requested = 'abcdef0123456789abcdef0123456789abcdef01'
    const resolved = '1111111111111111111111111111111111111111'
    let lsRemotes = 0
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', publishRequested: true, publishHead: requested } }),
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(resolved)
        if (joined.includes(`--end-of-options ${requested}^{commit}`)) return ok(requested)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) {
          lsRemotes += 1
          return ok(`${lsRemotes === 1 ? '9'.repeat(40) : resolved}\trefs/heads/feat-x`)
        }
        return ok()
      },
    })
    const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)
    expect(final.phase).toBe('failed')
    // A disagreement is a real signal (wrong branch/worktree). Neither value may be
    // silently preferred, so the reason has to carry both verbatim to be actionable.
    expect(final.failure_reason).toContain(requested)
    expect(final.failure_reason).toContain(resolved)
    // …and it must not blame a review that never ran.
    expect(final.failure_reason).not.toContain('Argus')
    const calls = h.hostCalls.map((c) => c.join(' '))
    expect(calls.some((c) => c.includes(' push '))).toBe(true)
    expect(calls.some((c) => c.includes('gh pr create'))).toBe(false)
    expect(h.inputs).toHaveLength(1)
  })

  test("a claim that resolves to no git object is ABSENT — the publisher publishes from git's head", async () => {
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    const claim = '924b42906950'
    let fires = 0
    let lsRemotes = 0
    const h = buildHarness({
      plan: () => ++fires === 1
        ? { result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', checkpoint: 'forge-done', publishRequested: true, publishHead: claim } }
        : { result: { verdict: 'APPROVE', prNumber: 42, branch: 'feat-x' } },
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
        if (joined.includes(`--end-of-options ${claim}^{commit}`)) {
          return { ok: false, stdout: '', stderr: 'fatal: Needed a single revision', exit_code: 128 }
        }
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) {
          return ok(`${++lsRemotes === 1 ? '9'.repeat(40) : head}\trefs/heads/feat-x`)
        }
        if (joined.includes('gh pr list')) return ok('42')
        if (joined.includes('diff --name-only')) return ok('changed.ts')
        return ok()
      },
    })
    const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)
    expect(final.phase).toBe('done')
    expect(final.failure_reason).toBeNull()
    expect(h.hostCalls.map((c) => c.join(' ')).some((c) => c.includes(' push '))).toBe(true)
    expect(h.refirePatches[0]?.inner_checkpoint).toBe(`outer-published:${head}:0:1`)
  })

  test('a short-sha claim resolving to the same commit is accepted by OID equality', async () => {
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    const claim = head.slice(0, 7)
    let fires = 0
    let lsRemotes = 0
    const h = buildHarness({
      plan: () => ++fires === 1
        ? { result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', checkpoint: 'forge-done', publishRequested: true, publishHead: claim } }
        : { result: { verdict: 'APPROVE', prNumber: 42, branch: 'feat-x' } },
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
        if (joined.includes(`--end-of-options ${claim}^{commit}`)) return ok(head)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) {
          return ok(`${++lsRemotes === 1 ? '9'.repeat(40) : head}\trefs/heads/feat-x`)
        }
        if (joined.includes('gh pr list')) return ok('42')
        if (joined.includes('diff --name-only')) return ok('changed.ts')
        return ok()
      },
    })
    const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)
    expect(final.phase).toBe('done')
    expect(h.hostCalls.map((c) => c.join(' ')).some((c) => c.includes(`--end-of-options ${claim}^{commit}`))).toBe(true)
  })

  test("PR #271's string claim comparison cannot return", () => {
    const source = readFileSync(join(import.meta.dir, 'orchestrator.ts'), 'utf8')
    expect(source).not.toContain('startsWith(claimedHead')
    expect(source).toContain('resolveClaimedCommit')
  })

  describe('resolveClaimedCommit — real git', () => {
    test('resolves full and abbreviated commit OIDs and rejects absent or non-sha claims', async () => {
      const repo = join(tmp, 'claim-resolution-real-git')
      mkdirSync(repo)
      const git = (...args: string[]) => Bun.spawnSync(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe' })
      expect(git('init').exitCode).toBe(0)
      expect(git('config', 'user.email', 'test@example.com').exitCode).toBe(0)
      expect(git('config', 'user.name', 'Test').exitCode).toBe(0)
      writeFileSync(join(repo, 'one'), 'one')
      expect(git('add', 'one').exitCode).toBe(0)
      expect(git('commit', '-m', 'one').exitCode).toBe(0)
      const a = git('rev-parse', 'HEAD').stdout.toString().trim()
      expect(await resolveClaimedCommit(spawnCapture, repo, a)).toBe(a)
      expect(await resolveClaimedCommit(spawnCapture, repo, a.slice(0, 8))).toBe(a)
      expect(await resolveClaimedCommit(spawnCapture, repo, '924b42906950')).toBeNull()
      expect(git('cat-file', '-t', '924b42906950').exitCode).not.toBe(0)
      expect(await resolveClaimedCommit(spawnCapture, repo, 'not-a-sha')).toBeNull()
      expect(await resolveClaimedCommit(spawnCapture, repo, null)).toBeNull()
      expect(await resolveClaimedCommit(spawnCapture, repo, 'HEAD')).toBeNull()
      writeFileSync(join(repo, 'two'), 'two')
      expect(git('add', 'two').exitCode).toBe(0)
      expect(git('commit', '-m', 'two').exitCode).toBe(0)
      const b = git('rev-parse', 'HEAD').stdout.toString().trim()
      expect(await resolveClaimedCommit(spawnCapture, repo, b.slice(0, 8))).toBe(b)
      expect(b).not.toBe(a)
    })
  })

  describe('FIX-ROUND ANCESTRY GATE', () => {
    const reviewed = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const produced = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

    const ancestryRun = async (answer: HostCommandResult, pin: string | null = reviewed) => {
      const h = buildHarness({
        plan: () => ({ result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', publishRequested: true, publishHead: produced } }),
        hostResponder: (cmd) => {
          const joined = cmd.join(' ')
          if (joined.includes('rev-parse --verify refs/heads/feat-x')) return ok(produced)
          if (joined.includes(`merge-base --is-ancestor ${reviewed} ${produced}`)) return answer
          return ok()
        },
      })
      const run = await createRun({ merge_mode: 'pr' as MergeMode, reviewed_head: pin, bound_pr: null, fenced_paths: null })
      return { h, final: await runToTerminal(h, run.id) }
    }

    test('refuses a produced head that abandoned the reviewed head before push or PR creation', async () => {
      const { h, final } = await ancestryRun({ ok: false, stdout: '', stderr: '', exit_code: 1 })
      expect(final.phase).toBe('failed')
      expect(final.failure_reason).toContain('does not descend from the reviewed head')
      expect(final.failure_reason).toContain(reviewed)
      expect(final.failure_reason).toContain(produced)
      const calls = h.hostCalls.map((c) => c.join(' '))
      expect(calls.some((c) => c.includes(' push '))).toBe(false)
      expect(calls.some((c) => c.includes('gh pr create'))).toBe(false)
    })

    test('fails closed when git cannot verify ancestry', async () => {
      const { h, final } = await ancestryRun({ ok: false, stdout: '', stderr: 'fatal: Not a valid commit name aaaa', exit_code: 128 })
      expect(final.failure_reason).toContain('could not verify')
      expect(final.failure_reason).toContain(reviewed)
      expect(final.failure_reason).toContain(produced)
      expect(h.hostCalls.some((c) => c.includes('push'))).toBe(false)
    })

    test('rejects a malformed pin without asking git to measure it', async () => {
      const { h, final } = await ancestryRun(ok(), 'deadbeef')
      expect(final.failure_reason).toContain('is not a 40-hex commit')
      expect(final.failure_reason).toContain(produced)
      expect(h.hostCalls.map((c) => c.join(' ')).some((c) => c.includes('merge-base --is-ancestor deadbeef'))).toBe(false)
    })

    test('a verified descendant proceeds through the normal publish path', async () => {
      let fires = 0
      let remotes = 0
      const h = buildHarness({
        plan: () => ++fires === 1
          ? { result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', checkpoint: 'forge-done', publishRequested: true, publishHead: produced } }
          : { result: { verdict: 'APPROVE', prNumber: 42, branch: 'feat-x' } },
        hostResponder: (cmd) => {
          const joined = cmd.join(' ')
          if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(produced)
          if (joined.includes(`merge-base --is-ancestor ${reviewed} ${produced}`)) return ok()
          if (joined.includes('merge-base --is-ancestor')) return ok()
          if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) return ok(`${++remotes === 1 ? '9'.repeat(40) : produced}\trefs/heads/feat-x`)
          if (joined.includes('gh pr list')) return ok('42')
          if (joined.includes('diff --name-only')) return ok('changed.ts')
          return ok()
        },
      })
      const run = await createRun({ merge_mode: 'pr' as MergeMode, reviewed_head: reviewed, bound_pr: null, fenced_paths: null })
      expect((await runToTerminal(h, run.id)).phase).toBe('done')
      expect(h.hostCalls.map((c) => c.join(' '))).toContain(`git -C /repo merge-base --is-ancestor ${reviewed} ${produced}`)
    })

    test('a null pin adds no pre-rebase ancestry command', async () => {
      const { h } = await ancestryRun(ok(), null)
      expect(h.hostCalls.map((c) => c.join(' ')).some((c) => c.includes(`merge-base --is-ancestor ${reviewed} ${produced}`))).toBe(false)
    })

    test('real git treats equality as ancestry and an unrelated commit as non-ancestry', () => {
      const repo = join(tmp, 'ancestry-real-git')
      mkdirSync(repo)
      const git = (...args: string[]) => Bun.spawnSync(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe' })
      expect(git('init').exitCode).toBe(0)
      expect(git('config', 'user.email', 'test@example.com').exitCode).toBe(0)
      expect(git('config', 'user.name', 'Test').exitCode).toBe(0)
      writeFileSync(join(repo, 'one'), 'one')
      expect(git('add', 'one').exitCode).toBe(0)
      expect(git('commit', '-m', 'one').exitCode).toBe(0)
      const x = git('rev-parse', 'HEAD').stdout.toString().trim()
      expect(git('merge-base', '--is-ancestor', x, x).exitCode).toBe(0)
      expect(git('checkout', '--orphan', 'unrelated').exitCode).toBe(0)
      expect(git('rm', '-rf', '.').exitCode).toBe(0)
      writeFileSync(join(repo, 'two'), 'two')
      expect(git('add', 'two').exitCode).toBe(0)
      expect(git('commit', '-m', 'two').exitCode).toBe(0)
      const y = git('rev-parse', 'HEAD').stdout.toString().trim()
      expect(git('merge-base', '--is-ancestor', x, y).exitCode).not.toBe(0)
    })
  })

  /**
   * THE PUBLISHER MUST BE ABLE TO PUBLISH A REBASED BRANCH — WITH A LEASE, NEVER A FORCE.
   *
   * Run `2aacf419` (2026-08-14) was the first build to reach this step. It built successfully and
   * then could not deliver: the build rebases onto current `main`, and an ordinary push may only
   * ADD to the remote. A rebased branch is by definition not a fast-forward, so the push was
   * refused and every card with a pre-existing remote branch was stranded.
   *
   * The pair below is the point. Proving only that a rebase now publishes would prove that
   * `--force` works — trivially true, and catastrophic. The second test is what proves it is a
   * LEASE: a remote that genuinely moved is still refused.
   */
  const failWith = (stderr: string): HostCommandResult => ({ ok: false, stdout: '', stderr, exit_code: 1 })

  test('a rebased branch publishes, and the lease is pinned to the sha actually observed', async () => {
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    const preRebase = '2222222222222222222222222222222222222222'
    const baseTip = '4444444444444444444444444444444444444444'
    let lsRemotes = 0
    let fires = 0
    const h = buildHarness({
      // A SUCCESSFUL publish re-fires review, so the run only terminates on the second verdict.
      plan: () => {
        fires += 1
        return fires === 1
          ? { result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', checkpoint: 'forge-done', publishRequested: true, publishHead: head } }
          : { result: { verdict: 'APPROVE', prNumber: 42, branch: 'feat-x' } }
      },
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        // Both spellings: the PUBLISHER reads the head with `rev-parse --verify` (T1), while
        // `rebaseOntoObservedBase` reads its own pre-replay tip with a plain `rev-parse`.
        if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
        // T1d — the rebase step is a NO-OP here (the branch already contains the base tip), so
        // these four lease cases keep asserting exactly what they asserted before it existed.
        if (joined.includes('ls-remote --heads origin refs/heads/main')) return ok(`${baseTip}\trefs/heads/main`)
        if (joined.includes('merge-base --is-ancestor')) return ok()
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) {
          lsRemotes += 1
          // Before the push the remote still holds the PRE-REBASE tip; after it, the new one.
          return ok(lsRemotes === 1 ? `${preRebase}\trefs/heads/feat-x` : `${head}\trefs/heads/feat-x`)
        }
        if (joined.includes('gh pr list')) return ok('42')
        if (joined.includes('diff --name-only')) return ok('changed.ts')
        return ok()
      },
    })
    const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)
    const calls = h.hostCalls.map((c) => c.join(' '))

    // It got past publishing — on today's code this run dies at the push.
    expect(final.failure_reason ?? '').not.toContain('could not push')
    expect(calls.some((c) => c.includes(`--force-with-lease=refs/heads/feat-x:${preRebase}`))).toBe(true)
    // The lease is pinned to what was OBSERVED. The bare form trusts the remote-tracking ref,
    // which a concurrent fetch can advance — at which point it silently degrades to a force.
    expect(calls.some((c) => /--force-with-lease(\s|$)/.test(c))).toBe(false)
    // And the observation must PRECEDE the push, or it certifies nothing.
    const observeAt = calls.findIndex((c) => c.includes('ls-remote --heads origin'))
    const pushAt = calls.findIndex((c) => c.includes(' push '))
    expect(observeAt).toBeGreaterThanOrEqual(0)
    expect(pushAt).toBeGreaterThan(observeAt)
  })

  test('a remote that moved underneath is REFUSED — this is a lease, not a force', async () => {
    // THE TEST THAT MAKES THE FEATURE MEAN SOMETHING. Delete it and a bare `--force` passes.
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    const theirs = '3333333333333333333333333333333333333333'
    const baseTip = '4444444444444444444444444444444444444444'
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', publishRequested: true, publishHead: head } }),
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
        // T1d — the rebase step is a NO-OP here (the branch already contains the base tip), so
        // these four lease cases keep asserting exactly what they asserted before it existed.
        if (joined.includes('ls-remote --heads origin refs/heads/main')) return ok(`${baseTip}\trefs/heads/main`)
        if (joined.includes('merge-base --is-ancestor')) return ok()
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) return ok(`${theirs}\trefs/heads/feat-x`)
        if (joined.includes(' push ')) {
          return failWith('! [rejected]   feat-x -> feat-x (stale info)\nerror: failed to push some refs')
        }
        return ok()
      },
    })
    const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)
    const calls = h.hostCalls.map((c) => c.join(' '))

    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('stale info')
    // Their commits survive: we never opened a PR or advanced past the refusal.
    expect(calls.some((c) => c.includes('gh pr create'))).toBe(false)
    // NOTHING may reach for a bare force as a fallback when the lease refuses.
    // The purity preflight's throwaway SCAN worktree is excluded: it is added
    // and removed with `--force` so a stale scratch directory cannot wedge a
    // lane, which publishes nothing and is not a push.
    expect(
      calls
        .filter((c) => !c.includes('/.trident-worktrees/leak-preflight-'))
        .some((c) => /\s--force(\s|$)/.test(c)),
    ).toBe(false)
  })

  test('a first push of a new card still works — an absent remote branch leases the EMPTY value', async () => {
    // Empty is meaningful to git ("this ref must not exist"), not a missing argument. Without
    // this case the lease fix would regress every brand-new card in order to rescue rebased ones.
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    const baseTip = '4444444444444444444444444444444444444444'
    let lsRemotes = 0
    let fires = 0
    const h = buildHarness({
      plan: () => {
        fires += 1
        return fires === 1
          ? { result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', checkpoint: 'forge-done', publishRequested: true, publishHead: head } }
          : { result: { verdict: 'APPROVE', prNumber: 42, branch: 'feat-x' } }
      },
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
        // T1d — the rebase step is a NO-OP here (the branch already contains the base tip), so
        // these four lease cases keep asserting exactly what they asserted before it existed.
        if (joined.includes('ls-remote --heads origin refs/heads/main')) return ok(`${baseTip}\trefs/heads/main`)
        if (joined.includes('merge-base --is-ancestor')) return ok()
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) {
          lsRemotes += 1
          return ok(lsRemotes === 1 ? '' : `${head}\trefs/heads/feat-x`)
        }
        if (joined.includes('gh pr list')) return ok('42')
        if (joined.includes('diff --name-only')) return ok('changed.ts')
        return ok()
      },
    })
    const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)
    expect(final.failure_reason ?? '').not.toContain('could not push')
    // Asserted against the ARGUMENT, not the joined string — a trailing-space match would pass
    // for `…:<sha>` too and quietly stop testing the empty case.
    expect(h.hostCalls.some((c) => c.includes('--force-with-lease=refs/heads/feat-x:'))).toBe(true)
  })

  test("a failed push reports git's own words instead of only the branch name", async () => {
    // The sibling of #240, in brand-new code. #240 removed a message that ASSERTED a cause it
    // never measured; this one MEASURED the cause and threw it away. Recovering that one line
    // cost a DB read, a hand merge-base comparison and a credentialed dry-run push.
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    const baseTip = '4444444444444444444444444444444444444444'
    const stale = '9'.repeat(40)
    let lsRemotes = 0
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', publishRequested: true, publishHead: head } }),
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
        // T1d — the rebase step is a NO-OP here (the branch already contains the base tip), so
        // these four lease cases keep asserting exactly what they asserted before it existed.
        if (joined.includes('ls-remote --heads origin refs/heads/main')) return ok(`${baseTip}\trefs/heads/main`)
        if (joined.includes('merge-base --is-ancestor')) return ok()
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) {
          // Stale first so the run gets PAST the zero-ahead gate and reaches the push.
          lsRemotes += 1
          return ok(lsRemotes === 1 ? `${stale}\trefs/heads/feat-x` : `${head}\trefs/heads/feat-x`)
        }
        if (joined.includes(' push ')) return failWith('! [rejected] feat-x -> feat-x (non-fast-forward)')
        return ok()
      },
    })
    const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)

    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('non-fast-forward')
    // …and it stays distinguishable from the OTHER publish failures by reading it alone.
    expect(final.failure_reason).toContain('could not push')
    expect(final.failure_reason).not.toContain('could not confirm')
  })

  /**
   * A STALE BRANCH IS NOT A REJECTED BUILD.
   *
   * Measured 2026-08-14: every open build PR but one read `mergeable: CONFLICTING`, because `main`
   * absorbed five PRs while those branches were building and NOTHING rebased them. The repaired
   * readiness probe then correctly refused to review — so the whole board was blocked on staleness,
   * and a restart just rebuilt the same stale branch. The publisher now replays the branch onto the
   * OBSERVED base tip before it pushes, in a throwaway worktree (the shared checkout is SHALLOW,
   * governance #574 — `git rebase` there conflicts on every file).
   */
  test('a branch behind main is replayed onto the observed base tip and the REBASED head is published', async () => {
    const oldHead = 'abcdef0123456789abcdef0123456789abcdef01'
    const newHead = '5555555555555555555555555555555555555555'
    const newBaseSha = '6666666666666666666666666666666666666666'
    const preRebase = '2222222222222222222222222222222222222222'
    let lsRemotesBranch = 0
    let fires = 0
    const h = buildHarness({
      plan: () => {
        fires += 1
        return fires === 1
          ? { result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', checkpoint: 'forge-done', publishRequested: true, publishHead: oldHead } }
          : { result: { verdict: 'APPROVE', prNumber: 42, branch: 'feat-x' } }
      },
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (joined.includes('ls-remote --heads origin refs/heads/main')) return ok(`${newBaseSha}\trefs/heads/main`)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) {
          lsRemotesBranch += 1
          // The lease is pinned to the PRE-rebase remote tip; the witness after the push sees the
          // replayed one.
          return ok(lsRemotesBranch === 1 ? `${preRebase}\trefs/heads/feat-x` : `${newHead}\trefs/heads/feat-x`)
        }
        // `main` is NOT an ancestor of the branch — this is the genuinely-behind case.
        if (joined.includes('merge-base --is-ancestor')) return failWith('')
        // The publisher's OWN read of the head (T1) is `rev-parse --verify refs/heads/<branch>` —
        // matched BEFORE the rebase step's generic `rev-parse --verify <baseSha>^{commit}` probe.
        if (joined.includes('rev-parse --verify refs/heads/feat-x')) return ok(oldHead)
        if (joined.includes(`--end-of-options ${oldHead}^{commit}`)) return ok(oldHead)
        if (joined.includes('rev-parse --verify')) return ok(newBaseSha)
        if (joined.includes('rev-parse HEAD')) return ok(newHead)
        if (joined.includes('rev-parse refs/heads/feat-x')) return ok(oldHead)
        if (joined.includes('gh pr list')) return ok('42')
        // The merge-base that is HONEST on a shallow checkout: the forge's, not ours.
        if (joined.includes('gh pr diff'))
          return ghPrDiffTo(joined, 'diff --git a/changed.ts b/changed.ts\n@@ -1 +1 @@\n-a\n+b\n')
        if (joined.includes('diff --name-only')) return ok('changed.ts')
        return ok()
      },
    })
    const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)
    const calls = h.hostCalls.map((c) => c.join(' '))

    expect(final.phase).toBe('done')
    // The replay happens in an ISOLATED worktree checked out AT THE OBSERVED BASE TIP — never in
    // the shared working tree, which other lanes are building in.
    expect(calls.some((c) => c.includes('worktree add --detach --force') && c.endsWith(newBaseSha))).toBe(true)
    expect(calls.some((c) => c.includes('apply --3way --index'))).toBe(true)
    // NEVER `git rebase` against the shared repo: `.git/shallow` makes merge-base lie there.
    expect(calls.some((c) => /\bgit -C \/repo rebase\b/.test(c))).toBe(false)
    // The branch ref moves by COMPARE-AND-SWAP: refused if anything moved it underneath us.
    expect(calls.some((c) => c.includes(`update-ref refs/heads/feat-x ${newHead} ${oldHead}`))).toBe(true)
    // The push still carries the lease pinned to the sha OBSERVED on the remote…
    expect(calls.some((c) => c.includes(`--force-with-lease=refs/heads/feat-x:${preRebase}`))).toBe(true)
    // …and no push ever falls back to a bare force (the scratch worktree's own --force is ours).
    expect(calls.filter((c) => c.includes(' push ')).some((c) => /\s--force(\s|$)/.test(c))).toBe(false)
    // The REBASED head — not the head the build reported — is what review is re-fired against.
    expect(h.refirePatches[0]?.inner_checkpoint).toBe(`outer-published:${newHead}:0:1`)
    expect(h.inputs[1]?.resume_checkpoint).toBe(`outer-published:${newHead}:0:1`)
    // …AND THE DIFF HANDED TO REVIEW IS TAKEN FROM THE OBSERVED BASE, ON THIS PATH TOO
    // (Argus r5). `rebaseOntoObservedBase` has TWO return sites — already-contains
    // (asserted above, at the `${baseTip}..${head}` test) and the REPLAY, this one — and
    // only the first was pinned. A replay that returned the pre-rebase base would hand
    // reviewers the ~87%-already-merged artifact this card exists to stop.
    const replayDiffs = calls.filter((c) => c.includes(' diff ') && c.includes(`..${newHead}`))
    expect(replayDiffs.length).toBeGreaterThan(0)
    for (const c of replayDiffs) expect(c).toContain(`${newBaseSha}..${newHead}`)
    expect(calls.some((c) => c.includes(`main..${newHead}`))).toBe(false)
    // The lease observation still precedes the push it certifies.
    const observeAt = calls.findIndex((c) => c.includes('ls-remote --heads origin refs/heads/feat-x'))
    const pushAt = calls.findIndex((c) => c.includes(' push '))
    expect(observeAt).toBeGreaterThanOrEqual(0)
    expect(pushAt).toBeGreaterThan(observeAt)
  })

  /**
   * THE REPLAY DIFF, ON THE FIRST-PUBLISH PATH WHERE NO PR EXISTS YET.
   *
   * The test above pins the diff base for a branch that HAS a PR, so it runs `gh pr diff` and
   * never touches the local-ref branch below it. That branch was the live defect.
   *
   * MEASURED 2026-08-15: `refs/heads/main` in the shared build checkout sat at d8324cc while the
   * observed tip was d5ba62b — 236 commits stale, because step (d) fetches into
   * `refs/remotes/origin/main` and nothing ever moves `refs/heads/main`. The diff carried 103
   * files instead of the branch's own 22. Applied onto the observed tip every already-merged hunk
   * failed, `git apply` staged NOTHING as conflicted, and the run reported `conflicts with main
   * in: (paths unreadable)` — a conflict that never existed. Five builds across two projects died
   * on it in a day.
   */
  test('the FIRST-PUBLISH replay diff is taken from the observed base sha, never the local base ref', async () => {
    const oldHead = 'abcdef0123456789abcdef0123456789abcdef01'
    const newHead = '5555555555555555555555555555555555555555'
    const newBaseSha = '6666666666666666666666666666666666666666'
    const preRebase = '2222222222222222222222222222222222222222'
    const forkPoint = '7777777777777777777777777777777777777777'
    let lsRemotesBranch = 0
    let prLists = 0
    let fires = 0
    const h = buildHarness({
      plan: () => {
        fires += 1
        return fires === 1
          ? { result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', checkpoint: 'forge-done', publishRequested: true, publishHead: oldHead } }
          : { result: { verdict: 'APPROVE', prNumber: 42, branch: 'feat-x' } }
      },
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (joined.includes('ls-remote --heads origin refs/heads/main')) return ok(`${newBaseSha}\trefs/heads/main`)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) {
          lsRemotesBranch += 1
          return ok(lsRemotesBranch === 1 ? `${preRebase}\trefs/heads/feat-x` : `${newHead}\trefs/heads/feat-x`)
        }
        if (joined.includes('merge-base --is-ancestor')) return failWith('')
        // The FORK POINT — what `gh pr diff` computes server-side, and what the replay must use.
        if (joined.includes('merge-base ')) return ok(forkPoint)
        if (joined.includes('rev-parse --verify refs/heads/feat-x')) return ok(oldHead)
        if (joined.includes('rev-parse --verify')) return ok(newBaseSha)
        if (joined.includes('rev-parse HEAD')) return ok(newHead)
        if (joined.includes('rev-parse refs/heads/feat-x')) return ok(oldHead)
        // NO PR AT ALL — this is what forces the local-ref branch of the diff. A first publish
        // for a card whose PR has not been opened yet is the common case, not an edge one.
        if (joined.includes('gh pr list')) {
          prLists += 1
          return ok('')
        }
        if (joined.includes('diff --name-only')) return ok('changed.ts')
        if (joined.includes(' diff ')) return ok('diff --git a/changed.ts b/changed.ts\n@@ -1 +1 @@\n-a\n+b\n')
        return ok()
      },
    })
    // Not driven to terminal: with no PR the run cannot merge, and the assertion here is about
    // the REPLAY, which happens on the first publish tick.
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await h.loop.runOnce()
    await h.complete()
    await h.loop.runOnce()
    const calls = h.hostCalls.map((c) => c.join(' '))

    const replayDiffs = calls.filter((c) => c.includes(' diff ') && c.includes('..refs/heads/feat-x'))
    expect(replayDiffs.length).toBeGreaterThan(0)
    // …and every one of them is anchored to the FORK POINT.
    for (const c of replayDiffs) expect(c).toContain(`${forkPoint}..refs/heads/feat-x`)
    // The positive control for the defect that shipped: not one names the stale local ref…
    expect(calls.some((c) => c.includes('refs/heads/main..refs/heads/feat-x'))).toBe(false)
    // …and not one names the observed TIP either, which would replay a revert of main's own work.
    expect(calls.some((c) => c.includes(`${newBaseSha}..refs/heads/feat-x`))).toBe(false)
  })

  /**
   * CODEX REVIEW [Blocker] — THE SHALLOW BOUNDARY MUST FAIL CLOSED.
   *
   * The first cut of the fork-point fix fell back to `refs/heads/<base>` when merge-base could
   * not answer. That is exactly the shallow checkout this function is written for, so the fix
   * would have silently done the broken thing in the one condition that produces the bug. A fork
   * point that cannot be established is an infrastructure fault about the checkout, not a licence
   * to replay a diff known to carry already-merged work through review.
   */
  test('a fork point that cannot be established REFUSES — it never falls back to the stale local ref', async () => {
    const oldHead = 'abcdef0123456789abcdef0123456789abcdef01'
    const newBaseSha = '6666666666666666666666666666666666666666'
    const preRebase = '2222222222222222222222222222222222222222'
    let lsRemotesBranch = 0
    const h = buildHarness({
      plan: () => ({
        result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', checkpoint: 'forge-done', publishRequested: true, publishHead: oldHead },
      }),
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (joined.includes('ls-remote --heads origin refs/heads/main')) return ok(`${newBaseSha}\trefs/heads/main`)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) {
          lsRemotesBranch += 1
          return ok(`${preRebase}\trefs/heads/feat-x`)
        }
        if (joined.includes('merge-base --is-ancestor')) return failWith('')
        // The shallow boundary: merge-base cannot answer, before OR after the deepen.
        if (joined.includes('merge-base ')) return failWith('fatal: refusing to work with a shallow history')
        if (joined.includes('rev-parse --verify refs/heads/feat-x')) return ok(oldHead)
        if (joined.includes('rev-parse --verify')) return ok(newBaseSha)
        if (joined.includes('gh pr list')) return ok('')
        if (joined.includes('diff --name-only')) return ok('changed.ts')
        if (joined.includes(' diff ')) return ok('diff --git a/changed.ts b/changed.ts\n@@ -1 +1 @@\n-a\n+b\n')
        return ok()
      },
    })
    await createRun({ merge_mode: 'pr' as MergeMode })
    await h.loop.runOnce()
    await h.complete()
    await h.loop.runOnce()
    const calls = h.hostCalls.map((c) => c.join(' '))

    // It TRIED to recover before giving up…
    expect(calls.some((c) => c.includes('fetch --no-tags --unshallow origin'))).toBe(true)
    // …and having failed, it replayed NOTHING rather than replaying the wrong thing.
    expect(calls.some((c) => c.includes('refs/heads/main..refs/heads/feat-x'))).toBe(false)
    expect(calls.some((c) => c.includes('apply --3way'))).toBe(false)
  })

  test('a branch already containing the base tip is a NO-OP — no worktree, no replay, head unchanged', async () => {
    // The anti-churn half: a branch that already has main's tip must not be squashed and
    // force-pushed for nothing. (The anti-FAKE half — a branch genuinely behind a moved main on a
    // real SHALLOW clone — is the real-git test, T2.)
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    const baseTip = '4444444444444444444444444444444444444444'
    // The remote must be BEHIND the local head, or the zero-ahead gate ("nothing was built")
    // correctly refuses to publish a branch that is already fully pushed.
    const stale = '9'.repeat(40)
    let lsRemotes = 0
    let fires = 0
    const h = buildHarness({
      plan: () => {
        fires += 1
        return fires === 1
          ? { result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', checkpoint: 'forge-done', publishRequested: true, publishHead: head } }
          : { result: { verdict: 'APPROVE', prNumber: 42, branch: 'feat-x' } }
      },
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (joined.includes('ls-remote --heads origin refs/heads/main')) return ok(`${baseTip}\trefs/heads/main`)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) {
          lsRemotes += 1
          return ok(lsRemotes === 1 ? `${stale}\trefs/heads/feat-x` : `${head}\trefs/heads/feat-x`)
        }
        if (joined.includes('merge-base --is-ancestor')) return ok()
        if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
        if (joined.includes('gh pr list')) return ok('42')
        if (joined.includes('diff --name-only')) return ok('changed.ts')
        return ok()
      },
    })
    const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)
    const calls = h.hostCalls.map((c) => c.join(' '))

    expect(final.phase).toBe('done')
    // Only the REBASE scratch must be absent here. The purity preflight now
    // provisions a throwaway SCAN worktree on every publish, so a bare
    // `worktree add` match would assert that expected worktree away too.
    expect(
      calls.some((c) => c.includes('worktree add') && c.includes('/.trident-worktrees/rebase-')),
    ).toBe(false)
    expect(calls.some((c) => c.includes('apply --3way'))).toBe(false)
    expect(calls.some((c) => c.includes('gh pr diff'))).toBe(false)
    // The build's own head is published, untouched — the lease is pinned to what the remote
    // actually held, and the checkpoint carries the UNREBASED head.
    expect(calls.some((c) => c.includes(`--force-with-lease=refs/heads/feat-x:${stale}`))).toBe(true)
    expect(h.refirePatches[0]?.inner_checkpoint).toBe(`outer-published:${head}:0:1`)
  })

  test('a failed PR creation persists the underlying gh diagnostic', async () => {
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    const baseTip = '4444444444444444444444444444444444444444'
    const stale = '9'.repeat(40)
    let lsRemotes = 0
    const h = buildHarness({
      plan: () => ({
        result: {
          verdict: 'REQUEST_CHANGES',
          branch: 'feat-x',
          checkpoint: 'forge-done',
          publishRequested: true,
          publishHead: head,
        },
      }),
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (joined.includes('ls-remote --heads origin refs/heads/main')) return ok(`${baseTip}\trefs/heads/main`)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) {
          lsRemotes += 1
          return ok(lsRemotes === 1 ? `${stale}\trefs/heads/feat-x` : `${head}\trefs/heads/feat-x`)
        }
        if (joined.includes('merge-base --is-ancestor')) return ok()
        if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
        if (joined.includes('gh pr list')) return ok('')
        if (joined.includes('gh pr create')) {
          return failWith('pull request create failed: GraphQL: No commits between main and feat-x (createPullRequest)')
        }
        if (joined.includes('diff --name-only')) return ok('changed.ts')
        return ok()
      },
    })

    const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)

    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('publish failed: outer publisher could not open a PR for branch feat-x')
    expect(final.failure_reason).toContain('No commits between')
    expect(h.hostCalls.map((c) => c.join(' ')).some((c) => c.includes('gh pr create'))).toBe(true)
  })

  test('a rebase CONFLICT with NO resolver configured is an attention state naming the paths — never REQUEST_CHANGES', async () => {
    // A conflicting branch is a MERGEABILITY fact about its relationship to `main`, not a
    // judgement about the code. Reporting it as REQUEST_CHANGES tells the owner his build was
    // rejected when no reviewer read a line of it.
    //
    // NO `resolve_conflict` here — this is the acceptance case for "no resolver configured →
    // exactly the behaviour that predates auto-resolution" (the resolved/declined/exhausted
    // cases are the three tests below).
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    const newBaseSha = '6666666666666666666666666666666666666666'
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', publishRequested: true, publishHead: head } }),
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (joined.includes('ls-remote --heads origin refs/heads/main')) return ok(`${newBaseSha}\trefs/heads/main`)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) return ok(`${head}\trefs/heads/feat-x`)
        if (joined.includes('merge-base --is-ancestor')) return failWith('')
        // Publisher's own head read (T1) before the rebase step's generic `--verify` probe.
        if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
        if (joined.includes('rev-parse --verify')) return ok(newBaseSha)
        if (joined.includes('rev-parse refs/heads/feat-x')) return ok(head)
        if (joined.includes('gh pr list')) return ok('42')
        if (joined.includes('gh pr diff'))
          return ghPrDiffTo(joined, 'diff --git a/shared.ts b/shared.ts\n@@ -1 +1 @@\n-a\n+b\n')
        if (joined.includes('apply --3way')) return failWith('error: patch failed: shared.ts:1')
        if (joined.includes('--diff-filter=U')) return ok('shared.ts\0other.ts')
        return ok()
      },
    })
    const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)
    const calls = h.hostCalls.map((c) => c.join(' '))

    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('REBASE CONFLICT')
    expect(final.failure_reason).toContain('needs attention')
    // It names the files a human has to look at.
    expect(final.failure_reason).toContain('shared.ts')
    expect(final.failure_reason).toContain('other.ts')
    // …and it is NOT dressed up as a review verdict: what a human reads is the attention state,
    // named as a PUBLISH-step failure. (The row's `inner_verdict` column is the INNER loop's own
    // last word — production's `writeTerminalResult` records REVIEW_NOT_RUN unless a code-block
    // reviewer produced findings; the rebase stamps no verdict of its own.)
    expect(final.failure_reason).toContain('publish failed: REBASE CONFLICT — needs attention:')
    expect(final.failure_reason).not.toContain('REQUEST_CHANGES')
    // With no resolver there is nothing to auto-resolve, and this path never drives a
    // `git rebase` (the shallow checkout makes merge-base lie there).
    expect(calls.some((c) => c.includes('rebase --continue'))).toBe(false)
    // Nothing is published on a conflict.
    expect(calls.some((c) => c.includes(' push '))).toBe(false)
    expect(calls.some((c) => c.includes('gh pr create'))).toBe(false)
    // And the scratch worktree is torn down even on the failing path.
    expect(calls.some((c) => c.includes('worktree remove --force') && c.includes('.trident-worktrees/rebase-'))).toBe(true)
  })

  /**
   * THE AUTONOMOUS PATH IS THE ONE THAT NEEDS THE RESOLVER.
   *
   * Three builds died on 2026-08-15 (`25b2327d`, `5a17ec86`, `9e813276`) with
   * `publish failed: REBASE CONFLICT` and a human resolved all three by hand — while the bounded
   * Forge resolver sat wired to the LOCAL merge path, the one where a human is already present.
   * These three tests are the fix and its two limits.
   */
  test('a configured resolver resolves the publish-path conflict IN THE SCRATCH WORKTREE, and review still re-fires', async () => {
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    const newHead = '7777777777777777777777777777777777777777'
    const newBaseSha = '6666666666666666666666666666666666666666'
    const preRebase = '2222222222222222222222222222222222222222'
    let resolverCalls = 0
    let resolverInput: {
      repo_path: string
      branch: string
      base_branch: string
      run: TridentRun
      conflicted_files: string[]
      mode?: 'rebase' | 'replay'
    } | null = null
    let lsRemotesBranch = 0
    let fires = 0
    const h = buildHarness({
      // A publish that CONTINUES re-fires review, so the run can only terminate on a second
      // verdict — the whole point of criterion 4.
      plan: () => {
        fires += 1
        return fires === 1
          ? { result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', checkpoint: 'forge-done', publishRequested: true, publishHead: head } }
          : { result: { verdict: 'APPROVE', prNumber: 42, branch: 'feat-x' } }
      },
      resolve_conflict: async (input) => {
        resolverCalls += 1
        resolverInput = input
        return { resolved: true }
      },
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (joined.includes('ls-remote --heads origin refs/heads/main')) return ok(`${newBaseSha}\trefs/heads/main`)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) {
          lsRemotesBranch += 1
          return ok(lsRemotesBranch === 1 ? `${preRebase}\trefs/heads/feat-x` : `${newHead}\trefs/heads/feat-x`)
        }
        if (joined.includes('merge-base --is-ancestor')) return failWith('')
        if (joined.includes('rev-parse --verify refs/heads/feat-x')) return ok(head)
        if (joined.includes(`--end-of-options ${head}^{commit}`)) return ok(head)
        if (joined.includes('rev-parse --verify')) return ok(newBaseSha)
        if (joined.includes('rev-parse HEAD')) return ok(newHead)
        if (joined.includes('rev-parse refs/heads/feat-x')) return ok(head)
        if (joined.includes('gh pr list')) return ok('42')
        if (joined.includes('gh pr diff'))
          return ghPrDiffTo(joined, 'diff --git a/shared.ts b/shared.ts\n@@ -1 +1 @@\n-a\n+b\n')
        if (joined.includes('apply --3way')) return failWith('error: patch failed: shared.ts:1')
        // The unmerged set BEFORE the resolver ran and AFTER it did — the same read, and the only
        // evidence the orchestrator accepts that a claimed resolution actually happened.
        if (joined.includes('--diff-filter=U')) return ok(resolverCalls === 0 ? 'shared.ts' : '')
        if (joined.includes('diff --name-only')) return ok('changed.ts')
        return ok()
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    const final = await runToTerminal(h, run.id)
    const calls = h.hostCalls.map((c) => c.join(' '))

    // Invoked exactly once — the post-resolution re-read came back clean, so the loop stopped.
    expect(resolverCalls).toBe(1)
    const input = resolverInput as unknown as {
      repo_path: string
      branch: string
      base_branch: string
      run: TridentRun
      conflicted_files: string[]
      mode?: 'rebase' | 'replay'
    }
    expect(input).not.toBeNull()
    // THE TREE IT IS POINTED AT IS THE WHOLE SAFETY PROPERTY: the throwaway scratch worktree the
    // failed `apply --3way` left the markers in — NEVER `/repo`, the checkout other lanes build in.
    expect(input.repo_path).toBe(`/repo/.trident-worktrees/rebase-${run.id}`)
    expect(input.branch).toBe('feat-x')
    expect(input.base_branch).toBe('main')
    expect(input.conflicted_files).toEqual(['shared.ts'])
    expect(input.run.id).toBe(run.id)
    // AND IT IS TOLD WHICH TREE THAT IS. `'replay'` is what makes the resolver's contract true
    // here: no rebase to `--continue`, no `node_modules` to test against, the outer loop commits.
    expect(input.mode).toBe('replay')

    // The claimed resolution is checked against git TWICE — the unmerged set and the staged bytes.
    expect(calls.some((c) => c.includes('--diff-filter=U'))).toBe(true)
    expect(calls.some((c) => c.includes('diff --cached -U1'))).toBe(true)

    // The replay then commits and the branch moves by the UNCHANGED compare-and-swap.
    expect(calls.some((c) => c.includes(`update-ref refs/heads/feat-x ${newHead} ${head}`))).toBe(true)
    expect(calls.some((c) => c.includes(`--force-with-lease=refs/heads/feat-x:${preRebase}`))).toBe(true)
    // A RESOLVED CONFLICT IS NOT AN APPROVED ONE. The run reaches terminal only through the
    // SECOND fire's verdict — the review seat ran against the resolved head.
    expect(h.refirePatches[0]?.inner_checkpoint).toMatch(new RegExp(`^outer-published:${newHead}:`))
    expect(h.inputs).toHaveLength(2)
    expect(final.phase).toBe('done')
    expect(final.failure_reason).toBeNull()
    expect(final.failure_reason ?? '').not.toContain('REBASE CONFLICT')
  })

  test('a resolver that DECLINES leaves the conflict an attention state — the typed error, not the question', async () => {
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    const newBaseSha = '6666666666666666666666666666666666666666'
    let resolverCalls = 0
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', publishRequested: true, publishHead: head } }),
      resolve_conflict: async () => {
        resolverCalls += 1
        return { resolved: false, question: 'which spelling of the publish cross-check wins here' }
      },
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (joined.includes('ls-remote --heads origin refs/heads/main')) return ok(`${newBaseSha}\trefs/heads/main`)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) return ok(`${head}\trefs/heads/feat-x`)
        if (joined.includes('merge-base --is-ancestor')) return failWith('')
        if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
        if (joined.includes('rev-parse --verify')) return ok(newBaseSha)
        if (joined.includes('gh pr list')) return ok('42')
        if (joined.includes('gh pr diff'))
          return ghPrDiffTo(joined, 'diff --git a/shared.ts b/shared.ts\n@@ -1 +1 @@\n-a\n+b\n')
        if (joined.includes('apply --3way')) return failWith('error: patch failed: shared.ts:1')
        if (joined.includes('--diff-filter=U')) return ok('shared.ts\0other.ts')
        return ok()
      },
    })
    const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)
    const calls = h.hostCalls.map((c) => c.join(' '))

    expect(resolverCalls).toBe(1)
    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('publish failed: REBASE CONFLICT — needs attention:')
    expect(final.failure_reason).toContain('shared.ts')
    expect(final.failure_reason).toContain('other.ts')
    // The attention state keeps its OWN message. A declining resolver's question belongs to the
    // local-merge escalation channel; it must not be smuggled into a publish failure reason.
    expect(final.failure_reason).not.toContain('which spelling')
    expect(final.failure_reason).not.toContain('REQUEST_CHANGES')
    expect(calls.some((c) => c.includes(' push '))).toBe(false)
    expect(calls.some((c) => c.includes('gh pr create'))).toBe(false)
    expect(calls.some((c) => c.includes('worktree remove --force') && c.includes('.trident-worktrees/rebase-'))).toBe(true)
  })

  test('a resolver that CLAIMS success without staging anything is stopped after ONE no-progress round', async () => {
    // The lie-detector, and its cost ceiling. The only evidence of resolution the orchestrator
    // accepts is the unresolved set SHRINKING — so a resolver that reports RESOLVED while the
    // markers stay put ends in exactly the same attention state, after exactly ONE wasted round.
    //
    // NOT `MAX_CONFLICT_ROUNDS` rounds. `rebaseBranchOntoBase` can spend 12 because each one is a
    // different commit that `git rebase --continue` advanced onto; here there is exactly one
    // apply, so rounds 2..12 re-hand the resolver the identical tree and cannot do anything new.
    // Each round is a real Forge turn bounded at 8 minutes, awaited inside the SERIAL tick sweep —
    // 12 of them is ~96 minutes in which no other run in the process moves at all.
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    const newBaseSha = '6666666666666666666666666666666666666666'
    let resolverCalls = 0
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', publishRequested: true, publishHead: head } }),
      resolve_conflict: async () => {
        resolverCalls += 1
        return { resolved: true }
      },
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (joined.includes('ls-remote --heads origin refs/heads/main')) return ok(`${newBaseSha}\trefs/heads/main`)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) return ok(`${head}\trefs/heads/feat-x`)
        if (joined.includes('merge-base --is-ancestor')) return failWith('')
        if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
        if (joined.includes('rev-parse --verify')) return ok(newBaseSha)
        if (joined.includes('gh pr list')) return ok('42')
        if (joined.includes('gh pr diff'))
          return ghPrDiffTo(joined, 'diff --git a/shared.ts b/shared.ts\n@@ -1 +1 @@\n-a\n+b\n')
        if (joined.includes('apply --3way')) return failWith('error: patch failed: shared.ts:1')
        // Never clears, no matter how many times the resolver says it did.
        if (joined.includes('--diff-filter=U')) return ok('shared.ts')
        return ok()
      },
    })
    const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)
    const calls = h.hostCalls.map((c) => c.join(' '))

    expect(resolverCalls).toBe(1)
    expect(resolverCalls).toBeLessThan(MAX_CONFLICT_ROUNDS)
    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('publish failed: REBASE CONFLICT — needs attention:')
    expect(final.failure_reason).toContain('shared.ts')
    expect(final.failure_reason).not.toContain('REQUEST_CHANGES')
    expect(calls.some((c) => c.includes(' push '))).toBe(false)
    expect(calls.some((c) => c.includes('worktree remove --force') && c.includes('.trident-worktrees/rebase-'))).toBe(true)
  })

  test('a resolver that stages a resolved .md with an outer marker still in it is REFUSED', async () => {
    // THE INDEX BIT IS NOT PROOF OF RESOLUTION. `git add <path>` clears the unmerged bit for the
    // whole path no matter what is left inside the file, so the realistic failure — resolve hunk
    // 1 of 2, `git add`, report RESOLVED, which is exactly what the resolver's own contract tells
    // it to do — reads as CLEAN to `--diff-filter=U`. Checking only the index would commit the
    // marker text and force-push it to the shared branch.
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    const newBaseSha = '6666666666666666666666666666666666666666'
    let resolverCalls = 0
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', publishRequested: true, publishHead: head } }),
      resolve_conflict: async () => {
        resolverCalls += 1
        return { resolved: true }
      },
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (joined.includes('ls-remote --heads origin refs/heads/main')) return ok(`${newBaseSha}\trefs/heads/main`)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) return ok(`${head}\trefs/heads/feat-x`)
        if (joined.includes('merge-base --is-ancestor')) return failWith('')
        if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
        if (joined.includes('rev-parse --verify')) return ok(newBaseSha)
        if (joined.includes('gh pr list')) return ok('42')
        if (joined.includes('gh pr diff'))
          return ghPrDiffTo(joined, 'diff --git a/notes.md b/notes.md\n@@ -1 +1 @@\n-a\n+b\n')
        if (joined.includes('apply --3way')) return failWith('error: patch failed: notes.md:1')
        // The index says DONE after the resolver's `git add` — this is the lie.
        if (joined.includes('--diff-filter=U')) return ok(resolverCalls === 0 ? 'notes.md' : '')
        // The staged bytes say otherwise. Hunk 1 was resolved, hunk 2 was not.
        if (joined.includes('diff --cached -U1'))
          return ok(
            [
              'diff --git a/notes.md b/notes.md',
              '--- a/notes.md',
              '+++ b/notes.md',
              '@@ -1,0 +2,4 @@',
              '+publishHead: oidClaim(branchHead)',
              '+<<<<<<< ours',
              '+publishHead: oidClaim(forgeSha)',
              '+>>>>>>> theirs',
            ].join('\n'),
          )
        return ok()
      },
    })
    const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)
    const calls = h.hostCalls.map((c) => c.join(' '))

    expect(resolverCalls).toBe(1)
    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('publish failed: REBASE CONFLICT — needs attention:')
    expect(final.failure_reason).toContain('notes.md')
    expect(final.failure_reason).not.toContain('REQUEST_CHANGES')
    // NOTHING IS COMMITTED, NOTHING IS SWAPPED, NOTHING IS PUSHED. The marker text never leaves
    // the throwaway worktree, which is then removed.
    expect(calls.some((c) => c.includes(' commit '))).toBe(false)
    expect(calls.some((c) => c.includes('update-ref refs/heads/feat-x'))).toBe(false)
    expect(calls.some((c) => c.includes(' push '))).toBe(false)
    expect(calls.some((c) => c.includes('worktree remove --force') && c.includes('.trident-worktrees/rebase-'))).toBe(true)
  })

  test('a markdown separator followed by surviving conflict-side content is REFUSED', async () => {
    // THE SEPARATOR IS THE RESIDUE MOST LIKELY TO SURVIVE. `<<<<<<< ours` and `>>>>>>> theirs`
    // are the visually obvious lines; a hand-resolution that keeps both sides and strips the
    // outer markers leaves a bare `=======` sitting between them, and that line used to pass this
    // gate entirely — straight onto the shared branch.
    for (const tail of [['+theirs'], [' theirs']] as const) {
      const head = 'abcdef0123456789abcdef0123456789abcdef01'
      const newBaseSha = '6666666666666666666666666666666666666666'
      let resolverCalls = 0
      const h = buildHarness({
        plan: () => ({ result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', publishRequested: true, publishHead: head } }),
        resolve_conflict: async () => {
          resolverCalls += 1
          return { resolved: true }
        },
        hostResponder: (cmd) => {
          const joined = cmd.join(' ')
          if (joined.includes('ls-remote --heads origin refs/heads/main')) return ok(`${newBaseSha}\trefs/heads/main`)
          if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) return ok(`${head}\trefs/heads/feat-x`)
          if (joined.includes('merge-base --is-ancestor')) return failWith('')
          if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
          if (joined.includes('rev-parse --verify')) return ok(newBaseSha)
          if (joined.includes('gh pr list')) return ok('42')
          if (joined.includes('gh pr diff'))
            return ghPrDiffTo(joined, 'diff --git a/docs/AS_BUILT.md b/docs/AS_BUILT.md\n@@ -1 +1 @@\n-a\n+b\n')
          if (joined.includes('apply --3way')) return failWith('error: patch failed: docs/AS_BUILT.md:1')
          // The index says DONE after the resolver's `git add` — this is the lie.
          if (joined.includes('--diff-filter=U')) return ok(resolverCalls === 0 ? 'docs/AS_BUILT.md' : '')
          // The preceding added line alone must not manufacture a Setext exemption: the surviving
          // conflict-side content immediately after the separator makes this residue.
          if (joined.includes('diff --cached -U1'))
            return ok(
              [
                'diff --git a/docs/AS_BUILT.md b/docs/AS_BUILT.md',
                '--- a/docs/AS_BUILT.md',
                '+++ b/docs/AS_BUILT.md',
                '@@ -1,2 +1,3 @@',
                '+## ours entry',
                '+=======\r',
                ...tail,
              ].join('\n'),
            )
          return ok()
        },
      })
      const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)
      const calls = h.hostCalls.map((c) => c.join(' '))

      expect(resolverCalls).toBe(1)
      expect(final.phase).toBe('failed')
      expect(final.failure_reason).toContain('publish failed: REBASE CONFLICT — needs attention:')
      expect(final.failure_reason).toContain('docs/AS_BUILT.md')
      // NOTHING IS COMMITTED, NOTHING IS SWAPPED, NOTHING IS PUSHED.
      expect(calls.some((c) => c.includes(' commit '))).toBe(false)
      expect(calls.some((c) => c.includes('update-ref refs/heads/feat-x'))).toBe(false)
      expect(calls.some((c) => c.includes(' push '))).toBe(false)
      expect(calls.some((c) => c.includes('worktree remove --force') && c.includes('.trident-worktrees/rebase-'))).toBe(true)
    }
  })

  test('a markdown setext H1 underline in a resolved doc file is NOT residue — the publish proceeds', async () => {
    // A SETEXT H1 UNDERLINE IS BYTE-IDENTICAL TO GIT'S SEPARATOR. The gate requires the markdown
    // affirmative diff evidence: the nonblank title itself was added immediately before the
    // underline. Existing text plus a separator is ambiguous conflict residue and fails closed.
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    const newHead = '7777777777777777777777777777777777777777'
    const newBaseSha = '6666666666666666666666666666666666666666'
    const preRebase = '2222222222222222222222222222222222222222'
    let resolverCalls = 0
    let resolverInput: { conflicted_files: string[] } | null = null
    let lsRemotesBranch = 0
    let fires = 0
    const h = buildHarness({
      plan: () => {
        fires += 1
        return fires === 1
          ? { result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', checkpoint: 'forge-done', publishRequested: true, publishHead: head } }
          : { result: { verdict: 'APPROVE', prNumber: 42, branch: 'feat-x' } }
      },
      resolve_conflict: async (input) => {
        resolverCalls += 1
        resolverInput = input as unknown as { conflicted_files: string[] }
        return { resolved: true }
      },
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (joined.includes('ls-remote --heads origin refs/heads/main')) return ok(`${newBaseSha}\trefs/heads/main`)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) {
          lsRemotesBranch += 1
          return ok(lsRemotesBranch === 1 ? `${preRebase}\trefs/heads/feat-x` : `${newHead}\trefs/heads/feat-x`)
        }
        if (joined.includes('merge-base --is-ancestor')) return failWith('')
        if (joined.includes('rev-parse --verify refs/heads/feat-x')) return ok(head)
        if (joined.includes(`--end-of-options ${head}^{commit}`)) return ok(head)
        if (joined.includes('rev-parse --verify')) return ok(newBaseSha)
        if (joined.includes('rev-parse HEAD')) return ok(newHead)
        if (joined.includes('rev-parse refs/heads/feat-x')) return ok(head)
        if (joined.includes('gh pr list')) return ok('42')
        if (joined.includes('gh pr diff'))
          return ghPrDiffTo(joined, 'diff --git "a/docs/notes\\t.md" "b/docs/notes\\t.md"\n@@ -1 +1 @@\n-a\n+b\n')
        if (joined.includes('apply --3way')) return failWith('error: patch failed')
        if (joined.includes('--diff-filter=U')) return ok(resolverCalls === 0 ? 'docs/notes\t.md\0' : '')
        if (joined.includes('diff --cached -U1'))
          return ok(
            [
              'diff --git "a/docs/notes\\t.md" "b/docs/notes\\t.md"',
              '--- "a/docs/notes\\t.md"',
              '+++ "b/docs/notes\\t.md"',
              '@@ -1,1 +2,4 @@',
              '+Release notes',
              '+=======',
              '+',
              '+Details',
            ].join('\n'),
          )
        if (joined.includes('diff --name-only')) return ok('docs/notes\t.md')
        return ok()
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    const final = await runToTerminal(h, run.id)
    const calls = h.hostCalls.map((c) => c.join(' '))

    expect(resolverCalls).toBe(1)
    expect((resolverInput as unknown as { conflicted_files: string[] }).conflicted_files).toEqual(['docs/notes\t.md'])
    expect(calls.some((c) => c.includes('diff --cached -U1'))).toBe(true)
    // The compare-and-swap happened: the setext underline was never mistaken for residue.
    expect(calls.some((c) => c.includes(`update-ref refs/heads/feat-x ${newHead} ${head}`))).toBe(true)
    expect(final.phase).toBe('done')
    expect(final.failure_reason).toBeNull()
  })

  test('a suffixed or indented run of = in a code file is not the separator — the publish proceeds', async () => {
    // GIT'S SEPARATOR NEVER CARRIES A LABEL and never sits anywhere but column 0, so the rule is
    // an EXACT bare line. A quoted `"======="`, an indented run, and a suffixed run are content.
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    const newHead = '7777777777777777777777777777777777777777'
    const newBaseSha = '6666666666666666666666666666666666666666'
    const preRebase = '2222222222222222222222222222222222222222'
    let resolverCalls = 0
    let lsRemotesBranch = 0
    let fires = 0
    const h = buildHarness({
      plan: () => {
        fires += 1
        return fires === 1
          ? { result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', checkpoint: 'forge-done', publishRequested: true, publishHead: head } }
          : { result: { verdict: 'APPROVE', prNumber: 42, branch: 'feat-x' } }
      },
      resolve_conflict: async () => {
        resolverCalls += 1
        return { resolved: true }
      },
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (joined.includes('ls-remote --heads origin refs/heads/main')) return ok(`${newBaseSha}\trefs/heads/main`)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) {
          lsRemotesBranch += 1
          return ok(lsRemotesBranch === 1 ? `${preRebase}\trefs/heads/feat-x` : `${newHead}\trefs/heads/feat-x`)
        }
        if (joined.includes('merge-base --is-ancestor')) return failWith('')
        if (joined.includes('rev-parse --verify refs/heads/feat-x')) return ok(head)
        if (joined.includes(`--end-of-options ${head}^{commit}`)) return ok(head)
        if (joined.includes('rev-parse --verify')) return ok(newBaseSha)
        if (joined.includes('rev-parse HEAD')) return ok(newHead)
        if (joined.includes('rev-parse refs/heads/feat-x')) return ok(head)
        if (joined.includes('gh pr list')) return ok('42')
        if (joined.includes('gh pr diff'))
          return ghPrDiffTo(joined, 'diff --git a/shared.ts b/shared.ts\n@@ -1 +1 @@\n-a\n+b\n')
        if (joined.includes('apply --3way')) return failWith('error: patch failed: shared.ts:1')
        if (joined.includes('--diff-filter=U')) return ok(resolverCalls === 0 ? 'shared.ts' : '')
        if (joined.includes('diff --cached -U1'))
          return ok(
            [
              'diff --git a/shared.ts b/shared.ts',
              '--- a/shared.ts',
              '+++ b/shared.ts',
              '@@ -1,0 +2,3 @@',
              '+const banner = "======="',
              '+  =======',
              '+=======trailing',
              '+>>> quoted',
            ].join('\n'),
          )
        if (joined.includes('diff --name-only')) return ok('changed.ts')
        return ok()
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    const final = await runToTerminal(h, run.id)
    const calls = h.hostCalls.map((c) => c.join(' '))

    expect(resolverCalls).toBe(1)
    expect(calls.some((c) => c.includes(`update-ref refs/heads/feat-x ${newHead} ${head}`))).toBe(true)
    expect(final.phase).toBe('done')
    expect(final.failure_reason).toBeNull()
  })

  // A VERIFICATION THAT CANNOT RUN IS NOT A VERIFICATION THAT PASSED. Both post-resolution reads
  // used to swallow a failed command and return an empty list, which the loop reads as "nothing
  // unmerged, no markers staged — the resolver was telling the truth". A `git diff` that never ran
  // would have been accepted as git's own evidence that the tree is clean, and the run would go on
  // to commit and force-push whatever the resolver actually left. The resolver's claim is the one
  // thing in this path that is never evidence, so when git cannot be asked there is nothing to
  // check the claim against, and the only safe answer is to refuse. Both commands get their own
  // test because they fail independently and either one alone is enough to lose the invariant.
  for (const failing of [
    { label: 'the unmerged-path read', match: '--diff-filter=U', stderr: 'fatal: not a git repository' },
    { label: 'the staged-marker scan', match: 'diff --cached -U1', stderr: 'fatal: bad object HEAD' },
  ]) {
    test(`a resolver claiming RESOLVED is REFUSED when ${failing.label} cannot run — it never fails open`, async () => {
      const head = 'abcdef0123456789abcdef0123456789abcdef01'
      const newBaseSha = '6666666666666666666666666666666666666666'
      let resolverCalls = 0
      const h = buildHarness({
        plan: () => ({ result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', publishRequested: true, publishHead: head } }),
        resolve_conflict: async () => {
          resolverCalls += 1
          return { resolved: true }
        },
        hostResponder: (cmd) => {
          const joined = cmd.join(' ')
          if (joined.includes('ls-remote --heads origin refs/heads/main')) return ok(`${newBaseSha}\trefs/heads/main`)
          if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) return ok(`${head}\trefs/heads/feat-x`)
          if (joined.includes('merge-base --is-ancestor')) return failWith('')
          if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
          if (joined.includes('rev-parse --verify')) return ok(newBaseSha)
          if (joined.includes('gh pr list')) return ok('42')
          if (joined.includes('gh pr diff'))
            return ghPrDiffTo(joined, 'diff --git a/shared.ts b/shared.ts\n@@ -1 +1 @@\n-a\n+b\n')
          if (joined.includes('apply --3way')) return failWith('error: patch failed: shared.ts:1')
          // The FIRST unmerged read must succeed — otherwise the resolver is never reached and the
          // test would prove nothing about post-resolution verification.
          if (joined.includes(failing.match) && resolverCalls > 0) return failWith(failing.stderr)
          if (joined.includes('--diff-filter=U')) return ok('shared.ts')
          if (joined.includes('diff --cached -U1')) return ok('')
          return ok()
        },
      })
      const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)
      const calls = h.hostCalls.map((c) => c.join(' '))

      expect(resolverCalls).toBe(1)
      expect(final.phase).toBe('failed')
      // Refused for the REASON IT ACTUALLY FAILED — git's own words, and an explicit statement
      // that this is an unverifiable resolution rather than a merge conflict.
      expect(final.failure_reason).toContain('could not read the conflict state of')
      expect(final.failure_reason).toContain(failing.stderr)
      expect(final.failure_reason).toContain('CANNOT be verified')
      expect(final.failure_reason).not.toContain('REBASE CONFLICT')
      // NOTHING IS COMMITTED, NOTHING IS SWAPPED, NOTHING IS PUSHED.
      expect(calls.some((c) => c.includes(' commit '))).toBe(false)
      expect(calls.some((c) => c.includes('update-ref refs/heads/feat-x'))).toBe(false)
      expect(calls.some((c) => c.includes(' push '))).toBe(false)
    })
  }

  test('PARTIAL resolution is progress: round 2 is handed only the files round 1 left', async () => {
    // Two conflicts, one resolved per round. The re-read shrinking is what buys the second round,
    // and the second round must see the REMAINDER — not the original set, and not everything again.
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    const newHead = '7777777777777777777777777777777777777777'
    const newBaseSha = '6666666666666666666666666666666666666666'
    const preRebase = '2222222222222222222222222222222222222222'
    const handed: string[][] = []
    let lsRemotesBranch = 0
    let fires = 0
    const h = buildHarness({
      plan: () => {
        fires += 1
        return fires === 1
          ? { result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', checkpoint: 'forge-done', publishRequested: true, publishHead: head } }
          : { result: { verdict: 'APPROVE', prNumber: 42, branch: 'feat-x' } }
      },
      resolve_conflict: async (input) => {
        handed.push([...input.conflicted_files])
        return { resolved: true }
      },
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (joined.includes('ls-remote --heads origin refs/heads/main')) return ok(`${newBaseSha}\trefs/heads/main`)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) {
          lsRemotesBranch += 1
          return ok(lsRemotesBranch === 1 ? `${preRebase}\trefs/heads/feat-x` : `${newHead}\trefs/heads/feat-x`)
        }
        if (joined.includes('merge-base --is-ancestor')) return failWith('')
        if (joined.includes('rev-parse --verify refs/heads/feat-x')) return ok(head)
        if (joined.includes(`--end-of-options ${head}^{commit}`)) return ok(head)
        if (joined.includes('rev-parse --verify')) return ok(newBaseSha)
        if (joined.includes('rev-parse HEAD')) return ok(newHead)
        if (joined.includes('rev-parse refs/heads/feat-x')) return ok(head)
        if (joined.includes('gh pr list')) return ok('42')
        if (joined.includes('gh pr diff')) return ghPrDiffTo(joined, 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b\n')
        if (joined.includes('apply --3way')) return failWith('error: patch failed: a.ts:1')
        // Two, then one, then none.
        if (joined.includes('--diff-filter=U')) {
          if (handed.length === 0) return ok('a.ts\0b.ts')
          if (handed.length === 1) return ok('b.ts')
          return ok('')
        }
        if (joined.includes('diff --name-only')) return ok('changed.ts')
        return ok()
      },
    })
    const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)

    expect(handed).toEqual([['a.ts', 'b.ts'], ['b.ts']])
    // Both rounds shrank the set, so the bound was never the thing that stopped it.
    expect(handed.length).toBeLessThan(MAX_CONFLICT_ROUNDS)
    expect(final.phase).toBe('done')
    expect(final.failure_reason).toBeNull()
  })

  test('a non-ASCII conflicted path reaches the resolver as a name it can actually open', async () => {
    // `git diff --name-only` C-QUOTES by default: `ünicode file.txt` comes back as
    // `"\303\274nicode file.txt"`, which names no file on disk and matches no pathspec. This list
    // is machine-consumed now (it IS the resolver's CONFLICTED FILES), so it is read with
    // `-z` + `core.quotePath=false` and the raw bytes survive.
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    const newBaseSha = '6666666666666666666666666666666666666666'
    const odd = 'ünicode file.txt'
    let handed: string[] = []
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', publishRequested: true, publishHead: head } }),
      resolve_conflict: async (input) => {
        handed = [...input.conflicted_files]
        return { resolved: false, question: 'nope' }
      },
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (joined.includes('ls-remote --heads origin refs/heads/main')) return ok(`${newBaseSha}\trefs/heads/main`)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) return ok(`${head}\trefs/heads/feat-x`)
        if (joined.includes('merge-base --is-ancestor')) return failWith('')
        if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
        if (joined.includes('rev-parse --verify')) return ok(newBaseSha)
        if (joined.includes('gh pr list')) return ok('42')
        if (joined.includes('gh pr diff')) return ghPrDiffTo(joined, 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n')
        if (joined.includes('apply --3way')) return failWith('error: patch failed')
        if (joined.includes('--diff-filter=U')) return ok(`${odd}\0plain.ts`)
        return ok()
      },
    })
    await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)
    const calls = h.hostCalls.map((c) => c.join(' '))

    expect(handed).toEqual([odd, 'plain.ts'])
    // The read that produced them asks git not to quote, and to separate with NUL — a name with a
    // space in it cannot survive newline-splitting-plus-trimming either.
    expect(calls.some((c) => c.includes('core.quotePath=false') && c.includes('-z --name-only --diff-filter=U'))).toBe(true)
  })

  test('a resolution that leaves NOTHING to commit is an attention state, quoting git — not a bare "could not commit"', async () => {
    // TAKING THE BASE'S SIDE OF EVERY HUNK IS A RESOLUTION THAT ERASES THE BRANCH. `git commit`
    // then refuses with "nothing to commit" — on STDOUT, which the failure reason used to drop,
    // producing a bare `outer publisher could not commit the rebase of branch feat-x` right after
    // the `finally` deleted the tree that held the evidence. A branch that now contributes nothing
    // is a MERGEABILITY fact, so it lands in the same non-verdict attention state as the conflict
    // it came from.
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    const newBaseSha = '6666666666666666666666666666666666666666'
    let resolverCalls = 0
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', publishRequested: true, publishHead: head } }),
      resolve_conflict: async () => {
        resolverCalls += 1
        return { resolved: true }
      },
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (joined.includes('ls-remote --heads origin refs/heads/main')) return ok(`${newBaseSha}\trefs/heads/main`)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) return ok(`${head}\trefs/heads/feat-x`)
        if (joined.includes('merge-base --is-ancestor')) return failWith('')
        if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
        if (joined.includes('rev-parse --verify')) return ok(newBaseSha)
        if (joined.includes('gh pr list')) return ok('42')
        if (joined.includes('gh pr diff'))
          return ghPrDiffTo(joined, 'diff --git a/shared.ts b/shared.ts\n@@ -1 +1 @@\n-a\n+b\n')
        if (joined.includes('apply --3way')) return failWith('error: patch failed: shared.ts:1')
        if (joined.includes('--diff-filter=U')) return ok(resolverCalls === 0 ? 'shared.ts' : '')
        // git says it on STDOUT and says nothing at all on stderr.
        if (joined.includes(' commit '))
          return { ok: false, stdout: 'nothing to commit, working tree clean', stderr: '', exit_code: 1 }
        return ok()
      },
    })
    const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)
    const calls = h.hostCalls.map((c) => c.join(' '))

    expect(resolverCalls).toBe(1)
    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('publish failed: REBASE CONFLICT — needs attention:')
    expect(final.failure_reason).toContain('shared.ts')
    expect(final.failure_reason).not.toContain('REQUEST_CHANGES')
    expect(calls.some((c) => c.includes('update-ref refs/heads/feat-x'))).toBe(false)
    expect(calls.some((c) => c.includes(' push '))).toBe(false)
  })

  test('a commit failure with NO resolution still quotes git, wherever git wrote it', async () => {
    // The same discard, on the ordinary clean-apply path: stdout-only diagnoses must reach the
    // failure reason instead of being replaced by the generic step name.
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    const newBaseSha = '6666666666666666666666666666666666666666'
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', publishRequested: true, publishHead: head } }),
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (joined.includes('ls-remote --heads origin refs/heads/main')) return ok(`${newBaseSha}\trefs/heads/main`)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) return ok(`${head}\trefs/heads/feat-x`)
        if (joined.includes('merge-base --is-ancestor')) return failWith('')
        if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
        if (joined.includes('rev-parse --verify')) return ok(newBaseSha)
        if (joined.includes('gh pr list')) return ok('42')
        if (joined.includes('gh pr diff'))
          return ghPrDiffTo(joined, 'diff --git a/shared.ts b/shared.ts\n@@ -1 +1 @@\n-a\n+b\n')
        if (joined.includes(' commit '))
          return { ok: false, stdout: 'nothing to commit, working tree clean', stderr: '', exit_code: 1 }
        return ok()
      },
    })
    const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)

    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('could not commit the rebase of branch feat-x')
    expect(final.failure_reason).toContain('nothing to commit')
    // No resolution happened, so this is NOT the conflict attention state.
    expect(final.failure_reason).not.toContain('REBASE CONFLICT')
  })

  test('a WHOLESALE apply failure (nothing unmerged) is never handed to the resolver, even with one configured', async () => {
    // THE SEAM BETWEEN THE TWO FIXES. #292 established that a failed apply leaving ZERO unmerged
    // paths is not a merge conflict at all — `git apply` refused the patch outright — and must
    // surface git's own stderr rather than `conflicts with main in: (paths unreadable)`. Adding
    // auto-resolution must not walk that back: there is nothing unmerged for a resolver to
    // reconcile, so it is not called, and the failure keeps its wholesale wording.
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    const newBaseSha = '6666666666666666666666666666666666666666'
    let resolverCalls = 0
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', publishRequested: true, publishHead: head } }),
      resolve_conflict: async () => {
        resolverCalls += 1
        return { resolved: true }
      },
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (joined.includes('ls-remote --heads origin refs/heads/main')) return ok(`${newBaseSha}\trefs/heads/main`)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) return ok(`${head}\trefs/heads/feat-x`)
        if (joined.includes('merge-base --is-ancestor')) return failWith('')
        if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
        if (joined.includes('rev-parse --verify')) return ok(newBaseSha)
        if (joined.includes('gh pr list')) return ok('42')
        if (joined.includes('gh pr diff'))
          return ghPrDiffTo(joined, 'diff --git a/shared.ts b/shared.ts\n@@ -1 +1 @@\n-a\n+b\n')
        if (joined.includes('apply --3way')) return failWith('error: corrupt patch at line 42')
        // Nothing was staged, so nothing is unmerged — the signature of a wholesale refusal.
        if (joined.includes('--diff-filter=U')) return ok('')
        return ok()
      },
    })
    const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)
    const calls = h.hostCalls.map((c) => c.join(' '))

    expect(resolverCalls).toBe(0)
    expect(final.phase).toBe('failed')
    // git's own words, and the explicit denial that this is a conflict.
    expect(final.failure_reason).toContain('corrupt patch at line 42')
    expect(final.failure_reason).toContain('failed WHOLESALE')
    expect(final.failure_reason).not.toContain('REBASE CONFLICT')
    expect(final.failure_reason).not.toContain('paths unreadable')
    expect(calls.some((c) => c.includes(' push '))).toBe(false)
    expect(calls.some((c) => c.includes('worktree remove --force') && c.includes('.trident-worktrees/rebase-'))).toBe(true)
  })

  test('an empty base-to-head diff terminates before review re-fire', async () => {
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    const stale = '9'.repeat(40)
    let lsRemotes = 0
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', publishRequested: true, publishHead: head } }),
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
        // No remote base → the rebase step is a no-op and the head is unchanged.
        if (joined.includes('ls-remote --heads origin refs/heads/main')) return ok('')
        if (joined.includes('ls-remote --heads')) {
          // Stale first so the run gets PAST the zero-ahead gate and reaches the diff check.
          lsRemotes += 1
          return ok(lsRemotes === 1 ? `${stale}\trefs/heads/feat-x` : `${head}\trefs/heads/feat-x`)
        }
        if (joined.includes('gh pr list')) return ok('42')
        if (joined.includes('diff --name-only')) return ok('')
        return ok()
      },
    })
    const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)
    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('empty diff')
    expect(h.inputs).toHaveLength(1)
  })

  /**
   * A COMMIT OID IS READ, NOT REPORTED (defect 2026-08-14, run `3d2696c3`).
   *
   * The build succeeded, committed, and the branch is one commit ahead of its PR — and the
   * run was filed REQUEST_CHANGES because a 40-character hex string did not survive being
   * relayed through a bookkeeping model. The head the publisher pins now comes from
   * `rev-parse --verify` on the branch the inner loop NAMES (a value a model cannot plausibly
   * mangle); an agent-supplied sha is only ever a CHECK against it.
   */
  const publishFixture = (over: { publishHead?: string | null }, remoteAlwaysHead = false) => {
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    const stale = '9'.repeat(40)
    let fires = 0
    let lsRemotes = 0
    const h = buildHarness({
      plan: () => {
        fires += 1
        return fires === 1
          ? {
              result: {
                verdict: 'REQUEST_CHANGES',
                branch: 'feat-x',
                checkpoint: 'forge-done',
                publishRequested: true,
                ...over,
              },
            }
          : { result: { verdict: 'APPROVE', prNumber: 42, branch: 'feat-x' } }
      },
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) {
          lsRemotes += 1
          return ok(
            !remoteAlwaysHead && lsRemotes === 1
              ? `${stale}\trefs/heads/feat-x`
              : `${head}\trefs/heads/feat-x`,
          )
        }
        if (joined.includes('gh pr list')) return ok('42')
        if (joined.includes('diff --name-only')) return ok('changed.ts')
        return ok()
      },
    })
    return { h, head }
  }

  test('a build that reports NO sha still publishes — the head is read from git', async () => {
    const { h, head } = publishFixture({ publishHead: null })
    const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)
    const calls = h.hostCalls.map((c) => c.join(' '))

    expect(final.phase).toBe('done')
    expect(calls.some((c) => c.includes(' push '))).toBe(true)
    // The checkpoint pins the FULL OID `rev-parse` produced — nothing about it came from the result.
    expect(h.inputs[1]!.resume_checkpoint).toBe(`outer-published:${head}:0:1`)
  })

  test('an abbreviated 7-char sha publishes, and the checkpoint pins the FULL resolved OID', async () => {
    const abbreviated = 'abcdef0123456789abcdef0123456789abcdef01'.slice(0, 7)
    const { h, head } = publishFixture({ publishHead: abbreviated })
    const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)

    expect(final.phase).toBe('done')
    expect(h.hostCalls.map((c) => c.join(' ')).some((c) => c.includes(' push '))).toBe(true)
    expect(h.inputs[1]!.resume_checkpoint).toBe(`outer-published:${head}:0:1`)
  })

  test('a claimed sha that disagrees with rev-parse FAILS, naming both values', async () => {
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    // Full-length and abbreviated claims both resolve to a real, different commit.
    for (const claimed of ['f'.repeat(40), 'baddad1']) {
      let lsRemotes = 0
      const h = buildHarness({
        plan: () => ({
          result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', publishRequested: true, publishHead: claimed },
        }),
        hostResponder: (cmd) => {
          const joined = cmd.join(' ')
          if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
          if (joined.includes(`--end-of-options ${claimed}^{commit}`)) return ok('f'.repeat(40))
          if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) {
            return ok(`${++lsRemotes === 1 ? '9'.repeat(40) : head}\trefs/heads/feat-x`)
          }
          return ok()
        },
      })
      const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)
      const calls = h.hostCalls.map((c) => c.join(' '))

      expect(final.phase).toBe('failed')
      expect(final.failure_reason).toContain(claimed)
      expect(final.failure_reason).toContain(head)
      expect(final.failure_reason).not.toContain('Argus')
      expect(calls.some((c) => c.includes(' push '))).toBe(true)
      expect(calls.some((c) => c.includes('gh pr create'))).toBe(false)
      expect(h.inputs).toHaveLength(1)
    }
  })

  test('first publish refuses a branch not cut from the pinned base', async () => {
    const base = 'b'.repeat(40)
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    const h = buildHarness({
      plan: () => ({
        result: {
          verdict: 'REQUEST_CHANGES',
          branch: 'feat-x',
          checkpoint: 'forge-done',
          publishRequested: true,
          publishHead: head,
        },
      }),
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) return ok('')
        if (joined.includes(`merge-base --is-ancestor ${base} ${head}`)) {
          return { ok: false, stdout: '', stderr: '', exit_code: 1 }
        }
        return ok()
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await store.update(run.id, { base_sha: base })
    const final = await runToTerminal(h, run.id)
    const calls = h.hostCalls.map((c) => c.join(' '))

    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toBe(
      `publish failed: branch feat-x does not contain the origin/main tip pinned at launch (${base.slice(0, 7)}) — not cut from origin/main; refusing to publish work built on another lane's branch. Verify the card instead of rebuilding.`,
    )
    expect(final.failure_reason).toContain('not cut from origin/')
    expect(final.failure_reason).toContain("refusing to publish work built on another lane's branch")
    expect(final.failure_reason).toContain('Verify the card instead of rebuilding')
    expect(final.failure_reason).toContain(base.slice(0, 7))
    expect(calls.some((c) => c.includes(' push '))).toBe(false)
    expect(calls.some((c) => c.includes('gh pr diff'))).toBe(false)
    expect(calls.some((c) => c.includes('.trident-worktrees/rebase-'))).toBe(false)
  })

  test('first publish proceeds when the branch contains the pinned base', async () => {
    const base = 'b'.repeat(40)
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    let fires = 0
    let branchReads = 0
    const h = buildHarness({
      plan: () => {
        fires += 1
        return fires === 1
          ? {
              result: {
                verdict: 'REQUEST_CHANGES',
                branch: 'feat-x',
                checkpoint: 'forge-done',
                publishRequested: true,
                publishHead: head,
              },
            }
          : { result: { verdict: 'APPROVE', prNumber: 42, branch: 'feat-x' } }
      },
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) {
          branchReads += 1
          return branchReads === 1 ? ok('') : ok(`${head}\trefs/heads/feat-x`)
        }
        if (joined.includes(`merge-base --is-ancestor ${base} ${head}`)) return ok()
        if (joined.includes('gh pr list')) return ok('42')
        if (joined.includes('diff --name-only')) return ok('changed.ts')
        return ok()
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await store.update(run.id, { base_sha: base })
    const final = await runToTerminal(h, run.id)
    const calls = h.hostCalls.map((c) => c.join(' '))

    expect(final.phase).toBe('done')
    expect(calls).toContain(`git -C /repo merge-base --is-ancestor ${base} ${head}`)
    expect(calls.some((c) => c.includes(' push '))).toBe(true)
    expect(h.inputs[1]!.resume_checkpoint).toBe(`outer-published:${head}:0:1`)
  })

  test('a null base pin skips the first-publish cut assertion', async () => {
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    let fires = 0
    let branchReads = 0
    const h = buildHarness({
      plan: () => {
        fires += 1
        return fires === 1
          ? {
              result: {
                verdict: 'REQUEST_CHANGES',
                branch: 'feat-x',
                checkpoint: 'forge-done',
                publishRequested: true,
                publishHead: head,
              },
            }
          : { result: { verdict: 'APPROVE', prNumber: 42, branch: 'feat-x' } }
      },
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) {
          branchReads += 1
          return branchReads === 1 ? ok('') : ok(`${head}\trefs/heads/feat-x`)
        }
        if (joined.includes('gh pr list')) return ok('42')
        if (joined.includes('diff --name-only')) return ok('changed.ts')
        return ok()
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await store.update(run.id, { inner_checkpoint: 'forge-done' })
    const final = await runToTerminal(h, run.id)
    const calls = h.hostCalls.map((c) => c.join(' '))

    expect(final.phase).toBe('done')
    expect(calls.some((c) => c.includes('merge-base --is-ancestor'))).toBe(false)
    expect(calls.some((c) => c.includes(' push '))).toBe(true)
  })

  test('a branch already fully on origin publishes as a NO-OP success — the work was simply already published', async () => {
    // 3 occurrences 2026-08-17 (runs 26ed32c1 / 88efe1ca / 95fcfb91): the remote already at
    // the built sha used to be refused as "the build left no new commits to publish", failing
    // a finished build and inviting a relaunch that rebuilds pushed work. The publisher now
    // resolves to that commit and continues; the genuine nothing-built outcome is the
    // EMPTY-DIFF refusal, tested above.
    const { h, head } = publishFixture({ publishHead: null }, true)
    const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)
    const calls = h.hostCalls.map((c) => c.join(' '))

    expect(final.phase).toBe('done')
    expect(final.failure_reason).toBeNull()
    // The publisher RESOLVED to the already-published commit and re-fired review on it:
    expect(h.inputs[1]!.resume_checkpoint).toBe(`outer-published:${head}:0:1`)
    // …without performing the push it did not have to perform:
    expect(calls.some((c) => c.includes('--force-with-lease'))).toBe(false)
  })

  test('the no-op publish is visible in the record — the note says the push was a no-op because the ref was already correct', async () => {
    const { h, head } = publishFixture({ publishHead: null }, true)
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await h.loop.runOnce() // fire the inner workflow
    await h.complete()     // it writes the publish-requested terminal result
    const outcome = await h.step(store.get(run.id)!) // harvest → the publish transition
    expect(outcome.note).toContain('push no-op')
    expect(outcome.note).toContain('the ref was already correct')
    expect(outcome.note).toContain(head)
  })

  describe('remoteAlreadyAtPublishHead — the push-necessity predicate', () => {
    const H = 'abcdef0123456789abcdef0123456789abcdef01'
    test('remote already exactly at the head to publish → no-op', () => {
      expect(remoteAlreadyAtPublishHead(H, H)).toBe(true)
    })
    test('an empty observation is a FIRST PUSH, never a no-op', () => {
      expect(remoteAlreadyAtPublishHead('', H)).toBe(false)
    })
    test('a stale remote still needs the real lease push', () => {
      expect(remoteAlreadyAtPublishHead('9'.repeat(40), H)).toBe(false)
    })
  })

  test('pr mode: fires, harvests inner_result, merges PR, persists inner_verdict', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', prNumber: 42, branch: 'feat-x' } }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    expect(final.pr).toBe(42)
    expect(final.branch).toBe('feat-x')
    expect(final.inner_verdict).toBe('APPROVE')
    expect(final.inner_checkpoint).toBe('argus-approved')
    expect(final.workflow_run_id).not.toBeNull()
    // #545 — the merge is PINNED to the head the review judged, so a commit that
    // landed after the APPROVE makes GitHub refuse instead of shipping unreviewed.
    expect(h.hostCalls.map((c) => c.join(' '))).toContain(
      `gh pr merge 42 --squash --match-head-commit ${SIM_REVIEWED_HEAD}`,
    )
    // exactly one fire.
    expect(h.inputs.length).toBe(1)
  })

  test('local mode: merges branch into base locally, never calls gh merge', async () => {
    const h = buildHarness({ plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }) })
    const run = await createRun({ merge_mode: 'local' as MergeMode })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    const joined = h.hostCalls.map((c) => c.join(' '))
    expect(joined).toContain('git -C /repo checkout main')
    expect(joined.some((c) => c.startsWith('git -C /repo merge --no-ff feat-x'))).toBe(true)
    expect(joined.some((c) => c.startsWith('gh pr merge'))).toBe(false)
    // #351 — the run row now RECORDS its dedicated merge worktree (was always
    // empty), and the rebase ran inside it (isolation), not the shared checkout.
    expect(final.worktree).toBe(runWorktreePath('/repo', final))
    expect(joined.some((c) => c.includes(`worktree add --detach --force ${final.worktree}`))).toBe(true)
    expect(joined.some((c) => c === `git -C ${final.worktree} rebase main`)).toBe(true)
  })
})

describe('orchestrator — the committed mutation nomination reaches the gate', () => {
  const ARTIFACT_CLAIM = {
    file: 'trident/limit.ts',
    find: 'n < LIMIT',
    replace: 'true',
    guard: ['bun', 'test', 'trident/limit.test.ts'],
    control: ['bun', 'test', 'trident/other.test.ts'],
  }
  // The PER-BRANCH artifact path, derived by the production helper from the branch
  // the sim plan resolves — never spelled out here, so a layout change reddens.
  const ARTIFACT_PATH = mutationClaimArtifactPath('feat-x') as string
  // The diff-membership leg, at the REVIEWED oid: the nomination only counts as
  // this build's if it is in the branch's own diff. The base is the base BRANCH
  // NAME the run resolves, exactly as `git diff` has always taken it.
  const DIFF_ARTIFACT = `git -C /repo diff --name-only main...${SIM_REVIEWED_HEAD}`
  const SIZE_ARTIFACT = `git -C /repo cat-file -s ${SIM_REVIEWED_HEAD}:${ARTIFACT_PATH}`
  const SHOW_ARTIFACT = `git -C /repo show ${SIM_REVIEWED_HEAD}:${ARTIFACT_PATH}`

  /** A host that serves the three legs of a successful committed-nomination read. */
  function serveArtifact(body: string): (cmd: string[]) => HostCommandResult {
    return (cmd) => {
      const j = cmd.join(' ')
      if (j === DIFF_ARTIFACT) return ok(`${ARTIFACT_PATH}\ntrident/limit.ts\n`)
      if (j === SIZE_ARTIFACT) return ok(String(Buffer.byteLength(body, 'utf8')))
      if (j === SHOW_ARTIFACT) return ok(body)
      return ok()
    }
  }

  /** Records every claim the gate was handed; mirrors the REAL gate's null
   *  refusal (mutation-prover.ts's "nominated no mutation" reason) so a null
   *  claim terminates exactly as production does. */
  function claimSpyGate(seen: unknown[]) {
    return async (input: MutationGateInput): Promise<MutationGateOutcome> => {
      seen.push(input.claim ?? null)
      if (input.claim === null || input.claim === undefined) {
        return {
          ok: false,
          // The PRODUCTION constant, not a copy of its text: the orchestrator
          // appends the reader's note to THIS refusal by exact match, so a
          // literal here would let the two drift apart silently.
          reason: NO_NOMINATION_REFUSAL,
          exempt: false,
          evidence: null,
        }
      }
      return { ok: true, reason: 'spy accepted the nominated claim', exempt: false, evidence: null }
    }
  }

  test('a null in-result claim falls back to the COMMITTED nomination at the reviewed OID — and the gate receives it', async () => {
    const seen: unknown[] = []
    const h = buildHarness({
      prove_mutation: claimSpyGate(seen),
      // No `mutationClaim` key in the sim result → `mutation_claim` parses to
      // null, which is exactly what a codex-routed build reports today.
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      // A REAL cleanup would provision a worktree at a `/repo` that does not exist.
      merge_deps: {},
      hostResponder: serveArtifact(JSON.stringify(ARTIFACT_CLAIM)),
    })
    const run = await createRun()

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    expect(seen).toHaveLength(1)
    // Positive control: the deep-equal below cannot pass on an empty extraction.
    expect(seen[0]).not.toBeNull()
    expect(seen[0]).toEqual(parseMutationClaim(ARTIFACT_CLAIM))
    // Bound to the REVIEWED OID (the commit the gate pins), never the branch
    // tip — the whole argv, because this is the injection surface.
    expect(h.hostCalls).toContainEqual(['git', '-C', '/repo', 'show', `${SIM_REVIEWED_HEAD}:${ARTIFACT_PATH}`])
    // ...and the path is the PER-BRANCH one, so a nomination inherited from a
    // merged branch's file is not even looked at.
    expect(ARTIFACT_PATH).toBe('.trident/mutation-claims/feat-x.json')
  })

  test('an artifact this branch did NOT write is ignored — an inherited nomination is not a nomination', async () => {
    // The tracked-path inheritance defect: after one branch merges, every later
    // branch is born holding that file. It is absent from THIS branch's diff, so
    // the read must be null and the required proof must still refuse.
    const seen: unknown[] = []
    const h = buildHarness({
      prove_mutation: claimSpyGate(seen),
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      merge_deps: {},
      hostResponder: (cmd) => {
        const j = cmd.join(' ')
        // The blob EXISTS and is perfectly well-formed at the reviewed commit...
        if (j === SIZE_ARTIFACT) return ok(String(Buffer.byteLength(JSON.stringify(ARTIFACT_CLAIM), 'utf8')))
        if (j === SHOW_ARTIFACT) return ok(JSON.stringify(ARTIFACT_CLAIM))
        // ...but this branch's own diff never touched it.
        if (j === DIFF_ARTIFACT) return ok('trident/limit.ts\n')
        return ok()
      },
    })
    const run = await createRun()

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('failed')
    expect(seen).toEqual([null])
    // The refusal NAMES the reason, instead of collapsing into the same sentence
    // a genuine no-nomination build gets.
    expect(final.failure_reason).toContain(ARTIFACT_PATH)
    expect(final.failure_reason).toContain('is not in the diff')
    // Positive control: the identical harness WITH the artifact in the diff
    // reaches the gate with a claim and merges.
    const seenOk: unknown[] = []
    const h2 = buildHarness({
      prove_mutation: claimSpyGate(seenOk),
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      merge_deps: {},
      hostResponder: serveArtifact(JSON.stringify(ARTIFACT_CLAIM)),
    })
    const run2 = await createRun()
    expect((await runToTerminal(h2, run2.id)).phase).toBe('done')
    expect(seenOk[0]).not.toBeNull()
  })

  test('no committed nomination still means NULL — and a required proof still refuses', async () => {
    const seen: unknown[] = []
    const h = buildHarness({
      prove_mutation: claimSpyGate(seen),
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      merge_deps: {},
      // The build committed real work and NO nomination: the branch diff simply
      // does not contain the artifact, and nothing serves its blob.
      hostResponder: (cmd) => {
        const j = cmd.join(' ')
        if (j === DIFF_ARTIFACT) return ok('trident/limit.ts\n')
        if (j.includes(ARTIFACT_PATH)) return { ok: false, stdout: '', stderr: 'fatal: path does not exist', exit_code: 128 }
        return ok()
      },
    })
    const run = await createRun()

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('nominated no mutation to run')
    // The refusal is a MISSING PROOF, not a reviewer's finding (existing invariant).
    expect(final.inner_verdict).toBe('APPROVE')
    expect(seen).toEqual([null])
    // The artifact WAS looked for — the assertion above is not vacuous.
    expect(h.hostCalls.map((c) => c.join(' '))).toContain(DIFF_ARTIFACT)
  })

  test('a schema-supplied claim WINS — the artifact is never even read', async () => {
    // Differs from the primed artifact, so an inverted precedence fails the deep-equal.
    const IN_RESULT_CLAIM = { ...ARTIFACT_CLAIM, find: 'n <= LIMIT' }
    const seen: unknown[] = []
    const h = buildHarness({
      prove_mutation: claimSpyGate(seen),
      plan: () => ({
        result: { verdict: 'APPROVE', branch: 'feat-x', mutationClaim: IN_RESULT_CLAIM },
      }),
      merge_deps: {},
      // The artifact is primed with a DIFFERENT claim — the trap for an
      // inverted or double-read implementation.
      hostResponder: serveArtifact(JSON.stringify(ARTIFACT_CLAIM)),
    })
    const run = await createRun()

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    expect(seen).toEqual([parseMutationClaim(IN_RESULT_CLAIM)])
    // Positive control against a null-vs-null equality.
    expect(seen[0]).not.toBeNull()
    // NOT READ AT ALL is the no-shadowing guarantee — not merely "not preferred".
    expect(h.hostCalls.some((c) => c.join(' ').includes(ARTIFACT_PATH))).toBe(false)
  })

  test('the reader note is appended ONLY to the refusal it explains', async () => {
    // The gate refuses for reasons that have nothing to do with a nomination: a
    // rejected branch name, an unresolvable head, a tip that moved. Suffixing
    // those with "no committed nomination" points the reader at the wrong
    // failure — the exact misdiagnosis this channel was built to end.
    const OTHER_REFUSAL = 'mutation proof rejected: the branch moved while the prose-only exemption was being decided'
    // NO artifact in the diff, so the read really is consulted and really is empty.
    const noArtifact = (cmd: string[]): HostCommandResult => {
      const j = cmd.join(' ')
      if (j === DIFF_ARTIFACT) return ok('trident/limit.ts\n')
      return ok()
    }
    const seen: unknown[] = []
    const h = buildHarness({
      prove_mutation: async (input: MutationGateInput): Promise<MutationGateOutcome> => {
        seen.push(input.claim ?? null)
        return { ok: false, reason: OTHER_REFUSAL, exempt: false, evidence: null }
      },
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      merge_deps: {},
      hostResponder: noArtifact,
    })
    const run = await createRun()

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('failed')
    // The read HAPPENED and came back empty — without this the assertion below
    // would pass on an implementation that never consulted the artifact at all.
    expect(seen).toEqual([null])
    expect(h.hostCalls.map((c) => c.join(' '))).toContain(DIFF_ARTIFACT)
    expect(final.failure_reason).toBe(OTHER_REFUSAL)
    expect(final.failure_reason).not.toContain('no committed nomination')

    // POSITIVE CONTROL: the SAME empty read, on the refusal the note explains,
    // DOES carry it — so the assertion above pins the scoping, not the note's
    // removal.
    const seenNull: unknown[] = []
    const h2 = buildHarness({
      prove_mutation: claimSpyGate(seenNull),
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      merge_deps: {},
      hostResponder: noArtifact,
    })
    const run2 = await createRun()
    const final2 = await runToTerminal(h2, run2.id)
    expect(seenNull).toEqual([null])
    expect(final2.failure_reason).toContain('nominated no mutation to run')
    expect(final2.failure_reason).toContain('no committed nomination')
  })
})

describe('orchestrator — post-merge as-built fold (one-writer T2)', () => {
  test('a performed pr-mode merge runs the fold once with the merged run and its resolved base', async () => {
    const calls: { run: TridentRun; base: string }[] = []
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', prNumber: 42, branch: 'feat-x' } }),
      fold_as_built: async (run, base) => {
        calls.push({ run, base })
        return { ok: true, folded: 1 }
      },
    })
    const run = await createRun({ merge_mode: 'pr' })

    const final = await runToTerminal(h, run.id)

    expect(final.phase).toBe('done')
    expect(final.failure_reason).toBeNull()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.base).toBe('main')
    expect(calls[0]?.run.repo_path).toBe('/repo')
    expect(calls[0]?.run.phase).toBe('done')
    expect(calls[0]?.run.merge_mode).toBe('pr')
  })

  test('local mode folds too', async () => {
    const calls: { run: TridentRun; base: string }[] = []
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      fold_as_built: async (run, base) => {
        calls.push({ run, base })
        return { ok: true, folded: 1 }
      },
    })
    const run = await createRun()

    expect((await runToTerminal(h, run.id)).phase).toBe('done')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.base).toBe('main')
    expect(calls[0]?.run.merge_mode).toBe('local')
  })

  test('a fold FAILURE VALUE leaves the merged run done and surfaces in the note', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', prNumber: 42, branch: 'feat-x' } }),
      fold_as_built: async () => ({
        ok: false,
        folded: 0,
        reason: 'could not land folded as-built entries: non-fast-forward',
      }),
    })
    const run = await createRun({ merge_mode: 'pr' })

    await h.loop.runOnce()
    await h.complete()
    const outcome = await h.step(store.get(run.id)!)

    expect(outcome.run.phase).toBe('done')
    expect(outcome.note).toContain('as-built fold deferred')
    expect(outcome.note).toContain('non-fast-forward')
    expect(await store.saveIfActive(outcome.run)).toBe(true)
    expect(store.get(run.id)).toMatchObject({ phase: 'done', failure_reason: null })
  })

  test('a THROWING fold seam still leaves the run done', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      fold_as_built: async () => {
        throw new Error('scratch worktree exploded')
      },
    })
    const run = await createRun()

    await h.loop.runOnce()
    await h.complete()
    const outcome = await h.step(store.get(run.id)!)

    expect(outcome.run.phase).toBe('done')
    expect(outcome.run.failure_reason).toBeNull()
    expect(outcome.note).toContain('as-built fold deferred')
    expect(outcome.note).toContain('scratch worktree exploded')
    expect(await store.saveIfActive(outcome.run)).toBe(true)
    expect(store.get(run.id)).toMatchObject({ phase: 'done', failure_reason: null })
  })

  test('every successful cleanup call folds, even when a stub reports performed=false', async () => {
    const calls: TridentRun[] = []
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      // A REAL gate would provision a worktree at a `/repo` that does not exist.
    base_branch: 'main',
    prove_mutation: buildSimMutationProofGate(),
    merge_deps: {},
      fold_as_built: async (run) => {
        calls.push(run)
        return { ok: true, folded: 1 }
      },
    })
    const run = await createRun()

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    expect(calls).toHaveLength(1)
  })

  test('a failed cleanup never runs the fold', async () => {
    const calls: TridentRun[] = []
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      // A REAL gate would provision a worktree at a `/repo` that does not exist.
    base_branch: 'main',
    prove_mutation: buildSimMutationProofGate(),
    merge_deps: {
        mergeLocal: async () => {
          throw new Error('cleanup failed before fold')
        },
      },
      fold_as_built: async (run) => {
        calls.push(run)
        return { ok: true, folded: 1 }
      },
    })
    const run = await createRun()

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('cleanup failed before fold')
    expect(calls).toHaveLength(0)
  })
})

describe('sweepStrandedFailures', () => {
  async function failedPr(slug: string): Promise<TridentRun> {
    const run = await store.create({
      slug,
      project_slug: 't1',
      repo_path: '/repo',
      task: 'recover the build',
      phase: 'failed',
      merge_mode: 'pr',
      branch: `trident/${slug}`,
    })
    await store.update(run.id, { failure_reason: `${slug} failed before handoff` })
    return store.get(run.id)!
  }

  test('persists only the salvaged PR and appended failure reason onto the failed row', async () => {
    const row = await failedPr('persist-salvage')

    await sweepStrandedFailures({
      store,
      reconcile: async (run) => ({
        ...run,
        pr: 73,
        failure_reason: `${run.failure_reason} — build survived the failure`,
      }),
    })

    const saved = store.get(row.id)
    expect(saved?.phase).toBe('failed')
    expect(saved?.pr).toBe(73)
    expect(saved?.failure_reason).toBe(
      'persist-salvage failed before handoff — build survived the failure',
    )
  })

  test('a throwing row does not block later salvage, and the sweep resolves', async () => {
    const throwing = await failedPr('throwing-row')
    const salvageable = await failedPr('later-row')

    await expect(
      sweepStrandedFailures({
        store,
        reconcile: async (run) => {
          if (run.id === throwing.id) throw new Error('broken checkout')
          return { ...run, pr: 74, failure_reason: `${run.failure_reason} — salvaged` }
        },
      }),
    ).resolves.toBeUndefined()

    expect(store.get(throwing.id)?.pr).toBeNull()
    expect(store.get(throwing.id)?.failure_reason).toBe('throwing-row failed before handoff')
    expect(store.get(salvageable.id)?.pr).toBe(74)
    expect(store.get(salvageable.id)?.failure_reason).toBe('later-row failed before handoff — salvaged')
  })

  test('an initial list failure is swallowed so the sweep promise never rejects', async () => {
    const brokenStore = {
      listFailedPrRuns: (): TridentRun[] => {
        throw new Error('database unavailable')
      },
      listNonTerminal: (): TridentRun[] => [],
      update: async () => null,
    }

    await expect(
      sweepStrandedFailures({ store: brokenStore, reconcile: async () => null }),
    ).resolves.toBeUndefined()
  })

  test('a reused branch owned by a live run disables only worktree inspection', async () => {
    const failed = await failedPr('reused-branch')
    await store.create({
      slug: 'replacement-run',
      project_slug: 't1',
      repo_path: '/repo',
      task: 'replacement build',
      phase: 'forge-init',
      merge_mode: 'pr',
      branch: failed.branch,
    })
    let inspectWorktree: boolean | undefined

    await sweepStrandedFailures({
      store,
      reconcile: async (_run, options) => {
        inspectWorktree = options?.inspect_worktree
        return null
      },
    })

    expect(inspectWorktree).toBe(false)
  })

  test('a failed branch with no live owner enables startup worktree inspection', async () => {
    await failedPr('available-branch')
    let inspectWorktree: boolean | undefined

    await sweepStrandedFailures({
      store,
      reconcile: async (_run, options) => {
        inspectWorktree = options?.inspect_worktree
        return null
      },
    })

    expect(inspectWorktree).toBe(true)
  })

  test('the same branch string in another project and repository is not a live owner', async () => {
    const failed = await failedPr('cross-project-branch')
    await store.create({
      slug: 'unrelated-run',
      project_slug: 't2',
      repo_path: '/another-repo',
      task: 'unrelated build',
      phase: 'forge-init',
      merge_mode: 'pr',
      branch: failed.branch,
    })
    let inspectWorktree: boolean | undefined

    await sweepStrandedFailures({
      store,
      reconcile: async (_run, options) => {
        inspectWorktree = options?.inspect_worktree
        return null
      },
    })

    expect(inspectWorktree).toBe(true)
  })
})

describe('orchestrator — ISSUES #563: a run whose PR is ALREADY merged', () => {
  test('is done, is a SUCCESS, and never runs a second gh pr merge', async () => {
    // The inner loop found the PR merged and stopped there (`prMerged`). Falling
    // through to the APPROVE path would run `gh pr merge` against an already-merged
    // PR — which fails, and would record this successful run as `merge failed`: a
    // shipped change reported as broken, which is worse than the waste #563 removes.
    const h = buildHarness({
      plan: () => ({
        result: {
          verdict: 'APPROVE',
          prNumber: 215,
          branch: 'feat-x',
          checkpoint: 'pr-merged',
          prMerged: true,
          remainingTasks: 0,
          // The workflow records NO reviewed head on this path — there is no merge
          // left to pin. Under the old code that alone would have failed the run.
          reviewedHead: null,
        },
        argusCheckpoint: 'pr-merged',
      }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    expect(final.failure_reason).toBeNull()
    expect(final.inner_verdict).toBe('APPROVE')
    expect(final.inner_checkpoint).toBe('pr-merged')
    expect(final.pr).toBe(215)
    // The whole point: NOTHING was merged, deleted or torn down by the outer loop.
    const joined = h.hostCalls.map((c) => c.join(' '))
    expect(joined.some((c) => c.startsWith('gh pr merge'))).toBe(false)
    expect(joined.some((c) => c.includes('push origin --delete'))).toBe(false)
    // …and it harvested exactly once — no re-fire of a merged run.
    expect(h.inputs.length).toBe(1)
    expect(isTridentHarvestTerminal(final)).toBe(true)
  })

  test('a merged Ralph iteration stops instead of re-firing the next task', async () => {
    // The next task would be built onto a branch the merge deleted. `prMerged` is
    // read BEFORE the re-fire, so even a result that still claims remaining tasks
    // ends the run.
    const h = buildHarness({
      plan: () => ({
        result: {
          verdict: 'APPROVE',
          prNumber: 215,
          branch: 'feat-x',
          checkpoint: 'pr-merged',
          prMerged: true,
          remainingTasks: 3,
        },
        argusCheckpoint: 'pr-merged',
      }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode, ralph: true })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    expect(h.inputs.length).toBe(1)
    expect(h.refirePatches).toHaveLength(0)
  })

  test('WITHOUT the flag, an APPROVE with no reviewed head still fails — the guard is not a bypass', async () => {
    // The mutant: treat any APPROVE carrying a `pr-merged`-ish checkpoint as merged.
    // A run that merely CLAIMS approval, with nothing recorded, must still be
    // refused — #563 must not become a way around #545's fail-closed merge.
    const h = buildHarness({
      plan: () => ({
        result: {
          verdict: 'APPROVE',
          prNumber: 215,
          branch: 'feat-x',
          checkpoint: 'pr-merged',
          reviewedHead: null,
        },
        argusCheckpoint: 'pr-merged',
      }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('failed')
    expect(h.hostCalls.map((c) => c.join(' ')).some((c) => c.startsWith('gh pr merge'))).toBe(false)
  })
})

describe('orchestrator — #545: a head that MOVED after the review never merges', () => {
  test('GitHub refuses the pinned merge → the run FAILS loudly (nothing is torn down)', async () => {
    // The observed window (PR #171 went clean → dirty mid-review): a commit lands
    // between the APPROVE and the merge. `--match-head-commit` makes GitHub reject
    // it, and the run must surface that as a failure — NEVER quietly merge the head
    // the reviewers never saw, and never retry the merge unpinned.
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', prNumber: 42, branch: 'feat-x' } }),
      hostResponder: (cmd) =>
        // Only the MERGE is refused. The gate's read-only head-location probe
        // (`gh pr view … isCrossRepository`) must keep answering, or this test
        // stops at the gate instead of at the merge it is about.
        cmd[0] === 'gh' && !cmd.includes('headRefName,baseRefName,isCrossRepository')
          ? {
              ok: false,
              stdout: '',
              stderr: 'failed to merge pull request: Head branch was modified. Review and try the merge again.',
              exit_code: 1,
            }
          : // A repo the #542 drift gate can read, so this test fails at the
            // MERGE (the thing it is about) and not at the gate before it.
            driftFreeHost(cmd),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('Head branch was modified')
    // The APPROVE itself still happened — this failed at the MERGE, not the review.
    expect(final.inner_verdict).toBe('APPROVE')
    const joined = h.hostCalls.map((c) => c.join(' '))
    expect(joined).toContain(`gh pr merge 42 --squash --match-head-commit ${SIM_REVIEWED_HEAD}`)
    // Exactly one merge attempt, and no branch teardown after the refusal (the PR
    // is still open and reviewable by a human).
    expect(joined.filter((c) => c.startsWith('gh pr merge'))).toHaveLength(1)
    expect(joined.some((c) => c.includes('push origin --delete') || c.includes('branch -D'))).toBe(false)
  })

  test('a workflow that recorded NO reviewed head fails BEFORE any gh call (fail-closed)', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', prNumber: 42, branch: 'feat-x', reviewedHead: null } }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('reviewed head')
    // Not merged at all — an unpinnable merge is never attempted, pinned or not.
    expect(h.hostCalls.map((c) => c.join(' ')).some((c) => c.startsWith('gh pr merge'))).toBe(false)
  })
})

describe('orchestrator — merge conflict (#342): resolve vs escalate to chat', () => {
  // A host whose initial rebase conflicts (then succeeds after --continue).
  const conflictingHost = (): ((cmd: string[]) => HostCommandResult) => {
    let rebased = false
    return (cmd) => {
      if (cmd.includes('rebase') && !cmd.includes('--continue') && !cmd.includes('--abort')) {
        if (!rebased) {
          rebased = true
          return { ok: false, stdout: '', stderr: 'CONFLICT (content): Merge conflict in shared.ts', exit_code: 1 }
        }
      }
      if (cmd.includes('diff') && cmd.includes('--diff-filter=U')) {
        return { ok: true, stdout: 'shared.ts', stderr: '', exit_code: 0 }
      }
      return ok()
    }
  }

  test('the Forge resolver fixes the conflict → the build still lands (done)', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      hostResponder: conflictingHost(),
      resolve_conflict: async () => ({ resolved: true }),
    })
    const run = await createRun({ merge_mode: 'local' as MergeMode })
    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    expect(h.hostCalls.map((c) => c.join(' ')).some((c) => c.includes('rebase --continue'))).toBe(true)
  })

  test('an ambiguous conflict → failed with the SPECIFIC question as the reason (not "merge failed")', async () => {
    const question = 'shared.ts: which flush() behaviour do you want?'
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      hostResponder: conflictingHost(),
      resolve_conflict: async () => ({ resolved: false, question }),
    })
    const run = await createRun({ merge_mode: 'local' as MergeMode })
    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('failed')
    // The failure reason IS the specific question (the terminal delivery posts it
    // verbatim to chat) — never a raw "merge failed".
    expect(final.failure_reason).toBe(question)
    expect(final.failure_reason).not.toContain('merge failed')
    expect(final.inner_verdict).toBe('APPROVE')
  })
})

describe('orchestrator — base-drift hold (#542): a HELD merge fails LOUDLY, not silently', () => {
  /** A host whose base has moved since the fork point, editing `baseTouched`;
   *  the branch's reviewed diff touches `reviewedFiles`. The rebase is clean, so
   *  nothing textual catches the overlap — only the #542 hold can. */
  const driftedHost = (
    baseTouched: string[],
    reviewedFiles: string[],
  ): ((cmd: string[]) => HostCommandResult) => {
    const REVIEW_BASE = '1111111111111111111111111111111111111111'
    const CURRENT_BASE = '2222222222222222222222222222222222222222'
    const BRANCH_HEAD = '3333333333333333333333333333333333333333'
    return (cmd) => {
      if (cmd.includes('rev-parse') && cmd.includes('--verify')) {
        const ref = (cmd[cmd.length - 1] ?? '').replace('^{commit}', '')
        if (ref.startsWith('feat-')) return ok(BRANCH_HEAD)
        return ok(CURRENT_BASE)
      }
      if (cmd.includes('merge-base')) return ok(REVIEW_BASE)
      if (cmd.includes('diff') && cmd.includes('--name-only') && !cmd.includes('--diff-filter=U')) {
        return ok((cmd[cmd.length - 1] === BRANCH_HEAD ? reviewedFiles : baseTouched).join('\n'))
      }
      return ok()
    }
  }

  test('an APPROVE whose base drifted INTO the reviewed diff is HELD → failed, nothing merged', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      hostResponder: driftedHost(['shared.ts'], ['shared.ts']),
    })
    const run = await createRun({ merge_mode: 'local' as MergeMode })
    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('failed')
    // The reason IS the hold text (the terminal delivery posts it verbatim) — not
    // a raw "merge failed", and it names both shas + the overlapping file.
    expect(final.failure_reason).toContain('holding the merge')
    expect(final.failure_reason).toContain('shared.ts')
    expect(final.failure_reason).not.toContain('merge failed')
    // The APPROVE is preserved: the work is intact, it just may not land here.
    expect(final.inner_verdict).toBe('APPROVE')
    // NOTHING landed on the base.
    expect(h.hostCalls.map((c) => c.join(' ')).some((c) => c.includes('merge --no-ff'))).toBe(false)
  })

  test('an APPROVE whose base drifted ELSEWHERE still merges (done)', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      hostResponder: driftedHost(['docs/CHANGELOG.md'], ['shared.ts']),
    })
    const run = await createRun({ merge_mode: 'local' as MergeMode })
    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    expect(h.hostCalls.map((c) => c.join(' ')).some((c) => c.startsWith('git -C /repo merge --no-ff'))).toBe(true)
  })
})

describe('orchestrator — server-gated verdict provenance', () => {
  test('a self-asserted APPROVE with no recorded argus-approved checkpoint is REJECTED → failed (no merge)', async () => {
    // The workflow's result claims APPROVE, but the recorded provenance checkpoint
    // is argus-request-changes — the merge gate must NOT trust the result line.
    const h = buildHarness({
      plan: () => ({
        result: { verdict: 'APPROVE', prNumber: 7, branch: 'feat-x' },
        argusCheckpoint: 'argus-request-changes',
      }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('provenance gate')
    expect(final.inner_verdict).toBe('REVIEW_NOT_RUN')
    expect(h.hostCalls.map((c) => c.join(' ')).some((c) => c.includes('pr merge'))).toBe(false)
  })
})

describe('orchestrator — REQUEST_CHANGES (maxRounds exhausted) → failed', () => {
  test('a findings-free REQUEST_CHANGES inner result records REVIEW_NOT_RUN', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'REQUEST_CHANGES', round: 3, prNumber: 7, branch: 'feat-x' } }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('without Argus APPROVE')
    expect(final.inner_verdict).toBe('REVIEW_NOT_RUN')
    expect(h.hostCalls.map((c) => c.join(' ')).some((c) => c.includes('pr merge'))).toBe(false)
  })

  // CODEX REVIEW, ROUND 3 [P1] — it caught the exact trap I had criticised elsewhere. The
  // assertion above passes on BOTH the old lying message and the new one (they share
  // "without Argus APPROVE"), and every unit test for the new reason calls the exported
  // helper DIRECTLY — so reverting the orchestrator's call site to the old hardcoded
  // template would have left the whole suite green. A test that cannot fail on the bug it
  // names is not a test. These two drive the REAL orchestrator, through the seam that
  // actually writes the row.
  test('a round-1 inner-error fails with a MEASURED reason, not the round ceiling', async () => {
    const h = buildHarness({
      plan: () => ({
        result: { verdict: 'REQUEST_CHANGES', round: 1, prNumber: 7, branch: 'feat-x', checkpoint: 'inner-error' },
      }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('failed')
    // THE DEFECT: three runs on 2026-08-13 ended exactly here and every one of them
    // claimed the round budget ran out.
    expect(final.failure_reason).not.toContain('exhausted')
    expect(final.failure_reason).not.toMatch(/\b10 round\(s\)/)
    expect(final.failure_reason).toContain('round 1 of')
    expect(final.failure_reason).toContain('inner-error')
  })

  test('the persisted checkpoint agrees with the reason that names it', async () => {
    // CODEX ROUND 3 [P2]. The row could carry a stale checkpoint while the terminal result
    // reported another; the reason read one field and the structured column read the other.
    // Two answers to one question — the shape of this whole defect.
    const h = buildHarness({
      plan: () => ({
        result: { verdict: 'REQUEST_CHANGES', round: 2, prNumber: 7, branch: 'feat-x', checkpoint: 'inner-error' },
        argusCheckpoint: 'forge-built',
      }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    const final = await runToTerminal(h, run.id)
    expect(final.inner_checkpoint).toBe('inner-error')
    expect(final.failure_reason).toContain('inner-error')
  })
})

describe('REVIEW_NOT_RUN — terminal without the reviewer speaking', () => {
  async function harvestRawResult(over: {
    verdict: 'REQUEST_CHANGES' | null
    checkpoint: string | null
    blockKind: 'code' | 'infra-only' | 'advisory-only' | 'round-lost' | null
    findings: string | null
    terminalCause?: string
  }): Promise<TridentRun> {
    const h = buildHarness({ plan: () => ({ result: null }) })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await h.loop.runOnce()
    await store.update(run.id, {
      inner_result: JSON.stringify({
        ok: false,
        verdict: over.verdict,
        prNumber: 7,
        branch: 'feat-x',
        round: 1,
        checkpoint: over.checkpoint,
        blockKind: over.blockKind,
        terminalCause: over.terminalCause ?? null,
      }),
      inner_checkpoint: over.checkpoint,
      inner_checkpoint_findings: over.findings,
      subagent_status: 'completed',
    })
    // Model the old out-of-process inner writer: the outer harvest must replace
    // this fabrication when no reviewer verdict can be substantiated.
    await db.run(
      'UPDATE code_trident_runs SET inner_verdict = ? WHERE id = ?',
      ['REQUEST_CHANGES', run.id],
    )
    await h.loop.runOnce()
    return store.get(run.id)!
  }

  test('a null verdict at inner-error records REVIEW_NOT_RUN and preserves findings/checkpoint', async () => {
    const findings = '[{"severity":"note","summary":"diagnostic retained"}]'
    const final = await harvestRawResult({
      verdict: null,
      checkpoint: 'inner-error',
      blockKind: null,
      findings,
      terminalCause: 'executor crashed before review',
    })

    expect(final.phase).toBe('failed')
    expect(final.inner_verdict).toBe('REVIEW_NOT_RUN')
    expect(final.inner_checkpoint).toBe('inner-error')
    expect(final.inner_checkpoint).not.toBe('argus-request-changes')
    expect(final.inner_checkpoint_findings).toBe(findings)
    expect(final.failure_reason).toContain('executor crashed before review')
  })

  test('a terminal result with no checkpoint does not fabricate an Argus checkpoint', async () => {
    const final = await harvestRawResult({
      verdict: null,
      checkpoint: null,
      blockKind: null,
      findings: null,
    })
    expect(final.inner_verdict).toBe('REVIEW_NOT_RUN')
    expect(final.inner_checkpoint).toBeNull()
  })

  test('infra-only and round-lost stops both record REVIEW_NOT_RUN', async () => {
    for (const blockKind of ['infra-only', 'round-lost'] as const) {
      const final = await harvestRawResult({
        verdict: 'REQUEST_CHANGES',
        checkpoint: 'argus-request-changes',
        blockKind,
        findings: '[{"severity":"blocker"}]',
        terminalCause: `${blockKind} stop`,
      })
      expect(final.inner_verdict).toBe('REVIEW_NOT_RUN')
    }
  })

  /**
   * ...AND AN ADVISORY-ONLY STOP IS THE OPPOSITE CASE, which the same discriminator used
   * to get wrong in the expensive direction.
   *
   * The inner workflow returns `blockKind: 'advisory-only'` when a HEALTHY panel judged the
   * code and every finding it produced was one the workflow has already declared
   * non-blocking (a nit, a minor, a pre-existing red). The fix loop exits without buying a
   * round — that is the whole point — but a reviewer DID speak, so recording REVIEW_NOT_RUN
   * ("no review seat ever judged the code") is simply false. It was also costly: a resume
   * off that row re-Forged a full round on findings the run had already settled as
   * non-actionable, which is the exact waste the advisory economy exists to stop.
   *
   * RED-mutation: change `advisory-only` back to `infra-only` in `classifyBlock`
   * (inner-workflow.mjs) or drop it from `recordedTerminalVerdict` and this fails.
   */
  test('an advisory-only stop records REQUEST_CHANGES — a reviewer DID judge the code', async () => {
    const findings = '[{"severity":"major","advisory":true,"title":"CI RED FOR PRE-EXISTING REASONS: shard 3/8"}]'
    const final = await harvestRawResult({
      verdict: 'REQUEST_CHANGES',
      checkpoint: 'argus-request-changes',
      blockKind: 'advisory-only',
      findings,
    })
    expect(final.inner_verdict).toBe('REQUEST_CHANGES')
    expect(final.inner_checkpoint_findings).toBe(findings)
  })

  // ...AND THE SIMULATOR WRITES THE SAME ROW THE WORKFLOW WOULD. The test above seeds the
  // verdict column by hand (deliberately — it models the OLD out-of-process writer the
  // harvest must correct), so it cannot catch the simulated writer drifting away from
  // production's. `inner-loop-sim.ts` widened its blockKind TYPE for 'advisory-only' and
  // left its `inner_verdict` discriminator matching 'code' alone, which recorded
  // REVIEW_NOT_RUN where production records REQUEST_CHANGES. This runs it.
  test('the SIMULATED writer records an advisory-only stop the way production does', async () => {
    const h = buildHarness({
      plan: () => ({
        result: {
          verdict: 'REQUEST_CHANGES' as const,
          branch: 'feat-x',
          checkpoint: 'argus-request-changes',
          blockKind: 'advisory-only' as const,
          findings: [{ severity: 'major', advisory: true, title: 'CI RED FOR PRE-EXISTING REASONS: shard 3/8' }],
        },
      }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    const final = await runToTerminal(h, run.id)
    expect(final.inner_verdict).toBe('REQUEST_CHANGES')
  })

  // ...and the provenance requirement is NOT relaxed by the new kind. An advisory-only
  // claim with no Argus checkpoint behind it is still a claim nobody made.
  test('advisory-only without Argus provenance is still REVIEW_NOT_RUN', async () => {
    const final = await harvestRawResult({
      verdict: 'REQUEST_CHANGES',
      checkpoint: 'forge-done',
      blockKind: 'advisory-only',
      findings: '[{"severity":"nit","title":"spacing"}]',
    })
    expect(final.inner_verdict).toBe('REVIEW_NOT_RUN')
  })

  // ...nor does it license the infra path. `isInfraDeath` reads 'infra-only' ONLY, so an
  // advisory-only stop must not be reported to the owner as "review never ran".
  test('an advisory-only stop is not an infra death', () => {
    expect(isInfraDeath({
      ok: true,
      verdict: 'REQUEST_CHANGES',
      checkpoint: 'argus-request-changes',
      block_kind: 'advisory-only',
      findings_present: true,
    })).toBe(false)
    expect(isInfraDeath({
      ok: true,
      verdict: 'REQUEST_CHANGES',
      checkpoint: 'argus-request-changes',
      block_kind: 'infra-only',
      findings_present: true,
    })).toBe(true)
  })

  // THE SUITE-GATE HOLE, MEASURED. `failedRun` used to keep REQUEST_CHANGES on any
  // non-empty findings list. But the suite gate in `inner-workflow.mjs` writes a
  // `blocker` of its own on a build that never reached a reviewer, so that test was
  // satisfied by a run whose review provably never ran. Live count at the time of the
  // fix: of 160 terminal REQUEST_CHANGES rows only 18 carried an Argus checkpoint —
  // 68 stopped at `forge-done` and 45 at `inner-error`.
  //
  // RED-mutation: drop `hasArgusProvenance(run.inner_checkpoint) &&` from `failedRun`
  // and this test fails while every other test in this file stays green.
  test('a forge-done run carrying the SUITE GATE blocker is REVIEW_NOT_RUN, not a reviewed rejection', async () => {
    // The verbatim shape the gate writes (trident/inner-workflow.mjs) — a real
    // blocker, with no reviewer behind it.
    const suiteGateFinding = JSON.stringify([
      {
        severity: 'blocker',
        title: 'FULL SUITE NOT PROVEN — the build did not report testsPassed=true',
        evidence: 'The build reported testsPassed=false and suiteOutcome="not-run".',
      },
    ])
    const final = await harvestRawResult({
      verdict: 'REQUEST_CHANGES',
      checkpoint: 'forge-done',
      blockKind: 'code',
      findings: suiteGateFinding,
      terminalCause: 'suite gate refused the round',
    })

    expect(final.phase).toBe('failed')
    expect(final.inner_verdict).toBe('REVIEW_NOT_RUN')
    // The finding itself is DIAGNOSTIC and must survive — the verdict is what was
    // wrong, not the evidence.
    expect(final.inner_checkpoint_findings).toBe(suiteGateFinding)
    expect(final.inner_checkpoint).toBe('forge-done')
  })

  test('a fix-round checkpoint IS Argus provenance — a fix round only exists after a review', async () => {
    // POSITIVE CONTROL for the guard above: `fix-round-N` means fix N is built in
    // response to an `argus-request-changes`, so the review demonstrably ran. If the
    // provenance predicate were tightened to `argus-*` only, this run would be
    // silently downgraded and a genuine reviewed rejection would be lost.
    const findings = '[{"severity":"blocker","summary":"reviewer found it in round 2"}]'
    const final = await harvestRawResult({
      verdict: 'REQUEST_CHANGES',
      checkpoint: 'fix-round-2',
      blockKind: 'code',
      findings,
      terminalCause: 'round budget spent after a real review',
    })

    expect(final.inner_verdict).toBe('REQUEST_CHANGES')
  })

  test('a code verdict with recorded findings remains REQUEST_CHANGES', async () => {
    const findings = '[{"severity":"blocker","summary":"wrong result"}]'
    const final = await harvestRawResult({
      verdict: 'REQUEST_CHANGES',
      checkpoint: 'argus-request-changes',
      blockKind: 'code',
      findings,
      terminalCause: 'review found a correctness defect',
    })
    expect(final.phase).toBe('failed')
    expect(final.inner_verdict).toBe('REQUEST_CHANGES')
    expect(final.inner_checkpoint_findings).toBe(findings)
    expect(final.failure_reason).toBe(
      "inner workflow ended at round 1 of 10 at checkpoint 'argus-request-changes' without Argus APPROVE",
    )
  })
})

describe('orchestrator — RALPH RE-FIRE (#362): multi-task build re-fires per task, merges once at 0', () => {
  // The bug: a multi-task Ralph build shipped after ONLY task 1 (the inner loop
  // built plan.topTask, then the outer merged with no remaining-tasks check). The
  // fix: the inner iteration emits `remainingTasks`; the outer RE-FIRES a fresh
  // iteration per remaining task and merges only when it reaches 0.
  //
  // This drives the REAL orchestrator + store + tick + migrations end-to-end with
  // a simulated inner workflow that returns remaining=2 → 1 → 0 (APPROVE) across
  // successive fires — the production harvest/re-fire/merge path, not a unit test
  // on the dead state-machine.
  test('a 3-task plan re-fires twice (fresh context each) and merges only at remaining=0', async () => {
    // Per-fire script: each fire is a SEPARATE inner iteration (fresh context). The
    // firer records every InnerLoopInput so we can assert re-fires + resume folding.
    let fireCount = 0
    const branch = 'trident/multi-task'
    const h = buildHarness({
      plan: (): SimPlan => {
        fireCount += 1
        if (fireCount === 1) {
          // Task 1 built, 2 remain → intermediate re-fire result (NOT reviewed).
          return {
            result: { verdict: 'REQUEST_CHANGES', prNumber: 55, branch, remainingTasks: 2, checkpoint: 'ralph-task-built' },
            argusCheckpoint: 'ralph-task-built',
          }
        }
        if (fireCount === 2) {
          // Task 2 built, 1 remains → another re-fire.
          return {
            result: { verdict: 'REQUEST_CHANGES', prNumber: 55, branch, remainingTasks: 1, checkpoint: 'ralph-task-built' },
            argusCheckpoint: 'ralph-task-built',
          }
        }
        // Task 3 (final) built, 0 remain → reviewed + APPROVED → the merge path.
        return {
          result: { verdict: 'APPROVE', prNumber: 55, branch, remainingTasks: 0, checkpoint: 'argus-approved' },
          argusCheckpoint: 'argus-approved',
        }
      },
    })
    const run = await createRun({ ralph: true, branch, merge_mode: 'pr' as MergeMode })

    const final = await runToTerminal(h, run.id)

    // Only the FINAL task's APPROVE merged — and it merged exactly once.
    expect(final.phase).toBe('done')
    expect(final.inner_verdict).toBe('APPROVE')
    expect(final.inner_checkpoint).toBe('argus-approved')
    const mergeCalls = h.hostCalls.map((c) => c.join(' ')).filter((c) => c.includes('gh pr merge'))
    expect(mergeCalls).toEqual([`gh pr merge 55 --squash --match-head-commit ${SIM_REVIEWED_HEAD}`])

    // THREE inner iterations fired — one per task (the bug shipped after ONE).
    expect(h.inputs.length).toBe(3)
    // Each re-fire is a FRESH context (a brand-new Workflow launch), and fires 2 & 3
    // RESUME onto the same branch via the workflow-written 'ralph-task-built'
    // checkpoint (re-plan the next task; never accumulate one context).
    expect(h.inputs[0]!.resume_checkpoint ?? null).toBeNull()
    expect(h.inputs[1]!.resume_checkpoint).toBe('ralph-task-built')
    expect(h.inputs[2]!.resume_checkpoint).toBe('ralph-task-built')
    // The branch/PR is reused across every iteration — never a duplicate build.
    expect(h.inputs.every((i) => i.run.branch === branch)).toBe(true)

    // The ralph-round counter advanced once per re-fire (bounds the loop).
    expect(final.ralph_round).toBe(2)
    // harvested_at is stamped only on the TERMINAL harvest (the merge), not the
    // intermediate re-fires.
    expect(final.harvested_at).not.toBeNull()
  })

  test('a Ralph build that never converges fails at max_ralph_rounds (no infinite re-fire)', async () => {
    // A planner that ALWAYS reports a task still remaining — the fix must fail
    // loudly at the cap rather than re-fire forever.
    const h = buildHarness({
      plan: (): SimPlan => ({
        result: { verdict: 'REQUEST_CHANGES', prNumber: 9, branch: 'trident/loops', remainingTasks: 5, checkpoint: 'ralph-task-built' },
        argusCheckpoint: 'ralph-task-built',
      }),
    })
    const run = await createRun({
      ralph: true,
      branch: 'trident/loops',
      merge_mode: 'pr' as MergeMode,
      max_ralph_rounds: 3,
    })

    const final = await runToTerminal(h, run.id, 40)
    expect(final.phase).toBe('failed')
    expect(final.inner_verdict).toBe('REVIEW_NOT_RUN')
    expect(final.failure_reason).toContain('max_ralph_rounds')
    // Never merged.
    expect(h.hostCalls.map((c) => c.join(' ')).some((c) => c.includes('pr merge'))).toBe(false)
    // Bounded: re-fired exactly max_ralph_rounds times before failing (fire 1 +
    // 3 re-fires = the run stops climbing at the cap).
    expect(final.ralph_round).toBe(3)
  })

  test('the intermediate re-fire never leaves a harvestable inner_result behind (no re-harvest loop)', async () => {
    // Regression guard for the wiring trap: saveIfActive never writes inner_result,
    // so a re-fire that failed to null it out-of-band would re-harvest the SAME
    // intermediate result every tick and spin forever. Assert the column is cleared
    // after the re-fire tick.
    let fireCount = 0
    const h = buildHarness({
      plan: (): SimPlan => {
        fireCount += 1
        return fireCount === 1
          ? {
              result: { verdict: 'REQUEST_CHANGES', prNumber: 3, branch: 'trident/clr', remainingTasks: 1, checkpoint: 'ralph-task-built' },
              argusCheckpoint: 'ralph-task-built',
            }
          : {
              result: { verdict: 'APPROVE', prNumber: 3, branch: 'trident/clr', remainingTasks: 0, checkpoint: 'argus-approved' },
              argusCheckpoint: 'argus-approved',
            }
      },
    })
    const run = await createRun({ ralph: true, branch: 'trident/clr', merge_mode: 'pr' as MergeMode })

    // Tick 1: fire iteration 1. Drain writes the intermediate result.
    await h.loop.runOnce()
    await h.complete()
    // Tick 2: harvest the intermediate → re-fire. The row must be reset launchable
    // with inner_result CLEARED and the sub-agent slot released.
    await h.loop.runOnce()
    const afterRefire = store.get(run.id)!
    expect(afterRefire.inner_result).toBeNull()
    expect(afterRefire.subagent_run_id).toBeNull()
    expect(afterRefire.ralph_round).toBe(1)
    expect(isTerminalPhase(afterRefire.phase)).toBe(false)

    // CRASH-SAFETY (Codex [P2]): the reset is ONE atomic patch that bundles the
    // inner_result clear WITH the sub-agent-slot release AND the ralph_round bump — so
    // no crash can strand the row as (inner_result=null, stale terminal sub-agent),
    // which step() would reap as terminal-but-garbled. And it NEVER touches `phase`
    // (that stays for saveIfActive's race guard, so a cancel can't be resurrected).
    expect(h.refirePatches).toHaveLength(1)
    const patch = h.refirePatches[0]!
    expect(patch.inner_result).toBeNull()
    expect(patch.subagent_run_id).toBeNull()
    expect(patch.subagent_status).toBeNull()
    expect(patch.ralph_round).toBe(1)
    expect('phase' in patch).toBe(false)

    // The loop still converges to a merge.
    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    expect(h.inputs.length).toBe(2)
  })
})

describe('orchestrator — fire did not settle → failed', () => {
  test('a fire that fails to settle fails the run (no silent success)', async () => {
    const fail: FireOutcome = { status: 'failed', error: 'fire turn closed without a completion event' }
    const h = buildHarness({ plan: () => ({ fire: fail }) })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    await h.loop.runOnce()
    const after = store.get(run.id)
    expect(after?.phase).toBe('failed')
    expect(after?.failure_reason).toContain('fire failed')
  })

  test('a failed fire outcome fails the run', async () => {
    const h = buildHarness({ plan: () => ({ fire: { status: 'failed', error: 'boom' } }) })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await h.loop.runOnce()
    expect(store.get(run.id)?.phase).toBe('failed')
  })

  // THE SETTLE-TIMEOUT EVIDENCE GATE. A launcher turn that never settles is
  // cancelled and the fire resolves `failed` — but the workflow it fired runs
  // DETACHED and the cancel does not reach it. Measured: 8 of 33 runs in 7 days
  // were written off on that inference, one of them while its workflow went on
  // building for another six minutes, and twice over a row that already said
  // `outer-published:…`. The gate consults POSITIVE evidence only, and ONLY for
  // this one error string.
  const TIMEOUT_FIRE: FireOutcome = { status: 'failed', error: FIRE_SETTLE_TIMEOUT_ERROR }
  const PUBLISHED_SHA = '7'.repeat(40)
  const PUBLISHED_CHECKPOINT = `outer-published:${PUBLISHED_SHA}:0:3`
  const PLAIN_FIRE_FAILURE = `inner workflow fire failed: ${FIRE_SETTLE_TIMEOUT_ERROR}`

  test('evidence the workflow LAUNCHED holds the lane instead of terminalizing it', async () => {
    const h = buildHarness({
      plan: () => ({ fire: TIMEOUT_FIRE }),
      gather_fire_evidence: async () => ({
        kind: 'launched',
        detail: 'worktree on the run branch holds a live lock',
      }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    await h.loop.runOnce()

    const after = store.get(run.id)!
    expect(isTerminalPhase(after.phase)).toBe(false)
    expect(after.subagent_status).toBe('running')
    expect(after.failure_reason).toBeNull()
    expect(after.subagent_run_id).not.toBeNull()

    // AND THE LANE IS HELD: a second tick must not invite a second workflow onto
    // the branch the live one holds (the relaunch this card exists to stop).
    await h.loop.runOnce()
    expect(h.inputs).toHaveLength(1)
    expect(isTerminalPhase(store.get(run.id)!.phase)).toBe(false)
  })

  test('a row that already says outer-published is recorded as built-and-published, not as a failed fire', async () => {
    const h = buildHarness({
      plan: () => ({ fire: TIMEOUT_FIRE }),
      // The leftover-branch probe must resolve for the launch to reach the fire.
      local_branch_tip: PUBLISHED_SHA,
      gather_fire_evidence: async () => ({
        kind: 'published',
        checkpoint: PUBLISHED_CHECKPOINT,
        detail: 'row already published',
      }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    // `phaseForCheckpoint` leaves outer-loop markers alone, so the row stays launchable.
    await store.update(run.id, { inner_checkpoint: PUBLISHED_CHECKPOINT })

    await h.loop.runOnce()

    const after = store.get(run.id)!
    // Terminal — the work is FINISHED — but the row must not read as a failed
    // fire, and must not read as a rejection either.
    expect(after.phase).toBe('failed')
    expect(after.failure_reason).toContain(FIRE_PUBLISHED_REASON_MARKER)
    expect(after.failure_reason).toContain('review not run')
    expect(after.failure_reason).not.toContain('fire failed')
    // `failedRun`'s own normalization owns this: an outer-published checkpoint
    // carries no argus provenance, so the verdict cannot be a rejection.
    expect(after.inner_verdict).toBe('REVIEW_NOT_RUN')
    // Preserved for the disposition classifier and the resume seed.
    expect(after.inner_checkpoint).toBe(PUBLISHED_CHECKPOINT)
  })

  // ARGUS r5 (nit): the trimmed checkpoint used to travel in `observed`, which is
  // ALSO the CAS token — so `inner_checkpoint IS <trimmed>` never matched the
  // stored untrimmed value and the column kept its whitespace. The trim now
  // travels in `checkpoint` and is written onto the row, while the CAS still
  // compares what is really stored.
  test('the TRIMMED checkpoint actually lands over an untrimmed stored column', async () => {
    const messy = `  ${PUBLISHED_CHECKPOINT} \n`
    const h = buildHarness({
      plan: () => ({ fire: TIMEOUT_FIRE }),
      local_branch_tip: PUBLISHED_SHA,
      gather_fire_evidence: async (input) => ({
        kind: 'published',
        checkpoint: PUBLISHED_CHECKPOINT,
        detail: 'row already published',
        // The CAS token is the RAW column, exactly as the classifier reports it.
        observed: pickWorkflowOwned(store.get(input.run.id)!),
      }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await store.update(run.id, { inner_checkpoint: messy })

    await h.loop.runOnce()

    expect(store.get(run.id)?.inner_checkpoint).toBe(PUBLISHED_CHECKPOINT)
  })

  test('NO evidence keeps today\'s failure byte-identical', async () => {
    const h = buildHarness({
      plan: () => ({ fire: TIMEOUT_FIRE }),
      gather_fire_evidence: async () => ({ kind: 'none', detail: 'nothing' }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    await h.loop.runOnce()

    const after = store.get(run.id)!
    expect(after.phase).toBe('failed')
    expect(after.failure_reason).toBe(PLAIN_FIRE_FAILURE)
  })

  test('an UNWIRED seam keeps today\'s failure byte-identical', async () => {
    const h = buildHarness({ plan: () => ({ fire: TIMEOUT_FIRE }) })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    await h.loop.runOnce()

    const after = store.get(run.id)!
    expect(after.phase).toBe('failed')
    expect(after.failure_reason).toBe(PLAIN_FIRE_FAILURE)
  })

  test('a NON-timeout fire error never consults the seam', async () => {
    let consulted = 0
    const h = buildHarness({
      plan: () => ({ fire: { status: 'failed', error: 'boom' } }),
      gather_fire_evidence: () => {
        consulted += 1
        throw new Error('the seam must never be consulted for a non-timeout error')
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    await h.loop.runOnce()

    expect(consulted).toBe(0)
    expect(store.get(run.id)?.phase).toBe('failed')
    expect(store.get(run.id)?.failure_reason).toBe('inner workflow fire failed: boom')
  })

  // BLOCKER (round 1): the held lane returned the row PINNED BEFORE THE FIRE, and
  // `saveIfActive` assigns `inner_checkpoint`/`inner_verdict` plainly — so the
  // tick's own save wrote the workflow's progress back to its pre-fire value,
  // destroying the very delta that proved the lane was live. The evidence now
  // carries what the gatherer actually READ and the orchestrator applies it.
  test('a workflow-owned column the detached workflow wrote SURVIVES the tick that spares the lane', async () => {
    const h = buildHarness({
      plan: () => ({ fire: TIMEOUT_FIRE }),
      gather_fire_evidence: async (input) => {
        // The detached workflow checkpoints WHILE the launcher is wedged — the
        // real sequence this gate exists for. The gatherer re-reads the row, so
        // it observes the new value; the orchestrator still holds the PINNED one.
        await store.update(input.run.id, { inner_checkpoint: 'forge-done' })
        const fresh = store.get(input.run.id)!
        return {
          kind: 'launched',
          detail: 'run row moved since the fire (inner_checkpoint)',
          observed: pickWorkflowOwned(fresh),
        }
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    await h.loop.runOnce()

    const after = store.get(run.id)!
    expect(isTerminalPhase(after.phase)).toBe(false)
    // THE ASSERTION THAT MATTERS: the workflow's checkpoint is still there.
    expect(after.inner_checkpoint).toBe('forge-done')
    // MAJOR (round 2): and so is the PHASE that checkpoint implies. `phase` is
    // not a workflow-owned column, but `checkpoint.sh` derives it from
    // `inner_checkpoint` at the inner workflow's write choke point — so carrying
    // the checkpoint while restoring the PINNED phase left the row saying
    // `forge-init` and `forge-done` at once, and reverted a run that had already
    // reached review. `saveIfActive` applies no derivation, so the tick must.
    expect(after.phase).toBe('argus')
  })

  // The mirror of the case above: a checkpoint that implies NOTHING (an
  // outer-loop marker, a name the table has never seen) must leave the phase
  // exactly as the tick set it, never guess one.
  test('a carried checkpoint that implies no phase leaves the pinned phase alone', async () => {
    const h = buildHarness({
      plan: () => ({ fire: TIMEOUT_FIRE }),
      gather_fire_evidence: async (input) => {
        await store.update(input.run.id, { inner_checkpoint: 'a-checkpoint-nobody-mapped' })
        return {
          kind: 'launched',
          detail: 'run row moved since the fire (inner_checkpoint)',
          observed: pickWorkflowOwned(store.get(input.run.id)!),
        }
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    const before = store.get(run.id)!.phase

    await h.loop.runOnce()

    const after = store.get(run.id)!
    expect(after.inner_checkpoint).toBe('a-checkpoint-nobody-mapped')
    expect(after.phase).toBe(before)
    expect(isTerminalPhase(after.phase)).toBe(false)
  })

  // ARGUS r4 (minor): the held-lane save spread the seen row VERBATIM, and a
  // `REQUEST_CHANGES` with no findings — a shape `checkpoint.sh` can write and
  // crash recovery preserves — is exactly what `saveIfActive` REFUSES. The throw
  // is swallowed by the tick's per-run catch, `subagent_run_id` stays NULL, and
  // the next tick re-enters the launch site: a second lane at the same branch,
  // which is the whole thing this seam exists to prevent.
  test('a findings-free REQUEST_CHANGES on the row cannot make the lane-holding save throw', async () => {
    const h = buildHarness({
      plan: () => ({ fire: TIMEOUT_FIRE }),
      gather_fire_evidence: async (input) => ({
        kind: 'launched',
        detail: 'live lock on the branch',
        observed: pickWorkflowOwned(store.get(input.run.id)!),
      }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    // The rejected shape, written the way the checkpoint seam can write it.
    await db.run(
      `UPDATE code_trident_runs SET inner_verdict = 'REQUEST_CHANGES', inner_checkpoint_findings = NULL WHERE id = ?`,
      [run.id],
    )

    await h.loop.runOnce()

    const after = store.get(run.id)!
    // THE LANE IS HELD: not terminal, and carrying a dispatch id, so harvest and
    // the stall guard own it rather than a fresh fire.
    expect(isTerminalPhase(after.phase)).toBe(false)
    expect(after.subagent_run_id).not.toBeNull()
    // And the unacceptable verdict was normalized, not persisted.
    expect(after.inner_verdict).toBe('REVIEW_NOT_RUN')
  })

  test('the held row carries NO launcher generation (never a minted or inherited one)', async () => {
    const h = buildHarness({
      plan: () => ({ fire: TIMEOUT_FIRE }),
      gather_fire_evidence: async () => ({ kind: 'launched', detail: 'live lock on the branch' }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    // A PRIOR round's generation, exactly as `persistRefireReset` leaves it.
    await store.update(run.id, { workflow_run_id: 'generation-from-a-previous-round' })

    await h.loop.runOnce()

    const after = store.get(run.id)!
    expect(after.subagent_status).toBe('running')
    // A stale generation under `running` is what the tick's liveness probe would
    // latch DEAD, reaping the live lane this hold exists to protect. Null is what
    // crash recovery itself writes here, and for the same reason.
    expect(after.workflow_run_id).toBeNull()
  })

  // ARGUS r4 (BLOCKER): carrying `observed` forward NARROWS the clobber window —
  // it does not close it. The gatherer's last re-read and the tick's
  // `saveIfActive` are two statements, and the detached workflow writes between
  // them. The step now hands the store the values it READ, and the store writes
  // those two columns only while they still hold them.
  test('a checkpoint that lands BETWEEN the gatherer and the save survives the spared lane', async () => {
    const h = buildHarness({
      plan: () => ({ fire: TIMEOUT_FIRE }),
      gather_fire_evidence: async (input) => {
        await store.update(input.run.id, { inner_checkpoint: 'forge-done' })
        const observed = pickWorkflowOwned(store.get(input.run.id)!)
        // …and THEN the workflow moves again, after the gatherer has answered and
        // before the tick's save. Simulated here because the real gap IS those two
        // statements.
        await store.update(input.run.id, { inner_checkpoint: 'argus-approved' })
        return { kind: 'launched', detail: 'run row moved since the fire (inner_checkpoint)', observed }
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    await h.loop.runOnce()

    const after = store.get(run.id)!
    expect(isTerminalPhase(after.phase)).toBe(false)
    // WITHOUT THE CAS this reads 'forge-done' — the save regresses the row past
    // the workflow's newest write, which is the misreporting-write class the card
    // exists to remove.
    expect(after.inner_checkpoint).toBe('argus-approved')
  })

  test('a verdict that lands between the gatherer and the save is not stamped over by the published arm', async () => {
    const h = buildHarness({
      plan: () => ({ fire: TIMEOUT_FIRE }),
      gather_fire_evidence: async (input) => {
        const observed = pickWorkflowOwned(store.get(input.run.id)!)
        // The review lands its verdict in the gap.
        await store.update(input.run.id, { inner_verdict: 'APPROVE' })
        return { kind: 'published', detail: 'published', checkpoint: PUBLISHED_CHECKPOINT, observed }
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await store.update(run.id, { inner_checkpoint: PUBLISHED_CHECKPOINT })

    await h.loop.runOnce()

    const after = store.get(run.id)!
    expect(after.phase).toBe('failed')
    // The published arm normally demotes the verdict to REVIEW_NOT_RUN. It must
    // not do so over a verdict that arrived after it looked.
    expect(after.inner_verdict).toBe('APPROVE')
  })

  test('a THROWING gatherer cannot spare the run and cannot crash the launch', async () => {
    const h = buildHarness({
      plan: () => ({ fire: TIMEOUT_FIRE }),
      gather_fire_evidence: () => {
        throw new Error('probe host unavailable')
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    await h.loop.runOnce()

    const after = store.get(run.id)!
    expect(after.phase).toBe('failed')
    expect(after.failure_reason).toBe(PLAIN_FIRE_FAILURE)
  })
})

describe('orchestrator — durable pre-build stage stamps', () => {
  test('a successful fire stamps launch, dispatch, and settle in order', async () => {
    const stamped: Array<{ run_id: string; stage: string; meta: string | null | undefined }> = []
    const h = buildHarness({
      plan: () => ({ fire: { status: 'fired', error: null } }),
      record_stage: (run_id, stage, meta) => stamped.push({ run_id, stage, meta }),
    })
    const created = await createRun()
    const run = (await store.update(created.id, { round: 3, ralph_round: 2 }))!

    await h.loop.runOnce()

    expect(stamped.map((entry) => entry.stage)).toEqual([
      'launch-start',
      'fire-dispatched',
      'fire-settled',
    ])
    expect(stamped.every((entry) => entry.run_id === run.id)).toBe(true)
    expect(stamped[0]!.meta).toContain('round=3')
    expect(stamped[0]!.meta).toContain('ralph_round=2')
  })

  test('a failed fire stamps dispatch but never settle', async () => {
    const stages: string[] = []
    const h = buildHarness({
      plan: () => ({ fire: { status: 'failed', error: 'boom' } }),
      record_stage: (_run_id, stage) => stages.push(stage),
    })
    await createRun()

    await h.loop.runOnce()

    expect(stages).toEqual(['launch-start', 'fire-dispatched'])
  })

  test('a throwing record_stage seam cannot prevent the fire from advancing', async () => {
    const h = buildHarness({
      plan: () => ({ fire: { status: 'fired', error: null } }),
      record_stage: () => {
        throw new Error('ledger unavailable')
      },
    })
    const run = await createRun()

    await h.loop.runOnce()

    expect(h.inputs).toHaveLength(1)
    expect(store.get(run.id)?.subagent_status).toBe('running')
  })

  test('omitting record_stage preserves the existing successful fire path', async () => {
    const h = buildHarness({ plan: () => ({ fire: { status: 'fired', error: null } }) })
    const run = await createRun()

    await h.loop.runOnce()

    expect(h.inputs).toHaveLength(1)
    expect(store.get(run.id)?.subagent_status).toBe('running')
  })
})

describe('orchestrator — idempotent crash-resume', () => {
  test('a prior partial run threads resume_checkpoint + reuses the existing PR (no dup)', async () => {
    const h = buildHarness({ plan: () => ({ result: { verdict: 'APPROVE', prNumber: 7, branch: 'feat-x' } }) })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    // Simulate a crash that left a checkpoint + an opened PR on the row.
    await store.update(run.id, { pr: 7, inner_checkpoint: 'argus-request-changes' })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    // The workflow was fired with the resume checkpoint + the existing PR.
    expect(h.inputs).toHaveLength(1)
    expect(h.inputs[0]!.resume_checkpoint).toBe('argus-request-changes')
    expect(h.inputs[0]!.run.pr).toBe(7)
  })

  test('when the row has no PR but gh finds one, it is folded in (no duplicate open)', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', prNumber: 99, branch: 'feat-x' } }),
      // Answers the PR lookup, and falls through to a drift-free repo for
      // everything else — an unanswered `rev-parse` would hold this pr-mode
      // merge (#542) and the run would never reach `done`.
      hostResponder: (cmd) => (cmd.includes('pr') && cmd.includes('list') ? ok('99') : driftFreeHost(cmd)),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    expect(h.hostCalls.some((c) => c.join(' ').includes('gh pr list --head feat-x'))).toBe(true)
    expect(h.inputs[0]!.run.pr).toBe(99)
  })
})

describe('orchestrator — crash-safe harvest (result survives a restart)', () => {
  test('a run whose workflow wrote inner_result before a restart HARVESTS (never re-fires)', async () => {
    // A run dispatched by a PRIOR process (subagent_run_id set, NOT in this
    // process's `fired` set) that already wrote a terminal result must harvest,
    // not orphan-redispatch — the durable result, not the lost dispatch, wins.
    const h = buildHarness({ plan: () => ({ result: { verdict: 'REQUEST_CHANGES' } }) /* unused */ })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await store.update(run.id, {
      subagent_run_id: 'lost-dispatch-from-prior-process',
      subagent_status: 'running',
      pr: 5,
      inner_checkpoint: 'argus-approved',
      inner_verdict: 'APPROVE',
      inner_result: JSON.stringify({
        ok: true,
        prNumber: 5,
        branch: 'feat-x',
        verdict: 'APPROVE',
        round: 1,
        checkpoint: 'argus-approved',
        reviewedHead: SIM_REVIEWED_HEAD,
      }),
    })

    await h.loop.runOnce()
    const after = store.get(run.id)
    expect(after?.phase).toBe('done')
    expect(after?.pr).toBe(5)
    // No fire happened — the result was harvested straight from the DB.
    expect(h.inputs).toHaveLength(0)
  })
})

describe('orchestrator — stalled workflow guard', () => {
  test('a fired workflow that never writes a result past max_inflight_ms is reaped', async () => {
    let t = 0
    const h = buildHarness({
      // Fire settles, but the workflow NEVER writes a result (result null).
      plan: () => ({ result: null }),
      now: () => new Date(t).toISOString(),
      max_inflight_ms: 1_000,
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    await h.loop.runOnce() // launch + fire (last_advanced_at = t=0)
    expect(store.get(run.id)?.subagent_run_id).not.toBeNull()
    expect(store.get(run.id)?.phase).not.toBe('failed')

    t = 5_000 // advance past max_inflight_ms with no checkpoint/result
    await h.loop.runOnce()
    const after = store.get(run.id)
    expect(after?.phase).toBe('failed')
    expect(after?.inner_verdict).toBe('REVIEW_NOT_RUN')
    expect(after?.failure_reason).toContain('stalled')
  })
})

describe('orchestrator — per-agent hang watchdog (item 2)', () => {
  test('a fired run that makes no progress past no_advance_hang_ms is reaped as a suspected hang', async () => {
    let t = 0
    const h = buildHarness({
      // Fire settles, but the workflow hangs — never checkpoints, never writes a result.
      plan: () => ({ result: null }),
      now: () => new Date(t).toISOString(),
      no_advance_hang_ms: 60_000,
      max_inflight_ms: 2 * 60 * 60_000, // the 2h ceiling stays far away — the hang guard fires first
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    await h.loop.runOnce() // launch + fire (last_advanced_at = t=0)
    expect(store.get(run.id)?.phase).not.toBe('failed')

    // Just under the hang threshold — still waiting, not reaped.
    t = 30_000
    await h.loop.runOnce()
    expect(store.get(run.id)?.phase).not.toBe('failed')

    // Past the hang threshold with no advance → reaped to failed with the hang reason.
    t = 90_000
    await h.loop.runOnce()
    const after = store.get(run.id)
    expect(after?.phase).toBe('failed')
    expect(after?.inner_verdict).toBe('REVIEW_NOT_RUN')
    expect(after?.failure_reason).toContain('suspected agent hang')
  })

  /**
   * THE WATCHDOG'S OWN PREMISE IS FALSE, and these pin the correction.
   *
   * It documents "a HEALTHY build re-stamps `last_advanced_at` on every
   * inner-workflow checkpoint, so it never trips this". Checkpoints land BETWEEN
   * phases; one Forge round runs ~40 min and re-stamps nothing while it does. So the
   * field is stale by construction during exactly the work the watchdog is most
   * likely to interrupt.
   *
   * MEASURED: run 9bece714 was reaped as "no progress for 90 min — suspected agent
   * hang" with pid 286859 alive and its stderr written to seconds earlier.
   */
  test('a stale clock does NOT reap a run whose stage events prove it is advancing', async () => {
    let t = 0
    // The mid-phase evidence: written at t=50s, INSIDE the 60s window, while
    // `last_advanced_at` has been frozen at t=0 since the fire.
    let stageAt: string | null = null
    const h = buildHarness({
      plan: () => ({ result: null }),
      now: () => new Date(t).toISOString(),
      no_advance_hang_ms: 60_000,
      max_inflight_ms: 2 * 60 * 60_000,
      latest_stage_event_at: () => stageAt,
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    await h.loop.runOnce()
    expect(store.get(run.id)?.phase).not.toBe('failed')

    stageAt = new Date(50_000).toISOString()
    t = 90_000 // past the threshold on last_advanced_at — the old code reaps here
    await h.loop.runOnce()

    const after = store.get(run.id)
    expect(after?.phase).not.toBe('failed')
    expect(after?.failure_reason ?? '').not.toContain('suspected agent hang')
    // THE CLOCK MOVED (T4). A spare authorised by RUN-SCOPED evidence — here a stage
    // row inside the window — persists the unmodified snapshot, and `saveIfActive`
    // re-stamps `last_advanced_at` to now() as a matter of course. That is what stops
    // display consumers reporting phantom staleness and makes the probes fire once per
    // hang window instead of once per tick. The watchdog still never READS this column
    // as evidence: the next window's reprieve is re-earned from live evidence.
    expect(after?.last_advanced_at).toBe(new Date(90_000).toISOString())
  })

  test('the reprieve EXPIRES on its own once the evidence stops', async () => {
    // The other half: a stand-down must not become immortality. A run-scoped spare
    // re-stamps the clock (T4), so expiry is measured one full window from the last
    // SPARE — not from the last event, and not from the run's fire. Each window must
    // RE-EARN the reprieve from fresh evidence, and a run that has gone quiet cannot.
    let t = 0
    let stageAt: string | null = null
    const h = buildHarness({
      plan: () => ({ result: null }),
      now: () => new Date(t).toISOString(),
      no_advance_hang_ms: 60_000,
      max_inflight_ms: 2 * 60 * 60_000,
      latest_stage_event_at: () => stageAt,
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await h.loop.runOnce()

    stageAt = new Date(50_000).toISOString()
    t = 90_000
    await h.loop.runOnce()
    expect(store.get(run.id)?.phase).not.toBe('failed')

    // Events stop. The spare at t=90s re-stamped the clock to 90s, so the run is
    // reaped one full window after THAT — and the stage row is by then 105 s old,
    // outside the 60 s window, so there is nothing left to re-earn the reprieve with.
    t = 155_000
    await h.loop.runOnce()
    const after = store.get(run.id)
    expect(after?.phase).toBe('failed')
    expect(after?.failure_reason).toContain('suspected agent hang')
  })

  test('ABSENCE IS NOT EVIDENCE: no events, and no reader at all, both still reap', async () => {
    // The two null paths must be indistinguishable from the old behaviour, or the
    // fix trades a false death for a run nothing can ever reap.
    for (const reader of [() => null, undefined]) {
      let t = 0
      const opts: Parameters<typeof buildHarness>[0] = {
        plan: () => ({ result: null }),
        now: () => new Date(t).toISOString(),
        no_advance_hang_ms: 60_000,
        max_inflight_ms: 2 * 60 * 60_000,
      }
      if (reader !== undefined) opts.latest_stage_event_at = reader
      const h = buildHarness(opts)
      const run = await createRun({ merge_mode: 'pr' as MergeMode })

      await h.loop.runOnce()
      t = 90_000
      await h.loop.runOnce()

      const after = store.get(run.id)
      expect(after?.phase).toBe('failed')
      expect(after?.failure_reason).toContain('suspected agent hang')
    }
  })

  test('a stage event OLDER than the threshold is not a reprieve either', async () => {
    let t = 0
    const h = buildHarness({
      plan: () => ({ result: null }),
      now: () => new Date(t).toISOString(),
      no_advance_hang_ms: 60_000,
      max_inflight_ms: 2 * 60 * 60_000,
      // Evidence exists, but it is ancient — a run that genuinely stopped.
      latest_stage_event_at: () => new Date(1_000).toISOString(),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    await h.loop.runOnce()
    t = 90_000
    await h.loop.runOnce()

    const after = store.get(run.id)
    expect(after?.phase).toBe('failed')
    expect(after?.failure_reason).toContain('suspected agent hang')
  })

  /**
   * THE STAGE LEDGER IS NOT ENOUGH, and these pin the second source.
   *
   * `codex-build.sh` used to stamp `codex-exec-start` immediately before `codex exec`
   * and `codex-exec-end` after it, with NOTHING in between. MEASURED against the live
   * ledger (808 events, 37 completed exec windows): max 72.0 min, avg 20.7 min between
   * those two stamps — so against a 90-minute threshold the reader above was blind for
   * up to 72 of the 90 minutes it was supposed to cover, and the review phase stamped
   * nothing at all. MEASURED over 17 real runs, the newest stage event was OLDER than
   * `last_advanced_at` for 11 of them: for two runs in three the stand-down could not
   * fire even in principle.
   *
   * The launcher-liveness probe already existed and already ran every 15 s — and
   * `tick.ts` threw its POSITIVE answer away (`if (verdict !== 'dead') continue`). These
   * tests are about reading it for the opposite verdict.
   */
  const HANG_MS = 60_000
  /** Evidence far older than the threshold — #442's stand-down CANNOT save a run on it. */
  const ANCIENT_STAGE = () => new Date(0).toISOString()

  test('POSITIVE: an alive launcher spares a run the stage ledger cannot vouch for', async () => {
    // THE ASSERTION THAT FAILS WITHOUT THIS FIX. Stage evidence is 90 s old against a
    // 60 s threshold, so the stage path is exhausted; the probe positively observes the
    // process running. Before this change the run was reaped here — which is the
    // 9bece714 incident (pid 286859 alive, stderr written seconds earlier).
    let t = 0
    let probed = 0
    const h = buildHarness({
      plan: () => ({ result: null }),
      now: () => new Date(t).toISOString(),
      no_advance_hang_ms: HANG_MS,
      max_inflight_ms: 2 * 60 * 60_000,
      latest_stage_event_at: ANCIENT_STAGE,
      probe_run_alive: () => {
        probed += 1
        return 'alive'
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    await h.loop.runOnce()
    t = 90_000
    await h.loop.runOnce()

    const after = store.get(run.id)
    expect(after?.phase).not.toBe('failed')
    expect(after?.failure_reason ?? '').not.toContain('suspected agent hang')
    // The probe was actually CONSULTED — a stand-down that happened for some other
    // reason would pass the assertion above while proving nothing.
    expect(probed).toBeGreaterThan(0)
    // NOTHING WAS WRITTEN, and deliberately so (T4). The launcher probe answers about a
    // shared launcher GENERATION, not about this run, so it spares the run but does not
    // move its clock; only RUN-SCOPED evidence re-stamps. That split is exactly what
    // keeps the 2 h ceiling reachable for a forever-alive launcher (see N4).
    expect(after?.last_advanced_at).toBe(new Date(0).toISOString())
  })

  test('POSITIVE: a reap that DOES fire discloses what was checked and what it found', async () => {
    // The card's second ask, and the half that was entirely unimplemented: every one of
    // the 13 reaped rows in the live DB carried the bare "suspected agent hang" string,
    // which says nothing about the evidence the watchdog did or did not have.
    let t = 0
    const h = buildHarness({
      plan: () => ({ result: null }),
      now: () => new Date(t).toISOString(),
      no_advance_hang_ms: HANG_MS,
      max_inflight_ms: 2 * 60 * 60_000,
      latest_stage_event_at: ANCIENT_STAGE,
      probe_run_alive: () => 'unknown',
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    await h.loop.runOnce()
    t = 20 * 60_000 // 20 minutes in, so the stage age is a round, checkable number
    await h.loop.runOnce()

    const reason = store.get(run.id)?.failure_reason ?? ''
    expect(store.get(run.id)?.phase).toBe('failed')
    // ON THE REAL STRING, not a boolean, and with the CONCRETE numbers — a disclosure
    // that says only "liveness checked" would be as unfalsifiable as saying nothing.
    expect(reason).toMatch(/liveness checked:/)
    expect(reason).toContain('newest stage event 20 min ago')
    expect(reason).toContain('launcher probe=unknown')
  })

  test('NEGATIVE (N1): an UNKNOWN probe still reaps, on the byte-identical reason prefix', async () => {
    // Absence of evidence is not evidence of life. A probe outage, an unrecognised
    // generation, a registry that could not be read — none of them may buy a reprieve,
    // and the reason class `delivery.ts` routes on must not shift under it.
    let t = 0
    const h = buildHarness({
      plan: () => ({ result: null }),
      now: () => new Date(t).toISOString(),
      no_advance_hang_ms: HANG_MS,
      max_inflight_ms: 2 * 60 * 60_000,
      latest_stage_event_at: ANCIENT_STAGE,
      probe_run_alive: () => 'unknown',
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await h.loop.runOnce()
    t = 90_000
    await h.loop.runOnce()

    const after = store.get(run.id)
    expect(after?.phase).toBe('failed')
    expect(after?.failure_reason ?? '').toStartWith(
      'no progress for 1 min — suspected agent hang (inner workflow stopped advancing)',
    )
  })

  test('NEGATIVE (N1b): a THROWING probe is an outage, not a life sign — it still reaps', async () => {
    let t = 0
    const h = buildHarness({
      plan: () => ({ result: null }),
      now: () => new Date(t).toISOString(),
      no_advance_hang_ms: HANG_MS,
      max_inflight_ms: 2 * 60 * 60_000,
      latest_stage_event_at: ANCIENT_STAGE,
      probe_run_alive: () => {
        throw new Error('registry unreadable')
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await h.loop.runOnce()
    t = 90_000
    await h.loop.runOnce()

    const after = store.get(run.id)
    expect(after?.phase).toBe('failed')
    expect(after?.failure_reason ?? '').toContain('launcher probe=unknown')
  })

  // ── N2: WHICH EVIDENCE OUTRANKS WHICH ────────────────────────────────────────
  //
  // AN EARLIER CUT MADE `probe === 'dead'` STRICTLY STRONGER THAN ANY STAGE EVENT.
  // That is the inverse of this file's own position a few hundred lines up — "A DEAD
  // LAUNCHER IS NOT A DEAD BUILD", written from three measured gateway boots that
  // reaped healthy builds — because the probe answers about a launcher GENERATION
  // several runs SHARE while the build is detached from it (`nohup setsid`), and the
  // heartbeat answers about THIS run's own wrapper pid.
  //
  // BOTH HALVES ARE PINNED, because each without the other is a different bug:
  //   N2  — a stage row too OLD to prove the wrapper is alive does NOT save a run
  //         whose launcher is positively dead. ("A heartbeat row proves a TICKER ran,
  //         not that the build did.")
  //   N2c — a stage row inside `DEAD_LAUNCHER_OVERRIDE_MS` DOES, because the ticker
  //         re-checks `kill -0 "$MAIN_PID"` before every stamp and so cannot outlive
  //         its wrapper by more than one cadence.
  // These run on the REAL 90-minute threshold rather than the 1-minute `HANG_MS` the
  // tests above use: the two windows only differ at real scale, and a fixture that
  // collapses them would make one of the two assertions vacuous.
  const REAL_HANG_MS = 90 * 60_000

  test('NEGATIVE (N2): a dead launcher reaps through a STALE stage row (a ticker is not a build)', async () => {
    let t = 0
    // 30 min old at the tick below: well inside the 90-min stand-down window, and well
    // OUTSIDE the 15-min window in which a ticker must still have had a live wrapper.
    const stageAt = 60 * 60_000
    const h = buildHarness({
      plan: () => ({ result: null }),
      now: () => new Date(t).toISOString(),
      no_advance_hang_ms: REAL_HANG_MS,
      max_inflight_ms: 4 * 60 * 60_000,
      latest_stage_event_at: () => new Date(stageAt).toISOString(),
      probe_run_alive: () => 'dead',
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await h.loop.runOnce()
    t = 90 * 60_000 + 1_000
    await h.loop.runOnce()

    const after = store.get(run.id)
    expect(after?.phase).toBe('failed')
    expect(after?.failure_reason ?? '').toContain('launcher is positively dead')
    // Still routed to delivery.ts's `hang` class — the copy changed, the class did not.
    expect(after?.failure_reason ?? '').toContain('no progress for')
    // CONTROL: the stage row really was inside the ordinary stand-down window, so this
    // reap is the DEAD probe overriding it and not the row having expired.
    expect(90 * 60_000 + 1_000 - stageAt).toBeLessThan(REAL_HANG_MS)
  })

  test('NEGATIVE (N2c): a dead launcher does NOT reap through a row inside the override window', async () => {
    // THE MEASURED INCIDENT THIS PROTECTS: a gateway restart kills the launcher
    // generation while the detached wrapper keeps building and keeps stamping. Under
    // the old precedence that run was terminally reaped while writing rows that second.
    let t = 0
    const stageAt = 90 * 60_000 // 1 min old at the tick below
    const h = buildHarness({
      plan: () => ({ result: null }),
      now: () => new Date(t).toISOString(),
      no_advance_hang_ms: REAL_HANG_MS,
      max_inflight_ms: 4 * 60 * 60_000,
      latest_stage_event_at: () => new Date(stageAt).toISOString(),
      probe_run_alive: () => 'dead',
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await h.loop.runOnce()
    t = 90 * 60_000 + 60_000
    await h.loop.runOnce()

    const after = store.get(run.id)
    expect(after?.phase).not.toBe('failed')
    // THE CLOCK MOVED: this run was spared by THIS run's own ticker row — run-scoped
    // evidence — so the spared tick re-stamped `last_advanced_at` (T4).
    expect(after?.last_advanced_at).toBe(new Date(90 * 60_000 + 60_000).toISOString())
  })

  test('NEGATIVE (N2d): the override window is BOUNDED — the 2 h ceiling still reaps through it', async () => {
    // NEVER WIDEN A REFUSAL — or a REPRIEVE — WITHOUT A RETRACTION PATH. A ticker that
    // somehow never stopped must not hold a lane forever; the ceiling clears it with no
    // operator action and no stored state.
    let t = 0
    const h = buildHarness({
      plan: () => ({ result: null }),
      now: () => new Date(t).toISOString(),
      no_advance_hang_ms: REAL_HANG_MS,
      max_inflight_ms: 2 * 60 * 60_000,
      // Stamping THIS SECOND, forever.
      latest_stage_event_at: () => new Date(t).toISOString(),
      probe_run_alive: () => 'dead',
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await h.loop.runOnce()
    t = 2 * 60 * 60_000 + 60_000
    await h.loop.runOnce()

    const after = store.get(run.id)
    expect(after?.phase).toBe('failed')
    expect(after?.failure_reason ?? '').toContain('the 2 h ceiling outranks any liveness reprieve')
  })

  test('NEGATIVE (N2b): the same FRESH evidence with a non-dead probe DOES stand the run down', async () => {
    // The control for N2. Without it, N2 would pass even if the code reaped every run
    // past the threshold regardless of evidence — which is the bug, not the fix.
    let t = 0
    const h = buildHarness({
      plan: () => ({ result: null }),
      now: () => new Date(t).toISOString(),
      no_advance_hang_ms: HANG_MS,
      max_inflight_ms: 2 * 60 * 60_000,
      latest_stage_event_at: () => new Date(80_000).toISOString(),
      probe_run_alive: () => 'unknown',
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await h.loop.runOnce()
    t = 90_000
    await h.loop.runOnce()

    expect(store.get(run.id)?.phase).not.toBe('failed')
  })

  test('DISCLOSURE ON BOTH OUTCOMES: a STAND-DOWN reports what the probe answered too', async () => {
    // The comment on this block claimed the disclosure was "carried onto BOTH
    // outcomes". It was not: the reap `reason` interpolated it and the stand-down
    // `note` used a separate string that never named the probe — so a run SPARED left
    // no record of what the probe said, and only the kills were auditable. A watchdog
    // that quietly declines to fire is as hard to trust as one that quietly fires.
    let t = 0
    const h = buildHarness({
      plan: () => ({ result: null }),
      now: () => new Date(t).toISOString(),
      no_advance_hang_ms: HANG_MS,
      max_inflight_ms: 2 * 60 * 60_000,
      // Fresh stage evidence carries the stand-down; the probe is CONSULTED anyway and
      // its answer is exactly what used to go unrecorded on this branch.
      latest_stage_event_at: () => new Date(19 * 60_000).toISOString(),
      probe_run_alive: () => 'unknown',
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await h.loop.runOnce()
    t = 20 * 60_000

    const outcome = await h.step(store.get(run.id)!)
    // A fresh stage row is RUN-SCOPED evidence, so this spare re-stamps the clock (T4)
    // and the note says which of the two clock decisions was taken.
    expect(outcome.changed).toBe(true)
    expect(outcome.note ?? '').toContain('advancement clock re-stamped')
    expect(outcome.note ?? '').toContain('hang watchdog STOOD DOWN')
    // THE SAME CONCRETE DISCLOSURE THE REAP CARRIES — both clocks and the probe's
    // answer, never a boolean.
    expect(outcome.note ?? '').toMatch(/liveness checked:/)
    expect(outcome.note ?? '').toContain('newest stage event 1 min ago')
    expect(outcome.note ?? '').toContain('launcher probe=unknown')
    // CONTROL: the run really was spared, so this is a stand-down note and not a reap.
    expect(store.get(run.id)?.phase).not.toBe('failed')
  })

  test('NEGATIVE (N3): with NO probe wired at all, behaviour is unchanged from before the seam', async () => {
    // Extends the ABSENCE IS NOT EVIDENCE test above to the new seam. An un-wired
    // deployment must reap exactly as it always did.
    let t = 0
    const h = buildHarness({
      plan: () => ({ result: null }),
      now: () => new Date(t).toISOString(),
      no_advance_hang_ms: HANG_MS,
      max_inflight_ms: 2 * 60 * 60_000,
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await h.loop.runOnce()
    t = 90_000
    await h.loop.runOnce()

    const after = store.get(run.id)
    expect(after?.phase).toBe('failed')
    expect(after?.failure_reason ?? '').toStartWith(
      'no progress for 1 min — suspected agent hang (inner workflow stopped advancing)',
    )
    // And it says so: no evidence of either kind was available.
    expect(after?.failure_reason ?? '').toContain('newest stage event none, launcher probe=not wired')
  })

  test('NEGATIVE (N4) IMMORTALITY GUARD: a forever-alive probe still dies at the inflight ceiling', async () => {
    // THE RISK THIS FIX CARRIES, pinned. A launcher is SHARED INFRASTRUCTURE, not proof
    // that the detached build it fired is working — so if 'alive' conferred an unbounded
    // reprieve, one genuinely wedged run whose launcher survives would hold one of ~6
    // lanes forever. That is strictly worse than the false kill being fixed here.
    let t = 0
    const h = buildHarness({
      plan: () => ({ result: null }),
      now: () => new Date(t).toISOString(),
      no_advance_hang_ms: HANG_MS,
      max_inflight_ms: 600_000, // the 2h ceiling, scaled
      probe_run_alive: () => 'alive',
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await h.loop.runOnce()

    // Deep past the hang threshold, under the ceiling: alive, so spared — repeatedly.
    for (const at of [90_000, 300_000, 599_000]) {
      t = at
      await h.loop.runOnce()
      expect(store.get(run.id)?.phase).not.toBe('failed')
    }

    // One tick past the ceiling: the lane is freed even though the probe still says
    // ALIVE and never stopped saying so.
    t = 601_000
    await h.loop.runOnce()
    const after = store.get(run.id)
    expect(after?.phase).toBe('failed')
    expect(after?.failure_reason ?? '').toContain('inner workflow stalled (no terminal result within 10 min)')
    // Disclosed there too, and it names the probe answer it OVERRODE.
    expect(after?.failure_reason ?? '').toContain('launcher probe=alive')
    expect(after?.failure_reason ?? '').toContain('ceiling outranks any liveness reprieve')
  })

  test('NEGATIVE (N5): when the heartbeat STOPS, the reprieve expires from the LAST SPARED TICK', async () => {
    // The sibling of "the reprieve EXPIRES on its own", for the ticker case: a heartbeat
    // that dies while the exec hangs must not leave the run un-reapable. The probe is
    // pinned 'unknown' so ONLY the heartbeat is under test — a live-launcher answer
    // would rescue the run for an unrelated reason and hide a broken expiry.
    let t = 0
    let lastBeat: string | null = null
    const h = buildHarness({
      plan: () => ({ result: null }),
      now: () => new Date(t).toISOString(),
      no_advance_hang_ms: HANG_MS,
      max_inflight_ms: 2 * 60 * 60_000,
      latest_stage_event_at: () => lastBeat,
      probe_run_alive: () => 'unknown',
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await h.loop.runOnce()

    // The ticker beats twice, one hang window apart, each beat landing on a tick where
    // the watchdog TRIPS — so each one is a run-scoped spare that re-stamps the clock
    // (T4). The spacing is deliberate: after the first spare moves the clock to t=71 s,
    // a beat sooner than one window later would not even reach the watchdog.
    for (const beat of [70_000, 140_000]) {
      lastBeat = new Date(beat).toISOString()
      t = beat + 1_000
      await h.loop.runOnce()
      expect(store.get(run.id)?.phase).not.toBe('failed')
    }

    // Then it dies. 58 s after the last SPARED TICK (t=141 s) the watchdog does not even
    // trip — the reprieve now runs from the spare, not from the run's fire.
    t = 199_000
    await h.loop.runOnce()
    expect(store.get(run.id)?.phase).not.toBe('failed')

    // One full window past that LAST SPARED TICK: the watchdog trips, the newest beat is
    // by now 62 s old — outside the window — and nothing re-earns the reprieve. Reaped.
    t = 202_000
    await h.loop.runOnce()
    const after = store.get(run.id)
    expect(after?.phase).toBe('failed')
    expect(after?.failure_reason ?? '').toContain('suspected agent hang')
    expect(after?.failure_reason ?? '').toContain('newest stage event 1 min ago')
  })

  test('a stale orphan past the hang threshold is reaped, not redispatched', async () => {
    let t = 0
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      now: () => new Date(t).toISOString(),
      no_advance_hang_ms: 60_000,
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    // An orphan (dispatch id from a prior process) that has not advanced for a while.
    await store.update(run.id, { subagent_run_id: 'STALE', subagent_status: 'running' })

    t = 120_000 // well past the hang threshold
    await h.loop.runOnce()
    const after = store.get(run.id)
    expect(after?.phase).toBe('failed')
    expect(after?.inner_verdict).toBe('REVIEW_NOT_RUN')
    expect(after?.failure_reason).toContain('suspected agent hang')
    // Reaped, NOT redispatched.
    expect(h.inputs).toHaveLength(0)
  })
})

/**
 * THE THREE RUN-SCOPED PROBES (card #2). The two evidence sources that came
 * before this one answer about the wrong subject: the stage ledger is measured
 * silent for up to 72 min inside one `codex exec` and says nothing at all during
 * review, and the launcher probe answers about a GENERATION several runs share.
 * Neither can say whether THIS build is doing work — which is how 17 runs in 30
 * days were terminated as "suspected agent hang", four of them with a complete,
 * green PR already on GitHub.
 *
 * The seam is exercised with FAKE gatherers only: no real process table, no real
 * scratch files, and nothing in this file ever signals a process.
 */
describe('orchestrator — run-scoped hang evidence (three probes)', () => {
  const HANG_MS = 60_000
  type Obs = import('./run-evidence.ts').EvidenceObservation
  const obs = {
    activity: (age_ms: number, detail = 'seen'): Obs => ({ observed: 'activity', age_ms, detail }),
    nothing: (detail = 'looked, found none'): Obs => ({ observed: 'nothing', detail }),
    unknown: (detail = 'could not look'): Obs => ({ observed: 'unknown', detail }),
  }

  test('SPARED BY A LIVE PROCESS: the ground-truth probe outranks a stale clock', async () => {
    // The measured false kill, reduced: `last_advanced_at` frozen at the fire while
    // the run's own process is running this second.
    let t = 0
    let consulted = 0
    const h = buildHarness({
      plan: () => ({ result: null }),
      now: () => new Date(t).toISOString(),
      no_advance_hang_ms: HANG_MS,
      max_inflight_ms: 2 * 60 * 60_000,
      gather_run_evidence: () => {
        consulted += 1
        return { process: obs.activity(0), artifacts: obs.nothing(), ref: obs.nothing() }
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await h.loop.runOnce()

    t = 90_000
    const outcome = await h.step(store.get(run.id)!)

    expect(consulted).toBeGreaterThan(0) // the seam really was asked, not defaulted past
    // A live process is the strongest RUN-SCOPED answer there is, so the spare re-stamps
    // the advancement clock (T4) and says so.
    expect(outcome.changed).toBe(true)
    expect(outcome.note ?? '').toContain('advancement clock re-stamped')
    expect(outcome.note ?? '').toContain('hang watchdog STOOD DOWN')
    expect(outcome.note ?? '').toContain('run process=live')
    const after = store.get(run.id)
    expect(after?.phase).not.toBe('failed')

    // AND IT ACTUALLY PERSISTS. `changed: true` is only half the claim — the tick's
    // `saveIfActive` is what carries it to the column (the orchestrator never touches
    // `last_advanced_at` itself; callers cannot pass it). Same instant, through the real
    // seam: this is the unit half of T4's verification.
    await h.loop.runOnce()
    expect(store.get(run.id)?.last_advanced_at).toBe(new Date(90_000).toISOString())
  })

  test('SPARED BY A FRESH ARTIFACT: an mtime inside the window is activity', async () => {
    let t = 0
    const h = buildHarness({
      plan: () => ({ result: null }),
      now: () => new Date(t).toISOString(),
      no_advance_hang_ms: HANG_MS,
      max_inflight_ms: 2 * 60 * 60_000,
      gather_run_evidence: () => ({
        process: obs.nothing(),
        artifacts: obs.activity(30_000),
        ref: obs.nothing(),
      }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await h.loop.runOnce()

    t = 90_000
    await h.loop.runOnce()
    expect(store.get(run.id)?.phase).not.toBe('failed')
  })

  test('SPARED BY BRANCH-REF MOVEMENT: the third probe carries a stand-down on its own', async () => {
    let t = 0
    const h = buildHarness({
      plan: () => ({ result: null }),
      now: () => new Date(t).toISOString(),
      no_advance_hang_ms: HANG_MS,
      max_inflight_ms: 2 * 60 * 60_000,
      gather_run_evidence: () => ({
        process: obs.nothing(),
        artifacts: obs.nothing(),
        ref: obs.activity(30_000),
      }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await h.loop.runOnce()

    t = 90_000
    await h.loop.runOnce()
    expect(store.get(run.id)?.phase).not.toBe('failed')
  })

  test('POSITIVE CONTROL: all quiet still REAPS, and the reason names every probe', async () => {
    // A watchdog that can no longer kill anything is a different bug of the same
    // family. Every probe ran, none saw activity inside the window — reap, with the
    // reap prefix unchanged byte-for-byte and the evidence spelled out after it.
    let t = 0
    const h = buildHarness({
      plan: () => ({ result: null }),
      now: () => new Date(t).toISOString(),
      no_advance_hang_ms: HANG_MS,
      max_inflight_ms: 2 * 60 * 60_000,
      gather_run_evidence: () => ({
        process: obs.nothing(),
        // OLDER than the 60 s window: quiet, but its age is still disclosed.
        artifacts: obs.activity(120_000),
        ref: obs.nothing(),
      }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await h.loop.runOnce()

    t = 90_000
    await h.loop.runOnce()

    const after = store.get(run.id)
    expect(after?.phase).toBe('failed')
    const reason = after?.failure_reason ?? ''
    expect(reason).toStartWith(
      'no progress for 1 min — suspected agent hang (inner workflow stopped advancing)',
    )
    expect(reason).toContain('liveness checked:')
    expect(reason).toContain('run process=none observed')
    expect(reason).toContain('newest artifact 2 min old')
    expect(reason).toContain('no branch ref movement recorded')
  })

  test('AN UNKNOWN PROBE DEFERS — and the reap stays reachable once it can look again', async () => {
    // Both directions in one test. "Could not check" must not read as "checked and
    // found nothing" (the defect class this card forbids), and the deferral must not
    // become an amnesty.
    let t = 0
    let blind = true
    const h = buildHarness({
      plan: () => ({ result: null }),
      now: () => new Date(t).toISOString(),
      no_advance_hang_ms: HANG_MS,
      max_inflight_ms: 2 * 60 * 60_000,
      gather_run_evidence: () => ({
        process: obs.nothing(),
        artifacts: blind ? obs.unknown('scratch dir unreadable') : obs.nothing(),
        ref: obs.nothing(),
      }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await h.loop.runOnce()

    t = 90_000
    const deferred = await h.step(store.get(run.id)!)
    expect(deferred.changed).toBe(false)
    expect(deferred.note ?? '').toContain('hang watchdog DEFERRED')
    expect(deferred.note ?? '').toContain('newest artifact unknown (scratch dir unreadable)')
    await h.loop.runOnce()
    expect(store.get(run.id)?.phase).not.toBe('failed')

    // The probe recovers and positively sees nothing: the very next tick reaps.
    blind = false
    t = 120_000
    await h.loop.runOnce()
    const after = store.get(run.id)
    expect(after?.phase).toBe('failed')
    expect(after?.failure_reason ?? '').toContain('suspected agent hang')
  })

  test('A THROWING GATHERER DEFERS, never reaps — its own failure is not evidence of death', async () => {
    let t = 0
    let throwing = true
    const h = buildHarness({
      plan: () => ({ result: null }),
      now: () => new Date(t).toISOString(),
      no_advance_hang_ms: HANG_MS,
      max_inflight_ms: 2 * 60 * 60_000,
      gather_run_evidence: () => {
        if (throwing) throw new Error('process table query failed')
        return { process: obs.nothing(), artifacts: obs.nothing(), ref: obs.nothing() }
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await h.loop.runOnce()

    t = 90_000
    const deferred = await h.step(store.get(run.id)!)
    expect(deferred.changed).toBe(false)
    expect(deferred.note ?? '').toContain('hang watchdog DEFERRED')
    expect(deferred.note ?? '').toContain('process table query failed')
    await h.loop.runOnce()
    expect(store.get(run.id)?.phase).not.toBe('failed')

    throwing = false
    t = 120_000
    await h.loop.runOnce()
    expect(store.get(run.id)?.phase).toBe('failed')
  })

  test('THE CEILING OUTRANKS A DEFERRAL — a permanently blind probe cannot hold a lane', async () => {
    // NEVER WIDEN A REPRIEVE WITHOUT A RETRACTION PATH. A gatherer that can never
    // answer would otherwise defer forever, which is a worse failure than the false
    // kill this card fixes: there are only ~6 lanes.
    let t = 0
    const h = buildHarness({
      plan: () => ({ result: null }),
      now: () => new Date(t).toISOString(),
      no_advance_hang_ms: HANG_MS,
      max_inflight_ms: 100_000,
      gather_run_evidence: () => ({
        process: obs.unknown('process table unreadable'),
        artifacts: obs.unknown('process table unreadable'),
        ref: obs.unknown('process table unreadable'),
      }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await h.loop.runOnce()

    t = 150_000
    await h.loop.runOnce()
    const after = store.get(run.id)
    expect(after?.phase).toBe('failed')
    expect(after?.failure_reason ?? '').toContain('inner workflow stalled (no terminal result within 2 min)')
    expect(after?.failure_reason ?? '').toContain('ceiling outranks any liveness reprieve')
    // Disclosed there too — the ceiling reaped THROUGH a blind check, and says so.
    expect(after?.failure_reason ?? '').toContain('run process=unknown (process table unreadable)')
  })

  test('DEAD LAUNCHER: only run-scoped activity INSIDE the override window overturns it', async () => {
    // Mirrors N2/N2c for the new probes, at the REAL thresholds — the 90-min hang
    // window and the 15-min override window only differ at real scale, and a fixture
    // that collapses them makes one of the two assertions vacuous.
    const REAL_HANG_MS = 90 * 60_000
    for (const [artifactAgeMs, reaped] of [
      [10 * 60_000, false],
      [30 * 60_000, true],
    ] as const) {
      let t = 0
      const h = buildHarness({
        plan: () => ({ result: null }),
        now: () => new Date(t).toISOString(),
        no_advance_hang_ms: REAL_HANG_MS,
        max_inflight_ms: 4 * 60 * 60_000,
        // ANCIENT stage evidence: the stage ledger cannot be what saves here.
        latest_stage_event_at: () => new Date(0).toISOString(),
        probe_run_alive: () => 'dead',
        gather_run_evidence: () => ({
          process: obs.nothing(),
          artifacts: obs.activity(artifactAgeMs),
          ref: obs.nothing(),
        }),
      })
      // Both legs share one database (`beforeEach`), so each needs its own slug.
      const run = await createRun({ merge_mode: 'pr' as MergeMode, slug: `add-thing-${artifactAgeMs}` })
      await h.loop.runOnce()
      t = REAL_HANG_MS + 60_000
      await h.loop.runOnce()

      const after = store.get(run.id)
      if (reaped) {
        expect(after?.phase).toBe('failed')
        expect(after?.failure_reason ?? '').toContain('launcher is positively dead')
      } else {
        expect(after?.phase).not.toBe('failed')
      }
      // CONTROL: the artifact really was inside the ordinary hang window in BOTH legs,
      // so the difference above is the override window and not the hang window.
      expect(artifactAgeMs).toBeLessThan(REAL_HANG_MS)
    }
  })
})

describe('orchestrator — orphan recovery', () => {
  test('redispatch (default) re-fires a lost dispatch exactly once, resuming from the checkpoint', async () => {
    const h = buildHarness({ plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }) })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    // A run whose dispatch was lost on restart (stale id, persisted checkpoint, no result).
    await store.update(run.id, {
      subagent_run_id: 'stale-id-from-prior-process',
      subagent_status: 'running',
      pr: 42,
      inner_checkpoint: 'forge-done',
    })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    expect(h.inputs).toHaveLength(1)
    expect(h.inputs[0]!.resume_checkpoint).toBe('forge-done')
  })

  test('the checkpoint travels WITH the commit it was recorded against + its findings', async () => {
    const h = buildHarness({ plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }) })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    const head = 'a'.repeat(40)
    await store.update(run.id, {
      subagent_run_id: 'stale-id-from-prior-process',
      subagent_status: 'running',
      pr: 42,
      inner_checkpoint: 'argus-request-changes',
      inner_checkpoint_head: head,
      inner_checkpoint_findings: '[{"severity":"blocker","title":"boom","evidence":"a.ts:1"}]',
    })

    await runToTerminal(h, run.id)
    expect(h.inputs).toHaveLength(1)
    // Without the OID the workflow cannot tell whether the branch still holds the
    // code that verdict was about, so it would have to rebuild — which is exactly
    // what every relaunch did before this.
    expect(h.inputs[0]!.resume_checkpoint_head).toBe(head)
    expect(h.inputs[0]!.resume_findings).toContain('boom')
  })

  test('a row with a checkpoint but NO recorded OID threads null (old data cannot unlock the fast path)', async () => {
    const h = buildHarness({ plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }) })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await store.update(run.id, {
      subagent_run_id: 'stale-id-from-prior-process',
      subagent_status: 'running',
      pr: 42,
      inner_checkpoint: 'argus-approved',
    })

    await runToTerminal(h, run.id)
    expect(h.inputs).toHaveLength(1)
    expect(h.inputs[0]!.resume_checkpoint_head ?? null).toBeNull()
    expect(h.inputs[0]!.resume_findings ?? null).toBeNull()
  })

  // BLOCKER (round 1): the settle-timeout hold lives in the in-memory `fired` set,
  // which a restart loses BY DESIGN — after which the default `redispatch` policy
  // would clear the slot and fire a SECOND workflow over a lane that may still be
  // building the branch. The filesystem survived the restart even though the set
  // did not, so orphan recovery asks it.
  test('an orphan whose branch is held by a LIVE worktree lock is waited on, never redispatched', async () => {
    let probed = 0
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE' } }),
      probe_branch_holder: async (_repo, branch) => {
        probed += 1
        return {
          worktree_basename: `wf_live_${branch.slice(-3)}`,
          lock_reason: 'claude agent wf_live (pid 4242 start 99)',
          pid: 4242,
          pid_live: true,
          mtime_ms: 0,
        }
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode, branch: 'trident/held' })
    await store.update(run.id, { subagent_run_id: 'STALE-FROM-A-PRIOR-PROCESS', subagent_status: 'running' })

    await h.loop.runOnce()

    expect(probed).toBe(1)
    // NO second lane, and the row stays non-terminal (which also keeps
    // board-dispatch's own branch-liveness refusal armed against it).
    expect(h.inputs).toHaveLength(0)
    const after = store.get(run.id)!
    expect(isTerminalPhase(after.phase)).toBe(false)
    expect(after.subagent_run_id).toBe('STALE-FROM-A-PRIOR-PROCESS')
  })

  test('an orphan whose branch holder is NOT live redispatches exactly as before', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE' } }),
      probe_branch_holder: async () => ({
        worktree_basename: 'wf_dead',
        lock_reason: 'claude agent wf_dead (pid 9 start 1)',
        pid: 9,
        pid_live: false,
        mtime_ms: 0,
      }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode, branch: 'trident/free' })
    await store.update(run.id, { subagent_run_id: 'STALE', subagent_status: 'running' })

    await h.loop.runOnce()

    expect(h.inputs).toHaveLength(1)
  })

  test('a THROWING branch-holder probe is not evidence — the orphan redispatches', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE' } }),
      probe_branch_holder: async () => {
        throw new Error('worktree list unavailable')
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode, branch: 'trident/blind' })
    await store.update(run.id, { subagent_run_id: 'STALE', subagent_status: 'running' })

    await h.loop.runOnce()

    expect(h.inputs).toHaveLength(1)
  })

  test("'wait' policy leaves the orphan untouched (no fire, no advance)", async () => {
    const h = buildHarness({ plan: () => ({ result: { verdict: 'APPROVE' } }), on_orphaned_session: 'wait' })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await store.update(run.id, { subagent_run_id: 'STALE', subagent_status: 'running' })

    await h.loop.runOnce()
    const after = store.get(run.id)
    expect(after?.phase).not.toBe('done')
    expect(after?.subagent_run_id).toBe('STALE')
    expect(h.inputs).toHaveLength(0)
  })

  test("'fail' policy reaps the orphan loudly", async () => {
    const h = buildHarness({ plan: () => ({ result: { verdict: 'APPROVE' } }), on_orphaned_session: 'fail' })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await store.update(run.id, { subagent_run_id: 'STALE', subagent_status: 'running' })

    await h.loop.runOnce()
    const after = store.get(run.id)
    expect(after?.phase).toBe('failed')
    expect(after?.subagent_status).toBe('crashed')
    expect(after?.inner_verdict).toBe('REVIEW_NOT_RUN')
    expect(after?.failure_reason).toContain('orphaned')
    expect(h.inputs).toHaveLength(0)
  })

  // THE REAP PATHS ARE THE OTHER HALF OF THE SUITE-GATE HOLE. A row whose verdict
  // was written OUT OF PROCESS by the inner workflow (the shape below) is reaped by
  // `failedRun`, not by the harvest — so the provenance guard has to be in both, and
  // the orphan branch used to inline a THIRD copy of the rule that had neither.
  //
  // RED-mutation: drop `hasArgusProvenance(run.inner_checkpoint) &&` from `failedRun`
  // and both tests below fail.
  test('a reaped orphan does NOT inherit a never-reviewed REQUEST_CHANGES from the row', async () => {
    const h = buildHarness({ plan: () => ({ result: { verdict: 'APPROVE' } }), on_orphaned_session: 'fail' })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await store.update(run.id, {
      subagent_run_id: 'STALE',
      subagent_status: 'running',
      // Written by the inner workflow before it died: the suite gate's own blocker,
      // at a checkpoint that proves review never ran.
      inner_checkpoint: 'forge-done',
      inner_checkpoint_findings: '[{"severity":"blocker","title":"FULL SUITE NOT PROVEN"}]',
    })
    await db.run('UPDATE code_trident_runs SET inner_verdict = ? WHERE id = ?', ['REQUEST_CHANGES', run.id])

    await h.loop.runOnce()
    const after = store.get(run.id)
    expect(after?.phase).toBe('failed')
    expect(after?.inner_verdict).toBe('REVIEW_NOT_RUN')
    // The evidence survives; only the untrue verdict is corrected.
    expect(after?.inner_checkpoint_findings).toContain('FULL SUITE NOT PROVEN')
  })

  test('a reaped orphan DOES keep a genuinely reviewed REQUEST_CHANGES', async () => {
    // POSITIVE CONTROL — without this, a guard that simply always wrote
    // REVIEW_NOT_RUN would pass the test above and destroy real review verdicts.
    const h = buildHarness({ plan: () => ({ result: { verdict: 'APPROVE' } }), on_orphaned_session: 'fail' })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await store.update(run.id, {
      subagent_run_id: 'STALE',
      subagent_status: 'running',
      inner_checkpoint: 'argus-request-changes-round-2',
      inner_checkpoint_findings: '[{"severity":"blocker","title":"the reviewer really did speak"}]',
    })
    await db.run('UPDATE code_trident_runs SET inner_verdict = ? WHERE id = ?', ['REQUEST_CHANGES', run.id])

    await h.loop.runOnce()
    expect(store.get(run.id)?.inner_verdict).toBe('REQUEST_CHANGES')
  })
})

describe('orchestrator — resume safety (no double-fire)', () => {
  test('a re-entrant tick while the workflow is in flight does NOT fire again', async () => {
    const h = buildHarness({ plan: () => ({ result: { verdict: 'APPROVE', prNumber: 7, branch: 'feat-x' } }) })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    // Launch tick fires once; do NOT complete the workflow yet.
    await h.loop.runOnce()
    const afterLaunch = store.get(run.id)
    expect(afterLaunch?.subagent_run_id).not.toBeNull()
    expect(h.inputs).toHaveLength(1)

    // Re-enter twice while the workflow is still in flight — must wait, not re-fire.
    await h.loop.runOnce()
    await h.loop.runOnce()
    expect(h.inputs).toHaveLength(1)

    // Now let the workflow finish and harvest.
    await h.complete()
    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    expect(h.inputs).toHaveLength(1)
  })
})

describe('orchestrator — CODEX_HOME resolution', () => {
  test('prefers the per-run resolver over the static codex_home', async () => {
    const seen: string[] = []
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', prNumber: 9, branch: 'feat-x' } }),
      codex_home: '/static/global',
      resolve_codex_home: (run) => {
        seen.push(run.project_slug)
        return `/resolved/${run.project_slug}`
      },
    })
    const run = await createRun({ project_slug: 't1' })
    await runToTerminal(h, run.id)
    // The resolver was called with the launching run and its output threaded to
    // the inner workflow — NOT the static dir.
    expect(seen).toContain('t1')
    expect(h.inputs[0]?.codex_home).toBe('/resolved/t1')
  })

  test('falls back to the static codex_home when no resolver is supplied', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', prNumber: 9, branch: 'feat-x' } }),
      codex_home: '/static/global',
    })
    const run = await createRun({ project_slug: 't1' })
    await runToTerminal(h, run.id)
    expect(h.inputs[0]?.codex_home).toBe('/static/global')
  })

  // WAS: "a resolver returning null → codex not connected (null threaded)", which
  // asserted that a null from the resolver SHADOWED a configured static dir. That
  // is the behaviour that took every build on an instance down on 2026-08-13 — a
  // resolver miswired with the wrong lookup key returned null for a connected,
  // materialized credential, and the correct static dir beside it was never
  // consulted. The inner workflow got `CODEX_HOME=''` and `codex-build.sh` exited
  // 10 NOT_CONNECTED before writing a line. The assertion is inverted on purpose:
  // null from the resolver means "no per-run answer", not "no credential".
  test('a resolver returning null falls back to the static codex_home', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', prNumber: 9, branch: 'feat-x' } }),
      codex_home: '/static/global',
      resolve_codex_home: () => null,
    })
    const run = await createRun({ project_slug: 't1' })
    await runToTerminal(h, run.id)
    expect(h.inputs[0]?.codex_home).toBe('/static/global')
  })

  test('a null resolver AND no static dir → codex not connected (null threaded)', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', prNumber: 9, branch: 'feat-x' } }),
      resolve_codex_home: () => null,
    })
    const run = await createRun({ project_slug: 't1' })
    await runToTerminal(h, run.id)
    // Genuinely unset — the graceful path stays graceful. Claude-only review, and
    // a build routed to codex stops and says why rather than guessing a dir.
    expect(h.inputs[0]?.codex_home).toBeNull()
  })

  // THE DEFECT ITSELF (2026-08-13, run `03242fe5`). The credential is stored
  // against the INSTANCE OWNER; a run's `project_slug` is the PROJECT it belongs
  // to. Every prior test in this describe used `t1` for both, so the two were
  // indistinguishable and the miswiring was invisible. Here they differ, which is
  // the whole point: the resolver must be asked by OWNER handle, with the run's
  // project as the override key.
  test('the run project slug is NOT the owner handle — both reach the resolver, in order', async () => {
    const OWNER = 'owner-handle'
    const calls: Array<{ owner: string; project: string | undefined }> = []
    // Stands in for `CodexCredentialService.resolveActiveCodexHome`: a global
    // credential under OWNER, no per-project override.
    const resolveActiveCodexHome = (owner: string, project?: string): string | null => {
      calls.push({ owner, project })
      return owner === OWNER ? '/materialized/global' : null
    }
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', prNumber: 9, branch: 'feat-x' } }),
      resolve_codex_home: (run) => resolveActiveCodexHome(OWNER, run.project_slug),
    })
    const run = await createRun({ project_slug: 'some-project' })
    await runToTerminal(h, run.id)
    expect(calls[0]).toEqual({ owner: OWNER, project: 'some-project' })
    expect(h.inputs[0]?.codex_home).toBe('/materialized/global')
  })
})

describe('orchestrator — RB2 (b) reflection-context threading to build agents', () => {
  test('threads the resolved reflection block into the launching run input', async () => {
    const seen: string[] = []
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', prNumber: 9, branch: 'feat-x' } }),
      resolve_reflection_context: (run) => {
        seen.push(run.project_slug)
        return '<learned_corrections>\n- never force-push to main\n</learned_corrections>'
      },
    })
    const run = await createRun({ project_slug: 't1' })
    await runToTerminal(h, run.id)
    // The resolver was called with the launching run, and its block was threaded to
    // the inner workflow so the Forge builder (not the argus review gate) re-grounds
    // on owner corrections.
    expect(seen).toContain('t1')
    expect(h.inputs[0]?.reflection_context).toContain('never force-push to main')
  })

  test('threads null when no reflection resolver is wired (clean no-op)', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', prNumber: 9, branch: 'feat-x' } }),
    })
    const run = await createRun({ project_slug: 't1' })
    await runToTerminal(h, run.id)
    expect(h.inputs[0]?.reflection_context ?? null).toBeNull()
  })

  test('a THROWING reflection resolver degrades to null and still launches (Codex r4 [P1])', async () => {
    // A reflection-store read failure must NEVER strand a build: the resolver is
    // best-effort, so a throw degrades to no corrections context and the workflow
    // still fires (the run is NOT left stuck non-terminal, retrying every tick).
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', prNumber: 9, branch: 'feat-x' } }),
      resolve_reflection_context: () => {
        throw new Error('reflection store read boom')
      },
    })
    const run = await createRun({ project_slug: 't1' })
    await runToTerminal(h, run.id)
    // The workflow was fired (an input was captured) with a null reflection context.
    expect(h.inputs).toHaveLength(1)
    expect(h.inputs[0]?.reflection_context ?? null).toBeNull()
  })
})

describe('orchestrator — TEST EXECUTION strategy composition at fire time', () => {
  /** A repo that declares a test script whose runner text names the parallel knob. */
  function knobRepo(): string {
    const repo = join(tmp, 'knob-repo')
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ scripts: { test: 'bash scripts/run-tests.sh' } }),
    )
    writeFileSync(
      join(repo, 'scripts', 'run-tests.sh'),
      '#!/usr/bin/env bash\nJOBS="${NEUTRON_TEST_JOBS:-1}"\n',
    )
    return repo
  }

  const approve = () => ({ result: { verdict: 'APPROVE' as const, prNumber: 9, branch: 'feat-x' } })

  test('composes the block from the run’s OWN repo and threads it to the firer', async () => {
    const h = buildHarness({ plan: approve, resolve_active_runs: () => 2 })
    const run = await createRun({ repo_path: knobRepo() })
    await runToTerminal(h, run.id)
    const strategy = h.inputs[0]?.test_strategy
    expect(typeof strategy).toBe('string')
    expect(strategy).toContain('TEST EXECUTION')
    // The knob is asked for — the whole point of the card. The NUMBER is deliberately
    // not asserted: it depends on this box's live cores/RAM, and the arithmetic is
    // already pinned against fixed inputs in test-strategy.test.ts.
    expect(strategy).toContain('NEUTRON_TEST_JOBS=')
  })

  test('threads the detail intermediate block to the firer verbatim', async () => {
    const marker = 'task-2-intermediate-thread-marker'
    const activeRuns = 1_000_000
    const repo = knobRepo()
    const h = buildHarness({
      plan: approve,
      resolve_active_runs: () => activeRuns,
      base_branch: marker,
    })
    const run = await createRun({ repo_path: repo })
    await runToTerminal(h, run.id)

    // A very high active-run count fixes jobs at 1, so the expected rendered bytes
    // remain stable even if MemAvailable moves between these two budget reads.
    const budget = readHostBudget()
    const detail = buildTestStrategyDetail(repo, {
      cores: budget.cores,
      active_runs: activeRuns,
      mem_available_bytes: budget.mem_available_bytes,
      base_branch: marker,
    })
    expect(detail.intermediate_block).toContain(marker)
    expect(h.inputs[0]?.test_strategy_intermediate).toBe(detail.intermediate_block)
  })

  test('a THROWING resolve_active_runs still launches, with a strategy (degrades to 1 run)', async () => {
    // Same never-fails contract as the reflection resolve: a budget that cannot be
    // computed is a sequential build, never a stuck run.
    const h = buildHarness({
      plan: approve,
      resolve_active_runs: () => {
        throw new Error('store read boom')
      },
    })
    const run = await createRun({ repo_path: knobRepo() })
    const terminal = await runToTerminal(h, run.id)
    expect(terminal.phase).toBe('done')
    expect(h.inputs).toHaveLength(1)
    expect(h.inputs[0]?.test_strategy).toContain('TEST EXECUTION')
  })

  test('no resolver at all → still a strategy (an idle box is the safe assumption)', async () => {
    const h = buildHarness({ plan: approve })
    const run = await createRun({ repo_path: knobRepo() })
    await runToTerminal(h, run.id)
    expect(h.inputs[0]?.test_strategy).toContain('TEST EXECUTION')
  })

  test('a repo that documents nothing still gets a usable block, never a failed launch', async () => {
    const h = buildHarness({ plan: approve })
    const run = await createRun({ repo_path: join(tmp, 'no-such-repo-9182') })
    const terminal = await runToTerminal(h, run.id)
    expect(terminal.phase).toBe('done')
    expect(h.inputs[0]?.test_strategy).toContain('TEST EXECUTION')
  })
})

describe('orchestrator — terminal-but-garbled harvest guard (Bug 2)', () => {
  test('subagent_status=completed with a NULL inner_result → failed (not stuck at forge-init)', async () => {
    // The inner workflow marked completed but its inner_result is null (the
    // readfile() yielded nothing at UPDATE time). parseInnerResult is null so the
    // normal harvest can't fire; the hang watchdog is DEFEATED because the
    // completed-write re-stamped last_advanced_at (fresh here). The gate must
    // still drive the run terminal.
    let t = 0
    const h = buildHarness({ plan: () => ({ result: null }), now: () => new Date(t).toISOString() })
    const run = await createRun({ merge_mode: 'local' as MergeMode })
    // Simulate the inner workflow's terminal write, but with a null result.
    await store.update(run.id, { subagent_run_id: 'wf-done', subagent_status: 'completed', inner_result: null })
    t = 1_000 // move the clock forward, but NOT past any hang threshold

    await h.loop.runOnce()
    const after = store.get(run.id)
    expect(after?.phase).toBe('failed')
    expect(after?.inner_verdict).toBe('REVIEW_NOT_RUN')
    expect(after?.failure_reason).toContain('terminal result missing/garbled')
    // Never re-fired, never merged.
    expect(h.inputs).toHaveLength(0)
    expect(h.hostCalls.some((c) => c.join(' ').startsWith('git -C /repo merge'))).toBe(false)
  })

  test('subagent_status=completed with a GARBLED inner_result → failed', async () => {
    let t = 0
    const h = buildHarness({ plan: () => ({ result: null }), now: () => new Date(t).toISOString() })
    const run = await createRun({ merge_mode: 'local' as MergeMode })
    await store.update(run.id, {
      subagent_run_id: 'wf-done',
      subagent_status: 'completed',
      inner_result: '{"ok":true,"verdict":"APPRO', // truncated → unparseable
    })
    t = 1_000

    await h.loop.runOnce()
    const after = store.get(run.id)
    expect(after?.phase).toBe('failed')
    expect(after?.inner_verdict).toBe('REVIEW_NOT_RUN')
    expect(after?.failure_reason).toContain('terminal result missing/garbled')
  })

  test('a still-running inflight (subagent_status=running, null result) is NOT reaped by the gate', async () => {
    // Guard: the gate only fires on a TERMINAL subagent_status. A healthy in-flight
    // run (running, no result yet, fresh timestamp) must stay waiting.
    let t = 0
    const h = buildHarness({ plan: () => ({ result: null }), now: () => new Date(t).toISOString() })
    const run = await createRun({ merge_mode: 'local' as MergeMode })
    await store.update(run.id, { subagent_run_id: 'wf-live', subagent_status: 'running', inner_result: null })
    t = 1_000

    await h.loop.runOnce()
    expect(store.get(run.id)?.phase).not.toBe('failed')
  })
})

describe('orchestrator — RC2 nexus producer over the REAL post-commit on_terminal seam', () => {
  // Drives a committed terminal transition through the tick loop's `on_terminal`
  // hook (the SAME seam build-core-modules wires the composer's `on_run_terminal`
  // into), with the RC2 producer wired exactly as the composer wires it. Proves
  // the post-commit path actually persists project-scoped events — and would fail
  // if the producer were unwired from `on_terminal`.
  let nexusHome: string
  let nexus: NexusStore
  beforeEach(() => {
    nexusHome = mkdtempSync(join(tmpdir(), 'neutron-orch-nexus-'))
    nexus = new NexusStore({ owner_home: nexusHome })
  })
  afterEach(() => {
    nexus.closeAll()
    rmSync(nexusHome, { recursive: true, force: true })
  })

  const nexusOnTerminal = (store: NexusStore): TridentTerminalHook => ({
    onTerminal: async (run): Promise<void> => {
      await emitTridentTerminalEvents(store, run, {
        harvested: isTridentHarvestTerminal(run),
      })
    },
  })

  async function waitForEvents(project_id: string, atLeast: number) {
    for (let i = 0; i < 200; i++) {
      const rows = await nexus.readRecent(project_id, { limit: 100 })
      if (rows.length >= atLeast) return rows
      await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error(`timed out waiting for ${atLeast} nexus event(s)`)
  }

  test('a committed APPROVE harvest fires the post-commit hook → handoff + argus decision persist, scoped to the project', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', prNumber: 42, branch: 'feat-x' } }),
      on_terminal: nexusOnTerminal(nexus),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')

    const rows = await waitForEvents('t1', 2)
    const byKind = new Map(rows.map((e) => [e.kind, e]))
    expect(byKind.get('handoff')?.actor_kind).toBe('orchestrator')
    expect(byKind.get('decision')?.actor_kind).toBe('argus')
    expect(byKind.get('decision')?.body).toContain('APPROVE')
    expect(byKind.get('decision')?.refs_json).toContain('#42')
    // Scoped: another project sees nothing.
    expect(await nexus.readRecent('other', { limit: 100 })).toEqual([])
  })

  test('flag-off analog: no producer wired → the run still terminates, nothing persisted', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', prNumber: 42, branch: 'feat-x' } }),
      // No on_terminal — mirrors the composer passing no nexus observer (flag off).
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    expect((await runToTerminal(h, run.id)).phase).toBe('done')
    expect(await nexus.readRecent('t1', { limit: 100 })).toEqual([])
  })

  test('a hang-reaped run (no harvest) fires the hook but persists NOTHING (no false handoff/decision)', async () => {
    // A run that never harvests (stalls) → reaped to failed with REVIEW_NOT_RUN.
    // The post-commit hook fires, but the harvest gate still emits nothing.
    let t = 0
    const h = buildHarness({
      plan: () => ({ result: null }),
      now: () => new Date(t).toISOString(),
      no_advance_hang_ms: 1_000,
      on_terminal: nexusOnTerminal(nexus),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    await h.loop.runOnce() // launch (fires the workflow, no result)
    await h.complete()
    t = 10_000 // advance past the hang threshold
    await h.loop.runOnce() // reaped → failed → on_terminal fires
    const final = store.get(run.id)
    expect(final?.phase).toBe('failed')
    expect(final?.inner_verdict).toBe('REVIEW_NOT_RUN')
    await new Promise((r) => setTimeout(r, 20))
    expect(await nexus.readRecent('t1', { limit: 100 })).toEqual([])
  })
})

describe('isTridentHarvestTerminal — the durable outer-harvest marker (harvested_at)', () => {
  const valid = JSON.stringify({
    ok: true,
    verdict: 'APPROVE',
    pr_number: 1,
    branch: 'feat-x',
    round: 1,
    checkpoint: 'argus-approved',
  })

  test('harvested_at set → true (a genuine outer-loop harvest)', async () => {
    const base = await createRun()
    expect(isTridentHarvestTerminal({ ...base, phase: 'done', harvested_at: 123 })).toBe(true)
    expect(isTridentHarvestTerminal({ ...base, phase: 'failed', harvested_at: 456 })).toBe(true)
  })

  test('harvested_at NULL → false — even with a parseable inner_result + an inner-written verdict', async () => {
    // The force-terminate / cancel / stopped case: the DETACHED inner workflow
    // wrote a result + verdict, the outer loop never harvested (harvested_at
    // stays null), and `terminalTransition` flipped the phase.
    const base = await createRun()
    expect(
      isTridentHarvestTerminal({
        ...base,
        phase: 'failed',
        inner_result: valid,
        inner_verdict: 'APPROVE',
        inner_checkpoint: 'argus-approved',
        harvested_at: null,
      }),
    ).toBe(false)
    expect(
      isTridentHarvestTerminal({ ...base, phase: 'stopped', inner_result: valid, harvested_at: null }),
    ).toBe(false)
  })
})

describe('applyResult stamps harvested_at (the outer loop is the ONLY writer)', () => {
  test('a genuine APPROVE harvest commits harvested_at; a force-terminate leaves it null', async () => {
    // APPROVE→done through the real orchestrator: harvested_at is stamped.
    const h = buildHarness({ plan: () => ({ result: { verdict: 'APPROVE', prNumber: 9, branch: 'feat-x' } }) })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    const done = await runToTerminal(h, run.id)
    expect(done.phase).toBe('done')
    expect(done.harvested_at).not.toBeNull()
    expect(isTridentHarvestTerminal(done)).toBe(true)

    // A LIVE run force-terminated out-of-band (a board X-cancel / stop) — inner
    // wrote a stale result + verdict, but the outer loop never harvested.
    const live = await createRun({ slug: 'other-thing', merge_mode: 'pr' as MergeMode })
    await store.update(live.id, {
      subagent_run_id: 'wf-live',
      subagent_status: 'running',
      inner_result: JSON.stringify({ ok: true, verdict: 'APPROVE', round: 1, checkpoint: 'argus-approved' }),
      inner_verdict: 'APPROVE',
      inner_checkpoint: 'argus-approved',
    })
    const { run: terminated, won } = await store.terminalTransition(live.id, {
      phase: 'failed',
      failure_reason: 'cancelled by owner',
    })
    expect(won).toBe(true)
    expect(terminated?.phase).toBe('failed')
    expect(terminated?.harvested_at).toBeNull() // terminalTransition never sets it
    expect(isTridentHarvestTerminal(terminated!)).toBe(false)
  })
})

/**
 * A GIT FACT IS READ BY CODE, NEVER RELAYED BY A MODEL (Part 2a of the "git truth
 * comes from git" card).
 *
 * The live head a resume decision turns on used to come from a haiku PROBE AGENT
 * inside the workflow; when that read failed, `classifyResume` called it
 * `head-unreadable` and REBUILT already-committed work (measured: 3,813 → 84,875 →
 * 133,169 cumulative output tokens on the neutron-enterprise #439 run). The launcher
 * is the credentialed host boundary and already runs every other git command for the
 * run, so it reads the head itself and threads the answer in.
 */
describe('orchestrator — the resume live head is read in code, never relayed by a model', () => {
  const HEAD = 'a'.repeat(40)

  /** Fire ONE launch and stop, so the only host calls are the launch's own. */
  async function launchOnce(h: Harness): Promise<void> {
    await h.loop.runOnce()
    await h.complete()
  }

  /** A run orphaned mid-flight with a checkpoint + recorded OID → a resume launch.
   *  Each call gets its own slug: `(project_slug, slug)` is unique among live runs. */
  let seq = 0
  async function resumeRun(
    over: Partial<Parameters<TridentRunStore['update']>[1]> = {},
    merge_mode: MergeMode = 'pr' as MergeMode,
  ): Promise<TridentRun> {
    seq += 1
    const run = await createRun({ merge_mode, slug: `add-thing-${seq}` })
    await store.update(run.id, {
      subagent_run_id: 'stale-id-from-prior-process',
      subagent_status: 'running',
      pr: 42,
      inner_checkpoint: 'forge-done',
      inner_checkpoint_head: HEAD,
      ...over,
    })
    return run
  }

  test('a pr-mode resume reads the branch head with ls-remote and threads the OID', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      hostResponder: (cmd) =>
        cmd.join(' ').includes('ls-remote --heads origin refs/heads/feat-x')
          ? ok(`${HEAD}\trefs/heads/feat-x\n`)
          : ok(),
    })
    await resumeRun()
    await launchOnce(h)

    expect(h.hostCalls).toContainEqual([
      'git',
      '-C',
      '/repo',
      'ls-remote',
      '--heads',
      'origin',
      'refs/heads/feat-x',
    ])
    expect(h.inputs).toHaveLength(1)
    expect(h.inputs[0]!.resume_live_head).toBe(HEAD)
  })

  test('a transient read failure is retried, and three failures mean "could not read" — not "gone"', async () => {
    let reads = 0
    const flaky = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      hostResponder: (cmd) => {
        if (!cmd.join(' ').includes('ls-remote --heads origin refs/heads/feat-x')) return ok()
        reads += 1
        return reads <= 2
          ? { ok: false, stdout: '', stderr: 'fatal: could not read from remote', exit_code: 128 }
          : ok(`${HEAD}\trefs/heads/feat-x\n`)
      },
    })
    await resumeRun()
    await launchOnce(flaky)
    expect(flaky.inputs[0]!.resume_live_head).toBe(HEAD)
    expect(reads).toBe(3)
  })

  // A read that never succeeds is bounded at 3 attempts and reports '' — reserved
  // exclusively for "could not tell", never for "the branch is not there". PART 2b:
  // and '' at THIS boundary ends the run here, because the fire it would pay for has
  // exactly one outcome (`classifyResume` → the bounded stop). The checkpoint columns
  // are left untouched so a re-run after the read recovers resumes at this point.
  test('a read that never succeeds stops the run at the boundary — no fire, checkpoint preserved', async () => {
    let dead = 0
    const broken = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      hostResponder: (cmd) => {
        if (!cmd.join(' ').includes('ls-remote --heads origin refs/heads/feat-x')) return ok()
        dead += 1
        return { ok: false, stdout: '', stderr: 'fatal: could not read from remote', exit_code: 128 }
      },
    })
    const run = await resumeRun()
    await launchOnce(broken)

    expect(dead).toBe(3)
    expect(broken.inputs).toHaveLength(0)

    const final = store.get(run.id)!
    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('review never ran (infra-only)')
    expect(final.failure_reason).toContain('could not read the head of feat-x')
    expect(final.failure_reason).toContain(HEAD)
    expect(final.failure_reason).toContain('re-run when the read succeeds')
    // Argus never ran; the reason for this class must never claim it did.
    expect(final.failure_reason).not.toContain('without Argus APPROVE')
    expect(final.inner_checkpoint).toBe('forge-done')
    expect(final.inner_checkpoint_head).toBe(HEAD)
  })

  // `classifyResume` resolves a 'pr-merged' checkpoint to `merged` BEFORE it looks at
  // the head, so the fast-exit must not steal that run: it fires and the inner loop
  // finishes the merge.
  test("a 'pr-merged' checkpoint is exempt — the fire still happens on an unreadable head", async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      hostResponder: (cmd) =>
        cmd.join(' ').includes('ls-remote --heads origin refs/heads/feat-x')
          ? { ok: false, stdout: '', stderr: 'fatal: could not read from remote', exit_code: 128 }
          : ok(),
    })
    await resumeRun({ inner_checkpoint: 'pr-merged' })
    await launchOnce(h)
    expect(h.inputs).toHaveLength(1)
    expect(h.inputs[0]!.resume_live_head).toBe('')
  })

  // …and so is an EMPTY checkpoint name: `classifyResume` resolves that to `rebuild`
  // (reason 'no-checkpoint') before it looks at the head, so there is no recorded work
  // to preserve and nothing for the bounded stop to name.
  test('an EMPTY checkpoint name is exempt too — no fast-exit, the fire still happens', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      hostResponder: (cmd) =>
        cmd.join(' ').includes('ls-remote --heads origin refs/heads/feat-x')
          ? { ok: false, stdout: '', stderr: 'fatal: could not read from remote', exit_code: 128 }
          : ok(),
    })
    await resumeRun({ inner_checkpoint: '' })
    await launchOnce(h)
    expect(h.inputs).toHaveLength(1)
    expect(h.inputs[0]!.resume_live_head).toBe('')
  })

  // Local mode reaches '' by a different route (a failed rev-parse under an UNHEALTHY
  // git); it takes the same exit.
  test('a local-mode unreadable head takes the same boundary exit — no fire', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (
          joined.includes('rev-parse --verify refs/heads/feat-x^{commit}') ||
          joined.includes('rev-parse --git-dir')
        ) {
          return { ok: false, stdout: '', stderr: 'fatal: not a git repository', exit_code: 128 }
        }
        return ok()
      },
    })
    const run = await resumeRun({}, 'local' as MergeMode)
    await launchOnce(h)

    expect(h.inputs).toHaveLength(0)
    const final = store.get(run.id)!
    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('review never ran (infra-only)')
    expect(final.failure_reason).toContain('could not read the head of feat-x')
    expect(final.failure_reason).toContain(HEAD)
    expect(final.failure_reason).not.toContain('without Argus APPROVE')
    expect(final.inner_checkpoint).toBe('forge-done')
    expect(final.inner_checkpoint_head).toBe(HEAD)
  })

  /**
   * THE EXIT MUST NOT PRE-EMPT A DECISION THE HEAD NEVER PARTICIPATES IN (Argus r5).
   * `classifyResume` rebuilds on EVERY head — matching, moved, absent or unreadable —
   * for a ralph `forge-done` and for any name it does not recognise, `ralph-task-built`
   * above all. Exiting terminally on those turns a rebuild that was going to happen
   * anyway into a dead run, so one transient `ls-remote` blip would kill every
   * resuming ralph re-fire. `resumeHeadDecides` is the shared mirror;
   * `inner-workflow-resume.test.ts` pins it against the `.mjs` decision itself.
   */
  const unreadable = (): Harness =>
    buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      hostResponder: (cmd) =>
        cmd.join(' ').includes('ls-remote --heads origin refs/heads/feat-x')
          ? { ok: false, stdout: '', stderr: 'fatal: could not read from remote', exit_code: 128 }
          : ok(),
    })

  test.each(['ralph-task-built', 'ralph-task-built-deviated'] as const)(
    "a deferred '%s' re-fire reads the local branch tip and never asks stale origin",
    async (checkpoint) => {
      const localHead = 'b'.repeat(40)
      const staleRemoteHead = 'c'.repeat(40)
      const h = buildHarness({
        plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
        hostResponder: (cmd) => {
          const joined = cmd.join(' ')
          if (joined.includes('rev-parse --verify refs/heads/feat-x^{commit}')) return ok(localHead)
          if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) {
            return ok(`${staleRemoteHead}\trefs/heads/feat-x\n`)
          }
          return ok()
        },
      })
      seq += 1
      const run = await createRun({
        merge_mode: 'pr' as MergeMode,
        slug: `deferred-refire-${seq}`,
        ralph: true,
      })
      await store.update(run.id, {
        subagent_run_id: 'stale-id-from-prior-process',
        subagent_status: 'running',
        pr: 42,
        ralph_round: 1,
        inner_checkpoint: checkpoint,
        inner_checkpoint_head: localHead,
      })

      await launchOnce(h)

      expect(h.hostCalls).toContainEqual([
        'git',
        '-C',
        '/repo',
        'rev-parse',
        '--verify',
        'refs/heads/feat-x^{commit}',
      ])
      expect(
        h.hostCalls.some((cmd) =>
          cmd.join(' ').includes('ls-remote --heads origin refs/heads/feat-x'),
        ),
      ).toBe(false)
      expect(h.inputs).toHaveLength(1)
      expect(h.inputs[0]!.resume_live_head).toBe(localHead)
      expect(store.get(run.id)!.phase).not.toBe('failed')
    },
  )

  test("a RALPH 'forge-done' is exempt too — its rebuild does not depend on the head", async () => {
    const h = unreadable()
    const run = await createRun({ merge_mode: 'pr' as MergeMode, slug: 'ralph-resume', ralph: true })
    await store.update(run.id, {
      subagent_run_id: 'stale-id-from-prior-process',
      subagent_status: 'running',
      pr: 42,
      inner_checkpoint: 'forge-done',
      inner_checkpoint_head: HEAD,
    })
    await launchOnce(h)
    expect(h.inputs).toHaveLength(1)
    expect(store.get(run.id)!.phase).not.toBe('failed')
  })

  // NEGATIVE CONTROL for the pair above: the same 'forge-done' checkpoint on a
  // NON-ralph run still takes the bounded exit, or the exemption would have deleted
  // the stop rather than narrowed it.
  test("a non-ralph 'forge-done' still stops — the exemption is narrow, not a repeal", async () => {
    const h = unreadable()
    const run = await resumeRun()
    await launchOnce(h)
    expect(h.inputs).toHaveLength(0)
    expect(store.get(run.id)!.phase).toBe('failed')
  })

  /**
   * THE TERMINAL RECORD POINTS AT THE WORK (Argus r5). "Re-run when the read succeeds"
   * is advice a human follows by opening the PR the recorded commit is on — and this
   * exit used to run BEFORE `detectExistingPr`, so a run whose row had not yet learned
   * its PR number was filed with `pr: null` and no link to the branch it is naming.
   */
  test('the bounded exit still records the PR it detected', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) {
          return { ok: false, stdout: '', stderr: 'fatal: could not read from remote', exit_code: 128 }
        }
        if (joined.includes('gh pr list')) return ok('77\n')
        return ok()
      },
    })
    const run = await resumeRun({ pr: null })
    await launchOnce(h)

    expect(h.inputs).toHaveLength(0)
    const final = store.get(run.id)!
    expect(final.phase).toBe('failed')
    expect(final.pr).toBe(77)
    expect(final.failure_reason).toContain('could not read the head of feat-x')
  })

  test("an OK read with no output is the remote SAYING the branch is gone → 'absent'", async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      hostResponder: (cmd) =>
        cmd.join(' ').includes('ls-remote --heads origin refs/heads/feat-x') ? ok('') : ok(),
    })
    await resumeRun()
    await launchOnce(h)
    expect(h.inputs[0]!.resume_live_head).toBe('absent')
  })

  test('the recorded OID may come from the outer-published checkpoint name alone', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      hostResponder: (cmd) =>
        cmd.join(' ').includes('ls-remote --heads origin refs/heads/feat-x')
          ? ok(`${HEAD}\trefs/heads/feat-x\n`)
          : ok(),
    })
    await resumeRun({ inner_checkpoint: `outer-published:${HEAD}:0:1`, inner_checkpoint_head: null })
    await launchOnce(h)
    expect(h.inputs[0]!.resume_live_head).toBe(HEAD)
  })

  test('a FRESH board-shaped pr launch fetches and pins origin/main before firing', async () => {
    const HEAD = 'a'.repeat(40)
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (joined.includes('rev-parse --verify refs/remotes/origin/main^{commit}')) return ok(HEAD.toUpperCase())
        if (joined.includes('rev-list --count refs/heads/main..refs/remotes/origin/main')) return ok('16')
        return ok()
      },
    })
    await createRun({ merge_mode: 'pr' as MergeMode, branch: 'trident/add-thing' })
    await launchOnce(h)

    expect(h.inputs).toHaveLength(1)
    expect('resume_live_head' in h.inputs[0]!).toBe(false)
    expect(h.inputs[0]!.base_sha).toBe(HEAD)
    expect(store.listNonTerminal()[0]?.base_sha).toBe(HEAD)
    expect(store.listNonTerminal()[0]?.base_behind).toBe(16)
    const calls = h.hostCalls.map((c) => c.join(' '))
    expect(calls.some((c) => c.includes('ls-remote --heads origin refs/heads/feat-x'))).toBe(false)
    // THE DESTINATION REF IS NAMED, not left to `remote.origin.fetch` (Argus finding,
    // reproduced on git 2.43): with a narrowed configured refspec, `fetch --no-tags origin main`
    // exits 0, moves FETCH_HEAD, and leaves refs/remotes/origin/main exactly where it was — the
    // ref this very test then rev-parses for `base_sha` and pins the build to.
    const BASE_REFSPEC = 'fetch --no-tags --no-recurse-submodules origin +refs/heads/main:refs/remotes/origin/main'
    expect(calls.some((c) => c.includes(BASE_REFSPEC))).toBe(true)
    expect(calls.findIndex((c) => c.includes(BASE_REFSPEC)))
      .toBeLessThan(calls.findIndex((c) => c.includes('rev-parse --verify refs/remotes/origin/main')))
    expect(calls.some((c) => c.includes('rev-parse --verify --quiet refs/heads/trident/add-thing'))).toBe(true)
  })

  test("a fresh launch refuses another lane's local branch without firing", async () => {
    const BASE = 'b'.repeat(40)
    const TIP = 'c'.repeat(40)
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'trident/add-thing' } }),
      local_branch_tip: TIP,
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (joined.includes('rev-parse --verify refs/remotes/origin/main^{commit}')) return ok(BASE)
        if (joined.includes(`merge-base --is-ancestor ${TIP} ${BASE}`)) {
          return { ok: false, stdout: '', stderr: '', exit_code: 1 }
        }
        if (joined.includes(`rev-list --count ${BASE}..${TIP}`)) return ok('3')
        // The remedy resolves its own evidence: git enumerates the repo's own checkout and
        // NOTHING holds the branch, and origin carries the very same tip — the one shape where
        // a delete is genuinely safe. The listing is spelled in git's real `-z` shape (every
        // attribute NUL-terminated, an empty attribute closing the record) and really does
        // name the shared checkout: an EMPTY listing is a thing real git never produces, and
        // the guard now reads that silence as UNKNOWN rather than as "nobody holds it", so a
        // positive control resting on it would be a control for an impossible world.
        if (joined.includes('worktree list --porcelain')) {
          return ok(['worktree /repo', `HEAD ${BASE}`, 'branch refs/heads/main'].map((f) => `${f}\0`).join('') + '\0')
        }
        if (joined.includes('rev-parse --verify --quiet refs/remotes/origin/trident/add-thing')) {
          return ok(TIP)
        }
        return ok()
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode, branch: 'trident/add-thing' })
    await launchOnce(h)

    expect(h.inputs).toHaveLength(0)
    const final = store.get(run.id)!
    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('already carries 3 commit(s) not on origin/')
    expect(final.failure_reason).toContain("refusing to build on another lane's work")
    expect(final.failure_reason).toContain('branch -D')
    expect(final.failure_reason).toContain('branch -D -- trident/add-thing')
    // The printed remedy re-establishes BOTH perishable premises at the moment it runs — the
    // local ref is still the evidenced sha, and origin still carries it — before it deletes.
    expect(final.failure_reason).toContain('fetch --no-tags --no-recurse-submodules origin +refs/heads/trident/add-thing')
    expect(final.failure_reason).toContain(`merge-base --is-ancestor ${TIP} refs/remotes/origin/trident/add-thing`)
    // The delete git RE-CHECKS, never a low-level ref delete: this reason is read minutes to
    // hours after it is composed, and `update-ref -d` would blow past the
    // checked-out-elsewhere refusal that is the only thing protecting a lane that took the
    // branch in between.
    expect(final.failure_reason).not.toContain('update-ref -d')
    expect(final.failure_reason).toContain(TIP)
  })

  test('a SHALLOW checkout cannot turn a true ancestor into a proven divergence', async () => {
    // THE BLOCKER. `merge-base --is-ancestor B C` exits 1 past a shallow boundary for a B that
    // IS an ancestor of C — the parent commits simply are not in the object store (reproduced on
    // git 2.43 with a depth-1 clone and a true parent). This checkout may arrive shallow:
    // `healShallowCheckout` documents that shape in production and runs only on the REPLAY path,
    // never before this guard. Reading exit 1 as divergence therefore printed "already carries N
    // commit(s) not on origin/main — it was not cut from origin/main", a positive claim about
    // another lane's work that nothing established, in the one message class this change exists
    // to make evidence-honest. Shallow => UNKNOWN, and UNKNOWN authorises nothing.
    const BASE = 'b'.repeat(40)
    const TIP = 'c'.repeat(40)
    const scenario = (depth: HostCommandResult) =>
      buildHarness({
        plan: () => ({ result: { verdict: 'APPROVE', branch: 'trident/add-thing' } }),
        local_branch_tip: TIP,
        hostResponder: (cmd) => {
          const joined = cmd.join(' ')
          if (joined.includes('rev-parse --is-shallow-repository')) return depth
          if (joined.includes('rev-parse --verify refs/remotes/origin/main^{commit}')) return ok(BASE)
          if (joined.includes(`merge-base --is-ancestor ${TIP} ${BASE}`)) {
            return { ok: false, stdout: '', stderr: '', exit_code: 1 }
          }
          if (joined.includes(`rev-list --count ${BASE}..${TIP}`)) return ok('3')
          if (joined.includes('worktree list --porcelain')) {
            return ok(['worktree /repo', `HEAD ${BASE}`, 'branch refs/heads/main'].map((f) => `${f}\0`).join('') + '\0')
          }
          if (joined.includes('rev-parse --verify --quiet refs/remotes/origin/trident/add-thing')) return ok(TIP)
          return ok()
        },
      })

    const shallow = scenario(ok('true'))
    const run = await createRun({ merge_mode: 'pr' as MergeMode, branch: 'trident/add-thing' })
    await launchOnce(shallow)
    const reason = store.get(run.id)?.failure_reason ?? ''
    // Still REFUSED — fail-closed, nothing fired. Only the CLAIM changes.
    expect(shallow.inputs).toHaveLength(0)
    expect(store.get(run.id)?.phase).toBe('failed')
    expect(reason).toContain('UNKNOWN')
    expect(reason).toContain('SHALLOW')
    // The claim the shallow boundary did not license is gone...
    expect(reason).not.toContain('already carries')
    expect(reason).not.toContain('it was not cut from')
    // ...and so is every destructive instruction (docs/INVARIANTS.md §12 invariant 122).
    expect(reason).not.toContain('branch -D')
    // The reader is told the read that settles it, rather than being left with "exited 1".
    expect(reason).toContain('--unshallow')

    // AN UNREADABLE DEPTH IS UNKNOWN TOO — fail-closed in the same direction, and it says so
    // rather than borrowing the shallow wording it did not measure.
    const blind = scenario({ ok: false, stdout: '', stderr: 'fatal: not a repository', exit_code: 128 })
    const run2 = await createRun({ merge_mode: 'pr' as MergeMode, branch: 'trident/add-thing' })
    await launchOnce(blind)
    const reason2 = store.get(run2.id)?.failure_reason ?? ''
    expect(blind.inputs).toHaveLength(0)
    expect(reason2).toContain('UNKNOWN')
    expect(reason2).toContain('the depth of this checkout could not be read')
    expect(reason2).not.toContain('already carries')
    expect(reason2).not.toContain('branch -D')

    // POSITIVE CONTROL: the identical exit 1 in a checkout PROVEN complete is still the
    // wrong-base refusal, remedy and all. Without this, "shallow => UNKNOWN" could be satisfied
    // by an implementation that stopped answering "no" at all and never refused a real
    // wrong-base branch again.
    const complete = scenario(ok('false'))
    const run3 = await createRun({ merge_mode: 'pr' as MergeMode, branch: 'trident/add-thing' })
    await launchOnce(complete)
    const reason3 = store.get(run3.id)?.failure_reason ?? ''
    expect(complete.inputs).toHaveLength(0)
    expect(reason3).toContain('already carries 3 commit(s) not on origin/')
    expect(reason3).toContain('branch -D -- trident/add-thing')

    // AND THE STEP SURVIVES DELIVERY (Argus blocker). Everything above asserts the PERSISTED
    // reason, which nobody reads: `composeTerminalDelivery` renders `summary` + `input_needed`
    // and drops the reason entirely. Both depth refusals match the pre-launch prefix and carry
    // the not-started clause, so both used to flatten to "Reply to retry the build" — and a
    // retry re-runs the identical probe over the identical truncated history and re-refuses,
    // deterministically, because nothing on the launch path deepens the checkout
    // (`healShallowCheckout` runs only on the replay path). The one step that breaks that loop
    // has to reach the person being told to act.
    const delivered = (r: string): string => composeTerminalDelivery(store.get(r)!)?.text ?? ''
    for (const [name, id] of [
      ['shallow', run.id],
      ['unreadable depth', run2.id],
    ] as const) {
      const text = delivered(id)
      expect(`${name}: ${text}`).toContain('--unshallow')
      expect(`${name}: ${text}`).toContain('did not start this build')
      // The retry is still offered — it is just no longer the FIRST thing, and it is no longer
      // the ONLY thing.
      expect(`${name}: ${text}`).toContain('retry')
      // UNKNOWN authorises nothing irreversible, in the delivered text as in the reason.
      expect(`${name}: ${text}`).not.toContain('branch -D')
    }
    // POSITIVE CONTROL ON THE DELIVERY TOO: the proven-complete run is a wrong-base refusal, a
    // different class entirely, and must not inherit an unshallow step it has no use for.
    expect(delivered(run3.id)).not.toContain('--unshallow')
  })

  // THE TOCTOU BLOCKER, in three cases. The exit-1 read and the depth read are two separate
  // `git` invocations, and the guard used to pair them: exit 1 first, depth afterwards. A
  // checkout unshallowed BETWEEN them therefore pairs the STALE exit 1 — the one a TRUE ancestor
  // produces past a shallow boundary — with a now-complete depth answer, and the pair reads as
  // proven divergence: the false wrong-base refusal and its safe-delete chain, on a correctly
  // based branch. That race is not hypothetical here, because the refusal's own detail line
  // tells the operator to run `git fetch --unshallow origin` — exactly the event that closes the
  // window. So the "no" is re-established AFTER completeness is proven, and these cases pin the
  // TRANSITION the shallow triple above (all static states) could not reach. Split into three
  // tests because the first case FIRES: a live run keeps its `(project_slug, slug)`, and a
  // second `runOnce` in the same test would re-process it.
  const TOCTOU_BASE = 'b'.repeat(40)
  const TOCTOU_TIP = 'c'.repeat(40)
  /** Every read but `merge-base --is-ancestor`, which each case answers for itself. */
  const toctouResponder =
    (ancestor: () => HostCommandResult) =>
    (cmd: string[]): HostCommandResult => {
      const joined = cmd.join(' ')
      // The depth read lands AFTER the unshallow: this checkout really is complete when asked.
      if (joined.includes('rev-parse --is-shallow-repository')) return ok('false')
      if (joined.includes('rev-parse --verify refs/remotes/origin/main^{commit}')) return ok(TOCTOU_BASE)
      if (joined.includes(`merge-base --is-ancestor ${TOCTOU_TIP} ${TOCTOU_BASE}`)) return ancestor()
      if (joined.includes(`rev-list --count ${TOCTOU_BASE}..${TOCTOU_TIP}`)) return ok('3')
      if (joined.includes('worktree list --porcelain')) {
        return ok(
          ['worktree /repo', `HEAD ${TOCTOU_BASE}`, 'branch refs/heads/main'].map((f) => `${f}\0`).join('') + '\0',
        )
      }
      if (joined.includes('rev-parse --verify --quiet refs/remotes/origin/trident/add-thing')) return ok(TOCTOU_TIP)
      return ok()
    }

  test('an unshallow landing between the two reads cannot become a proven divergence', async () => {
    let reads = 0
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'trident/add-thing' } }),
      local_branch_tip: TOCTOU_TIP,
      hostResponder: toctouResponder(() => {
        reads += 1
        // Read 1: taken while the parent commits were still missing — exit 1 on a TRUE ancestor.
        // Read 2: taken after they arrived, and it finds the link.
        return reads === 1 ? { ok: false, stdout: '', stderr: '', exit_code: 1 } : ok()
      }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode, branch: 'trident/add-thing' })
    await launchOnce(h)

    // The proven-complete read is the one the verdict rests on, so the branch is CONTAINED: the
    // build fires and no refusal is composed at all.
    expect(reads).toBe(2)
    expect(h.inputs).toHaveLength(1)
    const reason = store.get(run.id)?.failure_reason ?? ''
    expect(reason).not.toContain('already carries')
    expect(reason).not.toContain('branch -D')
  })

  test('POSITIVE CONTROL: exit 1 at BOTH reads of a complete checkout is still the wrong-base refusal', async () => {
    // Without this, "re-read before answering no" could be satisfied by an implementation that
    // stopped answering "no" at all and never refused a real wrong-base branch again.
    let reads = 0
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'trident/add-thing' } }),
      local_branch_tip: TOCTOU_TIP,
      hostResponder: toctouResponder(() => {
        reads += 1
        return { ok: false, stdout: '', stderr: '', exit_code: 1 }
      }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode, branch: 'trident/add-thing' })
    await launchOnce(h)
    const reason = store.get(run.id)?.failure_reason ?? ''
    expect(h.inputs).toHaveLength(0)
    expect(reads).toBe(2)
    expect(reason).toContain('already carries 3 commit(s) not on origin/')
    expect(reason).toContain('branch -D -- trident/add-thing')
  })

  // THE REVERSE TRANSITION, which the three cases above could not reach. The re-read they pin
  // was justified by "deepening is one-way — nothing re-truncates a checkout in place", and the
  // depth probe was MEMOISED on that premise: one "complete" answer licensed every later exit 1
  // in the same guard pass. The premise is false. `git fetch --depth=1` truncates a COMPLETE
  // checkout in place (git 2.43: `--is-shallow-repository` flips false → true and `merge-base
  // --is-ancestor` starts exiting 1 on a genuine ancestor), so a truncation landing across the
  // confirming read paired a STALE "complete" with an exit 1 that means nothing — the false
  // wrong-base refusal and its safe-delete chain, on a correctly based branch. The depth probe
  // is no longer memoised and the confirming read is BRACKETED: complete before it AND after it,
  // or the verdict is UNKNOWN.
  /** Like `toctouResponder`, but the depth answer is the case's to control per read. */
  const toctouResponderDepth =
    (ancestor: () => HostCommandResult, depth: () => HostCommandResult) =>
    (cmd: string[]): HostCommandResult => {
      const joined = cmd.join(' ')
      if (joined.includes('rev-parse --is-shallow-repository')) return depth()
      if (joined.includes('rev-parse --verify refs/remotes/origin/main^{commit}')) return ok(TOCTOU_BASE)
      if (joined.includes(`merge-base --is-ancestor ${TOCTOU_TIP} ${TOCTOU_BASE}`)) return ancestor()
      if (joined.includes(`rev-list --count ${TOCTOU_BASE}..${TOCTOU_TIP}`)) return ok('3')
      if (joined.includes('worktree list --porcelain')) {
        return ok(
          ['worktree /repo', `HEAD ${TOCTOU_BASE}`, 'branch refs/heads/main'].map((f) => `${f}\0`).join('') + '\0',
        )
      }
      if (joined.includes('rev-parse --verify --quiet refs/remotes/origin/trident/add-thing')) return ok(TOCTOU_TIP)
      return ok()
    }

  test('a checkout TRUNCATED between the two reads cannot become a proven divergence either', async () => {
    const order: string[] = []
    let depths = 0
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'trident/add-thing' } }),
      local_branch_tip: TOCTOU_TIP,
      hostResponder: toctouResponderDepth(
        () => {
          order.push('ancestry')
          // Exit 1 at BOTH reads — indistinguishable, at the probe, from a real divergence.
          return { ok: false, stdout: '', stderr: '', exit_code: 1 }
        },
        () => {
          depths += 1
          order.push('depth')
          // Read 1: the checkout really is complete. Read 2: a `fetch --depth=1` landed in
          // between and truncated it, so the exit 1 the verdict would rest on means nothing.
          return depths === 1 ? ok('false') : ok('true')
        },
      ),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode, branch: 'trident/add-thing' })
    await launchOnce(h)
    const reason = store.get(run.id)?.failure_reason ?? ''

    // The bracket: depth is read once BEFORE the confirming ancestry read and once AFTER it, so
    // the second depth answer cannot be inherited from before the read it licenses.
    expect(order).toEqual(['ancestry', 'depth', 'ancestry', 'depth'])
    // Still REFUSED — fail-closed, nothing fired. Only the CLAIM changes.
    expect(h.inputs).toHaveLength(0)
    expect(store.get(run.id)?.phase).toBe('failed')
    expect(reason).toContain('UNKNOWN')
    // The detail quotes the depth actually measured around that read, not the stale one.
    expect(reason).toContain('SHALLOW')
    expect(reason).toContain('--unshallow')
    expect(reason).not.toContain('already carries')
    expect(reason).not.toContain('it was not cut from')
    expect(reason).not.toContain('branch -D')
  })

  test('POSITIVE CONTROL: complete on BOTH sides of the confirming read is still the wrong-base refusal', async () => {
    // The bracket must not be satisfiable by an implementation that stopped answering "no".
    let depths = 0
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'trident/add-thing' } }),
      local_branch_tip: TOCTOU_TIP,
      hostResponder: toctouResponderDepth(
        () => ({ ok: false, stdout: '', stderr: '', exit_code: 1 }),
        () => {
          depths += 1
          return ok('false')
        },
      ),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode, branch: 'trident/add-thing' })
    await launchOnce(h)
    const reason = store.get(run.id)?.failure_reason ?? ''
    expect(h.inputs).toHaveLength(0)
    expect(depths).toBe(2)
    expect(reason).toContain('already carries 3 commit(s) not on origin/')
    expect(reason).toContain('branch -D -- trident/add-thing')
  })

  test('a CLOSING depth read that cannot answer is UNKNOWN, not a "no" borrowed from the opening one', async () => {
    let depths = 0
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'trident/add-thing' } }),
      local_branch_tip: TOCTOU_TIP,
      hostResponder: toctouResponderDepth(
        () => ({ ok: false, stdout: '', stderr: '', exit_code: 1 }),
        () => {
          depths += 1
          return depths === 1 ? ok('false') : { ok: false, stdout: '', stderr: 'fatal: not a repository', exit_code: 128 }
        },
      ),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode, branch: 'trident/add-thing' })
    await launchOnce(h)
    const reason = store.get(run.id)?.failure_reason ?? ''
    expect(h.inputs).toHaveLength(0)
    expect(reason).toContain('UNKNOWN')
    expect(reason).toContain('the depth of this checkout could not be read')
    expect(reason).not.toContain('already carries')
    expect(reason).not.toContain('branch -D')
  })

  test('a re-read that ERRORS is UNKNOWN, not a "no" borrowed from the first read', async () => {
    let reads = 0
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'trident/add-thing' } }),
      local_branch_tip: TOCTOU_TIP,
      hostResponder: toctouResponder(() => {
        reads += 1
        return reads === 1
          ? { ok: false, stdout: '', stderr: '', exit_code: 1 }
          : { ok: false, stdout: '', stderr: 'fatal: bad object', exit_code: 128 }
      }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode, branch: 'trident/add-thing' })
    await launchOnce(h)
    const reason = store.get(run.id)?.failure_reason ?? ''
    expect(h.inputs).toHaveLength(0)
    expect(reason).toContain('UNKNOWN')
    // The detail quotes the read the verdict actually rests on — the second one.
    expect(reason).toContain('exited 128')
    expect(reason).not.toContain('already carries')
    expect(reason).not.toContain('branch -D')
  })

  test('exit 0 stays definitive, so a shallow checkout costs a contained branch nothing', async () => {
    // Truncation can only HIDE ancestry, never invent it: `--is-ancestor` exiting 0 found the
    // link, and that is positive proof at any depth. So the depth probe is lazy — the common
    // shape (a branch already contained in the base) never pays for it, and never stalls on it.
    const BASE = 'b'.repeat(40)
    const TIP = 'c'.repeat(40)
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'trident/add-thing' } }),
      local_branch_tip: TIP,
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (joined.includes('rev-parse --is-shallow-repository')) return ok('true')
        if (joined.includes('rev-parse --verify refs/remotes/origin/main^{commit}')) return ok(BASE)
        if (joined.includes(`merge-base --is-ancestor ${TIP} ${BASE}`)) return ok()
        return ok()
      },
    })
    await createRun({ merge_mode: 'pr' as MergeMode, branch: 'trident/add-thing' })
    await launchOnce(h)
    expect(h.inputs).toHaveLength(1)
    expect(h.hostCalls.some((c) => c.join(' ').includes('rev-parse --is-shallow-repository'))).toBe(false)
  })

  test("the launch base fetch stays inside this repo's own .git — no submodule recursion", async () => {
    // The refusal composed on this path, and `delivery.ts`'s LAUNCH_PATH_FETCH beside it, both
    // tell the reader the launcher's writes live under this repo's `.git`. A fetch recurses into
    // submodules whenever `fetch.recurseSubmodules` says so (its default is `on-demand`, and a
    // repo may set `true`), and a recursed fetch writes inside the SUBMODULE's git dir — git's
    // OWN write, which no hook caveat covers, and which falsifies the boundary the message
    // asserts. One flag; this pins that it is passed, and that the sentence quotes the argv that
    // actually ran.
    const BASE = 'b'.repeat(40)
    const TIP = 'c'.repeat(40)
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'trident/add-thing' } }),
      local_branch_tip: TIP,
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (joined.includes('rev-parse --verify refs/remotes/origin/main^{commit}')) return ok(BASE)
        if (joined.includes(`merge-base --is-ancestor ${TIP} ${BASE}`)) {
          return { ok: false, stdout: '', stderr: 'fatal: bad object', exit_code: 128 }
        }
        return ok()
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode, branch: 'trident/add-thing' })
    await launchOnce(h)
    const fetched = h.hostCalls.find((c) => c.includes('fetch'))
    expect(fetched).toBeDefined()
    expect(fetched).toContain('--no-recurse-submodules')
    expect(fetched?.indexOf('--no-recurse-submodules')).toBeLessThan(fetched?.indexOf('origin') ?? -1)
    const reason = store.get(run.id)?.failure_reason ?? ''
    expect(reason).toContain('--no-recurse-submodules')
    expect(reason).toContain("under this repo's own .git")
  })

  test('an ancestor-only local branch leftover proceeds', async () => {
    const BASE = 'b'.repeat(40)
    const TIP = 'c'.repeat(40)
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'trident/add-thing' } }),
      local_branch_tip: TIP,
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (joined.includes('rev-parse --verify refs/remotes/origin/main^{commit}')) return ok(BASE)
        if (joined.includes(`merge-base --is-ancestor ${TIP} ${BASE}`)) return ok()
        return ok()
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode, branch: 'trident/add-thing' })
    await launchOnce(h)

    expect(h.inputs).toHaveLength(1)
    expect(store.get(run.id)?.phase).not.toBe('failed')
  })

  test("this run's own crash-leftover branch proceeds from its prior pin", async () => {
    const BASE = 'b'.repeat(40)
    const TIP = 'c'.repeat(40)
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'trident/add-thing' } }),
      local_branch_tip: TIP,
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (joined.includes(`merge-base --is-ancestor ${TIP} ${BASE}`)) {
          return { ok: false, stdout: '', stderr: '', exit_code: 1 }
        }
        if (joined.includes(`merge-base --is-ancestor ${BASE} ${TIP}`)) return ok()
        return ok()
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode, branch: 'trident/add-thing' })
    await store.update(run.id, { base_sha: BASE, base_behind: 7 })
    await launchOnce(h)

    expect(h.inputs).toHaveLength(1)
    expect(h.inputs[0]!.base_sha).toBe(BASE)
    expect(h.hostCalls.some((c) => c.includes('fetch'))).toBe(false)
    expect(store.get(run.id)?.base_sha).toBe(BASE)
    expect(store.get(run.id)?.phase).not.toBe('failed')
  })

  test('an ancestry probe that ERRORED refuses as UNKNOWN, and claims no divergence it never measured', async () => {
    // `merge-base --is-ancestor` has THREE exits — 0 yes, 1 no, anything else an ERROR (128 on
    // a corrupt or missing object). The guard used to read only `.ok`, so exit 128 flowed into
    // the SAME composed refusal as a meaningful exit 1 and asserted, in the guard's own voice,
    // that the branch "already carries N commit(s) not on origin/main — it was not cut from
    // origin/main". That is a positive claim about divergence derived from a probe that
    // answered nothing, in the one message class this change exists to make evidence-honest.
    const BASE = 'b'.repeat(40)
    const TIP = 'c'.repeat(40)
    const errored = (exit_code: number, timed_out?: boolean) =>
      buildHarness({
        plan: () => ({ result: { verdict: 'APPROVE', branch: 'trident/add-thing' } }),
        local_branch_tip: TIP,
        hostResponder: (cmd) => {
          const joined = cmd.join(' ')
          if (joined.includes('rev-parse --verify refs/remotes/origin/main^{commit}')) return ok(BASE)
          if (joined.includes(`merge-base --is-ancestor ${TIP} ${BASE}`)) {
            // `timed_out` is an OPTIONAL property of HostCommandResult, and this repo compiles
            // with `exactOptionalPropertyTypes` — so "present and undefined" is NOT the same
            // type as "absent", and spreading `boolean | undefined` in is a TS2322. Omit the
            // key when there is no kill to report, which is also the shape `spawnCapture`
            // actually produces.
            return {
              ok: false,
              stdout: '',
              stderr: 'fatal: bad object',
              exit_code,
              ...(timed_out === undefined ? {} : { timed_out }),
            }
          }
          return ok()
        },
      })

    const h = errored(128)
    const run = await createRun({ merge_mode: 'pr' as MergeMode, branch: 'trident/add-thing' })
    await launchOnce(h)

    // FAIL-CLOSED: the build is still not started. UNKNOWN refuses; it does not proceed.
    expect(h.inputs).toHaveLength(0)
    const final = store.get(run.id)!
    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('UNKNOWN')
    expect(final.failure_reason).toContain('exited 128')
    expect(final.failure_reason).toContain('trident/add-thing')
    // ...and it refuses as what it IS, not as the divergence refusal.
    expect(final.failure_reason).not.toContain('already carries')
    expect(final.failure_reason).not.toContain("refusing to build on another lane's work")
    // UNKNOWN authorises nothing irreversible (docs/INVARIANTS.md §12 invariant 122).
    expect(final.failure_reason).not.toContain('branch -D')
    expect(final.failure_reason).not.toContain('worktree remove')
    // The composer is never even reached, so no evidence-gathering command was spent on it.
    expect(h.hostCalls.some((c) => c.join(' ').includes('worktree list'))).toBe(false)

    // THE SEAM, NOT JUST THE STRING (Argus blocker). A refusal is only as honest as what
    // delivery makes of it, and this one QUOTES git — `git merge-base --is-ancestor exited 128`.
    // `interpretFailure`'s merge-mechanics arm is a bare `includes('git ')`, so the reason was
    // delivered as "The build finished but a git step failed while landing the branch": a
    // completed build and a merge attempt, both asserted about a launch its own text says never
    // happened. Asserting on `failure_reason` alone could not see that.
    const delivered = interpretFailure(final)
    expect(delivered.klass).toBe('infra')
    expect(delivered.summary).toContain('did not start this build')
    expect(delivered.summary).not.toContain('The build finished')
    expect(delivered.summary).not.toContain('landing the branch')
    expect(delivered.input_needed).not.toContain('branch -D')

    // A KILLED probe is the same non-answer wearing git's meaningful exit code: `spawnCapture`
    // reports the kill in `timed_out`, and exit 1 alone cannot tell the two apart.
    const killed = errored(1, true)
    const run2 = await createRun({ merge_mode: 'pr' as MergeMode, branch: 'trident/add-thing' })
    await launchOnce(killed)
    expect(killed.inputs).toHaveLength(0)
    const final2 = store.get(run2.id)!
    expect(final2.failure_reason).toContain('killed by its watchdog')
    expect(final2.failure_reason).not.toContain('already carries')
    expect(final2.failure_reason).not.toContain('branch -D')
    // The watchdog variant carries no `git ` token at all, so it missed the merge-mechanics arm
    // and landed on the bare `unknown` fallback instead — the same defect, vaguer sentence.
    const delivered2 = interpretFailure(final2)
    expect(delivered2.klass).toBe('infra')
    expect(delivered2.summary).toContain('did not start this build')
    expect(delivered2.summary).not.toContain('The build finished')

    // POSITIVE CONTROL: exit 1 is git ANSWERING "no", and it still composes the full
    // evidence-naming refusal — see "a fresh launch refuses another lane's local branch
    // without firing" above, which asserts that message down to its `branch -D` chain. An
    // implementation that answered UNKNOWN for every non-zero exit would fail it.
  })

  test('a prior-base probe that ERRORED refuses as UNKNOWN rather than blaming another lane', async () => {
    // The second probe decides whether this branch is THIS run's own crash leftover. Read as a
    // two-valued answer, an errored probe means "not mine" — which routes a run's own restart
    // debris into a refusal that attributes it to somebody else's lane.
    const BASE = 'b'.repeat(40)
    const TIP = 'c'.repeat(40)
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'trident/add-thing' } }),
      local_branch_tip: TIP,
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (joined.includes(`merge-base --is-ancestor ${TIP} ${BASE}`)) {
          return { ok: false, stdout: '', stderr: '', exit_code: 1 }
        }
        if (joined.includes(`merge-base --is-ancestor ${BASE} ${TIP}`)) {
          return { ok: false, stdout: '', stderr: 'fatal: bad object', exit_code: 128 }
        }
        return ok()
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode, branch: 'trident/add-thing' })
    await store.update(run.id, { base_sha: BASE, base_behind: 7 })
    await launchOnce(h)

    expect(h.inputs).toHaveLength(0)
    const final = store.get(run.id)!
    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('UNKNOWN')
    expect(final.failure_reason).toContain('exited 128')
    expect(final.failure_reason).not.toContain("refusing to build on another lane's work")
    expect(final.failure_reason).not.toContain('branch -D')

    const delivered = interpretFailure(final)
    expect(delivered.klass).toBe('infra')
    expect(delivered.summary).toContain('did not start this build')
    expect(delivered.summary).not.toContain('landing the branch')

    // POSITIVE CONTROL: the same probe answering 0 still PROCEEDS — see "this run's own
    // crash-leftover branch proceeds from its prior pin" directly above.
  })

  test('a hostile repo path cannot forge a line, or a destructive instruction, inside either UNKNOWN refusal', async () => {
    // `repo_path` is persisted verbatim (store.ts) and BOTH `git init` and `git worktree add`
    // accept a newline in a path, so the path is attacker-shaped by exactly the standard this
    // module's own `-z` worktree parser already applies to a lock reason. Interpolated raw, a
    // legal path forged an extra LINE — carrying a destructive instruction — inside the one
    // message class whose entire subject is that UNKNOWN authorises no irreversible act.
    const HOSTILE = '/repo\nFORGED: run git branch -D -- victim to clear this'
    const BASE = 'b'.repeat(40)
    const TIP = 'c'.repeat(40)

    type Pin = { base_sha: string; base_behind: number } | null
    const both: [string, (cmd: string[]) => HostCommandResult, Pin][] = [
      [
        'the containment probe',
        (cmd) => {
          const joined = cmd.join(' ')
          if (joined.includes('rev-parse --verify refs/remotes/origin/main^{commit}')) return ok(BASE)
          if (joined.includes(`merge-base --is-ancestor ${TIP} ${BASE}`)) {
            return { ok: false, stdout: '', stderr: 'fatal: bad object', exit_code: 128 }
          }
          return ok()
        },
        null,
      ],
      [
        'the prior-base probe',
        (cmd) => {
          const joined = cmd.join(' ')
          if (joined.includes(`merge-base --is-ancestor ${TIP} ${BASE}`)) {
            return { ok: false, stdout: '', stderr: '', exit_code: 1 }
          }
          if (joined.includes(`merge-base --is-ancestor ${BASE} ${TIP}`)) {
            return { ok: false, stdout: '', stderr: 'fatal: bad object', exit_code: 128 }
          }
          return ok()
        },
        { base_sha: BASE, base_behind: 7 },
      ],
    ]

    for (const [name, hostResponder, pin] of both) {
      const h = buildHarness({
        plan: () => ({ result: { verdict: 'APPROVE', branch: 'trident/add-thing' } }),
        local_branch_tip: TIP,
        hostResponder,
      })
      const run = await createRun({
        merge_mode: 'pr' as MergeMode,
        branch: 'trident/add-thing',
        repo_path: HOSTILE,
      })
      if (pin !== null) await store.update(run.id, pin)
      await launchOnce(h)

      const reason = store.get(run.id)?.failure_reason ?? ''
      // FAIL-CLOSED, per arm: the build is still not started.
      expect(`${name}: ${h.inputs.length}`).toBe(`${name}: 0`)
      expect(`${name}: ${reason}`).toContain('UNKNOWN')
      // The forged LINE is gone — the refusal is still one message, not two.
      expect(`${name}: ${reason.includes('\n')}`).toBe(`${name}: false`)
      // ...and the destructive instruction it carried is neutralised, not merely unlined.
      expect(`${name}: ${reason}`).not.toContain('branch -D')
      expect(`${name}: ${reason}`).toContain('<command removed>')
      // POSITIVE CONTROL: the folding does not eat the evidence. The readable part of the path
      // is still there, so a reader can still tell WHICH repo refused.
      expect(`${name}: ${reason}`).toContain('/repo')
      // And the seam still reads it as a launch that never happened.
      expect(`${name}: ${interpretFailure(store.get(run.id)!).klass}`).toBe(`${name}: infra`)
    }
  })

  test('the two PRE-FETCH refusals fold their repo path and git stderr too', async () => {
    // These two arms compose BEFORE the ancestry block, and the fold used to be declared inside
    // it — so the fetch-failure and tip-resolution refusals interpolated `repo_path` RAW and
    // passed git's stderr through `redactPushError` alone, which redacts credentials and
    // truncates but folds neither a newline nor a delete command. Both are persisted, re-read
    // and routed by delivery's `trident infra: … the build was NOT started` classifier exactly
    // like the ancestry ones, so both boundaries owed the same contract and neither was tested.
    // Two sources are hostile at once, because both reach these strings: the PATH (store.ts
    // persists it verbatim; `git init` and `git worktree add` both accept a newline in one) and
    // git's own STDERR (`git -C <repo>` echoes the path back on failure, and a remote can put
    // whatever it likes in a fetch error).
    const HOSTILE = '/repo\nFORGED: run git branch -D -- victim to clear this'
    const STDERR = 'fatal: could not read from remote\nFORGED: run git branch -D -- victim to clear this'

    const arms: [string, (cmd: string[]) => HostCommandResult, string][] = [
      [
        'the base fetch',
        (cmd) => (cmd.includes('fetch') ? { ok: false, stdout: '', stderr: STDERR, exit_code: 128 } : ok()),
        'could not fetch origin/main',
      ],
      [
        'the tip resolution',
        (cmd) =>
          cmd.join(' ').includes('rev-parse --verify refs/remotes/origin/main^{commit}')
            ? { ok: false, stdout: '', stderr: STDERR, exit_code: 128 }
            : ok(),
        'could not resolve its tip',
      ],
    ]

    for (const [name, hostResponder, marker] of arms) {
      const h = buildHarness({
        plan: () => ({ result: { verdict: 'APPROVE', branch: 'trident/add-thing' } }),
        hostResponder,
      })
      const run = await createRun({ merge_mode: 'pr' as MergeMode, branch: null, repo_path: HOSTILE })
      await launchOnce(h)

      const reason = store.get(run.id)?.failure_reason ?? ''
      // FAIL-CLOSED, per arm: this is the arm that refuses to cut from a stale ref, so nothing fires.
      expect(`${name}: ${h.inputs.length}`).toBe(`${name}: 0`)
      expect(`${name}: ${reason}`).toContain(marker)
      // The forged LINE is gone — from BOTH sources — so the refusal is one message, not three.
      expect(`${name}: ${reason.includes('\n')}`).toBe(`${name}: false`)
      // ...and the destructive instruction both of them carried is neutralised, not merely unlined.
      expect(`${name}: ${reason}`).not.toContain('branch -D')
      expect(`${name}: ${reason}`).toContain('<command removed>')
      // POSITIVE CONTROL: the fold does not eat the evidence. The readable part of the path is
      // still there, and so is what git actually said — which is the whole point of quoting it.
      expect(`${name}: ${reason}`).toContain('/repo')
      expect(`${name}: ${reason}`).toContain('fatal: could not read from remote')
      // And the seam still reads it as a launch that never happened, with no destructive advice.
      const delivered = interpretFailure(store.get(run.id)!)
      expect(`${name}: ${delivered.klass}`).toBe(`${name}: infra`)
      expect(`${name}: ${delivered.summary}`).toContain('did not start this build')
      expect(`${name}: ${delivered.input_needed}`).not.toContain('branch -D')
    }
  })

  test('a LEGAL branch name carrying non-ASCII controls cannot forge a line in either UNKNOWN refusal', async () => {
    // The branch used to be EXEMPT from folding, on the premise that "git's own ref rules have
    // already excluded control characters". That is true of ASCII controls and false of
    // everything else this guard folds. Reproduced in a scratch repo on git 2.43: `git branch`
    // ACCEPTED, and `rev-parse --verify` RESOLVED, both of the names below — a U+2028 line
    // separator several renderers break on, and a U+202E bidi override that reorders what is
    // DISPLAYED without changing a byte. The separators inside the payload are U+00A0, which git
    // does not reject either. So a legal branch name could draw what looks like a new line of the
    // guard's own message, carrying the one instruction this message class must never carry.
    const NBSP = ' '
    const FORGED = `trident/add-thing FORGED:${NBSP}run${NBSP}git${NBSP}branch${NBSP}-D${NBSP}--${NBSP}victim`
    const BIDI = 'trident/add-‮thing'
    const BASE = 'b'.repeat(40)
    const TIP = 'c'.repeat(40)

    for (const hostile of [FORGED, BIDI]) {
      const h = buildHarness({
        plan: () => ({ result: { verdict: 'APPROVE', branch: hostile } }),
        local_branch_tip: TIP,
        hostResponder: (cmd) => {
          const joined = cmd.join(' ')
          if (joined.includes('rev-parse --verify refs/remotes/origin/main^{commit}')) return ok(BASE)
          if (joined.includes(`merge-base --is-ancestor ${TIP} ${BASE}`)) {
            return { ok: false, stdout: '', stderr: 'fatal: bad object', exit_code: 128 }
          }
          return ok()
        },
      })
      const run = await createRun({ merge_mode: 'pr' as MergeMode, branch: hostile })
      await launchOnce(h)

      const reason = store.get(run.id)?.failure_reason ?? ''
      expect(`${hostile}: ${h.inputs.length}`).toBe(`${hostile}: 0`)
      expect(reason).toContain('UNKNOWN')
      // The forged LINE is gone, and so is the bidi override that reorders the rendering.
      expect(reason).not.toContain(' ')
      expect(reason).not.toContain('‮')
      // ...and the destructive instruction the payload carried is neutralised, not merely
      // unlined — in BOTH spellings, since U+00A0 separators are what the payload actually uses
      // and `\s` in the option-window rule covers them.
      expect(reason).not.toContain('branch -D')
      expect(reason).not.toContain(`branch${NBSP}-D`)
      // AND THE FOLD KEEPS A NAME FIELD TO ONE TOKEN (Argus blocker). Folding those codepoints
      // to an ASCII SPACE is what neutralised the payload before, and the space is exactly what
      // `delivery.ts` anchors its wrong-base classifier on (`[^ \n]+`) — so the fold spelled the
      // banned instruction out of a name in one message class while breaking the classifier in
      // the other. The whole payload now sits inside ONE whitespace-delimited token, which is
      // asserted here rather than the substitute character, so the spelling stays free.
      if (hostile === FORGED) {
        const tokens = reason.split(/\s/).filter((t) => t.includes('victim'))
        expect(tokens.length).toBeGreaterThan(0)
        for (const t of tokens) expect(t).toContain('trident/add-')
      }
      // POSITIVE CONTROL: the readable half of the branch name survives, so the refusal still
      // says WHICH branch it refused. An implementation that simply dropped the field would
      // pass every assertion above and tell the reader nothing.
      expect(reason).toContain('trident/add-')
    }
  })

  test('a LEGAL base name carrying non-ASCII controls cannot forge a line in the UNKNOWN refusals either', async () => {
    // The refusals said "every field this refusal quotes is folded" while interpolating `base`
    // RAW — it arrives from `detectBaseBranch`/`opts.base_branch`, and git accepts U+2028 and
    // U+202E in it exactly as it does in the build branch. So the forged line was still
    // available, through the other name, in the one message class whose subject is that UNKNOWN
    // authorises nothing.
    const NBSP = '\u00a0'
    const HOSTILE_BASE = `main\u2028FORGED:${NBSP}run${NBSP}git${NBSP}branch${NBSP}-D${NBSP}--${NBSP}victim`
    const BASE = 'b'.repeat(40)
    const TIP = 'c'.repeat(40)
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'trident/add-thing' } }),
      local_branch_tip: TIP,
      base_branch: HOSTILE_BASE,
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (joined.includes('rev-parse --verify refs/remotes/origin/')) return ok(BASE)
        if (joined.includes(`merge-base --is-ancestor ${TIP} ${BASE}`)) {
          return { ok: false, stdout: '', stderr: 'fatal: bad object', exit_code: 128 }
        }
        return ok()
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode, branch: 'trident/add-thing' })
    await launchOnce(h)

    const reason = store.get(run.id)?.failure_reason ?? ''
    expect(h.inputs).toHaveLength(0)
    expect(reason).toContain('UNKNOWN')
    expect(reason.includes('\n')).toBe(false)
    expect(reason).not.toContain('branch -D')
    expect(reason).not.toContain(`branch${NBSP}-D`)
    const tokens = reason.split(/\s/).filter((t) => t.includes('victim'))
    expect(tokens.length).toBeGreaterThan(0)
    // POSITIVE CONTROL: the readable half of the base survives, so the refusal still says which
    // base it measured against.
    for (const t of tokens) expect(t).toContain('main')
  })

  test('the UNKNOWN refusal counts the fetch it already made instead of claiming it wrote nothing', async () => {
    // The refusal asserted "no branch, worktree, commit or file was changed or deleted" — true
    // as far as it goes — immediately after this same path ran the base fetch,
    // which force-updates the tracking ref, appends that ref's reflog, rewrites FETCH_HEAD and
    // writes whatever objects it downloaded. `delivery.ts` names that exact set for the
    // composer's own fetch and calls undercounting your own writes the overclaiming this refusal
    // exists to stop; the refusal itself did not. Non-destructive is the reassurance owed —
    // "wrote nothing" is a different claim, and it was not the true one.
    const BASE = 'b'.repeat(40)
    const TIP = 'c'.repeat(40)

    // FRESH PR BUILD: the fetch ran, so the writes it made are named.
    const fresh = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'trident/add-thing' } }),
      local_branch_tip: TIP,
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (joined.includes('rev-parse --verify refs/remotes/origin/main^{commit}')) return ok(BASE)
        if (joined.includes(`merge-base --is-ancestor ${TIP} ${BASE}`)) {
          return { ok: false, stdout: '', stderr: 'fatal: bad object', exit_code: 128 }
        }
        return ok()
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode, branch: 'trident/add-thing' })
    await launchOnce(fresh)
    const reason = store.get(run.id)?.failure_reason ?? ''
    // The sentence quotes the argv that actually ran, refspec included — a refusal that named
    // a shorthand fetch while the code ran a different one is the same defect in miniature.
    expect(
      fresh.hostCalls.some((c) =>
        c.join(' ').includes('fetch --no-tags --no-recurse-submodules origin +refs/heads/main:refs/remotes/origin/main'),
      ),
    ).toBe(true)
    expect(reason).toContain('no branch, worktree, commit or file in the tree was changed or deleted')
    expect(reason).toContain('fetch --no-tags --no-recurse-submodules origin +refs/heads/main:refs/remotes/origin/main')
    expect(reason).toContain('refs/remotes/origin/main')
    expect(reason).toContain('FETCH_HEAD')
    // ...AND THE REF UPDATE IS NAMED AS THE CONDITIONAL IT IS (Argus finding). A fetch whose
    // tracking ref already sits at origin's tip runs no ref transaction: repeating the identical
    // fetch against an unchanged remote leaves that ref's reflog at one line. Asserting the
    // refresh and the append flatly reported, in the no-op case, writes that did not happen —
    // overcounting, which is the same defect as the undercount this sentence was written to fix.
    expect(reason).toContain('if origin had moved that ref')
    expect(reason).toContain("that ref's reflog")
    // ...WHILE THE CONFIGURED BOOKKEEPING IS NOT CONDITIONAL (Argus finding). It used to ride
    // inside that same "if origin had moved that ref" list, which asserted in the NO-OP case a
    // boundary the config falsifies: reproduced on git 2.43 with `fetch.writeCommitGraph=true`
    // and a tracking ref already at origin's tip, the ref did not move (reflog stayed at one
    // line) and the commit-graph files appeared anyway. It belongs on FETCH_HEAD's side, where
    // `delivery.ts` already puts it — so it is named BEFORE the conditional opens.
    expect(reason).toContain('bookkeeping')
    expect(reason.indexOf('bookkeeping')).toBeLessThan(reason.indexOf('if origin had moved that ref'))
    // AND THE CAVEAT NAMES CONFIGURED CODE, NOT HOOKS ALONE (Argus blocker). An `ext::` remote
    // helper is spawned BY the fetch and was reproduced writing into the working tree during the
    // exact fetch form this path runs, so a hook-only caveat left the same hole one config key
    // along. Shared verbatim with `delivery.ts` through `CONFIGURED_CODE_CAVEAT`.
    expect(reason).toContain('code this repo configures git to run is code of its own')
    expect(reason).toContain('ext:: remote helper or a credential helper is spawned by the fetch itself')

    // POSITIVE CONTROL, and the OVERcounting half: a run that already carries a base pin makes
    // no fetch on this path, so naming one would report a write that never happened. An
    // implementation that hard-codes the fetch sentence fails here.
    const pinned = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'trident/add-thing' } }),
      local_branch_tip: TIP,
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (joined.includes(`merge-base --is-ancestor ${TIP} ${BASE}`)) {
          return { ok: false, stdout: '', stderr: 'fatal: bad object', exit_code: 128 }
        }
        return ok()
      },
    })
    const run2 = await createRun({ merge_mode: 'pr' as MergeMode, branch: 'trident/add-thing' })
    await store.update(run2.id, { base_sha: BASE, base_behind: 7 })
    await launchOnce(pinned)
    const reason2 = store.get(run2.id)?.failure_reason ?? ''
    expect(pinned.hostCalls.some((c) => c.join(' ').includes('fetch'))).toBe(false)
    expect(reason2).toContain('no branch, worktree, commit or file in the tree was changed or deleted')
    expect(reason2).not.toContain('FETCH_HEAD')
    // The no-fetch arm measures git's writes too, and carries the same caveat: a hook or helper
    // this repo configures is not bounded by a sentence about what the launcher did.
    expect(reason2).toContain('deleted by git itself')
    expect(reason2).toContain('code this repo configures git to run is code of its own')
  })

  test('a checkpointed resume does not fetch or pin a base', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      hostResponder: (cmd) =>
        cmd.join(' ').includes('ls-remote --heads origin refs/heads/feat-x')
          ? ok(`${HEAD}\trefs/heads/feat-x\n`)
          : ok(),
    })
    const run = await resumeRun()
    await launchOnce(h)

    expect(h.inputs).toHaveLength(1)
    expect(h.hostCalls.some((c) => c.includes('fetch'))).toBe(false)
    expect(store.get(run.id)?.base_sha).toBeNull()
    expect(store.get(run.id)?.base_behind).toBeNull()
  })

  test('a pre-pinned relaunch keeps its original base without fetching again', async () => {
    const PINNED = 'b'.repeat(40)
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'trident/add-thing' } }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode, branch: 'trident/add-thing' })
    await store.update(run.id, { base_sha: PINNED, base_behind: 7 })
    await launchOnce(h)

    expect(h.inputs).toHaveLength(1)
    expect(h.inputs[0]!.base_sha).toBe(PINNED)
    expect(h.hostCalls.some((c) => c.includes('fetch'))).toBe(false)
    expect(store.get(run.id)?.base_sha).toBe(PINNED)
    expect(store.get(run.id)?.base_behind).toBe(7)
  })

  test('a checkpointed resume does not fetch or pin a base', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      hostResponder: (cmd) =>
        cmd.join(' ').includes('ls-remote --heads origin refs/heads/feat-x')
          ? ok(`${HEAD}\trefs/heads/feat-x\n`)
          : ok(),
    })
    const run = await resumeRun()
    await launchOnce(h)

    expect(h.inputs).toHaveLength(1)
    expect(h.hostCalls.some((c) => c.includes('fetch'))).toBe(false)
    expect(store.get(run.id)?.base_sha).toBeNull()
    expect(store.get(run.id)?.base_behind).toBeNull()
  })

  test('a pre-pinned relaunch keeps its original base without fetching again', async () => {
    const PINNED = 'b'.repeat(40)
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'trident/add-thing' } }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode, branch: 'trident/add-thing' })
    await store.update(run.id, { base_sha: PINNED, base_behind: 7 })
    await launchOnce(h)

    expect(h.inputs).toHaveLength(1)
    expect(h.inputs[0]!.base_sha).toBe(PINNED)
    expect(h.hostCalls.some((c) => c.includes('fetch'))).toBe(false)
    expect(store.get(run.id)?.base_sha).toBe(PINNED)
    expect(store.get(run.id)?.base_behind).toBe(7)
  })

  test('two failed fresh-base fetches fail loudly without firing', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      hostResponder: (cmd) => cmd.includes('fetch')
        ? { ok: false, stdout: '', stderr: 'network down', exit_code: 1 }
        : ok(),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode, branch: null })
    await launchOnce(h)

    expect(h.inputs).toHaveLength(0)
    expect(h.hostCalls.filter((c) => c.includes('fetch'))).toHaveLength(2)
    expect(store.get(run.id)?.phase).toBe('failed')
    expect(store.get(run.id)?.failure_reason).toContain('could not fetch origin/main')
  })

  test('a local-mode resume asks the LOCAL ref', async () => {
    const found = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      hostResponder: (cmd) =>
        cmd.join(' ').includes('rev-parse --verify refs/heads/feat-x^{commit}') ? ok(HEAD) : ok(),
    })
    await resumeRun({}, 'local' as MergeMode)
    await launchOnce(found)
    expect(found.hostCalls).toContainEqual([
      'git',
      '-C',
      '/repo',
      'rev-parse',
      '--verify',
      'refs/heads/feat-x^{commit}',
    ])
    expect(found.inputs[0]!.resume_live_head).toBe(HEAD)
  })

  // A failed rev-parse is ambiguous — a HEALTHY git that still cannot find the ref
  // is a real answer ("the branch is gone"), not a failed read.
  test('a local-mode resume whose ref is missing under a HEALTHY git is absent', async () => {
    const gone = buildHarness({
      plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }),
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (joined.includes('rev-parse --verify refs/heads/feat-x^{commit}')) {
          return { ok: false, stdout: '', stderr: 'fatal: Needed a single revision', exit_code: 128 }
        }
        if (joined.includes('rev-parse --git-dir')) return ok('.git')
        return ok()
      },
    })
    await resumeRun({}, 'local' as MergeMode)
    await launchOnce(gone)
    expect(gone.inputs[0]!.resume_live_head).toBe('absent')
  })

  test('resolveResumeLiveHead: a malformed answer is not an answer — it is a failed attempt', async () => {
    const calls: string[][] = []
    const host = async (cmd: string[]): Promise<HostCommandResult> => {
      calls.push(cmd)
      // A plausible-looking but ABBREVIATED sha is exactly the mangling this card
      // exists to stop being believed.
      return ok('1d731ad\trefs/heads/feat-x\n')
    }
    const out = await resolveResumeLiveHead(
      host,
      { repo_path: '/repo', branch: 'feat-x', merge_mode: 'pr' },
      async () => {},
    )
    expect(out).toBe('')
    expect(calls).toHaveLength(3)
  })

  test('resolveResumeLiveHead: an unhealthy git in local mode is a failed read, never "absent"', async () => {
    const host = async (): Promise<HostCommandResult> => ({
      ok: false,
      stdout: '',
      stderr: 'fatal: not a git repository',
      exit_code: 128,
    })
    expect(
      await resolveResumeLiveHead(
        host,
        { repo_path: '/repo', branch: 'feat-x', merge_mode: 'local' },
        async () => {},
      ),
    ).toBe('')
  })

  /**
   * A `pr`-mode read is `git ls-remote` — a NETWORK call — and `''` fails the run
   * terminally at the fast-exit. Three back-to-back attempts complete inside a few
   * milliseconds, which a DNS blip outlives comfortably: the retry existed but did not
   * cover the one class that is actually transient. The waits are now a seam.
   */
  test('resolveResumeLiveHead: the retries are SPACED, not fired back to back', async () => {
    const waits: number[] = []
    const order: string[] = []
    const host = async (): Promise<HostCommandResult> => {
      order.push('read')
      return { ok: false, stdout: '', stderr: 'ssh: Could not resolve hostname github.com', exit_code: 128 }
    }
    const out = await resolveResumeLiveHead(
      host,
      { repo_path: '/repo', branch: 'feat-x', merge_mode: 'pr' },
      async (ms) => {
        waits.push(ms)
        order.push(`wait:${ms}`)
      },
    )
    expect(out).toBe('')
    // Between attempts only: never before the first read, never after the last.
    expect(order).toEqual(['read', ...RESUME_HEAD_RETRY_DELAYS_MS.flatMap((ms) => [`wait:${ms}`, 'read'])])
    expect(waits).toEqual([...RESUME_HEAD_RETRY_DELAYS_MS])
    expect(waits.every((ms) => ms > 0)).toBe(true)
  })

  /**
   * THE PRODUCTION DEFAULT IS THE ONE THING EVERY OTHER TEST HERE REPLACES (Argus r4). The
   * suite injects a no-op `sleep` everywhere, and `gateway/composition/build-core-modules.ts`
   * never passes `opts.sleep` — so the value that actually runs in production, the default
   * parameter, was exercised by nothing. If it were `async () => {}` the three attempts would
   * fire back to back in production and every test above would still pass.
   *
   * MEASURED WITHOUT A CLOCK (Argus r5). An earlier version of this test spent the real
   * ~1.25 s and asserted on `Date.now()` elapsed, which measures the runner rather than the
   * code (`scripts/ci/wall-clock-bound-check.mjs`, ISSUES #438). The observable that
   * actually distinguishes "sleeps" from "does not sleep" is the TIMER IT SCHEDULES, so the
   * default is exercised for real against a captured `setTimeout`: the delays it asks for
   * are the assertion, and firing each callback immediately keeps the test free.
   */
  test('resolveResumeLiveHead: the DEFAULT sleep schedules the real delays (no stub injected)', async () => {
    const host = async (): Promise<HostCommandResult> => ({
      ok: false,
      stdout: '',
      stderr: 'ssh: Could not resolve hostname github.com',
      exit_code: 128,
    })
    const scheduled: number[] = []
    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      scheduled.push(ms ?? 0)
      // Fire on the microtask queue instead of the timer queue: same ordering, no wait.
      queueMicrotask(fn)
      return 0
    }) as unknown as typeof globalThis.setTimeout
    try {
      // No third argument: exactly how production calls it.
      const out = await resolveResumeLiveHead(host, { repo_path: '/repo', branch: 'feat-x', merge_mode: 'pr' })
      expect(out).toBe('')
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
    // A no-op default would schedule nothing; a back-to-back default would schedule zeroes.
    expect(scheduled).toEqual([...RESUME_HEAD_RETRY_DELAYS_MS])
  })

  test('resolveResumeLiveHead: a read that SUCCEEDS first time never waits at all', async () => {
    const waits: number[] = []
    const head = 'a'.repeat(40)
    const host = async (): Promise<HostCommandResult> => ok(`${head}\trefs/heads/feat-x\n`)
    const out = await resolveResumeLiveHead(
      host,
      { repo_path: '/repo', branch: 'feat-x', merge_mode: 'pr' },
      async (ms) => {
        waits.push(ms)
      },
    )
    expect(out).toBe(head)
    expect(waits).toEqual([])
  })
})

/**
 * WIRED, NOT MERELY BUILT. Five PRs in one night landed a module plus its unit
 * tests and skipped the registration, so a green merge delivered no behaviour. A
 * hang-watchdog reader is exactly that shape: `latest_stage_event_at` is OPTIONAL
 * and its absence is indistinguishable from the old code, so an unwired version
 * passes every test above while production keeps reaping live builds.
 *
 * This asserts the production composition root actually passes it.
 */
describe('hang watchdog — the stage-event reader is wired in production', () => {
  test('build-core-modules passes latest_stage_event_at to buildTridentOrchestrator', () => {
    const src = readFileSync(
      new URL('../gateway/composition/build-core-modules.ts', import.meta.url),
      'utf8',
    )
    // POSITIVE CONTROL FIRST: if this anchor ever moves, the assertions below would
    // pass vacuously against an empty read, and an empty check reads as a passing
    // check. Fail loudly instead.
    expect(src).toContain('buildTridentOrchestrator(orchestratorOpts)')
    expect(src).toContain('latest_stage_event_at:')
    expect(src).toContain('store.latestStageEventAt(run_id)')
  })

  test('the store exposes the single-row reader the wiring calls', () => {
    const src = readFileSync(new URL('./store.ts', import.meta.url), 'utf8')
    expect(src).toContain('latestStageEventAt(run_id: string): string | null')
    // ONE row, not the whole history — this runs per in-flight run per tick.
    expect(src).toContain('ORDER BY id DESC')
    expect(src).toContain('LIMIT 1')
  })
})

describe('orchestrator — a prNumber of 0 is a sentinel, never a PR number (run f384460d)', () => {
  test('an inner-error harvest carrying prNumber 0 keeps the known PR on the failed row', async () => {
    // The f384460d trace: the run went terminal-failed with `checkpoint: 'inner-error'` and
    // the wrapper's pr sentinel still attached. A failed run may lose its verdict — it may
    // not lose its PR, or the recovery has nothing to point at.
    const h = buildHarness({
      plan: () => ({
        result: {
          verdict: 'REQUEST_CHANGES',
          round: 1,
          checkpoint: 'inner-error',
          prNumber: 0,
          branch: 'feat-x',
          remainingTasks: 0,
        },
      }),
      // `detectExistingPr` runs at FIRE time, so this is how the row comes to hold pr=267.
      hostResponder: (cmd) => (cmd.join(' ').includes('gh pr list') ? ok('267') : ok()),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })
    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('failed')
    expect(final.pr).toBe(267)
  })
})

/**
 * T4 — RUN `f384460d` REPLAYED: AN INFRASTRUCTURE DEATH MUST NOT BE REPORTED AS A VERDICT.
 *
 * The build finished, then the inner workflow threw and its catch path wrote
 * `{ ok:false, verdict:'REQUEST_CHANGES', checkpoint:'inner-error', findings: [] }`. That
 * verdict is the wrapper's — no reviewer ever ran — so the harvested row must carry null.
 */
describe('orchestrator — T4: an inner-error harvest carries NO verdict (run f384460d)', () => {
  // RENAMED, AND THE ASSERTION CHANGED ON PURPOSE — read this before "fixing" it back.
  // T4 originally recorded `null` here to mean "nobody judged this code", which was right
  // against the alternative it was written to kill (a fabricated REQUEST_CHANGES on an
  // infrastructure death). It stays right; it is just no longer the best available answer.
  // `null` is also what an un-harvested, still-running row carries, so the record could not
  // distinguish "review provably did not happen" from "not filled in yet" — the same
  // absence-read-as-information that this whole area keeps getting wrong.
  // REVIEW_NOT_RUN is that identical claim with a NAME, and it is now a value the column's
  // CHECK constraint accepts. The infra polarity T4 exists to protect is untouched and
  // still asserted below: reason names infrastructure, never "without Argus APPROVE", and
  // `interpretFailure` still classifies it `infra`.
  test('the replayed inner-error harvest fails with REVIEW_NOT_RUN, the PR intact, and an infra reason', async () => {
    const h = buildHarness({
      plan: () => ({
        result: {
          ok: false,
          prNumber: 0,
          branch: 'feat-x',
          verdict: 'REQUEST_CHANGES',
          round: 1,
          checkpoint: 'inner-error',
          remainingTasks: 0,
        },
      }),
      hostResponder: (cmd) => (cmd.join(' ').includes('gh pr list') ? ok('267') : ok()),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('failed')
    expect(final.inner_verdict).toBe('REVIEW_NOT_RUN')
    // The point T4 actually defends: whatever this field says, it must NOT be the
    // reviewer's rejection. Asserted positively so the test still fails if the old
    // fabricated REQUEST_CHANGES ever comes back.
    expect(final.inner_verdict).not.toBe('REQUEST_CHANGES')
    expect(final.pr).toBe(267)
    expect(final.failure_reason).toContain('build infrastructure failed')
    expect(final.failure_reason).not.toContain('without Argus APPROVE')
    expect(interpretFailure(final).klass).toBe('infra')
  })

  test('a genuine review exhaustion still reports REQUEST_CHANGES with review copy', async () => {
    const h = buildHarness({
      plan: () => ({
        result: {
          verdict: 'REQUEST_CHANGES',
          branch: 'feat-x',
          round: 8,
          checkpoint: 'argus-request-changes',
          blockKind: 'code',
          findings: [{ severity: 'blocker', title: 'null deref in a.ts' }],
        },
      }),
      hostResponder: (cmd) => (cmd.join(' ').includes('gh pr list') ? ok('267') : ok()),
    })
    const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)

    expect(final.phase).toBe('failed')
    expect(final.inner_verdict).toBe('REQUEST_CHANGES')
    // THE ROW MUST CARRY THE EVIDENCE FOR THE VERDICT IT RECORDS, not merely have been
    // allowed past the guard. Without this, the store's own rule ("REQUEST_CHANGES needs
    // findings") holds only at the moment of the write and is false on disk the instant
    // after -- and the next reader of this row, including the resumed fix round, sees a
    // rejection with nothing to fix. Verified by mutation: deleting the
    // `inner_checkpoint_findings` write from saveIfActive's UPDATE leaves every other
    // assertion in this file green, so this is the only thing standing between a correct
    // implementation and a column nothing ever populates.
    const persisted = parseCheckpointFindings(final.inner_checkpoint_findings)
    expect(persisted.length).toBeGreaterThan(0)
    expect(JSON.stringify(persisted)).toContain('null deref in a.ts')
    expect(final.failure_reason).toContain('without Argus APPROVE')
    expect(interpretFailure(final).klass).not.toBe('infra')
  })
})

/**
 * PURITY PREFLIGHT wiring (2026-08-31). Every case here drives the DEFAULT —
 * the real `runLeakGatePreflight` — through a scripted host responder. Nothing
 * injects a fake `leak_preflight`, on purpose: a seam whose producer is missing
 * ships an inert feature, and a test that injects its own producer proves the
 * fake rather than the wiring.
 *
 * The gate's rule ids embed the six-letter word the gate itself bans anywhere in
 * a committed file, so every fixture assembles it from FRAGMENTS at runtime —
 * the discipline `trident/leak-preflight.test.ts` and
 * `scripts/ci/leak-gate-selftest.test.ts` established.
 */
describe('orchestrator — purity preflight in the outer publisher', () => {
  const T2 = 'ten' + 'ant'
  const RULE_W = `${T2}-word`
  const RULE_P = `${T2}-purged`
  const PLAN_DOC = '.trident/plans/trident/x.md'
  const EXCERPT_W = 'Repo rules: never write the flagged vocabulary'
  const FAIL_OUT = [
    '── Tier 2: vocabulary ─────',
    `  [${RULE_W}] ${PLAN_DOC}:7:${EXCERPT_W}`,
    `  [${RULE_P}] ${PLAN_DOC}:24:zero flagged words in the commit`,
    '    TOTAL FINDINGS: 2',
    'LEAK GATE: FAIL — the public tree must be fully silent.',
  ].join('\n')
  const SILENT_OUT = ['    TOTAL FINDINGS: 0', 'LEAK GATE: SILENT'].join('\n')
  const gateFail: HostCommandResult = { ok: false, stdout: FAIL_OUT, stderr: '', exit_code: 1 }
  const gateSilent: HostCommandResult = { ok: true, stdout: SILENT_OUT, stderr: '', exit_code: 0 }
  const isGate = (joined: string): boolean => joined.includes('leak-gate.sh --tree')

  const head = 'abcdef0123456789abcdef0123456789abcdef01'
  const baseTip = '4444444444444444444444444444444444444444'
  const stale = '9'.repeat(40)

  /** The publish scenario of the NO-OP replay test above: the branch already
   *  carries the base tip, so nothing here turns on the rebase. */
  const publishPlan = (): ((input: InnerLoopInput) => SimPlan) => {
    let fires = 0
    return () => {
      fires += 1
      return fires === 1
        ? {
            result: {
              verdict: 'REQUEST_CHANGES',
              branch: 'feat-x',
              checkpoint: 'forge-done',
              publishRequested: true,
              publishHead: head,
            },
          }
        : { result: { verdict: 'APPROVE', prNumber: 42, branch: 'feat-x' } }
    }
  }

  test('the gate runs on the branch tree before the PR is opened, and a silent verdict adds nothing', async () => {
    let lsRemotes = 0
    let prCreated = false
    const h = buildHarness({
      plan: publishPlan(),
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (isGate(joined)) return gateSilent
        if (joined.includes('ls-remote --heads origin refs/heads/main')) return ok(`${baseTip}\trefs/heads/main`)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) {
          lsRemotes += 1
          return ok(lsRemotes === 1 ? `${stale}\trefs/heads/feat-x` : `${head}\trefs/heads/feat-x`)
        }
        if (joined.includes('merge-base --is-ancestor')) return ok()
        if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
        if (joined.includes('gh pr create')) {
          prCreated = true
          return ok()
        }
        // No PR exists until this publish mints one.
        if (joined.includes('gh pr list')) return ok(prCreated ? '42' : '')
        if (joined.includes('diff --name-only')) return ok('changed.ts')
        return ok()
      },
    })
    const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)
    const calls = h.hostCalls.map((c) => c.join(' '))

    expect(final.phase).toBe('done')
    const gateAt = calls.findIndex((c) => isGate(c))
    const createAt = calls.findIndex((c) => c.includes('gh pr create'))
    expect(gateAt).toBeGreaterThanOrEqual(0)
    expect(createAt).toBeGreaterThanOrEqual(0)
    expect(gateAt).toBeLessThan(createAt)
    // A silent verdict says nothing on the PR. (`gh pr view … --json body` is
    // the annotation's own read; the unrelated `--json state,number` merge probe
    // is not it.)
    expect(calls.some((c) => c.includes('gh pr view') && c.includes('--json body'))).toBe(false)
    expect(calls.some((c) => c.includes('gh pr edit'))).toBe(false)
    expect(calls.some((c) => c.includes('gh pr comment'))).toBe(false)
    expect(h.refirePatches[0]?.inner_checkpoint).toBe(`outer-published:${head}:0:1`)
  })

  test('findings with no fixer still open the PR, and the annotation is sanitized', async () => {
    let lsRemotes = 0
    let prCreated = false
    const h = buildHarness({
      plan: publishPlan(),
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (isGate(joined)) return gateFail
        if (joined.includes('ls-remote --heads origin refs/heads/main')) return ok(`${baseTip}\trefs/heads/main`)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) {
          lsRemotes += 1
          return ok(lsRemotes === 1 ? `${stale}\trefs/heads/feat-x` : `${head}\trefs/heads/feat-x`)
        }
        if (joined.includes('merge-base --is-ancestor')) return ok()
        if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
        if (joined.includes('gh pr create')) {
          prCreated = true
          return ok()
        }
        // No PR exists until this publish mints one.
        if (joined.includes('gh pr list')) return ok(prCreated ? '42' : '')
        if (joined.includes('gh pr view 42 --json body')) return ok('original body')
        if (joined.includes('diff --name-only')) return ok('changed.ts')
        return ok()
      },
    })
    const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)
    const calls = h.hostCalls.map((c) => c.join(' '))

    expect(final.phase).toBe('done')
    expect(calls.some((c) => c.includes('gh pr create'))).toBe(true)
    const edit = h.hostCalls.find((c) => c[0] === 'gh' && c[1] === 'pr' && c[2] === 'edit')
    expect(edit).toBeDefined()
    const bodyFile = edit === undefined ? '' : (edit[edit.indexOf('--body-file') + 1] ?? '')
    const written = readFileSync(bodyFile, 'utf8')
    expect(written).toContain('original body')
    expect(written).toContain(`${PLAN_DOC}:7`)
    // The rule id lands SPLIT — an unsanitized one would re-redden this very PR.
    expect(written).toContain('ten-ant' + '-word')
    expect(written).not.toContain(T2)
    // …and no excerpt is quoted, ever.
    expect(written).not.toContain(EXCERPT_W)
    expect(h.refirePatches[0]?.inner_checkpoint).toBe(`outer-published:${head}:0:1`)
  })

  test('a failing annotation never fails the publish', async () => {
    let lsRemotes = 0
    const h = buildHarness({
      plan: publishPlan(),
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (isGate(joined)) return gateFail
        if (joined.includes('ls-remote --heads origin refs/heads/main')) return ok(`${baseTip}\trefs/heads/main`)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) {
          lsRemotes += 1
          return ok(lsRemotes === 1 ? `${stale}\trefs/heads/feat-x` : `${head}\trefs/heads/feat-x`)
        }
        if (joined.includes('merge-base --is-ancestor')) return ok()
        if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
        if (joined.includes('gh pr list')) return ok('42')
        if (joined.includes('gh pr comment')) return { ok: false, stdout: '', stderr: 'boom', exit_code: 1 }
        if (joined.includes('diff --name-only')) return ok('changed.ts')
        return ok()
      },
    })
    const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)
    const calls = h.hostCalls.map((c) => c.join(' '))

    expect(final.phase).toBe('done')
    // A PRE-EXISTING PR is COMMENTED on, never edited (an edit would clobber it).
    expect(calls.some((c) => c.includes('gh pr comment') && c.includes('--body-file'))).toBe(true)
    expect(calls.some((c) => c.includes('gh pr edit'))).toBe(false)
    // The annotation failed and the publish still completed.
    expect(h.refirePatches[0]?.inner_checkpoint).toBe(`outer-published:${head}:0:1`)
  })

  /**
   * A FRESHLY-MINTED PR WHOSE BODY EDIT FAILS STILL GETS THE FINDINGS. The flag that says "the
   * annotation is placed" used to be set BEFORE the edit's result was checked, so a transient
   * `gh pr edit` failure left the unresolved findings in a log line and nowhere a human reads.
   */
  test('a failed body edit on a NEW PR falls back to the comment path', async () => {
    let lsRemotes = 0
    let prCreated = false
    const h = buildHarness({
      plan: publishPlan(),
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (isGate(joined)) return gateFail
        if (joined.includes('ls-remote --heads origin refs/heads/main')) return ok(`${baseTip}\trefs/heads/main`)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) {
          lsRemotes += 1
          return ok(lsRemotes === 1 ? `${stale}\trefs/heads/feat-x` : `${head}\trefs/heads/feat-x`)
        }
        if (joined.includes('merge-base --is-ancestor')) return ok()
        if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
        if (joined.includes('gh pr create')) {
          prCreated = true
          return ok()
        }
        if (joined.includes('gh pr list')) return ok(prCreated ? '42' : '')
        if (joined.includes('gh pr view 42 --json body')) return ok('original body')
        if (joined.includes('gh pr edit')) return { ok: false, stdout: '', stderr: 'boom', exit_code: 1 }
        if (joined.includes('diff --name-only')) return ok('changed.ts')
        return ok()
      },
    })
    const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)
    const calls = h.hostCalls.map((c) => c.join(' '))

    expect(final.phase).toBe('done')
    expect(calls.some((c) => c.includes('gh pr edit'))).toBe(true)
    // The edit failed, so the findings take the OTHER route rather than evaporating.
    const comment = h.hostCalls.find((c) => c[0] === 'gh' && c[1] === 'pr' && c[2] === 'comment')
    expect(comment).toBeDefined()
    const bodyFile = comment === undefined ? '' : (comment[comment.indexOf('--body-file') + 1] ?? '')
    const written = readFileSync(bodyFile, 'utf8')
    expect(written).toContain(`${PLAN_DOC}:7`)
    expect(written).not.toContain(T2)
    expect(h.refirePatches[0]?.inner_checkpoint).toBe(`outer-published:${head}:0:1`)
  })

  test('a fixer-moved head is what gets pushed, confirmed, diffed and checkpointed', async () => {
    const newHead = 'e'.repeat(40)
    const fixerFindings: unknown[] = []
    let gateRuns = 0
    let lsRemotes = 0
    let refMoved = false
    const h = buildHarness({
      plan: publishPlan(),
      fix_leak_findings: async (input) => {
        fixerFindings.push(input.findings)
        return { fixed: true }
      },
      hostResponder: (cmd) => {
        const joined = cmd.join(' ')
        if (isGate(joined)) {
          gateRuns += 1
          return gateRuns === 1 ? gateFail : gateSilent
        }
        // The fixer staged its reword, and the preflight AUDITS what it staged: an
        // in-place modification (`M`) of exactly the file the gate flagged.
        if (joined.includes('.trident-worktrees/leak-preflight-') && joined.includes('diff --cached --name-status'))
          return ok(`M\t${PLAN_DOC}\n`)
        if (joined.includes('.trident-worktrees/leak-preflight-') && joined.includes('rev-parse HEAD'))
          return ok(newHead)
        if (joined.includes('update-ref refs/heads/feat-x')) {
          refMoved = true
          return ok()
        }
        if (joined.includes('ls-remote --heads origin refs/heads/main')) return ok(`${baseTip}\trefs/heads/main`)
        if (joined.includes('ls-remote --heads origin refs/heads/feat-x')) {
          lsRemotes += 1
          return ok(lsRemotes === 1 ? `${stale}\trefs/heads/feat-x` : `${newHead}\trefs/heads/feat-x`)
        }
        if (joined.includes('merge-base --is-ancestor')) return ok()
        // The branch ref really did move under the compare-and-swap.
        if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(refMoved ? newHead : head)
        if (joined.includes('gh pr list')) return ok('42')
        if (joined.includes('diff --name-only')) return ok('changed.ts')
        return ok()
      },
    })
    const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)
    const calls = h.hostCalls.map((c) => c.join(' '))

    expect(final.phase).toBe('done')
    // Findings reach the fixer as rule/file/line — never an excerpt.
    expect(fixerFindings[0]).toEqual([
      { rule: RULE_W, file: PLAN_DOC, line: 7 },
      { rule: RULE_P, file: PLAN_DOC, line: 24 },
    ])
    expect(calls.some((c) => c.includes(`update-ref refs/heads/feat-x ${newHead} ${head}`))).toBe(true)
    expect(calls.some((c) => c.includes(`--force-with-lease=refs/heads/feat-x:${stale}`))).toBe(true)
    expect(calls.some((c) => c.includes(`${baseTip}..${newHead}`))).toBe(true)
    expect(h.refirePatches[0]?.inner_checkpoint).toBe(`outer-published:${newHead}:0:1`)
  })
})

describe('sanitizeLeakAnnotation', () => {
  const T2 = 'ten' + 'ant'

  test('splits the flagged root in any case, anywhere, and is idempotent', () => {
    const mixed = `[${T2}-word] and ${T2.toUpperCase()} and ${T2.slice(0, 1).toUpperCase()}${T2.slice(1)}`
    const once = sanitizeLeakAnnotation(mixed)
    expect(once).not.toContain(T2)
    expect(once).not.toContain(T2.toUpperCase())
    expect(once).toContain('ten-ant' + '-word')
    expect(sanitizeLeakAnnotation(once)).toBe(once)

    // A file PATH can carry the root too, not only a rule id.
    const path = sanitizeLeakAnnotation(`- [rule] var/${T2}s/x/plan.md:7`)
    expect(path).not.toContain(T2)
    expect(path).toContain('ten-ants/x/plan.md:7')
  })
})
