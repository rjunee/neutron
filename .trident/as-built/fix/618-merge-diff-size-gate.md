## Issue 618 — deterministic merge diff-size gate

### What changed

The merge path now measures the complete binary-capable three-dot diff and makes a code-owned
allow/refuse decision before either landing mechanism. The pure assessment counts UTF-8 bytes,
permits at most 1,048,576, and returns a named refusal above that boundary (`assessMergeDiff`,
`trident/merge.ts`). An unreadable diff also fails closed, through the same
`TridentMergeDiffHold` with a null measurement (`enforceMergeDiffGate`). PR mode measures the
two remote refs the explicit-refspec fetch just refreshed — the refs GitHub will actually merge;
local mode measures fully qualified local refs before it mutates or lands the branch.

The numeric boundary deliberately matches the reviewer seat's measured input ceiling. The
wrapper documents the unit relationship and retains its existing review chunking behavior
(`trident/codex-review.sh`). This is not prompt wording as enforcement: the merge
implementation reads the diff and refuses on its own, with no model in the loop.

### Outcome vocabulary and default

`TridentMergeDiffHold` joins the merge layer's thrown terminal outcomes. The complete
production-consumer enumeration, by `rg` over non-test sources with a positive control on
`TridentBaseDriftHold` (which the same greps find at every site listed here):

1. `trident/orchestrator.ts` — an `instanceof` switch over the merge error. Base drift and
   conflict escalation have dedicated arms; everything else becomes `merge failed: <message>`.
2. `trident/delivery.ts` `interpretFailure` — classifies the stored reason string into one
   `FailureClass`. A `merge failed:` prefix lands on `merge-mechanics`.
3. `trident/delivery.ts` `composeTerminalDelivery` — switches on the class for the glyph and
   carve-outs; `merge-mechanics` takes the default ❌ arm.

REVIEW FINDING, AND WHAT THE DEFAULT COST. Measured by calling the real classifier on the
real authored reason: the refusal was announced as "The build finished but a git step failed
while landing the branch, so it was not merged. … Reply to retry the build." No git step
failed, the authored measurement was discarded entirely, and the prescribed retry re-measures
the same diff and refuses again — a loop with no exit. So the refusal now has:

* its own orchestrator arm (`trident/orchestrator.ts`), which stores the authored sentence AS
  the reason exactly like the #542 hold, keeping `inner_verdict: 'APPROVE'` — the work was
  reviewed and is intact, only the landing was refused;
* its own `FailureClass`, `merge-too-large` (`trident/delivery.ts`), whose advice names the
  decision (split the work into smaller cards) and says plainly that a re-run will refuse
  again.

FALSE AND UNKNOWN DO NOT SHARE A BRANCH. A hold with `measured_bytes === null` means the diff
could not be READ — a git command that failed, which says nothing about size. That one keeps
the `merge failed:`/`merge-mechanics` disposition, where "a git step failed" is true and the
retry advice is right. The orchestrator arm keys on the field, not on the class, and a test
pins both directions.

THE WORDING IS SHARED, NOT RESTATED. `delivery.ts` may not import `merge.ts` (the `no-cycles`
rule), so the ceiling, the authored sentence and its matcher live in a leaf both import —
`trident/merge-diff-limit.ts`, the same shape as `trident/deploy-kill-reason.ts`. A test
composes the reason through the real author and asserts the real matcher recognises it, so a
reword cannot leave writer and reader disagreeing in silence.

### Decisions

The cap is bytes rather than line count or changed-file count because it directly bounds the
complete content presented for review. The command uses `--binary`, `--no-ext-diff`,
`--full-index`, `--end-of-options` and fully qualified refs so the measurement includes binary
patch material, cannot invoke repository-specific external diff drivers, and cannot be captured
by another ref namespace. A failed measurement refuses rather than treating missing output as an
empty, allowed diff.

The test pins the literal 1,048,576-byte policy independently of the production constant, drives
the real `cleanupAfterMerge` entry point in BOTH merge modes, proves the exact boundary reaches
`gh pr merge` / `git merge --no-ff`, and proves boundary-plus-one throws the named refusal
without either (`trident/merge.test.ts`). Doubling the constant reds the boundary test, which is
what makes it a policy pin rather than a restatement of the code.

