import { CodexProjectOwnerError } from './codex-project-owner.ts'
import { hasArgusProvenance } from './checkpoint-phase.ts'
import { escalationKindAgrees } from './escalation-block.ts'
import {
  ESCALATION_KINDS,
  parseCheckpointFindings,
  type EscalationKind,
  type InnerResult,
  type TridentWorkflowFirer,
} from './inner-loop.ts'
import { executeBoundReview } from './review-run.ts'
import type { AdvanceOutcome } from './state-machine.ts'
import type { TridentRun } from './store.ts'
import type { DiffOutputHost } from './git-mode.ts'

/**
 * REQUEST_CHANGES is reserved for a reviewer that judged the code and recorded
 * at least one finding. `round-lost` and `infra-only` both mean the code was not
 * (re-)judged (the inner workflow's own terminology), while an empty finding set
 * is either approval or infrastructure failure — never a rejection.
 *
 * `advisory-only` IS A REVIEW AND IS RECORDED AS ONE. It is the workflow's statement that
 * a healthy panel judged the code and every finding it returned was one the workflow has
 * already declared non-blocking — so the fix loop exits without buying a round. That is the
 * opposite of `infra-only`, and reading it as REVIEW_NOT_RUN was untrue in the one direction
 * that costs real work: a resume off that row re-Forged a whole round on findings the run
 * had already settled as non-actionable.
 *
 * AND THE REVIEWER MUST ACTUALLY HAVE RUN. Findings alone do not prove that: the
 * suite gate in `inner-workflow.mjs` writes a `blocker` of its own ("FULL SUITE
 * NOT PROVEN …") on a build that never reached a reviewer, and that build carries
 * `block_kind: 'code'` too — so all three of the old conditions were satisfied by
 * a run whose review provably never happened. Measured over this database at the
 * time of the fix: of 160 terminal REQUEST_CHANGES rows only 18 carried an Argus
 * checkpoint; 68 stopped at `forge-done` and 45 at `inner-error`. Those rows are
 * why a queue of un-reviewed builds reads as reviewed-and-rejected, and why
 * re-dispatching them changes nothing — there was never a finding to answer.
 *
 * The findings themselves are still PRESERVED on the row; only the verdict
 * changes, because the verdict is the part that was untrue.
 */
export function recordedTerminalVerdict(
  result: Pick<InnerResult, 'verdict' | 'block_kind' | 'checkpoint' | 'escalation'>,
  rowFindings: string | null,
): 'REQUEST_CHANGES' | 'REVIEW_NOT_RUN' {
  if (result.verdict !== 'REQUEST_CHANGES') return 'REVIEW_NOT_RUN'
  // ARGUS PROVENANCE IS REQUIRED OF EVERY KIND, and it is the condition the paragraphs
  // above are about. Nothing below weakens it.
  if (!hasArgusProvenance(result.checkpoint)) return 'REVIEW_NOT_RUN'

  // AN ESCALATION IS A REVIEWED VERDICT, AND ITS FINDINGS LIST MAY BE EMPTY. That second
  // half was missing, and it discarded the CLEANEST possible escalation: a panel that
  // concludes the PLAN is wrong often has no individual code finding to write, because the
  // code is a faithful implementation of a bad plan. `VERDICT_SCHEMA` has no `minItems` on
  // `findings`, so `{verdict:'REQUEST_CHANGES', block_kind:'design-gap', findings:[]}` is
  // schema-valid — and it was being recorded as REVIEW_NOT_RUN, which is how a resume
  // re-Forges a whole round against the same wrong plan with no finding to answer. That is
  // the precise behaviour this card exists to stop, reproduced by the card's own remedy.
  //
  // WHY DROPPING THE FINDINGS CHECK IS SAFE HERE, AND ONLY HERE. The argument above — that
  // findings do not prove a reviewer ran — is an argument about FINDINGS: the suite gate
  // writes its own `blocker` on a build that never reached a reviewer, and that build
  // carries `block_kind: 'code'`. It does not transfer to an escalation, because the suite
  // gate cannot produce one. An escalation requires `kind` AND `whatIsMissing`, only a
  // reviewer's own reply can carry it (`synthesisRaw.escalate`, never the merged findings),
  // and `hasArgusProvenance` is still required above. So for these kinds the declaration
  // IS the proof, and findings are evidence of a different question.
  //
  // NOT "≥1 finding whenever an escalation is present", which was the other available fix:
  // that would make a reviewer invent a code finding to be allowed to say the plan is
  // wrong, and a schema that forces a model to fabricate an artifact it does not have is
  // worse than the bug.
  //
  // VALIDATED STRUCTURALLY, not by the kind alone: `escalationKindAgrees` is the SAME
  // function the reader and the writer of the block already share, so a row whose routing
  // kind and payload disagree is a half-written escalation here too, and falls through to
  // the findings requirement below rather than being taken on the strength of its label.
  if (
    ESCALATION_KINDS.includes(result.block_kind as EscalationKind) &&
    escalationKindAgrees(result)
  ) {
    return 'REQUEST_CHANGES'
  }

  // `code` and `advisory-only` KEEP the findings requirement, unchanged. Nothing above
  // touches them, and the measurement that motivated it (18 of 160 terminal rows carrying
  // an Argus checkpoint) is about exactly these.
  if (
    (result.block_kind === 'code' || result.block_kind === 'advisory-only') &&
    parseCheckpointFindings(rowFindings).length > 0
  ) {
    return 'REQUEST_CHANGES'
  }
  return 'REVIEW_NOT_RUN'
}

