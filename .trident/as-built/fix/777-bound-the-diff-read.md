## Issue 777 — bound the merge diff read

### What changed

`enforceMergeDiffGate` now asks Git to write the complete binary diff to a private temporary
file, then obtains the exact byte count from file metadata (`trident/merge.ts:194-225`). This
keeps the pathological payload out of the host runner's captured stdout while retaining the
existing strict greater-than refusal (`trident/merge.ts:242-244`). The temporary directory is
removed by a `finally` block, independently of whether Git or measurement succeeds
(`trident/merge.ts:226-230`).

The test host now models Git's output-file behavior (`trident/merge.test.ts:41-53`). The PR and
local tests independently pin exactly 1,048,576 bytes as allowed and 1,048,577 as refused
(`trident/merge.test.ts:75-148`). Command-shape assertions also require the output-file flag
while retaining the shielded three-dot range (`trident/merge.test.ts:167-195`).

### Decisions and outcome vocabulary

A disk-backed exact measurement was chosen because the shared runner materializes captured
stdout before returning. File metadata preserves byte-exact policy without expanding this issue
into the shared runner. The temporary file is initialized before Git runs, so existing injected
host doubles that model an empty successful diff remain faithful to that result.

This adds no outcome. It retains `TridentMergeDiffHold`: a measured oversize diff carries its
numeric byte count (`trident/merge.ts:242-244`), while any command, file, or metadata failure
carries `measured_bytes: null` (`trident/merge.ts:226-240`). The existing outcome switch routes
only numeric measurements to the size-specific terminal arm; null retains the merge-mechanics
default (`trident/orchestrator.ts:5377-5387`).

### Mutation table

| Direction | Mutation at `trident/merge.ts:247` during the run | Result |
|---|---|---|
| Exactly at limit merges | `>` changed to `>=` | RED: exact-limit PR test refused, 1 fail |
| One byte over refuses | limit changed to `Number.MAX_SAFE_INTEGER` | RED: over-limit PR test merged, 1 fail |
| Restored guard | `measured_bytes > MERGE_DIFF_BYTES_MAX` | GREEN: 104 merge tests and 42 range-guard tests |

Each mutation's landing line was printed before its targeted test ran.

### Verification

`bun test trident/merge.test.ts` — 104 pass, 0 fail.

`bun test trident/diff-base-option-shaped.test.ts` — 42 pass, 0 fail.

`bunx tsc -p trident/tsconfig.json --noEmit` — pass.

`bash scripts/ci/lint.sh` — pass.

### Deliberately not done

No approximate pre-check was added, because it could not own the literal byte boundary. No
shared runner or delivery code changed, and no alternate merge path or feature switch was
introduced. The exported pure string assessment remains unchanged
(`trident/merge.ts:181-185`); the production gate no longer supplies it a captured diff.
