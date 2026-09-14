## Issue 783 — `/status` joins the process census

### What changed

`/status` now obtains `active_trident_runs` from the shared `countActiveBuildRuns()` process census (`open/composer.ts:169`, `open/composer.ts:4270-4274`) instead of counting non-terminal database rows. Known census results therefore preserve exact zero and live lane counts, while the shared counter throws for an unknown census (`trident/active-runs.ts:41-44`) rather than manufacturing zero.

The scoped regression test pins the production binding to the shared census and excludes the former row read (`open/__tests__/status-active-build-census-wiring.test.ts:24-36`). It also exercises exact zero, a live count, stale rows that do not contribute, and an unknown census (`open/__tests__/status-active-build-census-wiring.test.ts:38-49`).

### Decisions

The change reuses the existing `FleetSnapshot.status` vocabulary and `countActiveBuildRuns()` behavior instead of adding another sentinel or outcome type. Unknown throws at `trident/active-runs.ts:41-44`; the existing chained command-filter boundary logs a thrown filter and continues, ultimately returning the unclaimed-command default `null` (`gateway/boot-chat-command-filters.ts:35-51`). Thus failure cannot render the meaningful answer `Active builds: 0`.

Tracked TypeScript consumers were enumerated with `git grep -n -E 'active_trident_runs|pending_reminders' -- '*.ts'`; `pending_reminders` was the positive control. Production hits were the snapshot contract and formatter (`gateway/boot-chat-command-filters.ts:258-303`) plus the composer's fallback and bound snapshot (`open/composer.ts:2045-2057`, `open/composer.ts:4251-4281`). The formatter interpolates the exact number and has no zero branch (`gateway/boot-chat-command-filters.ts:295-303`).

### Mutation evidence

| Guard | Mutation | Red | Restored | Green |
|---|---|---|---|---|
| `/status` calls `countActiveBuildRuns()` at `open/composer.ts:4274` | Replaced that exact line with `boardRunStore.listNonTerminal().length`; `nl` printed the mutation at line 4274 | `bun test open/__tests__/status-active-build-census-wiring.test.ts`: 1 failed, expected census call was absent | Restored the census call; `nl` printed it at line 4274 | `bun test open/__tests__/status-active-build-census-wiring.test.ts trident/active-runs.test.ts`: 9 passed, 0 failed |

### Verification

- `bash scripts/ci/typecheck-all.sh`: 51 configurations checked, all passed.
- `bash scripts/ci/lint.sh`: passed all lint and repository guards.
- `bun test open/__tests__/status-active-build-census-wiring.test.ts trident/active-runs.test.ts`: 9 passed, 0 failed.
- `git diff --check`: passed.

### Deliberately not changed

The shared census implementation and its established unknown semantics were not changed (`trident/active-runs.ts:21-44`). The `StatusSnapshot` shape remains numeric (`gateway/boot-chat-command-filters.ts:258-268`), because known zero is valid and unknown already travels through the command chain's throw boundary. Reminder and work-item best-effort behavior remains unchanged at `open/composer.ts:4256-4269`; those fields are outside this issue's process-census scope.
