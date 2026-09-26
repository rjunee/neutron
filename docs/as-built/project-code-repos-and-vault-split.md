## 2026-09-26 — Canonical project vault snapshots and an active backup scheduler

The project materializer, document editor and dormant backup substrate previously
owned independent histories over overlapping files. A nested code checkout could
be represented only by a gitlink, and staging live SQLite bytes did not capture
committed WAL transactions. The owner selected the existing `.project-backup/`
store and an encrypted owner-wide destination; the immutable decision is recorded
in `SPEC.md` (2026-09-26).

Open now shares one writer across materialization, document writes, the backup
HTTP surface and the six-hour scheduler (`open/composer.ts:3832`,
`open/composer.ts:4292`, `open/composer.ts:5388`). Boot backfill, jitter and
stop/drain use the existing scheduler lifecycle. The consuming composer test
captures two scheduled versions and recovers the first without an HTTP backup.

The store reconciles required ignores while retaining owner rules. Shared
repository declarations support zero and multiple repositories; discovery also
excludes undeclared nested checkouts. Staging rebuilds the eligible index, refuses
gitlinks and captures each SQLite database with `VACUUM INTO`, omitting live
journals (`gateway/git/vault-snapshot.ts:45`, `gateway/git/vault-snapshot.ts:61`).
This is per-database consistency, not a project-wide transaction.

Legacy materializer and document refs, HEADs and reflog-only tips retain original
SHAs under immutable `refs/vault-history/` refs
(`gateway/git/vault-history-migration.ts:18`). Source repositories are retained.
Only the exact old generated document-ignore block is retired, after archiving
the complete original bytes; owner rules and owner-modified blocks remain.
Document history reads both layouts while new edits use the shared writer
(`gateway/git/doc-version-store.ts:271`). Materialization delegates initialization
and no longer writes a separate repository
(`onboarding/wow-moment/project-materializer.ts:370`).

The owner transport encrypts complete all-ref bundles with AES-256-GCM and checks
pinned private GitHub identity before remote writes. Fresh-clone recovery restores
archived refs as well as main. Authenticated bounded chunks carry up to a 1 GiB
bundle, with 32 MiB maximum objects; a real 96 MiB incompressible fixture proves
the former single-object limit is overcome. Missing, extra, reordered or corrupted
chunks refuse before Git consumes plaintext. Every export retains full history;
remote storage grows with exports and no retention deletion is implemented.
Configuration requires an explicit off-host-key
custody attestation; no secret is generated or uploaded by this change. Legacy
plaintext destinations and automatic provisioning are refused, including the old
HTTP configuration route (`gateway/http/app-admin-surface.ts:531`). No destination
means local recovery only. See `docs/vault-backup-recovery.md` for operational
limits and the owner procedure.

The sole remote route is fixed-host HTTPS using an ephemeral, GitHub-scoped
`gh auth git-credential` helper (`gateway/git/project-backup-remote.ts:198`).
Ambient Git configuration/helpers are isolated and redirects are refused;
credentials never enter URLs or stored Git configuration. A real-Git fixture
checks intended-host success, wrong-host refusal and non-persistence. A read-only
private-destination identity check and `ls-remote` probe passed using the exact
integrated command builder. That proves read access, not push or restoration.
The integrated store/transport rerun passed 64 tests / 294 assertions; independent
HTTPS security review reproduced 21 tests / 94 assertions and found no blocker.

Review reproduced two additional failures and the consuming regressions now pin
their fixes: failed snapshot staging persists an error without losing the prior
valid SHA; destructive restore requires a successful local safety snapshot.
SQLite-affecting in-place restores refuse with offline/fresh-directory guidance,
because this surface cannot quiesce live connections and WAL. An unrelated
document restore remains available alongside a live database
(`gateway/__tests__/project-backup-store.test.ts:1303`,
`gateway/__tests__/project-backup-store.test.ts:1324`). Whole-project recovery
commits use the same safe staging helper.

Verification at the integration checkpoint: 266 tests / 1,252 assertions across
13 consuming suites passed. The served composition suites separately passed 20
tests with loopback binding available. The restore HTTP surface and production
composer passed another 44 tests / 186 assertions, including explicit offline
SQLite guidance and a successful document-only control. Root and Trident TypeScript passed after
the review fixes; the dependency boundary check passed with 3,057 modules and
8,201 dependencies (eight pre-existing exceptions). An
independent recheck closed all three findings with four real-store tests and
26 assertions. Final gate evidence accompanies the reviewed PR. Semantic mutations were red for raw SQLite
staging, over-excluding ordinary zero-repository vault content, omitting scheduler
start, removing the SQLite restore refusal, refusing unrelated document restore,
and omitting failure-status persistence. Transport tests exercise privacy and
authentication refusal in both directions.

The local clean-archive leak scan is not green: both the base and candidate
report 451 findings under the supplied host denylist. This change does not weaken
that gate; publication still requires the authoritative leak check to pass.

Not claimed: live offsite push/restore, owner custody of a recovery key, a full
shared-host gate at this checkpoint, deletion of retained legacy repositories,
or location-independent classification of public versus private files. The last
criterion remains open in `project-code-repos-and-vault-split.md`; folder exclusion
and encrypted backup do not settle publication policy.
