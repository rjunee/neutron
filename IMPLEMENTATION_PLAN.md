# IMPLEMENTATION_PLAN — a codex-routed build cannot transmit a mutation nomination, so the merge gate refuses its PRs

Card: on the codex route the schema field `mutationClaim` is filled by the BRIDGE, which never sees the build's reasoning; the wrapper trailer has no nomination line; the contracts never asked for one — so every codex-routed APPROVE reached the post-APPROVE mutation gate with a null claim and was refused. Fix: Option A — the build COMMITS its nomination to a per-branch artifact and the orchestrator reads it back out of git at the reviewed commit, ONLY when the in-result claim is null. The nomination stays untrusted; absence still means null.

Resume state (branch `trident/a-codex-routed-build-cannot-transmi`, PR #500 OPEN/MERGEABLE/CLEAN, 17/17 checks): the branch carries one squashed commit plus the round-9 and round-10 fix commits. Do NOT cite commit shas in this plan — the branch is replayed onto a moving base; `git log --oneline main..HEAD` is the only honest answer. Environment: a worktree WITHOUT its own `node_modules` fails trident/orchestrator.test.ts en masse ("table code_trident_runs has no column named claimed_paths" — workspace imports resolving into another checkout); `bun install --frozen-lockfile` in the worktree fixes it. Persist THIS body to the ROOT `IMPLEMENTATION_PLAN.md` and mirror it to `.trident/plans/trident/a-codex-routed-build-cannot-transmi.md`. Keep this file under 20 KB and NEVER include a literal dollar-brace template sequence — a launcher brief carrying one does not fire. Purity: never write the word for a per-customer isolated instance; say "absolute host filesystem paths".

## DESIGN DECISION (locked — do not re-litigate) — Option A, refined: the nomination is a COMMITTED artifact at `.trident/mutation-claims/<branch>.json`, read back out of git at the gate call site (`readCommittedMutationClaim`, invoked in `trident/orchestrator.ts` only when the schema claim is null). Chosen because in pr mode the workflow process ENDS at each publish handoff; a committed blob is the only channel that crosses that boundary. The suite-red question is SETTLED as failed-preexisting (recorded round 9; corroborated by reviewer A) — do not re-open it.

## Tasks

- [x] 1. Artifact reader module + unit suite (`trident/mutation-claim-artifact.ts` + test): per-branch path helper, 32 KiB cap sized via `git cat-file -s` before the body crosses the process boundary, decode is `parseMutationClaim` and nothing more (agent-route parity), every failure is null with a `note` saying which failure.
- [x] 2. Gate call-site fallback + production-seam tests: `trident/orchestrator.ts` reads the committed artifact ONLY when `result.mutation_claim` is null, at the single `proveMutation` call site, at the reviewed OID; the reader's note is appended only to the gate's no-nomination refusal (`NO_NOMINATION_REFUSAL`, matched by strict equality). Seam tests prove: artifact reaches the spy gate and the run merges; missing artifact still refuses; a schema-supplied claim wins with no host command naming the artifact path.
- [x] 3. The contract asks for the nomination: MUTATION NOMINATION block in `forgeBuildContract` (build + fix rounds; the codex route embeds the same brief), prose opt-out for inert-docs diffs, exactly-once find, allowlisted argv runners spelled out, 32 KiB cap named; prompt-seam tests extract the path via the production helper.
- [x] 4. Review rounds 2-3: per-branch path (inheritance + lane collisions), `isProseOnlyChange` treats any blob under `.trident/mutation-claims/` as inert, replay-dropped content restored.
- [x] 5. Review round 4: the TypeScript gate (null-narrowing helper in tests), the self-nomination bypass (`validateClaim` refuses a nomination naming the artifact itself via `isMutationClaimArtifact`), the mutable-ref read (refs pinned to OIDs before the read's three legs).
- [x] 6. Review rounds 5-7: brief stops promising a target the gate refuses (harness-driving markdown rules); the codex route's null is guarded in CODE (`forgeAgent` discards a bridge-fabricated claim); `NO_NOMINATION_REFUSAL` exported so the orchestrator note lands on the right refusal only.
- [x] 7. Review round 8: hostile base stops reaching git — `changedFilesOnBranch` refuses an option-shaped base (leading dash) before any command; deliberately NOT an allowlist (legal bases like release@v1 and HEAD~1 stay git's to judge); realgit repro of the option-injection kept.
- [x] 8. Review round 9: reader-side base pinning added for artifact membership (both base ref spellings) — SUPERSEDED, see task 11.
- [x] 9. Review round 10: base resolution moved into the gate (`branchDiffAgainstEveryBase`; exemption on the union, binding on the intersection) — VETOED twice by review: in local git-mode the ORIGIN spelling is the stale one, so the union destroyed the prose exemption (docs-only branches permanently unmergeable, reproduced A/B); and embedding documented bases like HEAD~1 inside remote ref paths silently reinterpreted them. Both vetoes live in code the card's Do-not section forbade touching.
- [x] 10. Lesson recorded: an explicit negative constraint in the card does not reliably bind the build (happened twice). State constraints POSITIVELY: name the files and symbols a round may touch.
- [x] 13. Round 11 — REVERT the rounds-9/10 base-resolution rewiring everywhere (prover AND reader; the artifact channel stays; the stale-base read becomes a recorded limitation for its own card), scope the nomination artifact PER WAVE MEMBER at the writer and test at the member seam, land the two truthfulness fixes (case-sensitive .json comments tell the truth; the byte cap refuses exactly 32768 to match "under 32 KiB"), and re-nominate the branch's own mutation claim (round 10's target line no longer exists after the revert).
- [x] 14. Round 12 (review findings, no vetoed behaviour touched): (a) this plan's round-11 narrative corrected — `trident/mutation-prover.ts` was NOT "restored wholesale" and does NOT sit inside the card's four-item allowlist; what it actually holds, and why each extra hunk stays, is named in CURRENT STATE below. (b) `.JSON` case-sensitivity is EXECUTED rather than asserted in a comment: the uppercase spelling forfeits a docs diff's exemption and stays a legal target. (c) The reader's diagnostic notes stop collapsing — a malformed body, an unreadable size, a failed blob read and a host that THROWS are four distinct notes, which is what invariant (c) promised. (d) The writer/reader path asymmetry is pinned at the member seam BOTH ways: agreement on the production dispatch, and a fail-closed refusal (never a sibling's nomination) when a caller threads an unsuffixed member branch. (e) The build contract stops overclaiming that writing a nomination never forfeits a docs-only exemption.

- [x] 15. Round 13 (two blockers + one major, no vetoed behaviour touched): (a) the untrusted BASE stops flowing raw into the reader's notes — folded with `foldRefName` (the repo's own guard for this forgery) wherever a note quotes it, raw where git receives it, pinned at the unit level AND at the production seam that persists `failure_reason`; (b) the falsified "never a provable claim" declaration withdrawn — the reproduced stale-base inheritance is named in the PR body, in the reader's own docblock and in an executable test, with its bound and its own-card follow-up, and the vetoed base pinning is NOT reintroduced; (c) `pinRevision` stops reporting a throwing host as an absent ref; (d) an EMPTY branch diff is no longer described as an unreadable one; (e) the build contract's denylist warning says which names can actually forfeit the exemption (a segment anywhere but LAST).

## PR BODY (authoritative — the publishing loop should carry this; the build lane may not run gh)

Option A, refined: the nomination is a COMMITTED artifact, read back out of git at the gate call site. The build writes `.trident/mutation-claims/<branch>.json` — per branch, and per wave member in member mode — and commits it with its work; `trident/orchestrator.ts` calls `readCommittedMutationClaim` at the single `proveMutation` call site ONLY when the schema claim is null. Chosen over a loose worktree file and over Option B's seventh trailer line because in pr mode the workflow process ENDS at every publish handoff and re-enters with a null claim; a committed blob is the one channel that already crosses that boundary, and the reviewed OID binds the nomination to the very commit the gate pins. The nomination remains UNTRUSTED: same decode as the agent route, then the unchanged gate validates and actually RUNS it; TEST_COMMAND_SHAPES, the general-shell ban, the documentation rejection, the diff-membership requirement, the proof token/HMAC/evidence schema and prover_version are untouched. A missing artifact still decodes to null and a required proof still refuses. One declared widening: `isProseOnlyChange` treats ANY blob under `.trident/mutation-claims/` ending in `.json` as inert — including one written at ANOTHER lane's nomination path, since the predicate tests only the directory prefix and the `.json` suffix. The denylist refusals still run first and `validateClaim` refuses every path it admits as a TARGET, so a stray blob can buy a docs diff an exemption and can never itself be nominated. WHAT THAT DOES NOT BOUND, corrected here because an earlier draft of this paragraph said a stray blob could "never" yield a provable claim and review reproduced otherwise: where a branch NAME is reused after its predecessor merged and the LOCAL base ref is behind its remote, the predecessor's committed nomination AND the file it names are both still inside `<base>...<head>`, so the reader accepts the inherited nomination and the gate can RUN and prove the predecessor's mutation while this branch's own work goes unproved. That is the stale-base read — the same bare-name base resolution the gate already used before this PR for both the prose exemption and the `claim.file` binding, so it is not a widening this channel introduced — and the base pinning that closes it was VETOED twice by review (in local mode the origin spelling is the stale one, so the union reading destroyed the prose exemption and made documentation-only branches permanently unmergeable). It therefore stays a recorded limitation for its own card, and is now EXECUTABLE rather than prose: `mutation-claim-artifact.test.ts` pins both the inherited read and the bound that does hold (a nomination absent from the branch's diff is still null). Rounds 9-10 additionally pinned the gate's diff base to every commit the base names; round 11 REVERTED that per review — in local git-mode the origin ref spelling is the stale one, so the union reading destroyed the prose exemption, and embedding documented bases like HEAD~1 inside remote ref paths reinterpreted them — so the diff binding reads the base as a name exactly as before this PR, and the stale-base read is a recorded limitation for its own card. The agent route is unaffected: a schema-supplied claim wins and the reader is not invoked; on the codex route the bridge cannot fabricate a claim (discarded in code), so the committed blob is the answer. Two hunks in `trident/mutation-prover.ts` sit outside the card's four-item allowlist and are kept on purpose, named here rather than left to be discovered: the nomination blob's inert-prose dispensation, without which a documentation-only branch that wrote its nomination becomes permanently unmergeable, and round 8's fail-closed refusal of an option-shaped diff base, which both reviewers reproduced as a real `--output=` injection against git 2.43.0. Round 13 closes the two round-12 blockers without touching any vetoed behaviour: every branch/base NAME a reader note quotes is folded through the repo's own `foldRefName` before it lands in a persisted `failure_reason` (git accepts U+2028/U+202E in a base, that reason is replayed to a model verbatim, and this file already folds the same field wherever a wrong-base refusal quotes it) — the RAW base still reaches git, so no diff changes — and the "never a provable claim" declaration above is withdrawn and replaced with the reproduced case, its bound and its own-card follow-up. It also splits the pin leg's two nulls apart (an absent ref versus a host that throws) and stops reporting an EMPTY branch diff as an unreadable one. Round 12 adds no behaviour beyond splitting the reader's JSON decode into its own `try` — so a malformed nomination and a host that throws stop producing the same diagnostic — and correcting the contract sentence that claimed writing a nomination can never forfeit a docs-only exemption.
# CURRENT STATE (2026-09-04, round 13) — REPLACE this section each round; keep this file under 20 KB

PR #500 OPEN/MERGEABLE/CLEAN. The rounds-9/10 base-resolution rewiring (`resolveBaseCommits`,
`branchDiffAgainstEveryBase`, the gate hunks that consumed them, and the reader's use of them) is
still GONE from both the prover and the reader, and round 13 does not bring any of it back: the two
round-12 blockers are answered where they were actually made, in the reader's NOTES and in this
file's DECLARATION.

  1. THE UNTRUSTED BASE STOPS FLOWING RAW INTO PERSISTED PROSE. The reader's notes are appended to
     `failure_reason`, which is stored verbatim and replayed to a model as "Failure reason
     (verbatim)"; git accepts a base name carrying U+2028/U+202E, so a forged line was available
     through it. Every name a note quotes is now folded with `foldRefName` — the repo's own answer
     to this exact forgery, already applied in `orchestrator.ts` wherever a wrong-base refusal
     quotes the base. The RAW base is still what `changedFilesOnBranch` receives, so no diff
     changes. Pinned twice: at the unit (fold + untouched argv, with an ordinary-base control) and
     at the production seam that persists the reason.
  2. THE DECLARATION IS CORRECTED, NOT THE VETOED CODE. "A stray blob can buy an exemption but never
     a provable claim" was falsified by a real-git repro: a reused branch name over a local base ref
     behind its remote drags a predecessor's nomination AND its target into `<base>...<head>`, so
     the gate proves the predecessor's mutation. The PR body and the reader's docblock now say that
     plainly, name the bound that holds (production target, in the diff, and the gate RUNS it) and
     record it as the stale-base card's work — the pre-change gate read the base as a bare name for
     the exemption and the `claim.file` binding too, so this is not a regression the channel
     introduced, and closing it here means re-landing the code review vetoed twice.

Also: `pinRevision`'s two nulls are separated (an absent ref versus a host that THROWS, which round
12 promised and did not deliver at that leg), an EMPTY branch diff is no longer reported as an
unreadable one, and the build contract's denylist warning now says which branch names can actually
forfeit the prose exemption (a denylisted segment anywhere but LAST — the last one gains `.json`).

