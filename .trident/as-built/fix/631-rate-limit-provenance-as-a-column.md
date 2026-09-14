## 2026-09-14 — Carry cross-model rate-limit provenance through the harvested result

### Change and evidence

Issue #631 replaces the terminal advice's text matcher with a nullable boolean in
`inner_result`, the existing JSON column. The producer aggregates the configured
seats' own fields at `trident/inner-workflow.mjs:6695`: any explicit true wins;
false requires every configured seat to report false; absent, malformed, unsupported
or empty evidence remains null. It stamps the round at
`trident/inner-workflow.mjs:7615` and carries the last round's value into the terminal
result at `trident/inner-workflow.mjs:9187`. The existing writer serializes the
whole result at `trident/inner-workflow.mjs:2917`.

`trident/inner-loop.ts:917` accepts only booleans, without coercion or text fallback.
`trident/infra-block.ts:72` carries that value beside the cause, behind the existing
harvest and infra-only gate at `trident/infra-block.ts:70`. Delivery reads unknown
at `trident/delivery.ts:715`, true at `trident/delivery.ts:717`, and explicit false
at `trident/delivery.ts:719`. True gets provider advice even when the message
contains competing cause words. Unknown gets generic infrastructure advice and an
explicit statement that the rate-limit observation is unknown. False retains the
ordinary cause remedies. None of these changes the `infra-blocked` class returned
at `trident/delivery.ts:727`.

### Vocabulary and continuous maintenance

This is a fact field, not a new failure class, retry policy or verdict. It joins
`InnerResult`'s nullable observations at `trident/inner-loop.ts:310` and the existing
infra-block derivation. Unknown neither asserts a negative nor authorizes provider
advice. Early exits and older rows without a stamp decode as unknown. Strict decoding
and the harvested-result gate run in the outer reader, so a failing workflow does
not need to remain alive to maintain that refusal to infer facts from prose.

The precedent was checked before use:
`runtime/adapters/claude-code/persistent/classify-spawn-error.ts:91` validates the
class stamped on an error; `runtime/adapters/claude-code/persistent/pool.ts:454`
reads it, with an unstamped error defaulting to retryable at line 455. This change
uses the same producer/validated-reader ownership, without copying its message
fallback. The pre-existing seat helper at `trident/inner-workflow.mjs:6687` remains
a positive-evidence predicate for retry and panel presentation; its false result
is deliberately not used as a measured negative in this new provenance column.

Consumers were enumerated with repository-wide searches for the old matcher names,
`deriveInfraBlock`, and the new field names. The new field's production readers
are the terminal transport, decoder, deriver and delivery branches cited above.
The old matcher constants have no live-code hits: the same search positively
matches `cross_model_rate_limited` in `trident/delivery.ts:715`. The old names remain
only in the immutable historical record
`docs/as-built/542-quota-exhausted-honest-outcome.md:214` and line 244. Those hits
remain as accounts of what that earlier change shipped, not current instructions.

### Acceptance and verification

The five new tests begin at
`trident/__tests__/cross-model-rate-limited.test.ts:1146`. They check three-state
aggregation, both routed slots, actual round and terminal property expressions,
strict decoding, derivation, reworded positive messages, ordinary negatives,
malformed values and old rows. The property expressions are enumerated from the
workflow AST at `trident/__tests__/cross-model-rate-limited.test.ts:1165`, not
copied into a substitute implementation. Existing prefix, suffix and substitution
negative tests remain. The obsolete label drift test was removed with the table
it guarded.

The ordinary-cause fixture now explicitly supplies false at
`trident/delivery.test.ts:631`; its existing remedy assertions remain. Unknown
object expectations include null at `trident/inner-loop.test.ts:188` and line 398.

