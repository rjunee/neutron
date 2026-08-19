/**
 * Review an existing, bound pull request without entering Trident's build or
 * publisher paths.
 *
 * This module owns only the review-only pipeline. It deliberately has no
 * dependency on the outer publisher, merge cleanup, or any branch/commit/push
 * helper. The existing panel stays single-sourced in `inner-workflow.mjs`: the
 * production adapter below fires that workflow against an isolated scratch DB
 * with its already-supported one-round `outer-published:<sha>:0:1` resume
 * contract. The isolation is load-bearing. If the host process dies after the
 * panel writes its result, a later outer tick cannot mistake that result for a
 * build result and reach `applyResult`.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  parseCheckpointFindings,
  parseInnerResult,
  type TridentWorkflowFirer,
} from './inner-loop.ts'
import type { TridentRun } from './store.ts'

type ReviewVerdict = 'APPROVE' | 'REQUEST_CHANGES'

interface HostResult {
  ok: boolean
  stdout: string
  stderr: string
  exit_code: number
  timed_out?: boolean
}

interface ReviewPanelInput {
  run: TridentRun
  pr: number
  head_sha: string
  merge_base: string
  worktree_path: string
  diff_file: string
}

interface ReviewPanelResult {
  ok: boolean
  verdict: ReviewVerdict | null
  findings: unknown[]
  reviewed_sha: string | null
  block_kind: 'none' | 'code' | 'infra-only' | 'round-lost' | null
  terminal_cause: string | null
  publish_requested?: boolean
  pr_merged?: boolean
}

interface ReviewRunDeps {
  run_host: (cmd: string[], cwd?: string) => Promise<HostResult>
  fire_workflow?: TridentWorkflowFirer
  codex_home?: string | null
  gh_data_dir?: string | null
  gh_owner_handle?: string | null
  kimi_configured?: boolean
  phase_models?: Record<string, { model?: string; effort?: string }> | null
  panel_timeout_ms?: number
  run_review_panel?: (input: ReviewPanelInput) => Promise<ReviewPanelResult>
  scratch_path?: string
  sleep?: (ms: number) => Promise<void>
}

export type ReviewGateOutcome =
  | { status: 'triggered'; detail: string }
  | { status: 'absent'; detail: string }
  | { status: 'failed'; detail: string }

export type BoundReviewOutcome =
  | {
      status: 'success'
      pr: number
      reviewed_sha: string
      verdict: ReviewVerdict
      findings: unknown[]
      review_gate: ReviewGateOutcome
    }
  | { status: 'failure'; pr: number; reason: string }

interface PanelRow {
  inner_result: string | null
  inner_checkpoint_head: string | null
  inner_checkpoint_findings: string | null
}

interface BoundPrView {
  headRefOid: string
  headRefName: string
  baseRefName: string
}

const SHA = /^[0-9a-f]{40}$/
const DEFAULT_PANEL_TIMEOUT_MS = 2 * 60 * 60_000
const PANEL_POLL_MS = 1_000

function redactMeasured(text: string): string {
  return text
    .replace(/(\w+:\/\/)[^/\s@]+@/g, '$1***@')
    .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '$1***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500)
}

function commandEvidence(result: HostResult): string {
  const said = redactMeasured(result.stderr || result.stdout)
  const token = result.timed_out === true ? 'timed_out=true' : `exit_code=${result.exit_code}`
  return said === '' ? token : `${token}; ${said}`
}

function failure(pr: number, detail: string): BoundReviewOutcome {
  return {
    status: 'failure',
    pr,
    reason: `bound PR #${pr} review-only execution failed: ${redactMeasured(detail)}`,
  }
}

function safeRunToken(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 120)
}

function panelRunId(run: TridentRun): string {
  return `${safeRunToken(run.id)}-review-panel`
}

function panelDiffPath(run: TridentRun): string {
  // This is the exact path the existing workflow's outer-published resume reads.
  return join(tmpdir(), `trident-outer-published-${panelRunId(run)}.diff`)
}

function panelDbPath(run: TridentRun): string {
  return join(tmpdir(), `trident-bound-review-panel-${safeRunToken(run.id)}.sqlite`)
}

function removePanelDb(path: string): void {
  rmSync(path, { force: true })
  rmSync(`${path}-shm`, { force: true })
  rmSync(`${path}-wal`, { force: true })
}

/**
 * Render the durable comment contract consumed by `review-gate`.
 *
 * The formatter is deliberately pure. Triple backticks inside a finding are
 * JSON-escaped so panel-authored text cannot terminate the evidence fence.
 */
