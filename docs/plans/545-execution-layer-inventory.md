# Execution layer inventory for #545 — live composition

Measured 2026-09-17 at `4bf30f84a940ace35fdfbc7c70fc11123b1dd6fc` (`git rev-parse HEAD origin/main` printed that SHA twice). This is a source measurement of the checked-out composition, not an observation of a deployed process. No remote was fetched: the lane explicitly forbids network access. The supplied issue snapshot, including the final falsification comment, is the issue source used here.

## Findings and measurement record

### Decision supported by this measurement

**Do not delete `launch`, the unconfirmed-fire machinery, or result settlement.** The gateway installs `orchestrator.step` into `TridentTickLoop` (`gateway/composition/build-core-modules.ts:826`), the step injects `launch` into recovery (`trident/orchestrator.ts:2876`), and recovery calls it (`trident/recovery-liveness.ts:602`). `launch` calls the **new** launcher through the injected `fireWorkflow` (`trident/orchestrator.ts:1974`); when `liveAgentSubstrate !== null`, the composer binds it to `createProjectLauncher`, otherwise it binds `null` (`open/composer.ts:1187-1210`). The gateway's fallback for absent wiring is no orchestrator (`gateway/composition/build-core-modules.ts:620`), not the legacy firer. The project launcher still returns all three launch statuses (`trident/project-launcher.ts:117,169,172,179`). A closure's name containing “fire” does not make it legacy.

The **unconditional API/test-preserving deletion set** for execution bodies in `orchestrator.ts` established here is empty. For the narrower running-composition question, the one self-contained body candidate is the 30-line helper at :825–854, `computeDiffLineCount` (`trident/orchestrator.ts:825`), plus unused import bindings; neither is the old launcher loop. Removing the helper requires retiring its public export and accounting for its parity test, rather than silently weakening that test (`trident/index.ts:159`; `trident/ported-fixes.test.ts:200`). Its external consumers are UNKNOWN. The import cleanup candidates below do not authorize deleting the implementations they import.

The legacy firer is disconnected from this composition: the non-test call census finds only its definitions, while the same census finds the new constructor call in `open/composer.ts:1189`. The old body remains addressable by path through its exported factory and by test readers. “Not selected by this composition” is the conclusion; “impossible to execute” is not. See commands C1–C4 and the path table.

**The pivot's preparation precondition is substantially unmet.** `prepareProjectBuild` creates/reuses a worktree, but requires `run.base_sha` already pinned (`open/wiring/project-build.ts:206,208,215`). It consumes the base branch, model configuration, credentials, reflection and test strategy rather than deriving them (`open/wiring/project-build.ts:231,321,333,358,377,411`). A replacement launcher must preserve those producers, the pre-launch refusals, and the run-store write order; changing only the callback leaves those responsibilities in the outer orchestrator.

Scope provenance is separate: **“Keep the gates, replace the loop”** is the checked-in design (`docs/plans/harness-orchestrator-pivot-2026-09-11.md:265`). **“Delete the execution layer; keep ~45k lines of gates verbatim; split orchestrator.ts, don't delete it”** is the owner's standing instruction supplied with this task and the agreed-rebuild comment on #545. The quoted line count is that instruction's estimate, not a fresh LOC measurement. This document does not reopen either ruling or certify all gate preservation.

### Live route and the additional callback path

| Edge | Mechanism and evidence | Confidence | Falsifier |
| --- | --- | --- | --- |
| Composition → outer loop | ES import and construction, `gateway/composition/build-core-modules.ts:77,634,826`; installs `step` at :829, `drain` at :841 and salvage at :842 | High, source wiring | A different composition supplies the running service, or replaces `step` |
| Composer → injected firer | Conditional on `liveAgentSubstrate !== null`, `open/composer.ts:1187-1210` constructs the launcher and injects `prepareProjectBuild`; otherwise the binding is `null`. At :7186 the composer exposes `fire_inner_workflow`; gateway copies it at `gateway/composition/build-core-modules.ts:633`. With no wiring, the gateway constructs no orchestrator (`gateway/composition/build-core-modules.ts:620`) | High for this composer's live-substrate branch | A different `tridentWiring.fire_inner_workflow` provider |
| Tick → launch | `trident/orchestrator.ts:2989` calls `stepCore`; :2880 injects `launch`; `trident/recovery-liveness.ts:272,602` invokes it for recovery/fresh dispatch | High, conditional on run state | A fresh eligible row completes through this composition without invoking that callback |
| Launch → project host | `trident/orchestrator.ts:1974`; `trident/project-launcher.ts:120,123,125`: reserve, prepare, construct host, run detached | High | Replace callback or fail reservation before host construction |
| Host → outer settlement | CAS result write at `trident/project-launcher.ts:141`; old-shaped result adapter at :74; parser/harvest at `trident/recovery-liveness.ts:122,137`; `applyResult` at `trident/orchestrator.ts:2287` | High | Change result protocol or bypass outer harvest |
| Bound review → injected firer | `trident/orchestrator.ts:1825` → `trident/bound-review.ts:160` → default panel (`trident/review-run.ts:244,273,499`) | High for invocation; **BROKEN**, filed as #1126 | Repair the store boundary and prove the composed review-only path reaches a terminal review verdict |
| Boot → stranded sweep | `gateway/composition/build-core-modules.ts:873` invokes `sweepStrandedFailures`; salvage returned at `trident/orchestrator.ts:3044` | High | Boot wiring no longer installs that sweep |
| Terminal notification | `open/wiring/trident-nexus-observer.ts:57` calls `isTridentHarvestTerminal` | High | Observer replaced or disconnected |

The type-level injection-channel census is `rg -n 'TridentWorkflowFirer' gateway open trident --glob '!**/*.test.*'`: it finds the contract (`trident/inner-loop.ts:474`), the gateway input (`gateway/composition/input/misc-input.ts:64`), and typed bindings in the project launcher (`trident/project-launcher.ts:102`), orchestrator (`trident/orchestrator.ts:187`), bound review (`trident/bound-review.ts:99`), review panel (`trident/review-run.ts:63`), and simulator (`trident/inner-loop-sim.ts:172,193`), plus imports, comments, the old factory annotation and the barrel re-export. Those are all non-test symbol hits returned by the command. Every typed binding is an injection channel; a symbol grep still does **not** enumerate callers of an injected dependency.

The bound-review channel is deterministically broken, tracked by #1126. The review panel mints a new ID (`trident/review-run.ts:251`), initialises that row in the separate `panelDbPath` database (:255-256), and invokes the injected firer (:273). In this composition that firer is `createProjectLauncher` when the live substrate exists (`open/composer.ts:1187-1210`); `rg -n 'execute_bound_review|createProjectLauncher' gateway open --glob '!**/*.test.*'` finds the constructor at `open/composer.ts:1,1189` and no `execute_bound_review` override, so the constructor is the positive control for that absence. The launcher reserves through `options.store`, the composition store (`trident/project-launcher.ts:120`; `open/composer.ts:1190`), not through the panel input's `db_path`. Its compare-and-set updates `code_trident_runs WHERE id = ?` and succeeds only when exactly one row changes (`trident/store.ts:1044-1049`); the panel ID has no row in that store, so reservation returns `false`. The launcher therefore returns non-`fired`, which the panel rejects (`trident/review-run.ts:291-292`), and bound review marks the run failed with `inner_checkpoint = 'bound-review-failed'` (`trident/bound-review.ts:163-175`).

Two consequences follow. The project launcher's own `bound_pr` mode selection (`trident/project-launcher.ts:124`) and the host's bound-review implementation (`trident/build-host.ts:233-239`) are unreachable from the outer route because every non-null `bound_pr` is diverted first (`trident/bound-review.ts:122`). Meanwhile terminal recovery recommends this dead route as “the cheapest correct recovery” (`gateway/proactive/terminal-build-wake.ts:88`). No product decision or repair is made here.

### Every launch preparation input: provenance and pivot requirement

Enumeration: every property of the object passed at `trident/orchestrator.ts:1974` through :2021, plus the destructured `PreparedLaunch` outputs at :1876 and launch-side effects. C3 enumerates all `input.` accesses in both consumers; `input.run` is copied, so omitted scalar accesses alone cannot prove a field of the run unused. “Re-derived” below means independently obtained from authoritative context, not copied or defaulted.

| Input / preparation | Current producer | New consumer / independent source | Verdict and falsifier |
| --- | --- | --- | --- |
| `run` identity, task, repo, project, modes | `pinnedRun` from `prepareLaunch`, `trident/launch-preparation.ts:724` | copied at `open/wiring/project-build.ts:206`; mode chosen at `trident/project-launcher.ts:124`; persisted identity checked at `trident/project-build-host.ts:62` | **Consumed**, not recreated. Falsifier: successful preparation without the supplied row identity/task |
| `run.branch`, `run.worktree` | supplied row, possibly null | defaults derived at `open/wiring/project-build.ts:206`; branch/worktree established :210–224 | **Re-derived when missing**, otherwise validated/reused. Does not recreate launch's foreign-branch refusal. Falsifier: real worktree creation accepts another branch |
| `base_branch` | `resolveBase`, `trident/orchestrator.ts:1360`; `prepareLaunch` :46 | passed as production base at `open/wiring/project-build.ts:377` | **Consumed**, no independent base discovery in prepare (C3). Falsifier: another preparation source calls base detection |
| `base_sha` scalar; `run.base_sha` | three origins: fresh remote/local resolution assigns the pin (`trident/launch-preparation.ts:312,334`); a non-fresh resume retains `launchRun`'s prior pin (:336); and resume branch validation can move it to `branchTip` (:591-593) | scalar unused (C3); **run pin mandatory**, `open/wiring/project-build.ts:208`; branch creation consumes it blindly at :220 | **Not re-derived by the consumer**. A replacement that pins once at dispatch would silently change resume-after-crash behavior. Falsifier: preparation independently proves which of the three producer states applies |
| `run.base_behind`, ancestry/foreign-branch checks | `trident/launch-preparation.ts:592,694,705` | copied with row :206; worktree HEAD validation is narrower :223 | **Not replaced by worktree preparation**. Falsifier: equivalent ancestry refusal in the new entry before effects |
| PR discovery (`run.pr`) | `trident/launch-preparation.ts:201` calls `detectExistingPr`, `trident/orchestrator.ts:1384` | row copied :206; result fallback `trident/project-launcher.ts:85`; when `current.pr === null`, production `readPr` runs `gh pr list --head <branch>` at observation time (`trident/production-host-effects.ts:182,188-193`) | **Re-derived by the new host at observation time**, replacing pre-launch `detectExistingPr` for this purpose. Falsifier: a null-PR run reaches an observation that does not query its branch |
| `max_rounds` scalar | `trident/orchestrator.ts:1979` | scalar unused (C3); whole run travels in mutation policy `trident/project-build-host.ts:93`; `trident/build-host.ts:143` reads `row.max_rounds` | **Carried through the run snapshot**, not scalar or a fresh budget computation. Falsifier: change only scalar and observe cap change; field/default must remain accounted for |
| `resume_checkpoint` | `trident/launch-preparation.ts:47,151,724` | truthiness selects `start` at `trident/project-launcher.ts:125` | **Consumed as a switch**. Detailed resume comes from `build-mode-state`, `trident/production-host-effects.ts:234,265`. Falsifier: legacy checkpoint alone reconstructs equivalent new mode state |
| `resume_checkpoint_head` | `trident/launch-preparation.ts:53` | scalar unused (C3); host re-reads `run.inner_checkpoint_head`, `trident/project-build-host.ts:91` | **Partly re-read**, not an adapter of old checkpoints. Falsifier: divergent scalar changes new host's reviewed pin |
| `resume_findings` | `trident/launch-preparation.ts:54` | scalar unused (C3); mode checkpoint validates persisted findings, `trident/production-host-effects.ts:246,269` | **Different durable source**, migration equivalence UNKNOWN. Falsifier: recovered legacy findings reproduced without a mode event |
| `resume_live_head` | bounded host probe, `trident/launch-preparation.ts:69`; unreadable refusal :206 | scalar unused (C3); new resume diff uses supplied measured tip, `trident/production-host-effects.ts:274` | **Upstream refusal still matters**; not duplicated by consuming this scalar. Falsifier: equivalent new pre-launch seed/head proof before any worker |
| Seed validation/reset | `trident/launch-preparation.ts:143,151,157` | prepare copies the resulting row, `open/wiring/project-build.ts:206` | **Not independently re-derived**. Falsifier: moved seed is invalidated by new preparation without `prepareLaunch` |
| `db_path` | `trident/orchestrator.ts:1978` | no scalar read (C3); authoritative store from context, `open/composer.ts:1190,1195`; prepare writes :210 | **Replaced by injected store**, with the bound-panel mismatch above. Falsifier: callback chooses database from the scalar |
| `codex_home` | resolver/static fallback, `trident/orchestrator.ts:1991` | merged into worker env, `open/wiring/project-build.ts:231,319` | **Consumed**, no credential resolution here. Falsifier: revocation/rotation picked up without supplying refreshed input |
| `gh_data_dir`, `gh_owner_handle` | `trident/orchestrator.ts:1998` | no scalar reads (C3); credentialed host runner supplied by `open/composer.ts:1195` | **Replaced by context runner for new host commands**. Bound-review consumer still exists, `trident/bound-review.ts:152`. Falsifier: a new-host command requires these scalar coordinates |
| `kimi_configured` | per-launch resolver, `trident/orchestrator.ts:2005` | scalar unused (C3); review configured through phase models/env, `open/wiring/project-build.ts:426` | **Not re-derived as a boolean**; capability parity UNKNOWN (runner may be unavailable, `trident/project-review-source.ts:71`). Falsifier: real configured Kimi seat behaves equivalently with this scalar omitted |
| `reflection_context` | best-effort resolver, `trident/orchestrator.ts:1895` | builder guidance rendered at `open/wiring/project-build.ts:358` | **Consumed**, rendering is not retrieval. Falsifier: preparation loads owner guidance independently |
| `test_strategy` | host budget + active count + diff base, `trident/orchestrator.ts:1917,1939,1940,1950` | build/fix briefs :333; suite policy :387; command extraction :411 | **Consumed and essential**; prepare does not census runs/read host budget. Falsifier: equivalent strategy constructed when scalar is absent |
| `test_strategy_intermediate` | `trident/orchestrator.ts:1955,2015` | no scalar read (C3); full strategy used for both builder roles at `open/wiring/project-build.ts:332` | **Unused scalar on this path**, not proof intermediate-suite behavior preserved. Falsifier: a read in this callback/preparation chain |
| `phase_models` | per-launch resolver, `trident/orchestrator.ts:2019` | parse/validate/default :321–328, role requests :362, review policy :426 in `open/wiring/project-build.ts` | **Consumed with defaults**, owner settings not retrieved here. Falsifier: preparation retrieves owner config independently |
| `id` dispatch identity | mint/validate, `trident/launch-preparation.ts:715` | outer outcome and pending map, `trident/orchestrator.ts:2057,2162`; not passed to prepare | **Outer lifecycle responsibility**. Falsifier: equivalent tracking adopted elsewhere before deleting it |
| `test_strategy_summary` | `trident/orchestrator.ts:1956` | launch note :2174 | **Outer telemetry**, not an input to prepare. Falsifier: replacement emits equivalent summary |
| stamps, `fireStartedAtMs`, promise drain | `trident/orchestrator.ts:1844,1972,1973,2027` | confirmation/evidence :2058,2138,2738; drain :3038 | **Outer lifetime/evidence**, not preparation. Falsifier: remove outer owner and still bound/observe a slow preparation and shutdown |
| post-prepare persisted fields | prepare writes `open/wiring/project-build.ts:210` | `withLauncherPersistedFields`, `trident/orchestrator.ts:2904`, used :2105,2161 | **Essential ordering**, not redundant recomputation. Falsifier: post-launch save cannot overwrite assigned branch/worktree/base without this read |
| bound-review diversion | `trident/orchestrator.ts:1825,1839` | retained executor `trident/bound-review.ts:160` | **Before preparation**, not reproduced by new worktree setup. Falsifier: replacement route proves review-only behavior with real composition |

High confidence in explicit producers/reads above; equivalence of the old resume protocol to the new `build-mode-state` protocol is **UNKNOWN**. Removing an ignored scalar does not authorize removing the producer's side effects or refusal. The most useful pivot test is a composed dispatch starting with null branch/worktree/base, then seeded-resume, moved seed, unreadable head, existing PR and bound-review variants, inspecting durable row changes and actual worker invocation.

### `FireOutcome`: recommended owner and current default costs

**Recommendation:** put the launch acknowledgement contract beside the project launcher in a small neutral contract module (for example `trident/launch-contract.ts`), with the launcher as producer and the outer launch/settlement owner as consumer. Move the single definition and retarget imports; do not retain a second vocabulary. This is a proposed boundary, not a shipped module. Today the definition lives at `trident/inner-loop.ts:384` and the new producer imports it at `trident/project-launcher.ts:2`.

| Existing value | New producer | Outer interpretation / default cost |
| --- | --- | --- |
| `fired` | after reservation and `host.run`, `trident/project-launcher.ts:120,125,169` | track running, `trident/orchestrator.ts:2158`; eventual build result is separately stored at `trident/project-launcher.ts:141` |
| `unconfirmed` | existing pending/reservation loss, :117,121; prepare settle timeout :179 | pending map and second budget, `trident/orchestrator.ts:2039,2048,2067`; late settle, :2085; evidence at :2738 |
| `failed` | caught construction/prepare error, `trident/project-launcher.ts:170` | outer failure at `trident/orchestrator.ts:2130,2151`; special legacy timeout string probes evidence at :2137 |

There is no exhaustive switch at this consumer: after `unconfirmed`, **anything other than `fired` fails** (`trident/orchestrator.ts:2130`). A new status silently joins that failure default unless the consumer changes. Bound review is stricter: any non-`fired`, including `unconfirmed`, throws (`trident/review-run.ts:291`). Neither vocabulary is `BuildRunOutcome`; the result adapter preserves that distinction (`trident/project-launcher.ts:74`).

The warm-session fields (`launcher_session_key`, `launcher`, `cancel`) describe a different producer; the project producer returns status/error and on timeout budget/elapsed/settled (`trident/project-launcher.ts:169,179`). Preserve the consumer until a replacement covers its actual live cases, then remove obsolete fields atomically. Do not infer that all evidence handling is dead because this producer supplies no session key: unconfirmed deadlines still call `decideSettleTimeoutByEvidence` (`trident/orchestrator.ts:2738`).

Continuous ownership is split today: reservation/result CAS belongs to the store through the launcher (`trident/project-launcher.ts:120,141`); restart recognition and recovery belong to a later gateway's tick (`trident/orchestrator.ts:2911,2950`); a measured unknown is made terminal at :2972. Same-process pending reservations short-circuit before `stepCore` at :2981, so this measurement does **not** certify a bounded watchdog for a preparation that never returns. That falsifier must suspend preparation after reservation and keep ticking. A new lifecycle owner must survive the worker's failure and use durable state; a worker-owned heartbeat alone would not maintain that invariant.

