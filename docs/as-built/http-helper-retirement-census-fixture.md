## 2026-09-25 — Scope the HTTP helper retirement fixture to its own census

The HTTP retirement fixture shared the `owner` identity with preceding composer
tests and omitted conversation scope. Once a composer registered that owner's
native-child census, the retirement guard correctly refused unknown scope before
the registry-removal and watchdog-race assertions could run. The fixture now
owns a unique owner census, names its project in the pool options and registry
rows, and removes its census during cleanup. Production code is unchanged.

The original `tests/integration/helper-retirement.test.ts` passes 10/10 alone on
both base `848c2676f` and candidate `252cc09f5`. An explicit sequential-import
harness loading `tests/integration/cores-slug-provenance-wired.open.test.ts` before
the retirement file passes 15/15 on the base and reproduces exactly the two
reported failures on the candidate (13 pass, 2 fail). Passing both paths to Bun
on its command line does not establish that order: Bun ran the retirement file
first. With the fixture correction, the ordered harness passes 19/19; the owning
file passes 14/14 with 111 assertions.

Four added cases exercise actual HTTP-backed fixture children against same-project
native work, other-project work, census failure, and absent scope. They assert
retirement or refusal, child exit, registry removal or preservation, pool
membership, the retirement marker, and the exact scope queried. Temporary
mutations that allow every scoped census, refuse every scoped census, or treat
missing scope as safe all fail their corresponding controls. Removing the
watchdog's post-probe retirement check produces one false crash report; deleting
the registry row before termination fails the existing row-at-kill assertion.
All mutations were reverted, the production-file diff is empty, and the complete
owning file passes again.

Verification also includes 8/8 native-child respawn controls and successful root
and Trident TypeScript checks (`bunx tsc --noEmit` and
`bunx tsc --noEmit -p trident/tsconfig.json`). HTTP tests ran serially with
`--max-concurrency=1 --timeout=60000`. These tests use real local HTTP and an
in-memory child boundary; they do not establish deployed serving. The consuming
Open build E2E and full suite remain assigned to the final combined revision.
