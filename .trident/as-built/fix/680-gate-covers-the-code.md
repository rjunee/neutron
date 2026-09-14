## Issue 680 — cross-model gate covers every code chunk

### What changed

The wrapper now reads its default prose exclusions from `config/codex-review-exclude-paths.txt:1-6`; `NEUTRON_CODEX_REVIEW_EXCLUDE_PATHS_FILE` replaces that list, and an explicit empty value disables filtering (`trident/codex-review.sh:159-162`). It filters complete file blocks before review and fails deferred if the configured list or filter cannot be used (`trident/codex-review.sh:463-482`).

The old line-prefix limit was replaced by the named 1,048,576-character ceiling measured on 2026-09-14 (`trident/codex-review.sh:154-158`). Every character of the filtered diff is assigned to a review call, each prompt states aggregate file coverage, and every chunk is invoked (`trident/codex-review.sh:518-549`). A failed or empty chunk uses the existing deferred outcomes; successful chunk responses are combined with request-changes taking precedence (`trident/codex-review.sh:553-587`). The existing outcome vocabulary maps wrapper exits 3 and 5 to deferred and explicitly says these are not approvals (`trident/codex-review.sh:15-31`).

The tests construct unified-diff blocks and cover all four default exclusions followed by code, exhaustive last-chunk delivery, a fitting single chunk, aggregate verdict precedence, prose-only deferral, override behavior, and configuration refusals (`trident/codex-review.test.ts:411-522`). The historical publisher comment was scoped to the pre-fix behavior (`trident/orchestrator.ts:2889-2895`).

### Decisions

Filtering is configuration-owned because review scope must be explicit and replaceable. Chunking happens after filtering so prose cannot consume model calls by default. Coverage is aggregate `N of N` because the gate invokes every planned chunk; any call failure prevents a successful aggregate result. No feature flag or fallback prefix path remains.

### Mutation table

| Guard | Mutation and landed line | Broken result | Restored result |
|---|---|---|---|
| Default prose filtering | Forced `DIFF_EXCLUDE_PATHS_FILE` empty at `trident/codex-review.sh:162` | leading-prose regression RED | focused file GREEN |
| Exhaustive chunk iteration | Replaced `while` with one-shot `if` at `trident/codex-review.sh:525` | final-chunk regression RED | focused file GREEN |
| Coverage disclosure | Reported `0 of N` at `trident/codex-review.sh:532` | coverage assertion RED | focused file GREEN |
| Aggregate blocker precedence | Matched an impossible verdict at `trident/codex-review.sh:573` | aggregate verdict regression RED | focused file GREEN |
| Character-budget validation | Removed the nonnumeric arm at `trident/codex-review.sh:461` | invalid-budget regression RED (exit 1 instead of deferred exit 3) | focused file GREEN |
| Exclusion readability | Inverted readability at `trident/codex-review.sh:463` | named-refusal regression RED | focused file GREEN |

Verification after restoring every mutation: `bun test trident/codex-review.test.ts` passed 41 tests; `bunx tsc --noEmit` passed; `scripts/ci/lint.sh` passed; `bash -n trident/codex-review.sh` and `git diff --check` passed.

### Deliberately not changed

`SPEC.md` and spec-item decisions were not changed because this fixes the gate instrument rather than product behavior. The upstream review-artifact ordering remains useful for other reviewers; only its historical comment was corrected. The full test suite was not run, per the lane instruction to run only touched specific tests.
