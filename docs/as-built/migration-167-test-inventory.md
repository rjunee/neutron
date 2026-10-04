## 2026-10-04 — Keep explicit migration test inventories current through 0167

The first-apply inventory in `migrations/runner.test.ts:166` and both later-apply
inventories in `migrations/__tests__/live-ledger-125-repair.test.ts:93,177` stopped
at 0166 although the reviewed tree contains 0167. Append 167 to each exact array;
the expectations remain independent of the migration loader. The fresh-install
test also directly checks the canonical ledger row's version and name at
`migrations/runner.test.ts:245`. Its existing ledger-to-applied comparison at
line 243 and exact inventory continue excluding the legitimate absent versions
59, 64–68, 128–129 and 159. Both incident inventories likewise retain their
existing gaps and repair assertions.

The governing invariant says the runner's six refusals are "fail-closed and must
stay so" (`docs/INVARIANTS.md:133–146`). The reviewed operational requirement says
the ordinary runner "later really executes the idempotent migration 0167 and
records its normal provenance" (`docs/spec-items/project-herdr-workspaces.md:124–126`).
This correction changes only the two consuming tests and this record; production
runner, provenance, repair and SQL files have no diff from the frozen base
`57dfdbbd3275edcaca1bb79b4740c8a4fce40e93`.

Validation on that base plus this test correction: frozen-lockfile installation
succeeded. The initial sandboxed test invocation exited 3 because mandatory
namespace isolation was denied; the approved retry verified isolation and ran
`bun test migrations/runner.test.ts migrations/__tests__/live-ledger-125-repair.test.ts`
with 27 passing tests, 0 failures and 295 assertions. Both
`bunx tsc -p tsconfig.json --noEmit` and
`bunx tsc -p trident/tsconfig.json --noEmit` exited 0, as did focused ESLint on
the two changed test files. No full-suite or CI receipt is claimed.

Mutation proof removed 167 only from the first-apply expected array: the selected
test failed at its exact applied-array assertion with received `+ 167` (exit 1).
Removing 167 from both incident expected arrays produced two corresponding
assertion failures, while the other two tests passed (exit 1). Restoring all
three expectations returned the affected files to green. A repository-wide
test/spec search for `166` or `0166` found these three migration inventories as
positive controls and the unrelated gate-citation count, which was preserved.
