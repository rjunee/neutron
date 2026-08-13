# General renders Chat · Work · Docs, and its Docs tab works

**Landed:** 2026-08-09 · **PR:** #147 · **Surface:** mobile app (`app/`)

## What the owner saw

One screenshot of the General scope on the APK, reported as two bugs:

1. the tab bar read **Chat / Apps / Tasks / Reminders / Docs / Settings** — no Work
   tab, Docs in fifth place;
2. inside Docs, the raw validator string `invalid_project_id: project_id must be
   1-128 chars from [A-Za-z0-9_.-]` where the file tree should be.

It was **one** defect.

## Root cause

The mobile rail spells the General scope `~general`. The `~` is deliberately
OUTSIDE the gateway's `[A-Za-z0-9_.-]` project-id alphabet so the sentinel can
never collide with a real project — which means any client that sends it RAW to a
project-scoped surface gets a 400.

Two clients did:

- `tabs-client.ts` → `GET /api/app/projects/~general/tabs` 400'd. The layout
  **swallows** a failed tabs fetch by design ("whatever this scope already had
  stands"), so General silently kept the PRE-FETCH loading default — which is
  exactly the legacy set in the screenshot — **forever**. The ordering was never
  wrong; the real tab set had never arrived.
- `docs-client.ts` → the same 400 on all 21 of its path builders. There it had
  nowhere to hide, so it rendered as the validator string.

`work-board-client.ts` and `activity-client.ts` had each already hit this and each
fixed it with its own private copy of the mapping plus a parity test. Two copies
read as a convention; it is what let the third and fourth client forget.

## What changed

- **New `app/lib/general-scope.ts`** — the one place General changes spelling.
  Import-free on purpose (every consumer is an RN-free client that must not gain
  the rail-view import chain), with a parity test pinning the duplicated constant
  to the rail's. `httpProjectSegment` maps `null` / `''` / `~general` → `general`
  and passes every named id through, matching EXACTLY so a project merely starting
  with the sentinel is not redirected at the General root.
- `work-board-client.ts` + `activity-client.ts` now delegate; their private copies
  are gone, public names unchanged.
- `docs-client.ts` routes all 21 builders through it; `tabs-client.ts` its one.
- **`generalScopeTabs`** (`project-tabs.ts`) narrows General to the three tabs a
  no-project scope can actually serve — `chat`, `work_board`, `documents`. Applied
  in the layout AFTER the Work injection, so General's pre-fetch frames show the
  right three too. Registry order gives Chat (0) · Work (5) · Documents (10), so
  Docs is third in General exactly as it is in a named project.
- **Also fixed, found by the test rather than reported:** the shell fired
  `GET /projects/~general/settings` on every General open, three times per mount,
  since it was written. Guaranteed 400, and nothing consumed the answer — the
  layout synthesises `GENERAL_SCOPE_PROJECT` for the chrome precisely because
  there is no row to fetch. `project-state.tsx` no longer asks.

## Why the tests bind

`general-tab-set.test.tsx` mounts the real layout and its fake gateway
**replicates the server's validator** — any id outside the alphabet gets the same
400 with the same code and message, and every rejected path is recorded. A stub
that answered `~general` happily would let the shipped defect pass with the tab bar
looking right and the Docs pane as broken as the owner found it. That assertion is
what surfaced the third request above.

Mutants killed: reverting the tabs-client mapping fails the order test AND the
no-sentinel test; applying the narrowing unconditionally fails the named-project
test (which guards Settings, the only route to a project's credentials UI).

`general-scope.test.ts` asserts on **fetched URLs**, not on the mapper: a test that
only checks `httpProjectSegment('~general') === 'general'` passes with every client
still sending the sentinel — which is the state that shipped, twice over.
