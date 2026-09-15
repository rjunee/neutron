## 2026-09-15 — Make the remote merge base limitation observable (partial)

### Completion boundary

This is a bounded partial delivery, not clearance for launcher cutover. It addresses
risk visibility in item 2 of HOSTFX2; it does not implement atomic remote base
protection or establish that every platform API lacks it. The task explicitly
permits a tested subset, requests this shard path, and requests updating the
foundation record; those instructions override the general shard-location and
immutable-record rules for this lane. The outstanding list is updated in
`host-effects.md`.

### Change and evidence

The production PR merge effect writes `build-remote-merge-attempt` before invoking
`gh pr merge`, including the PR, reviewed head, configured base branch, and
`basePrecondition: 'not-enforced'` (`trident/production-host-effects.ts:181`).
Its comment explicitly identifies the interval between readiness assessment and
remote merge as unprotected (`trident/production-host-effects.ts:175`). The head
pin remains in the command (`trident/production-host-effects.ts:192`).

Failure to persist the limitation returns `unknown` before the external write
(`trident/production-host-effects.ts:189`). The success fixture inspects the real
SQLite row at the instant the fake remote merge command is invoked
(`trident/production-host-effects.test.ts:200`); the failure fixture injects a
storage error after a successful publication and asserts the stopping outcome
(`trident/production-host-effects.test.ts:221`). Its command assertion includes
`create` as a positive control for the excluded `merge`
(`trident/production-host-effects.test.ts:235`). Git commands use temporary real
repositories; GitHub responses are simulated. No live server guarantee is tested.

### CLI evidence and decision

Read the installed `gh --version`: 2.97.0. Read the complete output of
`gh pr merge --help`. Its flag list contains:

```
--match-head-commit SHA   Commit SHA that the pull request head must match to allow merge
```

Searching that same help output with
`rg -n -- 'match-head-commit|match-base-commit|expected-base|base-commit'`
returns only the head-match entry at help line 23. This positive control supports
an absence claim about the installed command's documented flags only. Network
access was neither used nor worked around. Platform-wide API capability remains
unverified. The actual call uses that command at
`trident/production-host-effects.ts:191`.

Decision: preserve the existing head-pinned behavior and make its residual risk
explicit and durably observable, as the task allows. Do not invent an unsupported
base option or claim a preflight read is atomic. This changes neither a product
spec decision nor the launcher composition.

### Vocabulary and maintained property

The refusal joins `GateResult.unknown`; the void effect adapter throws for any
non-allow value (`trident/production-host-effects.ts:199`), and the driver's gate
classifier stops on unknown (`trident/build-run.ts:149`). The stage event joins
the store's ordinary timestamped metadata (`trident/store.ts:1042`), not a terminal
result or checkpoint. The heartbeat query selects two specific heartbeat names
and excludes this ordinary event (`trident/store.ts:1087`).

The host awaits the durable write on every remote merge attempt before invoking
the external command (`trident/production-host-effects.ts:180`). This ordering
requires no worker cooperation. A crash after the event leaves an attempt record,
not a successful merge claim. No mechanism continuously fixes the remote base;
that risk is deliberately stated in the event and comment.

### Mutation evidence

Both counted mutations passed `bunx tsc --noEmit -p trident/tsconfig.json` and
failed the named runtime test. The mutated source lines were printed. Both were
restored before the final green run. An initial typecheck exposed a test callback
returning void; it was fixed to return undefined without changing assertions,
and the first mutation was rerun and counted only after compilation passed.

| Property | Mutation printed | Runtime RED | Restored GREEN |
| --- | --- | --- | --- |
| Storage failure refuses | `trident/production-host-effects.ts:189`: replace unknown with `return { kind: 'allow' }` | `merge refuses when remote base-risk evidence cannot be persisted`: received allow, expected unknown | 73/73 bounded tests |
| Evidence precedes merge | `trident/production-host-effects.ts:181`: replace stage write with `await Promise.resolve(JSON.stringify({` | `merge pins reviewed head and requires independent merged witness`: zero event rows, expected one | 73/73 bounded tests |

### Validation

- `bun test trident/production-host-effects.test.ts trident/project-build-host.test.ts trident/build-host.test.ts`: 73 pass, 0 fail, 308 assertions.
- `bunx tsc --noEmit`: PASS.
- `bunx tsc --noEmit -p trident/tsconfig.json`: PASS.
- `bash scripts/ci/lint.sh`: PASS.
- `git diff --check`: PASS.
- `bash scripts/ci/leak-gate.sh --tree .`: INCOMPLETE (exit 3), zero findings
  in rules that ran; the PII file and message denylist rules could not run.

The test scope is enumerated by the three explicit file arguments above. No
whole-directory or whole-suite test run was used.

### Deliberately outstanding

- Atomic local merge remains unknown (`trident/production-host-effects.ts:172`).
- Remote base enforcement remains non-atomic; alternative API capability is
  unverified (`trident/production-host-effects.ts:175`).
- Resume/Ralph persistence and pending-worker reconciliation remain required by
  the mode interface (`trident/build-run.ts:61`).
- Full lifecycle persistence and terminal harvest remain outstanding: the
  production effects enumerate preparation, measurement, publication and merge
  (`trident/production-host-effects.ts:203`).
- Caller-side initialization and actual adapter resolution remain required inputs
  (`trident/project-build-host.ts:26`, `trident/project-build-host.ts:40`).

Scope control: `rg -n 'modes|effects' trident/project-build-host.ts` finds the
existing effects import/binding as its positive control, with no mode binding.
`rg -n 'inner_result|recordStageEvent' trident/production-host-effects.ts` finds
the attempt and preparation writes, with no terminal-result field write.
These are working-tree content claims, not remote-tree absence claims.
