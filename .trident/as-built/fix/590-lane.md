## Issue 590 — make the work-board status indicator inert

### What changed

The active-row status dot is now an inert `View` with a test identifier at `app/components/WorkBoardRow.tsx:244`. Worker inspection remains available through a separately labelled action at `app/components/WorkBoardRow.tsx:304`. The status action now says `Start progress` or `Mark done` at `app/components/WorkBoardRow.tsx:298`, so its effect is visible before activation.

The destructive direction is confirmation, not recovery after mutation. An in-progress item opens a cancelable confirmation with `Keep in progress` as the cancel action before `onAdvance` can mark it done at `app/components/WorkBoardRow.tsx:219`. Other active statuses continue immediately through the same callback at `app/components/WorkBoardRow.tsx:220`.

### Decisions

The dot was made inert even though the current tree had repurposed it for worker inspection, because an indicator should not hide any action. Inspection moved into the existing action cluster rather than being removed. Completion uses the component's existing `Alert.alert` confirmation vocabulary, whose cancelable default preserves the current state; deletion already uses that vocabulary at `app/components/WorkBoardRow.tsx:206`.

This adds no new error, verdict, state, or refusal. Status values remain classified by `WORK_BOARD_STATUSES` at `app/lib/work-board-client.ts:53`; this change only changes how the existing transition is initiated.

### Verification

Focused device-shaped coverage proves the indicator has no role or mutation callback and proves inspection remains reachable at `app/__tests__/work-board-row-brief-alert.test.tsx:78`. It proves completion does not fire before explicit confirmation at `app/__tests__/work-board-row-brief-alert.test.tsx:100`, and proves the non-destructive start action remains immediate at `app/__tests__/work-board-row-brief-alert.test.tsx:125`.

| Guard | Mutation | Red result | Restored result |
|---|---|---|---|
| Inert status indicator | Replaced the indicator `View` with a `Pressable` wired to `onAdvance` at `app/components/WorkBoardRow.tsx:244` | `keeps the status dot inert...` failed because the callback recorded `item-a` | Focused file: 6 pass, 0 fail |
| Completion confirmation | Called `onAdvance` and returned at `app/components/WorkBoardRow.tsx:220` | `confirms the destructive done transition...` failed before confirmation | Focused file: 6 pass, 0 fail |
| Action names its transition | Replaced the status-specific label at `app/components/WorkBoardRow.tsx:299` with `Advance status` | Both `Mark done` and `Start progress` reachability cases failed | Focused file: 6 pass, 0 fail |

`bun test app/__tests__/work-board-row-brief-alert.test.tsx` passed 6 tests. `EXPO_NO_TELEMETRY=1 bun run --cwd app lint` completed with zero errors and 21 existing warnings outside the touched files. `bun run --cwd app typecheck` could not enter source checking because the installed type roots request a missing `@types` library. A constrained compiler diagnostic reached source checking and found only the existing unused suppression at `app/__tests__/support/mount.tsx:17`.

### Deliberately not changed

The parent screen's existing status mutation requests at `app/app/projects/[id]/workboard.tsx:433` were not changed; the row now gates the completion callback before that request is invoked. The web work-board surface was not changed because the filed territory names the mobile row. No specification decision changed.
