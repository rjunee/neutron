import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type { HostCommandResult } from './git-mode.ts'
import type { FireOutcome, InnerLoopInput } from './inner-loop.ts'
import { buildSimFirer, SIM_REVIEWED_HEAD, type SimPlan } from './inner-loop-sim.ts'
import {
  buildTridentOrchestrator,
  isTridentHarvestTerminal,
  resolveResumeLiveHead,
  RESUME_HEAD_RETRY_DELAYS_MS,
} from './orchestrator.ts'
import { MAX_CONFLICT_ROUNDS, runWorktreePath } from './merge.ts'
import { isTerminalPhase } from './state-machine.ts'
import { TridentRunStore, type MergeMode, type TridentRun } from './store.ts'
import { TridentTickLoop, type TridentTerminalHook } from './tick.ts'
import { NexusStore } from '@neutronai/gateway/nexus/nexus-store.ts'
import { emitTridentTerminalEvents } from '@neutronai/gateway/nexus/nexus-emit.ts'

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
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
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

interface Harness {
  loop: TridentTickLoop
  /** Flush queued workflow completions (write their `inner_result` to the DB). */
  complete: () => Promise<void>
  hostCalls: string[][]
  inputs: InnerLoopInput[]
  /** RALPH RE-FIRE (#362) — every atomic reset patch `persist_refire_reset` was
   *  called with (assert the crash-safe bundle: inner_result + slot + ralph_round). */
  refirePatches: import('./store.ts').TridentRunUpdate[]
}

