import { describe, expect, test } from 'bun:test'
import {
  classifyFireTimeoutRow,
  FIRE_PUBLISHED_REASON_MARKER,
  FIRE_SETTLE_TIMEOUT_ERROR,
  OUTER_PUBLISHED_CHECKPOINT,
  PUBLISHED_REASON_MAX_CHARS,
  publishedFailureReason,
  type WorkflowOwnedColumns,
} from './fire-evidence.ts'

const SHA = '7'.repeat(40)
const PUBLISHED = `outer-published:${SHA}:0:3`

function columns(over: Partial<WorkflowOwnedColumns> = {}): WorkflowOwnedColumns {
  return {
    inner_checkpoint: null,
    inner_checkpoint_head: null,
    inner_checkpoint_findings: null,
    inner_verdict: null,
    inner_result: null,
    ...over,
  }
}

describe('classifyFireTimeoutRow — a moved workflow-owned column is a live lane', () => {
  test('an inner_checkpoint delta reads as launched and names the column', () => {
    const evidence = classifyFireTimeoutRow(
      columns(),
      columns({ inner_checkpoint: 'ralph-task-built' }),
    )
    expect(evidence.kind).toBe('launched')
    expect(evidence.detail).toContain('inner_checkpoint')
  })

  test('an inner_result delta alone reads as launched', () => {
    const evidence = classifyFireTimeoutRow(
      columns(),
      columns({ inner_result: '{"verdict":"APPROVE"}' }),
    )
    expect(evidence.kind).toBe('launched')
    expect(evidence.detail).toContain('inner_result')
    // The DETAIL NAMES COLUMNS, NEVER VALUES — a result is prose.
    expect(evidence.detail).not.toContain('APPROVE')
  })

  test('every workflow-owned column counts on its own', () => {
    const deltas: Array<Partial<WorkflowOwnedColumns>> = [
      { inner_checkpoint: 'forge-done' },
      { inner_checkpoint_head: SHA },
      { inner_checkpoint_findings: '[]' },
      { inner_verdict: 'APPROVE' },
      { inner_result: 'x' },
    ]
    for (const delta of deltas) {
      expect(classifyFireTimeoutRow(columns(), columns(delta)).kind).toBe('launched')
    }
  })

  test('a live delta OUTRANKS an outer-published checkpoint (a live lane is never terminalized)', () => {
    const evidence = classifyFireTimeoutRow(
      columns({ inner_checkpoint: PUBLISHED }),
      columns({ inner_checkpoint: PUBLISHED, inner_checkpoint_head: SHA }),
    )
    expect(evidence.kind).toBe('launched')
  })

  test('an identical fresh row is NOT a delta', () => {
    expect(classifyFireTimeoutRow(columns({ inner_checkpoint: 'forge-done' }), columns({ inner_checkpoint: 'forge-done' })).kind).toBe(
      'none',
    )
  })
})

describe('classifyFireTimeoutRow — an outer-published row is finished work', () => {
  test('a fresh published row reads as published and carries the checkpoint', () => {
    const evidence = classifyFireTimeoutRow(
      columns({ inner_checkpoint: PUBLISHED }),
      columns({ inner_checkpoint: PUBLISHED }),
    )
    expect(evidence.kind).toBe('published')
    if (evidence.kind !== 'published') throw new Error('unreachable')
    expect(evidence.checkpoint).toBe(PUBLISHED)
  })

  test('an unreadable fresh row falls back to the PINNED row', () => {
    const evidence = classifyFireTimeoutRow(columns({ inner_checkpoint: PUBLISHED }), null)
    expect(evidence.kind).toBe('published')
  })

  test('the :deviated suffix and surrounding whitespace still classify', () => {
    const messy = `  outer-published:${SHA}:0:5:deviated \n`
    const evidence = classifyFireTimeoutRow(
      columns({ inner_checkpoint: messy }),
      columns({ inner_checkpoint: messy }),
    )
    expect(evidence.kind).toBe('published')
    if (evidence.kind !== 'published') throw new Error('unreachable')
    expect(evidence.checkpoint).toBe(`outer-published:${SHA}:0:5:deviated`)
  })

  // ARGUS r4 (major): the classifier tested the SHAPE and ignored the `remaining`
  // field, so `outer-published:<sha>:1:1` — a governed round pushed with tasks
  // STILL UNBUILT — was terminalized as finished-and-published. Downstream that
  // reason tells delivery "do not rebuild it" and tells the wake to dispatch a
  // review, so an unfinished card is forbidden the rebuild it actually needs.
  // Delete the `Number(...) === 0` predicate and this goes RED.
  test('a published checkpoint with tasks STILL REMAINING is not published — it is no evidence', () => {
    for (const remaining of ['1', '7', '42']) {
      const name = `outer-published:${SHA}:${remaining}:3`
      const evidence = classifyFireTimeoutRow(columns({ inner_checkpoint: name }), columns({ inner_checkpoint: name }))
      expect(evidence.kind).toBe('none')
      expect(evidence.detail).toContain(`${remaining} task(s) remaining`)
    }
  })

  test('the :deviated suffix does not smuggle a remaining>0 row into published', () => {
    const name = `outer-published:${SHA}:2:5:deviated`
    expect(classifyFireTimeoutRow(columns({ inner_checkpoint: name }), columns({ inner_checkpoint: name })).kind).toBe(
      'none',
    )
  })

  test('every all-zero spelling of remaining is still zero', () => {
    for (const remaining of ['0', '00', '000']) {
      const name = `outer-published:${SHA}:${remaining}:3`
      expect(
        classifyFireTimeoutRow(columns({ inner_checkpoint: name }), columns({ inner_checkpoint: name })).kind,
      ).toBe('published')
    }
  })
})