### Commands, controls and limits

Commands below were run against the build worktree. Output summaries omit comments only where explicitly stated. No command is evidence about an uninspected external composer or an already-running Dynamic Workflow.

**C1 — call census with production and test controls**

```sh
rg -n 'buildWorkflowFirer\(|buildSubstrateWorkflowFire\(|createProjectLauncher\(' --glob '*.ts' --glob '!*.test.ts' --glob '!node_modules/**'
```

Output: `trident/inner-loop.ts:980,1043` (legacy definitions), `trident/project-launcher.ts:102` (new definition), **`open/composer.ts:1189` (new call, positive control)**. Same legacy pattern in `trident/inner-loop.test.ts` and `trident/liveness-death-e2e.test.ts` finds calls at :505 and :381–382 respectively. Additional identifier census `rg -n '\b(buildWorkflowFirer|buildSubstrateWorkflowFire)\b' --glob '*.ts' --glob '!*.test.ts' --glob '!node_modules/**'` found definitions, comments and `trident/index.ts:171,172` exports; no non-test import alias/callback reference to those factories. Exported entrypoints remain available; that is not runtime selection.

**C2 — type-level injection channels**

```sh
rg -n 'TridentWorkflowFirer' gateway open trident --glob '!**/*.test.*'
```

Output: the contract at `trident/inner-loop.ts:474`; channel bindings at `gateway/composition/input/misc-input.ts:64`, `trident/project-launcher.ts:102`, `trident/orchestrator.ts:187`, `trident/bound-review.ts:99`, `trident/review-run.ts:63`, and `trident/inner-loop-sim.ts:172,193`; and imports/comments/re-export/factory annotation at `trident/project-launcher.ts:2`, `trident/index.ts:180`, `trident/orchestrator.ts:38,127`, `trident/review-run.ts:23`, `trident/inner-loop-sim.ts:11,22,181`, `trident/bound-review.ts:9`, and `trident/inner-loop.ts:975,980`. This is the full non-test symbol output. It enumerates type-level injection channels, not the runtime callers of an injected value.

**C3 — preparation input reads, including positive controls**

```sh
rg -n 'input\.' open/wiring/project-build.ts trident/project-launcher.ts
```

Preparation reads `input.run` (:206–207), `codex_home` (:231), `phase_models` (:321), `test_strategy` (:333,387,411), `reflection_context` (:358), `base_branch` (:377). Launcher reads run fields (:84–85,116–127,141,162,166,171) and `resume_checkpoint` (:125). These are the complete member names found by that command; **`test_strategy` and `input.run` are positive controls** for the absent scalar reads listed above. This is a property-access census, not a dataflow proof across spread copies: the whole run remains an input.

**C4 — pin census, path control, and document baseline**

```sh
rg -l 'inner-workflow\.mjs' --glob '*.test.ts' --glob '!node_modules/**' | sort
rg -n 'DEFAULT_INNER_WORKFLOW_PATH|scriptPath =|checkpointSh|stageStampSh|codexBuildSh|codexReviewSh' trident/inner-loop.ts trident/inner-workflow.mjs
rg --files docs/plans | rg '545-execution-layer-inventory|harness-orchestrator-pivot'
```

First command returned **51 test files**, enumerated below. Second finds the file path (`trident/inner-loop.ts:498`), prompt's execution property (:815), and script command bindings (`trident/inner-workflow.mjs:245,1541,2187,5137`): positive controls for **path execution**, not ES-import resolution. Third returned only `docs/plans/harness-orchestrator-pivot-2026-09-11.md` before writing this document. The requested old draft was absent **in this working tree**; no fetched-ref absence claim is made. This is a wholly new inventory frame, not a repair of that missing draft.

**C5 — small helper versus real production control**

```sh
rg -n 'computeDiffLineCount|buildTridentOrchestrator' --glob '*.ts' --glob '!*.test.ts' --glob '!node_modules/**'
rg -n 'computeDiffLineCount' --glob '*.test.ts'
```

Helper: definition `trident/orchestrator.ts:825`, barrel `trident/index.ts:159`, explanatory comment `trident/git-range.ts:15`. Positive production control: `buildTridentOrchestrator` called at `gateway/composition/build-core-modules.ts:826`. Tests: `trident/ported-fixes.test.ts:200,202` call the helper; `trident/diff-base-option-shaped.test.ts:855` names it in commentary. This supports “test/API-only in the inspected tree”, not “safe to break every public consumer”.

### Paths, scripts, public exports and test cost

| Subject | Reached by what | Confidence | Falsifier / deletion constraint |
| --- | --- | --- | --- |
| `inner-workflow.mjs` | legacy factory chooses path, `trident/inner-loop.ts:981`; prompt asks Workflow to execute it :815; no legacy factory selected in C1 | High for disconnected composition; external/manual execution UNKNOWN | A composer selecting the exported legacy firer, a direct Workflow path invocation, or a still-running old workflow |
| `checkpoint.sh` | path arg `trident/inner-loop.ts:640`; agent Bash commands `trident/inner-workflow.mjs:2165,2187,2244`; also forwarded to wrapper :1608 | High for conditional legacy path | A surviving caller passing checkpoint env to a wrapper; don't infer file deletion from lost ES imports |
| `stage-stamp.sh` | path arg :642; Bash prompt `trident/inner-workflow.mjs:245`; wrapper env at :1608,5146 | High for conditional legacy path | A remaining wrapper environment that sets this path |
| `codex-build.sh` | old prompt uses `codexBuildSh`, `trident/inner-workflow.mjs:1541`; **new headless runner** selects it at `runtime/workers/codex-headless.ts:107` | High, retained dependency | Replacement runner must stop executing it before deletion; file is not dead with the workflow |
| `codex-review.sh` | old prompt uses `codexReviewSh`, `trident/inner-workflow.mjs:5137`; model registry retains wrapper entries at `trident/model-tiers.ts:161` | High for old route; other entrypoints UNKNOWN | Exhaustively resolve registry consumers/CLI paths before whole-file deletion |
| `worktree-cleanup.sh` | workflow finally `trident/inner-workflow.mjs:7010`; **new host** `trident/production-host-effects.ts:428` | High, retained dependency | New host cleanup no longer invokes it; otherwise keep |
| `gh-authed.ts`, API-review path | `trident/inner-loop.ts:651,656`; workflow shell assembly `trident/inner-workflow.mjs:4431,5182` | High for legacy route; global deletion UNKNOWN | A current reader/CLI entrypoint independent of the workflow |
| Barrel API | `trident/index.ts:170` exports old factories, prompt/args builder, parser, path/tool surface; types at :179 | High, load/export mechanism | External namespace/string-key consumer; C1 cannot rule that out |
| Test extractor/body pins | examples: source read `trident/inner-workflow.test.ts:24`; extracted gate read `trident/__tests__/severity-gate.test.ts:22`; size pin `trident/inner-workflow-size.test.ts:10` | High, 51 literal-name files, C4 | An extractor/helper naming the file indirectly would increase the count; 51 is not every transitive test |

Test cost is not a deletion veto. Retarget gate assertions to their kept implementation; retire obsolete whole-workflow harnesses or file-size assertions with the mechanism they pin. A file mentioning a name is not necessarily a behavioral pin, so the 51-file census is a reproducible impact floor, not “51 files must be deleted”. This measurement changes no assertions and makes no new gate.

### Scope and reading key for the symbol census

Enumeration used TypeScript's `createSourceFile` on each of the three files: visit direct source-file `FunctionDeclaration`, `VariableStatement` (including every destructuring binding), `InterfaceDeclaration` and `TypeAliasDeclaration`; also visit direct statements of `buildTridentOrchestrator`'s body. Counts: **86 orchestrator declarations, 26 inner-loop declarations, 279 workflow declarations**. Re-exports and imports are listed separately. Parameters, interface members, block-local temporaries and nested callbacks belong to their containing declaration/main body; they are not claimed to be separately deletable units. No import graph was used as the reachability oracle.

Each row names a definition read and an immediate use/owner reference; those are **syntactic occurrences**, not proof of branch coverage. A property with the same spelling can be an occurrence without being a bound-variable use. Reachability grades therefore come from the live routes above, not occurrence counts. In particular, the workflow rows all share the path boundary: **P** = only the legacy path/test body is established, not reached by the measured composer. A P row does not assert its internal branch executes. **H** = wired outer owner or contract; **T** = test/API-only candidate; **U** = UNKNOWN internal use or external reachability. A row's falsifier is a concrete way to refute that scope, not a request to weaken its test.

Repeated falsifier keys in the tables: **FO** = a composed fixture reaches the row's cited owner with this binding removed while preserving its observations and durable effects (prove that the branch actually ran); **FP** = demonstrate a selected non-test path executing this body, then trace this symbol; **FI** = find a bound reference beyond the import/export, or required module initialization; **FR** = show that the purported use resolves to another binding. The row supplies the symbol and location, so the counterexample has a specific subject. These are proposed falsification checks, not mutations performed by this measurement.

### Reproducing the declaration enumeration

This command enumerates definitions; **it makes no runtime reachability decision**. The tables add composition and path evidence separately. Imports/re-exports are not included in these three declaration counts.

```sh
node --input-type=module <<'JS'
import ts from 'typescript'
import fs from 'node:fs'
function bindings(n) {
  return ts.isIdentifier(n) ? [n.text] : n.elements.flatMap(e =>
    ts.isOmittedExpression(e) ? [] : bindings(e.name))
}
function declarations(statements) {
  return statements.flatMap(n => ts.isVariableStatement(n)
    ? n.declarationList.declarations.flatMap(d => bindings(d.name))
    : n.name && (ts.isFunctionDeclaration(n) || ts.isInterfaceDeclaration(n)
      || ts.isTypeAliasDeclaration(n) || ts.isClassDeclaration(n)) ? [n.name.text] : [])
}
for (const file of ['trident/orchestrator.ts', 'trident/inner-loop.ts', 'trident/inner-workflow.mjs']) {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const names = declarations(sf.statements)
  if (file.endsWith('orchestrator.ts')) {
    const factory = sf.statements.find(n => n.name?.text === 'buildTridentOrchestrator')
    names.push(...declarations(factory.body.statements))
  }
  console.log(file, names.length)
}
JS
```

Output: `trident/orchestrator.ts 86`, `trident/inner-loop.ts 26`, `trident/inner-workflow.mjs 279`. The workflow destructuring and exported `meta` are counted by the same parser, positive controls that it reads the path-executed subject rather than ignoring it as a non-imported file.

### Orchestrator declarations — retained owner, not name-based deletion

