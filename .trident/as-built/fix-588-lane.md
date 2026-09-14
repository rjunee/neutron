## Issue 588 — Work strip includes live board runs

### What changed

The Work Board screen now derives positive live-run evidence from the same `isLinkedRunning` predicate used by its rows and supplies it to the scope classifier (`app/app/projects/[id]/workboard.tsx:78`, `app/app/projects/[id]/workboard.tsx:273-278`). That predicate requires a bound run and excludes durable failed/blocked lanes and terminal run phases (`app/lib/work-board-helpers.ts:345-369`).

The classifier accepts the explicit signal and returns `working` before evaluating chat-turn staleness (`app/lib/work-board-activity.ts:62-70`, `app/lib/work-board-activity.ts:105-119`). Thus a live build with no chat events and a live build beside a stale chat turn both produce a pulsing Working strip; the indicator's existing `working` handling supplies that pulse (`app/lib/work-board-activity.ts:147-151`). When no live run is positively known, failure copy now visibly limits itself to the chat subject (`app/lib/work-board-activity.ts:125-135`).

The focused test covers no-chat/live-run, stale-chat/live-run, subject-qualified failure copy, and the screen-to-classifier wiring (`app/__tests__/work-board-activity.test.ts:130-150`, `app/__tests__/work-board-activity.test.ts:168-185`). Production call sites were completely enumerated with `rg -n "workActivityState\\(" app`: the screen call is at `app/app/projects/[id]/workboard.tsx:273`; the remaining matches are the definition and focused tests.

### Decisions

The new signal joins the existing `ActivityState` vocabulary as `working`, whose default indicator behavior is visible and pulsing (`app/lib/work-board-activity.ts:125-151`). No new error, verdict, state, or fallback path was introduced.

Positive live-run evidence wins over chat staleness because the strip describes the whole Work surface. Negative or not-yet-loaded board evidence does not assert that no build exists: the remaining stalled/dead copy explicitly describes only Chat (`app/lib/work-board-activity.ts:105-135`). This keeps unavailable board knowledge from becoming a permissive or broad absence claim.

The invariant is maintained continuously by the screen's existing board state: HTTP results and every live board snapshot replace `items` (`app/app/projects/[id]/workboard.tsx:167-179`, `app/app/projects/[id]/workboard.tsx:199-215`), and every render recomputes `items.some(isLinkedRunning)` into the classifier (`app/app/projects/[id]/workboard.tsx:273-278`). It does not depend on a stalled chat turn continuing to work.

### Mutation table

| Guard | Mutation | Red result | Restored result |
|---|---|---|---|
| Live-run precedence at `app/lib/work-board-activity.ts:109` | Changed the condition to `false && liveRunInFlight`; printed the landed line and diff before running | Focused test: no-chat/live-run received `idle`; stale-chat/live-run received `wedged` (17 pass, 2 fail) | Focused test: 20 pass, 0 fail, 29 assertions |
| Screen wiring at `app/app/projects/[id]/workboard.tsx:277` | Replaced `items.some(isLinkedRunning)` with `false`; printed the landed line and diff before running | Wiring assertion at `app/__tests__/work-board-activity.test.ts:184` received false (19 pass, 1 fail) | Focused test: 20 pass, 0 fail, 29 assertions |

### Verification

`bun test app/__tests__/work-board-activity.test.ts`: 20 pass, 0 fail, 29 assertions. `EXPO_NO_TELEMETRY=1 bun run --cwd app lint`: exit 0, with 21 existing warnings outside the three touched files. `bun install --frozen-lockfile`: no changes.

The prescribed `bun run --cwd app typecheck` did not reach source checking because TypeScript could not resolve an implicit library named `@types`. Supplying the installed libraries explicitly (`bun run --cwd app typecheck --types bun,react`) passed the changed sources and stopped at the unrelated existing unused suppression in `app/__tests__/support/mount.tsx:17`. That file is outside this issue's territory and was not changed.

### Deliberately not changed

Inline activity was not added to this fix; issue 588 names live bound runs, and the board already handles inline expiry separately (`app/app/projects/[id]/workboard.tsx:257-271`). The chat liveness thresholds and their `dead`-before-`wedged` ordering remain unchanged (`app/lib/work-board-activity.ts:99-119`). No feature flag or parallel classifier was added.

`SPEC.md` was not changed because this repair aligns the Work strip with the already-documented product rule that working activity is the union of a live chat turn, a live bound run, and inline activity (`docs/SYSTEM-OVERVIEW.md:1761-1769`). The full test suite was not run, per lane instructions.
