/**
 * THE CARD'S DISTINGUISHABILITY PROOF.
 *
 * The measurement this card is built on could not be trusted because a terminal
 * row said `REQUEST_CHANGES` whether a reviewer had rejected the work or nothing
 * had reviewed it at all. The table below is the evidence that the three states
 * are now computable FROM `code_trident_runs` COLUMNS ALONE — no new column, no
 * backfill, no rewriting of the historical rows the 30-day distribution came from.
 *
 * The trustworthy count of REAL rejections is therefore, exactly:
 *
 *     terminalRunDisposition(row) === 'reviewed-rejected'
 *
 * and the salvageable waste — the 33 runs that reached `forge-done` and were then
 * rebuilt from scratch — is `'built-never-reviewed'`.
 */

import { describe, expect, test } from 'bun:test'
import { makeTridentRun } from './testing/make-trident-run.ts'
import {
  builtButNeverReviewedSeed,
  terminalRunDisposition,
  type TerminalRunDisposition,
} from './run-disposition.ts'
import type { TridentPhase, TridentVerdict } from './store.ts'

const HEAD = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

interface Row {
  phase?: TridentPhase
  verdict?: TridentVerdict | null
  checkpoint?: string | null
  findings?: string | null
}

const CASES: ReadonlyArray<readonly [string, Row, TerminalRunDisposition]> = [
  // ── died before build: no review ran AND no commit exists to salvage ──────
  ['a null checkpoint', { checkpoint: null }, 'died-before-build'],
  ['inner-error', { checkpoint: 'inner-error' }, 'died-before-build'],
  ['awaiting-trailer', { checkpoint: 'awaiting-trailer' }, 'died-before-build'],
  // `ralph-task-built` has a COMMIT behind it, and still belongs here: the bucket
  // is "no build this dispatch may resume", not "the disk is empty". A ralph
  // iteration builds one task and hands back, so `resumeOnUnchangedHead` answers
  // `unknown-checkpoint` → rebuild for it on every head; a seed promising review
  // would be a lie about what the workflow does next. Conservative in the only
  // direction that is safe — it costs a rebuild that already happens today, and
  // never hands unreviewed work to a resume that will not review it.
  ['ralph-task-built — built, but the workflow rebuilds it by design', { checkpoint: 'ralph-task-built' }, 'died-before-build'],

  // ── built, never judged: a commit exists and nothing has an opinion on it ──
  ['forge-done + REVIEW_NOT_RUN', { checkpoint: 'forge-done' }, 'built-never-reviewed'],
  [
    'fix-round-3 with the LEGACY null verdict',
    { checkpoint: 'fix-round-3', verdict: null },
    'built-never-reviewed',
  ],
  [
    'an outer-published checkpoint',
    { checkpoint: `outer-published:${OTHER}:0:1` },
    'built-never-reviewed',
  ],
  [
    'a DEVIATED outer-published checkpoint',
    { checkpoint: `outer-published:${OTHER}:2:3:deviated` },
    'built-never-reviewed',
  ],

  // ── a reviewer actually spoke ─────────────────────────────────────────────
  [
    'REQUEST_CHANGES carrying findings',
    { verdict: 'REQUEST_CHANGES', checkpoint: 'argus-request-changes', findings: '[{"title":"x"}]' },
    'reviewed-rejected',
  ],
  [
    'the LEGACY fabricated shape — REQUEST_CHANGES at forge-done with EMPTY findings',
    { verdict: 'REQUEST_CHANGES', checkpoint: 'forge-done', findings: '[]' },
    'reviewed-rejected',
  ],
  ['APPROVE', { phase: 'done', verdict: 'APPROVE', checkpoint: 'argus-approved' }, 'approved'],
]

function row(over: Row) {
  return makeTridentRun({
    phase: over.phase ?? 'failed',
    inner_verdict: over.verdict === undefined ? 'REVIEW_NOT_RUN' : over.verdict,
    inner_checkpoint: over.checkpoint ?? null,
    inner_checkpoint_findings: over.findings ?? null,
    inner_checkpoint_head: HEAD,
  })
}