export function formatReviewEvidence(input: {
  verdict: ReviewVerdict
  findings: unknown[]
  reviewed_sha: string
  run_id?: string
}): string {
  let findings: string
  try {
    findings = JSON.stringify(input.findings, null, 2)
  } catch {
    findings = JSON.stringify([
      {
        severity: 'blocker',
        title: 'Review findings could not be serialized',
        evidence: 'The panel returned a cyclic or otherwise non-JSON findings value.',
      },
    ], null, 2)
  }
  findings = findings.replaceAll('```', '\\u0060\\u0060\\u0060')
  return [
    '```review-evidence',
    `verdict: ${input.verdict}`,
    `reviewed_sha: ${input.reviewed_sha}`,
    ...(input.run_id === undefined ? [] : [`run_id: ${input.run_id}`]),
    'findings:',
    findings,
    '```',
  ].join('\n')
}

async function realSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function initialisePanelDb(path: string, id: string): Promise<void> {
  removePanelDb(path)
  const db = ProjectDb.open(path)
  try {
    db.exec(`CREATE TABLE code_trident_runs (
      id TEXT PRIMARY KEY,
      phase TEXT NOT NULL,
      round INTEGER NOT NULL,
      pr INTEGER,
      branch TEXT,
      inner_checkpoint TEXT,
      inner_checkpoint_head TEXT,
      inner_checkpoint_findings TEXT,
      inner_result TEXT,
      subagent_status TEXT,
      inner_verdict TEXT,
      last_advanced_at TEXT NOT NULL
    )`)
    await db.run(
      `INSERT INTO code_trident_runs
        (id, phase, round, inner_result, subagent_status, last_advanced_at)
       VALUES (?, 'forge-init', 1, NULL, NULL, ?)`,
      [id, new Date().toISOString()],
    )
  } finally {
    db.close()
  }
}

/**
 * Invoke the existing review panel through its established firer/result seam.
 *
 * `merge_mode: 'local'` suppresses the circular PR-readiness dependency: this
 * review is producing the missing `review-gate`. The outer-published resume and
 * one-round cap skip Forge and the fix loop while retaining the existing rubric,
 * adversarial, cross-model, synthesis, retry, and completeness lanes.
 */
