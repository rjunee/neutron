/**
 * BLOCKED vs FAILED — the two words, end to end.
 *
 * A run that stops because its PLAN cannot succeed reached the owner wearing ❌ and the
 * sentence of a rejection, because every terminal non-merge shares the `failed` phase.
 * The owner then cannot tell "nothing can build this until a decision is made" from
 * "this build broke", and those earn opposite responses. This covers the whole chain:
 * the workflow's payload → the decoder → the ONE deriver → the card's lane, the run's
 * failure reason, and the chat sentence.
 *
 * THE ONE THING THESE MAY NOT DO is perform any part of the escalation themselves. Every
 * fixture here writes only what the WORKFLOW writes (`inner_result`, `harvested_at`,
 * `phase`); the lane, the reason and the sentence are all read back from production code.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { WorkBoardStore } from '@neutronai/work-board/store.ts'
import { buildBoardReconcileObserver } from './board-reconcile.ts'
import { composeTerminalDelivery, interpretFailure } from './delivery.ts'
import {
  deriveEscalationBlock,
  escalationKindAgrees,
  escalationStopSentence,
} from './escalation-block.ts'
import { parseInnerEscalation, parseInnerResult } from './inner-loop.ts'
import { innerTerminalFailureReason, recordedTerminalVerdict } from './orchestrator.ts'
import { makeTridentRun } from './testing/make-trident-run.ts'

/** EXACTLY what `inner-workflow.mjs` writes on an escalating terminal path. */
const escalatingResult = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    ok: true,
    prNumber: 12,
    branch: 'trident/x',
    verdict: 'REQUEST_CHANGES',
    round: 2,
    checkpoint: 'argus-request-changes',
    blockKind: 'not-converging',
    escalation: {
      kind: 'not-converging',
      whatIsMissing: 'the same finding(s) survived a fix round (a:b:c)',
      triggers: ['repeat-finding'],
      evidence: 'round 2; finding(s) a:b:c survived a fix round',
      round: 2,
    },
    ...over,
  })

const escalatedRun = (over: Record<string, unknown> = {}) =>
  makeTridentRun({
    phase: 'failed',
    harvested_at: 1_700_000_000_000,
    inner_result: escalatingResult(),
    ...(over as object),
  })

describe('parseInnerEscalation — fail-closed, and ALL-OR-NOTHING', () => {
  test('a complete payload decodes verbatim, trimmed and clamped', () => {
    const e = parseInnerEscalation({
      kind: 'missing-dependency',
      whatIsMissing: '  the dispatch-holds card must land first  ',
      triggers: ['missing-dependency', '', 42],
      evidence: 'round 1',
      round: 1,
    })
    expect(e?.kind).toBe('missing-dependency')
    expect(e?.whatIsMissing).toBe('the dispatch-holds card must land first')
    // Non-string / empty triggers are DROPPED, never coerced: the list says which gates
    // fired, and a coerced member would assert one that did not.
    expect(e?.triggers).toEqual(['missing-dependency'])
  })

  test('HEADLINE: an escalation that states NOTHING is refused at decode', () => {
    // The workflow's own gate refuses a bare complaint; a decoder that rebuilt one here
    // would restore downstream exactly what the gate removed upstream.
    for (const bad of [
      { kind: 'design-gap' },
      { kind: 'design-gap', whatIsMissing: '' },
      { kind: 'design-gap', whatIsMissing: '   ' },
      { kind: 'design-gap', whatIsMissing: 42 },
    ]) {
      expect(parseInnerEscalation(bad)).toBeNull()
    }
  })

  test('an unknown kind decodes to null — never to a half-filled escalation', () => {
    for (const bad of [
      null,
      undefined,
      'design-gap',
      ['design-gap'],
      { kind: 'made-up', whatIsMissing: 'x' },
      { kind: 'infra-only', whatIsMissing: 'x' },
    ]) {
      expect(parseInnerEscalation(bad)).toBeNull()
    }
  })

  test('`triggers` degrades to [] rather than to a guess', () => {
    const e = parseInnerEscalation({ kind: 'design-gap', whatIsMissing: 'x', triggers: 'repeat-finding' })
    // Inventing `['repeat-finding']` for a garbled list would assert the arithmetic fired
    // when nothing says it did.
    expect(e?.triggers).toEqual([])
  })

  test('the three escalation block kinds survive `parseInnerResult`; a fourth does not', () => {
    for (const kind of ['design-gap', 'missing-dependency', 'not-converging']) {
      const r = parseInnerResult(escalatingResult({ blockKind: kind, escalation: { kind, whatIsMissing: 'x', triggers: [], evidence: '', round: 1 } }))
      expect(r?.block_kind).toBe(kind as never)
      expect(r?.escalation?.kind).toBe(kind as never)
    }
    expect(parseInnerResult(escalatingResult({ blockKind: 'plan-smells-bad' }))?.block_kind).toBeNull()
  })
})

