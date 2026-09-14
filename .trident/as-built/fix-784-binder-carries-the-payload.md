## 2026-09-14 — `/code stop` preserves terminal board payload

### What changed

The terminal reconcile contract carries PR provenance and governed-loop allowance data in its fourth argument (`trident/board-reconcile.ts:49-61`) and constructs all five payload fields from the terminal run (`trident/board-reconcile.ts:106-128`). The `/code` production binder now has that same contract (`trident/board-dispatch.ts:290-301`) and forwards the complete argument to the canonical board store (`open/composer.ts:568-579`). `/code stop` narrows the optional member and hands a structurally checked reconciler to the observer without an arity-erasing cast (`trident/code-command.ts:310-314`).

The production binder is a named constructor used by composition (`open/composer.ts:2127-2129`), which lets the regression test exercise that exact boundary with real `TridentRunStore` and `WorkBoardStore` instances (`open/__tests__/open-code-stop-board-binder.test.ts:28-61`). The store consumes PR fields and governed-loop fields in the same terminal update (`work-board/store.ts:1372-1384`).

### Decisions

The four-argument signature is the model, not the defect. The tick-loop observer owns outcome derivation, PR URL resolution, and allowance carry (`trident/board-reconcile.ts:106-128`); the board store already persists those values atomically with terminal status (`work-board/store.ts:1372-1389`). Keeping a three-argument boundary would discard state that both sides explicitly model.

No new outcome was introduced. A stopped run continues through the existing terminal reconcile vocabulary and defaults to `failed` unless the escalation deriver classifies it as `blocked` (`trident/board-reconcile.ts:90-107`).

The continuously maintained invariant is type alignment at the binder boundary: `TridentBoardBinder.detachRun` now declares the same payload shape the terminal observer calls (`trident/board-dispatch.ts:290-301`), and `/code stop` constructs a typed reconciler without a cast (`trident/code-command.ts:310-314`). The behavior test independently guards runtime forwarding (`open/__tests__/open-code-stop-board-binder.test.ts:28-61`).

### Mutation table

| Guard | Mutation | Red result | Restored result |
|---|---|---|---|
| `open/composer.ts:577` forwards `pr_info` | Removed the fourth argument from the store call; the landed mutant line was printed as `await resolve()?.detachRun?.(slug, run_id, outcome)` | `open/__tests__/open-code-stop-board-binder.test.ts:58` received `null` instead of PR `784`; 0 pass, 1 fail | Same file: 1 pass, 0 fail, 6 assertions |

### Verification

`bun test open/__tests__/open-code-stop-board-binder.test.ts trident/code-command.test.ts`: 28 pass, 0 fail, 82 assertions. `bunx tsc -p trident/tsconfig.json --noEmit` and `bunx tsc -p open/tsconfig.json --noEmit`: green. `bash scripts/ci/lint.sh`: all checks green.

The root package has no `typecheck` script (`package.json:47-62`); the repository's complete checker is the package matrix described by `scripts/ci/typecheck-all.sh:1-10`, so the two affected package configurations were checked directly.

### Deliberately not changed

The optional presence probe remains because board-light test and boot seams may omit reconciliation (`trident/board-dispatch.ts:283-290`); only its unsafe cast was removed. No feature flag or alternate runtime path was added. `SPEC.md` was not changed because this repair restores the already-modelled terminal payload rather than changing product behavior (`trident/board-reconcile.ts:18-30`). The full test suite was not run, per the lane instruction; only touched tests and affected static gates were run.
