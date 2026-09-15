## 2026-09-15 — built-head, brief, and result-contract extraction

### What changed

The build-completion head reader is now available as an injected TypeScript gate with its three-attempt budget (`trident/gates/built-head.ts:1-38`). The brief receipt algorithm has one TypeScript implementation (`trident/gates/brief-integrity.ts:1-39`), and the existing brief writer imports and re-exports that owner (`trident/brief-parts.ts:1-4`).

The workflow result vocabulary is represented by `VerdictTrailer`, `ForgeTrailer`, and `PlanTrailer` (`trident/gates/result-contract.ts:14-49`). Their validator accepts only the declared fields and returns a typed rejection containing a reason and value path rather than throwing (`trident/gates/result-contract.ts:58-67`, `trident/gates/result-contract.ts:204-219`). Tests now import these boundaries directly (`trident/gates/built-head.test.ts:1-56`, `trident/gates/result-contract.test.ts:1-26`, `trident/brief-parts.test.ts:1-55`).

### Decisions

The built-head function is bound through a dependency factory because the workflow supplies its agent, quoting, normalization, and logging capabilities from its execution environment (`trident/gates/built-head.ts:3-18`). The returned function retains the existing command, retry, normalization, missing-ref, and unreadable outcomes (`trident/gates/built-head.ts:20-37`).

Trailer rejection joins the explicit `TrailerRejectionReason` vocabulary: `not-object`, `missing-field`, `unexpected-field`, `wrong-type`, and `invalid-enum` (`trident/gates/result-contract.ts:58-63`). Its default cost is refusal; every invalid branch returns `ok: false`, while only complete validation returns the typed value (`trident/gates/result-contract.ts:172-219`). The validator itself continuously maintains the invariant and does not depend on a worker remaining operational after it emits a malformed value (`trident/gates/result-contract.ts:172-219`).

Normalized extraction diffs were empty for `briefIntegrity` and `readBuiltHead`; normalization removed only TypeScript annotations and the two-space factory indentation. The source behavior remains at `trident/inner-workflow.mjs:1313-1350` and `trident/inner-workflow.mjs:4272-4289` until the host cutover consumes the TypeScript gates.

### Mutation table

| Guard | Mutation | Red result | Restored result |
|---|---|---|---|
| Required trailer fields at `trident/gates/result-contract.ts:203` | Inverted `!(field in value)` to `field in value`; the landed mutant line was printed | `trident/gates/result-contract.test.ts`: 0 pass, 3 fail | 3 pass, 0 fail, 9 assertions |
| Built-head retry budget at `trident/gates/built-head.ts:1` | Changed three attempts to one; the landed mutant line was printed | `trident/gates/built-head.test.ts:51-54` received an empty head instead of the second readable reply; 3 pass, 1 fail | 4 pass, 0 fail, 10 assertions |
| Brief FNV seed at `trident/gates/brief-integrity.ts:4` | Changed the final seed digit from five to four; the landed mutant line was printed | `trident/brief-parts.test.ts:52-55` observed a receipt mismatch; 3 pass, 7 fail | 10 pass, 0 fail, 55 assertions |

### Verification

`bun test trident/gates/built-head.test.ts trident/gates/result-contract.test.ts trident/brief-parts.test.ts trident/inner-workflow-built-head.test.ts`: 54 pass, 0 fail, 193 assertions. `bunx eslint` over the changed TypeScript files: green. `bunx tsc -p trident/tsconfig.json --noEmit`: green.

The root `bunx tsc --noEmit` remains red on three files outside this lane: `gateway/transcription/__tests__/whisper-install.test.ts:186`, `logger/__tests__/fire-and-forget.test.ts:301`, and `onboarding/history-import/__tests__/zip-writer.ts:10`. No assertion was loosened or skipped to hide those unrelated errors.

### Deliberately not changed

The executable workflow copy remains in place because this lane extracts gates for the replacement host and does not rewrite the legacy loop (`trident/inner-workflow.mjs:3-8`, `trident/gates/built-head.ts:15-38`). No feature flag, alternate outcome path, or product decision was introduced. `SPEC.md` was not changed because the result is an implementation boundary for the locked replacement design, not a change to that design.