describe('deriveEscalationBlock — the ONE deriver, and its three-condition gate', () => {
  test('a harvested, failed run carrying a matching escalation derives it', () => {
    const b = deriveEscalationBlock(escalatedRun())
    expect(b?.kind).toBe('not-converging')
    expect(b?.triggers).toEqual(['repeat-finding'])
    expect(b?.round).toBe(2)
  })

  test('a NON-terminal or non-failed run derives nothing', () => {
    for (const phase of ['forge-init', 'argus', 'done', 'stopped'] as const) {
      expect(deriveEscalationBlock(escalatedRun({ phase }))).toBeNull()
    }
  })

  test('THE STALE-RESULT HAZARD: an un-harvested row derives nothing', () => {
    // A force-terminated or cancelled row can keep a perfectly parseable `inner_result`
    // from an earlier iteration. `harvested_at` is written EXCLUSIVELY by
    // `orchestrator.applyResult`, so it is the proof the result belongs to THIS ending.
    expect(deriveEscalationBlock(escalatedRun({ harvested_at: null }))).toBeNull()
  })

  test('HEADLINE: a result whose KIND and PAYLOAD disagree derives nothing', () => {
    // The kind is what the outer loop routes on; the payload is what it reports. Half an
    // escalation was not written by one decision, and guessing which half is right is how
    // a bug becomes a confidently wrong owner-facing sentence.
    expect(
      deriveEscalationBlock(
        escalatedRun({ inner_result: escalatingResult({ blockKind: 'design-gap' }) }),
      ),
    ).toBeNull()
    // …and an escalation payload with no matching block kind at all.
    expect(
      deriveEscalationBlock(escalatedRun({ inner_result: escalatingResult({ blockKind: 'code' }) })),
    ).toBeNull()
  })

  test('an ordinary code rejection and an infra block are NOT escalations', () => {
    for (const blockKind of ['code', 'advisory-only', 'infra-only', 'round-lost']) {
      const run = escalatedRun({
        inner_result: JSON.stringify({ ok: false, verdict: 'REQUEST_CHANGES', round: 3, blockKind }),
      })
      expect(deriveEscalationBlock(run)).toBeNull()
    }
  })

  test('a garbled or absent `inner_result` derives nothing', () => {
    expect(deriveEscalationBlock(escalatedRun({ inner_result: '{bad json' }))).toBeNull()
    expect(deriveEscalationBlock(escalatedRun({ inner_result: null }))).toBeNull()
  })
})

