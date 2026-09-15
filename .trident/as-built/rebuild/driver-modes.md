## 2026-09-15 — Build driver modes and resume

### Change and evidence

The driver accepts Ralph, wave, bound-PR and resume work through the same bounded worker and host measurement loop. Mode-specific inputs and host effects are declared at `trident/build-run.ts:50` and `trident/build-run.ts:61`; every completed worker trailer still passes `corroborates` at `trident/build-run.ts:237`.

- Ralph selects the continuation planner only after a clean handoff and outside the five-round refresh interval (`trident/build-run.ts:200`). Committed plan bytes use independently supplied SHA-256 and count measurements (`trident/build-run.ts:205`), and replace the planner's body, task and remaining count (`trident/build-run.ts:259`). Intermediate work requires an acknowledged atomic host handoff before returning `continued` (`trident/build-run.ts:280`). Terminal tasks reach the shared review/publication loop (`trident/build-run.ts:297`).
- Wave replaces the planner's selection with the unchecked pinned line (`trident/build-run.ts:264`) and requires a full measured commit before returning `built`, without entering review (`trident/build-run.ts:275`). Wave resume revalidates and builds that task (`trident/build-run.ts:183`).
- Bound-PR admission requires the requested open identity (`trident/build-run.ts:163`). Worker completion and publication recheck that identity (`trident/build-run.ts:238`, `trident/build-run.ts:335`).
- Resume loads host checkpoints, preserves pending worker identity, and inherits spent rounds (`trident/build-run.ts:152`, `trident/build-run.ts:176`). A full matching head enables a regenerated pinned-OID diff; a missing/moved head rebuilds; an unreadable required head stops (`trident/build-run.ts:178`). Empty regenerated diffs rebuild (`trident/build-run.ts:187`). Only actionable code findings skip directly to a fix (`trident/build-run.ts:191`); prior finding classes and the round ceiling remain enforced (`trident/build-run.ts:289`).

### Decisions and maintained invariants

SHA-256 replaces the old relay checksum format at the new host seam: it verifies exact committed bytes without introducing another checksum implementation (`trident/build-run.ts:37`, `trident/build-run.ts:207`). Planner selection is passed to the existing bounded plan worker through host preparation (`trident/build-run.ts:224`). This lane does not choose new model defaults.

The driver owns sequencing, corroboration, review budgets and handoff acknowledgement. It does not rely on a worker to preserve them (`trident/build-run.ts:217`, `trident/build-run.ts:284`, `trident/build-run.ts:304`). Ralph task numbers enter step identity so separate iterations cannot reuse the same worker key (`trident/build-run.ts:219`). A pending resume returns unknown without dispatching its worker (`trident/build-run.ts:153`). The host must reconcile an uncertain external write before invoking the driver again (`trident/build-run.ts:55`).

The durable adapter must implement `advanceRalph` as one idempotent transaction that consumes the old result, releases the old worker slot and advances the checkpoint/round while checking the expected head. It must preserve the clean/deviated checkpoint distinction and the existing outer Ralph budget. This is the explicit host contract (`trident/build-run.ts:55`), matching the existing reset and budget enforcement read at `trident/orchestrator.ts:4874` and `trident/orchestrator.ts:4904`. The driver tests exercise an in-memory adapter and acknowledgement failures (`trident/build-run.test.ts:373`, `trident/build-run.test.ts:386`); they do not prove database atomicity. Durable adapter wiring belongs to the other lane under the supplied ownership boundary.

The added `built` and `continued` outcomes join `BuildRunOutcome` (`trident/build-run.ts:97`). Their causes reuse `wave-member-built` and `ralph-task-built`; `terminalCauseReason` intentionally returns null for both, leaving no invented failure sentence (`trident/terminal-cause.ts:248`). Refusals and unknowns retain the existing gate vocabulary: blocked goes to the orchestrator, unknown preserves its step, and only allow proceeds (`trident/build-run.ts:132`). A bound PR that is not open is blocked at admission rather than treated as a fresh change (`trident/build-run.ts:164`).

