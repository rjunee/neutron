## 2026-09-25 — Readable PR timeline chart

The temporary dashboard put every concurrent phase on its own 42-pixel lane.
Twenty-five overlapping CI jobs made a single PR occupy most of a desktop
viewport; the explanatory preamble pushed the first phone chart below the fold.

The renderer now gives each PR one fixed-height bar and keeps labels and duration
outside it. Time is partitioned at phase boundaries, preserving a common linear
wall-clock scale without summing concurrent work. Concurrent recorded categories
share a bar's height. An unrecorded end is shown with neutral hatching and a dashed
outline, rather than claiming continuous recorded phase coverage. Hover exposes
phase information; native details disclosures expose all receipts, models,
unknown token values, timestamps, legacy totals and coverage notes on click or
keyboard activation. Search and repository filters cover the catalogue before
pagination. Unpublished runs remain in the authenticated JSON API.

The default and bookmarked page both use the observed-work window. Automatic
refresh preserves open PR details and queues filter changes made during an
in-flight fetch. Basic authentication and the script-hash CSP are retained.

Validation: consuming dashboard tests cover authorization, file sources, unknown
accounting, interval geometry, parallel versus sequential phases, unrecorded ends,
filtering and pagination. Root and Trident TypeScript checks and changed-file lint
passed. Authenticated Chromium preview with current data was inspected at 1440×1000
and 390×844: ten desktop rows and five phone rows fit in the initial view, without
horizontal document scrolling. Browser interactions verified hover descriptions,
click/Enter disclosure, phone disclosure, exact PR search, repository filtering,
truthful model/unknown token details, and absence of browser errors. Independent
review identified and prompted corrections to unrecorded-end coloring, refresh
queuing and stale lifecycle bookmarks. Production deployment is verified separately
after merge, not claimed by these preview observations.
