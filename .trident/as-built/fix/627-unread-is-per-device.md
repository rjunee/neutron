## Per-device unread rail — checkpoint and ruling implementation

The checkpoint sections below describe the earlier revision. The 2026-09-15 continuation at the end supersedes their open questions and validation status.

### Status and scope

This is a preservation checkpoint requested by the continuation brief, not a completed change or a merge recommendation. The working tree was already modified when this continuation began, and additional edits appeared during inspection. Test results below describe the files at execution time, not a stable final revision.

The draft adds device marks and receipt triggers (migrations/0146_rail_device_marks.sql:2,35,41,46), initializes a new device from the message head (gateway/projects/sqlite-store.ts:329), and filters counts by device (gateway/projects/sqlite-store.ts:392). The HTTP surface takes the device from a request header (gateway/http/app-projects-surface.ts:609). The storage reader persists an identity (app/lib/installation-device.ts:14-18); the browser bootstrap also persists an identity (landing/chat-react/config.ts:341-352).

### Decisions and unresolved product questions

Preserve the draft rather than lose the interrupted work. Do not treat its product assumptions as approved. The available issue explicitly leaves unread-event policy undecided; the named acceptance file did not appear in the working-tree enumeration described in the lane progress log. Work-tracking forbids inventing the missing answer (docs/process/work-tracking.md:78-83).

The draft chooses aggregate historical marks (migrations/0146_rail_device_marks.sql:25-28) and head initialization for newly listed devices (gateway/projects/sqlite-store.ts:329-333). Both require a product ruling before completion. Existing receipts already include a required device key (migrations/0082_app_chat_receipts.sql:43-50).

The new unknown value joins the unread-count vocabulary as null (gateway/projects/sqlite-store.ts:379); ordering treats it as read (app/lib/rail-order.ts:71). Its display was still being edited during inspection. SQL triggers maintain marks while clients are disconnected (migrations/0146_rail_device_marks.sql:35-49), but their complete correctness is unproven.

### Verification

- Store, HTTP surface, migration runner and snapshot selection: 125 pass, 1 fail across 8 files. The migration enumeration assertion at migrations/runner.test.ts:166 lacks the new version.
- Client and web selection: 98 pass, 2 fail across 9 files. The legacy-response assertion expects zero (app/__tests__/projects-fetch.test.ts:174), while the draft maps missing counts to null (app/lib/projects.ts:233). The other failure was shared Happy DOM registration; the web rail suite passed separately with 5 tests and 55 assertions.
- App lint with telemetry disabled: zero errors, 21 warnings.
- Repository typecheck matrix reports TS2688 for the implicit @types library in app. It was interrupted after that failure; no green or complete matrix claim.

### Mutation table

| Guard | Mutation | Red | Restored green |
| --- | --- | --- | --- |
| Device initialization, device receipt isolation, read-only receipt advancement, monotonic marks, persisted identity reuse, storage failure handling | Not run by this continuation because another writer was changing the same draft | Unproven | Unproven |

### Remaining work and exclusions

Resolve event and initial/legacy mark policy. Finish both rail transports and identity lifecycle coverage. Reconcile the two substantive test failures against approved behavior without weakening tests. Run all affected suites on a stable revision, prove each guard with a printed mutation and diff, and complete typecheck. Review unknown-state rendering and error vocabulary. Re-read this record against the final code before considering it complete.

This continuation did not change source or tests, invent acceptance criteria, perform mutation edits against the active writer, push, open a PR, or merge. The checkpoint preserves source and tests found in the worktree; it does not certify them.


### 2026-09-15 continuation — approved connection-specific frames

Implemented the owner's ruling in SPEC.md:294-305. A live frame is built for each
connection using the existing HTTP store's device initialization and count path
(open/composer.ts:4124-4145; gateway/projects/sqlite-store.ts:338-355,399-415).
This preserves the prior migration and new-device policies rather than defining
another unread policy. The old composer aggregate reader was removed. Bootstrap
reads project metadata without an unread field (open/composer.ts:2431-2432,2558-2588).

