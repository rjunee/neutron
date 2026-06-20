/**
 * Pure prompt-builder tests for the P6.1 nudge engine. No I/O — exercises
 * the markdown emission contract that the LLM downstream depends on.
 */

import { describe, expect, it } from 'bun:test'

import {
  buildNudgePrompt,
  NUDGE_RATIONALE_MAX_CHARS,
  SKIP_OR_KILL_FLAG_DEFAULT,
  type NudgeSlateRow,
} from '../nudge-engine-prompt.ts'

function row(overrides: Partial<NudgeSlateRow> = {}): NudgeSlateRow {
  return {
    id: 'tsk_a',
    title: 'Default task',
    project_id: 'proj_alpha',
    priority: 2,
    due_date: null,
    focus_score: 7,
    staleness_demotion_count: 0,
    ...overrides,
  }
}

describe('buildNudgePrompt', () => {
  it('emits the day header, JSON response instruction, and exactly N slate rows', () => {
    const prompt = buildNudgePrompt({
      day: '2026-05-23',
      slate: [
        row({ id: 'tsk_one', title: 'First' }),
        row({ id: 'tsk_two', title: 'Second' }),
      ],
      yesterday_completions: [],
      resolved_today_count: 0,
    })
    expect(prompt).toContain('# Daily Focus Pick — 2026-05-23')
    expect(prompt).toContain('## Response format (required)')
    expect(prompt).toMatch(/```json/)
    expect(prompt).toContain('"task_id"')
    expect(prompt).toContain('"rationale"')
    expect(prompt).toContain(String(NUDGE_RATIONALE_MAX_CHARS))
    expect(prompt).toContain('`tsk_one`')
    expect(prompt).toContain('`tsk_two`')
  })

  it('renders priority, due_date, focus_score, project_id in the slate row meta', () => {
    const prompt = buildNudgePrompt({
      day: '2026-05-23',
      slate: [row({ priority: 3, due_date: '2026-05-24', focus_score: 12.5, project_id: 'proj_alpha' })],
      yesterday_completions: [],
      resolved_today_count: 0,
    })
    expect(prompt).toContain('P3')
    expect(prompt).toContain('due 2026-05-24')
    expect(prompt).toContain('score 12.5')
    expect(prompt).toContain('project proj_alpha')
  })

  it('appends [skip-or-kill] when staleness_demotion_count >= threshold', () => {
    const prompt = buildNudgePrompt({
      day: '2026-05-23',
      slate: [
        row({ id: 'tsk_a', staleness_demotion_count: 0 }),
        row({ id: 'tsk_b', staleness_demotion_count: SKIP_OR_KILL_FLAG_DEFAULT }),
      ],
      yesterday_completions: [],
      resolved_today_count: 0,
    })
    const lineA = prompt.split('\n').find((l) => l.includes('`tsk_a`'))
    const lineB = prompt.split('\n').find((l) => l.includes('`tsk_b`'))
    expect(lineA).not.toMatch(/\[skip-or-kill\]/)
    expect(lineB).toMatch(/\[skip-or-kill\]/)
  })

  it('respects a custom skip_or_kill_flag_threshold', () => {
    const prompt = buildNudgePrompt({
      day: '2026-05-23',
      slate: [row({ id: 'tsk_a', staleness_demotion_count: 1 })],
      yesterday_completions: [],
      resolved_today_count: 0,
      skip_or_kill_flag_threshold: 1,
    })
    expect(prompt).toMatch(/`tsk_a`.*\[skip-or-kill\]/)
  })

  it('renders yesterday completions as a bullet list', () => {
    const prompt = buildNudgePrompt({
      day: '2026-05-23',
      slate: [row()],
      yesterday_completions: [
        { id: 'tsk_y1', title: 'Wrote the brief' },
        { id: 'tsk_y2', title: 'Reviewed PR' },
      ],
      resolved_today_count: 2,
    })
    expect(prompt).toContain("Yesterday's completions")
    expect(prompt).toContain('- Wrote the brief')
    expect(prompt).toContain('- Reviewed PR')
    expect(prompt).toContain("Today's resolved count: 2")
  })

  it('shows "(none)" when there are no yesterday completions', () => {
    const prompt = buildNudgePrompt({
      day: '2026-05-23',
      slate: [row()],
      yesterday_completions: [],
      resolved_today_count: 0,
    })
    expect(prompt).toContain("Yesterday's completions")
    expect(prompt).toMatch(/Yesterday's completions[\s\S]+?\(none\)/)
  })

  it('handles empty slate gracefully', () => {
    const prompt = buildNudgePrompt({
      day: '2026-05-23',
      slate: [],
      yesterday_completions: [],
      resolved_today_count: 0,
    })
    expect(prompt).toContain('empty slate')
  })

  it('collapses long titles with an ellipsis', () => {
    const longTitle = 'x'.repeat(300)
    const prompt = buildNudgePrompt({
      day: '2026-05-23',
      slate: [row({ title: longTitle })],
      yesterday_completions: [],
      resolved_today_count: 0,
    })
    // The shortLine helper caps slate-row titles at 200 chars with a trailing ellipsis.
    const slateLine = prompt.split('\n').find((l) => l.includes('`tsk_a`'))
    expect(slateLine).toBeDefined()
    expect(slateLine!.length).toBeLessThan(longTitle.length + 50)
    expect(slateLine).toMatch(/…$/)
  })
})
