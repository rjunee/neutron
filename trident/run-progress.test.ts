import { describe, expect, test } from 'bun:test'

import {
  deriveRunProgress,
  deriveStepLabel,
  runProgressForItem,
  STALLED_WARN_MS,
} from './run-progress.ts'
import type { TridentPhase, TridentRun } from './store.ts'
import { makeTridentRun } from './testing/make-trident-run.ts'

const T0 = Date.parse('2026-07-02T00:00:00Z')

function run(over: Partial<TridentRun> = {}): TridentRun {
  return makeTridentRun({
    id: 'run-1',
    slug: 'demo',
    project_slug: 'owner',
    branch: 'trident/demo',
    merge_mode: 'pr',
    subagent_run_id: 'wf-1',
    repo_path: '/repo',
    task: 'build a thing',
    channel_kind: 'app_socket',
    workflow_run_id: 'wf-1',
    started_at: '2026-07-02T00:00:00Z',
    last_advanced_at: '2026-07-02T00:00:00Z',
    ...over,
  })
}

describe('deriveRunProgress — phase/checkpoint → label', () => {
  test('a fresh forge-init run with no checkpoint is "planning"', () => {
    const p = deriveRunProgress(run(), T0 + 30_000)
    expect(p.phase_label).toBe('planning')
    expect(p.round).toBe(1)
    expect(p.elapsed_ms).toBe(30_000)
    expect(p.stalled).toBe(false)
  })

  test('forge-done checkpoint → reviewing', () => {
    const p = deriveRunProgress(run({ inner_checkpoint: 'forge-done' }), T0)
    expect(p.phase_label).toBe('reviewing')
  })

  test('argus-request-changes checkpoint → building (a fix round is starting)', () => {
    const p = deriveRunProgress(run({ inner_checkpoint: 'argus-request-changes' }), T0)
    expect(p.phase_label).toBe('building')
  })

  // FIX #336 — a `fixing` step (post-review) must show round ≥ 2, never the
  // contradictory "round 1" (the outer `run.round` stays 1 for the whole
  // in-process workflow; the round is derived off the inner checkpoint).
  test('argus-request-changes (fixing) surfaces round 2, not the outer round 1', () => {
    const p = deriveRunProgress(run({ round: 1, inner_checkpoint: 'argus-request-changes' }), T0)
    expect(p.step_label).toBe('fixing')
    expect(p.round).toBe(2)
  })

  test('a round-bearing request-changes checkpoint surfaces the following fix round', () => {
    const p = deriveRunProgress(run({ round: 1, inner_checkpoint: 'argus-request-changes-round-7' }), T0)
    expect(p.step_label).toBe('fixing')
    expect(p.phase_label).toBe('building')
    expect(p.round).toBe(8)
  })

  test('a first build (no checkpoint) stays round 1', () => {
    const p = deriveRunProgress(run({ round: 1, inner_checkpoint: null }), T0)
    expect(p.step_label).toBe('building')
    expect(p.round).toBe(1)
  })

  test('fix-round-N checkpoint → REVIEWING round N (the fix is already built)', () => {
    // This asserted 'building' and was wrong, in a way this same file already
    // contradicted: `deriveStepLabel` has always answered 'reviewing' for this
    // checkpoint, so one snapshot carried `phase_label: 'building'` beside
    // `step_label: 'reviewing'`. The authority is the resume classifier —
    // `inner-workflow.mjs` `classifyResume`: "`forge-done` = built but never
    // judged; `fix-round-N` = fixed but never re-judged. Both mean the head in
    // front of us has NO verdict → review it", and both resume into review mode.
    // The checkpoint names the phase that just ENDED; the run is in the next one.
    const p = deriveRunProgress(run({ inner_checkpoint: 'fix-round-3' }), T0)
    expect(p.phase_label).toBe('reviewing')
    expect(p.round).toBe(3)
  })

  test('phase_label and step_label never contradict each other', () => {
    // Pin the AGREEMENT, not one instance of it: the bug above was two decoders
    // of the same checkpoint, in the same file, disagreeing.
    for (const cp of ['forge-done', 'fix-round-1', 'fix-round-3', 'argus-approved']) {
      const p = deriveRunProgress(run({ inner_checkpoint: cp }), T0)
      expect(p.phase_label).not.toBe('building')
      expect(deriveStepLabel('forge-init', cp)).not.toBe('building')
    }
    // Positive control: a checkpoint whose next phase IS a build reads that way
    // on both sides, so the assertion above cannot pass by everything being inert.
    const fixing = deriveRunProgress(run({ inner_checkpoint: 'argus-request-changes' }), T0)
    expect(fixing.phase_label).toBe('building')
    expect(deriveStepLabel('forge-init', 'argus-request-changes')).toBe('fixing')
  })

  test('argus-approved checkpoint → reviewing (about to merge)', () => {
    const p = deriveRunProgress(run({ inner_checkpoint: 'argus-approved' }), T0)
    expect(p.phase_label).toBe('reviewing')
  })

  test('terminal phases map directly, ignoring the checkpoint', () => {
    const cases: Array<[TridentPhase, string]> = [
      ['done', 'merged'],
      ['failed', 'failed'],
      ['stopped', 'cancelled'],
    ]
    for (const [phase, label] of cases) {
      const p = deriveRunProgress(run({ phase, inner_checkpoint: 'fix-round-2' }), T0)
      expect(p.phase_label).toBe(label as never)
      expect(p.stalled).toBe(false) // never stalled once terminal
    }
  })

  test('done carries the PR + verdict', () => {
    const p = deriveRunProgress(run({ phase: 'done', pr: 42, inner_verdict: 'APPROVE' }), T0)
    expect(p.phase_label).toBe('merged')
    expect(p.pr).toBe(42)
    expect(p.verdict).toBe('APPROVE')
  })

  test('carries a recovered brief refusal independently of terminal failure', () => {
    const alert = 'CODEX_BUILD_BRIEF_PART_CORRUPT: persisted bytes disagree. DEFERRED.'
    const p = deriveRunProgress(run({ phase: 'forge-init', brief_alert: alert }), T0)
    expect(p.phase_label).toBe('planning')
    expect(p.failure_reason).toBeNull()
    expect(p.brief_alert).toBe(alert)
  })
})

