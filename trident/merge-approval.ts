import { reviewedHeadOid } from './merge.ts'
import { readCommittedMutationClaim } from './mutation-claim-artifact.ts'
import { NO_NOMINATION_REFUSAL, type MutationGateInput, type MutationGateOutcome } from './mutation-prover.ts'
import { cleanupAfterMerge, type MergeCleanupDeps } from './git-mode.ts'
import { runWorktreePath, TridentBaseDriftHold, TridentMergeConflictEscalation, TridentMergeDiffHold, type RunHostCommand } from './merge.ts'
import type { InnerResult } from './inner-loop.ts'
import type { AdvanceOutcome } from './state-machine.ts'
import type { TridentRun } from './store.ts'

type MergeApprovalInput = {
  run: TridentRun
  result: InnerResult
  run_host: RunHostCommand
  merge_deps: MergeCleanupDeps
  proveMutation: (input: MutationGateInput) => Promise<MutationGateOutcome>
  resolvedDiffBase: (run: TridentRun) => Promise<string>
  failedRun: (run: TridentRun, reason: string, keepSubagentId: boolean) => TridentRun
  now: () => string
  nowMs: () => number
  truncateNote: (reason: string) => string
  truncateStageReason: (reason: string) => string
  record_stage?: (runId: string, stage: string, reason: string) => unknown
  log: { info(event: string, fields?: any): void }
}