async function runExistingReviewPanel(
  input: ReviewPanelInput,
  deps: ReviewRunDeps,
): Promise<ReviewPanelResult> {
  if (deps.fire_workflow === undefined) {
    throw new Error('existing review panel firer was not wired')
  }
  const id = panelRunId(input.run)
  if (input.diff_file !== panelDiffPath(input.run)) {
    throw new Error('panel diff path did not match the existing outer-published resume contract')
  }
  const dbPath = panelDbPath(input.run)
  await initialisePanelDb(dbPath, id)

  const panelRun: TridentRun = {
    ...input.run,
    id,
    branch: null,
    pr: null,
    merge_mode: 'local',
    ralph: false,
    worktree: input.worktree_path,
    repo_path: input.worktree_path,
    inner_result: null,
    inner_checkpoint: null,
    inner_checkpoint_head: null,
    inner_checkpoint_findings: null,
  }
  try {
    const fired = await deps.fire_workflow({
      run: panelRun,
      base_branch: input.merge_base,
      base_sha: input.merge_base,
      db_path: dbPath,
      max_rounds: 1,
      resume_checkpoint: `outer-published:${input.head_sha}:0:1`,
      resume_checkpoint_head: input.head_sha,
      resume_live_head: input.head_sha,
      resume_findings: null,
      codex_home: deps.codex_home ?? null,
      gh_data_dir: deps.gh_data_dir ?? null,
      gh_owner_handle: deps.gh_owner_handle ?? null,
      kimi_configured: deps.kimi_configured === true,
      reflection_context: null,
      test_strategy: null,
      ...(deps.phase_models !== undefined ? { phase_models: deps.phase_models } : {}),
    })
    if (fired.status !== 'fired') {
      throw new Error(`existing review panel fire returned failed: ${fired.error ?? 'empty error'}`)
    }

    const db = ProjectDb.open(dbPath, { readonly: true, create: false })
    const started = Date.now()
    const timeout = deps.panel_timeout_ms ?? DEFAULT_PANEL_TIMEOUT_MS
    try {
      for (;;) {
        const row = db.get<PanelRow, [string]>(
          `SELECT inner_result, inner_checkpoint_head, inner_checkpoint_findings
             FROM code_trident_runs WHERE id = ?`,
          [id],
        )
        if (row === null) throw new Error(`isolated panel row ${id} disappeared`)
        if (row.inner_result !== null && row.inner_result.trim() !== '') {
          const result = parseInnerResult(row.inner_result)
          if (result === null) {
            throw new Error(`panel wrote an unparseable inner_result: ${row.inner_result.slice(0, 160)}`)
          }
          return {
            ok: result.ok,
            verdict: result.verdict,
            findings: parseCheckpointFindings(row.inner_checkpoint_findings),
            reviewed_sha:
              typeof row.inner_checkpoint_head === 'string' && SHA.test(row.inner_checkpoint_head)
                ? row.inner_checkpoint_head
                : null,
            block_kind: result.block_kind,
            terminal_cause: result.terminal_cause,
            ...(result.publish_requested === undefined
              ? {}
              : { publish_requested: result.publish_requested }),
            ...(result.pr_merged === undefined ? {} : { pr_merged: result.pr_merged }),
          }
        }
        if (Date.now() - started >= timeout) {
          throw new Error(`panel inner_result remained empty for ${timeout}ms`)
        }
        await (deps.sleep ?? realSleep)(PANEL_POLL_MS)
      }
    } finally {
      db.close()
    }
  } finally {
    // The durable run never points at this DB. Removing it cannot erase run state;
    // it only prevents a late panel write from being mistaken for a future attempt.
    removePanelDb(dbPath)
  }
}

function parseBoundPrView(stdout: string): BoundPrView | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const value = parsed as Record<string, unknown>
  const headRefOid = typeof value.headRefOid === 'string' ? value.headRefOid.trim().toLowerCase() : ''
  const headRefName = typeof value.headRefName === 'string' ? value.headRefName.trim() : ''
  const baseRefName = typeof value.baseRefName === 'string' ? value.baseRefName.trim() : ''
  if (!SHA.test(headRefOid) || headRefName === '' || baseRefName === '') return null
  return { headRefOid, headRefName, baseRefName }
}

function looksAbsent(result: HostResult): boolean {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase()
  return /\b404\b|not found|no check runs?/.test(text)
}

