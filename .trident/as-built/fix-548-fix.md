## Issue 548 — model classes resolve the latest version per tier

### What changed

The runtime defaults now pass Claude Code the bare `opus`, `fable`, `sonnet`,
and `haiku` classes (`runtime/models.ts:45-88`). Claude Code receives the chosen
value directly as the final `--model` argument (`runtime/adapters/claude-code/persistent/build-repl-argv.ts:180`), so version selection happens when a model process starts. Explicit environment values still win over each default (`runtime/models.ts:45-88`).

Boot configuration mirrors the same four class defaults (`config/index.ts:52-57`), and the existing cross-package drift guard compares that table with all four runtime exports (`gateway/__tests__/model-defaults-drift.test.ts:28-45`). The strict pricing registry now recognizes each bare class while retaining numbered entries for explicit pins and historical accounting (`runtime/model-pricing.ts:79-150`). The focused pricing coverage enumerates all five exported defaults, including the probe alias (`runtime/__tests__/pricing-covers-defaults.test.ts:26-48`).

Durable acceptance criteria live in `docs/spec-items/pin-model-class-resolve-latest-per-tier.md:9-28`, and the product decision is recorded at `SPEC.md:294-302`.

### Decisions

The class names are passed through unchanged rather than resolved in Neutron. The existing spawn seam already delegates `--model` resolution to Claude Code (`runtime/adapters/claude-code/persistent/build-repl-argv.ts:180`), and the watchdog probe already uses the `opus` class (`runtime/adapters/claude-code/persistent/model-update-watchdog.ts:86-91`). This replaces numbered defaults without adding a feature flag or a second dispatch path.

No new error, verdict, state, or refusal was introduced. Unknown pricing values remain in the existing `resolveModelPricing` lookup vocabulary and take its default loud failure (`runtime/model-pricing.ts:209-230`). The maintained invariant is that runtime defaults, boot defaults, and pricing coverage move together: the default-value assertion guards the runtime table (`runtime/__tests__/models.test.ts:32-40`), the cross-package drift assertion guards boot configuration (`gateway/__tests__/model-defaults-drift.test.ts:28-45`), and the pricing loop guards every exported default (`runtime/__tests__/pricing-covers-defaults.test.ts:26-48`). These checks do not depend on a failed model process.

### Mutation table

| Guard | Mutation | Red result | Restored result |
|---|---|---|---|
| Runtime class defaults (`runtime/__tests__/models.test.ts:33-40`) | Changed `runtime/models.ts:46` from `opus` to a numbered Opus id; printed the landed line | 1 failed, 4 passed; the class-default equality failed | Focused six-file run: 65 passed, 0 failed |
| Boot/runtime drift (`gateway/__tests__/model-defaults-drift.test.ts:29-45`) | Changed `config/index.ts:56` from `sonnet` to a numbered Sonnet id; printed the landed line | 1 failed, 0 passed; the declared and runtime maps differed | Focused six-file run: 65 passed, 0 failed |
| Strict default pricing (`runtime/__tests__/pricing-covers-defaults.test.ts:26-48`) | Removed the `haiku` row at `runtime/model-pricing.ts:123`; printed the surrounding table | 2 failed, 5 passed; FAST_MODEL and PROBE_MODEL both threw | Focused six-file run: 65 passed, 0 failed |

### Verification

`bun test runtime/__tests__/models.test.ts runtime/__tests__/model-pricing.test.ts runtime/__tests__/pricing-covers-defaults.test.ts config/__tests__/bootconfig-defaults.test.ts gateway/__tests__/model-defaults-drift.test.ts trident/ported-fixes.test.ts`: 65 passed, 0 failed, 220 assertions.

`bunx tsc -p runtime/tsconfig.json --noEmit`, `bunx tsc -p config/tsconfig.json --noEmit`, and `bunx tsc -p trident/tsconfig.json --noEmit` passed. Gateway typecheck reached unrelated existing errors at `gateway/transcription/__tests__/whisper-install.test.ts:186` and `onboarding/history-import/__tests__/zip-writer.ts:10`. `bash scripts/ci/lint.sh` and `git diff --check` passed.

The leak gate reported zero findings from every rule that ran, but its local PII denylist rules could not run because their external pattern file was unavailable; this is explicitly an incomplete result rather than a clean claim.

### Deliberately not changed

The model-update watchdog was not expanded to probe four classes. Class aliases make version discovery the Claude CLI's responsibility at each process start (`runtime/models.ts:4-6`); adding parallel probes would duplicate that resolver. Numbered pricing entries remain because explicit environment pins are supported (`runtime/models.ts:33-34`) and historical billing still needs their distinct rates (`runtime/model-pricing.ts:129-150`). The full test suite was not run, per the lane's bounded-validation instruction.
