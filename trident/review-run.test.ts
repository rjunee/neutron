import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type { HostCommandResult } from './git-mode.ts'
import type { InnerLoopInput } from './inner-loop.ts'
import { buildTridentOrchestrator } from './orchestrator.ts'
import { executeBoundReview, formatReviewEvidence } from './review-run.ts'
import { makeTridentRun } from './testing/make-trident-run.ts'

const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const DIFF = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n'
const ok = (stdout = ''): HostCommandResult => ({ ok: true, stdout, stderr: '', exit_code: 0 })

const roots: string[] = []
const artifacts: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  for (const artifact of artifacts.splice(0)) rmSync(artifact, { force: true })
})

function scratch(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `trident-review-run-${name}-`))
  roots.push(root)
  return join(root, 'detached')
}

interface RecordingHost {
  calls: string[][]
  comments: string[]
  run: (cmd: string[], cwd?: string) => Promise<HostCommandResult>
}

function recordingHost(input: {
  pr?: number
  worktree: string
  gate?: 'present' | 'absent' | 'rerun-fails'
  viewFailure?: HostCommandResult
}): RecordingHost {
  const calls: string[][] = []
  const comments: string[] = []
  const pr = input.pr ?? 515
  const run = async (cmd: string[]): Promise<HostCommandResult> => {
    calls.push(cmd)
    const joined = cmd.join(' ')
    if (joined.startsWith(`gh pr view ${pr} `)) {
      if (input.viewFailure !== undefined) return input.viewFailure
      return ok(JSON.stringify({
        headRefOid: HEAD,
        headRefName: 'feature/existing-pr',
        baseRefName: 'main',
      }))
    }
    if (joined === `gh pr diff ${pr}`) return ok(DIFF)
    if (joined.includes('worktree add --detach')) {
      mkdirSync(input.worktree, { recursive: true })
      return ok()
    }
    if (joined.includes('worktree remove')) {
      rmSync(input.worktree, { recursive: true, force: true })
      return ok()
    }
    if (joined.includes(' merge-base ')) return ok(BASE)
    if (joined.startsWith(`gh pr comment ${pr} --body-file `)) {
      comments.push(readFileSync(cmd.at(-1)!, 'utf8'))
      return ok()
    }
    if (joined.includes('check-runs?check_name=review-gate')) {
      return input.gate === 'absent' ? ok('') : ok('73')
    }
    if (joined.includes('check-suites/73/rerequest')) {
      return input.gate === 'rerun-fails'
        ? { ok: false, stdout: '', stderr: 'rerequest unavailable', exit_code: 22 }
        : ok()
    }
    return ok()
  }
  return { calls, comments, run }
}

const approvingPanel = async (
  input: Parameters<NonNullable<Parameters<typeof executeBoundReview>[1]['run_review_panel']>>[0],
) => {
  artifacts.push(input.diff_file)
  return {
    ok: true,
    verdict: 'APPROVE' as const,
    findings: [{ severity: 'minor', title: 'documented observation' }],
    reviewed_sha: HEAD,
    block_kind: 'none' as const,
    terminal_cause: null,
  }
}

describe('formatReviewEvidence', () => {
  test('emits the fenced contract with verdict, findings, and reviewed SHA', () => {
    const body = formatReviewEvidence({
      verdict: 'REQUEST_CHANGES',
      findings: [{ severity: 'blocker', title: 'Unsafe edge' }],
      reviewed_sha: HEAD,
    })

    expect(body.startsWith('```review-evidence\n')).toBe(true)
    expect(body.endsWith('\n```')).toBe(true)
    expect(body).toContain('verdict: REQUEST_CHANGES')
    expect(body).toContain(`reviewed_sha: ${HEAD}`)
    expect(body).toContain('Unsafe edge')
  })
})