async function retriggerReviewGate(
  deps: ReviewRunDeps,
  repo: string,
  head: string,
): Promise<ReviewGateOutcome> {
  let found: HostResult
  try {
    found = await deps.run_host(
      [
        'gh',
        'api',
        `repos/{owner}/{repo}/commits/${head}/check-runs?check_name=review-gate&per_page=100`,
        '--jq',
        '.check_runs[0].check_suite.id // empty',
      ],
      repo,
    )
  } catch (err) {
    return {
      status: 'failed',
      detail: `review-gate lookup threw: ${redactMeasured(err instanceof Error ? err.message : String(err))}`,
    }
  }
  if (!found.ok) {
    return looksAbsent(found)
      ? { status: 'absent', detail: `review-gate absent on ${head}: ${commandEvidence(found)}` }
      : { status: 'failed', detail: `review-gate lookup ${commandEvidence(found)}` }
  }
  const suiteId = found.stdout.trim()
  if (suiteId === '') return { status: 'absent', detail: `review-gate absent on ${head}` }
  if (!/^\d+$/.test(suiteId)) {
    return {
      status: 'failed',
      detail: `review-gate lookup returned non-numeric check-suite id ${JSON.stringify(suiteId.slice(0, 100))}`,
    }
  }

  let rerun: HostResult
  try {
    rerun = await deps.run_host(
      ['gh', 'api', '--method', 'POST', `repos/{owner}/{repo}/check-suites/${suiteId}/rerequest`],
      repo,
    )
  } catch (err) {
    return {
      status: 'failed',
      detail: `review-gate check suite ${suiteId} rerequest threw: ${redactMeasured(err instanceof Error ? err.message : String(err))}`,
    }
  }
  return rerun.ok
    ? { status: 'triggered', detail: `review-gate check suite ${suiteId} rerequested` }
    : { status: 'failed', detail: `review-gate check suite ${suiteId} rerequest ${commandEvidence(rerun)}` }
}

/**
 * Execute exactly one review-only round for `run.bound_pr`.
 *
 * Every GitHub and git command crosses the orchestrator's credentialed host
 * runner. The only git mutation is lifecycle management of one exact detached
 * worktree, removed in `finally` on both success and failure.
 */
