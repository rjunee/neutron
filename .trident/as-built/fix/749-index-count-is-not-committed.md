## Issue 749 — stop committing queue cardinalities

### What changed

The renderer no longer emits the whole-queue summary. The design decision is recorded beside the renderer at `scripts/spec-items-index.ts:13-16`, and the rendered index now proceeds from its stable introduction directly to per-item sections at `scripts/spec-items-index.ts:258-262`. The committed artifact reflects that output at `docs/spec-items/README.md:11-15`.

The exact drift check remains unchanged at `scripts/__tests__/spec-items-index.test.ts:33-37`, so an item added without rendering is still refused. A new focused check at `scripts/__tests__/spec-items-index.test.ts:52-63` prevents the whole-queue count from returning while proving both fixture rows remain rendered.

The implementation-file list was enumerated with `git diff --name-only origin/main` before this record was added: `docs/spec-items/README.md`, `scripts/__tests__/spec-items-index.test.ts`, and `scripts/spec-items-index.ts`.

### Decision and invariant

Option 1 was selected because removing the aggregate value removes the shared whole-tree fact from every item-adding diff. Keeping it while weakening the exact comparison would permit a stale artifact, and regenerating after merge would add a write to the merge path. The continuous maintainer is the exact renderer comparison at `scripts/__tests__/spec-items-index.test.ts:33-37`; it computes from the directory and does not depend on the item author performing a separate check.

No new error, verdict, state, or refusal was introduced, so there is no outcome vocabulary to extend. The existing test failure remains Bun's ordinary failed-expectation outcome at `scripts/__tests__/spec-items-index.test.ts:36`.

### Evidence

The absence search used one alternation over all three implementation files: `rg -n '\*\*[0-9]+ items\.\*\*|# Spec items' ...`. Its positive controls found the known heading at `scripts/spec-items-index.ts:252` and `docs/spec-items/README.md:5`; the only count-shaped hit was the negative assertion at `scripts/__tests__/spec-items-index.test.ts:60`, with none in the renderer or artifact.

Two disposable branches were created from the fix commit. One added and rendered an item in the `trident` group; the other did the same in `security`. Merging A then B produced merge commit `fbd2bd0f` with no intervening repair commit and the focused file passed 38/38. Merging B then A produced `c1436fe5` under the same conditions and passed 38/38. Different existing groups isolate the aggregate-line defect described by the issue; placing both additions in one table row hunk produces a separate textual conflict and was deliberately not presented as evidence for this fix.

An actual temporary item, `docs/spec-items/acceptance-unrendered.md:1-9`, was added without regenerating. The exact comparison failed at `scripts/__tests__/spec-items-index.test.ts:36`; the temporary file was then removed.

### Mutation table

| Guard | Mutation and landed line | Red | Restored green |
|---|---|---|---|
| No committed whole-queue count, `scripts/__tests__/spec-items-index.test.ts:55-63` | Restored ``out.push(`**${items.length} items.**`)`` at `scripts/spec-items-index.ts:262` | Focused test failed at `scripts/__tests__/spec-items-index.test.ts:60` | Focused test passed, 1/1 |
| Every item is rendered, `scripts/__tests__/spec-items-index.test.ts:33-50` | Added an unrendered item at `docs/spec-items/acceptance-unrendered.md:1-9` | Exact comparison failed at `scripts/__tests__/spec-items-index.test.ts:36` | Full focused file passed, 38/38, after removal |

### Validation

- `bash scripts/ci/typecheck-all.sh`: 51 configurations checked, all pass.
- `bash scripts/ci/lint.sh`: all reported gates pass.
- `bun test scripts/__tests__/spec-items-index.test.ts`: 38 pass, 0 fail.

### Deliberately not changed

The committed per-item index, exact byte comparison, frontmatter validation, blocker filtering, needs-spec section, grouping, ordering, and table rendering remain in place at `scripts/spec-items-index.ts:245-296`. No post-merge writer, tolerance for stale output, feature flag, alternate renderer, or spec decision was added.