describe('executeBoundReview', () => {
  test('reviews the detached bound head, posts by body-file, re-triggers the gate, and never publishes', async () => {
    const worktree = scratch('happy')
    const host = recordingHost({ worktree, gate: 'present' })
    const panelInputs: Parameters<
      NonNullable<Parameters<typeof executeBoundReview>[1]['run_review_panel']>
    >[0][] = []

    const result = await executeBoundReview(
      makeTridentRun({
        id: 'bound-happy',
        bound_pr: 515,
        branch: 'trident/prospective-name-only',
        repo_path: '/repo',
      }),
      {
        run_host: host.run,
        scratch_path: worktree,
        run_review_panel: async (input) => {
          panelInputs.push(input)
          return approvingPanel(input)
        },
      },
    )

    expect(result).toMatchObject({
      status: 'success',
      pr: 515,
      reviewed_sha: HEAD,
      verdict: 'APPROVE',
      review_gate: { status: 'triggered' },
    })
    expect(panelInputs).toHaveLength(1)
    expect(panelInputs[0]).toMatchObject({
      pr: 515,
      head_sha: HEAD,
      merge_base: BASE,
      worktree_path: worktree,
    })
    expect(readFileSync(panelInputs[0]!.diff_file, 'utf8')).toBe(DIFF)
    expect(host.comments).toHaveLength(1)
    expect(host.comments[0]).toContain('```review-evidence')
    expect(host.comments[0]).toContain(`reviewed_sha: ${HEAD}`)
    expect(existsSync(worktree)).toBe(false)

    const commands = host.calls.map((cmd) => cmd.join(' '))
    expect(commands).toContain('gh pr diff 515')
    expect(commands.some((cmd) => cmd.includes(`worktree add --detach ${worktree} ${HEAD}`))).toBe(true)
    expect(commands.some((cmd) => cmd === `chmod -R a-w ${worktree}`)).toBe(true)
    expect(commands.some((cmd) => cmd.includes('check-suites/73/rerequest'))).toBe(true)
    expect(commands.filter((cmd) => cmd.startsWith('gh pr comment 515 --body-file '))).toHaveLength(1)
    for (const command of commands) {
      expect(command).not.toMatch(/\bgit\b.*\bbranch\b/)
      expect(command).not.toMatch(/\bgit\b.*\bcommit\b/)
      expect(command).not.toMatch(/\bgit\b.*\bpush\b/)
      expect(command).not.toContain('gh pr create')
    }
    const source = readFileSync(new URL('./review-run.ts', import.meta.url), 'utf8')
    expect(source).not.toContain("from './git-mode.ts'")
    expect(source).not.toContain('publishBuiltCommit')
  })

  test('records an absent review-gate and still succeeds', async () => {
    const worktree = scratch('absent')
    const host = recordingHost({ pr: 524, worktree, gate: 'absent' })
    const result = await executeBoundReview(
      makeTridentRun({ id: 'bound-no-gate', bound_pr: 524, repo_path: '/repo' }),
      { run_host: host.run, scratch_path: worktree, run_review_panel: approvingPanel },
    )

    expect(result).toMatchObject({ status: 'success', review_gate: { status: 'absent' } })
    expect(host.calls.some((cmd) => cmd.join(' ').includes('/rerequest'))).toBe(false)
  })

  test('records a failed best-effort re-trigger and still succeeds', async () => {
    const worktree = scratch('gate-failed')
    const host = recordingHost({ worktree, gate: 'rerun-fails' })
    const result = await executeBoundReview(
      makeTridentRun({ id: 'bound-gate-failed', bound_pr: 515, repo_path: '/repo' }),
      { run_host: host.run, scratch_path: worktree, run_review_panel: approvingPanel },
    )

    expect(result).toMatchObject({ status: 'success', review_gate: { status: 'failed' } })
  })

  test('a gh pr view failure names the PR, redacts credentials, and does not enter the panel', async () => {
    const worktree = scratch('view-failure')
    const host = recordingHost({
      worktree,
      viewFailure: {
        ok: false,
        stdout: '',
        stderr: 'remote https://github_pat_secret@example.test/repo and ghp_alsosecret refused',
        exit_code: 17,
      },
    })
    let panels = 0
    const result = await executeBoundReview(
      makeTridentRun({ id: 'bound-view-failure', bound_pr: 515, repo_path: '/repo' }),
      {
        run_host: host.run,
        scratch_path: worktree,
        run_review_panel: async () => {
          panels += 1
          throw new Error('must not run')
        },
      },
    )

    expect(result.status).toBe('failure')
    if (result.status === 'failure') {
      expect(result.reason).toContain('bound PR #515')
      expect(result.reason).toContain('exit_code=17')
      expect(result.reason).toContain('https://***@example.test')
      expect(result.reason).not.toContain('github_pat_secret')
      expect(result.reason).not.toContain('ghp_alsosecret')
    }
    expect(panels).toBe(0)
    expect(host.calls).toHaveLength(1)
  })

  // REDACTION RUNS ON ATTACKER-CONTROLLED TEXT, so it has to be linear. `gh pr
  // view` prints a PR's title and body, which anyone can set on a public repo.
  // CodeQL flagged the original `(\w+:\/\/)[^/\s@]+@` as `js/polynomial-redos`
  // (high) and it was right: measured on this box, a run of word characters with
  // no scheme separator took 272ms at 20k, 1030ms at 40k and 2287ms at 60k —
  // quadratic — against 1.1ms / 1.7ms / 4.5ms once the leading quantifiers are
  // bounded. The ceiling below is ~100x the measured cost and ~1/4 of the OLD
  // cost at this size, so it is not a tight timing assertion that reds on a busy
  // box; it only catches the quantifier becoming unbounded again.
  test('redaction stays LINEAR on hostile output — the bounded quantifiers are load-bearing', async () => {
    const worktree = scratch('redos')
    const hostile = `${'0'.repeat(60_000)} ghp_realsecret`
    const host = recordingHost({
      worktree,
      viewFailure: { ok: false, stdout: '', stderr: hostile, exit_code: 9 },
    })

    const started = Bun.nanoseconds()
    const result = await executeBoundReview(
      makeTridentRun({ id: 'bound-redos', bound_pr: 515, repo_path: '/repo' }),
      {
        run_host: host.run,
        scratch_path: worktree,
        run_review_panel: async () => {
          throw new Error('must not run')
        },
      },
    )
    const elapsedMs = (Bun.nanoseconds() - started) / 1e6

    expect(result.status).toBe('failure')
    expect(elapsedMs).toBeLessThan(500)
    // POSITIVE CONTROL — the scan really did happen and really did redact, so
    // this cannot pass by the redaction having been skipped or short-circuited.
    if (result.status === 'failure') {
      expect(result.reason).toContain('bound PR #515')
      expect(result.reason).not.toContain('ghp_realsecret')
    }
  })

  test('removes the detached worktree when the panel throws', async () => {
    const worktree = scratch('panel-throws')
    const host = recordingHost({ worktree })
    const result = await executeBoundReview(
      makeTridentRun({ id: 'bound-panel-throws', bound_pr: 515, repo_path: '/repo' }),
      {
        run_host: host.run,
        scratch_path: worktree,
        run_review_panel: async (input) => {
          artifacts.push(input.diff_file)
          throw new Error('panel transport failed')
        },
      },
    )

    expect(result.status).toBe('failure')
    expect(existsSync(worktree)).toBe(false)
    expect(host.calls.some((cmd) => cmd.join(' ').includes(`worktree remove ${worktree}`))).toBe(true)
  })

  test('the production adapter reuses the existing panel in an isolated one-round resume', async () => {
    const worktree = scratch('adapter')
    const host = recordingHost({ worktree, gate: 'absent' })
    const firedInputs: InnerLoopInput[] = []
    const run = makeTridentRun({ id: 'bound-adapter', bound_pr: 515, repo_path: '/repo' })

    const result = await executeBoundReview(run, {
      run_host: host.run,
      scratch_path: worktree,
      fire_workflow: async (input) => {
        firedInputs.push(input)
        const db = ProjectDb.open(input.db_path)
        try {
          await db.run(
            `UPDATE code_trident_runs
                SET inner_checkpoint = 'argus-approved',
                    inner_checkpoint_head = ?,
                    inner_checkpoint_findings = ?,
                    inner_result = ?,
                    subagent_status = 'completed'
              WHERE id = ?`,
            [
              HEAD,
              JSON.stringify([{ severity: 'minor', title: 'adapter finding' }]),
              JSON.stringify({
                ok: true,
                verdict: 'APPROVE',
                prNumber: null,
                branch: null,
                round: 1,
                checkpoint: 'argus-approved',
                blockKind: 'none',
                remainingTasks: 0,
              }),
              input.run.id,
            ],
          )
        } finally {
          db.close()
        }
        return { status: 'fired', error: null }
      },
      sleep: async () => {},
    })

    expect(result).toMatchObject({ status: 'success', reviewed_sha: HEAD })
    expect(firedInputs).toHaveLength(1)
    const input = firedInputs[0]!
    expect(input.max_rounds).toBe(1)
    expect(input.run).toMatchObject({
      merge_mode: 'local',
      pr: null,
      branch: null,
      ralph: false,
      repo_path: worktree,
    })
    expect(input.resume_checkpoint).toBe(`outer-published:${HEAD}:0:1`)
    expect(input.resume_checkpoint_head).toBe(HEAD)
    expect(input.resume_live_head).toBe(HEAD)
    // The panel result lived in a throwaway DB, never in the durable run snapshot.
    expect(run.inner_result).toBeNull()
    artifacts.push(panelInputsDiff(input.run.id))
  })
})

