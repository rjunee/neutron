## 2026-09-27 — Preserve the native phase tap through touch focus

The existing dashboard acceptance requires immediate hover/focus details and
tap pinning (`docs/spec-items/temporary-build-timeline-dashboard.md:83`). A real
Chrome touch gesture at a 390 × 844 viewport exposed an ordering failure: the
compatibility mousedown focused the phase button, focus opened the bottom sheet
over that button, mouseup landed on the sheet heading, and Chrome retargeted the
click to the body. The outside-click handler then dismissed the sheet. The same
gesture with the original script was a failing control in a local HTTP fixture
using the production popover styles.

`trident/build-timeline-popover.ts:92` remembers the touch target and recognizes
its compatibility mousedown. Only that mousedown's default focus is suppressed;
the native click still opens and pins the details. Compatibility mouse events may
arrive in a later task than pointerup, so the focus suppression is established at
mousedown and expires after its task. Focus consumes it, while cancellation,
another pointer, a key, or a click clears the gesture state. Standalone focus and
mouse hover keep their immediate behavior (`trident/build-timeline-popover.ts:81`,
`trident/build-timeline-popover.ts:108`).

The focused Bun run passed 13 tests with 306 assertions across
`trident/build-timeline-popover.test.ts` and `trident/build-timeline-html.test.ts`.
The new event-ordering regression starts at
`trident/build-timeline-popover.test.ts:82`; its cancellation, missing-click,
keyboard, mouse, programmatic-focus, refresh, and dismissal controls start at
line 103. Removing the touch-focus condition produced two failing tests; blocking
all phone-width focus produced three. These tests execute the shipped script in
a small DOM fixture; they do not substitute for browser hit testing.

The local Chrome browser probe separately passed native tap pinning, ten repeated
taps, Escape, touch close, outside tap, phone keyboard focus, replacement of the
trigger during refresh, viewport width, desktop hover, and desktop keyboard
focus. No synthetic click or forced click was used. A focused strict TypeScript
check of the changed source and test passed. Served-site acceptance remains a
separate integration check; this record does not claim that the hosted dashboard
has been updated.

Independent native review and a bounded root-run cross-model review approved
the touch-event change. Both repository TypeScript checks passed on the original
candidate. Integration now includes merged revision
`520796435076461a65ab9a7f49c335a9062410a5`, whose namespace-aware process
ownership fix is required for reliable shared-host validation. Composition
changed only that fix's eight files; the reviewed popover and existing HTML
renderer remained byte-for-byte unchanged. The complete local gate below tests
the composed candidate; no receipt transfers from either constituent revision.

The complete local command
`python3 -B trident/process-test-isolation.py -- bash scripts/check-shared-host.sh`
exited 0 on frozen revision `e9b1fd40679673081dfe03110c196d9de8d1dd63`.
The checkout was clean before and after the run, with HEAD unchanged. All 51
TypeScript projects passed. Declared, Bun-discovered, assigned and executed test
file counts each equal 1,728: 1,492 general files across 15 chunks, 22 PGLite
files, 43 device files and 171 real-HTTP files. All 18 lanes passed with zero
failed lanes, using the admitted four-job shared-host profile.

The tracked-file content aggregate was unchanged before and after the gate:
`ca7dfaf771ebdc54a5173251d34be21a93370e2650b6ce8fd82daea90d7ca2e2`.
It is the SHA-256 of ordered per-file SHA-256 output for
`git ls-files -z -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs' '*.py' '*.sh' '*.md'`,
consumed by `xargs -0 sha256sum | sha256sum`. The external operator log
`dashboard-canonical-topology-complete-gate-0927.log` has SHA-256
`aa7cb4005c6878c7e62b6c443a5e0d3adae8d3f28d4e00af6dd586c3a504cb95`;
its final coverage audit accounts for every assigned file. This receipt belongs
to the tested revision above. Adding this record does not establish a gate pass
for a different revision, CI success, merge or deployment.
