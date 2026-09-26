## 2026-09-25 — Publish migration ownership claims atomically

The three-process Nexus first-write acceptance failed when one process read
`.migrate-owner` after another process created its inode but before it wrote the
owner bytes. The malformed-marker refusal was correct; the marker producer
exposed an incomplete claim. The old first-claim catch also ignored an exclusive
creation loser without validating the winner's owner.

`migrations/runner.ts:1439` distinguishes a truly absent marker from an unreadable
dangling symlink. At `:1462`, the runner writes the entire claim privately in the
same directory, exclusively links the completed file to the public marker, then
reads and validates the winner. Existing markers are never overwritten. A
private write failure retains the established absent-marker tolerance for
unwritable media; a failed publication on writable media refuses if no readable
winner exists. Cleanup removes the private staging directory when possible.

`gateway/nexus/__tests__/fixtures/owner-publication.ts` pauses the first claim
between its real open and write and runs another Nexus writer in a child
process. Both appends survive with one ledger row. The consuming tests also
exercise failed writes, existing and competing foreign/malformed claims,
dangling markers, and unsupported hard links, including no-schema/no-ledger
assertions on refusal. The existing three-process first-writer case remains.

`migrations/__tests__/migrate-owner-publication-mutation.test.ts` runs the Nexus
consumer assertions against an unchanged control and four semantic mutants:
partial public publication, skipped winner validation, foreign-owner admission,
and own-owner refusal. The control passes; every mutant fails an assertion.
Independent review found the dangling-marker and unsupported-link cases; both
were fixed and the follow-up review found no remaining blocker.

Verification on the main-based candidate `e7bb6785cd5aba8202b3c40fea3783dc7576f1d1`:
166 focused tests passed across the Nexus suites, migration runner,
ownership-refusal and mutation suites, and generated spec-index checks. The
required `bash scripts/check-shared-host.sh` passed: all 51 TypeScript
configurations, then all 1,693 discovered and executed test files across 18
lanes (1,459 general, 22 PGLite, 43 device, 169 real-HTTP), with zero failing
lanes. The final publication commit adds this receipt; CI on that final head
and served deployment verification remain separate gates.
