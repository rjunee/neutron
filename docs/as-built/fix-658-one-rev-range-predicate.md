## 2026-09-14 — One rev-range qualification predicate

### What changed

The qualification rule now has one owner: `isQualifiedRevRangeOperand` accepts an explicit `refs/` path or a full hexadecimal object name at caller-supplied widths (`trident/rev-range-operand.mjs:2-7`). Its command-line entry point lets the shell ask the same function (`trident/rev-range-operand.mjs:10-13`).

The three callers were enumerated by searching `isQualifiedRevRangeOperand` across the production files. TypeScript applies it to a launch pin with Git's two supported widths (`trident/merge.ts:402-407`); the review wrapper supplies the current repository's one width (`trident/codex-review.sh:96-103`); and the source gate extracts the assembled operand prefix and applies the predicate before exempting it (`scripts/ci/diff-base-check.mjs:534-536`). The old TypeScript object-name constant, shell shape arms, and gate-only qualified-prefix regex were deleted.

Before this change, a 64-hex input exposed the intentional disagreement: TypeScript admitted either supported width, while the shell admitted only the current repository's width. That context is now data passed to the predicate rather than competing definitions (`trident/merge.ts:405`; `trident/codex-review.sh:96-102`). The default used by the source gate admits both supported widths (`trident/rev-range-operand.mjs:2`).

### Decisions

Repository-specific hash width remains deliberate. The TypeScript launch binding has no repository to query and receives a canonical launch pin, while the shell can query the checkout; the shared predicate therefore accepts an explicit width list rather than hiding that difference (`trident/merge.ts:405`; `trident/codex-review.sh:96-102`).

No new outcome was introduced. Shell refusals remain in the existing `DEFERRED` exit-3 vocabulary (`trident/codex-review.sh:394-418`), and the source gate still reports the existing bare-range hit type (`scripts/ci/diff-base-check.mjs:537-541`). The invariant is maintained continuously by the shared predicate at each of the three decision boundaries; the CI source gate independently scans the range surface, so enforcement does not rely only on a runtime caller remaining healthy (`scripts/ci/diff-base-check.mjs:201-211`).

The line-number inventory moved to `codex-review.sh:440` (`trident/diff-base-option-shaped.test.ts:955-962`). This is only the necessary update: the consolidation does not make that key stable.

### Verification and mutation

| Site | Accept case | Refuse case | Predicate forced false | Restored |
|---|---|---|---|---|
| TypeScript binding | valid pin wins (`trident/diff-base-option-shaped.test.ts:281-285`) | option-shaped unpinned input is refused (`trident/diff-base-option-shaped.test.ts:288-290`) | red | green |
| Shell wrapper | already-shaped pin stays verbatim (`trident/codex-review-base-ref.test.ts:344-351`) | unshapeable inputs are refused (`trident/codex-review-base-ref.test.ts:464-469`) | red | green |
| Source gate | explicit `refs/` operands stay silent (`scripts/ci/diff-base-check.test.ts:271-281`) | shorthand lookalikes are reported (`scripts/ci/diff-base-check.test.ts:283-301`) | red | green |

The mutation inserted `return false` at `trident/rev-range-operand.mjs:3`. Each named site test failed, then each passed after restoration. The complete focused run passed 82 tests across the three files. `scripts/ci/typecheck-all.sh` passed all 51 configurations, and `scripts/ci/lint.sh` passed every repository lint gate.

### Deliberately not changed

The source gate remains a source-shape regression alarm rather than a parser or proof of every possible rev-range spelling (`scripts/ci/diff-base-check.mjs:198-211`). The separate object-name validation of a git probe response remains in `refResolves`; that question is whether git returned an object identifier, not whether an operand is qualified.
