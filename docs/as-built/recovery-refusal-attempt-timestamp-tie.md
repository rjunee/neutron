## 2026-10-03 — Make recovery refusal provenance checks deterministic under timestamp ties

The late launch refusal fixture assumed terminal attempts were returned in launch
order. The reader orders by `recorded_at, run_id` (`work-board/store.ts:695-699`),
the default clock records milliseconds (`work-board/store.ts:709`), and run IDs
default to random UUIDs (`trident/store.ts:918`). Equal observation timestamps
can therefore return the successor before its source. The provenance acceptance
requires distinct retained attempts and no duplicates
(`docs/spec-items/work-board-attempt-provenance.md:40-42`).

The fixture now pins the observation time and supplies UUIDs whose lexical order
reverses launch order (`work-board/recovery-refusal.test.ts:191-199`). It checks
the timestamp tie and compares the exact identity/outcome arrays after sorting
both by run identity (`work-board/recovery-refusal.test.ts:216-220`). Both blocked
outcomes and exact multiplicity remain required.

Verification: with the deterministic fixture and original assertion, the focused
late launch test failed with the two correct blocked identities reversed. With
the corrected assertion, `bun test work-board/recovery-refusal.test.ts` passed
all 12 tests with 65 assertions. Temporary result mutations independently removed
the source, removed the successor, replaced the successor identity with a second
source identity, or changed the successor outcome to failed; every focused run
failed. All four mutations were removed before the final passing run.

The first corrected full-gate attempt stopped at the owned Work Board typecheck:
sorting the expected literal array widened its outcome to `string`. Both expected
outcomes now retain the literal type with `as const`; runtime values and exact
array assertions are unchanged. That aborted attempt executed no tests and is
not full-suite evidence. The owned Work Board typecheck is required before the
new canonical validation attempt.

## Final canonical verification

The owning `tsc -p work-board/tsconfig.json` and all 12 focused refusal tests
passed before clean revision `225b91a01b630cb47f719fd64a632438bee661f4` was frozen.
Its subsequent canonical `bash scripts/check-shared-host.sh` exited zero: all 51
TypeScript configurations, including root and Trident, and all 1,776
declared/discovered/assigned/executed test files passed across 19 lanes with
zero failed lanes. The 1,537 general, 22 PGLite, 43 device and 174 real-HTTP
files all executed; existing case-level skips were retained, not file exclusions.
Both named consuming Open E2Es executed. Suite input identity was unchanged:
`7b4722809fd1e649d8a44db71bfa104089e5f353beea94215704a83547ccb2fe`.
The complete retained log SHA-256 is
`012bf8475a6b5ace6590a6374f1ed65bf3be74a64ed3dbab5dd1c54dbd99cebe`.
The publication head adds this measured record without changing the tested
source, fixtures or dependencies. Exact-head CI, deployment and live unattended
acceptance remain independent requirements.
