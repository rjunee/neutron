## Issue 548 — version-free model classes

### What changed

The four Claude defaults now select `opus`, `fable`, `sonnet`, and `haiku` rather than concrete releases (`runtime/models.ts:45-87`). The independently loaded boot configuration mirrors those values (`config/index.ts:52-57`), and its existing cross-package drift guard compares the two sources (`gateway/__tests__/model-defaults-drift.test.ts:28-45`). Explicit environment values remain authoritative at each runtime declaration (`runtime/models.ts:45-87`).

Pricing now classifies each version-free selector through `MODEL_CLASS_PRICING_TARGETS` before the existing exact and snapshot lookups (`runtime/model-pricing.ts:183-230`). The exported `resolveModelPricingTarget` is the same catalog lookup used by `resolveModelPricing`, so tests for local Core fallbacks can follow future catalog releases without copying today's ID (`runtime/model-pricing.ts:188-228`, `cores/free/code-gen/__tests__/substrate-runtime.test.ts:602-614`, `cores/free/email/__tests__/tools.test.ts:475-500`). This keeps the existing fail-loud unknown-model behavior at `runtime/model-pricing.ts:241-248` while allowing the four defaults to boot.

The update watchdog now recognizes the same four-class vocabulary (`runtime/adapters/claude-code/persistent/model-update-watchdog.ts:139-144`). On a first class probe it records a matching concrete ID only as the edge-detection baseline and routes a wrong-family answer to the existing fail-closed `skip-unrecognized` outcome (`runtime/adapters/claude-code/persistent/model-update-watchdog.ts:286-295`). Restart restoration does not replace a class with a persisted version (`runtime/adapters/claude-code/persistent/model-update-watchdog.ts:657-665`), and live wiring retains the class when a newer concrete ID is observed (`runtime/adapters/claude-code/persistent/supervision.ts:938-967`).

### Decisions

Class aliases are the dispatch contract because the Claude CLI already demonstrates class-to-current-release resolution with `--model opus` (`runtime/adapters/claude-code/persistent/model-update-watchdog.ts:83-92`). Concrete IDs remain valid only as explicit overrides and persisted observation baselines.

No new watchdog outcome was introduced. Matching resolutions join `ModelUpdateDecision`'s existing `no-change` outcome, while mismatched families join `skip-unrecognized`; the switch persists the former and logs/refuses the latter by default (`runtime/adapters/claude-code/persistent/model-update-watchdog.ts:237-257`, `runtime/adapters/claude-code/persistent/model-update-watchdog.ts:694-727`).

The class invariant is continuously maintained at the default declarations and the boot-config parity test (`runtime/__tests__/models.test.ts:32-78`, `gateway/__tests__/model-defaults-drift.test.ts:28-45`). Watchdog restart and adoption guards do not depend on a stale concrete model remaining callable (`runtime/adapters/claude-code/persistent/model-update-watchdog.ts:657-665`, `runtime/adapters/claude-code/persistent/supervision.ts:938-967`).

### Mutation table

| Guard | Mutation | Red proof | Restored proof |
|---|---|---|---|
| All defaults are version-free classes (`runtime/models.ts:45-87`) | Restored Sonnet's concrete release at `runtime/models.ts:80` in the mutation checkout (the restored declaration is now `runtime/models.ts:80`) | `runtime/__tests__/models.test.ts`: 2 failures | Focused run: green |
| A resolved ID must match its configured class (`runtime/adapters/claude-code/persistent/model-update-watchdog.ts:286-295`) | Inverted the family comparison | `model-class baselines`: 2 failures | Focused run: green |
| A class is never replaced by the observed concrete ID (`runtime/adapters/claude-code/persistent/supervision.ts:938-943`) | Inverted the class-retention condition | wiring test: expected `opus`, received the concrete probe ID | Focused run: green |
| Code-gen's absent-response model follows the Sonnet catalog target (`cores/free/code-gen/__tests__/substrate-runtime.test.ts:602-614`) | Changed the fallback at `cores/free/code-gen/src/substrate-runtime.ts:526` to the prior Sonnet release | Code-gen suite: 1 failure, expected the catalog target and received the prior release | Code-gen suite: 24 passing, 0 failing |
| Email's absent dependency model follows the fast catalog target (`cores/free/email/__tests__/tools.test.ts:475-500`) | Changed the fallback at `cores/free/email/src/tools.ts:190` to the undated Haiku alias | Email suite: 1 failure, expected the catalog snapshot and received the alias | Email suite: 15 passing, 0 failing |

The restored original focused command ran the nine touched/owning test files and reported 139 passing, 0 failing. The two formerly failing Core suites reported 39 passing, 0 failing. `bunx tsc --noEmit` completed successfully. The root package defines neither a typecheck nor lint script (`package.json:42-47`), so the compiler command is the repository-wide type check used here. `git diff --check` also completed successfully.

### Deliberately not changed

Concrete model IDs in historical records and fixtures remain because they test parsing, pricing, downgrade ordering, or persistence compatibility; they are not live defaults (`runtime/adapters/claude-code/persistent/__tests__/model-update-watchdog.test.ts:94-126`, `runtime/__tests__/model-pricing.test.ts:153-196`). The two local Core fallback implementations were not replaced: runtime evidence showed both still default correctly (`cores/free/code-gen/src/substrate-runtime.ts:516-526`, `cores/free/email/src/tools.ts:188-190`), so only their stale assertions and the shared catalog accessor changed. The filed issue did not change a product decision in `SPEC.md`, so no Decisions Log entry was added. No feature flag or parallel runtime path was introduced.
