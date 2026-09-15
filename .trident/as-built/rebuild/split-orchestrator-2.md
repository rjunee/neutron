## 2026-09-15 — Extract recovery and liveness from the outer orchestrator

### Scope and fate

The ten keep-in-place rows within G111–G123 now route through
`trident/recovery-liveness.ts:80`. Enumerated all thirteen rows with
`rg -n '^\| G(11[1-9]|12[0-3]) \|' docs/trident-gates-inventory.md`, then read
both the property and fate columns (`docs/trident-gates-inventory.md:200`).
Only enforcement references changed in those inventory rows; G124's reference
to the same outer stall backstop also follows the move
(`docs/trident-gates-inventory.md:213`).

| Row | Enforcement after extraction |
| --- | --- |
| G111 | `trident/recovery-liveness.ts:81`, `trident/recovery-liveness.ts:137` |
| G112 | `trident/recovery-liveness.ts:177`, `trident/recovery-liveness.ts:179`, `trident/recovery-liveness.ts:261` |
| G113 | `trident/recovery-liveness.ts:213`, `trident/recovery-liveness.ts:225` |
| G114 | `trident/recovery-liveness.ts:237`, `trident/recovery-liveness.ts:279`, `trident/recovery-liveness.ts:609` |
| G115 | `trident/recovery-liveness.ts:310` |
| G116 | retained: `trident/orchestrator.ts:4626`, `trident/orchestrator.ts:4643`, `trident/orchestrator.ts:4669` |
| G117 | retained: `trident/orchestrator.ts:4724`, `trident/orchestrator.ts:4732`, `trident/orchestrator.ts:4743` |
| G118 | `trident/recovery-liveness.ts:339`, `trident/recovery-liveness.ts:473`, `trident/recovery-liveness.ts:512`; reprieve callback at `trident/orchestrator.ts:4811` |
| G119 | retained: `trident/orchestrator.ts:4824` |
| G120 | `trident/recovery-liveness.ts:489` |
| G121 | `trident/recovery-liveness.ts:526`, `trident/recovery-liveness.ts:542`, `trident/recovery-liveness.ts:579` |
| G122 | `trident/recovery-liveness.ts:551`, `trident/recovery-liveness.ts:563` |
| G123 | `trident/recovery-liveness.ts:473`, `trident/recovery-liveness.ts:633` |

G114 belongs with recovery because it bounds recovery claims and throwing
relaunches; G115 belongs because it resolves terminal-but-unharvestable runs
before the watchdog (`trident/recovery-liveness.ts:237`,
`trident/recovery-liveness.ts:310`). G116–G117 and G119 have the
`deleted-with-the-mechanism` fate, so their implementation remains with fire
settlement and shared-launcher reprieves in the original module
(`docs/trident-gates-inventory.md:205`, `docs/trident-gates-inventory.md:208`).
The entire positive reprieve block stays together because its selection and
restamping decision use the same evidence (`trident/orchestrator.ts:4811`,
`trident/orchestrator.ts:4824`). The watchdog calls that block at its original
position (`trident/recovery-liveness.ts:475`).

### Wiring and move proof

The factory binds the original maps, clocks, probes, launch, harvest, and failure
writer by reference (`trident/orchestrator.ts:4862`,
`trident/recovery-liveness.ts:62`). State allocation remains process-scoped in
the outer factory (`trident/orchestrator.ts:1474`,
`trident/orchestrator.ts:1480`). Existing `stepCore` and `elapsedSinceAdvance`
keep their names (`trident/recovery-liveness.ts:72`,
`trident/recovery-liveness.ts:80`). The worker-observation and salvage wrapper
still calls `stepCore` (`trident/orchestrator.ts:4870`).

The fire callback returns synchronously on ordinary fallthrough and early
outcomes (`trident/orchestrator.ts:4578`, `trident/recovery-liveness.ts:333`).
Only its original deadline branch uses an async closure around its existing
await (`trident/orchestrator.ts:4716`, `trident/orchestrator.ts:4724`). This
avoids adding an await between fire confirmation and watchdog/orphan decisions.
The nullable callback results express existing fallthrough, not new policy
outcomes (`trident/recovery-liveness.ts:334`, `trident/recovery-liveness.ts:476`).

Header/dependency style was read against `trident/gates/built-head.ts:3` and
`trident/gates/built-head.ts:15`; the exemplar binds capabilities rather than
claiming that its presence proves this extraction correct. The inventory-tagged
policy style was read at `trident/gates/review-progress.ts:15`. Those exemplars
were not edited.

Baseline: `ca9f343b2016bfa7aedce2fcbfc4f1d5da27778c`, local HEAD before this
change. Counts use `git show HEAD:trident/orchestrator.ts` and `wc -l` on the
resulting modules; new-file status uses `git status --short`.

| File | Before | After |
| --- | ---: | ---: |
| `trident/orchestrator.ts` | 5,483 | 4,932 |
| `trident/recovery-liveness.ts` | new | 646 |

The source span was baseline lines 4581–5420. A TypeScript AST comparison
reconstructed the old module from the result: unwrap the recovery factory,
inline the two callback bodies at their call sites, remove their new null
fallthrough sentinels and the deadline closure wrapper, and normalize the
structurally identical probe annotation back to `RunLiveness | 'not-wired'`.
Print statements with `removeComments: true`, excluding imports, and compare
arrays in source order. **All 47 non-import top-level statements matched**,
including the complete reconstructed outer factory. This verifies source
identity under those explicit wiring transformations; behavioral tests provide
the execution evidence below.