| Symbol / definition | Reached by what / immediate evidence | Confidence | What would falsify this classification |
| --- | --- | --- | --- |
| `log` — `trident/orchestrator.ts:167` | Outer owner occurrence in `decideSettleTimeoutByEvidence` at `trident/orchestrator.ts:1658` | H, conditional | FO (cited owner) |
| `TridentStep` — `trident/orchestrator.ts:169` | Compile-time contract used by `buildTridentOrchestrator` at `trident/orchestrator.ts:1255` | H (type) | Remove this contract with all cited callers unchanged and still typecheck them |
| `RunLiveness` — `trident/orchestrator.ts:182` | Compile-time contract used by `BuildTridentOrchestratorOptions` at `trident/orchestrator.ts:542` | H (type) | Remove this contract with all cited callers unchanged and still typecheck them |
| `BuildTridentOrchestratorOptions` — `trident/orchestrator.ts:184` | Compile-time contract used by `buildTridentOrchestrator` at `trident/orchestrator.ts:1253` | H (type) | Remove this contract with all cited callers unchanged and still typecheck them |
| `DEFAULT_MAX_CRASH_RECOVERIES` — `trident/orchestrator.ts:643` | Outer owner occurrence in `maxCrashRecoveries` at `trident/orchestrator.ts:1290` | H, conditional | FO (cited owner) |
| `TRIDENT_SALVAGE_MARKER` — `trident/orchestrator.ts:651` | Outer owner occurrence in `reconcile_stranded` at `trident/orchestrator.ts:1581` | H, conditional | FO (cited owner) |
| `TRIDENT_SNAPSHOT_MARKER` — `trident/orchestrator.ts:658` | Outer owner occurrence in `worktreeDispositionSuffix` at `trident/orchestrator.ts:679` | H, conditional | FO (cited owner) |
| `TRIDENT_SNAPSHOT_FAILURE_MARKER` — `trident/orchestrator.ts:664` | Outer owner occurrence in `worktreeCaptureFailureSuffix` at `trident/orchestrator.ts:683` | H, conditional | FO (cited owner) |
| `TRIDENT_STASH_PARKED_MARKER` — `trident/orchestrator.ts:671` | Outer owner occurrence in `worktreeDispositionSuffix` at `trident/orchestrator.ts:677` | H, conditional | FO (cited owner) |
| `worktreeDispositionSuffix` — `trident/orchestrator.ts:673` | Outer owner occurrence in `reconcile_stranded` at `trident/orchestrator.ts:1549` | H, conditional | FO (cited owner) |
| `worktreeCaptureFailureSuffix` — `trident/orchestrator.ts:682` | Outer owner occurrence in `reconcile_stranded` at `trident/orchestrator.ts:1559` | H, conditional | FO (cited owner) |
| `TICK_NOTE_CEILING` — `trident/orchestrator.ts:696` | Outer owner occurrence in `truncateNote` at `trident/orchestrator.ts:702` | H, conditional | FO (cited owner) |
| `truncateNote` — `trident/orchestrator.ts:701` | Outer owner occurrence in `applyResult` at `trident/orchestrator.ts:2521` | H, conditional | FO (cited owner) |
| `truncateWithPointer` — `trident/orchestrator.ts:711` | Outer owner occurrence in `truncateNote` at `trident/orchestrator.ts:702` | H, conditional | FO (cited owner) |
| `STAGE_REASON_CEILING` — `trident/orchestrator.ts:734` | Outer owner occurrence in `truncateStageReason` at `trident/orchestrator.ts:737` | H, conditional | FO (cited owner) |
| `truncateStageReason` — `trident/orchestrator.ts:736` | Outer owner occurrence in `applyResult` at `trident/orchestrator.ts:2522` | H, conditional | FO (cited owner) |
| `StrandedReconcileOptions` — `trident/orchestrator.ts:740` | Compile-time contract used by `StrandedFailureSweepDeps` at `trident/orchestrator.ts:751` | H (type) | Remove this contract with all cited callers unchanged and still typecheck them |
| `StrandedFailureSweepDeps` — `trident/orchestrator.ts:747` | Compile-time contract used by `sweepStrandedFailures` at `trident/orchestrator.ts:765` | H (type) | Remove this contract with all cited callers unchanged and still typecheck them |
| `strandedWorktreeScope` — `trident/orchestrator.ts:755` | Outer owner occurrence in `sweepStrandedFailures` at `trident/orchestrator.ts:774` | H, conditional | FO (cited owner) |
| `sweepStrandedFailures` — `trident/orchestrator.ts:762` | ES-imported caller `gateway/composition/build-core-modules.ts:873` | H | Show the selected composition substitutes another callback before this call executes |
| `isTridentHarvestTerminal` — `trident/orchestrator.ts:809` | ES-imported caller `open/wiring/trident-nexus-observer.ts:57` | H | Show the selected composition substitutes another callback before this call executes |
| `computeDiffLineCount` — `trident/orchestrator.ts:825` | C5: barrel `trident/index.ts:159`; test calls `trident/ported-fixes.test.ts:200,202` | T; external API U | Any non-test direct/aliased/namespace call; exporting alone does not establish one |
| `PublishFailureClass` — `trident/orchestrator.ts:887` | Compile-time contract used by `classifyPublishFailure` at `trident/orchestrator.ts:896` | H (type) | Remove this contract with all cited callers unchanged and still typecheck them |
| `PUBLISH_CREDENTIAL_CLASS` — `trident/orchestrator.ts:889` | Outer owner occurrence in `applyResult` at `trident/orchestrator.ts:2413` | H, conditional | FO (cited owner) |
| `classifyPublishFailure` — `trident/orchestrator.ts:896` | Outer owner occurrence in `applyResult` at `trident/orchestrator.ts:2413` | H, conditional | FO (cited owner) |
| `RESUME_HEAD_RETRY_DELAYS_MS` — `trident/orchestrator.ts:974` | Outer owner occurrence in `resolveResumeLiveHead` at `trident/orchestrator.ts:988` | H, conditional | FO (cited owner) |
| `SleepMs` — `trident/orchestrator.ts:978` | Compile-time contract used by `BuildTridentOrchestratorOptions` at `trident/orchestrator.ts:209` | H (type) | Remove this contract with all cited callers unchanged and still typecheck them |
| `realSleep` — `trident/orchestrator.ts:980` | Outer owner occurrence in `resolveResumeLiveHead` at `trident/orchestrator.ts:985` | H, conditional | FO (cited owner) |
| `resolveResumeLiveHead` — `trident/orchestrator.ts:982` | Outer owner occurrence in `launch` at `trident/orchestrator.ts:1850` | H, conditional | FO (cited owner) |
| `resumeHeadDecides` — `trident/orchestrator.ts:1050` | Outer owner occurrence in `launch` at `trident/orchestrator.ts:1851` | H, conditional | FO (cited owner) |
| `isInfraDeath` — `trident/orchestrator.ts:1095` | Outer owner occurrence in `innerTerminalFailureReason` at `trident/orchestrator.ts:1223` | H, conditional | FO (cited owner) |
| `innerTerminalFailureReason` — `trident/orchestrator.ts:1103` | Outer owner occurrence in `launch` at `trident/orchestrator.ts:1855` | H, conditional | FO (cited owner) |
| `buildTridentOrchestrator` — `trident/orchestrator.ts:1252` | ES-imported caller `gateway/composition/build-core-modules.ts:826` | H | Show the selected composition substitutes another callback before this call executes |
| `now` — `trident/orchestrator.ts:1263` | Outer owner occurrence in `nowMs` at `trident/orchestrator.ts:1267` | H, conditional | FO (cited owner) |
| `nowMs` — `trident/orchestrator.ts:1266` | Outer owner occurrence in `launch` at `trident/orchestrator.ts:1972` | H, conditional | FO (cited owner) |
| `fireWorkflow` — `trident/orchestrator.ts:1270` | Outer owner occurrence in `launch` at `trident/orchestrator.ts:1827` | H, conditional | FO (cited owner) |
| `db_path` — `trident/orchestrator.ts:1271` | Outer owner occurrence in `launch` at `trident/orchestrator.ts:1978` | H, conditional | FO (cited owner) |
| `merge_deps` — `trident/orchestrator.ts:1272` | Outer owner occurrence in `applyResult` at `trident/orchestrator.ts:2515` | H, conditional | FO (cited owner) |
| `on_orphaned` — `trident/orchestrator.ts:1278` | Outer owner occurrence in `stepCore` at `trident/orchestrator.ts:2878` | H, conditional | FO (cited owner) |
| `mint` — `trident/orchestrator.ts:1279` | Outer owner occurrence in `launch` at `trident/orchestrator.ts:1848` | H, conditional | FO (cited owner) |
| `persistRefireReset` — `trident/orchestrator.ts:1280` | Outer owner occurrence in `refireNextRalphTask` at `trident/orchestrator.ts:2260` | H, conditional | FO (cited owner) |
| `maxInflightMs` — `trident/orchestrator.ts:1281` | Outer owner occurrence in `launch` at `trident/orchestrator.ts:1835` | H, conditional | FO (cited owner) |
| `noAdvanceHangMs` — `trident/orchestrator.ts:1282` | Outer owner occurrence in `stepCore` at `trident/orchestrator.ts:2878` | H, conditional | FO (cited owner) |
| `latestStageEventAt` — `trident/orchestrator.ts:1283` | Outer owner occurrence in `stepCore` at `trident/orchestrator.ts:2879` | H, conditional | FO (cited owner) |
| `probeRunAlive` — `trident/orchestrator.ts:1284` | Outer owner occurrence in `stepCore` at `trident/orchestrator.ts:2879` | H, conditional | FO (cited owner) |
| `gatherRunEvidence` — `trident/orchestrator.ts:1285` | Outer owner occurrence in `stepCore` at `trident/orchestrator.ts:2879` | H, conditional | FO (cited owner) |
| `gatherFireEvidence` — `trident/orchestrator.ts:1286` | Outer owner occurrence in `decideSettleTimeoutByEvidence` at `trident/orchestrator.ts:1646` | H, conditional | FO (cited owner) |
| `probeBranchHolderFor` — `trident/orchestrator.ts:1287` | Outer owner occurrence in `stepCore` at `trident/orchestrator.ts:2880` | H, conditional | FO (cited owner) |
| `beginCrashRecovery` — `trident/orchestrator.ts:1288` | Outer owner occurrence in `stepCore` at `trident/orchestrator.ts:2879` | H, conditional | FO (cited owner) |
| `beginProjectBuildDriverRecovery` — `trident/orchestrator.ts:1289` | Outer owner occurrence in `step` at `trident/orchestrator.ts:2942` | H, conditional | FO (cited owner) |
| `maxCrashRecoveries` — `trident/orchestrator.ts:1290` | Outer owner occurrence in `stepCore` at `trident/orchestrator.ts:2878` | H, conditional | FO (cited owner) |
| `beginInfraRetry` — `trident/orchestrator.ts:1291` | Outer owner occurrence in `applyResult` at `trident/orchestrator.ts:2496` | H, conditional | FO (cited owner) |
| `beginPublishRetry` — `trident/orchestrator.ts:1292` | Outer owner occurrence in `applyResult` at `trident/orchestrator.ts:2412` | H, conditional | FO (cited owner) |
| `maxInfraRetries` — `trident/orchestrator.ts:1293` | Outer owner occurrence in `applyResult` at `trident/orchestrator.ts:2415` | H, conditional | FO (cited owner) |
| `onInfraRetry` — `trident/orchestrator.ts:1294` | Outer owner occurrence in `applyResult` at `trident/orchestrator.ts:2496` | H, conditional | FO (cited owner) |
| `proveMutation` — `trident/orchestrator.ts:1295` | Outer owner occurrence in `applyResult` at `trident/orchestrator.ts:2516` | H, conditional | FO (cited owner) |
| `fired` — `trident/orchestrator.ts:1301` | Outer owner occurrence in `decideSettleTimeoutByEvidence` at `trident/orchestrator.ts:1683` | H, conditional | FO (cited owner) |
| `redispatched` — `trident/orchestrator.ts:1304` | Outer owner occurrence in `refireNextRalphTask` at `trident/orchestrator.ts:2206` | H, conditional | FO (cited owner) |
| `launchFaults` — `trident/orchestrator.ts:1307` | Outer owner occurrence in `stepCore` at `trident/orchestrator.ts:2877` | H, conditional | FO (cited owner) |
| `MAX_LAUNCH_FAULTS` — `trident/orchestrator.ts:1308` | Outer owner occurrence in `stepCore` at `trident/orchestrator.ts:2877` | H, conditional | FO (cited owner) |
| `listStageEvents` — `trident/orchestrator.ts:1317` | Outer owner occurrence in `handleUnconfirmedFire` at `trident/orchestrator.ts:2666` | H, conditional | FO (cited owner) |
| `UnconfirmedFire` — `trident/orchestrator.ts:1318` | Compile-time contract used by `unconfirmedFires` at `trident/orchestrator.ts:1342` | H (type) | Remove this contract with all cited callers unchanged and still typecheck them |
| `unconfirmedFires` — `trident/orchestrator.ts:1342` | Outer owner occurrence in `launch` at `trident/orchestrator.ts:2067` | H, conditional | FO (cited owner) |
| `stampFor` — `trident/orchestrator.ts:1343` | Outer owner occurrence in `launch` at `trident/orchestrator.ts:2094` | H, conditional | FO (cited owner) |
| `inflight` — `trident/orchestrator.ts:1352` | Outer owner occurrence in `launch` at `trident/orchestrator.ts:2027` | H, conditional | FO (cited owner) |
| `infraRetryNotBefore` — `trident/orchestrator.ts:1358` | Outer owner occurrence in `applyResult` at `trident/orchestrator.ts:2435` | H, conditional | FO (cited owner) |
| `resolveBase` — `trident/orchestrator.ts:1360` | Outer owner occurrence in `resolvedDiffBase` at `trident/orchestrator.ts:1375` | H, conditional | FO (cited owner) |
| `resolvedDiffBase` — `trident/orchestrator.ts:1374` | Outer owner occurrence in `publishBuiltCommit` at `trident/orchestrator.ts:1444` | H, conditional | FO (cited owner) |
| `detectExistingPr` — `trident/orchestrator.ts:1384` | Outer owner occurrence in `publishBuiltCommit` at `trident/orchestrator.ts:1445` | H, conditional | FO (cited owner) |
| `detectMergedPr` — `trident/orchestrator.ts:1404` | Outer owner occurrence in `stepCore` at `trident/orchestrator.ts:2880` | H, conditional | FO (cited owner) |
| `publishBuiltCommit` — `trident/orchestrator.ts:1436` | Outer owner occurrence in `reconcile_stranded` at `trident/orchestrator.ts:1580` | H, conditional | FO (cited owner) |
| `failedRun` — `trident/orchestrator.ts:1450` | Outer owner occurrence in `decideSettleTimeoutByEvidence` at `trident/orchestrator.ts:1795` | H, conditional | FO (cited owner) |
| `salvageFailureNotes` — `trident/orchestrator.ts:1490` | Outer owner occurrence in `reconcile_stranded` at `trident/orchestrator.ts:1623` | H, conditional | FO (cited owner) |
| `anchoredSnapshotDisposition` — `trident/orchestrator.ts:1491` | Outer owner occurrence in `reconcile_stranded` at `trident/orchestrator.ts:1538` | H, conditional | FO (cited owner) |
| `captureWorktreeDisposition` — `trident/orchestrator.ts:1491` | Outer owner occurrence in `reconcile_stranded` at `trident/orchestrator.ts:1543` | H, conditional | FO (cited owner) |
| `reconcile_stranded` — `trident/orchestrator.ts:1498` | Outer owner occurrence in `step` at `trident/orchestrator.ts:3009` | H, conditional | FO (cited owner) |
| `decideSettleTimeoutByEvidence` — `trident/orchestrator.ts:1639` | Outer owner occurrence in `launch` at `trident/orchestrator.ts:2138` | H, conditional | FO (cited owner) |
| `launch` — `trident/orchestrator.ts:1817` | Outer owner occurrence in `stepCore` at `trident/orchestrator.ts:2880` | H, conditional | FO (cited owner) |
| `refireNextRalphTask` — `trident/orchestrator.ts:2200` | Outer owner occurrence in `applyResult` at `trident/orchestrator.ts:2367` | H, conditional | FO (cited owner) |
| `applyResult` — `trident/orchestrator.ts:2287` | Outer owner occurrence in `stepCore` at `trident/orchestrator.ts:2880` | H, conditional | FO (cited owner) |
| `handleUnconfirmedFire` — `trident/orchestrator.ts:2592` | Outer owner occurrence in `stepCore` at `trident/orchestrator.ts:2881` | H, conditional | FO (cited owner) |
| `sharedLauncherStandDown` — `trident/orchestrator.ts:2797` | Outer owner occurrence in `stepCore` at `trident/orchestrator.ts:2881` | H, conditional | FO (cited owner) |
| `stepCore` — `trident/orchestrator.ts:2876` | Outer owner occurrence in `step` at `trident/orchestrator.ts:2954` | H, conditional | FO (cited owner) |
| `withLauncherPersistedFields` — `trident/orchestrator.ts:2904` | Outer owner occurrence in factory return `trident/orchestrator.ts:3044` | H, conditional | FO (cited owner) |
| `step` — `trident/orchestrator.ts:2910` | Outer owner occurrence in `buildTridentOrchestrator` at `trident/orchestrator.ts:3044` | H, conditional | FO (cited owner) |
| `drain` — `trident/orchestrator.ts:3038` | Outer owner occurrence in `buildTridentOrchestrator` at `trident/orchestrator.ts:3044` | H, conditional | FO (cited owner) |

No row above certifies that every branch has fired on a real run. `step` is the common running-system owner; publication, retry, salvage and confirmation are conditional subpaths. In particular, project pending state can prevent confirmation code being reached on a particular tick (`trident/orchestrator.ts:2981`). A test of that later code must avoid or release the earlier pending reservation; otherwise a deletion mutation could stay green without exercising its subject.

### Inner-loop declarations — split live contracts from disconnected execution

| Symbol / definition | Reached by what | Confidence | Falsifier |
| --- | --- | --- | --- |
| `InnerLoopInput` — `trident/inner-loop.ts:85` | type input in `open/wiring/project-build.ts:205` and `trident/project-launcher.ts:96` | H | Replace the cited producer/consumer contract or parser before deleting this symbol |
| `InnerResult` — `trident/inner-loop.ts:228` | parser result used by `trident/recovery-liveness.ts:122` | H | Replace the cited producer/consumer contract or parser before deleting this symbol |
| `FireOutcome` — `trident/inner-loop.ts:384` | new launcher return and outer status handling, `trident/project-launcher.ts:114`; `trident/orchestrator.ts:2028` | H | Replace the cited producer/consumer contract or parser before deleting this symbol |
| `FIRE_UNCONFIRMED_ERROR` — `trident/inner-loop.ts:446` | Legacy factory/path chain (C1); `buildSubstrateWorkflowFire` occurrence at `trident/inner-loop.ts:1183` | P; public/test surface remains | A non-test composition invokes legacy factory or imports `FIRE_UNCONFIRMED_ERROR` independently |
| `FireInnerWorkflowInput` — `trident/inner-loop.ts:449` | Legacy factory/path chain (C1); `FireInnerWorkflow` occurrence at `trident/inner-loop.ts:469` | P; public/test surface remains | A non-test composition invokes legacy factory or imports `FireInnerWorkflowInput` independently |
| `FireInnerWorkflow` — `trident/inner-loop.ts:468` | Legacy factory/path chain (C1); `BuildWorkflowFirerOptions` occurrence at `trident/inner-loop.ts:478` | P; public/test surface remains | A non-test composition invokes legacy factory or imports `FireInnerWorkflow` independently |
| `TridentWorkflowFirer` — `trident/inner-loop.ts:474` | new launcher signature, `trident/project-launcher.ts:102` | H | Replace the cited producer/consumer contract or parser before deleting this symbol |
| `BuildWorkflowFirerOptions` — `trident/inner-loop.ts:476` | Legacy factory/path chain (C1); `buildWorkflowFirer` occurrence at `trident/inner-loop.ts:980` | P; public/test surface remains | A non-test composition invokes legacy factory or imports `BuildWorkflowFirerOptions` independently |
| `DEFAULT_INNER_WORKFLOW_PATH` — `trident/inner-loop.ts:498` | Legacy factory/path chain (C1); `buildWorkflowFirer` occurrence at `trident/inner-loop.ts:981` | P; public/test surface remains | A non-test composition invokes legacy factory or imports `DEFAULT_INNER_WORKFLOW_PATH` independently |
| `CHECKPOINT_SCRIPT_PATH` — `trident/inner-loop.ts:506` | Legacy factory/path chain (C1); `buildWorkflowArgs` occurrence at `trident/inner-loop.ts:640` | P; public/test surface remains | A non-test composition invokes legacy factory or imports `CHECKPOINT_SCRIPT_PATH` independently |
| `GH_AUTHED_SCRIPT_PATH` — `trident/inner-loop.ts:516` | Legacy factory/path chain (C1); `buildWorkflowArgs` occurrence at `trident/inner-loop.ts:656` | P; public/test surface remains | A non-test composition invokes legacy factory or imports `GH_AUTHED_SCRIPT_PATH` independently |
| `WORKTREE_CLEANUP_SCRIPT_PATH` — `trident/inner-loop.ts:525` | Legacy factory/path chain (C1); `buildWorkflowArgs` occurrence at `trident/inner-loop.ts:646` | P; public/test surface remains | A non-test composition invokes legacy factory or imports `WORKTREE_CLEANUP_SCRIPT_PATH` independently |
| `CODEX_BUILD_SCRIPT_PATH` — `trident/inner-loop.ts:537` | Legacy factory/path chain (C1); `buildWorkflowArgs` occurrence at `trident/inner-loop.ts:648` | P; public/test surface remains | A non-test composition invokes legacy factory or imports `CODEX_BUILD_SCRIPT_PATH` independently |
| `STAGE_STAMP_SCRIPT_PATH` — `trident/inner-loop.ts:540` | Legacy factory/path chain (C1); `buildWorkflowArgs` occurrence at `trident/inner-loop.ts:642` | P; public/test surface remains | A non-test composition invokes legacy factory or imports `STAGE_STAMP_SCRIPT_PATH` independently |
| `CODEX_REVIEW_SCRIPT_PATH` — `trident/inner-loop.ts:548` | Legacy factory/path chain (C1); `buildWorkflowArgs` occurrence at `trident/inner-loop.ts:650` | P; public/test surface remains | A non-test composition invokes legacy factory or imports `CODEX_REVIEW_SCRIPT_PATH` independently |
| `API_REVIEW_SCRIPT_PATH` — `trident/inner-loop.ts:549` | Legacy factory/path chain (C1); `buildWorkflowArgs` occurrence at `trident/inner-loop.ts:651` | P; public/test surface remains | A non-test composition invokes legacy factory or imports `API_REVIEW_SCRIPT_PATH` independently |
| `WORKFLOW_FIRE_TOOL_NAMES` — `trident/inner-loop.ts:567` | Legacy factory/path chain (C1); `buildSubstrateWorkflowFire` occurrence at `trident/inner-loop.ts:1058` | P; public/test surface remains | A non-test composition invokes legacy factory or imports `WORKFLOW_FIRE_TOOL_NAMES` independently |
| `buildWorkflowArgs` — `trident/inner-loop.ts:584` | Legacy factory/path chain (C1); `buildFireWorkflowPrompt` occurrence at `trident/inner-loop.ts:810` | P; public/test surface remains | A non-test composition invokes legacy factory or imports `buildWorkflowArgs` independently |
| `modelTierArgs` — `trident/inner-loop.ts:755` | Legacy factory/path chain (C1); `buildWorkflowArgs` occurrence at `trident/inner-loop.ts:733` | P; public/test surface remains | A non-test composition invokes legacy factory or imports `modelTierArgs` independently |
| `phaseModelArgs` — `trident/inner-loop.ts:785` | Legacy factory/path chain (C1); `buildWorkflowArgs` occurrence at `trident/inner-loop.ts:740` | P; public/test surface remains | A non-test composition invokes legacy factory or imports `phaseModelArgs` independently |
| `buildFireWorkflowPrompt` — `trident/inner-loop.ts:804` | Legacy factory/path chain (C1); `buildWorkflowFirer` occurrence at `trident/inner-loop.ts:995` | P; public/test surface remains | A non-test composition invokes legacy factory or imports `buildFireWorkflowPrompt` independently |
| `parseInnerResult` — `trident/inner-loop.ts:848` | runtime harvest at `trident/recovery-liveness.ts:122`; review at `trident/review-run.ts:307` | H | Replace the cited producer/consumer contract or parser before deleting this symbol |
| `normalizeVerdict` — `trident/inner-loop.ts:968` | live parser calls at `trident/inner-loop.ts:860` | H | Replace the cited producer/consumer contract or parser before deleting this symbol |
| `buildWorkflowFirer` — `trident/inner-loop.ts:980` | Legacy factory/path chain (C1); public factory/options, `trident/index.ts:171,187` | P; public/test surface remains | A non-test composition invokes legacy factory or imports `buildWorkflowFirer` independently |
| `BuildSubstrateWorkflowFireOptions` — `trident/inner-loop.ts:1008` | Legacy factory/path chain (C1); `buildSubstrateWorkflowFire` occurrence at `trident/inner-loop.ts:1044` | P; public/test surface remains | A non-test composition invokes legacy factory or imports `BuildSubstrateWorkflowFireOptions` independently |
| `buildSubstrateWorkflowFire` — `trident/inner-loop.ts:1043` | Legacy factory/path chain (C1); public factory/options, `trident/index.ts:171,187` | P; public/test surface remains | A non-test composition invokes legacy factory or imports `buildSubstrateWorkflowFire` independently |

### Workflow declaration census — path selection precedes internal reachability

All rows below are inside the same path-executed body. **P** means the inspected new composer does not select that body (C1), but the legacy path and the 51 literal test pins remain. “Occurrence” gives a location to inspect inside the conditional body; it is deliberately not presented as proof of production execution. Local control-flow variables under the main `try`/loop/finally are owned by that body (`trident/inner-workflow.mjs:5700,6482,7009`). Test harness execution is positive evidence for the non-import mechanism: `trident/inner-workflow-resume.test.ts:288` constructs an AsyncFunction with injected `agent`, `parallel`, `phase`, `log`, `budget`, `args`.

