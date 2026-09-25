## 2026-09-25 — Give legacy helper retirement tests an owned, scoped census

The native-child retirement gate exposed an order-dependent test fixture:
`legacy-helper-retirement.test.ts` used the shared owner identity with no
conversation scope. Earlier composer tests register that owner's census, so the
new gate correctly refused the fixture's unknown scope before termination.
The fixture now owns a unique owner and census, names its helper project in the
pool identity and registry, and asks cleanup to retire that exact project.
Production ownership proof and unknown-state refusal are unchanged.

Paired evidence used main base `848c2676f` and candidate `252cc09f5`. The original
legacy-helper file passed all 15 tests independently on both refs. Importing
`kimi-panelist-wired.open.test.ts` before it in one Bun process passed 23/23 on
the base, but reproduced all four host-suite retirement failures on the candidate
(19/23). After the fixture correction, the ordered pair passes 28/28 and the
owning file passes 20/20.

The five additional cases require refusal for a same-project live child, a census
error, missing scope, and a child admitted during idle-screen capture. A child
in another project permits retirement. Assertions check actual child kills,
registry preservation/removal, retirement admission markers, scope passed to the
census, and whether idle capture was reached. Temporary mutations confirmed that
removing the final pre-kill census check, treating an unknown scope as safe,
returning false for every census, and returning true for every census each fail
the relevant controls. Restoring production code restores 20/20 passing tests.

Verification: `bun test tests/integration/legacy-helper-retirement.test.ts`, plus
the ordered composer/helper pair described above; root and Trident TypeScript
checks (`bunx tsc -p tsconfig.json --noEmit` and
`bunx tsc -p trident/tsconfig.json --noEmit`) also pass. These are fake-child
tests; they do not establish live serving or deployment evidence.
