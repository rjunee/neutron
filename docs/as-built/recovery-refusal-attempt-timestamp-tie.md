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