function buildHarness(opts: {
  plan: (input: InnerLoopInput) => SimPlan
  hostResponder?: (cmd: string[]) => HostCommandResult
  on_orphaned_session?: 'redispatch' | 'wait' | 'fail'
  mint_run_id?: () => string
  now?: () => string
  max_inflight_ms?: number
  no_advance_hang_ms?: number
  codex_home?: string | null
  resolve_codex_home?: (run: TridentRun) => string | null
  resolve_reflection_context?: (run: TridentRun) => string | null
  resolve_active_runs?: () => number
  resolve_conflict?: import('./merge.ts').MergeConflictResolver
  on_terminal?: TridentTerminalHook
}): Harness {
  const hostCalls: string[][] = []
  const refirePatches: import('./store.ts').TridentRunUpdate[] = []
  const now = opts.now ?? (() => new Date(0).toISOString())
  // Bind the store to the SAME clock as the orchestrator so `last_advanced_at`
  // (re-stamped by store.save) and the orchestrator's stall computation share one
  // time base — production runs both on wall-clock; the tests run both on the
  // fake clock (mismatched clocks would make `elapsedSinceAdvance` meaningless).
  store = new TridentRunStore(db, now)
  const sim = buildSimFirer(store, opts.plan)
  const host = async (cmd: string[]): Promise<HostCommandResult> => {
    hostCalls.push(cmd)
    if (cmd.join(' ').includes('rev-parse --is-shallow-repository')) return ok('false')
    return opts.hostResponder ? opts.hostResponder(cmd) : ok()
  }
  const o: Parameters<typeof buildTridentOrchestrator>[0] = {
    fire_workflow: sim.fire_workflow,
    db_path: join(tmp, 'project.db'),
    run_host: host,
    base_branch: 'main',
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
  if (opts.on_orphaned_session !== undefined) o.on_orphaned_session = opts.on_orphaned_session
  if (opts.mint_run_id !== undefined) o.mint_run_id = opts.mint_run_id
  if (opts.max_inflight_ms !== undefined) o.max_inflight_ms = opts.max_inflight_ms
  if (opts.no_advance_hang_ms !== undefined) o.no_advance_hang_ms = opts.no_advance_hang_ms
  if (opts.codex_home !== undefined) o.codex_home = opts.codex_home
  if (opts.resolve_codex_home !== undefined) o.resolve_codex_home = opts.resolve_codex_home
  if (opts.resolve_reflection_context !== undefined)
    o.resolve_reflection_context = opts.resolve_reflection_context
  if (opts.resolve_active_runs !== undefined) o.resolve_active_runs = opts.resolve_active_runs
  if (opts.resolve_conflict !== undefined) o.resolve_conflict = opts.resolve_conflict
  const orch = buildTridentOrchestrator(o)
  const loop = new TridentTickLoop({
    store,
    step: orch.step,
    ...(opts.on_terminal !== undefined ? { on_terminal: opts.on_terminal } : {}),
  })
  return { loop, complete: sim.drain, hostCalls, inputs: sim.inputs, refirePatches }
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

describe('orchestrator — APPROVE → done → merge (server-gated)', () => {
  test('pr mode publishes in the outer loop and confirms origin before re-firing review', async () => {
    const head = 'abcdef0123456789abcdef0123456789abcdef01'
    // The remote must be BEHIND the local head, or the zero-ahead gate ("nothing was built")
    // correctly refuses to publish a branch that is already fully pushed.
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

  /**
   * THE DEVIATION SUFFIX IS THE ONLY THING THAT SURVIVES THE PROCESS BOUNDARY in pr
   * mode. The build invocation exits at the publish handoff, so the Forge that
   * reported it deviated from its exec spec is long gone by the time the SECOND
   * invocation writes `ralph-task-built*`. The outer publisher's checkpoint string
   * is the only channel between them — drop the suffix here and the next iteration
   * silently plans from a document the build no longer matches.
   */
  test('a publish handoff carrying deviatedFromSpec suffixes the outer-published checkpoint', async () => {
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
                publishHead: head,
                remainingTasks: 2,
                deviatedFromSpec: true,
              },
            }
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
        if (joined.includes('gh pr list')) return ok('42')
        return ok()
      },
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode, ralph: true })

    await runToTerminal(h, run.id)

    // Both the persisted patch and the relaunch input carry it — the row is what a
    // crashed outer loop re-reads, the input is what the workflow actually parses.
    expect(h.refirePatches[0]?.inner_checkpoint).toBe(`outer-published:${head}:2:1:deviated`)
    expect(h.inputs[1]!.resume_checkpoint).toBe(`outer-published:${head}:2:1:deviated`)
    // …and the suffix must not break the recorded-OID extraction the live-head read
    // is gated on, or the resume would rebuild for the wrong reason.
    expect(h.inputs[1]!.resume_live_head).toBe(head)
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

  test('the outer publisher refuses a commit that is not the local branch tip — naming BOTH values', async () => {
    const requested = 'abcdef0123456789abcdef0123456789abcdef01'
    const resolved = '1111111111111111111111111111111111111111'
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', publishRequested: true, publishHead: requested } }),
      hostResponder: (cmd) => cmd.join(' ').includes('rev-parse --verify refs/heads/feat-x')
        ? ok(resolved)
        : ok(),
    })
    const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)
    expect(final.phase).toBe('failed')
    // A disagreement is a real signal (wrong branch/worktree). Neither value may be
    // silently preferred, so the reason has to carry both verbatim to be actionable.
    expect(final.failure_reason).toContain(requested)
    expect(final.failure_reason).toContain(resolved)
    // …and it must not blame a review that never ran.
    expect(final.failure_reason).not.toContain('Argus')
    expect(h.hostCalls.map((c) => c.join(' ')).some((c) => c.includes(' push '))).toBe(false)
    expect(h.inputs).toHaveLength(1)
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
    expect(calls.some((c) => /\s--force(\s|$)/.test(c))).toBe(false)
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
    expect(calls.some((c) => c.includes('worktree add'))).toBe(false)
    expect(calls.some((c) => c.includes('apply --3way'))).toBe(false)
    expect(calls.some((c) => c.includes('gh pr diff'))).toBe(false)
    // The build's own head is published, untouched — the lease is pinned to what the remote
    // actually held, and the checkpoint carries the UNREBASED head.
    expect(calls.some((c) => c.includes(`--force-with-lease=refs/heads/feat-x:${stale}`))).toBe(true)
    expect(h.refirePatches[0]?.inner_checkpoint).toBe(`outer-published:${head}:0:1`)
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
    // last word — production's `writeTerminalResult` normalises every non-APPROVE result to
    // REQUEST_CHANGES before this step ever runs; the rebase stamps no verdict of its own.)
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
    // Full-length and abbreviated: the prefix check must catch BOTH, or an abbreviation
    // silently becomes "accept anything".
    for (const claimed of ['f'.repeat(40), 'baddad1']) {
      const h = buildHarness({
        plan: () => ({
          result: { verdict: 'REQUEST_CHANGES', branch: 'feat-x', publishRequested: true, publishHead: claimed },
        }),
        hostResponder: (cmd) => {
          const joined = cmd.join(' ')
          if (/rev-parse (--verify )?refs\/heads\/feat-x/.test(joined)) return ok(head)
          return ok()
        },
      })
      const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)
      const calls = h.hostCalls.map((c) => c.join(' '))

      expect(final.phase).toBe('failed')
      expect(final.failure_reason).toContain(claimed)
      expect(final.failure_reason).toContain(head)
      expect(final.failure_reason).not.toContain('Argus')
      expect(calls.some((c) => c.includes(' push '))).toBe(false)
      expect(calls.some((c) => c.includes('gh pr create'))).toBe(false)
      expect(h.inputs).toHaveLength(1)
    }
  })

  test('zero commits ahead of the remote still fails — "nothing was built" is a real outcome', async () => {
    // Reading the head from git must not convert a build that committed nothing into a
    // publish of the remote back onto itself.
    const { h } = publishFixture({ publishHead: null }, true)
    const final = await runToTerminal(h, (await createRun({ merge_mode: 'pr' as MergeMode })).id)
    const calls = h.hostCalls.map((c) => c.join(' '))

    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('no new commits')
    expect(final.failure_reason).toContain('feat-x')
    expect(final.failure_reason).not.toContain('Argus')
    expect(calls.some((c) => c.includes(' push '))).toBe(false)
    expect(calls.some((c) => c.includes('gh pr create'))).toBe(false)
    expect(h.inputs).toHaveLength(1)
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
        cmd[0] === 'gh'
          ? {
              ok: false,
              stdout: '',
              stderr: 'failed to merge pull request: Head branch was modified. Review and try the merge again.',
              exit_code: 1,
            }
          : ok(),
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
    expect(final.inner_verdict).toBe('REQUEST_CHANGES')
    expect(h.hostCalls.map((c) => c.join(' ')).some((c) => c.includes('pr merge'))).toBe(false)
  })
})