### Re-exports and importer enumeration

No recovery symbol was re-exported from the outer module: its direct import is
at `trident/orchestrator.ts:1`, and `rg -n '^export \{'
trident/orchestrator.ts` enumerates only the three pre-existing statements at
`trident/orchestrator.ts:4`, `trident/orchestrator.ts:5`, and
`trident/orchestrator.ts:6` (positive controls for that search).
Their six symbols retain these observed importers:

| Symbol | Importers |
| --- | --- |
| `healShallowCheckout` | `trident/publish-rebase-realgit.test.ts:39` |
| `rebaseOntoObservedBase` | `trident/publish-rebase-realgit.test.ts:39`, `trident/as-built-publish-wiring-realgit.test.ts:33` |
| `TridentRebaseConflict` | `trident/publish-rebase-realgit.test.ts:39`, `trident/as-built-publish-wiring-realgit.test.ts:33` |
| `ensureAsBuiltMergeDriver` | `trident/as-built-publish-wiring-realgit.test.ts:33` |
| `publishFailureReason` | `trident/terminal-failure-reason.test.ts:43` |
| `redactPushError` | `trident/terminal-failure-reason.test.ts:44` |

Enumeration used repository-wide `rg -n -U`, with `--glob '*.ts' --glob '*.mjs'`:

```text
(?s)(?:import|export)\s*\{[^}]*\b(?:redactPushError|publishFailureReason|healShallowCheckout|rebaseOntoObservedBase|TridentRebaseConflict|ensureAsBuiltMergeDriver|buildTridentOrchestrator)\b[^}]*\}\s*from ["\x27][^"\x27]*orchestrator\.ts["\x27]
```

The control is `buildTridentOrchestrator` at `trident/orchestrator.test.ts:19`.
Repeating the same expression with symbol alternatives
`stepCore|elapsedSinceAdvance|buildTridentOrchestrator` found the control and
no named imports of the two private helpers. This enumeration covers static
named imports/exports, not arbitrary dynamic property access.

### Validation

- `bun test trident/orchestrator.test.ts`: **305 pass, 0 fail**.
- Final combined run of that file plus `trident/crash-recovery.test.ts` and
  `trident/launch-throw-bounded.test.ts`: **320 pass, 0 fail**, 1,573 assertions.
  The latter two independently passed **15 tests**.
- All three test files are byte-identical to baseline, checked using
  `git diff HEAD --` on those paths and a direct comparison with `git show`.
  The orchestrator instrument remains 9,957 lines.
- `bunx tsc -p trident/tsconfig.json --noEmit`: **exit 0**. The first draft of
  the dependency interface omitted the branch probe's nullable result; the
  interface now preserves it (`trident/recovery-liveness.ts:51`).
- `bash scripts/ci/lint.sh`: **exit 0**, including a rerun after final wiring.
- `bash scripts/ci/depcruise.sh`: **exit 0**, 2,815 modules and 7,254 dependencies;
  eight known violations ignored. This is the layering ratchet
  (`scripts/ci/depcruise.sh:3`). Working-tree filename enumeration
  `rg --files scripts/ci | rg 'layering|depcruise|lint'` found `depcruise.sh` and
  the positive control `lint.sh`, without a `layering.sh` filename.
- `git diff --check`: **exit 0**. An inventory cell comparison also verified
  that every changed row differs only in its enforcement-reference column.

**No new guard, so no mutation table or guard mutation experiment.** The proof
is the unchanged behavioral tests and the source identity comparison. No test
assertion or fixture was changed. No whole-suite runner was used.

### Decisions and deliberate limits

No product decision, acceptance criterion, outcome vocabulary, or invariant was
changed. Existing deadline reasons still join the `infra` classification
(`trident/recovery-liveness.ts:504`, `trident/delivery.ts:742`); the recovery
budget reason still joins its existing `infra` branch
(`trident/recovery-liveness.ts:248`, `trident/delivery.ts:1054`).

The clock remains elapsed time since advancement, including the existing
run-scoped restamping policy; this extraction does not turn it into an absolute
wall-clock lifetime cap (`trident/recovery-liveness.ts:72`,
`trident/recovery-liveness.ts:468`, `trident/orchestrator.ts:4824`). The existing
comments describe both the ceiling and that qualification; no behavioral fix
was folded into the move. G111's inventory **NO TEST** assessment remains as
recorded (`docs/trident-gates-inventory.md:200`).

The merge detector and launch/harvest services remain injected outer capabilities
(`trident/recovery-liveness.ts:52`, `trident/orchestrator.ts:4866`). The retained
mechanisms and remaining orchestrator clusters await later lanes. The staged
filename enumeration is limited to these two modules, the gate inventory and
this shard; prohibited hosts, gates, workers, and execution files were untouched.
Historical source anchors elsewhere were not comprehensively refreshed.

This shard uses the explicit lane-requested `.trident/as-built/` location in
place of the repository standard's default directory. Delivery ends at a local
commit for orchestrator review; this lane does not push, open a PR, or merge.
