## 2026-09-28 — Manual exact native task registration

The native task importer required operators to hand-edit private turn bindings.
The registration command now verifies a native session/turn context and the
existing config's repository scope before adding one explicit phase/PR binding.
It derives the refresh/recorder observation lock from the operator's trusted
`observationJournal` config field; a caller-supplied path must match exactly.
It writes the private config by atomic
replacement at mode 0600, treats identical retries as no-ops, and refuses changed
attribution. Existing observation journal bytes are never edited.

Six focused tests, with 114 assertions, exercise root and child build/fix/review/test
tasks through native completion import and the authenticated dashboard API. They
also prove wrong session/turn/repository and duplicate-link rejection, immutable
attribution, shared-lock refusal, private transcript/path exclusion and unknown
tokens when receipts are missing. Start/end, model and disjoint token counts come
from native receipts, not registration time or parent ownership.

The registration, importer and dashboard API suites together pass 35 tests with
369 assertions. A deterministic barrier holds the first registration lock while
a distinct turn is refused; retry after release preserves both bindings.
Inverting native-turn existence causes four test failures;
weakening the attribution-conflict predicate causes the immutability test to
fail. Both mutations were reverted and the focused suites rerun successfully.
The changed-file purity scan is silent; the full-tree local scan reports
pre-existing baseline findings and the linked worktree metadata path.

Publication timing deviation: draft PR #1380 was opened before the required
shared-host gate while its admission lock was held by another change. The draft
must remain unready until the exact candidate passes that gate and review. No
deployment followed publication. Subsequent pushes require the gate to be green.

This change supplies a manual registration seam. It does not intercept native
dispatch, discover new rollout/config sources, emit active task intervals, infer
historical phases or prove automatic all-PR coverage. Those producer limitations
remain tracked by #1313. No deployed configuration is changed by this PR.