### Mutation table

Every mutation below was printed at the line it landed on, the file diffed before the run, and
individually restored GREEN.

| Guard | Mutation | RED |
|---|---|---|
| `measured_bytes <= MERGE_DIFF_BYTES_MAX` (`trident/merge.ts`) | `if (true)` — always allow | the over-limit case merged: 1 fail |
| same | `if (false)` — always refuse | the at-limit case was refused: 1 fail |
| `MERGE_DIFF_BYTES_MAX` | doubled to `2_097_152` | over-limit case: 1 fail — the test pins the literal, not the constant |
| pr-mode call site | deleted | over-limit case: 1 fail |
| local-mode call site | deleted | local over-limit case: 1 fail — **before review this mutation was SILENT**; no test reached the second call site |
| the diff command's `--binary` | changed so the fixture no longer answers it | over-limit case: 1 fail — the test measures the real command's output, not a stub |
| orchestrator `TridentMergeDiffHold` arm | disabled | end-to-end case: 1 fail (reason became `merge failed: …`) |
| `isMergeDiffTooLargeReason` | widened to also match the unmeasurable refusal | the false/unknown control: 1 fail |

### Verification

`bun test trident/merge.test.ts trident/delivery.test.ts` — 173 pass, 0 fail.
`bun test trident/orchestrator.test.ts` — 284 pass, 0 fail. Typecheck and the repository lint
wrapper pass. The leak gate was re-run at review time; its Tier-1 PII denylist is a repository
secret that is not available outside CI, so the local run is INCOMPLETE by construction and
the armed run is the `purity` job on this PR.

### The rev-range guard, and the two fixtures it exposed

CI's `diff-base-option-shaped` gate red on the first push, correctly: the gate's property is
that **no TypeScript module outside `trident/git-range.ts` builds a rev-range at all**, and the
first version of this gate hand-rolled `['git','-C',repo,'diff',…,'--end-of-options',
`${base}...${branch}`]`. Spelling the shield correctly is not the same as being unable to omit
it. The diff now goes through `gitRangeArgv` with `dots: '...'`, which is the only constructor
that can place `--end-of-options` in the position that works.

The guard's second and third arms exposed two more things worth recording:

* The unmeasurable refusal's MESSAGE contained `${base_ref}...${branch_ref}`. A range operand
  spelled in a string is indistinguishable, to a source scanner, from one being handed to git —
  which is the ambiguity the guard exists to remove. The message now names the two refs with a
  word between them.
* `enforceMergeDiffGate` is a FORWARDER, so the constructor's call site shows its parameter and
  says nothing about what either merge mode passes. The gate already makes that argument for
  `sideHistory`; it now enumerates this forwarder's two call sites the same way. Mutation:
  replacing the pr-mode operands with the bare `base`/`branchForGate` shorthands reds it.

A THIRD FIXTURE, in `trident/arbiter-wiring.test.ts`, called every plain `diff` a working-tree
fingerprint probe — including this gate's ref-range read — so `failFingerprint: true` refused
the merge for "the diff could not be measured" before the arbiter was ever consulted, and a
test about fail-closed FINGERPRINTS would have been satisfied by a refusal that has nothing to
do with fingerprints. The probe predicate now excludes `--binary`, which the fingerprint probes
never carry and this gate always does. Same defect class as the conflict-diff clause already
sitting above it in that stub.

### Deliberately not done

The pr-mode gate call was MOVED above the base-drift assessment rather than left where it was
first written. The drift block's closing comment is explicit that nothing may be inserted
between the drift hold and `gh pr merge`, because every command there widens the window in
which a sibling lane moves `base` under an assessment that already passed — and reading a
megabyte of diff is the most expensive command on the path. Both positions are below the
explicit-refspec fetch, so the gate measures the same two refreshed refs either way.

No prompt-only rule was added, no alternate merge path or feature switch was introduced, and the in-flight inner-workflow files were not touched. The cap does not attempt semantic inspection of diff prose; it supplies the requested non-model size gate, while all existing model-review behavior remains in place.
