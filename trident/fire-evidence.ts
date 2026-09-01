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

/**
 * The EXACT error string `buildSubstrateWorkflowFire` resolves on a launcher
 * settle timeout. Authored HERE, once, and imported by both the producer
 * (`inner-loop.ts`) and the consumer (`orchestrator.ts`) — the gate keys on
 * string equality, so a reworded literal on one side would silently disable it.
 */
export const FIRE_SETTLE_TIMEOUT_ERROR = 'fire turn did not settle within the budget'

/**
 * The phrase that makes a terminal row READ as "the work was finished and
 * pushed, the review simply never ran" rather than as a failed fire. The wake
 * prompt keys on it to say "verify the PR and dispatch a review" instead of
 * "relaunch", so it is a contract string, not decoration.
 */
export const FIRE_PUBLISHED_REASON_MARKER = 'already built and published'

/**
 * The outer loop's published-checkpoint shape, written by the orchestrator when
 * it pushes: `outer-published:<40-hex-oid>:<remaining_tasks>:<round>[:deviated]`.
 *
 * SEMANTICALLY IDENTICAL to `trident/run-disposition.ts`'s sibling on the
 * terminal-taxonomy branch (not on main yet) — same anchors, same field shapes,
 * same bounds. It is NOT character-for-character: this copy CAPTURES the sha,
 * remaining and round groups because `publishedFailureReason` renders them
 * field-by-field, where run-disposition's copy only tests. WHEN THAT MODULE
 * LANDS ON MAIN, DEDUPE TO ONE EXPORT (this capturing form is the superset) —
 * two copies of one regex is a temporary cost of two branches in flight, not a
 * design.
 *
 * The round field is BOUNDED (`\d{1,9}`) ON PURPOSE: it matches what
 * `checkpointRound` / `checkpoint.sh` can actually write, so an absurd
 * pseudo-round cannot pass as a published checkpoint.
 */
export const OUTER_PUBLISHED_CHECKPOINT = /^outer-published:([0-9a-f]{40}):(\d+):(\d{1,9})(?::deviated)?$/

/**
 * What a settle-timeout gatherer may report. THREE-VALUED, and only the first two
 * are evidence:
 *
 *   • `launched`  — the workflow is believed LIVE. Distinct from `fired`: the
 *     launcher never confirmed. The lane is HELD, not terminalized.
 *   • `published` — the work is FINISHED and pushed; the row's own
 *     `inner_checkpoint` says so. Terminal, but as built-and-published /
 *     review-not-run, never as a failed fire.
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
 *   2. else the effective row carries an `outer-published:…` checkpoint → `published`;
 *   3. else → `none`.
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
  if (OUTER_PUBLISHED_CHECKPOINT.test(name)) {
    return {
      kind: 'published',
      checkpoint: name,
      detail: 'run row already carries an outer-published checkpoint',
      // THE TRIMMED NAME, not the raw column. `checkpoint` above (and the
      // failure_reason rendered from it) quote the trimmed form, and `observed`
      // is what the caller PERSISTS — so carrying the untrimmed value here would
      // leave the row saying one thing and the reason quoting another.
      ...(fresh !== null ? { observed: { ...pickWorkflowOwned(fresh), inner_checkpoint: name } } : {}),
    }
  }
  return { kind: 'none', detail: 'row unchanged and not published' }
}

/**
 * The failure_reason for the published case. It must say, in the operator's
 * words, that the WORK IS DONE and only the review is missing.
 *
 * HARD CONSTRAINTS, and they are why this string is authored in one place with a
 * test that guards it: `interpretFailure` (`delivery.ts`) routes failure classes
 * by KEYWORDS, and the salvage-marker rules key on others. Any of those tokens in
 * here would report a finished, published build as a hang, a merge problem, or a
 * rejection. So: ≤200 chars (the honest fallback quotes it verbatim), none of the
 * classifier tokens, and NO filesystem paths (leak gate).
 */
/**
 * The ≤200-char ceiling `publishedFailureReason` promises — a CONSTANT the
 * function enforces, not a number in prose. The bound was documented and
 * unenforced: the non-matching fallback path rendered 639 chars from a 500-char
 * input, because only the 40-hex sha was abbreviated there.
 */
export const PUBLISHED_REASON_MAX_CHARS = 200

const PUBLISHED_REASON_HEAD = `launcher settle timeout over work ${FIRE_PUBLISHED_REASON_MARKER} (`
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
  const budget = PUBLISHED_REASON_MAX_CHARS - PUBLISHED_REASON_HEAD.length - PUBLISHED_REASON_TAIL.length
  const short = rendered.length > budget ? `${rendered.slice(0, budget - 1)}…` : rendered
  return `${PUBLISHED_REASON_HEAD}${short}${PUBLISHED_REASON_TAIL}`
}
