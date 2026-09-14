## Issue #828 — workflow script fits the tool limit

### What changed

The shipped workflow is 443,028 bytes. Long standalone rationale moved to the anchored sibling `trident/inner-workflow-rationale.md`; each moved block has a short source link, beginning at `trident/inner-workflow.mjs:1`. Rationale that source-contract tests intentionally inspect remains beside its guard, including `trident/inner-workflow.mjs:2241-2305`, `trident/inner-workflow.mjs:3715-3741`, and `trident/inner-workflow.mjs:4954-4971`.

The new guard measures the real sibling file through `import.meta.url` at `trident/inner-workflow-size.test.ts:10-14`. It records the Workflow tool's 524,288-byte cap and enforces a 491,520-byte ceiling at `trident/inner-workflow-size.test.ts:5-20`, reserving 32 KiB for routine maintenance.

### Decisions and evidence

The reduction relocates only parser-identified standalone comment groups; it does not use a comment-stripping regular expression. A Babel parse with top-level returns enabled enumerated 29,811 non-comment token type/value pairs before and after, and the streams were identical. The same parser enumerated 489 original comment groups; every group remains byte-for-byte in either the executable or the sibling rationale document.

Line-start enumeration of `function`, `async function`, and `const` declarations found 229 names before and after, with an empty name-only diff. The top-level success and failure returns remain at `trident/inner-workflow.mjs:6848` and `trident/inner-workflow.mjs:6904`; cleanup remains after them at `trident/inner-workflow.mjs:6905-6944`. The text extractor documents its eight-function/three-const contract at `trident/testing/load-escalation-gate.ts:5-17`, and its dedicated test passed.

This adds no runtime outcome, so there is no error/verdict taxonomy to extend. The size invariant is maintained continuously by the test at `trident/inner-workflow-size.test.ts:12-21`; it reads the file directly and does not depend on the Workflow runtime accepting or executing the oversized script.

### Mutation table

| Guard | Mutation | Red | Restored |
|---|---|---|---|
| Size ceiling, `trident/inner-workflow-size.test.ts:7-20` | Appended a 100,026-byte block comment at workflow line 6813, producing a 533,887-byte file | 0 pass, 1 fail; received 533,887, expected at most 491,520 | 1 pass, 0 fail |
| Real shipped path, `trident/inner-workflow-size.test.ts:10-14` | Changed line 10 to a nonexistent sibling path | 0 pass, 1 fail with `ENOENT` from `statSync` | 1 pass, 0 fail |

The guard was created before the reduction and failed on the received 613,663-byte file: 0 pass, 1 fail, expected at most 491,520.

### Verification

- `bun test trident/inner-workflow-size.test.ts`: 1 pass, 0 fail.
- `bun test trident/__tests__/escalation-gate.test.ts`: 43 pass, 0 fail.
- `bash scripts/ci/lint.sh`: green across all reported gates.
- `bash scripts/ci/typecheck-all.sh`: `trident/tsconfig.json` passed; the 51-config matrix reported existing errors only in untouched areas.
- `bun test trident/`: 5,028 pass and 5 skip on the first full run. Source-contract failures caused by moving three comments were corrected and their specific tests passed. Five unchanged server tests cannot listen on an ephemeral port in this environment, and two unchanged launcher timing assertions failed at `trident/abandon-poison-e2e.test.ts:166,201`.
- `scripts/ci/leak-gate.sh --tree .`: zero findings from every available rule; local result incomplete because the external PII denylist is unavailable.

### Deliberately not changed

No executable token, declaration name, runtime outcome, feature path, spec decision, or file outside the task's implementation/test/as-built scope changed. `trident/inner-workflow-assembly.test.ts` was not edited. The three rationale blocks asserted as live source contracts were retained beside their code rather than weakening their tests.
