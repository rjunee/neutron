## Issue 937 — provider vocabulary reconciliation

### What changed

The provider vocabulary is now owned once by `PROVIDERS` at `runtime/provider.ts:2`; the bounded-work contract imports its `Provider` type at `runtime/bounded-work.ts:44`, and conversational normalization validates against the same list at `runtime/adapters/select-substrate.ts:151-160`. The Codex CLI value is now `openai-codex` throughout active code, matching the worker contract.

Project PATCH validation admits the same four values at `gateway/http/app-projects-surface.ts:1072-1082`. Migration 0146 rebuilds the projects constraint with those values at `migrations/0146_project_provider_vocabulary.sql:24-26` and translates the former Codex spelling at `migrations/0146_project_provider_vocabulary.sql:33-38`. The snapshot test accepts every canonical value and rejects obsolete and unknown values at `migrations/snapshot.test.ts:72-86`; its upgrade fixture proves the translation at `migrations/snapshot.test.ts:89-106`.

### Decisions

`openai-codex` won because the bounded-work contract and implemented Codex runner already use it at `runtime/bounded-work.ts:44` and `runtime/workers/codex-headless.ts:114`. `openai` remains distinct because it selects the Responses API adapter at `runtime/adapters/select-substrate.ts:175-176`.

`pi` joins the existing provider-selection vocabulary. It is valid in configuration and storage, but no conversational adapter exists, so `assertConversationalProviderWired` throws at `runtime/adapters/select-substrate.ts:104-110`. Selection invokes that guard at `runtime/adapters/select-substrate.ts:172-174`, and both dynamic conversational entry points invoke it after normalization at `gateway/wiring/build-llm-call-substrate.ts:703-705` and `gateway/wiring/build-import-substrate.ts:250-252`. Open-mode boot uses the same guard at `open/composer.ts:844-850`. Thus the default handling for this recognized-but-unwired value is a named refusal, never Claude selection, and the maintaining mechanism does not rely on the missing adapter running.

The applied migration was not rewritten. Migration 0146 is forward-only because the ledger classifies an earlier migration as recorded by its name at `migrations/runner.ts:183`; changing migration 0145 alone would not update databases that already recorded it.

### Mutation table

| Guard | Mutation | Red proof | Restored proof |
|---|---|---|---|
| Shared provider list, `runtime/provider.ts:2` | Removed `pi` | `runtime/adapters/select-substrate.test.ts` failed 2 tests | targeted suite green |
| PATCH validator, `gateway/http/app-projects-surface.ts:1074` | Removed the `pi` allowance | `PATCH accepts pi and rejects the obsolete Codex spelling` failed: expected 200, received 400 | targeted suite green |
| Stored CHECK, `migrations/0146_project_provider_vocabulary.sql:25` | Removed `pi` | `projects accept the shared provider vocabulary and reject obsolete or unknown values` failed on the CHECK | targeted suite green |
| Conversational refusal, `runtime/adapters/select-substrate.ts:104-110` | Replaced the throw with return | selector refusal test and both Open-mode credential cases failed | targeted suite green |

The final targeted command covered seven named files and passed 144 tests with 0 failures. `bash scripts/ci/lint.sh` passed every gate. `bash scripts/ci/typecheck-all.sh` checked 51 configurations: all configurations touched by this change passed, while `app/tsconfig.json` failed before reaching project code because its implicit `@types` definition directory is unavailable in this checkout; the matrix therefore reported failed overall. Direct checks of `runtime/tsconfig.json`, `gateway/tsconfig.json`, and `open/tsconfig.json` passed.

### Deliberately not done

No conversational Pi adapter was invented; the selector’s exhaustive factory switch enumerates only the three wired adapters at `runtime/adapters/select-substrate.ts:172-185`. No compatibility dual-read was added to active code: a whole-scope `rg` enumeration for both Codex spellings found the former spelling only in migration 0145, migration 0146's translation, and rejection/upgrade fixtures, while the same search positively found the canonical spelling in runtime, gateway, Open wiring, the current schema snapshot, and the related spec item. `SPEC.md` was unchanged because this repairs an inconsistent implementation vocabulary without changing a product decision.