describe('the OWNER sees two different words', () => {
  test('HEADLINE: the chat line says BLOCKED and NOT failed, under its own glyph', () => {
    const run = escalatedRun({ title: 'ship the thing', pr: 12, merge_mode: 'pr' })
    const text = composeTerminalDelivery(run)?.text ?? ''
    expect(text).toContain('BLOCKED')
    // The ❌ line is what every other terminal failure wears; this one must not.
    expect(text).not.toContain('❌')
    expect(text).toContain('🛑')
    expect(text).toContain('the same finding(s) survived a fix round')
  })

  test('an ordinary failure still wears ❌ — the carve-out did not widen', () => {
    const run = makeTridentRun({ phase: 'failed', harvested_at: 1, inner_result: null, failure_reason: 'merge failed' })
    const text = composeTerminalDelivery(run)?.text ?? ''
    expect(text).toContain('❌')
    expect(text).not.toContain('BLOCKED')
  })

  test('the ADVICE differs by kind — each needs a different thing from the owner', () => {
    const advice = (kind: string, what: string): string =>
      interpretFailure(
        escalatedRun({
          inner_result: escalatingResult({
            blockKind: kind,
            escalation: { kind, whatIsMissing: what, triggers: [kind], evidence: 'e', round: 1 },
          }),
        }),
      ).input_needed
    const dependency = advice('missing-dependency', 'card X must land first')
    expect(dependency).toContain('SEQUENCING')
    // THE ROUTING, IN WORDS. The run reports; the orchestrator decides — so the sentence
    // has to name the call and what it takes, because "retry" alone is the one
    // instruction that changes nothing while the chokepoint is refusing the card.
    expect(dependency).toContain('reorder')
    expect(dependency).toContain('spec it first')
    expect(advice('design-gap', 'the spec asked for it')).toContain('Decide the plan')
    // The arithmetic kind measured that fixing stopped working and asserts NOTHING about
    // why, so its advice must not pretend to know which of the other two it is.
    const arithmetic = advice('not-converging', 'the count stopped falling')
    expect(arithmetic).not.toContain('SEQUENCING')
    expect(arithmetic).not.toContain('Decide the plan')
    // EVERY kind names the unblocking step, because none of them can be re-dispatched
    // until the card leaves the blocked lane.
    for (const text of [dependency, advice('design-gap', 'x'), arithmetic]) {
      expect(text).toContain('BLOCKED')
      expect(text).toContain('upcoming')
    }
  })

  test('the stored failure reason is the escalation sentence, not the generic catch-all', () => {
    const run = escalatedRun({ round: 2, max_rounds: 10 })
    const result = parseInnerResult(run.inner_result)!
    const reason = innerTerminalFailureReason(run, result)
    expect(reason).toBe(escalationStopSentence(deriveEscalationBlock(run)!, run.max_rounds))
    expect(reason).toContain('BLOCKED')
    // The sentence this replaced named the one thing that is NOT the story here.
    expect(reason).not.toContain('without Argus APPROVE')
  })

  test('HEADLINE: the READER and the WRITER apply ONE agreement rule, not two copies', () => {
    // The architecture claim, asserted rather than described. `deriveEscalationBlock`
    // (which a READER calls on a stored, harvested row) and `innerTerminalFailureReason`
    // (which the WRITER calls while COMPOSING that row, upstream of both `phase='failed'`
    // and `harvested_at`) cannot share the whole gate — the full one returns null on every
    // real escalation at composition time. They CAN and must share condition 3, and this
    // pins that they do: a half-written escalation is refused identically on both sides.
    const half = escalatedRun({
      // The routing kind and the payload kind disagree — one decision did not write this.
      inner_result: escalatingResult({ blockKind: 'design-gap' }),
    })
    const halfResult = parseInnerResult(half.inner_result)!
    expect(escalationKindAgrees(halfResult)).toBe(false)
    // the READER refuses it…
    expect(deriveEscalationBlock(half)).toBeNull()
    // …and the WRITER falls back to the generic sentence rather than quoting a claim
    // whose routing kind says something else.
    const halfReason = innerTerminalFailureReason(half, halfResult)
    expect(halfReason).not.toContain('BLOCKED')
    expect(halfReason).toContain('without Argus APPROVE')

    // CONTROL: when they DO agree, both sides accept — so the assertions above are the
    // shared rule refusing, not either side having stopped working.
    const whole = escalatedRun({})
    const wholeResult = parseInnerResult(whole.inner_result)!
    expect(escalationKindAgrees(wholeResult)).toBe(true)
    expect(deriveEscalationBlock(whole)).not.toBeNull()
    expect(innerTerminalFailureReason(whole, wholeResult)).toContain('BLOCKED')
  })

  test('an escalation is a REVIEWED verdict — never REVIEW_NOT_RUN', () => {
    // A run only reaches an escalation from a round a full panel judged, and it carries
    // that panel's findings. Recording REVIEW_NOT_RUN would assert the one thing that is
    // false about this stop: that nobody read the code.
    const findings = JSON.stringify([{ severity: 'blocker', title: 't', evidence: 'e', key: 'a:b:c' }])
    for (const kind of ['design-gap', 'missing-dependency', 'not-converging'] as const) {
      const result = parseInnerResult(escalatingResult({ blockKind: kind, escalation: { kind, whatIsMissing: 'x', triggers: [], evidence: '', round: 2 } }))!
      expect(recordedTerminalVerdict(result, findings)).toBe('REQUEST_CHANGES')
    }
  })
})