describe('classifyFireTimeoutRow — everything else is no evidence', () => {
  test('inner-loop checkpoints and a null checkpoint are not evidence', () => {
    for (const name of ['ralph-task-built', 'forge-done', 'argus-request-changes', null]) {
      expect(classifyFireTimeoutRow(columns({ inner_checkpoint: name }), columns({ inner_checkpoint: name })).kind).toBe(
        'none',
      )
    }
  })

  test('a 39-hex sha is not a published checkpoint', () => {
    const name = `outer-published:${'7'.repeat(39)}:0:3`
    expect(classifyFireTimeoutRow(columns({ inner_checkpoint: name }), null).kind).toBe('none')
    expect(OUTER_PUBLISHED_CHECKPOINT.test(name)).toBe(false)
  })

  test('a 10-digit round exceeds the bounded round field', () => {
    const name = `outer-published:${SHA}:0:1234567890`
    expect(classifyFireTimeoutRow(columns({ inner_checkpoint: name }), null).kind).toBe('none')
  })

  test('a 9-digit round is still inside the bound', () => {
    expect(OUTER_PUBLISHED_CHECKPOINT.test(`outer-published:${SHA}:0:123456789`)).toBe(true)
  })
})

// THE CLASSIFIER TOKENS `interpretFailure` (delivery.ts) AND THE SALVAGE-MARKER
// RULES ROUTE ON. Any of them inside the published reason would report a
// finished, pushed build as a hang, a merge problem, or a rejection.
const FORBIDDEN = [
  'fire failed',
  'failed:',
  'hang',
  'stalled',
  'no progress for',
  'exhausted',
  'conflict',
  'git ',
  'rebase',
  'checkout',
  'merge failed',
  'missing',
  'garbled',
  'provenance',
  'backend',
  'could not prepare',
  'request_changes',
  'without argus approve',
  'not enabled',
  'underspecified',
  'unmerged',
  'merge_head',
  'resolve your current index',
  'crash-recovery budget',
  'inner workflow ended at round',
  'inner workflow failed at round',
  'build infrastructure failed',
  'review never ran (infra-only)',
]

describe('the evidence carries what was READ, so the caller never saves stale columns back', () => {
  // BLOCKER (round 1): the orchestrator writes the PINNED row back through
  // `saveIfActive`, which assigns `inner_checkpoint`/`inner_verdict` plainly. If
  // the evidence did not hand back the fresh values, sparing a live lane would
  // erase in the same statement the delta that proved the lane was live.
  test('launched carries the FRESH workflow-owned columns, not the pinned ones', () => {
    const fresh = columns({ inner_checkpoint: 'forge-done' })
    const evidence = classifyFireTimeoutRow(columns(), fresh)
    expect(evidence.kind).toBe('launched')
    if (evidence.kind === 'launched') expect(evidence.observed).toEqual(fresh)
  })

  test('published carries the fresh columns when there WAS a fresh row', () => {
    const fresh = columns({ inner_checkpoint: PUBLISHED })
    const evidence = classifyFireTimeoutRow(columns({ inner_checkpoint: PUBLISHED }), fresh)
    expect(evidence.kind).toBe('published')
    if (evidence.kind === 'published') expect(evidence.observed).toEqual(fresh)
  })

  test('published carries NOTHING when the re-read failed — the pinned row is all there is', () => {
    const evidence = classifyFireTimeoutRow(columns({ inner_checkpoint: PUBLISHED }), null)
    expect(evidence.kind).toBe('published')
    if (evidence.kind === 'published') expect(evidence.observed).toBeUndefined()
  })
})

