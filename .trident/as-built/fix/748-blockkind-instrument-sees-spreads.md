## Issue #748 — blockKind instrument sees every shipped shape

### What changed

The terminal-site record now carries a `carriesBlockKind` verdict instead of the resolved literal's direct property list (`trident/inner-workflow-terminal-cause.test.ts:98-110`). `terminalSites` computes that verdict for every resolved `writeTerminalResult` call (`trident/inner-workflow-terminal-cause.test.ts:238-272`). The measurement recognizes a named property or a conditional spread, and follows a symbol-resolved assignment occurring after initialization and before the terminal write (`trident/inner-workflow-terminal-cause.test.ts:457-512`).

The shipped-source assertion now derives nine of twelve terminal sites that can carry `blockKind`, leaving three that cannot (`trident/inner-workflow-terminal-cause.test.ts:805-811`). The twelve-site list is complete within the scanner's documented boundary because `terminalSites` walks every call whose callee literally names `writeTerminalResult` (`trident/inner-workflow-terminal-cause.test.ts:238-272`, `trident/inner-workflow-terminal-cause.test.ts:273-317`), and the existing enumeration test pins those twelve calls (`trident/inner-workflow-terminal-cause.test.ts:874-882`).

The normative prose now states the measured property: three terminal paths can never carry the field, and the instrument follows each of the three shapes used by the workflow (`trident/terminal-cause.ts:30-47`). The throw result demonstrates both previously invisible forms: a conditional spread and a later assignment (`trident/inner-workflow.mjs:9239-9269`).

### Decisions

This is a may-carry measurement. A conditional spread means the terminal site can carry the field on one branch, so calling that site fieldless would be false (`trident/inner-workflow-terminal-cause.test.ts:457-464`). Later assignments are bounded by the resolved binding's initialization and terminal-call positions, and matched by compiler symbol identity, so an unrelated same-named object does not count (`trident/inner-workflow-terminal-cause.test.ts:473-497`).

The invariant is maintained continuously by the source-inspection test over the checked-in workflow, not by the runtime path remaining operational (`trident/inner-workflow-terminal-cause.test.ts:805-833`). The traversal inventory also pins the new whole-file assignment walk, forcing an audit if that mechanism changes (`trident/inner-workflow-terminal-cause.test.ts:835-854`).

No new error, verdict, state, or refusal was introduced, so there is no outcome-vocabulary default to classify.

### Mutation table

| Guard | Mutation and printed line | Red result | Restored result |
|---|---|---|---|
| Named property | Changed the searched key at `trident/inner-workflow-terminal-cause.test.ts:501` | focused control expected 10 carrying sites, received 1 | scoped file: 73 pass, 0 fail |
| Conditional spread | Disabled the conditional-expression arm at `trident/inner-workflow-terminal-cause.test.ts:508` | focused control expected 10, received 9 | scoped file: 73 pass, 0 fail |
| Later assignment | Forced the assignment verdict false at `trident/inner-workflow-terminal-cause.test.ts:497` | focused control expected 10, received 9 | scoped file: 73 pass, 0 fail |

Each doctored source introduces exactly one additional terminal site and expects both the total and carrying counts to rise (`trident/inner-workflow-terminal-cause.test.ts:813-833`). This prevents the pre-existing twelve-site count from being the reason a shape control fails.

### Verification

- `bun test trident/inner-workflow-terminal-cause.test.ts`: 73 pass, 0 fail.
- `bash scripts/ci/typecheck-all.sh`: 51 configurations checked, all pass.
- `bash scripts/ci/lint.sh`: all lint sub-gates pass.
- `git diff --check`: pass.

### Deliberately not changed

`trident/inner-workflow.mjs` was read to enumerate runtime shapes but not modified, as required. No product behavior or specification decision changed. The historical statement in `docs/as-built/a-terminal-cause-on-every-terminal-path.md:541` remains because merged as-built records are immutable; the distinctive-phrase tree search found that historical hit alongside the corrected normative and executable positive controls at `trident/terminal-cause.ts:32` and `trident/inner-workflow-terminal-cause.test.ts:802`.

### Reviewer addendum

Two gaps found on review, both closed here rather than deferred.

**The docblock named the three, but only the count was derived.** The sentence at
`trident/terminal-cause.ts:31-38` does not just cite a number — it says WHICH paths ("both
publish handoffs and the Ralph re-fire"). Nothing measured that half, so three *other*
sites could have lost their `blockKind` and the count would still have read 3 while the
sentence had gone false. That is exactly the failure this card exists to fix, one level in.
`the blockKind claim is derived, not remembered` now also asserts the three fieldless sites'
`terminalCauseKind` values (`handoff-publish`, `handoff-publish`, `ralph-task-built`).
Mutation: swapping one expected kind to `wave-member-built` reddens that test (1 fail of 73);
restored, 73 pass.

**"Can never carry" was stronger than a may-carry static instrument.** The scanner models
three shapes; a fourth way of landing the field (`Object.assign`, a spread of an identifier
it cannot resolve) would read as absent. The prose at `trident/terminal-cause.ts:44-54` now
states the modelled list explicitly and scopes the claim to "no modelled shape supplies it"
rather than to impossibility.

Reviewer-run mutations, each printing its landing line with the file diffed before the run:

| Blinded shape | Landing line | Result |
|---|---|---|
| spread arm of `objectCanSupplyBlockKind` → `return false` | `inner-workflow-terminal-cause.test.ts:502` | RED — `sees a conditional spread`, 1/73 |
| assignment walk → early `return false` | `inner-workflow-terminal-cause.test.ts:483` | RED — `sees an assignment after the literal`, 1/73 |
| named-property arm → `if (false)` | `inner-workflow-terminal-cause.test.ts:501` | RED — 4/73, including the shipped-source count |
| both new shapes blinded together | both above | RED — 4/73; the shipped 12/9 figure genuinely depends on the widening, it is not carried by the named-property arm alone |

Note for a future author: the two doctored-shape controls assert an ABSOLUTE total (13/10),
so they also move if the shipped source's own count changes. That is deliberate here — it
keeps a shape control from passing for the wrong reason — but it means a legitimate edit to
`inner-workflow.mjs` reddens four tests, not one.