describe('terminalRunDisposition — the three terminal states, from columns alone', () => {
  for (const [name, over, expected] of CASES) {
    test(`${name} → ${expected}`, () => {
      expect(terminalRunDisposition(row(over))).toBe(expected)
    })
  }

  test('every terminal phase classifies; a LIVE phase is never classified at all', () => {
    for (const phase of ['done', 'failed', 'stopped'] as const) {
      expect(terminalRunDisposition(row({ phase, checkpoint: 'forge-done' }))).toBe(
        'built-never-reviewed',
      )
    }
    for (const phase of ['forge-init', 'argus', 'forge-fix'] as const) {
      expect(terminalRunDisposition(row({ phase, checkpoint: 'forge-done' }))).toBe('not-terminal')
    }
  })

  test('the round domain is the parsers\' — nine digits, not "any digits"', () => {
    // THIRD COPY of the two round-bearing shapes (`checkpointRound` and the bash
    // `round_for_checkpoint` are the other two, and both stop at nine digits so the
    // bash `10#$digits` arithmetic cannot wrap). A copy that accepted more would
    // call a name salvageable and then seed a resume whose round neither parser can
    // read. Both sides of the bound, so this cannot pass by rejecting everything.
    expect(terminalRunDisposition(row({ checkpoint: 'fix-round-123456789' }))).toBe(
      'built-never-reviewed',
    )
    expect(terminalRunDisposition(row({ checkpoint: 'fix-round-1234567890' }))).toBe(
      'died-before-build',
    )
    const oid = 'a'.repeat(40)
    expect(terminalRunDisposition(row({ checkpoint: `outer-published:${oid}:1:123456789` }))).toBe(
      'built-never-reviewed',
    )
    expect(terminalRunDisposition(row({ checkpoint: `outer-published:${oid}:1:1234567890` }))).toBe(
      'died-before-build',
    )
  })

  test('the checkpoint trim is the ASCII whitespace set — the one all three dialects share', () => {
    // The SQL twin in docs/AS_BUILT.md trims ' ', TAB, LF, VT, FF, CR and the bash
    // mirror trims the six ASCII characters; JS `.trim()` would also eat NBSP and the Unicode
    // separators, which neither of the other two can express. Matching the narrow
    // set is what makes the published equivalence total rather than corpus-bounded.
    for (const pad of [' ', '\t', '\n', '\v', '\f', '\r']) {
      expect(terminalRunDisposition(row({ checkpoint: `${pad}forge-done${pad}` }))).toBe(
        'built-never-reviewed',
      )
    }
    // …and the padding NO dialect here strips.
    expect(terminalRunDisposition(row({ checkpoint: '\u00a0forge-done\u00a0' }))).toBe(
      'died-before-build',
    )
  })

  test('the taxonomy partitions: no terminal row falls outside the three states', () => {
    const seen = new Set(CASES.map(([, over]) => terminalRunDisposition(row(over))))
    expect(seen).toEqual(
      new Set<TerminalRunDisposition>(['died-before-build', 'built-never-reviewed', 'reviewed-rejected', 'approved']),
    )
  })
})

/** The origin/<base> pin every seedable prior row must carry. */
const BASE = 'c'.repeat(40)