describe('deriveRunProgress — stall detection', () => {
  test('non-terminal + no advance past STALLED_WARN_MS → stalled', () => {
    const p = deriveRunProgress(run(), T0 + STALLED_WARN_MS + 60_000)
    expect(p.stalled).toBe(true)
    expect(p.stalled_ms).toBeGreaterThan(STALLED_WARN_MS)
  })

  test('just under the threshold → not stalled', () => {
    const p = deriveRunProgress(run(), T0 + STALLED_WARN_MS - 1_000)
    expect(p.stalled).toBe(false)
    expect(p.stalled_ms).toBeNull()
  })

  test('an unparseable timestamp never falsely stalls', () => {
    const p = deriveRunProgress(run({ last_advanced_at: 'not-a-date' }), T0 + 3_600_000)
    expect(p.stalled).toBe(false)
    expect(p.elapsed_ms).toBeGreaterThanOrEqual(0)
  })
})

describe('runProgressForItem', () => {
  const lookup = (r: TridentRun) => (id: string) => (id === r.id ? r : null)

  test('null when the item has no linked run', () => {
    expect(runProgressForItem({ linked_run_id: null }, () => null, T0)).toBeNull()
    expect(runProgressForItem({ linked_run_id: '' }, () => null, T0)).toBeNull()
  })

  test('null when the run row is gone', () => {
    expect(runProgressForItem({ linked_run_id: 'ghost' }, () => null, T0)).toBeNull()
  })

  test('derives when the linked run exists', () => {
    const r = run({ id: 'run-x', inner_checkpoint: 'forge-done' })
    const p = runProgressForItem({ linked_run_id: 'run-x', project_slug: 'owner' }, lookup(r), T0)
    expect(p?.phase_label).toBe('reviewing')
    expect(p?.run_id).toBe('run-x')
  })

  test('null across a project mismatch (never derive cross-instance)', () => {
    const r = run({ id: 'run-x', project_slug: 'other' })
    const p = runProgressForItem({ linked_run_id: 'run-x', project_slug: 'owner' }, lookup(r), T0)
    expect(p).toBeNull()
  })
})

describe('deriveStepLabel — M1 UX REDESIGN inner-step vocabulary', () => {
  test('no checkpoint (round-1 build in flight) → building', () => {
    expect(deriveStepLabel('forge-init', null)).toBe('building')
  })

  test('forge-done → reviewing (build done, review running)', () => {
    expect(deriveStepLabel('forge-init', 'forge-done')).toBe('reviewing')
  })

  test('argus-request-changes → fixing (changes asked, fix building)', () => {
    expect(deriveStepLabel('forge-init', 'argus-request-changes')).toBe('fixing')
  })

  test('fix-round-N → reviewing (fix built, re-review running)', () => {
    expect(deriveStepLabel('forge-init', 'fix-round-2')).toBe('reviewing')
    expect(deriveStepLabel('forge-init', 'fix-round-13')).toBe('reviewing')
  })

  test('argus-approved → merging (approved, outer loop merging)', () => {
    expect(deriveStepLabel('forge-init', 'argus-approved')).toBe('merging')
  })

  test('inner-error / unrecognised checkpoint → building (about to fail)', () => {
    expect(deriveStepLabel('forge-init', 'inner-error')).toBe('building')
    expect(deriveStepLabel('forge-init', 'something-else')).toBe('building')
  })

  test('terminal phases win over any checkpoint', () => {
    expect(deriveStepLabel('done', 'argus-approved')).toBe('done')
    expect(deriveStepLabel('failed', 'forge-done')).toBe('failed')
    expect(deriveStepLabel('stopped', 'fix-round-2')).toBe('failed')
  })

  test('a full building→reviewing→fixing→reviewing→merging→done arc', () => {
    // The exact checkpoint sequence the inner workflow writes across a fix round.
    expect(deriveStepLabel('forge-init', null)).toBe('building')
    expect(deriveStepLabel('forge-init', 'forge-done')).toBe('reviewing')
    expect(deriveStepLabel('forge-init', 'argus-request-changes')).toBe('fixing')
    expect(deriveStepLabel('forge-init', 'fix-round-2')).toBe('reviewing')
    expect(deriveStepLabel('forge-init', 'argus-approved')).toBe('merging')
    expect(deriveStepLabel('done', 'argus-approved')).toBe('done')
  })

  test('deriveRunProgress surfaces step_label alongside phase_label', () => {
    const p = deriveRunProgress(run({ inner_checkpoint: 'argus-approved' }), T0)
    expect(p.step_label).toBe('merging')
    // phase_label keeps its legacy vocabulary (reviewing) — step_label refines it.
    expect(p.phase_label).toBe('reviewing')
  })
})
