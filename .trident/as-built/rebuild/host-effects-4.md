## 2026-09-15 — Persist production mode state and resume budgets

### Positive case and delivery boundary

PASS: a reconstructed production host reloads a rejected round 3, dispatches
`fix:3`, then `review:4`, and retains the spent re-plan despite a worker trailer
claiming zero counters (`trident/production-host-effects.test.ts:498`). The test
uses a real temporary git repository and project database; policy decisions and
worker responses are scripted. It deliberately stops at the publication gate.
A crash after the durable fix reloads `fixed`, round 4, and one spent re-plan
(`trident/production-host-effects.test.ts:558`). Ralph reaches `continued` through
the driver and reloads iteration 1 (`trident/production-host-effects.test.ts:709`).

The production mode host is connected at `trident/project-build-host.ts:69` and
forwarded by `trident/build-host.ts:74`. This delivers mode persistence and the
worker identity needed for reconciliation. It does **not** certify the launcher
cutover: pending-result reconciliation and the prior lifecycle/harvest integration
remain outstanding. The driver preserves pending uncertainty without redispatch
(`trident/build-run.ts:173`). The shared outstanding list records that boundary.

### Implementation and decisions

- The required persistence method belongs to `BuildModeHost`
  (`trident/build-run.ts:64`). The driver constructs state from its own counters
  (`trident/build-run.ts:238`), persists pending identity before preparation and
  dispatch (`trident/build-run.ts:250`), and records build/fix completion,
  approval, re-plan spend, and rejection (`trident/build-run.ts:270`,
  `trident/build-run.ts:339`, `trident/build-run.ts:348`,
  `trident/build-run.ts:355`). These are the explicitly enumerated write sites.
  Pure driver fixtures supply an explicit no-op storage mock
  (`trident/build-run.test.ts:298`); the production composition always supplies
  storage. The controlled search
  `rg -n 'checkpoint\(|outcome.result.payload' trident/build-run.ts` enumerates
  these calls and finds payload reads at `trident/build-run.ts:274` as positive
  control; no checkpoint patch there reads the worker payload.
- SQLite appends the checkpoint only if the latest host-state event still has
  the expected id and the run remains active (`trident/store.ts:1047`). It returns
  the inserted id inside the transaction (`trident/store.ts:1054`), avoiding a
  second reader accidentally adopting a competing writer's version. The existing
  terminal vocabulary is `done`, `failed`, `stopped` (`trident/store.ts:606`).
  The transaction style was checked against the existing write-claim exemplar
  (`trident/store.ts:1554`); the new SQL refusal has its own runtime mutation.
- Database durability and the conditional append continuously maintain the
  checkpoint after the worker or host dies; neither relies on that worker
  remaining responsive. The saved run, project, repository, worktree, branch,
  base, and merge mode are checked on reload
  (`trident/production-host-effects.ts:118`,
  `trident/production-host-effects.ts:137`). A stale append throws
  (`trident/production-host-effects.ts:138`).
- A checkpoint retains stage, round, re-plan spend, findings, prior findings,
  blocking count, and pending phase/step (`trident/build-run.ts:49`). Together with
  its stored run id, the step matches the existing worker-handle identity
  (`runtime/bounded-work.ts:120`). A process killed between pending persistence
  and actual dispatch also remains unknown; this deliberately avoids guessing
  that another launch is safe.
- Ralph consumes the completed checkpoint and increments its iteration in one
  event (`trident/production-host-effects.ts:194`). Replay of the same run/round
  and head is idempotent (`trident/production-host-effects.ts:191`). Completion
  and the observed head must match before advancement
  (`trident/production-host-effects.ts:185`,
  `trident/production-host-effects.ts:192`). This is an atomic database handoff
  after a git observation, not a cross-resource git/SQLite transaction.
  Composition obtains the iteration from host storage
  (`trident/project-build-host.ts:77`).
- The full committed OID pins diff regeneration
  (`trident/production-host-effects.ts:154`). Plan probing uses file output,
  refuses links, and verifies extracted bytes against the committed blob before
  reporting their digest and unchecked count
  (`trident/production-host-effects.ts:165`,
  `trident/production-host-effects.ts:170`,
  `trident/production-host-effects.ts:176`). Archive attributes that transform
  bytes stop the probe; they cannot silently change the committed plan supplied
  to the driver (`trident/production-host-effects.test.ts:732`).
