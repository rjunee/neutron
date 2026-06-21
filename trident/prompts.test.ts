import { describe, expect, test } from 'bun:test'
import {
  ARGUS_DIFF_LINE_LIMIT,
  chooseArgusScope,
  parseArgusFindings,
  parseArgusVerdict,
  parseForgeOutput,
  parseRalphPlan,
  renderArgusPrompt,
  renderForgeFixPrompt,
  renderForgePrompt,
  renderRalphPlanPrompt,
  renderRalphTaskPrompt,
} from './prompts.ts'
import type { TridentRun } from './store.ts'

function makeRun(overrides: Partial<TridentRun> = {}): TridentRun {
  return {
    id: 'id',
    slug: 'add-widget',
    project_slug: 't1',
    phase: 'forge-init',
    round: 1,
    max_rounds: 8,
    ralph: false,
    ralph_round: 0,
    max_ralph_rounds: 20,
    branch: 'trident/add-widget',
    pr: null,
    merge_mode: 'pr',
    subagent_run_id: null,
    subagent_status: null,
    repo_path: '/repo',
    worktree: null,
    task: 'Add a widget',
    chat_id: null,
    thread_id: null,
    channel_kind: 'telegram',
    failure_reason: null,
    started_at: '2026-01-01T00:00:00.000Z',
    last_advanced_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('parseForgeOutput', () => {
  test('parses the three locked contract lines (last lines)', () => {
    const out = parseForgeOutput('did the work\nPR_NUMBER=42\nBRANCH=feat-x\nWORKTREE=/repo')
    expect(out).not.toBeNull()
    expect(out?.pr_number).toBe(42)
    expect(out?.branch).toBe('feat-x')
    expect(out?.worktree).toBe('/repo')
    expect(out?.remaining).toBeNull()
  })

  test('captures REMAINING_TASKS when present (Ralph)', () => {
    const out = parseForgeOutput('PR_NUMBER=1\nBRANCH=b\nWORKTREE=/r\nREMAINING_TASKS=3')
    expect(out?.remaining).toBe(3)
  })

  test('accepts PR_NUMBER=0 (local placeholder)', () => {
    const out = parseForgeOutput('PR_NUMBER=0\nBRANCH=b\nWORKTREE=/r')
    expect(out?.pr_number).toBe(0)
  })

  test('returns null when a contract line is missing (no silent success)', () => {
    expect(parseForgeOutput('PR_NUMBER=1\nBRANCH=b')).toBeNull()
    expect(parseForgeOutput('I built the thing but forgot the contract lines')).toBeNull()
  })

  test('back-walk ignores trailing preamble shadowing', () => {
    const out = parseForgeOutput('PR_NUMBER=9\nBRANCH=real\nWORKTREE=/r\nsome closing remark')
    expect(out?.branch).toBe('real')
  })

  test('garbled REMAINING_TASKS is rejected (strict ^[0-9]+$ → null, fail-loud)', () => {
    // A non-numeric count must NOT coerce to 0 — it stays null so the state
    // machine halts a partial governed build rather than merging it.
    expect(parseForgeOutput('PR_NUMBER=1\nBRANCH=b\nWORKTREE=/r\nREMAINING_TASKS=lots')?.remaining).toBeNull()
    expect(parseForgeOutput('PR_NUMBER=1\nBRANCH=b\nWORKTREE=/r\nREMAINING_TASKS=-2')?.remaining).toBeNull()
  })
})

describe('parseRalphPlan', () => {
  test('parses REMAINING_TASKS + NEXT_TASK with no PR contract lines', () => {
    const p = parseRalphPlan('replanned\nREMAINING_TASKS=3\nNEXT_TASK=wire the auth guard')
    expect(p.remaining).toBe(3)
    expect(p.next_task).toBe('wire the auth guard')
  })

  test('REMAINING_TASKS=0 → done signal (remaining 0, not null)', () => {
    const p = parseRalphPlan('REMAINING_TASKS=0')
    expect(p.remaining).toBe(0)
    expect(p.next_task).toBeNull()
  })

  test('missing REMAINING_TASKS → null (state machine fails loud)', () => {
    expect(parseRalphPlan('I planned but forgot the count').remaining).toBeNull()
  })

  test('garbled REMAINING_TASKS → null (strict ^[0-9]+$)', () => {
    expect(parseRalphPlan('REMAINING_TASKS=three\nNEXT_TASK=x').remaining).toBeNull()
  })

  test('back-walk: the LAST REMAINING_TASKS line wins over earlier preamble', () => {
    const p = parseRalphPlan('REMAINING_TASKS=9 (draft)\nREMAINING_TASKS=2\nNEXT_TASK=do it')
    expect(p.remaining).toBe(2)
  })
})

describe('parseArgusVerdict', () => {
  test('exact APPROVE line', () => {
    expect(parseArgusVerdict('looks good\nAPPROVE\n')).toBe('APPROVE')
  })
  test('REQUEST CHANGES wins even with the word approve nearby', () => {
    expect(parseArgusVerdict('REQUEST CHANGES\n1. do not APPROVE blindly')).toBe('REQUEST_CHANGES')
  })
  test('markdown-wrapped **APPROVE**', () => {
    expect(parseArgusVerdict('**APPROVE**')).toBe('APPROVE')
  })
  test('unparseable defaults to REQUEST_CHANGES (fail-safe, never auto-merge)', () => {
    expect(parseArgusVerdict('hmm, I could not finish the review')).toBe('REQUEST_CHANGES')
  })
})

describe('parseArgusFindings', () => {
  test('strips list markers, drops the verdict line', () => {
    const f = parseArgusFindings('REQUEST CHANGES\n1. fix the SQL at db.ts:4\n- unused import')
    expect(f).toEqual(['fix the SQL at db.ts:4', 'unused import'])
  })
})

describe('chooseArgusScope — oversized-diff guard', () => {
  test('round 1 under the limit → full branch diff', () => {
    const s = chooseArgusScope({ base_branch: 'main', round: 1, diff_line_count: 500 })
    expect(s).toContain('git diff main..HEAD')
    expect(s).not.toContain('OVER')
  })

  test('round 1 over the limit → meaty-commits, declares what it could not verify', () => {
    const s = chooseArgusScope({ base_branch: 'main', round: 1, diff_line_count: ARGUS_DIFF_LINE_LIMIT + 1 })
    expect(s).toContain('OVER')
    expect(s).toContain('git log --oneline main..HEAD')
    expect(s).toContain('could not verify')
    expect(s).not.toContain('git diff main..HEAD`')
  })

  test('round 2+ always reviews the single fix commit (git show HEAD)', () => {
    const s = chooseArgusScope({ base_branch: 'main', round: 2, diff_line_count: 999999 })
    expect(s).toContain('git show HEAD')
    expect(s).not.toContain('OVER')
  })

  test('exactly at the limit is NOT oversized', () => {
    const s = chooseArgusScope({ base_branch: 'main', round: 1, diff_line_count: ARGUS_DIFF_LINE_LIMIT })
    expect(s).toContain('git diff main..HEAD')
  })
})

describe('renderForgePrompt', () => {
  test('pr mode tells Forge to gh pr create', () => {
    const p = renderForgePrompt(makeRun({ merge_mode: 'pr' }), 'main')
    expect(p).toContain('gh pr create')
    expect(p).toContain('TASK\nAdd a widget')
    expect(p).toContain('BRANCH=trident/add-widget')
  })

  test('local mode does NOT tell Forge to gh pr create; emits PR_NUMBER=0', () => {
    const p = renderForgePrompt(makeRun({ merge_mode: 'local' }), 'main')
    expect(p).not.toContain('gh pr create')
    expect(p).toContain('PR_NUMBER=0')
  })

  test('non-ralph run has NO Ralph bootstrap note', () => {
    const p = renderForgePrompt(makeRun({ ralph: false }), 'main')
    expect(p).not.toContain('RALPH MODE')
    expect(p).not.toContain('IMPLEMENTATION_PLAN.md')
  })

  test('ralph run appends the bootstrap note (plan + REMAINING_TASKS contract)', () => {
    const p = renderForgePrompt(makeRun({ ralph: true }), 'main')
    expect(p).toContain('RALPH MODE')
    expect(p).toContain('IMPLEMENTATION_PLAN.md')
    expect(p).toContain('REMAINING_TASKS=')
    expect(p).toContain('ONLY the single top-priority unchecked task')
    // the base build contract + TASK are still present.
    expect(p).toContain('TASK\nAdd a widget')
  })
})

describe('renderRalphPlanPrompt', () => {
  test('docs-only planning pass: writes plan, emits REMAINING_TASKS + NEXT_TASK, never rewrites SPEC', () => {
    const p = renderRalphPlanPrompt(makeRun({ branch: 'feat-x', pr: 7 }), 'main')
    expect(p).toContain('RALPH PLANNING PASS')
    expect(p).toContain('NO feature code this turn')
    expect(p).toContain('Read SPEC.md')
    expect(p).toContain('NEVER rewrite it')
    expect(p).toContain('Rewrite IMPLEMENTATION_PLAN.md')
    expect(p).toContain('REMAINING_TASKS=')
    expect(p).toContain('NEXT_TASK=')
    // a planner does NOT open a PR / emit the build contract lines.
    expect(p).not.toContain('PR_NUMBER=')
  })

  test('pr mode pushes; local mode commits locally', () => {
    expect(renderRalphPlanPrompt(makeRun({ merge_mode: 'pr' }), 'main')).toContain('push the branch')
    expect(renderRalphPlanPrompt(makeRun({ merge_mode: 'local', branch: 'b' }), 'main')).toContain(
      'commit locally on b',
    )
  })
})

describe('renderRalphTaskPrompt', () => {
  test('implements ONLY the surfaced task + checks it off, re-emits the build contract', () => {
    const p = renderRalphTaskPrompt(makeRun({ branch: 'feat-x', pr: 7 }), 'main', 'add the rate limiter')
    expect(p).toContain('RALPH TASK')
    expect(p).toContain('Implement ONLY this single task: add the rate limiter')
    expect(p).toContain('Do NOT start any other unchecked task')
    expect(p).toContain('Check THIS one task off')
    expect(p).toContain('PR_NUMBER=7')
    expect(p).toContain('BRANCH=feat-x')
  })

  test('null next_task falls back to "the single top task in the plan"', () => {
    const p = renderRalphTaskPrompt(makeRun(), 'main', null)
    expect(p).toContain('the single top-priority unchecked task in IMPLEMENTATION_PLAN.md')
  })
})

describe('renderForgeFixPrompt', () => {
  test('threads numbered findings + targets the same branch', () => {
    const p = renderForgeFixPrompt(
      makeRun({ pr: 42 }),
      'main',
      ['fix A', 'fix B'],
      2,
    )
    expect(p).toContain('1. fix A')
    expect(p).toContain('2. fix B')
    expect(p).toContain('do NOT open a new one')
    expect(p).toContain('round 2')
  })
})

describe('renderArgusPrompt', () => {
  test('embeds scope, branch, pr, round', () => {
    const p = renderArgusPrompt({
      branch: 'feat-x',
      pr_number: 42,
      round: 1,
      max_rounds: 8,
      base_branch: 'main',
      diff_line_count: 100,
    })
    expect(p).toContain('Branch: feat-x')
    expect(p).toContain('PR: #42')
    expect(p).toContain('Round: 1 of 8')
    expect(p).toContain('git diff main..HEAD')
    expect(p).toContain('NEVER exit silently')
  })
})