describe('builtButNeverReviewedSeed — what may be handed to the next dispatch', () => {
  test('a forge-done row hands over checkpoint, head, findings VERBATIM and the BASE PIN', () => {
    const findings = '[{"severity":"P2","title":"suite result"}]'
    const base = BASE
    const seed = builtButNeverReviewedSeed(
      makeTridentRun({
        phase: 'failed',
        inner_verdict: 'REVIEW_NOT_RUN',
        inner_checkpoint: 'forge-done',
        inner_checkpoint_head: HEAD,
        inner_checkpoint_findings: findings,
        base_sha: base,
        pr: 7,
      }),
    )
    // EXACT SHAPE, so a field added to the seed has to be argued for here first.
    // `base_sha` travels because a seeded row is not a fresh launch and will never
    // be re-pinned, which would leave the publish-time cut-from-origin refusal
    // (gated on `base_sha !== null`) permanently inert for salvaged runs.
    // `pr` deliberately does NOT: `launch()` reads `run.pr ?? detectExistingPr(run)`,
    // so a carried number short-circuits that probe onto a PR that may since have
    // been closed — the prior run's 7 must not appear anywhere in this object.
    expect(seed).toEqual({ checkpoint: 'forge-done', head: HEAD, findings, base_sha: base })
  })

  test('RALPH PARITY: a bare forge-done never seeds a ralph run, but fix-round/published do', () => {
    // The drift this closes: `resumeOnUnchangedHead` (inner-workflow.mjs) answers
    // `{ mode: 'rebuild', reason: 'ralph-progress-unknown' }` for `forge-done` when
    // `ralph === true` — a ralph build says nothing about whether the PLAN is done.
    // Seeding it would strip the leftover-branch guard off a run the workflow then
    // rebuilds anyway: all of the cost, none of the saving.
    const ralphRow = (checkpoint: string) =>
      makeTridentRun({
        phase: 'failed',
        inner_verdict: 'REVIEW_NOT_RUN',
        inner_checkpoint: checkpoint,
        inner_checkpoint_head: HEAD,
        base_sha: BASE,
      })
    expect(builtButNeverReviewedSeed(ralphRow('forge-done'), { ralph: true })).toBeNull()
    // Positive control on the SAME row: without ralph it is the salvageable shape,
    // so the null above is the flag talking and not a broken fixture.
    expect(builtButNeverReviewedSeed(ralphRow('forge-done'), { ralph: false })?.checkpoint).toBe(
      'forge-done',
    )
    expect(builtButNeverReviewedSeed(ralphRow('forge-done'))?.checkpoint).toBe('forge-done')
    // The two shapes the workflow reviews in BOTH modes still seed under ralph.
    expect(builtButNeverReviewedSeed(ralphRow('fix-round-2'), { ralph: true })?.checkpoint).toBe(
      'fix-round-2',
    )
    expect(
      builtButNeverReviewedSeed(ralphRow(`outer-published:${OTHER}:0:1`), { ralph: true })?.head,
    ).toBe(OTHER)
    // The DISPOSITION is unmoved by the flag — the row really is built-never-reviewed,
    // and an offline count of the historical table must not turn on a mode flag.
    expect(terminalRunDisposition(ralphRow('forge-done'))).toBe('built-never-reviewed')
  })

  test('an outer-published head comes from the checkpoint NAME, not the head column', () => {
    const seed = builtButNeverReviewedSeed(
      makeTridentRun({
        phase: 'failed',
        inner_verdict: 'REVIEW_NOT_RUN',
        inner_checkpoint: `outer-published:${OTHER}:0:1`,
        // The published name is authoritative even when the column disagrees or is
        // absent — it was stamped against the commit the publish actually pushed.
        inner_checkpoint_head: null,
        base_sha: BASE,
      }),
    )
    expect(seed?.head).toBe(OTHER)
  })

  test('an uppercase recorded head normalises rather than being discarded', () => {
    const seed = builtButNeverReviewedSeed(
      makeTridentRun({
        phase: 'failed',
        inner_verdict: 'REVIEW_NOT_RUN',
        inner_checkpoint: 'fix-round-2',
        inner_checkpoint_head: `  ${HEAD.toUpperCase()}  `,
        base_sha: BASE.toUpperCase(),
      }),
    )
    expect(seed?.head).toBe(HEAD)
    // The pin normalises the same way, so the value written to the new row is the
    // lowercase 40-hex every other reader of `base_sha` compares against.
    expect(seed?.base_sha).toBe(BASE)
  })

  test('NO BASE PIN → no seed: a seeded row can never acquire one', () => {
    // `launch()` re-pins only on a FRESH build (`inner_checkpoint === null &&
    // base_sha === null`), and a seeded checkpoint makes that false. So a seed
    // carrying a null pin would create a row pinned NEVER — and the publish-time
    // "branch does not contain the origin/<base> tip pinned at launch" refusal is
    // gated on `base_sha !== null`, so it could not fire for that run or for any
    // re-seed chained off it. A legacy/unpinned prior row therefore seeds nothing
    // and falls through to the fresh dispatch that DOES pin, which is exactly the
    // behaviour it has today.
    const unpinned = (base_sha: string | null) =>
      makeTridentRun({
        phase: 'failed',
        inner_verdict: 'REVIEW_NOT_RUN',
        inner_checkpoint: 'forge-done',
        inner_checkpoint_head: HEAD,
        base_sha,
      })
    for (const base of [null, '', 'not-a-sha', BASE.slice(0, 39), `${BASE}z`]) {
      expect(builtButNeverReviewedSeed(unpinned(base))).toBeNull()
    }
    // POSITIVE CONTROL on the SAME row shape: with a real pin it seeds, so the
    // nulls above are the pin talking and not a broken fixture.
    expect(builtButNeverReviewedSeed(unpinned(BASE))?.base_sha).toBe(BASE)
  })

  test('a STOPPED prior never seeds — an operator discard is not salvage material', () => {
    // `stopped` has exactly two writers, both explicit operator cancels: `/code
    // stop` and the board's X-cancel/delete, through `trident/terminate.ts`. It is
    // never a crash, a reap or a budget death. Adopting a cancelled run's commit
    // into the next dispatch would re-enter work the owner deliberately threw away,
    // with the leftover-branch refusal stripped off the run that did it.
    const cancelled = makeTridentRun({
      phase: 'stopped',
      inner_verdict: 'REVIEW_NOT_RUN',
      inner_checkpoint: 'forge-done',
      inner_checkpoint_head: HEAD,
      base_sha: BASE,
    })
    expect(builtButNeverReviewedSeed(cancelled)).toBeNull()
    // …and every OTHER salvageable checkpoint shape is refused on the same ground,
    // so this is the phase talking and not one name.
    for (const ck of ['fix-round-2', `outer-published:${OTHER}:0:1`]) {
      expect(builtButNeverReviewedSeed({ ...cancelled, inner_checkpoint: ck })).toBeNull()
    }
    // THE DISPOSITION IS UNMOVED. The offline count is about what happened, and a
    // cancelled run really did build without being reviewed — only the SEED refuses.
    expect(terminalRunDisposition(cancelled)).toBe('built-never-reviewed')
    // POSITIVE CONTROL on the identical row: the same shape that died of anything
    // else seeds, so the nulls above are the cancel signal and not a broken fixture.
    expect(builtButNeverReviewedSeed({ ...cancelled, phase: 'failed' })?.head).toBe(HEAD)
  })

  test('NO recorded head → no seed: there is nothing to prove the branch against', () => {
    for (const head of [null, '', 'abc123', HEAD.slice(0, 39), `${HEAD}z`]) {
      expect(
        builtButNeverReviewedSeed(
          makeTridentRun({
            phase: 'failed',
            inner_verdict: 'REVIEW_NOT_RUN',
            inner_checkpoint: 'forge-done',
            inner_checkpoint_head: head,
          }),
        ),
      ).toBeNull()
    }
  })

  test('a REJECTED prior NEVER seeds — including the legacy empty-findings shape', () => {
    for (const findings of ['[{"title":"real"}]', '[]', null]) {
      expect(
        builtButNeverReviewedSeed(
          makeTridentRun({
            phase: 'failed',
            inner_verdict: 'REQUEST_CHANGES',
            inner_checkpoint: 'forge-done',
            inner_checkpoint_head: HEAD,
            inner_checkpoint_findings: findings,
          }),
        ),
      ).toBeNull()
    }
  })

  test('an approved or died-before-build prior never seeds either', () => {
    expect(
      builtButNeverReviewedSeed(
        makeTridentRun({
          phase: 'done',
          inner_verdict: 'APPROVE',
          inner_checkpoint: 'argus-approved',
          inner_checkpoint_head: HEAD,
        }),
      ),
    ).toBeNull()
    expect(
      builtButNeverReviewedSeed(
        makeTridentRun({
          phase: 'failed',
          inner_verdict: 'REVIEW_NOT_RUN',
          inner_checkpoint: 'inner-error',
          inner_checkpoint_head: HEAD,
        }),
      ),
    ).toBeNull()
  })

  test('a still-LIVE run is never a seed source', () => {
    expect(
      builtButNeverReviewedSeed(
        makeTridentRun({
          phase: 'argus',
          inner_verdict: 'REVIEW_NOT_RUN',
          inner_checkpoint: 'forge-done',
          inner_checkpoint_head: HEAD,
        }),
      ),
    ).toBeNull()
  })
})
