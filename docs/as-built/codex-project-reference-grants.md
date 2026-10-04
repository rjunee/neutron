## 2026-10-04 — Add explicit Codex account references for project owners

The project connection route could only paste a subscription into a separate
project auth file. The new explicit selection stores a metadata reference to
an owner-bound global credential row, stable account digest and unique grant
version, with the existing credential record retaining expiry
(`trident/codex-credential.ts:660`). Selection and removal do not copy or delete
canonical account authentication bytes. Duplicate account pastes now refuse
across global and project authority rows, including expired credentials.

Both independent project credentials and account references resolve to the same
owner contract: canonical native account home, project owner root, stable account
identity and project grant identity (`trident/codex-credential.ts:621`). Native
credentials remain in place while project markers, sockets, journals and work
records use the project root. Cached admissions compare grant identity; durable
launch scopes persist it and refuse replacement or recreation after restart
(`open/wiring/codex-durable-owner.ts:108`). Older launch records lacking that
identity require explicit reconciliation rather than an inferred upgrade.

Recovery retains the existing refusal of every same-account-home competitor.
Separate project state does not authorize concurrent native refresh writers.
Credential connect, reconnect, removal and missing-file repair acquire the shared
account write lease before mutation; unqualified pool removal admits every account
before deleting any row. Busy refusal is an HTTP 409. Metadata-only project grant
revocation remains available while the account writer is busy
(`trident/codex-credential.ts:982`).
Project/global connects, grant selection, removal and refresh persistence share
the existing owner mutation queue. A queued harvest rechecks row identity,
plaintext, expiry and freshness, so it cannot recreate a removed project grant
(`trident/codex-credential.ts:1295`).

The actual helper entry point acquires account admission before any bootstrap
journal or child exists, then transfers that same lease to native transport.
Its direct acquisition refusal writes a launch-digest-bound receipt. The caller
matches the captured pane/helper birth identity, acknowledges that exact receipt,
proves helper exit and absence of native state, and only then removes provisional
launch/pane records. An exclusive cleanup claim and immutable refusal audit fence
concurrent cleanup and preserve uncertain cases. The real helper test demonstrates
account-busy refusal followed by a fresh durable retry
(`runtime/adapters/codex-cli/persistent/project-owner-helper-main.ts:22`).
The consuming bootstrap test additionally passes the exact reserved lease through
the real transport and observes its native fixture PID; reacquiring instead of
transferring cannot satisfy it. Shell reviewer/build controls hold the account
reservation and require visible `accountBusy`/deferred refusal without executing
Codex, paired with successful available-account execution. Thus a single seat
already occupied by an owner intentionally defers independent Codex review/build
work; this change does not promise same-account parallel native writers.

Grant expiry remains optional, as specified in the provider-resolution item.
The existing credential row owns expiry; finite grants retain their expiry across
same-account refresh and refuse after expiration. No arbitrary expiry horizon or
new renewal UI was introduced.

The follow-up consuming controls passed with the existing expiry controls (six
selected tests, 49 assertions); root and trident TypeScript checks passed. Five
additional must-fail mutations were killed and restored: dropping the transferred
lease, bypassing admission in each shell consumer, and always-busy overrefusal in
each shell consumer. These results do not substitute for the paired writer-lock
descendant-lifetime correction or final integrated acceptance.

The paired web/phone selection UI is recorded in
`codex-existing-account-project-selection.md`. Synthetic service/API checks cover
explicit connection, no credential copy, shared refresh visibility, source and
grant removal/recreation, account replacement, finite expiry, foreign owners,
revocation and the writable independent-account control. Owner tests cover
separate project sockets and grant replacement refusing chat, controls, builds
and restart.

Focused validation on the assembled source: 365 tests passed across twelve
service/grant/HTTP, custody, owner, refusal-recovery and kernel-lock test files
(2,512 assertions). Both root and trident TypeScript checks passed, as did web and
phone TypeScript checks. The earlier seven-file run including the consuming
`open/__tests__/project-build-e2e.test.ts` passed 799 tests; it predates the writer
lease integration and is not claimed as final integrated proof. Eight backend
must-fail mutants were killed and restored: accepting a foreign
source row, refusing every valid grant, ignoring grant replacement, allowing a
busy auth overwrite, unnecessarily blocking metadata-only revocation, bypassing
the project mutation queue, accepting a foreign refusal helper, and refusing
every valid pre-native retry. The paired UI tests passed 22 cases. After the final
small census retry correction, all 32 affected grant, kernel-lock, helper-refusal
and durable-owner controls passed (157 assertions). Required full-suite
validation and live acceptance remain separately unverified.

The paired account-writer guard supplies the shared native admission contract;
sharing one auth path alone does not establish it. External native launch paths
still require deployment corroboration. No live credential, grant, owner, account selection or
deployment was changed, and no live acceptance is claimed for #1348 or #978.