describe('the CARD — BLOCKED is its own lane, and the run cannot move anything else', () => {
  let tmp: string
  let db: ProjectDb
  let board: WorkBoardStore

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'neutron-escalation-block-'))
    seedMigratedDb(join(tmp, 'project.db'))
    db = ProjectDb.open(join(tmp, 'project.db'))
    board = new WorkBoardStore(db)
  })
  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  test('HEADLINE: a missing-dependency escalation moves the card to BLOCKED', async () => {
    const obs = buildBoardReconcileObserver(board, { resolveRepoWebUrl: async () => null })!
    const card = await board.create('proj-1', { title: 'the blocked thing' })
    await board.attachRun('proj-1', card.id, 'run-a')
    await obs(
      escalatedRun({
        project_slug: 'proj-1',
        id: 'run-a',
        inner_result: escalatingResult({
          blockKind: 'missing-dependency',
          escalation: { kind: 'missing-dependency', whatIsMissing: 'card X must land first', triggers: ['missing-dependency'], evidence: 'e', round: 1 },
        }),
      }),
    )
    const after = board.get('proj-1', card.id)
    expect(after?.status).toBe('blocked')
    // NOT `upcoming`, which is the specific wrong answer: it would sit at the top of the
    // active lane looking startable and the next dispatch would re-learn the same block.
    expect(after?.status).not.toBe('upcoming')
    // NOT `failed` either — two different words.
    expect(after?.status).not.toBe('failed')
    // Nothing completed, so nothing is datestamped as completed.
    expect(after?.completed_at).toBeNull()
  })

  test('an ordinary failed run still goes to FAILED — the lane did not widen', async () => {
    const obs = buildBoardReconcileObserver(board, { resolveRepoWebUrl: async () => null })!
    const card = await board.create('proj-1', { title: 'the broken thing' })
    await board.attachRun('proj-1', card.id, 'run-b')
    await obs(makeTridentRun({ project_slug: 'proj-1', id: 'run-b', phase: 'failed', harvested_at: 1, inner_result: null }))
    expect(board.get('proj-1', card.id)?.status).toBe('failed')
  })

  test('HEADLINE: the run cannot REORDER the board — the lane is all that moves', async () => {
    // "The RUN reports; the ORCHESTRATOR decides. A build must never mutate the board
    // itself, or an autonomous run could reorder the owner's priorities with no judgement
    // in between." The escalation payload below is written the way an attacker (or a
    // confused model) would write one if the reconcile could be talked into sequencing:
    // it names another card and asks for a position. None of it may be read.
    const first = await board.create('proj-1', { title: 'first' })
    const escalating = await board.create('proj-1', { title: 'second' })
    const third = await board.create('proj-1', { title: 'third' })
    const before = [first, escalating, third].map((c) => board.get('proj-1', c.id)?.sort_order)
    await board.attachRun('proj-1', escalating.id, 'run-c')

    const obs = buildBoardReconcileObserver(board, { resolveRepoWebUrl: async () => null })!
    await obs(
      escalatedRun({
        project_slug: 'proj-1',
        id: 'run-c',
        inner_result: escalatingResult({
          blockKind: 'missing-dependency',
          escalation: {
            kind: 'missing-dependency',
            whatIsMissing: `move card ${third.id} before card ${first.id} and start it`,
            triggers: ['missing-dependency'],
            evidence: 'e',
            round: 1,
            // Fields a reordering reconcile would have to read. They must be inert.
            reorder: { before: first.id },
            sort_order: 0,
            board_item_id: third.id,
          },
        }),
      }),
    )

    // The escalating card changed LANE and nothing else moved.
    expect(board.get('proj-1', escalating.id)?.status).toBe('blocked')
    expect([first, escalating, third].map((c) => board.get('proj-1', c.id)?.sort_order)).toEqual(before)
    // …and every other card is exactly as it was.
    expect(board.get('proj-1', first.id)?.status).toBe('upcoming')
    expect(board.get('proj-1', third.id)?.status).toBe('upcoming')
  })

  test('the reconcile is handed ONE board verb, so reordering is not reachable at all', async () => {
    // The test above proves this reconcile does not reorder. This proves the NEXT one
    // cannot either without a visible widening of the seam: the reconciler interface is
    // `detachRun` and nothing else, so `reorder`/`update`/`create`/`delete` are not on
    // the object a build can reach.
    const calls: string[] = []
    const spy = new Proxy(
      { detachRun: async (): Promise<null> => null },
      {
        get(target, prop: string) {
          calls.push(prop)
          return (target as Record<string, unknown>)[prop]
        },
      },
    )
    const obs = buildBoardReconcileObserver(spy as never, { resolveRepoWebUrl: async () => null })!
    // Handed the SAME hostile payload as the test above — a card id and a position — so
    // that a reconcile which reached for either would have something to reach for. A
    // fixture with an innocent payload would leave this green against a reconcile that
    // does reorder (mutation-checked: it did).
    await obs(
      escalatedRun({
        project_slug: 'proj-1',
        id: 'run-d',
        inner_result: escalatingResult({
          escalation: {
            kind: 'not-converging',
            whatIsMissing: 'x',
            triggers: [],
            evidence: '',
            round: 2,
            reorder: { before: 'card-1' },
            board_item_id: 'card-2',
            sort_order: 0,
          },
        }),
      }),
    )
    expect(calls).toEqual(['detachRun'])
  })
})