| Symbol / definition | Reached by what inside the legacy body | Confidence | Falsifier |
| --- | --- | --- | --- |
| `meta` — `trident/inner-workflow.mjs:3` | Path/body P; internal consumer UNKNOWN | P / U | Locate a body/loader use of `meta` beyond its declaration; C6 controls the negative search |
| `normalizeWorkflowArgs` — `trident/inner-workflow.mjs:21` | P; occurrence `trident/inner-workflow.mjs:226` | P, lexical | FP: execute body and trace `normalizeWorkflowArgs` |
| `repoPath` — `trident/inner-workflow.mjs:34` | P; occurrence `trident/inner-workflow.mjs:237` | P, lexical | FP: execute body and trace `repoPath` |
| `task` — `trident/inner-workflow.mjs:35` | P; occurrence `trident/inner-workflow.mjs:1501` | P, lexical | FP: execute body and trace `task` |
| `baseBranch` — `trident/inner-workflow.mjs:36` | P; occurrence `trident/inner-workflow.mjs:1210` | P, lexical | FP: execute body and trace `baseBranch` |
| `slug` — `trident/inner-workflow.mjs:37` | P; occurrence `trident/inner-workflow.mjs:283` | P, lexical | FP: execute body and trace `slug` |
| `maxRounds` — `trident/inner-workflow.mjs:59` | P; occurrence `trident/inner-workflow.mjs:3554` | P, lexical | FP: execute body and trace `maxRounds` |
| `laneRetryAttempts` — `trident/inner-workflow.mjs:60` | Path/body P; internal consumer UNKNOWN | P / U | Locate a body/loader use of `laneRetryAttempts` beyond its declaration; C6 controls the negative search |
| `ralph` — `trident/inner-workflow.mjs:61` | P; occurrence `trident/inner-workflow.mjs:3147` | P, lexical | FP: execute body and trace `ralph` |
| `ralphRound` — `trident/inner-workflow.mjs:71` | P; occurrence `trident/inner-workflow.mjs:5957` | P, lexical | FP: execute body and trace `ralphRound` |
| `mergeMode` — `trident/inner-workflow.mjs:74` | P; occurrence `trident/inner-workflow.mjs:273` | P, lexical | FP: execute body and trace `mergeMode` |
| `baseSha` — `trident/inner-workflow.mjs:77` | P; occurrence `trident/inner-workflow.mjs:1197` | P, lexical | FP: execute body and trace `baseSha` |
| `prNumber` — `trident/inner-workflow.mjs:78` | P; occurrence `trident/inner-workflow.mjs:278` | P, lexical | FP: execute body and trace `prNumber` |
| `branch` — `trident/inner-workflow.mjs:79` | P; occurrence `trident/inner-workflow.mjs:283` | P, lexical | FP: execute body and trace `branch` |
| `pinnedTaskId` — `trident/inner-workflow.mjs:82` | P; occurrence `trident/inner-workflow.mjs:269` | P, lexical | FP: execute body and trace `pinnedTaskId` |
| `memberBranch` — `trident/inner-workflow.mjs:83` | P; occurrence `trident/inner-workflow.mjs:270` | P, lexical | FP: execute body and trace `memberBranch` |
| `dbPath` — `trident/inner-workflow.mjs:84` | P; occurrence `trident/inner-workflow.mjs:244` | P, lexical | FP: execute body and trace `dbPath` |
| `runId` — `trident/inner-workflow.mjs:85` | P; occurrence `trident/inner-workflow.mjs:244` | P, lexical | FP: execute body and trace `runId` |
| `resumeCheckpoint` — `trident/inner-workflow.mjs:86` | P; occurrence `trident/inner-workflow.mjs:278` | P, lexical | FP: execute body and trace `resumeCheckpoint` |
| `resumeCheckpointHead` — `trident/inner-workflow.mjs:95` | P; occurrence `trident/inner-workflow.mjs:5707` | P, lexical | FP: execute body and trace `resumeCheckpointHead` |
| `resumeLiveHead` — `trident/inner-workflow.mjs:107` | P; occurrence `trident/inner-workflow.mjs:5722` | P, lexical | FP: execute body and trace `resumeLiveHead` |
| `resumeFindings` — `trident/inner-workflow.mjs:113` | P; occurrence `trident/inner-workflow.mjs:5708` | P, lexical | FP: execute body and trace `resumeFindings` |
| `codexHome` — `trident/inner-workflow.mjs:120` | P; occurrence `trident/inner-workflow.mjs:230` | P, lexical | FP: execute body and trace `codexHome` |
| `kimiConfiguredArg` — `trident/inner-workflow.mjs:125` | P; occurrence `trident/inner-workflow.mjs:231` | P, lexical | FP: execute body and trace `kimiConfiguredArg` |
| `checkpointScript` — `trident/inner-workflow.mjs:134` | P; occurrence `trident/inner-workflow.mjs:237` | P, lexical | FP: execute body and trace `checkpointScript` |
| `stageStampScript` — `trident/inner-workflow.mjs:135` | P; occurrence `trident/inner-workflow.mjs:238` | P, lexical | FP: execute body and trace `stageStampScript` |
| `codexBuildScript` — `trident/inner-workflow.mjs:136` | P; occurrence `trident/inner-workflow.mjs:252` | P, lexical | FP: execute body and trace `codexBuildScript` |
| `codexReviewScript` — `trident/inner-workflow.mjs:137` | P; occurrence `trident/inner-workflow.mjs:258` | P, lexical | FP: execute body and trace `codexReviewScript` |
| `apiReviewScript` — `trident/inner-workflow.mjs:138` | P; occurrence `trident/inner-workflow.mjs:5180` | P, lexical | FP: execute body and trace `apiReviewScript` |
| `worktreeCleanupScript` — `trident/inner-workflow.mjs:145` | P; occurrence `trident/inner-workflow.mjs:262` | P, lexical | FP: execute body and trace `worktreeCleanupScript` |
| `ghAuthedScript` — `trident/inner-workflow.mjs:159` | P; occurrence `trident/inner-workflow.mjs:4420` | P, lexical | FP: execute body and trace `ghAuthedScript` |
| `ghDataDir` — `trident/inner-workflow.mjs:160` | P; occurrence `trident/inner-workflow.mjs:4422` | P, lexical | FP: execute body and trace `ghDataDir` |
| `ghOwnerHandle` — `trident/inner-workflow.mjs:161` | P; occurrence `trident/inner-workflow.mjs:4424` | P, lexical | FP: execute body and trace `ghOwnerHandle` |
| `bunBin` — `trident/inner-workflow.mjs:162` | P; occurrence `trident/inner-workflow.mjs:4428` | P, lexical | FP: execute body and trace `bunBin` |
| `models` — `trident/inner-workflow.mjs:171` | P; occurrence `trident/inner-workflow.mjs:293` | P, lexical | FP: execute body and trace `models` |
| `reflectionGuidance` — `trident/inner-workflow.mjs:181` | P; occurrence `trident/inner-workflow.mjs:1501` | P, lexical | FP: execute body and trace `reflectionGuidance` |
| `testStrategy` — `trident/inner-workflow.mjs:199` | P; occurrence `trident/inner-workflow.mjs:1281` | P, lexical | FP: execute body and trace `testStrategy` |
| `testStrategyIntermediate` — `trident/inner-workflow.mjs:200` | P; occurrence `trident/inner-workflow.mjs:1280` | P, lexical | FP: execute body and trace `testStrategyIntermediate` |
| `phaseModels` — `trident/inner-workflow.mjs:206` | P; occurrence `trident/inner-workflow.mjs:525` | P, lexical | FP: execute body and trace `phaseModels` |
| `modelTiers` — `trident/inner-workflow.mjs:220` | P; occurrence `trident/inner-workflow.mjs:311` | P, lexical | FP: execute body and trace `modelTiers` |
| `briefParts` — `trident/inner-workflow.mjs:225` | P; occurrence `trident/inner-workflow.mjs:1485` | P, lexical | FP: execute body and trace `briefParts` |
| `codexConfigured` — `trident/inner-workflow.mjs:230` | P; occurrence `trident/inner-workflow.mjs:564` | P, lexical | FP: execute body and trace `codexConfigured` |
| `kimiConfigured` — `trident/inner-workflow.mjs:231` | P; occurrence `trident/inner-workflow.mjs:125` | P, lexical | FP: execute body and trace `kimiConfigured` |
| `checkpointSh` — `trident/inner-workflow.mjs:237` | P; occurrence `trident/inner-workflow.mjs:1608` | P, lexical | FP: execute body and trace `checkpointSh` |
| `stageStampSh` — `trident/inner-workflow.mjs:238` | P; occurrence `trident/inner-workflow.mjs:245` | P, lexical | FP: execute body and trace `stageStampSh` |
| `workflowStageStampCommand` — `trident/inner-workflow.mjs:243` | P; occurrence `trident/inner-workflow.mjs:1600` | P, lexical | FP: execute body and trace `workflowStageStampCommand` |
| `codexBuildSh` — `trident/inner-workflow.mjs:251` | P; occurrence `trident/inner-workflow.mjs:1541` | P, lexical | FP: execute body and trace `codexBuildSh` |
| `codexReviewSh` — `trident/inner-workflow.mjs:257` | P; occurrence `trident/inner-workflow.mjs:5132` | P, lexical | FP: execute body and trace `codexReviewSh` |
| `worktreeCleanupSh` — `trident/inner-workflow.mjs:262` | P; occurrence `trident/inner-workflow.mjs:7010` | P, lexical | FP: execute body and trace `worktreeCleanupSh` |
| `memberMode` — `trident/inner-workflow.mjs:268` | P; occurrence `trident/inner-workflow.mjs:271` | P, lexical | FP: execute body and trace `memberMode` |
| `pinnedMemberTaskId` — `trident/inner-workflow.mjs:271` | P; occurrence `trident/inner-workflow.mjs:287` | P, lexical | FP: execute body and trace `pinnedMemberTaskId` |
| `pinnedMemberBranch` — `trident/inner-workflow.mjs:272` | P; occurrence `trident/inner-workflow.mjs:283` | P, lexical | FP: execute body and trace `pinnedMemberBranch` |
| `isPr` — `trident/inner-workflow.mjs:273` | P; occurrence `trident/inner-workflow.mjs:1246` | P, lexical | FP: execute body and trace `isPr` |
| `resuming` — `trident/inner-workflow.mjs:278` | P; occurrence `trident/inner-workflow.mjs:1860` | P, lexical | FP: execute body and trace `resuming` |
| `forgeBranch` — `trident/inner-workflow.mjs:283` | P; occurrence `trident/inner-workflow.mjs:289` | P, lexical | FP: execute body and trace `forgeBranch` |
| `nominationBranch` — `trident/inner-workflow.mjs:286` | P; occurrence `trident/inner-workflow.mjs:290` | P, lexical | FP: execute body and trace `nominationBranch` |
| `mutationClaimArtifactPath` — `trident/inner-workflow.mjs:290` | P; occurrence `trident/inner-workflow.mjs:1294` | P, lexical | FP: execute body and trace `mutationClaimArtifactPath` |
| `threadedModels` — `trident/inner-workflow.mjs:293` | P; occurrence `trident/inner-workflow.mjs:295` | P, lexical | FP: execute body and trace `threadedModels` |
| `pickModel` — `trident/inner-workflow.mjs:294` | P; occurrence `trident/inner-workflow.mjs:302` | P, lexical | FP: execute body and trace `pickModel` |
| `LANE_RETRY_ATTEMPTS` — `trident/inner-workflow.mjs:299` | P; occurrence `trident/inner-workflow.mjs:5363` | P, lexical | FP: execute body and trace `LANE_RETRY_ATTEMPTS` |
| `MODELS` — `trident/inner-workflow.mjs:301` | P; occurrence `trident/inner-workflow.mjs:336` | P, lexical | FP: execute body and trace `MODELS` |
| `threadedTiers` — `trident/inner-workflow.mjs:310` | P; occurrence `trident/inner-workflow.mjs:323` | P, lexical | FP: execute body and trace `threadedTiers` |
| `resolveTier` — `trident/inner-workflow.mjs:322` | P; occurrence `trident/inner-workflow.mjs:346` | P, lexical | FP: execute body and trace `resolveTier` |
| `cliRoute` — `trident/inner-workflow.mjs:345` | P; occurrence `trident/inner-workflow.mjs:482` | P, lexical | FP: execute body and trace `cliRoute` |
| `CODEX_BUILD_MODEL_ENV` — `trident/inner-workflow.mjs:368` | P; occurrence `trident/inner-workflow.mjs:378` | P, lexical | FP: execute body and trace `CODEX_BUILD_MODEL_ENV` |
| `codexBuildRoute` — `trident/inner-workflow.mjs:369` | P; occurrence `trident/inner-workflow.mjs:619` | P, lexical | FP: execute body and trace `codexBuildRoute` |
| `codexReviewRoute` — `trident/inner-workflow.mjs:381` | P; occurrence `trident/inner-workflow.mjs:618` | P, lexical | FP: execute body and trace `codexReviewRoute` |
| `kimiReviewRoute` — `trident/inner-workflow.mjs:390` | P; occurrence `trident/inner-workflow.mjs:616` | P, lexical | FP: execute body and trace `kimiReviewRoute` |
| `claudeReviewRoute` — `trident/inner-workflow.mjs:415` | P; occurrence `trident/inner-workflow.mjs:597` | P, lexical | FP: execute body and trace `claudeReviewRoute` |
| `modelForTag` — `trident/inner-workflow.mjs:435` | P; occurrence `trident/inner-workflow.mjs:660` | P, lexical | FP: execute body and trace `modelForTag` |
| `ROLE_MODEL` — `trident/inner-workflow.mjs:453` | P; occurrence `trident/inner-workflow.mjs:512` | P, lexical | FP: execute body and trace `ROLE_MODEL` |
| `claudeSeatEffort` — `trident/inner-workflow.mjs:512` | P; occurrence `trident/inner-workflow.mjs:602` | P, lexical | FP: execute body and trace `claudeSeatEffort` |
| `threadedPhaseModels` — `trident/inner-workflow.mjs:524` | P; occurrence `trident/inner-workflow.mjs:544` | P, lexical | FP: execute body and trace `threadedPhaseModels` |
| `VALID_EFFORTS` — `trident/inner-workflow.mjs:526` | P; occurrence `trident/inner-workflow.mjs:594` | P, lexical | FP: execute body and trace `VALID_EFFORTS` |
| `phaseOverrideFor` — `trident/inner-workflow.mjs:543` | P; occurrence `trident/inner-workflow.mjs:548` | P, lexical | FP: execute body and trace `phaseOverrideFor` |
| `applyPhaseOverride` — `trident/inner-workflow.mjs:546` | P; occurrence `trident/inner-workflow.mjs:690` | P, lexical | FP: execute body and trace `applyPhaseOverride` |
| `routeModel` — `trident/inner-workflow.mjs:657` | P; occurrence `trident/inner-workflow.mjs:698` | P, lexical | FP: execute body and trace `routeModel` |
| `withModel` — `trident/inner-workflow.mjs:697` | P; occurrence `trident/inner-workflow.mjs:1736` | P, lexical | FP: execute body and trace `withModel` |
| `crossModelEnvPrefix` — `trident/inner-workflow.mjs:733` | P; occurrence `trident/inner-workflow.mjs:763` | P, lexical | FP: execute body and trace `crossModelEnvPrefix` |
| `logCrossModelSpawn` — `trident/inner-workflow.mjs:749` | P; occurrence `trident/inner-workflow.mjs:5262` | P, lexical | FP: execute body and trace `logCrossModelSpawn` |
| `ADVERSARIAL_CODEX_ENV_PREFIX` — `trident/inner-workflow.mjs:763` | P; occurrence `trident/inner-workflow.mjs:5148` | P, lexical | FP: execute body and trace `ADVERSARIAL_CODEX_ENV_PREFIX` |
| `VERDICT_SCHEMA` — `trident/inner-workflow.mjs:767` | P; occurrence `trident/inner-workflow.mjs:838` | P, lexical | FP: execute body and trace `VERDICT_SCHEMA` |
| `CODEX_VERDICT_SCHEMA` — `trident/inner-workflow.mjs:832` | P; occurrence `trident/inner-workflow.mjs:5266` | P, lexical | FP: execute body and trace `CODEX_VERDICT_SCHEMA` |
| `KIMI_VERDICT_SCHEMA` — `trident/inner-workflow.mjs:849` | P; occurrence `trident/inner-workflow.mjs:5291` | P, lexical | FP: execute body and trace `KIMI_VERDICT_SCHEMA` |
| `FORGE_SCHEMA` — `trident/inner-workflow.mjs:868` | P; occurrence `trident/inner-workflow.mjs:939` | P, lexical | FP: execute body and trace `FORGE_SCHEMA` |
| `CODEX_FORGE_SCHEMA` — `trident/inner-workflow.mjs:935` | P; occurrence `trident/inner-workflow.mjs:1750` | P, lexical | FP: execute body and trace `CODEX_FORGE_SCHEMA` |
| `PLAN_SCHEMA` — `trident/inner-workflow.mjs:966` | P; occurrence `trident/inner-workflow.mjs:5929` | P, lexical | FP: execute body and trace `PLAN_SCHEMA` |
| `PLAN_REFRESH_EVERY` — `trident/inner-workflow.mjs:1001` | P; occurrence `trident/inner-workflow.mjs:5970` | P, lexical | FP: execute body and trace `PLAN_REFRESH_EVERY` |
| `PLAN_PROBE_SCHEMA` — `trident/inner-workflow.mjs:1017` | P; occurrence `trident/inner-workflow.mjs:6002` | P, lexical | FP: execute body and trace `PLAN_PROBE_SCHEMA` |
| `probeBodyIntact` — `trident/inner-workflow.mjs:1034` | P; occurrence `trident/inner-workflow.mjs:6025` | P, lexical | FP: execute body and trace `probeBodyIntact` |
| `countUnchecked` — `trident/inner-workflow.mjs:1064` | P; occurrence `trident/inner-workflow.mjs:6016` | P, lexical | FP: execute body and trace `countUnchecked` |
| `firstUncheckedTask` — `trident/inner-workflow.mjs:1074` | P; occurrence `trident/inner-workflow.mjs:6119` | P, lexical | FP: execute body and trace `firstUncheckedTask` |
| `pinnedUncheckedTaskLine` — `trident/inner-workflow.mjs:1086` | P; occurrence `trident/inner-workflow.mjs:5939` | P, lexical | FP: execute body and trace `pinnedUncheckedTaskLine` |
| `cksumOf` — `trident/inner-workflow.mjs:1115` | P; occurrence `trident/inner-workflow.mjs:1040` | P, lexical | FP: execute body and trace `cksumOf` |
| `NO_INTERACTIVE_RULE` — `trident/inner-workflow.mjs:1165` | P; occurrence `trident/inner-workflow.mjs:1287` | P, lexical | FP: execute body and trace `NO_INTERACTIVE_RULE` |
| `REDIRECT_RULE` — `trident/inner-workflow.mjs:1168` | P; occurrence `trident/inner-workflow.mjs:1287` | P, lexical | FP: execute body and trace `REDIRECT_RULE` |
| `NO_PATTERN_KILL_RULE` — `trident/inner-workflow.mjs:1192` | P; occurrence `trident/inner-workflow.mjs:1290` | P, lexical | FP: execute body and trace `NO_PATTERN_KILL_RULE` |
| `OBJECT_NAME_RE` — `trident/inner-workflow.mjs:1196` | P; occurrence `trident/inner-workflow.mjs:1197` | P, lexical | FP: execute body and trace `OBJECT_NAME_RE` |
| `pinnedBase` — `trident/inner-workflow.mjs:1197` | P; occurrence `trident/inner-workflow.mjs:1231` | P, lexical | FP: execute body and trace `pinnedBase` |
| `UNRESOLVABLE_BASE_OID` — `trident/inner-workflow.mjs:1202` | P; occurrence `trident/inner-workflow.mjs:1227` | P, lexical | FP: execute body and trace `UNRESOLVABLE_BASE_OID` |
| `unpinnedDiffBase` — `trident/inner-workflow.mjs:1205` | P; occurrence `trident/inner-workflow.mjs:1242` | P, lexical | FP: execute body and trace `unpinnedDiffBase` |
| `diffBase` — `trident/inner-workflow.mjs:1230` | P; occurrence `trident/inner-workflow.mjs:1307` | P, lexical | FP: execute body and trace `diffBase` |
| `forgeStep1` — `trident/inner-workflow.mjs:1244` | P; occurrence `trident/inner-workflow.mjs:1303` | P, lexical | FP: execute body and trace `forgeStep1` |
| `forgePushStep` — `trident/inner-workflow.mjs:1263` | P; occurrence `trident/inner-workflow.mjs:1306` | P, lexical | FP: execute body and trace `forgePushStep` |
| `FORGE_PR_LINE` — `trident/inner-workflow.mjs:1271` | P; occurrence `trident/inner-workflow.mjs:1309` | P, lexical | FP: execute body and trace `FORGE_PR_LINE` |
| `forgeBuildContract` — `trident/inner-workflow.mjs:1278` | P; occurrence `trident/inner-workflow.mjs:6198` | P, lexical | FP: execute body and trace `forgeBuildContract` |
| `codexBuildDiffFile` — `trident/inner-workflow.mjs:1324` | P; occurrence `trident/inner-workflow.mjs:1377` | P, lexical | FP: execute body and trace `codexBuildDiffFile` |
| `briefIntegrity` — `trident/inner-workflow.mjs:1327` | P; occurrence `trident/inner-workflow.mjs:1435` | P, lexical | FP: execute body and trace `briefIntegrity` |
| `codexBuildCoda` — `trident/inner-workflow.mjs:1367` | P; occurrence `trident/inner-workflow.mjs:1500` | P, lexical | FP: execute body and trace `codexBuildCoda` |
| `CODEX_BRIEF_CHUNK_BYTES` — `trident/inner-workflow.mjs:1383` | P; occurrence `trident/inner-workflow.mjs:1563` | P, lexical | FP: execute body and trace `CODEX_BRIEF_CHUNK_BYTES` |
| `base64Encode` — `trident/inner-workflow.mjs:1386` | P; occurrence `trident/inner-workflow.mjs:1429` | P, lexical | FP: execute body and trace `base64Encode` |
| `renderBriefChunks` — `trident/inner-workflow.mjs:1423` | P; occurrence `trident/inner-workflow.mjs:1567` | P, lexical | FP: execute body and trace `renderBriefChunks` |
| `chunkTextOnLines` — `trident/inner-workflow.mjs:1434` | P; occurrence `trident/inner-workflow.mjs:1563` | P, lexical | FP: execute body and trace `chunkTextOnLines` |
| `codexBriefByPath` — `trident/inner-workflow.mjs:1483` | P; occurrence `trident/inner-workflow.mjs:1530` | P, lexical | FP: execute body and trace `codexBriefByPath` |
| `wrapperErrTailInstruction` — `trident/inner-workflow.mjs:1516` | P; occurrence `trident/inner-workflow.mjs:1655` | P, lexical | FP: execute body and trace `wrapperErrTailInstruction` |
| `codexDeferralMessage` — `trident/inner-workflow.mjs:1520` | P; occurrence `trident/inner-workflow.mjs:1808` | P, lexical | FP: execute body and trace `codexDeferralMessage` |
| `codexBuildPrompt` — `trident/inner-workflow.mjs:1527` | P; occurrence `trident/inner-workflow.mjs:1744` | P, lexical | FP: execute body and trace `codexBuildPrompt` |
| `codexTrailerProbePrompt` — `trident/inner-workflow.mjs:1659` | P; occurrence `trident/inner-workflow.mjs:1773` | P, lexical | FP: execute body and trace `codexTrailerProbePrompt` |
| `codexCollectPrompt` — `trident/inner-workflow.mjs:1670` | P; occurrence `trident/inner-workflow.mjs:1780` | P, lexical | FP: execute body and trace `codexCollectPrompt` |
| `codexWaitMorePrompt` — `trident/inner-workflow.mjs:1692` | P; occurrence `trident/inner-workflow.mjs:1792` | P, lexical | FP: execute body and trace `codexWaitMorePrompt` |
| `forgeAgent` — `trident/inner-workflow.mjs:1729` | P; occurrence `trident/inner-workflow.mjs:6195` | P, lexical | FP: execute body and trace `forgeAgent` |
| `ARGUS_RUBRIC` — `trident/inner-workflow.mjs:1843` | P; occurrence `trident/inner-workflow.mjs:5244` | P, lexical | FP: execute body and trace `ARGUS_RUBRIC` |
| `planFablePrompt` — `trident/inner-workflow.mjs:1860` | P; occurrence `trident/inner-workflow.mjs:6066` | P, lexical | FP: execute body and trace `planFablePrompt` |
| `rePlanPrompt` — `trident/inner-workflow.mjs:1908` | P; occurrence `trident/inner-workflow.mjs:6592` | P, lexical | FP: execute body and trace `rePlanPrompt` |
| `memberPlanPrompt` — `trident/inner-workflow.mjs:1934` | P; occurrence `trident/inner-workflow.mjs:5928` | P, lexical | FP: execute body and trace `memberPlanPrompt` |
| `BRANCH_BRIEF_MAX_BYTES` — `trident/inner-workflow.mjs:1971` | P; occurrence `trident/inner-workflow.mjs:2104` | P, lexical | FP: execute body and trace `BRANCH_BRIEF_MAX_BYTES` |
| `BRANCH_LOG_MAX_BYTES` — `trident/inner-workflow.mjs:1972` | P; occurrence `trident/inner-workflow.mjs:1992` | P, lexical | FP: execute body and trace `BRANCH_LOG_MAX_BYTES` |
| `planProbeRef` — `trident/inner-workflow.mjs:1974` | P; occurrence `trident/inner-workflow.mjs:1979` | P, lexical | FP: execute body and trace `planProbeRef` |
| `branchLogBase` — `trident/inner-workflow.mjs:1976` | P; occurrence `trident/inner-workflow.mjs:1992` | P, lexical | FP: execute body and trace `branchLogBase` |
| `planProbePrompt` — `trident/inner-workflow.mjs:1978` | P; occurrence `trident/inner-workflow.mjs:6001` | P, lexical | FP: execute body and trace `planProbePrompt` |
| `planNextPrompt` — `trident/inner-workflow.mjs:2006` | P; occurrence `trident/inner-workflow.mjs:6058` | P, lexical | FP: execute body and trace `planNextPrompt` |
| `utf8ByteWidth` — `trident/inner-workflow.mjs:2037` | P; occurrence `trident/inner-workflow.mjs:2086` | P, lexical | FP: execute body and trace `utf8ByteWidth` |
| `BRANCH_LOG_FENCE_OPEN` — `trident/inner-workflow.mjs:2053` | P; occurrence `trident/inner-workflow.mjs:2030` | P, lexical | FP: execute body and trace `BRANCH_LOG_FENCE_OPEN` |
| `BRANCH_LOG_FENCE_CLOSE` — `trident/inner-workflow.mjs:2054` | P; occurrence `trident/inner-workflow.mjs:2032` | P, lexical | FP: execute body and trace `BRANCH_LOG_FENCE_CLOSE` |
| `BRANCH_BRIEF_FENCE_OPEN` — `trident/inner-workflow.mjs:2055` | P; occurrence `trident/inner-workflow.mjs:2072` | P, lexical | FP: execute body and trace `BRANCH_BRIEF_FENCE_OPEN` |
| `BRANCH_BRIEF_FENCE_CLOSE` — `trident/inner-workflow.mjs:2056` | P; occurrence `trident/inner-workflow.mjs:2070` | P, lexical | FP: execute body and trace `BRANCH_BRIEF_FENCE_CLOSE` |
| `neutraliseFenceDelimiters` — `trident/inner-workflow.mjs:2058` | P; occurrence `trident/inner-workflow.mjs:2082` | P, lexical | FP: execute body and trace `neutraliseFenceDelimiters` |
| `neutraliseBranchBriefFenceDelimiters` — `trident/inner-workflow.mjs:2068` | P; occurrence `trident/inner-workflow.mjs:2099` | P, lexical | FP: execute body and trace `neutraliseBranchBriefFenceDelimiters` |
| `clampBranchLog` — `trident/inner-workflow.mjs:2080` | P; occurrence `trident/inner-workflow.mjs:2012` | P, lexical | FP: execute body and trace `clampBranchLog` |
| `clampBranchBrief` — `trident/inner-workflow.mjs:2094` | P; occurrence `trident/inner-workflow.mjs:2137` | P, lexical | FP: execute body and trace `clampBranchBrief` |
| `ralphExecuteNote` — `trident/inner-workflow.mjs:2124` | P; occurrence `trident/inner-workflow.mjs:6165` | P, lexical | FP: execute body and trace `ralphExecuteNote` |
| `memberExecuteNote` — `trident/inner-workflow.mjs:2151` | P; occurrence `trident/inner-workflow.mjs:5952` | P, lexical | FP: execute body and trace `memberExecuteNote` |
| `artifactCheckpointCommand` — `trident/inner-workflow.mjs:2162` | P; occurrence `trident/inner-workflow.mjs:1282` | P, lexical | FP: execute body and trace `artifactCheckpointCommand` |
| `checkpoint` — `trident/inner-workflow.mjs:2168` | P; occurrence `trident/inner-workflow.mjs:3090` | P, lexical | FP: execute body and trace `checkpoint` |
| `shSingleQuote` — `trident/inner-workflow.mjs:2194` | P; occurrence `trident/inner-workflow.mjs:245` | P, lexical | FP: execute body and trace `shSingleQuote` |
| `writeTerminalResult` — `trident/inner-workflow.mjs:2199` | P; occurrence `trident/inner-workflow.mjs:5769` | P, lexical | FP: execute body and trace `writeTerminalResult` |
| `normalizeVerdict` — `trident/inner-workflow.mjs:2251` | P; occurrence `trident/inner-workflow.mjs:2783` | P, lexical | FP: execute body and trace `normalizeVerdict` |
| `NON_BLOCKING_SEVERITIES` — `trident/inner-workflow.mjs:2320` | P; occurrence `trident/inner-workflow.mjs:2341` | P, lexical | FP: execute body and trace `NON_BLOCKING_SEVERITIES` |
| `ADVISORY_FINDING_KEY` — `trident/inner-workflow.mjs:2323` | P; occurrence `trident/inner-workflow.mjs:2340` | P, lexical | FP: execute body and trace `ADVISORY_FINDING_KEY` |
| `isNonBlockingFinding` — `trident/inner-workflow.mjs:2330` | P; occurrence `trident/inner-workflow.mjs:2445` | P, lexical | FP: execute body and trace `isNonBlockingFinding` |
| `stripAdvisoryMarkers` — `trident/inner-workflow.mjs:2362` | P; occurrence `trident/inner-workflow.mjs:5529` | P, lexical | FP: execute body and trace `stripAdvisoryMarkers` |
| `usableStatus` — `trident/inner-workflow.mjs:2418` | P; occurrence `trident/inner-workflow.mjs:2552` | P, lexical | FP: execute body and trace `usableStatus` |
| `errText` — `trident/inner-workflow.mjs:2423` | P; occurrence `trident/inner-workflow.mjs:2436` | P, lexical | FP: execute body and trace `errText` |
| `seatAttempt` — `trident/inner-workflow.mjs:2430` | P; occurrence `trident/inner-workflow.mjs:4311` | P, lexical | FP: execute body and trace `seatAttempt` |
| `enforceSeverityGate` — `trident/inner-workflow.mjs:2441` | P; occurrence `trident/inner-workflow.mjs:5545` | P, lexical | FP: execute body and trace `enforceSeverityGate` |
| `LANE_FINDING_KIND` — `trident/inner-workflow.mjs:2450` | P; occurrence `trident/inner-workflow.mjs:2385` | P, lexical | FP: execute body and trace `LANE_FINDING_KIND` |
| `KIMI_RATE_LIMIT_TOKEN` — `trident/inner-workflow.mjs:2459` | P; occurrence `trident/inner-workflow.mjs:5200` | P, lexical | FP: execute body and trace `KIMI_RATE_LIMIT_TOKEN` |
| `isCodeWorkFinding` — `trident/inner-workflow.mjs:2484` | P; occurrence `trident/inner-workflow.mjs:2581` | P, lexical | FP: execute body and trace `isCodeWorkFinding` |
| `enforceCrossModelGate` — `trident/inner-workflow.mjs:2512` | P; occurrence `trident/inner-workflow.mjs:5607` | P, lexical | FP: execute body and trace `enforceCrossModelGate` |
| `retryDeferredPeers` — `trident/inner-workflow.mjs:2530` | P; occurrence `trident/inner-workflow.mjs:5356` | P, lexical | FP: execute body and trace `retryDeferredPeers` |
| `classifyBlock` — `trident/inner-workflow.mjs:2573` | P; occurrence `trident/inner-workflow.mjs:5663` | P, lexical | FP: execute body and trace `classifyBlock` |
| `SELF_DECLARED_ESCALATION_KINDS` — `trident/inner-workflow.mjs:2592` | P; occurrence `trident/inner-workflow.mjs:2758` | P, lexical | FP: execute body and trace `SELF_DECLARED_ESCALATION_KINDS` |
| `ARITHMETIC_ESCALATION_KIND` — `trident/inner-workflow.mjs:2596` | P; occurrence `trident/inner-workflow.mjs:2835` | P, lexical | FP: execute body and trace `ARITHMETIC_ESCALATION_KIND` |
| `REPEATED_KEYS_MAX` — `trident/inner-workflow.mjs:2600` | P; occurrence `trident/inner-workflow.mjs:2620` | P, lexical | FP: execute body and trace `REPEATED_KEYS_MAX` |
| `redactedRepeatedKeys` — `trident/inner-workflow.mjs:2619` | P; occurrence `trident/inner-workflow.mjs:2810` | P, lexical | FP: execute body and trace `redactedRepeatedKeys` |
| `WHAT_IS_MISSING_MAX` — `trident/inner-workflow.mjs:2624` | P; occurrence `trident/inner-workflow.mjs:2765` | P, lexical | FP: execute body and trace `WHAT_IS_MISSING_MAX` |
| `findingIdentity` — `trident/inner-workflow.mjs:2635` | P; occurrence `trident/inner-workflow.mjs:2657` | P, lexical | FP: execute body and trace `findingIdentity` |
| `roundIdentity` — `trident/inner-workflow.mjs:2652` | P; occurrence `trident/inner-workflow.mjs:2683` | P, lexical | FP: execute body and trace `roundIdentity` |
| `repeatVerdict` — `trident/inner-workflow.mjs:2682` | P; occurrence `trident/inner-workflow.mjs:2791` | P, lexical | FP: execute body and trace `repeatVerdict` |
| `blockingFindingCount` — `trident/inner-workflow.mjs:2708` | P; occurrence `trident/inner-workflow.mjs:6506` | P, lexical | FP: execute body and trace `blockingFindingCount` |
| `progressVerdict` — `trident/inner-workflow.mjs:2727` | P; occurrence `trident/inner-workflow.mjs:2795` | P, lexical | FP: execute body and trace `progressVerdict` |
| `validateEscalationClaim` — `trident/inner-workflow.mjs:2749` | P; occurrence `trident/inner-workflow.mjs:2790` | P, lexical | FP: execute body and trace `validateEscalationClaim` |
| `contradictorySynthesis` — `trident/inner-workflow.mjs:2781` | P; occurrence `trident/inner-workflow.mjs:5656` | P, lexical | FP: execute body and trace `contradictorySynthesis` |
| `decideEscalation` — `trident/inner-workflow.mjs:2788` | P; occurrence `trident/inner-workflow.mjs:6526` | P, lexical | FP: execute body and trace `decideEscalation` |
| `eligibleFixFindings` — `trident/inner-workflow.mjs:2857` | P; occurrence `trident/inner-workflow.mjs:6505` | P, lexical | FP: execute body and trace `eligibleFixFindings` |
| `classifyDeltaPaths` — `trident/inner-workflow.mjs:2871` | P; occurrence `trident/inner-workflow.mjs:2918` | P, lexical | FP: execute body and trace `classifyDeltaPaths` |
| `classifyDeltaProbe` — `trident/inner-workflow.mjs:2911` | Path/body P; internal consumer UNKNOWN | P / U | Locate a body/loader use of `classifyDeltaProbe` beyond its declaration; C6 controls the negative search |
| `synthesisUnavailable` — `trident/inner-workflow.mjs:2922` | P; occurrence `trident/inner-workflow.mjs:2947` | P, lexical | FP: execute body and trace `synthesisUnavailable` |
| `SYNTHESIS_UNAVAILABLE` — `trident/inner-workflow.mjs:2947` | P; occurrence `trident/inner-workflow.mjs:2967` | P, lexical | FP: execute body and trace `SYNTHESIS_UNAVAILABLE` |
| `synthesisOrInfraBlock` — `trident/inner-workflow.mjs:2954` | P; occurrence `trident/inner-workflow.mjs:2998` | P, lexical | FP: execute body and trace `synthesisOrInfraBlock` |
| `reviewRoundOrInfraBlock` — `trident/inner-workflow.mjs:2996` | P; occurrence `trident/inner-workflow.mjs:4847` | P, lexical | FP: execute body and trace `reviewRoundOrInfraBlock` |
| `roundLanded` — `trident/inner-workflow.mjs:3031` | P; occurrence `trident/inner-workflow.mjs:3218` | P, lexical | FP: execute body and trace `roundLanded` |
| `FULL_OID` — `trident/inner-workflow.mjs:3051` | P; occurrence `trident/inner-workflow.mjs:3054` | P, lexical | FP: execute body and trace `FULL_OID` |
| `normalizeOid` — `trident/inner-workflow.mjs:3052` | P; occurrence `trident/inner-workflow.mjs:2180` | P, lexical | FP: execute body and trace `normalizeOid` |
| `OID_CLAIM` — `trident/inner-workflow.mjs:3063` | P; occurrence `trident/inner-workflow.mjs:3066` | P, lexical | FP: execute body and trace `OID_CLAIM` |
| `oidClaim` — `trident/inner-workflow.mjs:3064` | P; occurrence `trident/inner-workflow.mjs:6234` | P, lexical | FP: execute body and trace `oidClaim` |
| `classifyTrailerWait` — `trident/inner-workflow.mjs:3069` | P; occurrence `trident/inner-workflow.mjs:1776` | P, lexical | FP: execute body and trace `classifyTrailerWait` |
| `classifyResume` — `trident/inner-workflow.mjs:3089` | P; occurrence `trident/inner-workflow.mjs:5727` | P, lexical | FP: execute body and trace `classifyResume` |
| `resumeOnUnchangedHead` — `trident/inner-workflow.mjs:3130` | P; occurrence `trident/inner-workflow.mjs:3111` | P, lexical | FP: execute body and trace `resumeOnUnchangedHead` |
| `parseResumeRound` — `trident/inner-workflow.mjs:3164` | P; occurrence `trident/inner-workflow.mjs:5914` | P, lexical | FP: execute body and trace `parseResumeRound` |
| `classifyPrMerged` — `trident/inner-workflow.mjs:3174` | P; occurrence `trident/inner-workflow.mjs:4877` | P, lexical | FP: execute body and trace `classifyPrMerged` |
| `roundOutcome` — `trident/inner-workflow.mjs:3216` | P; occurrence `trident/inner-workflow.mjs:6734` | P, lexical | FP: execute body and trace `roundOutcome` |
| `mergedTerminalResult` — `trident/inner-workflow.mjs:3240` | P; occurrence `trident/inner-workflow.mjs:5776` | P, lexical | FP: execute body and trace `mergedTerminalResult` |
| `CI_PROBE_SCHEMA` — `trident/inner-workflow.mjs:3278` | P; occurrence `trident/inner-workflow.mjs:4453` | P, lexical | FP: execute body and trace `CI_PROBE_SCHEMA` |
| `PR_MERGE_PROBE_SCHEMA` — `trident/inner-workflow.mjs:3293` | P; occurrence `trident/inner-workflow.mjs:4875` | P, lexical | FP: execute body and trace `PR_MERGE_PROBE_SCHEMA` |
| `CLEANUP_SCHEMA` — `trident/inner-workflow.mjs:3310` | P; occurrence `trident/inner-workflow.mjs:7024` | P, lexical | FP: execute body and trace `CLEANUP_SCHEMA` |
| `classifyCleanupOutcome` — `trident/inner-workflow.mjs:3321` | P; occurrence `trident/inner-workflow.mjs:7031` | P, lexical | FP: execute body and trace `classifyCleanupOutcome` |
| `CI_FAILED_STATES` — `trident/inner-workflow.mjs:3355` | P; occurrence `trident/inner-workflow.mjs:4042` | P, lexical | FP: execute body and trace `CI_FAILED_STATES` |
| `CI_PENDING_STATES` — `trident/inner-workflow.mjs:3364` | P; occurrence `trident/inner-workflow.mjs:4047` | P, lexical | FP: execute body and trace `CI_PENDING_STATES` |
| `CI_UNNAMED_CHECK` — `trident/inner-workflow.mjs:3368` | P; occurrence `trident/inner-workflow.mjs:4040` | P, lexical | FP: execute body and trace `CI_UNNAMED_CHECK` |
| `REVIEW_READINESS_BUDGET_MS` — `trident/inner-workflow.mjs:3371` | P; occurrence `trident/inner-workflow.mjs:3375` | P, lexical | FP: execute body and trace `REVIEW_READINESS_BUDGET_MS` |
| `REVIEW_READINESS_RETRY_MS` — `trident/inner-workflow.mjs:3372` | P; occurrence `trident/inner-workflow.mjs:3375` | P, lexical | FP: execute body and trace `REVIEW_READINESS_RETRY_MS` |
| `REVIEW_READINESS_CONFIG_GRACE_MS` — `trident/inner-workflow.mjs:3374` | P; occurrence `trident/inner-workflow.mjs:3403` | P, lexical | FP: execute body and trace `REVIEW_READINESS_CONFIG_GRACE_MS` |
| `REVIEW_READINESS_ATTEMPTS` — `trident/inner-workflow.mjs:3379` | P; occurrence `trident/inner-workflow.mjs:3982` | P, lexical | FP: execute body and trace `REVIEW_READINESS_ATTEMPTS` |
| `readinessBudgetLabel` — `trident/inner-workflow.mjs:3396` | P; occurrence `trident/inner-workflow.mjs:4673` | P, lexical | FP: execute body and trace `readinessBudgetLabel` |
| `readinessGraceLabel` — `trident/inner-workflow.mjs:3402` | P; occurrence `trident/inner-workflow.mjs:3941` | P, lexical | FP: execute body and trace `readinessGraceLabel` |
| `redactProbeText` — `trident/inner-workflow.mjs:3415` | P; occurrence `trident/inner-workflow.mjs:2620` | P, lexical | FP: execute body and trace `redactProbeText` |
| `TERMINAL_CAUSE_MAX` — `trident/inner-workflow.mjs:3421` | P; occurrence `trident/inner-workflow.mjs:3423` | P, lexical | FP: execute body and trace `TERMINAL_CAUSE_MAX` |
| `infraCause` — `trident/inner-workflow.mjs:3422` | P; occurrence `trident/inner-workflow.mjs:5766` | P, lexical | FP: execute body and trace `infraCause` |
| `TERMINAL_CAUSE_KINDS` — `trident/inner-workflow.mjs:3444` | P; occurrence `trident/inner-workflow.mjs:3512` | P, lexical | FP: execute body and trace `TERMINAL_CAUSE_KINDS` |
| `TERMINAL_CAUSE_DIAGNOSTIC_MAX` — `trident/inner-workflow.mjs:3463` | P; occurrence `trident/inner-workflow.mjs:3478` | P, lexical | FP: execute body and trace `TERMINAL_CAUSE_DIAGNOSTIC_MAX` |
| `terminalCauseDiagnostic` — `trident/inner-workflow.mjs:3465` | P; occurrence `trident/inner-workflow.mjs:3521` | P, lexical | FP: execute body and trace `terminalCauseDiagnostic` |
| `reportQuietly` — `trident/inner-workflow.mjs:3484` | P; occurrence `trident/inner-workflow.mjs:3522` | P, lexical | FP: execute body and trace `reportQuietly` |
| `stampTerminalCause` — `trident/inner-workflow.mjs:3507` | P; occurrence `trident/inner-workflow.mjs:2202` | P, lexical | FP: execute body and trace `stampTerminalCause` |
| `reviewLoopTerminalCause` — `trident/inner-workflow.mjs:3541` | P; occurrence `trident/inner-workflow.mjs:6849` | P, lexical | FP: execute body and trace `reviewLoopTerminalCause` |
| `probeCause` — `trident/inner-workflow.mjs:3559` | P; occurrence `trident/inner-workflow.mjs:3689` | P, lexical | FP: execute body and trace `probeCause` |
| `PROBE_SECTION_KEYS` — `trident/inner-workflow.mjs:3566` | P; occurrence `trident/inner-workflow.mjs:3593` | P, lexical | FP: execute body and trace `PROBE_SECTION_KEYS` |
| `probeSections` — `trident/inner-workflow.mjs:3567` | P; occurrence `trident/inner-workflow.mjs:3612` | P, lexical | FP: execute body and trace `probeSections` |
| `classifyRequiredChecksProbe` — `trident/inner-workflow.mjs:3608` | P; occurrence `trident/inner-workflow.mjs:4620` | P, lexical | FP: execute body and trace `classifyRequiredChecksProbe` |
| `STATUS_CONTEXT_PENDING_STATES` — `trident/inner-workflow.mjs:3776` | P; occurrence `trident/inner-workflow.mjs:3797` | P, lexical | FP: execute body and trace `STATUS_CONTEXT_PENDING_STATES` |
| `normalizeRollupRow` — `trident/inner-workflow.mjs:3777` | P; occurrence `trident/inner-workflow.mjs:3883` | P, lexical | FP: execute body and trace `normalizeRollupRow` |
| `confirmedConfigError` — `trident/inner-workflow.mjs:3822` | P; occurrence `trident/inner-workflow.mjs:4650` | P, lexical | FP: execute body and trace `confirmedConfigError` |
| `classifyReviewReadiness` — `trident/inner-workflow.mjs:3829` | P; occurrence `trident/inner-workflow.mjs:4645` | P, lexical | FP: execute body and trace `classifyReviewReadiness` |
| `reviewWithPreconditions` — `trident/inner-workflow.mjs:3982` | P; occurrence `trident/inner-workflow.mjs:4845` | P, lexical | FP: execute body and trace `reviewWithPreconditions` |
| `classifyCi` — `trident/inner-workflow.mjs:4009` | P; occurrence `trident/inner-workflow.mjs:4456` | P, lexical | FP: execute body and trace `classifyCi` |
| `ciBlockerFindings` — `trident/inner-workflow.mjs:4065` | P; occurrence `trident/inner-workflow.mjs:5407` | P, lexical | FP: execute body and trace `ciBlockerFindings` |
| `ciFindingsBlock` — `trident/inner-workflow.mjs:4105` | P; occurrence `trident/inner-workflow.mjs:5410` | P, lexical | FP: execute body and trace `ciFindingsBlock` |
| `ciPreexistingNames` — `trident/inner-workflow.mjs:4124` | P; occurrence `trident/inner-workflow.mjs:5407` | P, lexical | FP: execute body and trace `ciPreexistingNames` |
| `ciDeferredPeer` — `trident/inner-workflow.mjs:4147` | P; occurrence `trident/inner-workflow.mjs:5605` | P, lexical | FP: execute body and trace `ciDeferredPeer` |
| `classifyCodeScanningAlerts` — `trident/inner-workflow.mjs:4173` | P; occurrence `trident/inner-workflow.mjs:4470` | P, lexical | FP: execute body and trace `classifyCodeScanningAlerts` |
| `codeScanningFindings` — `trident/inner-workflow.mjs:4196` | P; occurrence `trident/inner-workflow.mjs:5389` | P, lexical | FP: execute body and trace `codeScanningFindings` |
| `BRANCH_HEAD_SCHEMA` — `trident/inner-workflow.mjs:4216` | P; occurrence `trident/inner-workflow.mjs:4315` | P, lexical | FP: execute body and trace `BRANCH_HEAD_SCHEMA` |
| `CODEX_TRAILER_PROBE_SCHEMA` — `trident/inner-workflow.mjs:4230` | P; occurrence `trident/inner-workflow.mjs:1774` | P, lexical | FP: execute body and trace `CODEX_TRAILER_PROBE_SCHEMA` |
| `roundDidNotLandFinding` — `trident/inner-workflow.mjs:4243` | P; occurrence `trident/inner-workflow.mjs:6940` | P, lexical | FP: execute body and trace `roundDidNotLandFinding` |
| `roundLeftNoDiffFinding` — `trident/inner-workflow.mjs:4266` | P; occurrence `trident/inner-workflow.mjs:6942` | P, lexical | FP: execute body and trace `roundLeftNoDiffFinding` |
| `infraTerminalCause` — `trident/inner-workflow.mjs:4286` | P; occurrence `trident/inner-workflow.mjs:6843` | P, lexical | FP: execute body and trace `infraTerminalCause` |
| `readBranchHead` — `trident/inner-workflow.mjs:4301` | P; occurrence `trident/inner-workflow.mjs:5725` | P, lexical | FP: execute body and trace `readBranchHead` |
| `BUILT_HEAD_READ_ATTEMPTS` — `trident/inner-workflow.mjs:4328` | P; occurrence `trident/inner-workflow.mjs:4334` | P, lexical | FP: execute body and trace `BUILT_HEAD_READ_ATTEMPTS` |
| `readBuiltHead` — `trident/inner-workflow.mjs:4331` | P; occurrence `trident/inner-workflow.mjs:6228` | P, lexical | FP: execute body and trace `readBuiltHead` |
| `RESUME_DIFF_SCHEMA` — `trident/inner-workflow.mjs:4351` | P; occurrence `trident/inner-workflow.mjs:4392` | P, lexical | FP: execute body and trace `RESUME_DIFF_SCHEMA` |
| `writeResumeDiff` — `trident/inner-workflow.mjs:4376` | P; occurrence `trident/inner-workflow.mjs:5816` | P, lexical | FP: execute body and trace `writeResumeDiff` |
| `ghReadCommand` — `trident/inner-workflow.mjs:4418` | P; occurrence `trident/inner-workflow.mjs:4443` | P, lexical | FP: execute body and trace `ghReadCommand` |
| `probeCi` — `trident/inner-workflow.mjs:4441` | P; occurrence `trident/inner-workflow.mjs:5385` | P, lexical | FP: execute body and trace `probeCi` |
| `probeCodeScanningAlerts` — `trident/inner-workflow.mjs:4460` | P; occurrence `trident/inner-workflow.mjs:5387` | P, lexical | FP: execute body and trace `probeCodeScanningAlerts` |
| `encodeRefPath` — `trident/inner-workflow.mjs:4473` | P; occurrence `trident/inner-workflow.mjs:4583` | P, lexical | FP: execute body and trace `encodeRefPath` |
| `ciSection` — `trident/inner-workflow.mjs:4486` | P; occurrence `trident/inner-workflow.mjs:4603` | P, lexical | FP: execute body and trace `ciSection` |
| `mergeBaseCi` — `trident/inner-workflow.mjs:4540` | P; occurrence `trident/inner-workflow.mjs:4603` | P, lexical | FP: execute body and trace `mergeBaseCi` |
| `probeCiBase` — `trident/inner-workflow.mjs:4569` | P; occurrence `trident/inner-workflow.mjs:5406` | P, lexical | FP: execute body and trace `probeCiBase` |
| `probeRequiredChecks` — `trident/inner-workflow.mjs:4607` | P; occurrence `trident/inner-workflow.mjs:4649` | P, lexical | FP: execute body and trace `probeRequiredChecks` |
| `probeReviewReadiness` — `trident/inner-workflow.mjs:4624` | P; occurrence `trident/inner-workflow.mjs:4846` | P, lexical | FP: execute body and trace `probeReviewReadiness` |
| `reviewPreconditionDeferred` — `trident/inner-workflow.mjs:4653` | P; occurrence `trident/inner-workflow.mjs:4852` | P, lexical | FP: execute body and trace `reviewPreconditionDeferred` |
| `SUITE_FINDING_KIND` — `trident/inner-workflow.mjs:4683` | P; occurrence `trident/inner-workflow.mjs:2386` | P, lexical | FP: execute body and trace `SUITE_FINDING_KIND` |
| `SUITE_FINDING_PROMPT_MAX` — `trident/inner-workflow.mjs:4692` | P; occurrence `trident/inner-workflow.mjs:5220` | P, lexical | FP: execute body and trace `SUITE_FINDING_PROMPT_MAX` |
| `fullSuiteFindings` — `trident/inner-workflow.mjs:4694` | P; occurrence `trident/inner-workflow.mjs:6310` | P, lexical | FP: execute body and trace `fullSuiteFindings` |
| `suiteFindingsBlock` — `trident/inner-workflow.mjs:4803` | P; occurrence `trident/inner-workflow.mjs:4825` | P, lexical | FP: execute body and trace `suiteFindingsBlock` |
| `withSuiteBlocker` — `trident/inner-workflow.mjs:4821` | P; occurrence `trident/inner-workflow.mjs:6458` | P, lexical | FP: execute body and trace `withSuiteBlocker` |
| `runReviewRound` — `trident/inner-workflow.mjs:4838` | P; occurrence `trident/inner-workflow.mjs:6440` | P, lexical | FP: execute body and trace `runReviewRound` |
| `probePrMerged` — `trident/inner-workflow.mjs:4869` | P; occurrence `trident/inner-workflow.mjs:6334` | P, lexical | FP: execute body and trace `probePrMerged` |
| `crossModelPeerStatus` — `trident/inner-workflow.mjs:4887` | P; occurrence `trident/inner-workflow.mjs:5439` | P, lexical | FP: execute body and trace `crossModelPeerStatus` |
| `crossModelRateLimited` — `trident/inner-workflow.mjs:4896` | P; occurrence `trident/inner-workflow.mjs:2541` | P, lexical | FP: execute body and trace `crossModelRateLimited` |
| `crossModelRateLimitProvenance` — `trident/inner-workflow.mjs:4904` | P; occurrence `trident/inner-workflow.mjs:5664` | P, lexical | FP: execute body and trace `crossModelRateLimitProvenance` |
| `seatRateLimitKey` — `trident/inner-workflow.mjs:4912` | P; occurrence `trident/inner-workflow.mjs:5360` | P, lexical | FP: execute body and trace `seatRateLimitKey` |
| `CORE_SEAT_STATUS_KEY` — `trident/inner-workflow.mjs:4918` | P; occurrence `trident/inner-workflow.mjs:4891` | P, lexical | FP: execute body and trace `CORE_SEAT_STATUS_KEY` |
| `hasUsableVerdict` — `trident/inner-workflow.mjs:4933` | P; occurrence `trident/inner-workflow.mjs:4942` | P, lexical | FP: execute body and trace `hasUsableVerdict` |
| `missingCoreReviewers` — `trident/inner-workflow.mjs:4937` | P; occurrence `trident/inner-workflow.mjs:5438` | P, lexical | FP: execute body and trace `missingCoreReviewers` |
| `corePanelLine` — `trident/inner-workflow.mjs:4975` | P; occurrence `trident/inner-workflow.mjs:5483` | P, lexical | FP: execute body and trace `corePanelLine` |
| `rateLimitedPeer` — `trident/inner-workflow.mjs:4982` | P; occurrence `trident/inner-workflow.mjs:5063` | P, lexical | FP: execute body and trace `rateLimitedPeer` |
| `deferredCrossModelPeers` — `trident/inner-workflow.mjs:5045` | P; occurrence `trident/inner-workflow.mjs:5546` | P, lexical | FP: execute body and trace `deferredCrossModelPeers` |
| `codexPanelLine` — `trident/inner-workflow.mjs:5096` | Path/body P; internal consumer UNKNOWN | P / U | Locate a body/loader use of `codexPanelLine` beyond its declaration; C6 controls the negative search |
| `codexReviewerPrompt` — `trident/inner-workflow.mjs:5117` | P; occurrence `trident/inner-workflow.mjs:5263` | P, lexical | FP: execute body and trace `codexReviewerPrompt` |
| `refusedReviewSeat` — `trident/inner-workflow.mjs:5173` | P; occurrence `trident/inner-workflow.mjs:5311` | P, lexical | FP: execute body and trace `refusedReviewSeat` |
| `apiReviewerPrompt` — `trident/inner-workflow.mjs:5178` | P; occurrence `trident/inner-workflow.mjs:5286` | P, lexical | FP: execute body and trace `apiReviewerPrompt` |
| `kimiReviewerPrompt` — `trident/inner-workflow.mjs:5188` | P; occurrence `trident/inner-workflow.mjs:5289` | P, lexical | FP: execute body and trace `kimiReviewerPrompt` |
| `reviewAndSynthesize` — `trident/inner-workflow.mjs:5211` | P; occurrence `trident/inner-workflow.mjs:4847` | P, lexical | FP: execute body and trace `reviewAndSynthesize` |
| `finalVerdict` — `trident/inner-workflow.mjs:5679` | P; occurrence `trident/inner-workflow.mjs:3551` | P, lexical | FP: execute body and trace `finalVerdict` |
| `round` — `trident/inner-workflow.mjs:5680` | P; occurrence `trident/inner-workflow.mjs:1908` | P, lexical | FP: execute body and trace `round` |
| `pr` — `trident/inner-workflow.mjs:5681` | P; occurrence `trident/inner-workflow.mjs:2176` | P, lexical | FP: execute body and trace `pr` |
| `mutationClaim` — `trident/inner-workflow.mjs:5687` | P; occurrence `trident/inner-workflow.mjs:873` | P, lexical | FP: execute body and trace `mutationClaim` |
| `lastReviewRecord` — `trident/inner-workflow.mjs:5688` | P; occurrence `trident/inner-workflow.mjs:6459` | P, lexical | FP: execute body and trace `lastReviewRecord` |