- G038 remains two outcomes: confirmed absence or movement rebuilds; unreadable
  required evidence stops. A failed head command needs an independent exit-1
  absence observation (`trident/production-host-effects.ts:54`). Production
  measurement uncertainty returns unknown (`trident/production-host-effects.ts:106`);
  the existing driver's malformed-head outcome stays `resume-head-unreadable`
  (`trident/build-run.ts:198`). The production test covers moved, missing, and
  unreadable heads (`trident/production-host-effects.test.ts:574`).
- Errors join existing `GateResult` / `BuildRunOutcome` uncertainty
  (`trident/build-run.ts:29`, `trident/build-run.ts:119`). The driver catches host
  exceptions as nonterminal unknown (`trident/build-run.ts:416`), and composition
  does the same for iteration-load failure (`trident/project-build-host.ts:79`).
  No new terminal cause, review bound, or permissive gate default is introduced.
- Reconstructed briefs reuse only identical bytes
  (`trident/project-build-host.ts:55`). The runner selection still uses the
  supplied provider and placement (`trident/project-build-host.ts:19`).

### Mutation evidence

All 28 cases below compiled with `bunx tsc --noEmit -p trident/tsconfig.json`,
produced runtime RED, and restored to GREEN. The changed source line was printed
for each mutation. References below name final restored source locations; the
actual printed locations sometimes preceded later additions. Test references
identify the runtime assertions, not compilation failures.

| Guard or write | Compiling mutation | Runtime RED test | Restored |
| --- | --- | --- | --- |
| Worker counter ownership, `trident/build-run.ts:272` | Spread worker payload after host round and re-plan fields | fixed-checkpoint crash, `trident/production-host-effects.test.ts:558` | GREEN |
| G041, `trident/build-run.ts:196` | Set inherited first round to 1 | resumed round / exhausted budget, `trident/production-host-effects.test.ts:498`, `trident/production-host-effects.test.ts:508` | GREEN |
| G038, `trident/build-run.ts:198` | Treat a different full head as unreadable | moved-head rebuild, `trident/build-run.test.ts:423` | GREEN |
| Pending write, `trident/build-run.ts:250` | Remove the write | pending worker, `trident/production-host-effects.test.ts:514` | GREEN |
| Completed write, `trident/build-run.ts:270` | Replace build/fix condition with false | fixed-checkpoint crash, `trident/production-host-effects.test.ts:558` | GREEN |
| Approval write, `trident/build-run.ts:339` | Remove the write | resumed approval, `trident/production-host-effects.test.ts:498` | GREEN |
| Re-plan spend write, `trident/build-run.ts:348` | Remove the write | pre-replan crash, `trident/production-host-effects.test.ts:667` | GREEN |
| Rejection write, `trident/build-run.ts:355` | Remove the write | rejected-review crash, `trident/production-host-effects.test.ts:691` | GREEN |
| Latest-event comparison, `trident/store.ts:1051` | Add `OR 1 = 1` to the SQL predicate | stale writer, `trident/production-host-effects.test.ts:526` | GREEN |
| Active-run predicate, `trident/store.ts:1049` | Remove terminal-phase exclusion | terminal transition, `trident/production-host-effects.test.ts:682` | GREEN |
| Append refusal, `trident/production-host-effects.ts:138` | Disable the thrown refusal | stale writer, `trident/production-host-effects.test.ts:526` | GREEN |
| State validation, `trident/production-host-effects.ts:118` | Replace the validation condition with false | malformed state, `trident/production-host-effects.test.ts:602` | GREEN |
| Required checkpoint, `trident/production-host-effects.ts:145` | Return null for missing state | missing resume state, `trident/production-host-effects.test.ts:526` | GREEN |
| Absence evidence, `trident/production-host-effects.ts:54` | Accept an unreadable show-ref result as absence | unusable observations, `trident/production-host-effects.test.ts:602` | GREEN |
| Diff pin, `trident/production-host-effects.ts:154` | Return known empty diff for invalid pins | unusable observations, `trident/production-host-effects.test.ts:602` | GREEN |
| Plan pin, `trident/production-host-effects.ts:160` | Return null for a short head | unusable observations, `trident/production-host-effects.test.ts:602` | GREEN |
| Archive result, `trident/production-host-effects.ts:166` | Disable command-result check | failed archive with usable output, `trident/production-host-effects.test.ts:620` | GREEN |
| Extraction result, `trident/production-host-effects.ts:168` | Disable command-result check | failed tar with usable output, `trident/production-host-effects.test.ts:620` | GREEN |
| Regular plan file, `trident/production-host-effects.ts:170` | Disable file-kind check | committed link, `trident/production-host-effects.test.ts:656` | GREEN |
| Exact plan blob, `trident/production-host-effects.ts:176` | Disable blob-result and digest comparison | archive transformation, `trident/production-host-effects.test.ts:732` | GREEN |
| Handoff observation, `trident/production-host-effects.ts:186` | Ignore non-allow snapshot result | unknown Ralph head, `trident/production-host-effects.test.ts:638` | GREEN |
| Handoff identity, `trident/production-host-effects.ts:187` | Ignore mismatched run id | wrong Ralph identity, `trident/production-host-effects.test.ts:638` | GREEN |
| Handoff checkpoint, `trident/production-host-effects.ts:190` | Allow missing build state | incomplete Ralph state, `trident/production-host-effects.test.ts:638` | GREEN |
| Handoff completion, `trident/production-host-effects.ts:192` | Ignore the built-stage requirement | incomplete Ralph state, `trident/production-host-effects.test.ts:638` | GREEN |
| Handoff idempotency, `trident/production-host-effects.ts:191` | Disable the consumed-round fast path | replay, `trident/production-host-effects.test.ts:539` | GREEN |
| Mode composition, `trident/project-build-host.ts:69` | Remove the modes binding | reconstruction, `trident/project-build-host.test.ts:92` | GREEN |
| Brief identity, `trident/project-build-host.ts:55` | Ignore changed existing bytes | reconstruction, `trident/project-build-host.test.ts:92` | GREEN |
| Iteration-load uncertainty, `trident/project-build-host.ts:79` | Classify read failure as blocked | malformed Ralph state, `trident/project-build-host.test.ts:103` | GREEN |

