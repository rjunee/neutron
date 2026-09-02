/**
 * FIRE SETTLE-TIMEOUT EVIDENCE — the pure decision half of the launcher-timeout gate.
 *
 * WHY THIS EXISTS. `buildSubstrateWorkflowFire` (`inner-loop.ts`) resolves
 * `fired` the instant the LAUNCHING turn settles; the workflow it fired keeps
 * running DETACHED. On a settle timeout the launcher turn is cancelled and the
 * fire resolves `{ status:'failed', error: FIRE_SETTLE_TIMEOUT_ERROR }` — and the
 * orchestrator has, until this module, terminalized the run on that alone. That
 * inference is invalid: cancelling the LAUNCHER does not cancel the workflow.
 * Measured over 7 days, 8 of 33 runs died on this seam; one was written off at
 * 181 s while its workflow went on to cut a worktree and write a correct plan
 * five minutes later, and twice the row that was stamped `failed` already carried
 * `outer-published:<sha>:<remaining>:<round>` — built, pushed, CI green.
 *
 * POSITIVE EVIDENCE OR NOTHING. Only POSITIVE evidence may change the timeout
 * outcome. A blind or throwing gatherer keeps today's `failed` — deliberately the
 * INVERSE of `run-evidence.ts`'s unknown-defers rule, because there `unknown`
 * defers a KILL of a run already believed live, whereas sparing here without
 * evidence would hold a lane for the whole stall budget on every genuine fire
 * failure. With the orchestrator's `gather_fire_evidence` seam UNWIRED the
 * behaviour is byte-identical to before this module existed; production stays
 * unchanged until the composition root wires a gatherer.
 *
 * PURE: no I/O, no clock, no process access. The probes live behind the seam.
 */
import type { TridentRun } from './store.ts'
import { OUTER_PUBLISHED_CHECKPOINT } from './checkpoint-round.ts'

/**
 * The EXACT error string `buildSubstrateWorkflowFire` resolves on a launcher
 * settle timeout. Authored HERE, once, and imported by both the producer
 * (`inner-loop.ts`) and the consumer (`orchestrator.ts`) — the gate keys on
 * string equality, so a reworded literal on one side would silently disable it.
 */
export const FIRE_SETTLE_TIMEOUT_ERROR = 'fire turn did not settle within the budget'

/**
 * The MACHINE ANCHOR that makes a terminal row READ as "the work was finished
 * and pushed, the review simply never ran" rather than as a failed fire. The
 * wake prompt and `interpretFailure` key on it to say "verify the PR and
 * dispatch a review" instead of "relaunch", so it is a contract string, not
 * decoration.
 *
 * IT IS A BRACKETED TOKEN, NOT THE ENGLISH SENTENCE IT ACCOMPANIES (Argus r4).
 * It used to be the plain phrase `already built and published`, and BOTH
 * consumers match it with `includes()` — so any failure_reason that merely
 * QUOTED that phrase (an assertion message, a diff excerpt, a reviewer's own
 * words) classified a genuinely failed build as published-unreviewed and
 * suppressed its relaunch. Measured repro: `forge assertion failed: expected
 * text already built and published to be absent`. The English still appears in
 * the rendered reason, for the operator; only the MATCH moved to a token that
 * cannot occur in prose which is not deliberately imitating this one.
 */
export const FIRE_PUBLISHED_REASON_MARKER = '[trident:published-unreviewed]'

/**
 * The outer loop's published-checkpoint shape — RE-EXPORTED, NOT RESPELLED.
 *
 * There used to be a second copy here, because this gate CAPTURES the sha /
 * remaining / round fields (`publishedFailureReason` renders them one by one)
 * where `checkpoint-round.ts` only tested them. Two spellings of one shape
 * diverged exactly as you would expect — the round was bounded here and
 * unbounded there — so the capturing, bounded form moved into
 * `checkpoint-round.ts` (the leaf, already on `main`, importing nothing) and
 * this module imports it. The re-export keeps this file the one place the
 * settle-timeout gate's own consumers import from.
 *
 * Groups: 1 = sha, 2 = remaining tasks, 3 = round.
 */
export { OUTER_PUBLISHED_CHECKPOINT } from './checkpoint-round.ts'