- `bun test trident/delivery.test.ts trident/inner-loop.test.ts trident/__tests__/synthesis-unavailable.test.ts trident/lane-retry.test.ts`: **228 pass, 0 fail**.
- `bun test trident/__tests__/cross-model-rate-limited.test.ts`: **42 pass, 5 fail**.
  All five failures occur while the existing CLI fixture binds its local HTTP
  server at `trident/__tests__/cross-model-rate-limited.test.ts:385`, reporting
  EADDRINUSE for port 0 in this restricted environment. No assertions were weakened,
  no test was disabled, and a full green run is still required in the review environment.
- `bun test trident/__tests__/cross-model-rate-limited.test.ts -t '#631'`:
  **5 pass, 0 fail**, including after every restored mutation.
- `bash scripts/ci/lint.sh`: **exit 0**.
- `bash scripts/ci/leak-gate.sh --tree .`: **exit 3, incomplete**; zero findings
  from active rules, but the private denylist and message denylist rules could not run.
- `bash scripts/ci/typecheck-all.sh`: **51 configurations pass, exit 0** on the
  final rerun. The initial run caught two exact-object expectations, corrected
  above; the targeted trident rerun also exited 0.

### Mutation evidence

Each mutation was applied alone. Its landed line and a unified diff against the
fixed source were printed before the run. The five #631 tests went red under every
mutation and green after restoration. The complete output is retained in the
build lane's temporary mutation log for review.

| Guard | Landed line | Mutation | Mutated | Restored |
| --- | --- | --- | --- | --- |
| M1 positive observation | `trident/inner-workflow.mjs:6697` | `if (observed.some((value) => value === true)) return false` | RED | GREEN (5 tests) |
| M2 negative observation | `trident/inner-workflow.mjs:6698` | `if (observed.length > 0 && observed.every((value) => value === false)) return true` | RED | GREEN (5 tests) |
| M3 unknown companion | `trident/inner-workflow.mjs:6698` | `observed.some((value) => value === false)` | RED | GREEN (5 tests) |
| M4 empty panel | `trident/inner-workflow.mjs:6698` | `observed.every` | RED | GREEN (5 tests) |
| M5 configured seats | `trident/inner-workflow.mjs:6696` | `slots.filter(() => true)` | RED | GREEN (5 tests) |
| M6 unknown evidence | `trident/inner-workflow.mjs:6698` | `if (observed.length > 0 && observed.every((value) => value === false)) return false   return false` | RED | GREEN (5 tests) |
| M7 round transport | `trident/inner-workflow.mjs:7615` | `crossModelRateLimited: null,` | RED | GREEN (5 tests) |
| M8 terminal transport | `trident/inner-workflow.mjs:9187` | `crossModelRateLimited: null,` | RED | GREEN (5 tests) |
| M9 strict decoder | `trident/inner-loop.ts:917` | `Boolean(p.crossModelRateLimited)` | RED | GREEN (5 tests) |
| M10 derivation transport | `trident/infra-block.ts:72` | `cross_model_rate_limited: null` | RED | GREEN (5 tests) |
| M11 unknown advice | `trident/delivery.ts:715` | `if (infra.cross_model_rate_limited === false)` | RED | GREEN (5 tests) |
| M12 positive advice | `trident/delivery.ts:717` | `else if (infra.cross_model_rate_limited === false)` | RED | GREEN (5 tests) |
| M13 negative decoder | `trident/inner-loop.ts:917` | `p.crossModelRateLimited === true ? true : null` | RED | GREEN (5 tests) |
| M14 text fallback | `trident/delivery.ts:717` | `else if (infra.cross_model_rate_limited === true \|\| c.includes('rate limited'))` | RED | GREEN (5 tests) |

### Deliberate limits and decisions

No database migration, backfill, new provider detector, retry-policy change, feature
flag or fallback matcher. No new product decision in SPEC.md: this implements the
filed acceptance, including generic advice for absent provenance. The upstream
provider-to-verdict signal remains the existing contract; this change prevents its
terminal consumers from reconstructing that signal from the message.

The as-built record is staged under `.trident/as-built/` as explicitly requested
by the build-lane task, overriding the repository's normal `docs/as-built/`
location for this handoff. The branch is committed locally for orchestrator review;
it is not pushed, published or merged by this lane.