function panelInputsDiff(panelId: string): string {
  return join(tmpdir(), `trident-outer-published-${panelId}.diff`)
}

describe('orchestrator bound-review dispatch', () => {
  test('a bound run lands done without a build fire or host fallthrough', async () => {
    let reviewCalls = 0
    let buildFires = 0
    const hostCalls: string[][] = []
    const { step } = buildTridentOrchestrator({
      fire_workflow: async () => {
        buildFires += 1
        return { status: 'fired', error: null }
      },
      db_path: '/tmp/not-used-bound-review.db',
      run_host: async (cmd) => {
        hostCalls.push(cmd)
        return ok()
      },
      execute_bound_review: async (run) => {
        reviewCalls += 1
        return {
          status: 'success',
          pr: run.bound_pr!,
          reviewed_sha: HEAD,
          verdict: 'APPROVE',
          findings: [],
          review_gate: { status: 'absent', detail: `review-gate absent on ${HEAD}` },
        }
      },
    })

    const outcome = await step(makeTridentRun({
      id: 'bound-dispatch',
      bound_pr: 515,
      branch: 'trident/name-that-must-not-exist',
      subagent_run_id: null,
      subagent_status: null,
    }))

    expect(reviewCalls).toBe(1)
    expect(buildFires).toBe(0)
    expect(hostCalls).toHaveLength(0)
    expect(outcome.run).toMatchObject({
      phase: 'done',
      pr: 515,
      branch: null,
      inner_checkpoint: `bound-review-complete:${HEAD}:absent`,
      inner_verdict: 'APPROVE',
      failure_reason: null,
    })
  })

  test('head resolution failure is terminal and cannot fall through to the build path', async () => {
    let buildFires = 0
    const calls: string[][] = []
    const { step } = buildTridentOrchestrator({
      fire_workflow: async () => {
        buildFires += 1
        return { status: 'fired', error: null }
      },
      db_path: '/tmp/not-used-bound-failure.db',
      run_host: async (cmd) => {
        calls.push(cmd)
        return { ok: false, stdout: '', stderr: 'target unavailable', exit_code: 23 }
      },
    })

    const outcome = await step(makeTridentRun({
      id: 'bound-resolution-failure',
      bound_pr: 515,
      branch: 'trident/prospective-only',
      subagent_run_id: null,
      subagent_status: null,
      repo_path: '/repo',
    }))

    expect(outcome.run.phase).toBe('failed')
    expect(outcome.run.failure_reason).toContain('bound PR #515')
    expect(buildFires).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.slice(0, 4)).toEqual(['gh', 'pr', 'view', '515'])
  })

  test('an unbound run still fires the ordinary build workflow', async () => {
    let reviewCalls = 0
    let buildFires = 0
    const { step } = buildTridentOrchestrator({
      fire_workflow: async () => {
        buildFires += 1
        return { status: 'fired', error: null }
      },
      db_path: '/tmp/not-used-build-control.db',
      run_host: async () => ok(),
      base_branch: 'main',
      mint_run_id: () => 'control-fire-id',
      execute_bound_review: async () => {
        reviewCalls += 1
        throw new Error('must not run')
      },
    })

    const outcome = await step(makeTridentRun({
      id: 'unbound-control',
      bound_pr: null,
      branch: 'trident/ordinary-build',
      subagent_run_id: null,
      subagent_status: null,
      repo_path: '/repo',
    }))

    expect(reviewCalls).toBe(0)
    expect(buildFires).toBe(1)
    expect(outcome.waiting).toBe(true)
    expect(outcome.run.subagent_run_id).toBe('control-fire-id')
  })
})
