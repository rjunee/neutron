## 2026-09-15 — Extract the surviving replay cluster

### Scope and evidence

This lane delivers the replay seam, not the entire orchestrator split. G087–G097
are the eleven keep-in-place rows enumerated by
`rg -n '^\| G(08[7-9]|09[0-7]) \|' docs/trident-gates-inventory.md`
(`docs/trident-gates-inventory.md:171`). Their enforcement references now follow
the moved implementation. The outer loop remains at
`trident/orchestrator.ts:1430`.

| Inventory rows | Current enforcement |
| --- | --- |
| G087 | `trident/replay.ts:195`, `trident/replay.ts:238`, `trident/replay.ts:286` |
| G088 | `trident/replay.ts:118`, `trident/replay.ts:122`, `trident/replay.ts:142` |
| G089 | `trident/replay.ts:335`, `trident/replay.ts:353`, `trident/replay.ts:355`, `trident/replay.ts:376` |
| G090 | `trident/replay.ts:473` |
| G091 | `trident/replay.ts:484`, `trident/replay.ts:504` |
| G092 | `trident/replay.ts:410`, `trident/replay.ts:455`, `trident/replay.ts:506` |
| G093 | `trident/replay.ts:524` |
| G094 | `trident/replay.ts:492`; shared ceiling at `trident/merge.ts:311` |
| G095 | `trident/replay.ts:547` |
| G096 | `trident/replay.ts:572`, `trident/replay.ts:587`, `trident/replay.ts:589` |
| G097 | `trident/replay.ts:600` |

The replay dependencies also moved by subject: trusted driver provisioning to
`trident/as-built-merge-driver.ts:196`, redacted diagnostics to
`trident/publish-failure.ts:21` and `trident/publish-failure.ts:46`.
These helpers are dependencies, not additional inventory gates claimed as moved.
Extracting them avoids importing the outer orchestrator back into replay
(`trident/replay.ts:10`, `trident/replay.ts:11`, `trident/orchestrator.ts:1`).
The driver stays in the same directory, preserving its directory-based lookup
from `import.meta.url` (`trident/as-built-merge-driver.ts:34`).
Header style was checked against `trident/gates/built-head.ts:14` and
`trident/gates/review-progress.ts:9`; those files were only read.

### Size and move identity

Baseline: `c44841b8cbb410ef293a92ee6e5f2d184edba18a` (local HEAD before this change).
Counts come from `git show HEAD:trident/orchestrator.ts` and `wc -l` on the
resulting four files; new-file status was checked with `git status --short`.

| File | Before | After |
| --- | ---: | ---: |
| `trident/orchestrator.ts` | 6,399 | 5,483 |
| `trident/replay.ts` | new | 609 |
| `trident/as-built-merge-driver.ts` | new | 280 |
| `trident/publish-failure.ts` | new | 52 |

All 60 top-level statements other than imports/re-exports compare identically:
parse the baseline and all four resulting modules with TypeScript, print each
statement with `removeComments: true`, sort, and compare the arrays. This
includes declaration bodies, constants, types, signatures, and export modifiers.
The moved source spans were baseline lines 875–924, 1113–1210, 1211–1481,
and 1482–1980. One private provenance name in a moved comment was generalized
under the lane's public-tree rule (`trident/replay.ts:306`). Runtime code was
not redacted or rewritten. New headers and module wiring account for the size
increase across the four files.

### Re-exports and enumeration

All six retained re-exports are at `trident/orchestrator.ts:3`,
`trident/orchestrator.ts:4`, and `trident/orchestrator.ts:5`.
The following table enumerates their static importers outside the original module.

| Symbol | Importers justifying compatibility |
| --- | --- |
| `healShallowCheckout` | `trident/publish-rebase-realgit.test.ts:39` |
| `rebaseOntoObservedBase` | `trident/publish-rebase-realgit.test.ts:39`, `trident/as-built-publish-wiring-realgit.test.ts:33` |
| `TridentRebaseConflict` | `trident/publish-rebase-realgit.test.ts:39`, `trident/as-built-publish-wiring-realgit.test.ts:33` |
| `ensureAsBuiltMergeDriver` | `trident/as-built-publish-wiring-realgit.test.ts:33` |
| `publishFailureReason` | `trident/terminal-failure-reason.test.ts:43` |
| `redactPushError` | `trident/terminal-failure-reason.test.ts:44` |