/**
 * What a settle-timeout gatherer may report. THREE-VALUED, and only the first two
 * are evidence:
 *
 *   • `launched`  — the workflow is believed LIVE. Distinct from `fired`: the
 *     launcher never confirmed. The lane is HELD, not terminalized.
 *   • `published` — the work is FINISHED and pushed; the row's own
 *     `inner_checkpoint` says so, WITH `remaining` zero. Terminal, but as
 *     built-and-published / review-not-run, never as a failed fire. A published
 *     checkpoint with tasks still remaining is NOT this state — it is `none`.
 *   • `none`      — nothing positive was observed (including "could not look").
 *     Today's plain `failed`, byte-identical.
 *
 * WHY `observed` IS ON THE TWO EVIDENCE ARMS, and why the caller MUST APPLY IT.
 * The orchestrator pins the run row BEFORE the fire and writes that pinned
 * snapshot back through `saveIfActive`, which assigns `inner_checkpoint` /
 * `inner_verdict` PLAINLY. So a tick that spares a live lane would, in the same
 * breath, write the pinned values back over the very workflow-owned columns
 * whose movement PROVED the lane was live — silently un-doing a detached
 * workflow's checkpoint. `observed` is the FRESH row's workflow-owned columns as
 * this evidence actually read them; the caller spreads it over the pinned run so
 * the save carries them FORWARD instead of regressing them. Absent only when
 * there was no fresh row to read — then the pinned values are all there is, and
 * are not stale.
 */
export type FireTimeoutEvidence =
  | { kind: 'launched'; detail: string; observed?: WorkflowOwnedColumns }
  | { kind: 'published'; detail: string; checkpoint: string; observed?: WorkflowOwnedColumns }
  | { kind: 'none'; detail: string }


/** What the seam is given: the run as PINNED at fire time, plus when the fire went out. */
export interface FireEvidenceInput {
  run: TridentRun
  fire_started_at_ms: number
}

/**
 * The seam the orchestrator calls, and ONLY when a fire failed with
 * `FIRE_SETTLE_TIMEOUT_ERROR`. May be async (it probes). A throw is NOT evidence
 * — the caller treats it as `none`.
 */
export type FireEvidenceGatherer = (
  input: FireEvidenceInput,
) => Promise<FireTimeoutEvidence> | FireTimeoutEvidence

/**
 * The five columns ONLY the inner workflow writes between the fire and the
 * timeout (via `checkpoint.sh`). A delta on any of them since the pinned row is
 * proof a workflow started.
 *
 * `last_advanced_at` and `crash_recoveries` are DELIBERATELY EXCLUDED: the OUTER
 * loop moves those, so a crash-recovery bump (liveness-death-e2e's shape) would
 * read as launch evidence for a workflow that never started.
 *
 * DETECTION IS WIDER THAN CARRY-FORWARD, on purpose. `saveIfActive` writes only
 * three of these five (`inner_checkpoint`, `inner_verdict`, and
 * `inner_checkpoint_findings` under a COALESCE); `inner_checkpoint_head` and
 * `inner_result` ride along in `observed` inertly, because that save has no
 * column for them. They stay in the set because a delta on either is still
 * PROOF a workflow started — `checkpoint.sh` writes both — and dropping them
 * would blind the detection to buy a carry-forward nobody performs.
 */
export type WorkflowOwnedColumns = Pick<
  TridentRun,
  | 'inner_checkpoint'
  | 'inner_checkpoint_head'
  | 'inner_checkpoint_findings'
  | 'inner_verdict'
  | 'inner_result'
>

const WORKFLOW_OWNED_COLUMNS: ReadonlyArray<keyof WorkflowOwnedColumns> = [
  'inner_checkpoint',
  'inner_checkpoint_head',
  'inner_checkpoint_findings',
  'inner_verdict',
  'inner_result',
]

/**
 * Narrow a full row down to EXACTLY the workflow-owned columns. Copying the
 * whole `TridentRun` into `observed` would let the caller's spread carry back
 * OUTER-owned columns (phase, subagent slot, base pins) that the tick has
 * legitimately moved since the fire — the same clobber, in the other direction.
 */
export function pickWorkflowOwned(row: WorkflowOwnedColumns): WorkflowOwnedColumns {
  return {
    inner_checkpoint: row.inner_checkpoint,
    inner_checkpoint_head: row.inner_checkpoint_head,
    inner_checkpoint_findings: row.inner_checkpoint_findings,
    inner_verdict: row.inner_verdict,
    inner_result: row.inner_result,
  }
}