**C6 — internal unknown controls:** `rg -n '\b(meta|laneRetryAttempts|classifyDeltaProbe|codexPanelLine|normalizeWorkflowArgs)\b' trident/inner-workflow.mjs` finds declarations at :3,60,2911,5096; `codexPanelLine` also appears in a comment at :5160. Positive control `normalizeWorkflowArgs` finds its definition :21 **and invocation :226**. No internal executable read was established for the four U entries by this identifier scan; a loader can separately read exported `meta`, and test extraction can read a function declaration by string. Thus these remain unknown internal consumers, not a gate-deletion authorization.

### Imported bindings and forwarded exports

This supplement enumerates direct named import specifiers with the same TypeScript parser. “Occurrence” excludes import/export declarations and comments, but is syntactic, not a TypeScript symbol-resolution proof (for example a shadowed `resolve` can match). It is used only to find candidates; it does not prove any import is the live owner. Imports into an H owner inherit that owner's conditional route; imports into P inherit its path limitation. **U0** means zero executable/type identifier occurrences under that scan; the positive control in the same scan is `prepareLaunch` at `trident/orchestrator.ts:1845` and `parseMutationClaim` at `trident/inner-loop.ts:862`. The grep control below independently exposes the import-only candidates. Removing a binding must preserve any module-evaluation requirement; this does not authorize removing its source module or forwarded export.