Enumeration used repository-wide `rg -n -U` with this expression, scoped to
`--glob '*.ts' --glob '*.mjs'` (the last alternative is the positive control):

```text
(?s)(?:import|export)\s*\{[^}]*\b(?:redactPushError|publishFailureReason|healShallowCheckout|rebaseOntoObservedBase|TridentRebaseConflict|ensureAsBuiltMergeDriver|buildTridentOrchestrator)\b[^}]*\}\s*from ["\x27][^"\x27]*orchestrator\.ts["\x27]
```

It found the imports above and the control at `trident/orchestrator.test.ts:19`.
This is a static named-import enumeration, not a claim about arbitrary dynamic
property access. Each re-export has an observed user regardless of that limit.
The re-exports reference the single moved implementation; no wrapper or copied
implementation was introduced (`trident/orchestrator.ts:3`).

### Validation

- `bun test trident/orchestrator.test.ts`: **305 pass, 0 fail**; the entire
  9,957-line file is unchanged, verified with `git diff HEAD --` on that file.
- `bun test trident/publish-rebase-realgit.test.ts trident/as-built-publish-wiring-realgit.test.ts trident/terminal-failure-reason.test.ts`:
  **115 pass, 0 fail**. These test files are unchanged.
- `bun test trident/diff-base-option-shaped.test.ts`: **42 pass, 0 fail**.
  Its existing operand inventory first failed after the move (41 pass, 1 fail),
  because it still assigned `await localForkPoint()` to the old file. Only
  file inventories/locations were updated (`trident/diff-base-option-shaped.test.ts:877`,
  `trident/diff-base-option-shaped.test.ts:1105`,
  `trident/diff-base-option-shaped.test.ts:1124`,
  `trident/diff-base-option-shaped.test.ts:1131`). Assertions were not loosened;
  the operand is still tested at its new location (`trident/replay.ts:348`).
- `bunx tsc -p trident/tsconfig.json --noEmit`: **exit 0**.
- `bash scripts/ci/lint.sh`: **exit 0**.
- `bash scripts/ci/depcruise.sh`: **exit 0**, 2,810 modules and 7,236 dependencies;
  eight existing violations ignored, no new violations. This is the repository's
  layering ratchet (`scripts/ci/depcruise.sh:3`). Working-tree filename enumeration
  `rg --files scripts/ci | rg 'layering|depcruise|lint'` found `depcruise.sh` and
  the positive control `lint.sh`, with no `layering.sh` filename in that checkout.

No new guard was added, so **no mutation table or guard mutation experiment**.
The proof is the unchanged behavioral tests plus declaration identity. The
source-location test's observed red-to-green transition verifies that its
inventory follows the move; it is not presented as a guard mutation.

### Decisions and deliberate limits

No product decision or spec acceptance criterion changed. No new outcome or
invariant was introduced. The existing conflict class remains
`TridentRebaseConflict` (`trident/replay.ts:99`), and publication failure
classification remains in `trident/orchestrator.ts:889`.

The remaining orchestrator gates and execution layer were deliberately left for
later lanes; this change does not claim that execution deletion is ready. No
changes were made to the prohibited build hosts, gates directory, or worker
runtime (verified in the staged filename list). No whole-suite runner was used.
The existing conflict-marker limitation for diff3 markers remains documented at
`trident/replay.ts:18`; it was not fixed inside this move. Historical source
anchors outside the eleven inventory rows were not comprehensively refreshed.

The record uses the explicit lane-requested `.trident/as-built/` path rather
than the repository standard's default shard directory. No push, PR, or merge
is part of this lane; the orchestrator reviews the local commit.
