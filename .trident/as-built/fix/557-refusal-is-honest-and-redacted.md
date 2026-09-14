## 2026-09-14 — branch-name refusal is accurate and redacted

### What changed

The branch-name probe still delegates names that pass the pure pre-filter to `git check-ref-format --branch` (`trident/mutation-prover.ts:4116-4128`). Its failure detail now replaces every occurrence of the repository path with `<repo>` before the detail enters the durable reason (`trident/mutation-prover.ts:4129-4142`). The gate now says that a rejected name was not used to resolve a branch head, instead of claiming that the name was never passed to git (`trident/mutation-prover.ts:4480-4489`).

The regression supplies a repository path inside git stderr, requires the readable diagnosis with `<repo>`, and rejects the original path (`trident/mutation-prover.test.ts:6091-6115`). It also requires the accurate resolution wording and rejects the former wording (`trident/mutation-prover.test.ts:6116-6118`).

### Decisions

The stderr diagnosis remains available because it distinguishes a rejected name from an execution failure; those states already have separate reasons (`trident/mutation-prover.ts:4133-4142`). Redaction occurs before the existing 120-character bound so a long repository path cannot consume the diagnostic budget before it is replaced (`trident/mutation-prover.ts:4131-4132`). An empty repository path is handled separately because splitting on an empty string would insert replacements between every character (`trident/mutation-prover.ts:4132`).

No new outcome was introduced. This remains the existing `MutationGateOutcome` refusal vocabulary (`trident/mutation-prover.ts:4021-4033`): `ok: false` is persisted as the run failure reason (`trident/orchestrator.ts:5304-5329`). The default reader-note classifier only augments the no-nomination prefix, so this branch-name reason stays unchanged by default (`trident/orchestrator.ts:5325-5328`).

### Mutation table

| Guard | Mutation | Red result | Restored result |
|---|---|---|---|
| Repository-path substitution at `trident/mutation-prover.ts:4132` | Replaced the substitution expression with `stderr.slice(0, 120)`; the landed line was printed before the run | Focused test failed at `trident/mutation-prover.test.ts:6114`: expected `<repo>`, received the input path; 0 pass, 1 fail | Focused test: 1 pass, 0 fail, 7 assertions |
| Accurate resolution wording at `trident/mutation-prover.ts:4488` | Restored `It was not passed to git`; the landed line was printed before the run | Focused test failed at `trident/mutation-prover.test.ts:6116`: expected the branch-head-resolution statement; 0 pass, 1 fail | Focused test: 1 pass, 0 fail, 7 assertions |

### Verification

`bun test trident/mutation-prover.test.ts`: 230 pass, 0 fail, 1,477 assertions. `bunx tsc --noEmit -p trident/tsconfig.json`: green. `bash scripts/ci/lint.sh`: all checks green.

Trident's dedicated TypeScript project includes its TypeScript tree (`trident/tsconfig.json:1-4`), and the repository lint entry point documents its checks (`scripts/ci/lint.sh:14-29`); those direct commands were used. The optional leak scan reported zero findings from the rules that ran, but its external owner-PII denylist was unavailable, so that scan is recorded as incomplete rather than clean.

### Deliberately not changed

`trident/inner-workflow.mjs` was not touched. The pure branch-name pre-filter and the distinction between git rejection and a probe that could not run remain intact (`trident/mutation-prover.ts:4087-4102`, `trident/mutation-prover.ts:4133-4142`). No feature flag or alternate path was added. `SPEC.md` was not changed because the product decision did not change; this repair makes the existing refusal report what its probe did. The full suite was not run, per lane instructions.