describe('publishedFailureReason', () => {
  test('names the published state and the shortened checkpoint', () => {
    const reason = publishedFailureReason(PUBLISHED)
    expect(reason).toContain(FIRE_PUBLISHED_REASON_MARKER)
    expect(reason).toContain('review not run')
    expect(reason).toContain(`${'7'.repeat(12)}…`)
    // The full 40-hex oid never appears — the reason is read by a human.
    expect(reason).not.toContain(SHA)
  })

  test('stays inside the 200-char budget the honest fallback quotes verbatim', () => {
    for (const checkpoint of [PUBLISHED, `outer-published:${SHA}:123:123456789:deviated`]) {
      expect(publishedFailureReason(checkpoint).length).toBeLessThanOrEqual(200)
    }
  })

  // NIT (round 1): the old form `slice(0, 36)`d the WHOLE checkpoint, which lands
  // mid-field — `(outer-published:aaaaaaaaaaaa…:999999)` — silently eating the
  // round and any `:deviated`. Only the sha may be abbreviated, and any cap on a
  // numeric field must be VISIBLE.
  test('shortens by FIELD: the round and :deviated survive a maximal checkpoint', () => {
    const reason = publishedFailureReason(`outer-published:${SHA}:123:123456789:deviated`)
    expect(reason).toContain(':123:123456789:deviated')
    expect(reason.length).toBeLessThanOrEqual(200)
  })

  test('an over-long remaining field is capped VISIBLY, never silently', () => {
    const reason = publishedFailureReason(`outer-published:${SHA}:1234567890123:7`)
    expect(reason).toContain('123456789…:7')
    expect(reason.length).toBeLessThanOrEqual(200)
  })

  test('contains none of the failure-classifier tokens', () => {
    const reason = publishedFailureReason(PUBLISHED).toLowerCase()
    for (const token of FORBIDDEN) expect(reason).not.toContain(token)
  })

  test('the settle-timeout error string is the one the fire actually resolves', () => {
    expect(FIRE_SETTLE_TIMEOUT_ERROR).toBe('fire turn did not settle within the budget')
  })
})

describe('round-2 findings — the carried columns and the length contract', () => {
  // NIT (round 2): `checkpoint` was trimmed but `observed` carried the raw
  // column, so the row the caller PERSISTS said one thing while the
  // failure_reason quoted another.
  test('published carries the TRIMMED checkpoint in observed, matching the quoted one', () => {
    const messy = `  outer-published:${SHA}:0:5:deviated \n`
    const evidence = classifyFireTimeoutRow(
      columns({ inner_checkpoint: messy, inner_verdict: 'REVIEW_NOT_RUN' }),
      columns({ inner_checkpoint: messy, inner_verdict: 'REVIEW_NOT_RUN' }),
    )
    expect(evidence.kind).toBe('published')
    if (evidence.kind !== 'published') throw new Error('unreachable')
    expect(evidence.observed?.inner_checkpoint).toBe(evidence.checkpoint)
    expect(evidence.observed?.inner_checkpoint).toBe(`outer-published:${SHA}:0:5:deviated`)
    // Every OTHER workflow-owned column is still carried verbatim.
    expect(evidence.observed?.inner_verdict).toBe('REVIEW_NOT_RUN')
  })

  // MINOR (round 2): the <=200 contract was prose. A 500-char non-matching input
  // rendered a 639-char reason, because only the 40-hex sha was abbreviated.
  test('the fallback path is CAPPED, not merely documented', () => {
    const absurd = `outer-published:${SHA}:${'9'.repeat(500)}`
    const reason = publishedFailureReason(absurd)
    expect(reason.length).toBeLessThanOrEqual(PUBLISHED_REASON_MAX_CHARS)
    // The cut is visible, and the operator-facing sentence around it survives.
    expect(reason).toContain('…')
    expect(reason).toContain('review not run')
    expect(reason).toContain(FIRE_PUBLISHED_REASON_MARKER)
  })

  test('arbitrary free text on the fallback path is bounded too', () => {
    const reason = publishedFailureReason('x'.repeat(4000))
    expect(reason.length).toBeLessThanOrEqual(PUBLISHED_REASON_MAX_CHARS)
  })

  test('a MATCHED checkpoint is never cut by the ceiling — every field survives', () => {
    const maximal = `outer-published:${SHA}:123456789:123456789:deviated`
    const reason = publishedFailureReason(maximal)
    expect(reason).toContain(':123456789:123456789:deviated')
    expect(reason.length).toBeLessThanOrEqual(PUBLISHED_REASON_MAX_CHARS)
  })
})