export async function executeBoundReview(
  run: TridentRun,
  deps: ReviewRunDeps,
): Promise<BoundReviewOutcome> {
  const pr = run.bound_pr
  if (pr === null) return failure(0, 'executor received a run whose bound_pr was null')

  const repo = run.repo_path
  const worktree = deps.scratch_path ?? join(repo, '.trident-worktrees', `bound-review-${safeRunToken(run.id)}`)
  const diffFile = panelDiffPath(run)
  const commentFile = join(tmpdir(), `trident-review-evidence-${safeRunToken(run.id)}.md`)
  let worktreeAdded = false
  let outcome: BoundReviewOutcome
  const cleanupErrors: string[] = []

  try {
    const viewed = await deps.run_host(
      ['gh', 'pr', 'view', String(pr), '--json', 'headRefOid,headRefName,baseRefName'],
      repo,
    )
    if (!viewed.ok) throw new Error(`gh pr view failed: ${commandEvidence(viewed)}`)
    const target = parseBoundPrView(viewed.stdout)
    if (target === null) {
      throw new Error(`gh pr view returned malformed target metadata: ${redactMeasured(viewed.stdout)}`)
    }
    const head = target.headRefOid

    const diffed = await deps.run_host(['gh', 'pr', 'diff', String(pr)], repo)
    if (!diffed.ok) throw new Error(`gh pr diff failed: ${commandEvidence(diffed)}`)
    if (diffed.stdout.trim() === '') throw new Error('gh pr diff returned an empty diff')
    writeFileSync(diffFile, diffed.stdout.endsWith('\n') ? diffed.stdout : `${diffed.stdout}\n`, 'utf8')

    const fetched = await deps.run_host(
      [
        'git',
        '-C',
        repo,
        'fetch',
        '--no-tags',
        'origin',
        head,
        `+refs/heads/${target.baseRefName}:refs/remotes/origin/${target.baseRefName}`,
      ],
      repo,
    )
    if (!fetched.ok) throw new Error(`fetch of ${head} failed: ${commandEvidence(fetched)}`)

    mkdirSync(dirname(worktree), { recursive: true })
    if (existsSync(worktree)) {
      await deps.run_host(['chmod', '-R', 'u+w', worktree], repo)
      const stale = await deps.run_host(['git', '-C', repo, 'worktree', 'remove', worktree], repo)
      if (!stale.ok || existsSync(worktree)) {
        throw new Error(`stale detached worktree cleanup failed: ${commandEvidence(stale)}`)
      }
    }

    const added = await deps.run_host(
      ['git', '-C', repo, 'worktree', 'add', '--detach', worktree, head],
      repo,
    )
    if (!added.ok) throw new Error(`detached worktree add failed: ${commandEvidence(added)}`)
    worktreeAdded = true

    const based = await deps.run_host(
      ['git', '-C', worktree, 'merge-base', head, `origin/${target.baseRefName}`],
      worktree,
    )
    const mergeBase = based.stdout.trim().toLowerCase()
    if (!based.ok || !SHA.test(mergeBase)) {
      throw new Error(`merge-base for ${head} failed: ${commandEvidence(based)}`)
    }

    const sealed = await deps.run_host(['chmod', '-R', 'a-w', worktree], repo)
    if (!sealed.ok) throw new Error(`read-only worktree seal failed: ${commandEvidence(sealed)}`)

    const panel = await (deps.run_review_panel ?? ((input) => runExistingReviewPanel(input, deps)))({
      run,
      pr,
      head_sha: head,
      merge_base: mergeBase,
      worktree_path: worktree,
      diff_file: diffFile,
    })
    if (
      !panel.ok ||
      panel.verdict === null ||
      panel.block_kind === 'infra-only' ||
      panel.block_kind === 'round-lost' ||
      panel.publish_requested === true ||
      panel.pr_merged === true
    ) {
      const measured = [
        `ok=${String(panel.ok)}`,
        `verdict=${String(panel.verdict)}`,
        `block_kind=${String(panel.block_kind)}`,
        `publish_requested=${String(panel.publish_requested === true)}`,
        panel.terminal_cause === null ? '' : `terminal_cause=${panel.terminal_cause}`,
      ].filter(Boolean).join('; ')
      throw new Error(`review panel did not produce usable review-only evidence: ${measured}`)
    }
    if (panel.reviewed_sha !== head) {
      throw new Error(
        `review panel recorded reviewed_sha=${String(panel.reviewed_sha)} while bound head was ${head}`,
      )
    }

    writeFileSync(commentFile, formatReviewEvidence({
      verdict: panel.verdict,
      findings: panel.findings,
      reviewed_sha: head,
      run_id: run.id,
    }), 'utf8')
    const commented = await deps.run_host(
      ['gh', 'pr', 'comment', String(pr), '--body-file', commentFile],
      repo,
    )
    if (!commented.ok) throw new Error(`gh pr comment failed: ${commandEvidence(commented)}`)

    outcome = {
      status: 'success',
      pr,
      reviewed_sha: head,
      verdict: panel.verdict,
      findings: panel.findings,
      review_gate: await retriggerReviewGate(deps, repo, head),
    }
  } catch (err) {
    outcome = failure(pr, err instanceof Error ? err.message : String(err))
  } finally {
    try {
      rmSync(commentFile, { force: true })
    } catch (err) {
      // A temp-comment cleanup fault must not skip the detached-worktree cleanup
      // below. Report both after every cleanup step has had its chance to run.
      cleanupErrors.push(`comment file remove threw ${err instanceof Error ? err.message : String(err)}`)
    }
    if (worktreeAdded) {
      try {
        const writable = await deps.run_host(['chmod', '-R', 'u+w', worktree], repo)
        if (!writable.ok) cleanupErrors.push(`permission restore ${commandEvidence(writable)}`)
      } catch (err) {
        cleanupErrors.push(`permission restore threw ${err instanceof Error ? err.message : String(err)}`)
      }
      try {
        const removed = await deps.run_host(
          ['git', '-C', repo, 'worktree', 'remove', worktree],
          repo,
        )
        if (!removed.ok) cleanupErrors.push(`worktree remove ${commandEvidence(removed)}`)
      } catch (err) {
        cleanupErrors.push(`worktree remove threw ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  if (cleanupErrors.length > 0) {
    const cleanup = cleanupErrors.join('; ')
    return outcome.status === 'failure'
      ? failure(pr, `${outcome.reason}; cleanup: ${cleanup}`)
      : failure(pr, `review evidence was posted but detached worktree cleanup failed: ${cleanup}`)
  }
  return outcome
}
