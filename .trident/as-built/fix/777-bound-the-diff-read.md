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

### Review round 1 — the gate was satisfiable without measuring anything

`enforceMergeDiffGate` stopped reading the command's stdout, so the patch file
became the ONLY evidence the gate has. It was pre-created empty
(`writeFileSync(diff_path, '')`) and then `stat`-ed, which made two different
facts into one state: "the diff is empty" and "nothing wrote a patch". That state
was ALLOW.

Measured, not reasoned: the #618 vocabulary test failed in CI with `Expected:
"failed" / Received: "done"` — a 1,048,577-byte diff **merged**. Its fake host
answered the diff on stdout and never honoured `--output=`, so the gate measured
zero bytes and let through exactly the diff it exists to refuse.

Fixed by failing closed: the file is no longer pre-created, and `!result.ok ||
!existsSync(diff_path)` is a MEASUREMENT FAILURE — the `measured_bytes: null`
refusal — never a zero. This costs a real merge nothing: `git diff --output=`
always creates the file on success, and the file's size equals the stdout byte
count exactly (measured on a scratch repo: 89 == 89), so the byte-exact boundary
is unchanged. `assessMergeDiff` allowed `<= MAX`; this refuses `> MAX`; the
at-limit and limit+1 cases stay pinned with their measured sizes.

The two refusals stay distinct and only one advises a retry: "could not be
measured … refusing to merge without the size gate" carries `null`, and
`orchestrator.ts:5381` still routes on `measured_bytes !== null`.

The fakes now model the command that is actually run. One wrapper in each suite —
`buildMergeCleanupDeps` in `merge.test.ts`, `writingHost` in the orchestrator
harness — honours `--output=`, so seventy-odd scenarios that never meant to touch
the size gate keep measuring what they mean to, while a host that writes no patch
still holds. The unwritten-file case is pinned directly, built through the REAL
deps so the wrapper cannot mask it.

Mutations re-run by the reviewer, each RED then GREEN on restore: the boundary
(`merge.ts:250`, `> MAX` → `> MAX + 1`), the fail-closed check (`:232`, missing
file measured as zero) and the false/unknown distinction (`:245`, the unmeasured
refusal rewritten as a measured zero). 406 tests pass across `merge.test.ts` and
`orchestrator.test.ts`; the rev-range guard (`diff-base-option-shaped`) is green,
so `--output=` as a FLAG through `gitRangeArgv` does not trip it.

### Review round 2 — the obligation the fail-closed gate creates

Making the gate fail closed moved its evidence off the `run_host` seam: the
command's return value no longer carries the thing being measured, so any fake
host that answers on stdout and ignores `--output=` writes no patch file, and the
gate correctly HOLDS. That is right, and it is also a new obligation on a widely
used test seam. Filed as its own issue rather than left to be rediscovered.

**Ten suites needed the wrapper**, and the enumeration is the point:

| suite | how it reaches the gate |
|---|---|
| `trident/merge.test.ts` | directly — it IS the gate's suite |
| `trident/orchestrator.test.ts` | the harness's `run_host` |
| `trident/arbiter-wiring.test.ts` | merge-conflict arbitration; never mentions the gate |
| `gateway/composition/build-core-modules-trident-arbiter-wiring.test.ts` | the composed orchestrator |
| `trident/ralph.test.ts` | the orchestrator; mentions no merge symbol at all |
| `trident/ported-fixes.test.ts` (3 sites) | same, via a copied `driftFreeHost` |
| `trident/restart-resume.test.ts` (2 sites) | same |
| `trident/code-command.test.ts` | same |
| `trident/board-reconcile.test.ts` | the tick loop driving a build to done |
| `trident/merge-realgit.test.ts` | **needed nothing** — it drives real git |

`ralph.test.ts` is the one that matters. Grepping the gate's own symbols
(`buildMergeCleanupDeps`, `cleanupAfterMerge`) does NOT enumerate its callers — it
missed four suites. The complete set came from running the whole `trident/` +
`gateway/composition/` surface and bisecting the single red test against a
reverted `trident/merge.ts`. Four of the suites share a copy-pasted `driftFreeHost`
fixture, so the same omission existed in four places and a fifth copy would have
inherited it.

`trident/testing/diff-output-host.ts` (`honourDiffOutput`) is the one wrapper they
all now use, so the next author imports it instead of re-deriving it — and the
`merge-realgit` row is the tell that the real command needs no help.

`git diff --output=` behaviour, measured rather than assumed: the file it writes
carries exactly the bytes stdout would have (89 == 89), and git creates the file
even when the command FAILS (exit 128 leaves a 0-byte file) — which is why
`result.ok` alone was never evidence that a patch was produced.