No product decision changed: this implements the specified gate preservation. All four worker capabilities remain admission requirements, including for wave (`trident/build-run.ts:142`).

### Validation

- `bun test trident/build-run.test.ts`: **83 pass**, including the 55 retained fresh-driver tests and 28 mode/resume tests.
- `bun test trident/inner-workflow-gates.test.ts trident/inner-workflow-plan-next.test.ts trident/inner-workflow-resume.test.ts trident/inner-workflow-ralph-refire.test.ts`: **183 pass**.
- `bun test trident/orchestrator.test.ts --test-name-pattern 'a child built result|intermediate Ralph|a 3-task plan re-fires|a Ralph build that never converges|intermediate re-fire never leaves'`: **6 pass**, 295 filtered out.
- `bunx tsc --noEmit -p trident/tsconfig.json`: **pass**. `bun run typecheck` reported no such script; used the package tsconfig instead.
- `bash scripts/ci/lint.sh`: **pass**.
- Every mutation below passed the package compiler (incremental cache outside the tree), returned test exit **1**, then returned exit **0** after restoration. Parsing/type errors were not accepted as proof. The initial wave-guard deletion failed typechecking and was discarded; the certified replacement permits a fallback task while remaining well typed.
- The final mutation replay prints the actual changed line by its original edit offset, correcting ambiguous excerpt selection when replacement text occurred earlier in the file. It repeats the red/restored-green test checks on the same compiler-certified mutations.

### Gate mutation table

Enumerated from the twelve gate IDs in the task brief and their rows at `docs/trident-gates-inventory.md:93`. Test names below are selectors for `bun test trident/build-run.test.ts --test-name-pattern '<selector>'`. Multiple mutations within a row were each run independently.

| Gate | Guard evidence | Mutation and selected test | Mutated / restored |
|---|---|---|---|
| G024 | `trident/build-run.ts:267` | Permit the old selection when the pinned line is absent; separately retain the wrong planner selection. `G024 wave selects` (`trident/build-run.test.ts:302`). | RED 1 / GREEN 0 |
| G025 | `trident/build-run.ts:122` | Accept null as a valid execution plan. `G025 G024 ralph` (`trident/build-run.test.ts:293`). | RED 1 / GREEN 0 |
| G026 | `trident/build-run.ts:201` | Remove the periodic refresh condition. `G026` (`trident/build-run.test.ts:332`). | RED 1 / GREEN 0 |
| G027 | `trident/build-run.ts:205` | Remove the found-plan requirement, retaining nonempty body and valid checksum/count. `G027` (`trident/build-run.test.ts:347`). | RED 1 / GREEN 0 |
| G028 | `trident/build-run.ts:207` | Independently bypass SHA-256 equality and unchecked-count equality. `G028` (`trident/build-run.test.ts:356`). | RED 1 / GREEN 0 |
| G029 | `trident/build-run.ts:260` | Independently retain the claimed body, task and remaining count. `G029` (`trident/build-run.test.ts:365`). | RED 1 / GREEN 0 |
| G034 | `trident/build-run.ts:277` | Reject only an empty head, permitting short hashes and absent. `G034` (`trident/build-run.test.ts:315`). | RED 1 / GREEN 0 |
| G037 | `trident/build-run.ts:280` | Defer only above 99 remaining tasks; separately omit atomic advancement, then ignore blocked/unknown acknowledgement. `G037 intermediate` and `G037 handoff` (`trident/build-run.test.ts:373`, `trident/build-run.test.ts:386`). | RED 1 / GREEN 0 |
| G038 | `trident/build-run.ts:182` | Remove recorded/live head equality; separately allow unreadable required heads through. `G038 exact` and `G038 absent` (`trident/build-run.test.ts:395`, `trident/build-run.test.ts:404`). | RED 1 / GREEN 0 |
| G039 | `trident/build-run.ts:191` | Buy a fix for any recorded finding, including advisory/lane findings. `G039` (`trident/build-run.test.ts:414`). | RED 1 / GREEN 0 |
| G040 | `trident/build-run.ts:184` | Regenerate against main instead of the pinned OID; separately admit empty diffs. `G040` (`trident/build-run.test.ts:427`). | RED 1 / GREEN 0 |
| G041 | `trident/build-run.ts:176` | Reset the inherited round to one. `G041` (`trident/build-run.test.ts:436`). | RED 1 / GREEN 0 |

