## 2026-09-28 — Read concurrently published migration ownership claims

Issue #1373 follows the Nexus three-process first-writer failure in PR #1371
CI job 108754736387. The failure reported an unreadable `.migrate-owner` with
ENOENT. The deterministic subprocess control reproduced that refusal against
unchanged main before this fix: the first read observed absence, a competing
process published a complete claim, and the following existence check found it.
The old reader then refused the valid claim using the earlier read error.

`migrations/runner.ts:1439` now establishes entry presence with `lstatSync`
before reading. Absence proceeds to the existing exclusive publication path;
an existing entry must be readable and pass the unchanged identity checks at
`:1497`. Dangling links remain unreadable claims. There is no ownership retry,
replacement, or migration-ledger change.

`gateway/nexus/__tests__/fixtures/owner-publication.ts:31` publishes at the
existence-check boundary, using a separate Nexus process for the valid owner.
The consuming assertions at `gateway/nexus/__tests__/init-contention.test.ts:78`
require both appends and one ledger witness. Foreign, malformed, and dangling
claims arriving at the same boundary refuse without schema or ledger writes.
`migrations/__tests__/migrate-owner-publication-mutation.test.ts:11` restores
the former read/stat order as a must-fail control alongside the existing partial
publication, ignored-winner, foreign-admission, and own-owner-refusal mutants.
The normative acceptance remains in
`docs/spec-items/migration-owner-atomic-publication.md`.

Validation:

- `bun test gateway/nexus migrations/__tests__/migrate-owner-refusal.test.ts migrations/__tests__/migrate-owner-publication-mutation.test.ts migrations/runner.test.ts`
  — 133 pass, zero fail, including the unmodified three-process first writer.
- `bun test gateway/nexus/__tests__/init-contention.test.ts --rerun-each 30 -t 'three separate first writers|migration ownership publication'`
  — 390 pass, zero fail; every selected consuming case ran 30 times.
- `bunx tsc -p gateway/tsconfig.json --noEmit` and
  `bunx tsc -p migrations/tsconfig.json --noEmit` — pass.
- `bash scripts/ci/typecheck-all.sh` checked 51 configs. Its gateway check
  caught an overloaded test-spy annotation, corrected during the run; the
  explicit gateway rerun above passed. All other 50 configs passed, including
  root and trident. The original matrix command retained its nonzero exit.
- Publication mutation and spec-index suites — 39 pass, zero fail. The
  read-before-stat mutant must fail the exact competing-claim consuming test.
- The local whole-tree leak gate returned 452 findings, including worktree
  metadata and existing-file denylist matches. That run is not a purity pass.

These are local measurements; this record does not claim CI or publication.
