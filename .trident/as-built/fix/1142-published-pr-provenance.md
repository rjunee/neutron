## 2026-09-17 — Bind publication provenance to the create receipt

### Change and evidence

Publication now obtains the PR number from successful `gh pr create` stdout, validates the URL and positive safe integer, and views that exact number before persisting it (`trident/production-host-effects.ts:384-396`). The view checks branch, base, repository relationship, and number (`trident/production-host-effects.ts:187-200`); publication additionally checks open state and reviewed head (:395). A branch lookup can no longer supply a new `published_pr` value. Existing provenance is preserved without rewriting it; a discovered foreign PR returns a refusal (:392-396).

The installed `gh pr create --help` states that success prints the created PR URL. This is the locally verified command contract, not a live creation capture: the lane is offline. The fixture now emits a URL plus newline (`trident/production-host-effects.test.ts:68`). Parsing its number and using the existing identity-checked view avoids inventing an unsupported JSON output flag. The parser accepts an HTTPS PR URL and fails closed on unexpected output (:388-390).

The durable column remains the migration at `migrations/0153_trident_published_pr_provenance.sql:1`. Dispatch carries existing provenance at `trident/board-dispatch.ts:1516-1519`; fresh admission checks it at `trident/build-run.ts:267-270`. The continuously enforced boundary is the publication writer (:396), backed by the database after process failure; it does not require the failed worker to cooperate. A crash between external creation and durable persistence still leaves uncertain ownership; this change does not infer ownership to bridge that gap.

### Outcome vocabulary and decisions

The refusal joins existing `GateResult` values `blocked` and `unknown` (`trident/production-host-effects.ts:19-20`). Foreign discovery returns `blocked/on`; malformed receipts return `unknown/detail`. The production adapter throws either refusal through `requireAllow` (:446-448), and the build runner converts host exceptions to `unknown` (`trident/build-run.ts:659-661`). Thus the direct publication gate refuses the foreign PR, while the enclosing build preserves uncertainty after external writes.

The selected durable-provenance reclaim behavior is unchanged; no product decision in SPEC.md or a spec item changed. Preserve the reviewed schema, migration expectations, dispatch carry, and retry admission. The explicit lane instruction determines this record's location and authorizes rewriting the two unmerged branch records.

### Mutation table

Each mutation was applied separately, its actual source line printed, its focused regression run RED, then the original restored and the same regression run GREEN.

| Guard or binding | Mutation and printed site | RED | Restored GREEN |
| --- | --- | --- | --- |
| Receipt supplies provenance | Replace receipt parse assignment with `(await readPr(current))?.number ?? null`, :389 | Receipt/lookup disagreement regression fails | 1 pass |
| Receipt selects witness | Replace keyed view with `readPr(current)`, :391 | Disagreement regression persists observed 73 instead of receipt 12 in `pr` | 1 pass |
| Foreign discovery refused | Replace ownership mismatch with `false`, :392 | Mid-push foreign PR returns allow | 1 pass |
| Existing ownership allowed | Invert ownership mismatch, :392 | Owned PR incorrectly refused | 1 pass |
| Receipt validation | Remove validation, :390 | All four malformed-receipt regressions fail on wrong refusal evidence | 4 pass |
| Valid receipt allowed | Replace validation condition with `true`, :390 | Successful publication refused | 1 pass |

Regression fixtures use differing nonempty PR numbers (12 and 73), not an empty observation (`trident/production-host-effects.test.ts:252-263`). The mid-push fixture installs a foreign PR while real git push executes (:240-249). Owned republication remains allowed without another create (:266-272). Malformed receipts have explicit refusal assertions (:275-282).

### Verification

Real `bun install` succeeded. `readlink -f node_modules/@neutronai/trident` resolved to the build worktree's package. Root `tsc --noEmit -p tsconfig.json` passed — but the root project does not include `trident/**/*.test.ts`, so that result was not sufficient. CI's `typecheck` job went red on `trident/production-host-effects.test.ts(243,15) TS2345`: the foreign-PR interceptor's arrow body had no `return`, inferring `void` where the fixture expects `HostCommandResult | Promise<HostCommandResult | undefined> | undefined`. Fixed with an explicit `return undefined`; `tsc -p trident/tsconfig.json` and `tsc -p open/tsconfig.json` both now exit 0. The combined consuming run passed 815 tests across 33 files, with 7,942 assertions: `bun test migrations/ trident/build-run.test.ts trident/board-dispatch.test.ts trident/production-host-effects.test.ts trident/store.test.ts trident/project-build-host.test.ts trident/stranded-salvage-realgit.test.ts trident/build-host.test.ts`.

Consumer selection used `rg -n 'production-host-effects|createProductionHostEffects' trident --glob '*.test.ts'`, plus the prior provenance consuming set and migrations. This enumerates direct test references, not every possible transitive consumer.

That enumeration was in fact incomplete, and the gap was real. Scoping the search to `trident/` missed `open/__tests__/project-build-e2e.test.ts`, whose fake `gh` returned `https://example.invalid/pull/<n>` — a host-plus-`pull` path with no owner/repo segments. Nothing parsed that stdout before this change, so its shape was unconstrained; requiring a receipt made all 15 end-to-end publication tests fail with `PR creation receipt is malformed`. Real `gh pr create` prints an owner/repo URL, so the fixture was the incorrect party and was corrected at `open/__tests__/project-build-e2e.test.ts:433`; the parser was not loosened. Re-running the consuming set including that file: 215 pass, 0 fail across 5 files. The initial new foreign-refusal test used the wrong field `detail`; corrected to the existing `on` vocabulary without relaxing the assertion.

### Record corrections and limits

The filed fresh-admission citation is now `trident/build-run.ts:269-270`; launch discovery remains `trident/launch-preparation.ts:201-204`. The earlier implementation record overstated what observation proved; its behavior and invariant sections have been rewritten. The previous migration-repair record at this path is superseded by this account of the complete publication correction; the reviewed migration repair remains in the branch.

Deliberately did not rebuild durable storage, change the schema snapshot, introduce flags, close PRs after failure, or alter dispatch. No full-suite run, live GitHub creation, hosted CI verification, network fetch, push, PR creation, or merge was performed. Only a local commit is delivered.

The standalone migration run passed 219 tests with 5,551 assertions. Lint passed. `git diff --check` passed. The correction file set was enumerated with `git diff --name-only`: the host implementation, its tests, and the two requested records. A whole-tree hidden-file search for the superseded phrases included `receipt boundary` as a positive control, found the corrected original record, and found only unrelated discovery wording in the walkthrough record; that unrelated test-registration statement stays.

The leak gate reported zero findings from executed rules, but the external PII denylist was unavailable for files and commit messages. Its result is INCOMPLETE, not clean. The orchestrator must supply that gate before publication.