### Additional boundary mutations

Each row is independently compiler-certified and red/restored-green. These cover the remaining added refusal/identity boundaries and the resumed fix ceiling.

| Boundary | Actual mutated line | Selected test | Result |
|---|---|---|---|
| resume-pending | `trident/build-run.ts:153`: `if (resume?.pending && resume.round < 0) {` | `resume pending` | RED 1 / GREEN 0 |
| resume-round | `trident/build-run.ts:175`: `if (resume.round === -999) return blocked('Invalid recorded review round')` | `mode host and valid` | RED 1 / GREEN 0 |
| resume-diff | `trident/build-run.ts:188`: `if (regenerated.diff === snapshot.diff) return blocked('Regenerated diff disagrees with host measurement')` | `resume regenerated` | RED 1 / GREEN 0 |
| resume-repeat | `trident/build-run.ts:291`: `if (firstRound >= 99 && findings.some(f => previous.includes(f))) return blocked('Review requires orchestrator arbitration: repeated finding')` | `resume rejection retains` | RED 1 / GREEN 0 |
| resume-ceiling | `trident/build-run.ts:289`: `if (firstRound >= 99) return blocked('Review requires orchestrator arbitration: round ceiling')` | `G041` | RED 1 / GREEN 0 |
| bound-admission | `trident/build-run.ts:164`: `if (input.bound_pr === -1) {` | `bound PR builds` | RED 1 / GREEN 0 |
| bound-worker | `trident/build-run.ts:238`: `if (input.mode === 'bound_pr' && measured.pr?.number === -1) {` | `bound PR identity cannot change during worker` | RED 1 / GREEN 0 |
| bound-publication | `trident/build-run.ts:335`: `if ((input.mode === 'bound_pr' && snapshot.pr?.number === -1) \|\| snapshot.head !== reviewed.head \|\| snapshot.diff !== reviewed.diff \|\| snapshot.pr?.state !== 'OPEN' \|\| snapshot.pr.head !== reviewed.head) {` | `bound PR identity cannot change during publication` | RED 1 / GREEN 0 |
| wave-resume | `trident/build-run.ts:183`: `&& !resume.stage.startsWith('ralph-task-built')) {` | `wave resume` | RED 1 / GREEN 0 |
| ralph-identity | `trident/build-run.ts:219`: `step_id = `${input.run_id}${input.mode === 'ralph' ? '' : ''}:${role}:${round}`` | `Ralph step identities` | RED 1 / GREEN 0 |
| mode-host | `trident/build-run.ts:151`: `if (input.mode === 'wave' && !modes) return blocked('Mode host is required')` | `mode host and valid` | RED 1 / GREEN 0 |

### Deliberate exclusions and search evidence

Only the driver, its test file and this required staging record are delivered. No runtime adapter, orchestrator, legacy workflow, publication mechanism, model policy or spec decision was changed. Production callers must supply the declared mode host (`trident/build-run.ts:50`); this record does not claim that another lane has completed that wiring.

The content search `rg -n 'Only fresh PR builds are supported|Fresh PR state machine|fresh-PR state machine|BuildRunOutcome' . --glob '!bun.lock'` found the positive control `BuildRunOutcome` at `trident/build-run.ts:97` and its helper uses, with no old fresh-only wording in that search scope. This is a working-tree content check, not a fetched-ref completeness claim.

The requested `.trident/as-built/rebuild/driver-modes.md` staging location and local-commit-only delivery take precedence over the repository's general record location and PR workflow. No full-suite run, push, PR creation or merge was performed.
