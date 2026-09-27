## 2026-09-27 — Distinguish PR creation and observed phase clock times

The timeline previously exposed durations without a readable local clock context.
The catalogue now retains GitHub's creation timestamp independently of the work
envelope (`trident/build-timeline-catalogue.ts:63`), through the optional
`TimelineCard.createdAt` field (`trident/build-timeline.ts:72`). Earlier recorded
work does not move the PR's opened time; invalid or future creation timestamps
remain null and absent catalogue metadata remains unknown.

The rendered PR row and expanded evidence distinguish opened time from the first
recorded work timestamp (`trident/build-timeline-html.ts:75`). Phase evidence and
popovers carry recorded start and completion timestamps; an unrecorded end remains
unknown. Browser formatting uses a local date, timezone and 12-hour AM/PM clock,
and runs again after fragment refresh (`trident/build-timeline-html.ts:126`).
The shared browser formatter lives in `trident/build-timeline-popover.ts:9`.
The initial server-rendered timestamp is explicitly UTC. Incomplete phase
evidence stays disclosed without requiring an optional correction phase. This change does not
reconstruct historical phases, infer missing boundaries or allocate token usage.

On the combined candidate, `bun test trident/build-timeline.test.ts
trident/build-timeline-html.test.ts trident/build-timeline-popover.test.ts
scripts/__tests__/build-timeline-server.test.ts` passed 35 tests with 497
assertions. Checks include earlier work versus later PR creation, absent and
invalid metadata, explicit epoch zero, local clocks across midnight, completed
versus unrecorded phase ends, incomplete versus build/review coverage without
optional fixes, and refreshed pinned popovers. The HTTP fixture required a
permitted loopback listener. An initial run caught a missing formatter in the
standalone popover consumer; the shared formatter fixes that dependency.
Both `bunx --no-install tsc --noEmit` and
`bunx --no-install tsc --noEmit -p trident/tsconfig.json` exited zero after the
combined repair. The changed-file privacy scan with the local denylist found
zero findings; the commit-message scan also passed.
CI, shared-host validation and served browser verification remain separate
release checks; this record does not claim deployment or complete historical
phase coverage.
