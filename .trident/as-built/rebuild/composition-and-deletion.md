## L6 partial: remove the selector restriction

### Status and scope

This is an incomplete cutover. It removes the selector restriction only. It does
not claim that a dispatched card reaches the replacement driver.

The capability result now contains continuity and native-tool wiring
(`runtime/adapters/select-substrate.ts:72`, `runtime/adapters/select-substrate.ts:80`).
The selector prohibition was removed without replacement. The duplicate hard
constraint in substrate composition was also removed; the surrounding provider
selection remains at `open/wiring/substrates.ts:104`.

The exact-shape assertion enumerates `KNOWN_PROVIDERS`, whose definition is at
`runtime/adapters/select-substrate.ts:97`, and checks their results at
`runtime/adapters/select-substrate.test.ts:33`.

### Decisions and integration boundary

The locked placement rule remains the target
(`docs/plans/harness-orchestrator-pivot-2026-09-11.md:94`). No product decision or
specification was changed. The requested lane shard location takes precedence
over the general location in `docs/process/work-tracking.md:131`.

The L5 branch's driver requires host callbacks for measurement, admission, review,
publication and merge (`trident/build-run.ts:42` in that branch). It explicitly
requires production bindings rather than permissive defaults. The composition
input in this build worktree still requires the launcher
(`gateway/composition/input/misc-input.ts:85`), and its caller constructs it
(`open/composer.ts:1134`). Both files are outside L6 territory. Integration needs
those callers changed along with the worker and host bindings.

I deliberately did not remove the workflow, its tests, launcher, crash handling,
SQL scripts, or gate-bearing orchestration before their replacement can be
composed. The retained gate owners include rebase
(`trident/orchestrator.ts:1531`), publication (`trident/orchestrator.ts:2520`),
stranded reconciliation (`trident/orchestrator.ts:3423`), and result application
(`trident/orchestrator.ts:4949`). Unsupported-mode admission remains unfinished.
No new outcome or production guard was introduced by this partial change.

### Controlled searches

The command `rg -n 'TRIDENT NOTE|detachedWorkflows|providerCapabilities'
runtime/adapters/select-substrate.ts` returns only the positive control,
`providerCapabilities` at line 80. This establishes the removal from that file.
The whole-tree search with the same tokens finds the selector/test positive
controls and historical design references at
`docs/plans/2026-09-14-trident-rebuild-design-fable.md:56`, `:61`, `:321`, and `:439`.
Those references describe the removal target and its acceptance search; they are
outside this lane and remain historical context. Whole-tree textual absence is
not claimed.

The duplicate-comment search
`rg -n 'TRIDENT STAYS CLAUDE|openaiRequested' open/wiring/substrates.ts` returns the
positive control at lines 110, 112, 129, 175 and 240 and no prohibition.

A working-tree content search
`rg -n 'export (async function buildRun|function buildRunEvidenceGatherer)' trident`
finds the positive control at `trident/run-evidence-probes.ts:176` only. This is a
statement about this checkout, not a fetched remote or another branch. The L5
source was read separately. The contract search
`rg -n '^export (interface BuildHost|function placementFor)' runtime/bounded-work.ts`
finds only the positive control at `runtime/bounded-work.ts:40`.

### Mutation evidence

| Assertion | Mutation and landing line | Red | Restored green |
| --- | --- | --- | --- |
| Exact capability result, selector test line 35 | Restore the original selector from HEAD, including the old table field at original line 94; the landing lines and diff against the fixed file were printed before execution | 7 pass, 1 assertion failure showing the extra property; exit 1 | 8 pass, 0 fail; exit 0 |

The mutated source is the original compiling implementation. The failure was an
object-equality assertion, not parsing or module loading. No test was weakened or
skipped. This is a regression assertion on returned metadata, not a runtime
routing guard.

### Validation

- Focused selector tests: 8 passed, including the regression assertion.
- Repository lint: passed.
- Typecheck matrix: exit 1; 51 configurations checked, 46 passed. The open,
  runtime and trident configurations passed. Diagnostics were reported in app,
  gateway, logger, onboarding and root configurations (type-package resolution,
  timer types and zlib types).
- Requested directory test run: exit 124 at the 180-second outer bound. It reported two
  reply-sink bind-related failures at `trident/abandon-poison-e2e.test.ts:166` and
  `trident/abandon-poison-e2e.test.ts:201`. The run has a 180-second outer bound;
  completion and green acceptance are not claimed.
- Leak gate: exit 3, incomplete. Active checks found zero findings; the external
  file/message denylist checks could not run.
- Diff whitespace check: passed. The shard has exactly one level-two heading.
