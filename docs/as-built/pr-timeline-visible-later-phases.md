## 2026-10-01 — Make later recorded PR phases visible in focus rows

The default shared one-hour focus view could show only initial CI while later
fixes, reviews and tests were represented by an arrow-only overflow control.
The renderer now places a readable overflow button beneath the PR label, naming
explicit recorded categories beyond the boundary in first-start order. Three
categories appear directly; an additional-category count bounds long previews.
The full accessible label and existing popover retain every later action.
Unknown categories remain explicit and HTML-escaped; action-label inference does
not manufacture missing work. Categories crossing the boundary also appear.

The button wraps on narrow screens and has a 44-pixel minimum target height.
Its accessible name starts with its exact visible label, including the bounded
additional-category preview, before listing every recorded later category.
The shared scale, one-bar geometry, full duration label, complete API evidence,
Fit all and existing hover/focus/tap/refresh behavior remain intact. The dashboard
spec now makes visible category discovery an explicit part of overflow acceptance.

Verification: the focused renderer, popover and authenticated server tests pass,
including CI followed by overlapping fix/review/test work 86 hours later, CI-only,
unknown and absent timing, boundary crossings, deduplication and bounded previews.
Consuming popover tests load the actual rendered overflow payload and exercise
focus, click, refresh and Escape. Semantic mutations selecting first-hour work
instead of later work and inferring unknown categories from labels are rejected
by the corresponding tests. Removing the visible-label prefix from the accessible
name also fails its consuming test; bounded, escaped and unknown category labels
retain an exact accessible prefix. Root and Trident TypeScript checks pass.
This record describes the code candidate; served deployment verification remains
separate from these local checks.
