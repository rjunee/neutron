## 2026-09-14 — Per-device rail draft checkpoint (incomplete)

### Status and scope

This is a preservation checkpoint requested by the continuation brief, not a completed change or a merge recommendation. The working tree was already modified when this continuation began, and additional edits appeared during inspection. Test results below describe the files at execution time, not a stable final revision.

The draft adds device marks and receipt triggers (migrations/0144_rail_device_marks.sql:2,35,41,46), initializes a new device from the message head (gateway/projects/sqlite-store.ts:329), and filters counts by device (gateway/projects/sqlite-store.ts:392). The HTTP surface takes the device from a request header (gateway/http/app-projects-surface.ts:609). The storage reader persists an identity (app/lib/installation-device.ts:14-18); the browser bootstrap also persists an identity (landing/chat-react/config.ts:341-352).

### Decisions and unresolved product questions

Preserve the draft rather than lose the interrupted work. Do not treat its product assumptions as approved. The available issue explicitly leaves unread-event policy undecided; the named acceptance file did not appear in the working-tree enumeration described in the lane progress log. Work-tracking forbids inventing the missing answer (docs/process/work-tracking.md:78-83).

The draft chooses aggregate historical marks (migrations/0144_rail_device_marks.sql:25-28) and head initialization for newly listed devices (gateway/projects/sqlite-store.ts:329-333). Both require a product ruling before completion. Existing receipts already include a required device key (migrations/0082_app_chat_receipts.sql:43-50).

The new unknown value joins the unread-count vocabulary as null (gateway/projects/sqlite-store.ts:379); ordering treats it as read (app/lib/rail-order.ts:71). Its display was still being edited during inspection. SQL triggers maintain marks while clients are disconnected (migrations/0144_rail_device_marks.sql:35-49), but their complete correctness is unproven.

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
