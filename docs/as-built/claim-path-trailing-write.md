## 2026-09-25 — Preserve unresolved writes after reference paths

Follow-up to #1294 and `claim-path-instruction-ranges.md`. A path-bearing
clause cleared pending instructions even when it ended with an unresolved
write. `Review docs/spec.md and edit, then run scripts/ci/typecheck-all.sh`
therefore omitted the script claim; `Inspect trident/store.ts and create, then
inspect trident/new-store.ts` omitted the new store claim. Both incorrectly
admitted beside a live holder of the omitted target.

`trident/claimed-paths.ts` now carries nonempty trailing prose after the last
recognized path into the next inline clause unless the original clause is a
complete read-only exemption. Comma-only suffixes do not carry. Unknown trailing
prose remains conservative; the parser does not infer natural-language write
scope. Complete `Edit X; inspect Y` and canonical read/read clauses retain their
independent scopes. The store transaction, path recognizer and newline boundary
are unchanged.

Five separately named store tests cover the two actual refusal regressions,
their read-only siblings and a completed independent edit. They verify persisted
claims on admission, holder identity on refusal and the database row count in
both directions. Before the repair, both forbidden admissions failed assertions
while all three legitimate siblings passed. Parser tests also cover alternate
boundaries, slash-joined verbs, intervening objectless clauses and complete
prohibition exemptions.

Validation on the candidate:

- `bun test trident/claimed-paths.test.ts trident/store.test.ts
  tests/integration/identity-env-readers-registry.test.ts`: 231 passed.
- `bun test open/__tests__/project-build-e2e.test.ts --test-name-pattern
  'admission host exception|project admission end to end|task_sequence continuation probes|design-gap escalation|terminal (single|task-sequence) runs one host suite|local merge mode reaches merged'`:
  seven consuming tests passed; the rest of that file was filtered out.
- `tsc -p tsconfig.json` and `tsc -p trident/tsconfig.json`: passed.
- Temporary semantic mutant disabling suffix carry: both forbidden store
  admissions failed, all three legitimate siblings passed. Mutant carrying
  every suffix, including empty/exempt ones: all three legitimate admissions
  failed while both actual-overlap refusals passed. These were runtime assertion
  failures, not parser errors; the mutations were restored.

This source repair does not establish full-suite, deployment or live admission
acceptance. #1294 remains open for served positive/negative admission controls
and the adopted-chat Work Board unattended-merge witness in
`docs/spec-items/trident-build-efficiency.md`.
