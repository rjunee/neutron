# IMPLEMENTATION_PLAN — `suiteOutcome` gains `'deferred'`: an instructed deferral is not a missing suite, and the unoverridable full-suite gate stops refusing every intermediate Ralph round

Regenerated 2026-08-19 against branch base 5895e268. Card: both salvage lanes (ebfdfeee #282, efef443a #239) are blocked by the identical "FULL SUITE NOT PROVEN, suiteOutcome=not-run" finding. Root cause confirmed in the tree: the intermediate-task brief ITSELF instructs `suiteOutcome='not-run'` (`trident/test-strategy.ts` `INTERMEDIATE_REPORT_RULE` line 649; `trident/inner-workflow.mjs` forge contract subset branches, lines 1267 and 1270), while the gate (`fullSuiteFindings`, `trident/inner-workflow.mjs` line 4657) reads every outcome other than `passed` / evidenced `failed-preexisting` as an unoverridable blocker recorded on the `forge-done` checkpoint. `not-run` carries two incompatible meanings — "deferred by instruction" and "should have run and did not" — and the gate can only assume the second. Split them.

- [x] T1 — find out why stage 2 does not run: DONE, recorded on the card and re-verified against the code this round. Stage 2 is never invoked on intermediate rounds BY INSTRUCTION (the brief defers it to the terminal task), and the gate reads the instructed report as a refusal. No code archaeology remains.
- [x] Split the two meanings of `suiteOutcome='not-run'`: add `'deferred'` to the FORGE_SCHEMA suiteOutcome enum, switch every intermediate-task instruction site (INTERMEDIATE_REPORT_RULE plus the two subset branches of the forge build contract) to instruct `'deferred'`, make all three Codex EXIT-0 transcription paths preserve the reported value, and teach `fullSuiteFindings` that `'deferred'` on a SUBSET-scoped dispatch yields no finding while `'not-run'` — and `'deferred'` on any full-suite-scoped round — keeps the existing unoverridable blocker; pin BOTH directions and both executor routes with tests (F1+F2+F3+F4 as one task, per the card's own scoping directive).

Deliberately NOT in this plan, per the card's own boundaries: T2 (base-rate measurement of `not-run` terminal runs) and T3 (surfacing the gate's reason on the board) are separate cards — adding them here would make this a multi-task plan whose intermediate rounds defer their own suite and are blocked by the exact gate being fixed, before the fix lands. Do NOT weaken or bypass the gate (`deferred` means "the terminal task will prove it", never "no proof needed"); do NOT re-dispatch the two blocked salvage lanes before this lands; do NOT touch the `failed-preexisting` slice (a partial hatch already exists, built and unpushed, on `trident/relaunch-note-read-once-then-follow`); the codex lane-failure rules at inner-workflow.mjs ~1721/~1782 keep saying `'not-run'` — a failed codex lane genuinely never ran.

## Do not (copied verbatim from the card's plan doc)

_Source: `docs/plans/both-salvage-lanes-are-blocked-by-the-same-gate-full-suite-n-sbcxy9.md`. Do not paraphrase this section._

- Do NOT weaken or bypass the gate to unblock the lanes. "The full suite proved it" is the
  claim the whole review rests on; a lane that cannot prove it should not merge. `deferred`
  must mean "the terminal task will prove it", never "no proof needed".
- Do NOT re-dispatch the two blocked salvage lanes expecting a different outcome until this
  lands — they will run the same build and hit the same gate.
- Do NOT also try to fix the 12% `failed-preexisting` slice here. A partial hatch for that
  already exists, built and unpushed, on `trident/relaunch-note-read-once-then-follow` (see the
  stranded-builds card). Landing two overlapping mechanisms is a failure this board has
  already paid for.
