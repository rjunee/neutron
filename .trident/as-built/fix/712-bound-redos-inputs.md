## Issue 712 — bound externally influenced regex inputs

### What changed

The eight alerts were enumerated from the filed issue table and mapped to seven implementation sites; alerts 43 and 44 are two expressions at the same compiled-truth line boundary.

- Alert 26: `mirroredSlug` refuses a source longer than 128 characters before normalization (`connect/shared-project-memory-mirror.ts:105-121`). The composed value is a project id, separator, and an existing 80-character host slug; refusal avoids namespace collisions that truncation could create.
- Alert 29: `parseAgenda` returns no agenda for a provider description above 8 KiB before splitting or matching it (`cores/free/calendar/src/backend.ts:934-953`). This accommodates ordinary human-authored event descriptions without admitting an unbounded provider payload.
- Alert 34: research JSON extraction refuses a model response above 64 KiB before trimming or fence matching (`cores/free/research/src/backend.ts:445-453`). The research substrate's 4,096-token default is declared at `cores/free/research/src/substrate-runtime.ts:82-95`, so this is a conservative response envelope.
- Alert 35: package slugging rejects names above npm's 214-character package-name limit as `manifest_invalid` before either normalization expression (`cores/runtime/loader.ts:61-92`). That value joins the existing `CoreInstallErrorCode` taxonomy, where `manifest_invalid` already represents invalid package metadata (`cores/runtime/errors.ts:20-29`).
- Alert 40: entity slugging returns `null` for names above 256 characters before normalization (`runtime/entity-slug.ts:22-42`). The function already uses `null` for invalid slug inputs, while successful output remains capped at 80 characters (`runtime/entity-slug.ts:27-42`).
- Alert 42: the 32 KiB bound sits INSIDE `extractJsonObject` (`scribe/extract.ts:310`, `scribe/extract.ts:317-325`), the function that owns the flagged fence expression, so it applies to every caller. Scribe dispatch requests at most 2,048 completion tokens (`scribe/extract.ts:193`). `parseExtraction` continues to return its established empty extraction (`scribe/extract.ts:226-227`).
- Alerts 43 and 44: boilerplate stripping preserves a compiled-truth line above 8 KiB verbatim and skips all three classification expressions (`scribe/reflect/jaccard.ts:136-160`). Generated headings and marker lines are short; retaining oversized prose is the data-preserving refusal.

The new outcomes use existing behavior by default. Mirror import propagates every error other than the explicitly tolerated missing-binary case (`connect/shared-project-memory-mirror.ts:393-402`). Research parse errors enter the existing retry/failure path (`cores/free/research/src/backend.ts:969-976`). Calendar and scribe retain their best-effort empty results (`cores/free/calendar/src/backend.ts:934-950`, `scribe/extract.ts:225-239`), entity slugging retains `null` (`runtime/entity-slug.ts:34-42`), and compiled-truth stripping retains unclassified prose (`scribe/reflect/jaccard.ts:143-157`).

### Tests and mutation evidence

Each test contains an input just over its boundary and an ordinary complement: `connect/__tests__/shared-project-memory-mirror.test.ts:60-62`, `cores/free/calendar/__tests__/backend.test.ts:233-238`, `cores/free/research/__tests__/extract-json-bound.test.ts:5-10`, `cores/runtime/__tests__/loader.test.ts:62-68`, `runtime/__tests__/entity-slug.test.ts:5-9`, `scribe/__tests__/scribe-extract.test.ts:91-98`, and the two expression-specific cases at `scribe/__tests__/reflect-jaccard.test.ts:63-74`.