export async function applyMergeApproval(input: MergeApprovalInput): Promise<AdvanceOutcome | null> {
  const { result, run_host, merge_deps, proveMutation, resolvedDiffBase, failedRun, now, nowMs, truncateNote, truncateStageReason, record_stage, log } = input
  let { run } = input
const pr = result.pr_number ?? run.pr
const branch = result.branch ?? run.branch

// SERVER-GATED verdict provenance: a merge-eligible APPROVE must be backed by
// the Argus phase's OWN recorded checkpoint (`inner_checkpoint='argus-approved'`,
// written by the workflow's synthesis-phase Bash step), NEVER just the
// self-asserted verdict in the harvested result line. A result claiming
// APPROVE without that recorded provenance is rejected — failed, not merged.
const argusApproved = run.inner_checkpoint === 'argus-approved'

if (result.verdict === 'APPROVE' && argusApproved) {
  // FIX 1 (#351) — record this run's DEDICATED merge worktree on the row BEFORE
  // the merge, so `code_trident_runs.worktree` is populated (was always empty)
  // and the isolated path is durable for cleanup even if the merge escalates or
  // crashes. Local mode only — pr mode merges the remote (`gh pr merge`) and
  // never provisions a local worktree.
  const worktree = run.merge_mode === 'local' ? runWorktreePath(run.repo_path, run) : run.worktree
  const doneRun: TridentRun = {
    ...run,
    phase: 'done',
    pr,
    branch,
    worktree,
    inner_checkpoint: result.checkpoint ?? 'argus-approved',
    inner_verdict: 'APPROVE',
    subagent_status: 'completed',
    failure_reason: null,
    last_advanced_at: now(),
  }
  // MUTATION PROVER — the post-APPROVE, pre-merge phase. An APPROVE says a
  // reviewer BELIEVES the change is guarded; this RUNS the mutation and
  // watches the guard go red and come back green. It is deterministic TS and
  // the only producer of its own evidence — no agent output is read here,
  // because a convincing paragraph about a mutation is exactly what this
  // phase exists to stop being sufficient. Fails CLOSED: an unprovable
  // APPROVE does not merge.
  //
  // `{ ...run, branch }` — the FRESHLY RESOLVED branch, never the row's. On a
  // run whose row predates the build naming its branch, the prover would
  // resolve a head off the OLD ref while the merge below took the new one:
  // proving one commit and merging another.
  //
  // `expected_head` — the commit the merge will ACTUALLY take (#545 pins it
  // to the reviewed OID, not to whatever the branch tip is now). The prover
  // pins the branch tip. Those are two independent answers to "which commit
  // is this about", and nothing compared them before: a tip that moved past
  // the reviewed commit gave a proof of B while the merge took A.

  // THE COMMITTED-NOMINATION FALLBACK. On the codex route the schema field
  // is filled by the bridge, which never sees the build's reasoning; and in
  // pr mode the workflow process ends at every publish handoff, so the
  // in-result claim arrives null even when the build nominated. The build
  // therefore COMMITS its nomination to `.trident/mutation-claims/<branch>.json`,
  // and this reads it back AT THE REVIEWED OID — the very commit the gate
  // pins — ONLY when the in-result claim is null (the read is not even
  // attempted otherwise, so a schema-supplied claim is never shadowed). The
  // artifact stays branch-controlled, UNTRUSTED input: the reader decodes
  // shape only, and the gate below validates and actually RUNS it on the
  // same terms as an agent-supplied claim. Every absence or failure reads
  // as null — which the gate already refuses — so the fallback can never
  // turn a missing nomination into a pass.
  const expectedHead = reviewedHeadOid(run)
  // THE BASE `resolvedDiffBase` CHOSE (#546), never one named here.
  // `changedFilesOnBranch` takes it as `git diff --name-only
  // <base>...<ref>`, and the three-dot form resolves the merge-base — so a stale
  // `refs/heads/main` (which IS an ancestor of the branch) puts every file the base
  // moved past into the blast radius the mutation nomination is scored against.
  const baseBranch = await resolvedDiffBase(run)
  const committed =
    result.mutation_claim === null || result.mutation_claim === undefined
      ? await readCommittedMutationClaim(run_host, run.repo_path, {
          expected_head: expectedHead,
          branch,
          base_branch: baseBranch,
        })
      : null
  const claim = result.mutation_claim ?? committed?.claim ?? null
  const proof = await proveMutation({
    run: { ...run, branch },
    claim,
    base_branch: baseBranch,
    run_host: run_host,
    expected_head: expectedHead,
  })
  // AN EXEMPTION IS NOT A SILENT PASS. `proof.reason` is the only part of the
  // outcome that outlives the process, and on the ok path it was being
  // dropped — so a merge that ran NO mutation proof looked exactly like one
  // that ran and passed. The tick note below is the HUMAN one-liner; the
  // DURABLE run-record entry is the `mutation-proof-exempt` stage row
  // stamped further down, because `tick.ts` persists the run row and never
  // reads `outcome.note`. Both exemptions (prose-only, and
  // no-production-file) say so, in both places.
  // CAPPED HERE AND NOWHERE ELSE. The no-production-file exemption names
  // EVERY changed file (that list is the reviewer's evidence and must not be
  // filtered), so a large test-only refactor puts a multi-kilobyte string on
  // the run row — a tick note is a one-line human summary, not a record. The
  // full reason still goes to the log below, which is where it is meant to
  // be read back.
  const proofNote = proof.exempt ? `; mutation proof skipped — ${truncateNote(proof.reason)}` : ''
  // …and into the log, which is where this run's non-fatal facts actually
  // outlive the tick (`leak_preflight` above records the same way). Both
  // exemptions log — prose-only and no-production-file — so "the gate ran
  // and passed" and "the gate never ran" stop looking identical after the
  // fact. `reason` carries WHICH one and the file count it saw.
  if (proof.exempt) {
    log.info('mutation_proof_exempt', { run_id: run.id, branch, reason: proof.reason })
    // The tick persists the run row, never `note` — so the note is display
    // and the stage ledger row is the exemption's durable place in the run
    // record. The file list is the reviewer's evidence, so this copy keeps
    // it — capped only where the diff itself stops being a list and starts
    // being a blob (`STAGE_REASON_CEILING`, ~30x the tick note), with the
    // uncapped text still in the log line above. Best-effort like every
    // stamp.
    try {
      record_stage?.(run.id, 'mutation-proof-exempt', truncateStageReason(proof.reason))
    } catch {
      // a stamp must never fail a merge
    }
  }
  if (!proof.ok) {
    // `inner_verdict` / `inner_checkpoint` are left EXACTLY as the review left
    // them: Argus really did approve, and its provenance is the audit trail.
    // Rewriting either would misattribute the block — this is a MISSING
    // PROOF, not a reviewer's finding, and `failure_reason` says which.
    //
    // WHY THE READER'S NOTE IS APPENDED. "The build nominated no mutation"
    // was the same sentence for a build that genuinely nominated nothing, a
    // wrong path, an oversized blob and a malformed one — an ambiguity this
    // card's own history records as misdiagnosed for days as an agent
    // omission. The note says which, and ONLY on the refusal it explains:
    // the gate also refuses a rejected branch name, an unresolvable head and
    // a tip that moved, and none of those is a missing nomination — suffixed
    // with one they point the reader at the wrong failure.
    // BOUNDED, because `failure_reason` is stored verbatim and the note
    // quotes branch-supplied names: 300 characters is room for both legs of
    // a two-ref read and no room for a flood. The SHAPE of those names is
    // the reader's job and it does it at the source — every name a note
    // quotes is `foldRefName`-folded there, the same guard this file applies
    // wherever a refusal quotes the base, so the reason cannot carry a
    // forged line even though it is later replayed to a model verbatim.
    const reason =
      committed !== null && committed.claim === null && proof.reason.startsWith(NO_NOMINATION_REFUSAL)
        ? `${proof.reason} — ${committed.note.slice(0, 300)}`
        : proof.reason
    const blocked: TridentRun = { ...failedRun(run, reason, true), pr, branch }
    return { run: blocked, changed: true, waiting: false, note: 'APPROVE blocked (mutation prover) → failed' }
  }
  try {
    const res = await cleanupAfterMerge(doneRun, merge_deps)
    return {
      run: doneRun,
      changed: true,
      waiting: false,
      note: `APPROVE (argus-approved) → done; ${res.note}${proofNote}`,
    }
  } catch (err) {
    // #542 — the base moved materially between the review and the merge, so
    // the merge was HELD rather than landed. Fail the run with the hold text
    // AS the reason (the terminal delivery posts exactly it), keeping
    // `inner_verdict: 'APPROVE'` + the pr/branch: the reviewed work is intact
    // and re-runnable, it just may not land against a base nothing reviewed.
    if (err instanceof TridentBaseDriftHold) {
      return {
        run: { ...failedRun(doneRun, err.message, true), inner_verdict: 'APPROVE' },
        changed: true,
        waiting: false,
        note: 'done → failed (merge HELD: base drifted since review)',
      }
    }
    // #618 — the diff was MEASURED and is above the ceiling the reviewer
    // seat can be shown in full, so the merge was refused rather than
    // landed. Same shape as the #542 hold above and for the same reason:
    // the refusal text is authored, plain and specific, and the terminal
    // delivery posts exactly it. Without this arm the reason fell into the
    // `merge failed:` catch-all below, which `interpretFailure` classifies
    // as `merge-mechanics` — "a git step failed while landing the branch …
    // Reply to retry the build". No git step failed, the authored sentence
    // was discarded, and the retry re-measures the same diff and refuses
    // again; an unclassified refusal costs whatever the default costs.
    //
    // MEASURED ONLY. A hold carrying `measured_bytes === null` says the
    // diff could not be READ, which is a git command that failed and
    // nothing at all about its size — that one keeps the mechanics
    // disposition below, where the retry advice is right.
    if (err instanceof TridentMergeDiffHold && err.measured_bytes !== null) {
      return {
        run: { ...failedRun(doneRun, err.message, true), inner_verdict: 'APPROVE' },
        changed: true,
        waiting: false,
        note: 'done → failed (merge REFUSED: diff above the reviewable size limit)',
      }
    }
    // #342 — a genuinely ambiguous merge conflict escalates a SPECIFIC
    // question to chat (not a raw "merge failed"): fail the run with the
    // question AS the reason so the terminal delivery posts exactly it.
    if (err instanceof TridentMergeConflictEscalation) {
      return {
        run: { ...failedRun(doneRun, err.question, true), inner_verdict: 'APPROVE' },
        changed: true,
        waiting: false,
        note: 'done → failed (merge conflict escalated to chat)',
      }
    }
    const reason = err instanceof Error ? err.message : 'merge failed'
    return {
      run: { ...failedRun(doneRun, `merge failed: ${reason}`, true), inner_verdict: 'APPROVE' },
      changed: true,
      waiting: false,
      note: `done → failed (${reason})`,
    }
  }
}

  if (result.verdict === 'APPROVE' && !argusApproved) {
  // Provenance gate tripped — a self-asserted APPROVE with no recorded
  // argus-approved checkpoint. Never merge on an unverified verdict.
  const failed: TridentRun = {
    ...failedRun(
      run,
      'inner workflow reported APPROVE but no recorded argus-approved checkpoint (provenance gate)',
      true,
    ),
    pr,
    branch,
    inner_verdict: 'REVIEW_NOT_RUN',
  }
  return { run: failed, changed: true, waiting: false, note: 'APPROVE rejected (provenance gate) → failed' }
}

  return null
}