| Import binding / definition | ES source; body/type occurrence | Confidence | Falsifier |
| --- | --- | --- | --- |
| `projectBuildDriverReservation` — `trident/orchestrator.ts:1` | `./project-launcher.ts`; `trident/orchestrator.ts:2911` | H/P, lexical | FR: occurrence resolves to another binding |
| `projectBuildMeasuredUnknown` — `trident/orchestrator.ts:1` | `./project-launcher.ts`; `trident/orchestrator.ts:2972` | H/P, lexical | FR: occurrence resolves to another binding |
| `projectBuildPending` — `trident/orchestrator.ts:1` | `./project-launcher.ts`; `trident/orchestrator.ts:2981` | H/P, lexical | FR: occurrence resolves to another binding |
| `DEFAULT_MAX_INFRA_RETRIES` — `trident/orchestrator.ts:3` | `./infrastructure-retry.ts`; `trident/orchestrator.ts:1293` | H/P, lexical | FR: occurrence resolves to another binding |
| `INFRA_RETRY_BACKOFF_MS` — `trident/orchestrator.ts:4` | `./infrastructure-retry.ts`; `trident/orchestrator.ts:2434` | H/P, lexical | FR: occurrence resolves to another binding |
| `tryInfrastructureRetry` — `trident/orchestrator.ts:5` | `./infrastructure-retry.ts`; `trident/orchestrator.ts:2495` | H/P, lexical | FR: occurrence resolves to another binding |
| `prepareLaunch` — `trident/orchestrator.ts:14` | `./launch-preparation.ts`; `trident/orchestrator.ts:1845` | H/P, lexical | FR: occurrence resolves to another binding |
| `publishCommit` — `trident/orchestrator.ts:16` | `./publication.ts`; `trident/orchestrator.ts:1437` | H/P, lexical | FR: occurrence resolves to another binding |
| `remoteAlreadyAtPublishHead` — `trident/orchestrator.ts:17` | `./publication.ts`; zero occurrences (controlled AST scan) | U0 binding-only candidate | FI: bound reference to `remoteAlreadyAtPublishHead` or required module initialization |
| `resolveClaimedCommit` — `trident/orchestrator.ts:18` | `./publication.ts`; zero occurrences (controlled AST scan) | U0 binding-only candidate | FI: bound reference to `resolveClaimedCommit` or required module initialization |
| `sanitizeLeakAnnotation` — `trident/orchestrator.ts:19` | `./publication.ts`; zero occurrences (controlled AST scan) | U0 binding-only candidate | FI: bound reference to `sanitizeLeakAnnotation` or required module initialization |
| `createRecoveryLivenessStep` — `trident/orchestrator.ts:22` | `./recovery-liveness.ts`; `trident/orchestrator.ts:2876` | H/P, lexical | FR: occurrence resolves to another binding |
| `SharedLauncherStandDownInput` — `trident/orchestrator.ts:22` | `./recovery-liveness.ts`; `trident/orchestrator.ts:2799` | H/P, lexical | FR: occurrence resolves to another binding |
| `rebaseOntoObservedBase` — `trident/orchestrator.ts:23` | `./replay.ts`; zero occurrences (controlled AST scan) | U0 binding-only candidate | FI: bound reference to `rebaseOntoObservedBase` or required module initialization |
| `publishFailureReason` — `trident/orchestrator.ts:24` | `./publish-failure.ts`; zero occurrences (controlled AST scan) | U0 binding-only candidate | FI: bound reference to `publishFailureReason` or required module initialization |
| `redactPushError` — `trident/orchestrator.ts:24` | `./publish-failure.ts`; `trident/orchestrator.ts:1213` | H/P, lexical | FR: occurrence resolves to another binding |
| `fixLineage` — `trident/orchestrator.ts:28` | `./gates/fix-lineage.ts`; zero occurrences (controlled AST scan) | U0 binding-only candidate | FI: bound reference to `fixLineage` or required module initialization |
| `createFailureSalvageCapture` — `trident/orchestrator.ts:29` | `./failure-salvage.ts`; `trident/orchestrator.ts:1492` | H/P, lexical | FR: occurrence resolves to another binding |
| `WorktreeDisposition` — `trident/orchestrator.ts:29` | `./failure-salvage.ts`; `trident/orchestrator.ts:674` | H/P, lexical | FR: occurrence resolves to another binding |
| `unknownWorkerObservation` — `trident/orchestrator.ts:30` | `./worker-observation.ts`; `trident/orchestrator.ts:2954` | H/P, lexical | FR: occurrence resolves to another binding |
| `workerEvidence` — `trident/orchestrator.ts:30` | `./worker-observation.ts`; `trident/orchestrator.ts:3004` | H/P, lexical | FR: occurrence resolves to another binding |
| `RunWorkerObserver` — `trident/orchestrator.ts:30` | `./worker-observation.ts`; `trident/orchestrator.ts:575` | H/P, lexical | FR: occurrence resolves to another binding |
| `RunWorkerObservation` — `trident/orchestrator.ts:30` | `./worker-observation.ts`; zero occurrences (controlled AST scan) | U0 binding-only candidate | FI: bound reference to `RunWorkerObservation` or required module initialization |
| `appendFileSync` — `trident/orchestrator.ts:94` | `node:fs`; zero occurrences (controlled AST scan) | U0 binding-only candidate | FI: bound reference to `appendFileSync` or required module initialization |
| `existsSync` — `trident/orchestrator.ts:95` | `node:fs`; zero occurrences (controlled AST scan) | U0 binding-only candidate | FI: bound reference to `existsSync` or required module initialization |
| `mkdirSync` — `trident/orchestrator.ts:96` | `node:fs`; zero occurrences (controlled AST scan) | U0 binding-only candidate | FI: bound reference to `mkdirSync` or required module initialization |
| `readFileSync` — `trident/orchestrator.ts:97` | `node:fs`; zero occurrences (controlled AST scan) | U0 binding-only candidate | FI: bound reference to `readFileSync` or required module initialization |
| `writeFileSync` — `trident/orchestrator.ts:98` | `node:fs`; zero occurrences (controlled AST scan) | U0 binding-only candidate | FI: bound reference to `writeFileSync` or required module initialization |
| `dirname` — `trident/orchestrator.ts:100` | `node:path`; zero occurrences (controlled AST scan) | U0 binding-only candidate | FI: bound reference to `dirname` or required module initialization |
| `join` — `trident/orchestrator.ts:100` | `node:path`; zero occurrences (controlled AST scan) | U0 binding-only candidate | FI: bound reference to `join` or required module initialization |
| `resolve` — `trident/orchestrator.ts:100` | `node:path`; `trident/orchestrator.ts:757` | H/P, lexical | FR: occurrence resolves to another binding |
| `createLogger` — `trident/orchestrator.ts:101` | `@neutronai/logger`; `trident/orchestrator.ts:167` | H/P, lexical | FR: occurrence resolves to another binding |
| `fireAndForget` — `trident/orchestrator.ts:102` | `@neutronai/logger/fire-and-forget.ts`; `trident/orchestrator.ts:2757` | H/P, lexical | FR: occurrence resolves to another binding |
| `gitRangeArgv` — `trident/orchestrator.ts:103` | `./git-range.ts`; `trident/orchestrator.ts:837` | H/P, lexical | FR: occurrence resolves to another binding |
| `hasArgusProvenance` — `trident/orchestrator.ts:104` | `./checkpoint-phase.ts`; `trident/orchestrator.ts:1476` | H/P, lexical | FR: occurrence resolves to another binding |
| `phaseForCheckpoint` — `trident/orchestrator.ts:104` | `./checkpoint-phase.ts`; `trident/orchestrator.ts:1749` | H/P, lexical | FR: occurrence resolves to another binding |
| `ralphCapFailureReason` — `trident/orchestrator.ts:105` | `./ralph-budget.ts`; `trident/orchestrator.ts:2231` | H/P, lexical | FR: occurrence resolves to another binding |
| `checkpointRoundField` — `trident/orchestrator.ts:106` | `./checkpoint-round.ts`; `trident/orchestrator.ts:2389` | H/P, lexical | FR: occurrence resolves to another binding |
| `advanceBoundReview` — `trident/orchestrator.ts:107` | `./bound-review.ts`; `trident/orchestrator.ts:1825` | H/P, lexical | FR: occurrence resolves to another binding |
| `recordedTerminalVerdict` — `trident/orchestrator.ts:107` | `./bound-review.ts`; `trident/orchestrator.ts:2579` | H/P, lexical | FR: occurrence resolves to another binding |
| `executeBoundReview` — `trident/orchestrator.ts:109` | `./review-run.ts`; `trident/orchestrator.ts:203` | H/P, lexical | FR: occurrence resolves to another binding |
| `assertDiffOutputHost` — `trident/orchestrator.ts:111` | `./git-mode.ts`; `trident/orchestrator.ts:1262` | H/P, lexical | FR: occurrence resolves to another binding |
| `cleanupAfterMerge` — `trident/orchestrator.ts:112` | `./git-mode.ts`; zero occurrences (controlled AST scan) | U0 binding-only candidate | FI: bound reference to `cleanupAfterMerge` or required module initialization |
| `DiffOutputHost` — `trident/orchestrator.ts:113` | `./git-mode.ts`; `trident/orchestrator.ts:192` | H/P, lexical | FR: occurrence resolves to another binding |
| `HostCommandResult` — `trident/orchestrator.ts:114` | `./git-mode.ts`; zero occurrences (controlled AST scan) | U0 binding-only candidate | FI: bound reference to `HostCommandResult` or required module initialization |
| `MergeCleanupDeps` — `trident/orchestrator.ts:115` | `./git-mode.ts`; `trident/orchestrator.ts:311` | H/P, lexical | FR: occurrence resolves to another binding |
| `reviewedHeadOid` — `trident/orchestrator.ts:117` | `./merge.ts`; zero occurrences (controlled AST scan) | U0 binding-only candidate | FI: bound reference to `reviewedHeadOid` or required module initialization |
| `TridentArbiter` — `trident/orchestrator.ts:118` | `./arbiter.ts`; `trident/orchestrator.ts:354` | H/P, lexical | FR: occurrence resolves to another binding |
| `CONFIGURED_CODE_CAVEAT` — `trident/orchestrator.ts:119` | `./wrong-base-remedy.ts`; zero occurrences (controlled AST scan) | U0 binding-only candidate | FI: bound reference to `CONFIGURED_CODE_CAVEAT` or required module initialization |
| `composeWrongBaseRefusal` — `trident/orchestrator.ts:119` | `./wrong-base-remedy.ts`; zero occurrences (controlled AST scan) | U0 binding-only candidate | FI: bound reference to `composeWrongBaseRefusal` or required module initialization |
| `foldEvidence` — `trident/orchestrator.ts:119` | `./wrong-base-remedy.ts`; zero occurrences (controlled AST scan) | U0 binding-only candidate | FI: bound reference to `foldEvidence` or required module initialization |
| `foldRefName` — `trident/orchestrator.ts:119` | `./wrong-base-remedy.ts`; zero occurrences (controlled AST scan) | U0 binding-only candidate | FI: bound reference to `foldRefName` or required module initialization |
| `applyMergeApproval` — `trident/orchestrator.ts:120` | `./merge-approval.ts`; `trident/orchestrator.ts:2511` | H/P, lexical | FR: occurrence resolves to another binding |
| `runMutationProofGate` — `trident/orchestrator.ts:121` | `./mutation-prover.ts`; `trident/orchestrator.ts:1295` | H/P, lexical | FR: occurrence resolves to another binding |
| `MutationGateInput` — `trident/orchestrator.ts:121` | `./mutation-prover.ts`; `trident/orchestrator.ts:324` | H/P, lexical | FR: occurrence resolves to another binding |
| `MutationGateOutcome` — `trident/orchestrator.ts:121` | `./mutation-prover.ts`; `trident/orchestrator.ts:324` | H/P, lexical | FR: occurrence resolves to another binding |
| `parseCheckpointFindings` — `trident/orchestrator.ts:123` | `./inner-loop.ts`; `trident/orchestrator.ts:1477` | H/P, lexical | FR: occurrence resolves to another binding |
| `parseInnerResult` — `trident/orchestrator.ts:124` | `./inner-loop.ts`; zero occurrences (controlled AST scan) | U0 binding-only candidate | FI: bound reference to `parseInnerResult` or required module initialization |
| `FireOutcome` — `trident/orchestrator.ts:125` | `./inner-loop.ts`; `trident/orchestrator.ts:1336` | H/P, lexical | FR: occurrence resolves to another binding |
| `InnerResult` — `trident/orchestrator.ts:126` | `./inner-loop.ts`; `trident/orchestrator.ts:1096` | H/P, lexical | FR: occurrence resolves to another binding |
| `TridentWorkflowFirer` — `trident/orchestrator.ts:127` | `./inner-loop.ts`; `trident/orchestrator.ts:187` | H/P, lexical | FR: occurrence resolves to another binding |
| `buildMergeCleanupDeps` — `trident/orchestrator.ts:130` | `./merge.ts`; `trident/orchestrator.ts:1274` | H/P, lexical | FR: occurrence resolves to another binding |
| `detectBaseBranch` — `trident/orchestrator.ts:131` | `./merge.ts`; `trident/orchestrator.ts:1362` | H/P, lexical | FR: occurrence resolves to another binding |
| `diffBaseRef` — `trident/orchestrator.ts:132` | `./merge.ts`; `trident/orchestrator.ts:1379` | H/P, lexical | FR: occurrence resolves to another binding |
| `refResolves` — `trident/orchestrator.ts:133` | `./merge.ts`; `trident/orchestrator.ts:1379` | H/P, lexical | FR: occurrence resolves to another binding |
| `runWorktreePath` — `trident/orchestrator.ts:134` | `./merge.ts`; zero occurrences (controlled AST scan) | U0 binding-only candidate | FI: bound reference to `runWorktreePath` or required module initialization |
| `TridentBaseDriftHold` — `trident/orchestrator.ts:135` | `./merge.ts`; zero occurrences (controlled AST scan) | U0 binding-only candidate | FI: bound reference to `TridentBaseDriftHold` or required module initialization |
| `TridentMergeConflictEscalation` — `trident/orchestrator.ts:136` | `./merge.ts`; zero occurrences (controlled AST scan) | U0 binding-only candidate | FI: bound reference to `TridentMergeConflictEscalation` or required module initialization |
| `TridentMergeDiffHold` — `trident/orchestrator.ts:137` | `./merge.ts`; zero occurrences (controlled AST scan) | U0 binding-only candidate | FI: bound reference to `TridentMergeDiffHold` or required module initialization |
| `MergeConflictResolver` — `trident/orchestrator.ts:138` | `./merge.ts`; `trident/orchestrator.ts:336` | H/P, lexical | FR: occurrence resolves to another binding |
| `RunHostCommand` — `trident/orchestrator.ts:139` | `./merge.ts`; `trident/orchestrator.ts:826` | H/P, lexical | FR: occurrence resolves to another binding |
| `escalationKindAgrees` — `trident/orchestrator.ts:141` | `./escalation-block.ts`; `trident/orchestrator.ts:1209` | H/P, lexical | FR: occurrence resolves to another binding |
| `escalationStopSentence` — `trident/orchestrator.ts:141` | `./escalation-block.ts`; `trident/orchestrator.ts:1210` | H/P, lexical | FR: occurrence resolves to another binding |
| `resultCarriesEscalation` — `trident/orchestrator.ts:142` | `./escalation-evidence.ts`; `trident/orchestrator.ts:1478` | H/P, lexical | FR: occurrence resolves to another binding |
| `infraDeathSentence` — `trident/orchestrator.ts:143` | `./infra-block.ts`; `trident/orchestrator.ts:1224` | H/P, lexical | FR: occurrence resolves to another binding |
| `terminalCauseReason` — `trident/orchestrator.ts:144` | `./terminal-cause.ts`; `trident/orchestrator.ts:1245` | H/P, lexical | FR: occurrence resolves to another binding |
| `runLeakGatePreflight` — `trident/orchestrator.ts:145` | `./leak-preflight.ts`; `trident/orchestrator.ts:365` | H/P, lexical | FR: occurrence resolves to another binding |
| `LeakPreflightFixer` — `trident/orchestrator.ts:145` | `./leak-preflight.ts`; `trident/orchestrator.ts:371` | H/P, lexical | FR: occurrence resolves to another binding |
| `ARGUS_DIFF_LINE_LIMIT` — `trident/orchestrator.ts:146` | `./prompts.ts`; `trident/orchestrator.ts:841` | H/P, lexical | FR: occurrence resolves to another binding |
| `isTerminalPhase` — `trident/orchestrator.ts:147` | `./state-machine.ts`; `trident/orchestrator.ts:2912` | H/P, lexical | FR: occurrence resolves to another binding |
| `AdvanceOutcome` — `trident/orchestrator.ts:147` | `./state-machine.ts`; `trident/orchestrator.ts:170` | H/P, lexical | FR: occurrence resolves to another binding |
| `buildTestStrategyDetail` — `trident/orchestrator.ts:148` | `./test-strategy.ts`; `trident/orchestrator.ts:1940` | H/P, lexical | FR: occurrence resolves to another binding |
| `readHostBudget` — `trident/orchestrator.ts:148` | `./test-strategy.ts`; `trident/orchestrator.ts:1939` | H/P, lexical | FR: occurrence resolves to another binding |
| `TridentRun` — `trident/orchestrator.ts:149` | `./store.ts`; `trident/orchestrator.ts:170` | H/P, lexical | FR: occurrence resolves to another binding |
| `TridentRunStore` — `trident/orchestrator.ts:149` | `./store.ts`; `trident/orchestrator.ts:748` | H/P, lexical | FR: occurrence resolves to another binding |
| `TridentRunUpdate` — `trident/orchestrator.ts:149` | `./store.ts`; `trident/orchestrator.ts:391` | H/P, lexical | FR: occurrence resolves to another binding |
| `DEAD_LAUNCHER_OVERRIDE_MS` — `trident/orchestrator.ts:151` | `./liveness.ts`; `trident/orchestrator.ts:2843` | H/P, lexical | FR: occurrence resolves to another binding |
| `DEFAULT_MAX_INFLIGHT_MS` — `trident/orchestrator.ts:152` | `./liveness.ts`; `trident/orchestrator.ts:1281` | H/P, lexical | FR: occurrence resolves to another binding |
| `DEFAULT_SETTLE_TIMEOUT_MS` — `trident/orchestrator.ts:153` | `./liveness.ts`; `trident/orchestrator.ts:2048` | H/P, lexical | FR: occurrence resolves to another binding |
| `NO_ADVANCE_HANG_MS` — `trident/orchestrator.ts:154` | `./liveness.ts`; `trident/orchestrator.ts:1282` | H/P, lexical | FR: occurrence resolves to another binding |
| `RunEvidenceGatherer` — `trident/orchestrator.ts:157` | `./run-evidence.ts`; `trident/orchestrator.ts:576` | H/P, lexical | FR: occurrence resolves to another binding |
| `FIRE_SETTLE_TIMEOUT_ERROR` — `trident/orchestrator.ts:160` | `./fire-evidence.ts`; `trident/orchestrator.ts:2137` | H/P, lexical | FR: occurrence resolves to another binding |
| `publishedFailureReason` — `trident/orchestrator.ts:161` | `./fire-evidence.ts`; `trident/orchestrator.ts:1797` | H/P, lexical | FR: occurrence resolves to another binding |
| `FireEvidenceGatherer` — `trident/orchestrator.ts:162` | `./fire-evidence.ts`; `trident/orchestrator.ts:589` | H/P, lexical | FR: occurrence resolves to another binding |
| `FireTimeoutEvidence` — `trident/orchestrator.ts:163` | `./fire-evidence.ts`; `trident/orchestrator.ts:1650` | H/P, lexical | FR: occurrence resolves to another binding |
| `BranchHolderProbe` — `trident/orchestrator.ts:165` | `./fire-evidence-probes.ts`; `trident/orchestrator.ts:619` | H/P, lexical | FR: occurrence resolves to another binding |
| `join` — `trident/inner-loop.ts:52` | `node:path`; `trident/inner-loop.ts:498` | H/P, lexical | FR: occurrence resolves to another binding |
| `TRIDENT_SCRIPT_DIR` — `trident/inner-loop.ts:53` | `./script-dir.ts`; `trident/inner-loop.ts:498` | H/P, lexical | FR: occurrence resolves to another binding |
| `parseMutationClaim` — `trident/inner-loop.ts:54` | `./mutation-prover.ts`; `trident/inner-loop.ts:862` | H/P, lexical | FR: occurrence resolves to another binding |
| `MutationClaim` — `trident/inner-loop.ts:54` | `./mutation-prover.ts`; `trident/inner-loop.ts:243` | H/P, lexical | FR: occurrence resolves to another binding |
| `AgentSpec` — `trident/inner-loop.ts:55` | `@neutronai/runtime/substrate.ts`; `trident/inner-loop.ts:1058` | H/P, lexical | FR: occurrence resolves to another binding |
| `Substrate` — `trident/inner-loop.ts:55` | `@neutronai/runtime/substrate.ts`; `trident/inner-loop.ts:1017` | H/P, lexical | FR: occurrence resolves to another binding |
| `SessionHandle` — `trident/inner-loop.ts:56` | `@neutronai/runtime/session-handle.ts`; `trident/inner-loop.ts:1072` | H/P, lexical | FR: occurrence resolves to another binding |
| `waveChildSlug` — `trident/inner-loop.ts:57` | `./store.ts`; `trident/inner-loop.ts:611` | H/P, lexical | FR: occurrence resolves to another binding |
| `TridentRun` — `trident/inner-loop.ts:57` | `./store.ts`; `trident/inner-loop.ts:86` | H/P, lexical | FR: occurrence resolves to another binding |
| `FABLE_MODEL` — `trident/inner-loop.ts:58` | `@neutronai/runtime/models.ts`; `trident/inner-loop.ts:719` | H/P, lexical | FR: occurrence resolves to another binding |
| `SONNET_MODEL` — `trident/inner-loop.ts:58` | `@neutronai/runtime/models.ts`; `trident/inner-loop.ts:721` | H/P, lexical | FR: occurrence resolves to another binding |
| `FAST_MODEL` — `trident/inner-loop.ts:58` | `@neutronai/runtime/models.ts`; `trident/inner-loop.ts:722` | H/P, lexical | FR: occurrence resolves to another binding |
| `getBestModel` — `trident/inner-loop.ts:58` | `@neutronai/runtime/models.ts`; `trident/inner-loop.ts:720` | H/P, lexical | FR: occurrence resolves to another binding |
| `modelTierRegistry` — `trident/inner-loop.ts:59` | `./model-tiers.ts`; `trident/inner-loop.ts:763` | H/P, lexical | FR: occurrence resolves to another binding |
| `parsePhaseModelConfig` — `trident/inner-loop.ts:60` | `./phase-models.ts`; `trident/inner-loop.ts:789` | H/P, lexical | FR: occurrence resolves to another binding |
| `DEFAULT_SETTLE_TIMEOUT_MS` — `trident/inner-loop.ts:61` | `./liveness.ts`; `trident/inner-loop.ts:982` | H/P, lexical | FR: occurrence resolves to another binding |
| `FIRE_SETTLE_TIMEOUT_ERROR` — `trident/inner-loop.ts:62` | `./fire-evidence.ts`; `trident/inner-loop.ts:446` | H/P, lexical | FR: occurrence resolves to another binding |
| `buildReflectionGuidance` — `trident/inner-loop.ts:63` | `./reflection-guidance.ts`; `trident/inner-loop.ts:698` | H/P, lexical | FR: occurrence resolves to another binding |
| `writeBriefParts` — `trident/inner-loop.ts:64` | `./brief-parts.ts`; `trident/inner-loop.ts:488` | H/P, lexical | FR: occurrence resolves to another binding |
| `BriefParts` — `trident/inner-loop.ts:64` | `./brief-parts.ts`; `trident/inner-loop.ts:586` | H/P, lexical | FR: occurrence resolves to another binding |
| `parseCheckpointFindings` — `trident/inner-loop.ts:65` | `./checkpoint-findings.ts`; `trident/inner-loop.ts:675` | H/P, lexical | FR: occurrence resolves to another binding |
| `decodeEscalation` — `trident/inner-loop.ts:67` | `./escalation-evidence.ts`; `trident/inner-loop.ts:927` | H/P, lexical | FR: occurrence resolves to another binding |
| `EscalationKind` — `trident/inner-loop.ts:68` | `./escalation-evidence.ts`; zero occurrences (controlled AST scan) | U0 binding-only candidate | FI: bound reference to `EscalationKind` or required module initialization |
| `InnerEscalation` — `trident/inner-loop.ts:69` | `./escalation-evidence.ts`; `trident/inner-loop.ts:309` | H/P, lexical | FR: occurrence resolves to another binding |
| `parseTerminalCause` — `trident/inner-loop.ts:71` | `./terminal-cause.ts`; `trident/inner-loop.ts:941` | H/P, lexical | FR: occurrence resolves to another binding |
| `TerminalCause` — `trident/inner-loop.ts:71` | `./terminal-cause.ts`; `trident/inner-loop.ts:342` | H/P, lexical | FR: occurrence resolves to another binding |
| `TERMINAL_CAUSE_MAX` — `trident/inner-loop.ts:77` | `@neutronai/runtime/refusal-cause.ts`; `trident/inner-loop.ts:934` | H/P, lexical | FR: occurrence resolves to another binding |
| `fileURLToPath` — `trident/inner-loop.ts:80` | `node:url`; `trident/inner-loop.ts:506` | H/P, lexical | FR: occurrence resolves to another binding |
| `fireAndForget` — `trident/inner-loop.ts:81` | `@neutronai/logger/fire-and-forget.ts`; `trident/inner-loop.ts:1118` | H/P, lexical | FR: occurrence resolves to another binding |