WHAT `trident/mutation-prover.ts` ACTUALLY CONTAINS, stated precisely because round 11's commit
message and this file previously claimed it was "restored wholesale to the round-9 state", which was
not true. Measured, the file differs from that state only in COMMENTS, and against the base it
carries six hunks — four of them the card's allowlist, two of them outside it and kept deliberately:

  ALLOWLISTED — `MUTATION_CLAIM_ARTIFACT_DIR`, `NO_NOMINATION_REFUSAL`, `isMutationClaimArtifact`,
  and the `validateClaim` refusal of a nomination that names the artifact itself.

  OUTSIDE THE ALLOWLIST, with the reason each stays:
   1. `isProseOnlyChange` treats a nomination blob as inert. Without it a documentation-only branch
      that also wrote its nomination destroys its own exemption, owes a proof, and has no legal
      target — permanently unmergeable. The channel does not function without this hunk. It is
      pinned by `mutation-claim-artifact.test.ts`, and `validateClaim` refuses every path this
      predicate admits, so the two sets cannot drift.
   2. `changedFilesOnBranch` refuses an option-shaped base before any command runs (review round 8).
      Both reviewers independently reproduced the `--output=` injection on git 2.43.0; the guard is
      fail-closed — a refused base reads as "diff could not be read", which REQUIRES the proof — and
      a real-git repro pins it. Deleting a reproduced, fail-closed injection fix to satisfy a scope
      list would trade a real defect for a bookkeeping one.

  Both were reviewed and CONFIRMED minor with their mitigations verified; the residual cost is
  conflict surface with PR #490, which also edits this file.

Round 13's diff touches four files of code and one of prose: the reader (the fold, the pin leg's two
notes, the empty-diff wording, the docblock), its unit suite, the orchestrator seam suite, one
comment at the call site, and the contract sentence in `inner-workflow.mjs`. NOTHING in
`trident/mutation-prover.ts` changes this round. Every new assertion carries a control that goes the
other way, and each was mutation-checked: dropping the fold, collapsing the pin notes, or restoring
the one-sided diff wording each reddens exactly one new test and nothing else. Do NOT touch
`.github/workflows/`, the proof token/HMAC/evidence schema, `TEST_COMMAND_SHAPES`, or the gate's
base/diff resolution. This PR still cannot pass the deployed gate itself (the fix deploys after
merge); that is expected.
