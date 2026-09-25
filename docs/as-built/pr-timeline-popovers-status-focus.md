## 2026-09-25 — Explicit PR state, phase popovers and a useful time scale

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
