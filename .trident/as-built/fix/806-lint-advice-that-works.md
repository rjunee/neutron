## 2026-09-14 — Cross-workspace lint advice now resolves

### What changed

The cross-workspace report filter now recognizes the upstream rule's root meta-package suggestion and replaces it with two working remedies: keep importer-owned support inside the importing workspace and use a local relative import, or move genuinely shared support into a workspace package and import it through `@neutronai/<workspace>/<path>` (`scripts/ci/lint-filter.mjs:14-26`). Other outcomes in the existing `GATED_RULES` vocabulary retain their original message by default (`scripts/ci/lint-filter.mjs:12,23-26`).

The focused test protects both the diagnostic and the underlying boundary: it rejects the root-package suggestion (`scripts/ci/lint-filter.test.ts:14-35`), observes a real trident-to-logger relative import as a violation (`scripts/ci/lint-filter.test.ts:37-53`), and observes a trident-local relative import as legitimate (`scripts/ci/lint-filter.test.ts:55-64`). This test continuously maintains the useful-advice invariant without depending on a person following the broken suggestion.

### Scope decision

The rule resolves each import and compares package roots; it is not a ban on every relative path that leaves a directory (`eslint.config.mjs:11-19,111-120`). The `tests/support/migrated-db.ts` imports are correctly unflagged: root test support is intentionally outside the workspace graph, and the path is an explicit exception (`eslint.config.mjs:94-105,114-116`). I therefore changed no exemption and did not narrow the gate.

The two remedies were verified as already-applied executable forms, not inferred from configuration: trident suites use the workspace-local helper at `trident/merge.test.ts:20`, `trident/ported-fixes.test.ts:37`, and `trident/ralph.test.ts:27`; the gateway suite uses the workspace-package form at `gateway/composition/build-core-modules-trident-arbiter-wiring.test.ts:38`. Both `bunx tsc -p trident/tsconfig.json --noEmit` and `bunx tsc -p gateway/tsconfig.json --noEmit` passed, as did the three affected suites with 132 passes and zero failures.

### Mutation evidence

| Guard | Mutation and landed line | Red result | Restored result |
|---|---|---|---|
| Root-package advice rewrite | Changed the matcher to `neutron-disabled` at `scripts/ci/lint-filter.mjs:14`; printed that line before running | Advice test failed because the broken suggestion remained | 2 pass, 0 fail |
| Cross-workspace rejection | Replaced the logger import with `./local.ts` at `scripts/ci/lint-filter.test.ts:43`; printed that line before running | Expected violation was absent | 2 pass, 0 fail |
| Local-import acceptance | Replaced `./local.ts` with the logger import at `scripts/ci/lint-filter.test.ts:55`; printed that line before running | Unexpected violation was present | 2 pass, 0 fail |

Final verification also passed `bash scripts/ci/lint.sh` and `git diff --check`. A whole-suite run was deliberately omitted because the task requires the touched and affected suites rather than the repository's long sharded suite. No product decision changed, so `SPEC.md` was not edited.