/**
 * The cheapest evidence there is: the run's OWN row, read twice. No filesystem,
 * no git. Rules, IN ORDER:
 *
 *   1. any workflow-owned column MOVED since the fire → `launched`;
 *   2. else the effective row carries an `outer-published:…` checkpoint WHOSE
 *      `remaining` FIELD IS ZERO → `published`;
 *   3. else → `none`.
 *
 * `remaining` IS A PREDICATE, NOT DECORATION. The checkpoint's shape is
 * `outer-published:<sha>:<remaining>:<round>`, and a NON-ZERO `remaining` means
 * the outer loop pushed a governed round with tasks still unbuilt — work in
 * progress, not finished work. Classifying that as `published` would render
 * `publishedFailureReason`'s "the work is already published … not a rebuild",
 * which `delivery.ts` and `terminal-build-wake.ts` both act on, and a card with
 * unbuilt tasks would be forbidden the rebuild it actually needs. Only
 * `remaining === 0` is the SECOND SHAPE the card measured (both incidents:
 * `outer-published:<sha>:0:<round>`); anything else falls through to `none` and
 * the ordinary recoverable `failed`, which a re-run re-fires.
 *
 * A LIVE DELTA OUTRANKS `outer-published` BY DESIGN. A row can carry a published
 * checkpoint from a PRIOR round while the round just fired is live; terminalizing
 * that lane would abandon a running workflow, which is the exact defect this gate
 * exists to stop. Published work is finished and can be salvaged later; a live
 * lane cannot be un-killed.
 *
 * The detail names COLUMNS, never values — findings and results are prose and
 * would drag arbitrary text (and, worse, paths) into a failure reason.
 */
export function classifyFireTimeoutRow(
  pinned: WorkflowOwnedColumns,
  fresh: WorkflowOwnedColumns | null,
): FireTimeoutEvidence {
  if (fresh !== null) {
    const moved = WORKFLOW_OWNED_COLUMNS.filter((column) => fresh[column] !== pinned[column])
    if (moved.length > 0) {
      return {
        kind: 'launched',
        detail: `run row moved since the fire (${moved.join(', ')})`,
        observed: pickWorkflowOwned(fresh),
      }
    }
  }
  const effective = fresh ?? pinned
  // Plain `String.trim()` is enough here: the regex is anchored and rejects
  // anything the trims could disagree about.
  const name = (effective.inner_checkpoint ?? '').trim()
  const published = OUTER_PUBLISHED_CHECKPOINT.exec(name)
  // `Number` on the captured `\d+` cannot be NaN, and any all-zero spelling
  // ('0', '000') is zero — the only value that means "nothing left to build".
  if (published !== null && Number(published[2]) === 0) {
    return {
      kind: 'published',
      checkpoint: name,
      detail: 'run row already carries an outer-published checkpoint with no tasks remaining',
      // THE RAW COLUMN, VERBATIM — `observed` is the caller's COMPARE-AND-SWAP
      // TOKEN, not the value to write. The store compares `inner_checkpoint IS ?`
      // against what is STORED, so a trimmed token loses the CAS in exactly the
      // whitespace case the trim exists for, and the column is then left
      // untrimmed. `checkpoint` above carries the trimmed name; the caller writes
      // THAT onto the row while CAS-ing on this.
      ...(fresh !== null ? { observed: pickWorkflowOwned(fresh) } : {}),
    }
  }
  return {
    kind: 'none',
    detail:
      published === null
        ? 'row unchanged and not published'
        : // BOUNDED: `remaining` is `\d+` (unbounded) in the pattern, and this
          // string can reach a stamp/note, so cap the digits rather than paste them.
          `row unchanged and its published checkpoint still has ${published[2]!.slice(0, 9)} task(s) remaining`,
  }
}

/**
 * The failure_reason for the published case. It must say, in the operator's
 * words, that the WORK IS DONE and only the review is missing.
 *
 * HARD CONSTRAINTS, and they are why this string is authored in one place with a
 * test that guards it: `interpretFailure` (`delivery.ts`) routes failure classes
 * by KEYWORDS, and the salvage-marker rules key on others. Any of those tokens in
 * here would report a finished, published build as a hang, a merge problem, or a
 * rejection. So: bounded length (the honest fallback quotes it verbatim), none of
 * the classifier tokens, and NO filesystem paths (leak gate).
 */
/**
 * The ceiling `publishedFailureReason` enforces — a CONSTANT, not a number in
 * prose. The bound was documented and unenforced: the non-matching fallback path
 * rendered 639 chars from a 500-char input, because only the 40-hex sha was
 * abbreviated there.
 *
 * IT IS 231, NOT 200, AND THE 31 IS EXACTLY THE MACHINE TOKEN'S COST (Argus r4:
 * 30 chars of `FIRE_PUBLISHED_REASON_MARKER` plus its separating space). The
 * ceiling grew by what the token added so that the budget left for the RENDERED
 * CHECKPOINT is unchanged at 61 — the number the arithmetic below relies on. A
 * flat 200 would have cut every matched checkpoint short and defeated the point
 * of rendering it field-by-field.
 */
export const PUBLISHED_REASON_MAX_CHARS = 231

const PUBLISHED_REASON_HEAD =
  `launcher settle timeout over work already built and published ${FIRE_PUBLISHED_REASON_MARKER} (`
const PUBLISHED_REASON_TAIL =
  ') — review not run; verify the PR and dispatch a review round, not a rebuild'

