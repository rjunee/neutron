## 2026-09-19 — Host admission checks the complete publication history

The worker-side commit wrapper is not the publication authority: a worker can
report completion while a prohibited trailer remains in an ancestor beneath a
clean tip. The host now refuses publication before push, and independently
refuses local or PR merge, when the pinned launch-base-to-reviewed-head range
contains a case-insensitive `Claude-Session:` line. Harmless body mentions and
`Co-Authored-By` remain allowed; messages are never rewritten by this guard.
This preserves the existing gate and unattended-merge requirements in
`docs/spec-items/the-orchestrator-owns-the-build-loop.md:56` and `:64`.

The new checks in `trident/production-host-effects.ts:372`, `:424` and `:431`
retain the existing snapshot, ownership, lease, remote readiness and pinned
merge checks. The PR merge check runs after readiness has witnessed both the PR
and fetched remote head against the exact reviewed OID. Already published PRs
are not exempt. This is admission, not repair: it does not withdraw or rewrite
commits already created or published, nor claim that a live card has merged.

`trident/gates/commit-message-readiness.ts:17` accepts only full immutable OIDs,
checks commit identity and launch ancestry, refuses shallow history, and
disables replacement objects and legacy grafts. Its range operands use the
shared Git range factory. File-backed enumeration is checked against an
independent `rev-list --count` witness (`:41`), so a valid prefix cannot silently
omit ancestors. Raw commit-object reads avoid capped stdout and formatted-message
truncation; each raw object is rehashed before its message is checked (`:55`).
Only absent or explicit UTF-8/utf8 encoding declarations with valid UTF-8 message
bytes are admitted (`:66`). Unsupported or duplicate declarations and invalid
bytes fail closed, including an IBM037 trailer Git would transcode into the
prohibited token. This intentionally also refuses clean non-UTF-8 messages;
there is no unvalidated fallback decoder. Missing, malformed or failed evidence
refuses admission without echoing messages or Git stderr.

Real-Git tests in `trident/gates/commit-message-readiness.test.ts` cover a dirty
ancestor beneath a clean tip, merged side history, large messages, replacement
objects, grafts, NUL-bearing objects, encoded messages, valid-prefix truncation,
invalid pins, reversed or unrelated history, command failures, and missing or
malformed output. Adjacent production
host tests directly exercise publication and independent pre-merge refusal,
including an already published PR and local merge. The consuming
`open/__tests__/project-build-e2e.test.ts` drives the real host with a completed
fake worker: fresh dirty history creates no PR, previously published dirty
history remains OPEN, and clean history with body mentions and coauthors
reaches MERGED. Publication precedes review, so these dirty runs stop after
plan/build with the specific commit-message admission cause.

Validation: the complete consuming E2E, production host and new gate suites
passed together after the review fixes (196 tests); the range-factory and range-scanner suites passed
(68 tests). Root, open and trident TypeScript checks, targeted ESLint and
`git diff --check` passed. On the final raw-object implementation, changing the
matcher to miss the prohibited token made four negative controls RED, including
both consuming runs actually reaching MERGED. Overmatching every token mention
made three clean controls RED, including the consuming run refusing publication.
Deleting only the second, pre-merge check made the already-published PR unit
control RED independently of the working pre-push check. Mutations were restored.

Independent review reproduced two gaps in the initial draft: an IBM037-encoded
trailer bypassed its Latin-1 scan, and a valid-prefix enumeration omitted a dirty
ancestor. Both regressions were RED before the encoding and count checks above.
Reverting to the unchecked byte scan makes the encoding regressions RED;
rejecting every explicit encoding makes the valid UTF-8 control RED. Permitting
a short count makes the truncated-history regression RED, while rejecting a
matching count makes the complete clean-history control RED. The pre-merge
ordering test now requires both fetch and log observations to exist before
comparing their indices.
