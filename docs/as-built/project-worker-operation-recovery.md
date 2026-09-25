## 2026-09-24 — Reserve worker operations without wedging project ownership

Issue #1282 is integrated into the stopped worker-placement change at
`4da4cba8963938a4ef99d64b608b777169c61a72`. This supersedes the recovery claims
in `place-cross-provider-bounded-workers.md` under “Major: one failed worker tab
wedged the whole project scope”: retaining a ready workspace alone did not
prevent a second allocation for a worker whose reply was lost, and a typed
server error did not establish that workspace or Chat allocation never occurred.
The historical record remains unchanged; the current spec now states the
operation-reservation contract and its accepting/refusing checks.

The independently reviewed operation-keyed implementation replaces that recovery
path. The caller threads its existing stable dispatch key to a durable manager
reservation with a digest of snapshotted argv, environment, cwd, scope and task
label. After acknowledged workspace and Chat setup, a pending worker operation
coexists with ready workspace ownership. Chat ordering and worker allocation
share the operation's conservative failure handler. A failed ordering or
allocation therefore leaves that operation ambiguous while distinct verified
workers can proceed. Pending, ambiguous and completed same-key retries refuse;
changed payloads refuse separately. Completed placement is not an adoption API.

Workspace creation and Chat repair keep their scope reservation on both typed
and transport errors. No error code is classified as proof of no allocation.
Lost or malformed replies cannot purchase a second pane. Per-operation updates
merge without overwriting another operation or invalidating its workspace
preparation. Both available and unavailable caller paths reserve their cleanup
receipt exclusively, so a duplicate call cannot erase an earlier pane's identity.

The first-worker failure retains inert Chat. Legacy pending workspace journals,
unknown operation outcomes and orphan followers still require reconciliation;
there is no automatic retry, pruning or lifecycle completion claim.

Integration preserved the stopped head's host banner, follower-script digest,
detached recovery retirement, and deterministic discovery sorting. The only
textual overlap outside the replaced manager/tests was the caller's crypto
import; its added digest dependency was retained. The consuming E2E assertions
now expect one reserved workspace-creation attempt for typed errors as well as
transport failures, while the native build still completes unplaced.

Focused manager/strict-host/caller validation passed 69 tests before mutation.
Six integrated semantic mutants were rejected and restored: permitting same-key
dispatch, refusing all distinct operations, retaining scope-wide pending state,
clobbering other worker receipts, dropping the caller's key, and releasing
workspace creation on a typed error. The A/B/B/C caller tests cover both a
transport loss and a typed error after allocation, preserving the operation
reservation and existing cleanup receipts while placing C.

Final validation on this integration over the pinned stopped-run head:

- Manager, strict-host, caller, three native worker runners and Open terminal
  composition: 219 tests passed across seven files, 1,252 assertions.
- `bun test open/__tests__/project-build-e2e.test.ts -t
  'cross-provider|General-scoped|a refused placement|no terminal host'`: five
  tests passed, 51 assertions; 304 unrelated cases were filtered out. This
  invocation permits the local Unix-socket broker required by those tests.
- `bunx tsc --noEmit -p tsconfig.json` and
  `bunx tsc --noEmit -p trident/tsconfig.json`: both passed after a local
  frozen-lockfile dependency installation.
- ESLint over the six changed TypeScript files and `git diff --check`: passed.
- The public leak gate over the eight changed files: zero findings, SILENT.
  This is a changed-file scan, not a full-tree purity pass.

No full host suite or live deployment is claimed by this auxiliary change.
