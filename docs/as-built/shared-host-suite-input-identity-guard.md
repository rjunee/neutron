## 2026-09-27 — Bind shared-host checks to unchanged measured suite inputs

The shared-host operator wrapper previously ran typechecking and the full suite
without measuring whether their inputs remained stable. It now invokes the
publication path's production `projectSuiteIdentity` reader before starting
either check and after the admitted checks finish
(`scripts/shared-host-suite-identity.ts:1–8`,
`scripts/check-shared-host.sh:107–126`). Unknown initial identity refuses before
expensive work; changed or unavailable final identity refuses a successful run.
An original nonzero typecheck or suite status remains the exit status, including
when inputs also drift. The existing admission lock and complete checks remain
in place. The production measurement contract is unchanged.

This uses the existing frozen operator proof contract, including its clean-tree
requirement. Fixture call logs now live outside the measured checkout rather
than weakening that requirement (`scripts/check-shared-host.test.ts:23–40`).
Manifest-free fixtures exercise the real production reader: unchanged installed
files and local workspace links pass, while suite-written installed bytes,
linked workspace bytes and tracked inputs refuse
(`scripts/check-shared-host.test.ts:52–96`). No path-specific exclusion or new
Trident gate was introduced.

Focused verification passed: `bun test scripts/check-shared-host.test.ts`
(18 tests), `bunx tsc -p tsconfig.json --noEmit`,
`bunx tsc -p trident/tsconfig.json --noEmit`, and the additional
`bunx tsc -p open/tsconfig.json --noEmit`. Two temporary valid-shell mutations
provided semantic controls: replacing the final identity comparison with
`false` caused all three changed-input tests to fail with success received where
refusal was expected; replacing it with `true` caused the unchanged executable
test to fail with refusal received where success was expected. Both mutations
were restored before the final focused run.

This is bounded workflow work under #1196. Full local admission, exact-head CI,
publication and served dispatch evidence are pending coordinated validation;
these focused checks do not establish that broader proof or close the issue.
