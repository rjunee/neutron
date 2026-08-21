# IMPLEMENTATION_PLAN.md — Git-truth is half-done: resolve the CLAIM to an OID, and push before the cross-check can refuse

Governing card: "Git-truth is half-done — the claim is still compared as a STRING, and a wrong refusal still destroys the commit." All claims re-verified against origin/main (0e895300) on 2026-08-17.

- [x] Branch half of git-truth: `publishBuiltCommit` resolves the BRANCH with `git rev-parse --verify refs/heads/<branch>` and treats the model claim as a check only — landed via #290 (T1) and #283 (T4). Verified at trident/orchestrator.ts:1624-1635. Do not redo.
- [x] #271's T2 substance is ALREADY ON MAIN: both publish handoffs in trident/inner-workflow.mjs no longer throw `…without a full local commit OID` (the string is absent from the file; claims flow through `oidClaim`, lines 5491/5771), trident/inner-loop.ts:612 decodes any 7-40-hex `publishHead` verbatim, and the workflow-level coverage file trident/inner-workflow-publish-handoff.test.ts exists — all landed by #290/#283 (`git log` on those paths confirms). Nothing of T2 remains to fold in; what remains is administrative (next unchecked task after the fix).
- [x] Fix defects 1+2 in `publishBuiltCommit` (trident/orchestrator.ts): resolve the claim to an OID via a new exported `resolveClaimedCommit` helper (`git rev-parse --verify --quiet --end-of-options <claim>^{commit}`; unresolvable ⇒ ABSENT, publish from git's head), compare resolved OIDs only (never strings, never `startsWith`), and move the refusal to AFTER the push+witness so a refusal leaves the commit reachable on origin. Tests: real-git resolution tests for the helper; stub tests proving (a) hallucinated claim ⇒ ABSENT ⇒ publish proceeds, (b) short-sha same-commit claim accepted, (c) two real different commits still REFUSE with the push already made and no PR/review dispatched; source assertion that `startsWith(claimedHead` never returns to orchestrator.ts.
- [ ] Reconcile PR #271 (OPEN, CONFLICTING, zero reviews): its diff re-lands the exact `startsWith(claimedHead` line and its T1/T2 content is fully subsumed by #290/#283 (verified above). Close it via `gh pr close 271` with a comment naming the subsuming merges (#290, #283) and this fix, stating it must not be rebased-and-merged because its orchestrator.ts hunk would reintroduce the string compare. If gh credentials are unavailable in the executor sandbox, instead record the subsumption verdict and the required closure in the fix PR's body and docs/AS_BUILT.md so a credentialed pass closes it.

## Do not (copied verbatim from the card's plan doc)

_Source: `docs/plans/git-truth-is-half-done-resolve-the-claim-to-an-oid-and-push-1q34c6.md`. Do not paraphrase this section._

- Do not delete the cross-check. It is correct for the real disagreement case; it is the CLAIM RESOLUTION and the ORDERING that are wrong.
- Do not compare strings anywhere in this path.
