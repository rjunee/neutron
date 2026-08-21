/**
 * @neutronai/trident — the ONE test-fixture factory for `TridentRun`.
 *
 * Every hand-written full `TridentRun` object literal in a test is a tax:
 * adding a required column to `code_trident_runs` broke up to 14 fixtures per
 * branch, always at merge time, always with the same one-line edit. This
 * factory holds the complete default row ONCE — adding a field to `TridentRun`
 * means adding its default HERE and nowhere else. Tests override only the
 * fields they actually care about.
 *
 * TEST-ONLY by convention: never import from production code. A guard test
 * (`trident/__tests__/no-handrolled-trident-run-fixtures.test.ts`) fails any
 * test file that spells a full literal instead of calling this.
 */

import type { TridentRun } from '../store.ts'

export function makeTridentRun(over: Partial<TridentRun> = {}): TridentRun {
  return {
    id: 'id-1',
    slug: 'slug-1',
    project_slug: 't1',
    phase: 'forge-init',
    round: 1,
    max_rounds: 8,
    ralph: false,
    ralph_round: 0,
    max_ralph_rounds: 20,
    branch: null,
    base_sha: null,
    base_behind: null,
    pr: null,
    merge_mode: 'local',
    subagent_run_id: 'agent-1',
    subagent_status: 'running',
    repo_path: '/r',
    worktree: null,
    task: 't',
    chat_id: null,
    thread_id: null,
    channel_kind: 'telegram',
    failure_reason: null,
    brief_alert: null,
    workflow_run_id: null,
    inner_checkpoint: null,
    inner_checkpoint_head: null,
    inner_checkpoint_findings: null,
    inner_verdict: null,
    inner_result: null,
    started_at: '2026-01-01T00:00:00.000Z',
    last_advanced_at: '2026-01-01T00:00:00.000Z',
    harvested_at: null,
    crash_recoveries: 0,
    infra_retries: 0,
    reviewed_head: null,
    bound_pr: null,
    fenced_paths: null,
    parent_run_id: null,
    wave_task_id: null,
    ...over,
  }
}