Independent content control for the U0 candidates:

```sh
rg -n '\b(remoteAlreadyAtPublishHead|resolveClaimedCommit|sanitizeLeakAnnotation|rebaseOntoObservedBase|publishFailureReason|fixLineage|RunWorkerObservation|appendFileSync|existsSync|mkdirSync|readFileSync|writeFileSync|dirname|join|cleanupAfterMerge|HostCommandResult|reviewedHeadOid|CONFIGURED_CODE_CAVEAT|composeWrongBaseRefusal|foldEvidence|foldRefName|parseInnerResult|runWorktreePath|TridentBaseDriftHold|TridentMergeConflictEscalation|TridentMergeDiffHold|prepareLaunch)\b' trident/orchestrator.ts
```

Output has imports, forwarded exports and prose references for the candidates; **actual call `prepareLaunch` at :1845 is the positive control**. The bindings at :17–19,23–24 also have direct `export … from` statements (:21,25,27): removing the unused local import binding is different from deleting those exports. Type-only unused `RunWorkerObservation` (:30) and `HostCommandResult` (:114) are the smallest unambiguous cleanup. All are measurement candidates, not edits in this document-only change.

| Forwarded symbol(s), each explicitly enumerated | Owner / mechanism | Confidence | Falsifier |
| --- | --- | --- | --- |
| `classifyInnerFailure`, `DEFAULT_MAX_INFRA_RETRIES`, `INFRA_CAUSE_WORDS`, `INFRA_RETRY_BACKOFF_MS`, `InnerFailureClass` | `trident/orchestrator.ts:7`, ES re-export from infrastructure-retry | High export; independent consumer U | Remove export and find a consumer/typecheck failure; implementation owner stays separate |
| `remoteAlreadyAtPublishHead`, `resolveClaimedCommit`, `sanitizeLeakAnnotation` | `trident/orchestrator.ts:21`, publication | High export; independent consumer U | A consumer imports through this forwarding surface |
| `rebaseOntoObservedBase`, `healShallowCheckout`, `TridentRebaseConflict` | `trident/orchestrator.ts:25`, replay | High export; implementation not deleted | A consumer depends on this public spelling |
| `ensureAsBuiltMergeDriver` | `trident/orchestrator.ts:26`, as-built merge driver | High export; consumer U | Consumer import through orchestrator |
| `publishFailureReason`, `redactPushError` | `trident/orchestrator.ts:27`, publish-failure | High export; local use of redaction :1213 | Consumer import or local use survives |
| `recordedTerminalVerdict` | `trident/orchestrator.ts:108`, bound-review; local call :2579 | H | Settlement stops using this normalization |
| `TERMINAL_CAUSE_MAX` | `trident/inner-loop.ts:79`, runtime refusal-cause; parser read :934 | H | Parser/other consumers no longer need it |
| `parseCheckpointFindings` | `trident/inner-loop.ts:83`, checkpoint-findings; outer use `trident/orchestrator.ts:2542` | H | Retained consumers stop importing this surface |
| `ESCALATION_KINDS`, `EscalationKind`, `ESCALATION_TEXT_MAX`, `InnerEscalation`, `parseInnerEscalation` | `trident/inner-loop.ts:209,215,226,840`, escalation-evidence; retained result contract :309 and parser :927 | High export; per-export downstream reach U | Caller/typecheck identifies required forwarding export; preserve semantic owner |