The WebSocket upgrade distinguishes resolved installation identity from its
synthetic receipt-only fallback (gateway/http/app-ws-surface.ts:662-665,681,737-739).
The registry withholds synthetic identities and builds for each connection,
including separate connections on the same topic
(channels/adapters/app-ws/session-registry.ts:158-170). A real supplied device id
beginning with `conn-` remains valid; classification uses provenance, not spelling
(open/__tests__/open-projects-changed-wiring.test.ts:327-331).
Connect snapshots and subsequent cross-topic refreshes use this same delivery
method (open/wiring/app-ws.ts:1202; open/composer.ts:4159-4184).

### Vocabulary, maintenance, and scope decisions

Unknown joins the existing nullable HTTP unread vocabulary
(gateway/projects/sqlite-store.ts:399; app/lib/projects.ts:233). On the wire it is
an omitted optional `unread` (wire-types/app-ws-envelope.ts:372-373), including
when device storage fails (open/composer.ts:4127-4136). Native unknown labels use
`?` (app/lib/rail-order.ts:91-94); the existing web presentation hides an omitted
badge (landing/chat-react/ChatApp.tsx:1691). No new error code or verdict was added.
A failed sender is removed from the registry, matching the existing dropped-sender
handling; a connection removed during asynchronous frame construction is not sent
the frame (channels/adapters/app-ws/session-registry.ts:132-154,163-168).

The invariant is maintained at every send boundary, independently of the receiving
client. Durable receipt/message triggers maintain the marks while clients are
disconnected (migrations/0146_rail_device_marks.sql:35-49). The native live overlay
continues to copy activity and live-run state only; its unread refresh remains
HTTP (app/app/projects/[id]/_layout.tsx:291-304,372-375).

The existing HTTP fake-store test expected zero despite lacking a chat log. That
expectation contradicted the approved unknown contract and the store's explicit
null (gateway/http/app-projects-surface.ts:356-358). It now asserts null, not a
looser range or optional check (gateway/__tests__/app-projects-surface.test.ts:434-435),
and its zero-substitution mutation failed.

### Merge and documentation reconciliation

Merged the locally available main ref dd5638e3; no network fetch was attempted.
Migration 0144 conflicts with main's phase-usage migration. Moved the rail
migration to 0146 and updated migrations/runner.test.ts:213 and both independent
applied lists at migrations/__tests__/live-ledger-125-repair.test.ts:93,177.
The local-ref query `git ls-tree -r --name-only origin/main --
migrations/0146_rail_device_marks.sql migrations/0144_trident_phase_usage.sql
CONTRIBUTING.md` returned the latter two positive controls. This establishes the
local ref's contents, not the current remote state. Enumerating the SQL files in
the build worktree also showed one file per ordinal after the move.

Ran `bun run migrations/regen-snapshot.ts` after staging the renamed migration.
Read the complete snapshot diff against local origin/main: 37 added lines, only
two rail tables and three triggers. Main's schema additions remain present.

The whole-tree content search `rg -n 'readProjectUnread|highest READ receipt seq|IDENTICAL shape/order|share project metadata' . --glob '!bun.lock'`
found the obsolete sentence in docs/SYSTEM-OVERVIEW.md:4052 and the frozen
historical docs/AS_BUILT.md:24638, with the new composer metadata comment as the
positive control. Updated the current overview (docs/SYSTEM-OVERVIEW.md:4051-4062);
the frozen historical record stays untouched by repository policy. The standing
lane instruction explicitly selects this existing as-built path.

### Mutation evidence from this continuation

Each mutation was applied individually, its landed line printed, and the original
source restored. The restored device acceptance test passes with 14 assertions;
the restored registry/wiring/rail helper selection passes 42 tests. Mutation line
numbers below refer to the printed temporary mutation, before restoration.

