## 2026-09-15 — Connect local production landing (partial)

### Positive result and completion boundary

The local-mode driver reaches `merged` through the real production effect in
`trident/production-host-effects.test.ts:414`. Git measurement, preparation,
landing and ancestry confirmation use a real temporary repository; worker results
and policy gates are scripted (`trident/production-host-effects.test.ts:431`).
This is evidence for the effect/driver connection, not an end-to-end certification
of every policy source. The direct effect test also checks the retained branch,
clean base checkout and matching file content
(`trident/production-host-effects.test.ts:249`).

Gap 1 is connected at `trident/production-host-effects.ts:171`. Gap 2 is deliberately
outstanding: resume/Ralph persistence, host-owned review counts, iteration
advancement and pending-worker reconciliation remain for the next lane. No
worker-count mutation is claimed. The driver still requires a mode host
(`trident/build-run.ts:169`). The composition's effects binding is at
`trident/project-build-host.ts:66`; the controlled content search
`rg -n 'modes|effects' trident/project-build-host.ts` finds the effects import and
binding at lines 6 and 66, and no modes binding. This is a working-tree content
observation, not a remote-ref claim.

### Implementation and decisions

- The new callable landing stays in the kept merge module
  (`trident/merge.ts:1665`) and calls `localMergeReadiness`
  (`trident/merge.ts:1679`). G109 branch, worktree identity, preservation and drift
  checks remain in their existing implementation (`trident/merge.ts:1642`).
- The retained executor rebases (`trident/merge.ts:2216`) and deletes its branch
  (`trident/merge.ts:2308`), while the new driver's
  post-merge contract requires the original head (`trident/build-run.ts:390`).
  Calling that executor would violate this contract. The additive callable builds
  a merge tree and commit with immutable base/head parents instead
  (`trident/merge.ts:1681`). It does not copy the drift implementation.
- The base is pinned before readiness (`trident/merge.ts:1678`). A filesystem-local
  push uses an explicit expected-base lease and a receiver configured with
  `receive.denyCurrentBranch=updateInstead` (`trident/merge.ts:1685`). The receiver
  coordinates the ref update with checked-out base safety. The dirty-base and
  concurrent-base tests exercise those refusals
  (`trident/production-host-effects.test.ts:388`). The lease, maintained by git,
  does not depend on a worker still running. The process-local merge lock is reused
  (`trident/merge.ts:1671`); it is not the cross-process base pin.
- Command failures and timeouts remain unknown (`trident/merge.ts:1675`,
  `trident/merge.ts:1690`). The outcome joins existing `GateResult`
  (`trident/build-run.ts:29`). Its non-allow result throws through the production
  void adapter (`trident/production-host-effects.ts:198`); the driver maps that
  exception to nonterminal unknown (`trident/build-run.ts:397`). No new terminal
  cause or permissive fallback is introduced.
- No crash-recovery or terminal-harvest guarantee is added. A host interruption
  after the write still requires reconciliation, as does any external effect.
  The receiver may leave unreachable merge objects on a refused write; it does
  not rewrite the reviewed branch (`trident/merge.ts:1681`).

### Mutation evidence

Each counted mutation was printed at the actual changed line, passed
`bunx tsc --noEmit -p trident/tsconfig.json`, failed its runtime test, and was
restored before the same test passed. Cases are explicitly enumerated below.

| Guard | Compiling mutation | Runtime RED | Restored |
| --- | --- | --- | --- |
| G109 result, `trident/merge.ts:1680` | `if (false) { result = ready; return }` | `local effect refuses dirty-worktree` and `local effect refuses overlap` | GREEN |
| Expected base, `trident/merge.ts:1687` | Replace explicit lease with `--force` | `local effect refuses base-race` | GREEN |
| Checked-out base, `trident/merge.ts:1686` | Change receiver policy from `updateInstead` to `ignore` | `local effect refuses dirty-base` | GREEN |
| Timeout, `trident/merge.ts:1675` | Keep only `if (!value.ok)` | `local effect refuses push-timeout` | GREEN |
| Command outcome, `trident/merge.ts:1675` | Replace condition with `false` | `local effect refuses push-failure` | GREEN |
| Local connection, `trident/production-host-effects.ts:171` | Restore the previous disconnected `unknown` return | `local-mode driver reaches merged through the real production effect` | GREEN |

The overlap fixture changes separated lines of the same file
(`trident/production-host-effects.test.ts:396`), so git can merge silently when
readiness is bypassed. It tests G109's unreviewed-interaction risk rather than
letting a content conflict hide a bypass. The base-race fixture moves the base
at the push boundary (`trident/production-host-effects.test.ts:400`).

An exploratory mutation removing a second base observation stayed GREEN: its
fixture reached the receiver, which independently refused the old-base lease.
That proposed redundant observation was removed from the implementation; the
unchanged during-assessment test remains (`trident/production-host-effects.test.ts:446`).
An initial mutation attempt stopped at typecheck errors in the new driver fixture;
those fixture errors were corrected before counting any mutation. No assertion
was relaxed to obtain GREEN.

### Validation

- `bun test trident/production-host-effects.test.ts trident/project-build-host.test.ts trident/build-host.test.ts trident/merge.test.ts`: 186 pass, 0 fail, 686 assertions.
- `bunx tsc --noEmit`: PASS.
- `bunx tsc --noEmit -p trident/tsconfig.json`: PASS on the restored source.
- `rg -n '"typecheck"|"test:bun"' package.json` finds the existing test script at
  `package.json:61` as a positive control, with no typecheck alias. The existing
  compiler commands were used.
- The six mutations above each compiled and produced runtime RED, followed
  by restored GREEN.
- `bash scripts/ci/lint.sh`: PASS.
- `git diff --check`: PASS.
- `bash scripts/ci/leak-gate.sh --tree .`: INCOMPLETE (exit 3), zero findings in
  the rules that ran. The file and message PII denylist rules could not run.
  This is not a clean leak verdict.

Test scope is enumerated by the four explicit file arguments above, including the
retained G109 merge tests. No whole-directory or whole-suite sweep ran.

### Documentation and deliberate omissions

The shared outstanding list in `host-effects.md` now marks local landing connected
and keeps the mode-host gap visible. The controlled search
`rg -n --hidden -g '!.git' 'Atomic local merge|mergeLocalReviewed' .`
finds the new call as a positive control. The old foundation mutation table and
`host-effects-2.md:97` keep their historical local-merge statements because they
record earlier deliveries; the shared record now explicitly labels that history.

No product decision changed. No launcher swap, mode persistence, remote atomic-base
claim, lifecycle persistence or terminal-result harvest is included. The task's
explicit additive scope, local-commit-only delivery and requested shard paths
apply to this lane. The orchestrator owns publishing and review.