export function publishedFailureReason(checkpoint: string): string {
  // SHORTEN BY FIELD, NEVER BY `slice` ON THE WHOLE STRING. A blind cut lands
  // mid-field and emits `(outer-published:aaaaaaaaaaaa…:999999)` — a string an
  // operator can copy but which can never match `OUTER_PUBLISHED_CHECKPOINT`,
  // because the round (and any `:deviated`) were silently eaten. So the ONLY
  // thing abbreviated is the 40-hex sha, which is unambiguous at 12; every other
  // field is rendered WHOLE. `remaining` is `\d+` in the pattern (unbounded) so
  // it alone is capped, and the cap is visible as a `…` rather than a silent cut.
  const m = OUTER_PUBLISHED_CHECKPOINT.exec(checkpoint)
  const rendered =
    m === null
      ? // Not a published checkpoint at all — the caller should never get here,
        // but abbreviate the sha and keep the rest rather than invent a shape.
        checkpoint.replace(/[0-9a-f]{40}/, (sha) => `${sha.slice(0, 12)}…`)
      : `outer-published:${m[1]!.slice(0, 12)}…:` +
        // `remaining` is `\d+` (unbounded) in the pattern, so it is the one field
        // that can still need capping — and the cap is VISIBLE as a `…`, never a
        // silent cut. `round` is already bounded to 9 digits by the pattern.
        `${m[2]!.length > 9 ? `${m[2]!.slice(0, 9)}…` : m[2]!}:${m[3]!}` +
        (checkpoint.endsWith(':deviated') ? ':deviated' : '')
  // THE CEILING, ENFORCED. Every field of a MATCHED checkpoint is bounded above
  // (`outer-published:` 16 + sha 12 + `…:` 2 + remaining 9 + `…:` 2 + round 9 +
  // `:deviated` 9 = 59, against a 61-char budget), so this cap can only ever
  // bite the `m === null` fallback — where the input is arbitrary text and
  // the sha abbreviation alone bounds nothing. A 639-char reason from a 500-char
  // input was measured on that path; the docblock's "≤200" was prose until here.
  // The cut is still VISIBLE as a `…`, and it is applied to the rendered
  // checkpoint ALONE so the operator-facing sentence around it always survives.
  //
  // AND THE CUT DOES NOT SPLIT A CHARACTER. `slice` counts UTF-16 code units, so
  // cutting between a surrogate pair emits a LONE surrogate — an unpaired code
  // unit that reads as a replacement glyph wherever this reason is rendered and
  // is not valid UTF-8 to anything that re-encodes it. Only the `m === null`
  // fallback carries arbitrary text, so this is the only place it can happen;
  // drop the orphaned half rather than ship it.
  const budget = PUBLISHED_REASON_MAX_CHARS - PUBLISHED_REASON_HEAD.length - PUBLISHED_REASON_TAIL.length
  const cut = rendered.slice(0, budget - 1)
  const lastUnit = cut.charCodeAt(cut.length - 1)
  const whole = lastUnit >= 0xd800 && lastUnit <= 0xdbff ? cut.slice(0, -1) : cut
  const short = rendered.length > budget ? `${whole}…` : rendered
  return `${PUBLISHED_REASON_HEAD}${short}${PUBLISHED_REASON_TAIL}`
}

/**
 * DOES THIS `failure_reason` COME FROM `publishedFailureReason`? — the ONLY
 * question either consumer actually wants answered.
 *
 * ANCHORED ON THE PRODUCER'S SHAPE, NOT ON A SUBSTRING ANYWHERE (Argus r8).
 * Both consumers used to ask `reason.includes(FIRE_PUBLISHED_REASON_MARKER)`.
 * Moving the match from the English phrase to a bracketed token (r4) killed the
 * realistic collision, but not the mechanism: a reason that EMBEDS substrate
 * text quoting the literal token still matched. That is not hypothetical here —
 * trident builds trident, and `delivery.ts` documents that launcher-crash
 * reasons embed substrate output VERBATIM, so a failed build whose stderr
 * quoted this file would have been reported as "finished and pushed" and had
 * its relaunch suppressed. The token appears at a FIXED position in every
 * reason this seam authors — inside `PUBLISHED_REASON_HEAD`, at offset zero —
 * so match the head, and quoted text can only ever appear after it.
 *
 * Case-insensitive and leading-space tolerant because `interpretFailure`
 * lowercases and trims before classifying; the head is already lowercase, so
 * this costs nothing and keeps the two call sites able to pass either form.
 */
export function isPublishedUnreviewedReason(reason: string): boolean {
  return reason.trimStart().toLowerCase().startsWith(PUBLISHED_REASON_HEAD.toLowerCase())
}