| Guard / behavior | Mutation and printed location | Red observation | Restored result |
| --- | --- | --- | --- |
| Build per connection | Build once before the loop, registry line 161 | Second device expected 2, received 0 | Green |
| Unknown never borrows aggregate | Insert aggregate receipt query in composer lines 4138-4145 | Unknown-device row unexpectedly has unread 0 | Green |
| Synthetic identity is unresolved | Pass synthetic id to builder, registry line 162 | Unknown-device row unexpectedly has unread 3 | Green |
| Removed connection is not sent | Remove membership check, registry line 163 | Disconnected receiver gets a frame | Green |
| Failed sender is evicted | Remove unregister, registry line 167 | Expected one remaining connection, received two | Green |
| Device-store failure preserves rail | Rethrow from composer catch, line 4135 | Populated Gamma refresh never reaches known devices; timeout after prior count assertions pass | Green |
| Known zero is preserved | Require count greater than zero, composer line 4132 | First device expected 0, received undefined | Green |
| HTTP fake-store unknown | Substitute zero at app-projects-surface line 358 | Exact null assertion fails | Green |

The acceptance fixture uses the real composer, upgrade handler, session registry,
device store and create-project handler. Only the socket transport is in-process
(open/__tests__/open-projects-changed-wiring.test.ts:96-142,324-389). It supplies
three messages, distinct device receipts, and a populated project; the failure
case removes device storage only after the distinct-count assertions have passed.

### Validation and deliberate exclusions

Targeted successful selections (enumerated by the explicit commands):

- `bun test migrations/snapshot.test.ts migrations/runner.test.ts migrations/__tests__/live-ledger-125-repair.test.ts migrations/__tests__/rail-device-marks.test.ts gateway/projects/__tests__/sqlite-store.test.ts` — 71 pass.
- `bun test channels/adapters/app-ws/__tests__/session-registry-multidevice.test.ts open/__tests__/open-wiring-app-ws.test.ts open/project-rail.test.ts` — 42 pass.
- `bun test app/__tests__/projects-fetch.test.ts app/__tests__/installation-device.test.ts app/__tests__/projects-rail-live.test.ts app/__tests__/rail-order.test.ts` — 29 pass.
- `bun test app/__tests__/rail-unread-floats-and-counts.test.tsx` — 10 pass.
- `bun test app/__tests__/projects-client.test.ts app/__tests__/project-rail-view.test.ts app/__tests__/mobile-entry-route.test.ts` — 37 pass.
- `bun test landing/chat-react/__tests__/config.test.ts` — 42 pass.
- `bun test landing/chat-react/__tests__/component.test.tsx` — 20 pass.
- `bun test gateway/__tests__/app-projects-surface.test.ts gateway/__tests__/app-ws-close-attribution.test.ts` — 37 pass.
- `bun test open/__tests__/open-projects-changed-wiring.test.ts -t 'each connection'` — 1 pass, 14 assertions.

The full composer integration file was also run: the new acceptance test passes,
and both existing listener-based tests fail to bind port 0 with EADDRINUSE in the
restricted build environment. Their assertions remain intact; the existing
known-zero case now supplies a device id. This is not an all-green integration
claim. The orchestrator must rerun that full file where local listeners work.

No whole-suite or whole-directory sweep, schema hand-edit, native-overlay change,
new feature flag, push, PR operation, or merge into main was performed. Earlier
checkpoint mutation claims remain historical; the table above is exactly what
this continuation proved.

Final repository checks: `bash scripts/ci/typecheck-all.sh` passed all 51 projects;
`bash scripts/ci/lint.sh` passed; `git diff --check` passed.

The leak gate reported zero findings from available rules, but returned INCOMPLETE
because the external identity denylist was unavailable. Full leak certification
remains with the orchestrator; no bypass was used.