| Alert / guard | Mutation, with landed line printed | Mutated result | Restored result |
|---|---|---|---|
| 26 mirror source | Removed the length check immediately before normalization; printed `connect/shared-project-memory-mirror.ts:117-119` | RED: expected `RangeError`, received normalized slug | GREEN: 1 pass |
| 29 calendar description | Removed the check immediately before `description.trim`; printed `cores/free/calendar/src/backend.ts:934-945` | RED: oversized bullet was returned | GREEN: 1 pass |
| 34 research response | Removed the check immediately before `raw.trim`; printed `cores/free/research/src/backend.ts:445-456` | RED: expected response-bound error, received parsed object | GREEN: 1 pass |
| 35 package name | Removed the `manifest_invalid` length branch before scope stripping; printed `cores/runtime/loader.ts:61-78` | RED: expected typed error, function returned a slug | GREEN: 1 pass |
| 40 entity name | Removed the return before normalization; printed `runtime/entity-slug.ts:33-41` | RED: expected `null`, received an 80-character slug | GREEN: 1 pass |
| 42 scribe response | Bound inside `extractJsonObject` neutralised (`if (false)`); printed `scribe/extract.ts:324` | RED 2: both `parseExtraction` and `parseReservedExtraction` returned the oversized document's entity | GREEN: 11 pass |
| 42 complement | Same line forced always-refuse (`if (true)`); printed `scribe/extract.ts:324` | RED 7: every ordinary parse control in the file | GREEN: 11 pass |
| 43 H1 expression | Removed the shared line skip before the H1 expression; printed `scribe/reflect/jaccard.ts:136-150` | RED: oversized H1 was stripped | GREEN: 1 pass |
| 44 generated-body expression | Same shared line skip mutation, separate fixture for the generated-body expression | RED: oversized marker line was stripped | GREEN: 1 pass |

The seven touched test files passed together: 100 tests, 275 assertions. The restored focused mutation checks passed: eight tests across seven files. `bash scripts/ci/typecheck-all.sh` checked all 51 TypeScript configurations and passed. `bash scripts/ci/lint.sh` passed every reported lint guard. `git diff --check` passed.

### Decisions and deliberately excluded work

Refusal was chosen instead of truncation for identifiers and model documents: identifier truncation risks collisions, while partial JSON changes meaning. Best-effort parsers keep their established empty/no-op outcomes. The expressions themselves were not rewritten, no alternative path or feature switch was added, and no CodeQL alert state was changed. No product decision changed, so `SPEC.md` was not edited.

### Review lane: where the bound was moved, and why (2026-09-14)

Rebased onto `origin/main` at `735fa505`.

**A gap the build lane left, found and closed here.** Alert 42's flagged expression
is at `scribe/extract.ts:322` — inside `extractJsonObject`, not inside
`parseExtraction`. The build lane bounded `parseExtraction`, which is only ONE of
that function's two callers: `parseReservedExtraction`
(`scribe/reflect/reserved-kinds.ts:77-78`) feeds it the reflect pass's raw model
output (`scribe/reflect/reflect-pass.ts:1080`) with no bound at all, so the flagged
expression stayed reachable with unbounded externally-influenced input. The bound
was MOVED into `extractJsonObject` rather than duplicated at the second caller: a
per-call-site rule is what left the first gap, and a duplicated bound would have
left one of the two guards unpinnable by mutation.

Control for the claim: with the bound at its original `parseExtraction` site, the
new `parseReservedExtraction` case FAILS; with the bound inside
`extractJsonObject`, the whole file passes 11/11. Both directions of the relocated
bound were then mutated (table row 42 above).

**One stale sentence corrected.** `runtime/entity-slug.ts` still documented the
80-character cap as the guard against "a rare LLM-extracted multi-KB name". After
alert 40 that is no longer where a multi-KB name is stopped — it is refused at the
input bound, before normalisation. The docstring now says so and keeps the 80-char
output cap's real role.

**All eight mutations re-run independently after the rebase**, each in BOTH
directions (`if (false)` to remove the bound, `if (true)` to make it refuse
everything), with the landing line printed and the file diffed before each run.
Every site reddened in both directions, so no bound is a cap that simply rejects
everything. Site 34 (`cores/free/research`) reds the same single test in both
directions because its over-bound assertion and its ordinary-input control live in
one test body.

**Post-rebase suites.** `bun test cores/` — 1504 pass, 2 skip, 0 fail across 123
files (run in full because this change touches `cores/`; no Zod schema and no
regular expression was replaced anywhere in the diff, so no `invalid_string` →
`custom` error-code movement is possible). `bun test scribe/__tests__/
runtime/__tests__/entity-slug.test.ts` — 195 pass, 0 fail. The seven originally
touched test files — 100 pass, 0 fail. `scripts/ci/typecheck-all.sh` — 51/51.

**NOT VERIFIED, stated rather than implied.** Whether CodeQL itself will now close
alerts 26/29/34/35/40/42/43/44 is not established here — a pre-match length bound
is not necessarily visible to the `js/polynomial-redos` query, and re-running the
analysis is CI's job. No alert state was changed in CodeQL by this lane or this
review, which the issue requires. The three inputs the owner does not control —
the provider's calendar description (29), the third-party Core author's package
name (35), and model responses (34, 42) — are all bounded, and 42's second caller
is bounded by this review.
