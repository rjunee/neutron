## 2026-09-14 — One vocabulary for Codex authentication scrubbing

### What changed

`config/codex-cli-auth-env-vars.txt:1-5` now owns the credential-environment vocabulary once. The Codex adapter reads that file at `runtime/adapters/codex-cli/auth.ts:38-43`, the review wrapper iterates it at `trident/codex-review.sh:266-268`, and the build wrapper iterates it at `trident/codex-build.sh:879-881`. The maintained invariant is therefore structural: all three consumers read one file, while `runtime/adapters/codex-cli/auth.test.ts:15-29` refuses known-wrapper drift and scans every Trident shell script for a newly hand-maintained OpenAI unset list.

The two shell consumers now refuse before invoking Codex when that vocabulary is unreadable. The review guard emits `CODEX_REVIEW_AUTH_ENV_VARS_UNREADABLE` and exits 3 at `trident/codex-review.sh:262-265`; the build guard emits its corresponding marker and exits 3 at `trident/codex-build.sh:875-878`. This makes the billing invariant continuous without depending on Codex behaving safely: either the vocabulary is read and every listed variable is unset, or no Codex child starts.

The vocabulary is the required four-name union plus `CODEX_ACCESS_TOKEN`. I enumerated repository names with `rg -o --no-filename 'OPENAI_[A-Z0-9_]+' . --glob '!node_modules/**' --glob '!.git/**' | sort -u`; it found the four credential-shaped names and unrelated model, provider, embedding, storage, and test identifiers. I separately searched the Codex surfaces for credential inputs with `rg -n 'CODEX_ACCESS_TOKEN|OPENAI_API_KEY|OPENAI_AUTH_TOKEN|OPENAI_API_TOKEN|OPENAI_KEY'`; the repository's measured CLI investigation identifies `CODEX_ACCESS_TOKEN` as a real channel at `docs/spec-items/codex-work-runs-headless-per-call-on-a-reused-thread.md:125`, so it is scrubbed too.

The adapter retains both halves of its deletion protocol. The scaffold places every vocabulary key in `spawn_env` with an `undefined` value at `runtime/adapters/codex-cli/auth.ts:73-84`; after copying string-valued parent entries, the spawn merger interprets those values by deleting the copied keys at `runtime/adapters/codex-cli/exec.ts:82-91`. Removing either half would leave no deletion instruction or would pass an inherited value onward.

The governing spec item now describes the resolved shared vocabulary at `docs/spec-items/codex-work-runs-headless-per-call-on-a-reused-thread.md:77-81` and includes all five scrubbed inputs at `docs/spec-items/codex-work-runs-headless-per-call-on-a-reused-thread.md:100-109`.

### Decisions

I chose a plain newline-delimited file over a TypeScript export or generated copies. Bash can consume it using builtins without requiring Bun during early not-connected checks, TypeScript can load it directly, and no generated artifact can become a second owner. The wrappers intentionally retain their small iteration loops; those are behavior, not duplicate vocabulary.

For the unreadable-file case I chose fail-closed refusal rather than keeping a duplicate inline runtime floor. Fail-closed preserves one source of truth and makes a missing deployment artifact loud. I rejected the inline alternative because it makes production correctness depend on a drift test having run and passed before deployment.

The drift test is scoped honestly. It catches changes to either known wrapper that stop naming the shared file, a direct `unset OPENAI_...` introduced in any Trident shell script, a change to the adapter-visible vocabulary, and removal of a required name. It does not detect an independently implemented scrub outside Trident shell scripts or a differently spelled dynamic shell construction; review remains responsible for those shapes.

The new refusal joins the existing exit-code taxonomy as `exit 3`, DEFERRED. The review bridge maps 3/5 to `codexStatus='deferred'`, returns `REQUEST_CHANGES`, and forbids approval at `trident/inner-workflow.mjs:7202-7207`. The build launch and wait consumers both map ordinary exit 3/5 outcomes to deferred at `trident/inner-workflow.mjs:2250-2263` and `trident/inner-workflow.mjs:2313-2325`. The default is therefore fail-closed rather than the Claude-only fallback reserved for NOT_CONNECTED exit 10/11.

### Tests and mutation evidence

Each behavioral case seeds all five credential variables in the parent and asserts their absence in the actual child environment; the unscreened `CODEX_SCRUB_CONTROL` surviving proves the fixture reached the child (`trident/codex-review.test.ts:193-211`, `trident/codex-build.test.ts:2298-2319`, `runtime/adapters/codex-cli/__tests__/env-overlay-unset-unused.test.ts:186-215`).

| Guard | Mutation | RED | Restored GREEN |
|---|---|---|---|
| Shared vocabulary consumed by all three sites | Removed line 2, `OPENAI_KEY`, from `config/codex-cli-auth-env-vars.txt`; `nl -ba` printed the resulting lines 1-3 before the run | Four failures: review child leak, build child leak, adapter spawn leak, and exact required-vocabulary mismatch | 164 passed, 0 failed across the four touched test files |
| Vocabulary must be readable before either shell wrapper starts Codex | Removed the new readability guard from both wrappers; `nl -ba` showed each loop immediately following the file assignment at review lines 261-264 and build lines 874-877 | Both absent-vocabulary cases ran the child and returned 0 instead of 3 | Both cases passed after restoration; the full wrapper files passed 154/154 |

Final local gates: the same four test files passed 166/166; `scripts/ci/typecheck-all.sh` passed all 51 TypeScript projects; `scripts/ci/lint.sh` passed every reported lint guard.

### Deliberately not changed

The API-key resolver still deliberately selects a caller-supplied `OPENAI_API_KEY` at `runtime/adapters/codex-cli/auth.ts:101-110`; this change only prevents ambient credentials from reaching subscription-OAuth children. The spawn merger still copies the parent environment rather than adopting a general allowlist at `runtime/adapters/codex-cli/exec.ts:82-91`, because broad child-environment policy is outside this issue. Historical as-built records describing the pre-fix discrepancy remain historical records; only the present-tense spec item was corrected.