The counter mutation corrupts a real durable fixed checkpoint, then reconstructs
another host before checking its counters. An eventual approval write cannot hide
that corruption. The archive failure fixtures create usable output before marking
the command failed; a downstream missing-file error cannot mask those guards.

An initial rejection-crash fixture stopped at a pending write that retained the
rejected stage. It was corrected to stop at the settled rejection only
(`trident/production-host-effects.test.ts:697`), without changing its assertions.
The first plan probe used `git show --output` for a blob; the positive test exposed
its empty output. It was replaced before mutation evidence was counted. An initial
G041 report located an earlier identical assignment when printing its line; that
case was rerun, printing the actual changed assignment at `trident/build-run.ts:196`.

### Validation and documentation

- Bounded tests: 197 pass, 0 fail, 743 assertions, enumerated by exactly these four
  arguments: `trident/production-host-effects.test.ts`,
  `trident/project-build-host.test.ts`, `trident/build-host.test.ts`,
  `trident/build-run.test.ts`. No whole-suite sweep ran.
- The package-script search `rg -n '"typecheck"|"test:bun"' package.json` found
  `test:bun` at `package.json:61` as positive control, with no typecheck alias.
  The root and Trident compiler commands are used instead.
- `bunx tsc --noEmit`: PASS.
- `bunx tsc --noEmit -p trident/tsconfig.json`: PASS.
- `bash scripts/ci/lint.sh`: PASS.
- `git diff --check`: PASS.
- `bash scripts/ci/leak-gate.sh --tree .`: INCOMPLETE, exit 3. Zero findings
  in executed rules; file and commit-message PII denylist checks could not run.
  This is not a clean leak verdict.

The whole-tree controlled search for `new host-owned files`, `existing destination`,
old outstanding-mode wording, and `createProjectBuildHost` found the factory as its
positive control. The unrelated work-board and gateway destination refusals stay
because they describe other operations (`work-board/removal.ts:251`,
`gateway/__tests__/app-docs-surface.test.ts:703`). Earlier HOSTFX2/HOSTFX3 records
remain historical; the shared current outstanding list is updated in this change.

### Deliberate omissions

No product decision or spec acceptance criterion changed. This is additive work;
the launcher is not swapped or deleted. No legacy checkpoint conversion, automatic
pending-result recovery, terminal harvest, new review budget, or remote atomic-base
claim is included. Missing host resume state explicitly stops
(`trident/production-host-effects.ts:145`). The existing runner contract offers
liveness and execution, not a completed-result recovery method
(`runtime/bounded-work.ts:138`). The controlled search
`rg -n 'recover|liveness|run\(' runtime/bounded-work.ts` finds run and liveness as
positive controls, with no recovery member. Pending settlement remains a separate
integration.
The task's explicit shard path and local-commit-only delivery apply here. The
orchestrator owns publication, review, and merge.