export interface BoundReviewDeps {
  run_host: DiffOutputHost
  /** The isolated panel cannot use the composition's project-build launcher. */
  fire_review_panel?: TridentWorkflowFirer
  execute_bound_review?: typeof executeBoundReview
  codex_home?: string | null
  resolve_codex_home?: (run: TridentRun) => string | null
  gh_data_dir?: string | null
  gh_owner_handle?: string | null
  resolve_kimi_configured?: () => boolean
  resolve_phase_models?: () => Record<string, { model?: string; effort?: string }> | null
  panel_timeout_ms: number
  failed_run: (run: TridentRun, reason: string, keepSubagentId: boolean) => TridentRun
  now: () => string
}

export async function advanceBoundReview(run: TridentRun, deps: BoundReviewDeps): Promise<AdvanceOutcome | null> {
  // A review-only bound run dispatches CLOSED (SPEC card 2026-08-18; bound_pr was 0 of 190 runs).
  // The measured failure mode is a "review PR #N" dispatch building a docs PR about reviewing
  // (#542/#541/#530) while #N's review-gate stays red. Guarding at launch covers BOTH call sites
  // (the fresh launch ~2896 and the crash-recovery relaunch ~2769). The review executor lives
  // HERE and returns before base resolution, the build workflow, and every publisher/git-write
  // path. A fix-round lane that wants commit-capable bound runs must add a discriminator and
  // change this deliberately.
  // CROSS-LANE COLLISION: `.trident/plans/trident/a-fix-round-that-abandons-the-revie.md`
  // plans the opposite `bound_pr` meaning and must add its own discriminator before landing.
  if (run.bound_pr !== null) {
    let codexHome: string | null = deps.codex_home ?? null
    if (deps.resolve_codex_home !== undefined) {
      try {
        codexHome = deps.resolve_codex_home(run) ?? codexHome
      } catch (error) {
        if (error instanceof CodexProjectOwnerError) throw error
        // Other optional peer resolution failures retain the existing fallback.
      }
    }
    let kimiConfigured = false
    if (deps.resolve_kimi_configured !== undefined) {
      try {
        kimiConfigured = deps.resolve_kimi_configured()
      } catch {
        // An unavailable optional peer does not prevent the core panel.
      }
    }
    let phaseModels: Record<string, { model?: string; effort?: string }> | null | undefined
    if (deps.resolve_phase_models !== undefined) {
      try {
        phaseModels = deps.resolve_phase_models()
      } catch {
        phaseModels = null
      }
    }
    const reviewDeps = {
      run_host: deps.run_host,
      ...(deps.fire_review_panel !== undefined ? { fire_workflow: deps.fire_review_panel } : {}),
      codex_home: codexHome,
      gh_data_dir: deps.gh_data_dir ?? null,
      gh_owner_handle: deps.gh_owner_handle ?? null,
      kimi_configured: kimiConfigured,
      ...(phaseModels !== undefined ? { phase_models: phaseModels } : {}),
      panel_timeout_ms: deps.panel_timeout_ms,
    }
    // These direct calls are the non-test wiring proof for both exported entry points:
    // executeBoundReview calls formatReviewEvidence when it creates the PR comment.
    const reviewed = deps.execute_bound_review === undefined
      ? await executeBoundReview(run, reviewDeps)
      : await deps.execute_bound_review(run, reviewDeps)
    if (reviewed.status === 'failure') {
      const failed = deps.failed_run(
        { ...run, pr: run.bound_pr, branch: null, worktree: null },
        reviewed.reason,
        false,
      )
      failed.inner_checkpoint = 'bound-review-failed'
      return {
        run: failed,
        changed: true,
        waiting: false,
        note: `${run.phase} → failed (bound PR #${run.bound_pr} review-only executor)`,
      }
    }
    let findings = '[]'
    try {
      findings = JSON.stringify(reviewed.findings)
    } catch {
      // The evidence formatter has already recorded the serialization failure in the PR
      // comment. Keep the in-memory snapshot parseable too.
    }
    // A REJECTION MUST STATE A REASON HERE TOO, and here it is not merely a
    // consistency point — it is the difference between this run finishing and
    // never finishing. `verdict` comes from the panel's `inner_result` JSON while
    // `findings` comes from its `inner_checkpoint_findings` COLUMN
    // (`review-run.ts`), two sources that can disagree; and `saveIfActive` THROWS
    // on `REQUEST_CHANGES` beside no findings (`TridentEmptyFindingsRejectionError`).
    // `tick.ts` swallows that throw as `advance_failed`, so the row never reaches a
    // terminal phase and `executeBoundReview` runs the whole review AGAIN on the
    // next tick, forever. Recording the true state instead is the same rule
    // `checkpoint.sh` and the store apply — never APPROVE, which would merge
    // unreviewed code. `recordedTerminalVerdict` is deliberately NOT reused: it
    // additionally demands `hasArgusProvenance(checkpoint)`, and a bound review's
    // `bound-review-complete:*` checkpoint has none, so it would demote a genuine
    // rejection that DOES carry findings.
    const recorded_verdict =
      reviewed.verdict === 'REQUEST_CHANGES' && parseCheckpointFindings(findings).length === 0
        ? 'REVIEW_NOT_RUN'
        : reviewed.verdict
    const done: TridentRun = {
      ...run,
      phase: 'done',
      pr: reviewed.pr,
      // Dispatch creates a prospective branch name before git-mode is known; a review-only
      // success must not persist that name as if a branch had actually been created.
      branch: null,
      worktree: null,
      subagent_run_id: null,
      subagent_status: 'completed',
      failure_reason: null,
      // `saveIfActive` persists this field, including the gate outcome and reviewed SHA. The
      // paired head/findings remain on the returned snapshot for direct callers; the checkpoint
      // is the durable result because those two columns are workflow-owned and excluded from
      // the outer full-row save.
      inner_checkpoint: `bound-review-complete:${reviewed.reviewed_sha}:${reviewed.review_gate.status}`,
      inner_checkpoint_head: reviewed.reviewed_sha,
      inner_checkpoint_findings: findings,
      inner_verdict: recorded_verdict,
      last_advanced_at: deps.now(),
    }
    return {
      run: done,
      changed: true,
      waiting: false,
      note: `bound PR #${reviewed.pr} reviewed at ${reviewed.reviewed_sha} → done (${reviewed.review_gate.status})`,
    }
  }
  return null
}
