## 2026-09-14 — Detached-wrapper test waits for completion state

### What changed

The detached-wrapper regression case now polls for the marker file that the child publishes, bounded by a 3-second failure deadline (`trident/__tests__/cross-model-dispatch.test.ts:857-877`). The success path therefore waits for the observable completion state instead of assuming that 400 ms of elapsed time is enough.

### Cause and evidence

The cause was inferred, not benchmarked. The fixture deliberately leaves the foreground caller after 50 ms while its detached child waits 250 ms before writing `done` (`trident/__tests__/cross-model-dispatch.test.ts:861-867`). The former fixed 400 ms sleep left only 150 ms between the earliest possible marker write and the read. The marker is directly observable through `existsSync`, already imported by this test file (`trident/__tests__/cross-model-dispatch.test.ts:25`), and its content remains asserted after arrival (`trident/__tests__/cross-model-dispatch.test.ts:874-877`).

### Decisions

The deadline is a failure bound, not a success delay: the loop exits as soon as the marker appears (`trident/__tests__/cross-model-dispatch.test.ts:874-876`). The explicit existence assertion names a deadline failure before `readFileSync` checks the payload (`trident/__tests__/cross-model-dispatch.test.ts:876-877`). No product outcome or runtime behavior changed, so there is no new outcome value to classify and no `SPEC.md` decision to update.

THE DEADLINE MUST BE SHORTER THAN THE RUNNER'S OWN TIMEOUT, and the first cut of this change was not (review finding). It bounded the poll at 10 s while bun's default per-test timeout is 5 s, so the deadline could never expire: with the child mutated to never write the marker, the case died as `this test timed out after 5000ms` and the named assertion at `trident/__tests__/cross-model-dispatch.test.ts:876` never ran. A de-flaked wait whose failure assertion is unreachable reports the runner, not the code. The bound is now 3 s — 12x the fixture's 250 ms child delay, and 2 s inside the runner's budget — so a real failure fails at that line, by name (`trident/__tests__/cross-model-dispatch.test.ts:869-874`).

### Mutation proof and verification

| Guard | Mutation (landing line printed and diffed first) | Broken result | Restored result |
|---|---|---|---|
| Poll while the marker is absent (`trident/__tests__/cross-model-dispatch.test.ts:875`) | Inverted the polling predicate, `!existsSync(marker)` to `existsSync(marker)` | Named test RED at line 876: expected `true`, received `false` | Full touched file GREEN: 63 pass, 0 fail |
| The wait is a real instrument, not a vacuous one (`trident/__tests__/cross-model-dispatch.test.ts:869-876`) | Child never writes the marker: `printf done > "$1"` to `true "$1"` at `trident/__tests__/cross-model-dispatch.test.ts:866` | Named test RED at line 876 after 3.06 s: expected `true`, received `false`. Against the first cut's 10 s deadline the SAME mutation produced only `this test timed out after 5000ms`, which is what the 3 s bound fixes | Full touched file GREEN: 63 pass, 0 fail |
| The marker's payload is still asserted (`trident/__tests__/cross-model-dispatch.test.ts:877`) | Child writes an empty marker: `printf done > "$1"` to `: > "$1"` | Named test RED at line 877: expected `"done"`, received `""` | Full touched file GREEN: 63 pass, 0 fail |

`bash scripts/ci/lint.sh` passed, including the wall-clock-bound gate — that gate flags an `expect(...)` over a real elapsed delta, and explicitly exempts `while (Date.now() - start < …)` polling loops, which is the shape this change adopts (`scripts/ci/wall-clock-bound-check.mjs:42-46`). `bash scripts/ci/typecheck-all.sh` passed all 51 discovered TypeScript configurations. `bun test trident/__tests__/cross-model-dispatch.test.ts` passed 63 tests with 356 assertions.

### Deliberately not changed

The 250 ms detached-child delay and 50 ms foreground timeout remain, because they create the ordering the regression case exercises (`trident/__tests__/cross-model-dispatch.test.ts:861-867`). The deadline was not used to relax a runtime tolerance, and production dispatch code was not changed. No feature flag, alternate path, or specification change was introduced.

THE FIXTURE STILL DOES NOT DISCRIMINATE `nohup` + backgrounding, and that is pre-existing and out of scope here. Deleting `nohup … & wait` from `trident/__tests__/cross-model-dispatch.test.ts:866` leaves the case GREEN on this branch AND on `main`, because `spawnSync`'s timeout signals only its direct child and the grandchild survives regardless. The shell preamble is therefore illustrative; what this case actually pins is the generated production command's contents (`trident/__tests__/cross-model-dispatch.test.ts:879-884`). Fixing the reproduction is a separate change, filed as issue #771 rather than folded into a flake fix.