describe('orchestrator — REQUEST_CHANGES (maxRounds exhausted) → failed', () => {
  test('a REQUEST_CHANGES inner result fails the run without merging', async () => {
    const h = buildHarness({
      plan: () => ({ result: { verdict: 'REQUEST_CHANGES', round: 3, prNumber: 7, branch: 'feat-x' } }),
    })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('without Argus APPROVE')
    expect(final.inner_verdict).toBe('REQUEST_CHANGES')
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
      hostResponder: (cmd) => (cmd.includes('pr') && cmd.includes('list') ? ok('99') : ok()),
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
    expect(after?.failure_reason).toContain('suspected agent hang')
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
    expect(after?.failure_reason).toContain('suspected agent hang')
    // Reaped, NOT redispatched.
    expect(h.inputs).toHaveLength(0)
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
    expect(after?.failure_reason).toContain('orphaned')
    expect(h.inputs).toHaveLength(0)
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
    // A run that never harvests (stalls) → reaped to failed with inner_verdict
    // null. The post-commit hook fires, but the producer emits nothing.
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
    expect(final?.inner_verdict).toBeNull()
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

  test("a 'ralph-task-built' checkpoint is exempt — the fire still happens on an unreadable head", async () => {
    const h = unreadable()
    const run = await resumeRun({ inner_checkpoint: 'ralph-task-built' })
    await launchOnce(h)
    expect(h.inputs).toHaveLength(1)
    expect(h.inputs[0]!.resume_live_head).toBe('')
    expect(store.get(run.id)!.phase).not.toBe('failed')
  })

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

  test('a FRESH launch is byte-identical: no head read, no field at all', async () => {
    const h = buildHarness({ plan: () => ({ result: { verdict: 'APPROVE', branch: 'feat-x' } }) })
    await createRun({ merge_mode: 'pr' as MergeMode })
    await launchOnce(h)

    expect(h.inputs).toHaveLength(1)
    expect('resume_live_head' in h.inputs[0]!).toBe(false)
    const calls = h.hostCalls.map((c) => c.join(' '))
    expect(calls.some((c) => c.includes('ls-remote --heads origin refs/heads/feat-x'))).toBe(false)
    expect(calls.some((c) => c.includes('rev-parse'))).toBe(false)
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
