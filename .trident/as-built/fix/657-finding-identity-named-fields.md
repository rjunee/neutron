## Issue #657 — finding identity from named fields

### What changed

The review schema now requires `file`, `symbol`, `rule`, and a separate nullable `line` for every model-authored finding (`trident/inner-workflow.mjs:873`). The identity helper constructs `file:symbol:rule` from the three stable fields and returns the existing undecidable sentinel when any is absent or empty (`trident/inner-workflow.mjs:3566`). Title, evidence, line, and the former concatenated field are deliberately unread by that helper (`trident/inner-workflow.mjs:3557`).

The Codex bridge, Kimi bridge, and synthesis instructions all describe the named-field contract and keep line and prose outside identity (`trident/inner-workflow.mjs:7091`, `trident/inner-workflow.mjs:7115`, `trident/inner-workflow.mjs:7433`). The normative review-loop item records the same structured identity rule (`docs/spec-items/the-review-loop-must-stop-and-re-plan.md:33`).

### Decisions

This is a hard replacement: there is no legacy-field parser or title-derived fallback. A missing named field joins the existing `repeatVerdict` outcome vocabulary as `undecidable`; that vocabulary only returns `none` when both lists and every identity are readable (`trident/inner-workflow.mjs:3596`). The existing escalation decision reports undecidable readings and relies on the independent no-progress arithmetic rather than classifying an unknown finding as fresh (`trident/inner-workflow.mjs:3604`).

Only notation is normalized: surrounding whitespace on each named field and a leading `./` on `file`. Case and field contents remain significant (`trident/inner-workflow.mjs:3563`). Line is nullable because review-wide and provider-failure findings have no meaningful source line, while the schema still requires an explicit separate slot (`trident/inner-workflow.mjs:895`).

The identity helper's source range was searched with `f.(title|file)` and `f.(key|file)`: both searches matched the positive-control `f.file` reads at `trident/inner-workflow.mjs:3568` and found no `f.title` or `f.key` read in the helper. This establishes that neither prose nor the former field is a fallback.

### Tests and mutation

The focused test constructs findings from named fields (`trident/__tests__/escalation-gate.test.ts:34`), proves distinct rules remain distinct (`trident/__tests__/escalation-gate.test.ts:287`), proves prose and line changes retain one identity (`trident/__tests__/escalation-gate.test.ts:327`), and proves malformed or former-field-only findings are undecidable (`trident/__tests__/escalation-gate.test.ts:351`). End-to-end fixtures use the same structured shape (`trident/__tests__/escalation-e2e.test.ts:80`).

| Guard | Mutation | RED | Restored GREEN |
|---|---|---|---|
| `findingIdentity` reads `file`, `symbol`, `rule` | Replaced those reads with `f.key.split(':')`; printed mutation at `trident/inner-workflow.mjs:3568` | `bun test trident/__tests__/escalation-gate.test.ts -t 'line movement and prose rewording'` failed: expected `repeat`, received `undecidable` | Same command: 1 pass, 0 fail |

Validation: `bun run typecheck` was attempted and reported that the script does not exist. The repository entrypoint `bash scripts/ci/typecheck-all.sh` passed all 51 TypeScript projects. `bash scripts/ci/lint.sh` passed every lint gate. The three changed test files passed together with 97 tests and 0 failures. `trident/inner-workflow.test.ts` and `trident/__tests__/synthesis-unavailable.test.ts` also passed; the unrelated subprocess portion of `trident/__tests__/cross-model-rate-limited.test.ts` could not bind an ephemeral local port in this sandbox, while its source-level prompt assertion was restored and passes independently.

### Deliberately not changed

The repeat verdict names (`repeat`, `none`, `undecidable`), escalation kind (`not-converging`), and no-progress backstop are unchanged. Infrastructure, suite, and advisory findings authored inside the workflow remain outside reviewer finding identity, as they already use separate classification fields and are not reviewer judgements about a defect site (`trident/inner-workflow.mjs:3064`). No compatibility path accepts the removed concatenated field.