---

## Review-lane correction: the `null` arm was swallowing the cause-derived advice

### The defect, measured

`interpretFailure`'s infra arm carries two pieces of advice derived from the
MEASURED cause and nothing else — "conflicting with base" → rebase, "required check
… has not run" → re-run CI. Neither ever depended on a cross-model observation.

The first cut branched on the provenance column FIRST:

    if (cross_model_rate_limited === null)      -> bare generic + "unknown"
    else if (cross_model_rate_limited === true) -> rate-limit advice
    else                                        -> the two cause arms

Every row written before this column existed decodes `null`. So the `null` arm — the
entire existing corpus, plus any run with no configured cross-model seat — lost both
cause arms and got "Retry the build once the infrastructure is healthy", on a run
whose own measured cause says the PR is conflicting with its base.

This was invisible because the same change added `crossModelRateLimited: false` to
the shared infra fixture in `trident/delivery.test.ts`, which is what kept the two
pre-existing advice tests green. Removing that one line — restoring the OLD-ROW
shape, which is what every row on disk actually looks like — reddens both:

    trident/delivery.test.ts:657  expected "re-run ci"
    trident/delivery.test.ts:678  expected /rebase|merge the base branch/

The lane's own mutation table could not see this: all 14 mutations were scored
against the five tests this change added, so a regression in behaviour those tests
do not describe scores GREEN by construction.

### The fix

The cause arms are computed first and are orthogonal to the column
(`trident/delivery.ts:711-737`). Ordering is now: `true` → rate-limit advice
(it outranks the cause arms, which the reword test already pins); `null` →
cause advice PLUS "Whether a cross-model review was rate limited is unknown.";
`false` → cause advice alone.

FALSE AND UNKNOWN STILL DO NOT SHARE A BRANCH. Both decline the rate-limit
sentence — "I could not find out" is not a licence to assert a provider refusal —
but only `false` is an observation, so only `null` says so out loud. The fixture
was restored to the old-row shape, so those two pre-existing tests are now the
regression guard rather than its casualty, and
`trident/delivery.test.ts:697` pins the pair directly with a control that must
SURVIVE (the rebase sentence, present for both `null` and `false`) beside the thing
that must not (the admission, `null` only).

### Review-lane mutations

Applied with exact anchors asserted to occur exactly once. Suite:
`delivery.test.ts` + `__tests__/cross-model-rate-limited.test.ts` +
`inner-loop.test.ts`, baseline **188 pass / 0 fail**.

| # | Mutation | Landed line | Mutated | Restored |
|---|---|---|---|---|
| R1 | `null` arm returns bare generic (the defect above) | `trident/delivery.ts:734` | RED 185/3 | GREEN 188/0 |
| R2 | `=== true` → `!== false` (unknown read as rate-limited) | `trident/delivery.ts:727` | RED 180/8 | GREEN 188/0 |
| R3 | decoder accepts non-booleans (`?? null`) | `trident/inner-loop.ts:917` | RED 186/2 | GREEN 188/0 |
| R4 | producer returns `false` where it cannot observe | `trident/inner-workflow.mjs:6700` | RED 186/2 | GREEN 188/0 |
| R5 | a positive seat no longer wins (`true` → `null`) | `trident/inner-workflow.mjs:6698` | RED 186/2 | GREEN 188/0 |

R1 is the one the lane's table had no instrument for. R2 is the false/unknown
collapse in the consumer direction; R3–R5 re-run the lane's decoder and producer
claims independently, and all three reproduce.

### Wider re-run after rebase onto origin/main

`bun test trident/delivery.test.ts trident/__tests__/cross-model-rate-limited.test.ts
trident/inner-loop.test.ts trident/inner-workflow.test.ts trident/terminal-cause.test.ts
trident/lane-retry.test.ts trident/__tests__/synthesis-unavailable.test.ts`
— **466 pass / 0 fail**. `bunx tsc -p trident/tsconfig.json --noEmit` exit 0.