### Test-file literal pins (C4 output)

Each row is a file containing `inner-workflow.mjs`, with its first matching line read. All have **high confidence as literal pins only**. The falsifier for that scope is rerunning C4 on this SHA and failing to reproduce the hit. A transitive helper reference can increase the real impact, and a comment-only hit can reduce behavioral retargeting cost. These are test costs, not production entrypoints or a reason to preserve the old loop.

| Test file and first literal line |
| --- |
| `tests/integration/install-codex.test.ts:11` |
| `trident/__tests__/cross-model-dispatch.test.ts:13` |
| `trident/__tests__/cross-model-rate-limited.test.ts:5` |
| `trident/__tests__/dead-core-seat-e2e.test.ts:14` |
| `trident/__tests__/delta-classifier.test.ts:3` |
| `trident/__tests__/dying-reviewer-e2e.test.ts:17` |
| `trident/__tests__/escalation-e2e.test.ts:7` |
| `trident/__tests__/escalation-gate.test.ts:2` |
| `trident/__tests__/gh-read-command.test.ts:19` |
| `trident/__tests__/model-tiers.test.ts:36` |
| `trident/__tests__/phase-model-coverage.test.ts:5` |
| `trident/__tests__/severity-gate.test.ts:22` |
| `trident/__tests__/synthesis-unavailable.test.ts:31` |
| `trident/board-dispatch.test.ts:1904` |
| `trident/checkpoint-phase.test.ts:57` |
| `trident/checkpoint-sh.test.ts:1103` |
| `trident/claimed-paths.test.ts:7` |
| `trident/codex-brief-chunking.test.ts:14` |
| `trident/codex-build-arrival.test.ts:25` |
| `trident/codex-build.test.ts:8` |
| `trident/codex-review.test.ts:742` |
| `trident/diff-base-option-shaped.test.ts:22` |
| `trident/escalation-block.test.ts:35` |
| `trident/inner-loop.test.ts:6` |
| `trident/inner-workflow-assembly.test.ts:3` |
| `trident/inner-workflow-built-head.test.ts:9` |
| `trident/inner-workflow-gates.test.ts:7` |
| `trident/inner-workflow-mutation-claim.test.ts:6` |
| `trident/inner-workflow-plan-next.test.ts:3` |
| `trident/inner-workflow-publish-handoff.test.ts:3` |
| `trident/inner-workflow-ralph-refire.test.ts:3` |
| `trident/inner-workflow-resume.test.ts:3` |
| `trident/inner-workflow-size.test.ts:10` |
| `trident/inner-workflow-terminal-cause.test.ts:3` |
| `trident/inner-workflow.test.ts:2` |
| `trident/lane-retry.test.ts:5` |
| `trident/orchestrator.test.ts:4550` |
| `trident/ported-fixes.test.ts:13` |
| `trident/prompts-disk-source.test.ts:10` |
| `trident/ralph.test.ts:7` |
| `trident/reflection-guidance.test.ts:3` |
| `trident/retry-resumes-checkpoint.test.ts:287` |
| `trident/review-diff-base-realgit.test.ts:59` |
| `trident/review-round-cap.test.ts:9` |
| `trident/round-landed.test.ts:22` |
| `trident/run-disposition.test.ts:187` |
| `trident/run-head-width.test.ts:13` |
| `trident/run-progress.test.ts:91` |
| `trident/stage-attribution.test.ts:311` |
| `trident/terminate-on-merge.test.ts:12` |
| `trident/worktree-cleanup-sh.test.ts:622` |

### Corrections, validation and deliberate limits

The staged falsification's anchors `trident/orchestrator.ts:1974`, `open/composer.ts:1187`, `trident/inner-loop.ts:498,980,1043` still match. Older agreed-plan anchors do not: the retained replay implementation is now in `trident/replay.ts` (forwarded by `trident/orchestrator.ts:25`); publication wrapper is :1436, stranded reconciliation :1498, settlement :2287, and merge approval is delegated at :2511. These corrections come from current reads, not applying old line numbers to today's file. Names such as `run-settlement.ts` and `stranded-reconciliation.ts` in the prior review do not determine current ownership; the measured definitions and delegated calls above govern this inventory.

Validation: `bash scripts/ci/typecheck-all.sh` passed **51 projects**; `bash scripts/ci/lint.sh` passed; `bun test trident/project-launcher.test.ts` passed **7 tests / 69 assertions**. The root script used by CI is `scripts/ci/typecheck-all.sh` (`.github/workflows/ci.yml:265`), so that was used instead of inventing a package script. No full test suite was run. No code or test changes are part of this deliverable. Citation-target checks found zero missing/out-of-range literal references, and all 391 enumerated declarations have a table row. `git diff --check` passed. `bash scripts/ci/leak-gate.sh --tree .` exited **3 / INCOMPLETE**: zero findings in the rules that ran, but `pii-denylist` and `pii-denylist-msg` could not run because the private denylist was unavailable. This is not a green leak certification; the orchestrator must run the complete gate with its supplied denylist.

| Guard → mutation | Red | Restored green |
| --- | --- | --- |
| Not applicable: measurement-only document; zero new guards or test assertions | No mutation performed; no claim of mutation certification | Existing scoped launcher tests passed, as above |

No cross-model review was attempted under the explicit offline lane instruction. The orchestrator's review seat should be asked: **Can you falsify the empty execution-body deletion set, find an unlisted path/string/alias caller of the old factory/body, or demonstrate that any “consumed” preparation value is independently re-derived? In particular, exercise bound review's isolated-store seam and never-settling preparation after reservation.** Review the preparation table and live callback chain first; an import walk is not a substitute.

Deliberately not done: code deletion, new lifecycle policy, resume migration, bound-review repair, live acceptance dispatch, external-composer audit, public-API removal, a new gate census, a remote fetch, or a new spec decision. This measurement does not assert the pivot is complete. The task-specific one-document instruction supersedes the generic separate as-built deliverable; this section records the work in the same document. Only this document is to be committed locally; publication and merge belong to the orchestrator.
