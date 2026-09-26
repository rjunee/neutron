## 2026-09-25 — Explicit PR state, phase popovers and a useful time scale

This UX follow-up addresses #1329. Its normative scope remains in
`docs/spec-items/temporary-build-timeline-dashboard.md`.

The first compact chart still relied on native hover titles for tiny phase spans,
unlabeled lifecycle dots and a maximum-duration scale that compressed ordinary PRs.
The chart now groups Open PRs first, with a visible section heading and subtle row
accent, followed by Merged & closed. Activity is newest-first inside each section,
before pagination. Explicit lifecycle pills are independent of work signals.

The aggregate `active` field is not a liveness source. Running CI requires explicit
current-head provider `in_progress` status, a successful sample and evidence no
older than 60 seconds. Queued/pending status stays distinct. A recorded phase ending
within 10 minutes is labeled Recent work, without claiming it is still running.
Otherwise the chart says No live signal. The collector preserves its running status
through both incremental and full catalogue refreshes, and rejects invalid provider
statuses rather than promoting them to pending work.

The default 0–1h focus window retains a shared linear scale. Longer bars clip at the
window boundary, retain full duration labels and expose later phases through an
overflow control. Fit all restores the full shared range. Crossing actions state
that their displayed duration is the full action, not just the clipped portion.

Custom popovers open immediately on hover or focus and pin on tap. They lead with
the phase/action, wall duration and tokens, with model identity secondary. Unknown,
partial and explicit zero accounting retain their existing meanings. A full-size
duration control exposes every action even when its geometric segment is too small
to tap. Stable trigger identity preserves popovers, scroll and keyboard focus across
refresh. Escape, close and outside interaction dismiss them. Full PR evidence is
still available from the row or the popover action. Phone popovers are bounded to
the viewport and scroll internally.

Validation includes consuming projection, catalogue, HTTP and rendering tests for
status freshness, malformed status, cache preservation, recent-versus-live work,
grouping before pagination, focus clipping, overflow access and unknown accounting.
The focused dashboard/importer run passed 47 tests. Root and Trident TypeScript
checks and changed-file lint passed. Runtime semantic mutations failed as required
when stale status was promoted to live, valid fresh status was suppressed, or the
outlier maximum replaced the focus scale; restored code passed the same checks.
Authenticated Chromium preview checks covered desktop/phone screenshots, section
boundaries, phase hover, tap/keyboard explorer, Fit all, preserved popover/focus on
refresh, reliable dismissal and no horizontal page overflow. Independent review
identified and prompted fixes to status cache propagation, malformed status,
boundary labels, tiny targets and refresh focus. Deployment must update both the
standalone server revision and the collector's source revision; operational proof
is recorded after merge rather than claimed by these preview observations.

The recovered shared-host validation on 2026-09-26 tested revision
`78270cfca92806a653baf71a0ad86531031f7fca` with
`bash scripts/check-shared-host.sh`: all 51 TypeScript projects passed, followed
by the complete suite with 1,692 declared, Bun-discovered, assigned and executed
files (1,458 general, 22 PGLite, 43 device and 169 real-HTTP). All 18 bounded-memory
lanes passed with zero failed lanes. The wrapper used jobs=4, chunk-size=100 and
runner-default concurrency. An initial sandboxed invocation passed the same
typecheck matrix but refused the loopback preflight before discovery; the
successful invocation had host loopback access. Full logs were retained locally.
This receipt belongs to the tested revision; the publication commit adds this
record and does not transfer local exact-revision proof to a new head. Exact-head
CI and operational deployment verification remain separate gates.

The dependency layering check passed with no new violations. The local purity
scan is not green: the existing local denylist produces 451 findings in the
current-main archive; a working-tree scan adds its untracked Git pointer as a
452nd finding. Publication still requires authoritative CI purity, with the
candidate archive comparison and commit-message/PR-text scans checked separately.
