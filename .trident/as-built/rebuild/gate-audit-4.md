## Fourth rebuilt-driver gate census — publication, cleanup, and CI acquisition

### Result and provenance

**32 assigned gates classified: 7 PRESERVED, 6 CONFLICTS, 19 CANNOT TELL.** This report audits the production host-effects tree at local commit `37f0b114` (the latest completed prerequisite implementation), read from the sibling cutover checkout whose HEAD contains that commit. The build branch itself remains based on `origin/main` at `ddccde3d`, where the production files are not yet tracked. This distinction matters: the report certifies the named prerequisite tree, not the older branch base and not a freshly fetched remote.

Enumeration was mechanical: select exactly the 32 IDs in the lane brief, then join each ID to its unique row in `docs/trident-gates-inventory.md`. The resulting inventory anchors are `docs/trident-gates-inventory.md:102`, `docs/trident-gates-inventory.md:119-125`, `docs/trident-gates-inventory.md:167-183`, `docs/trident-gates-inventory.md:198-199`, `docs/trident-gates-inventory.md:214-216`, and `docs/trident-gates-inventory.md:252-259`. Every row's property, implementation citation, certification citation, and loss risk was read.

The prior census input was read at commit `f2b3260c`, `.trident/as-built/rebuild/gate-audit-2.md:5`; it classified these rows CANNOT TELL because effects were injected at `trident/build-host.ts:25`. The production composition now supplies `effects`, `modes`, admission, CI observation, and local configuration (`trident/project-build-host.ts:59-72`). Its effect object binds measurement, preparation, publication, and merge (`trident/production-host-effects.ts:301-319`).

Tracked-tree absence was checked against the current branch's fetched `origin/main` with a positive control: `git ls-tree -r --name-only origin/main -- CONTRIBUTING.md` returned `CONTRIBUTING.md`; the same command for `trident/production-host-effects.ts`, `trident/project-build-host.ts`, and `.trident/as-built/rebuild/gate-audit-2.md` returned nothing. That claim is only about the fetched ref in this checkout. The files were read from the prerequisite checkout at commit `37f0b114`.

### Classification table

| Gate | Inventory | Classification | Evidence or unfinished boundary |
| --- | --- | --- | --- |
| G033 | `docs/trident-gates-inventory.md:102` | PRESERVED | Production measurement resolves the full branch OID and rejects malformed output (`trident/production-host-effects.ts:50-57`); completed worker output must exactly corroborate that independent measurement (`trident/build-run.ts:261-269`). The measurement test reaches the real git branch and complete diff (`trident/production-host-effects.test.ts:83-93`). |
| G083 | `docs/trident-gates-inventory.md:167` | PRESERVED | Publication refuses non-PR mode and remeasures the supplied snapshot before any write (`trident/production-host-effects.ts:236-243`); head measurement accepts only a full OID (`trident/production-host-effects.ts:50-57`). The local-mode refusal reaches `publishChecked` (`trident/production-host-effects.test.ts:312-325`). |
| G087 | `docs/trident-gates-inventory.md:171` | CANNOT TELL | The production publisher pushes the already measured head directly (`trident/production-host-effects.ts:244-252`) and contains no replay step. Whether removing publication replay deliberately discharges this replay-only gate, or loses a required base-refresh behavior, is not specified in the inspected composition. |
| G088 | `docs/trident-gates-inventory.md:172` | CANNOT TELL | No publication replay or depth acquisition occurs before the direct leased push (`trident/production-host-effects.ts:244-252`). The retained local merge rebase is a different landing path (`trident/production-host-effects.ts:265-271`). |
| G089 | `docs/trident-gates-inventory.md:173` | CANNOT TELL | The production publisher creates no patch or replay scratch worktree; it moves directly from readiness to leased push (`trident/production-host-effects.ts:242-252`). No replacement owner for the inventory's patch/readability outcome was found at this effect boundary. |
| G090 | `docs/trident-gates-inventory.md:174` | CANNOT TELL | The PR publication path has no apply or conflict-resolver transition (`trident/production-host-effects.ts:236-263`). Local landing delegates to the retained merge implementation (`trident/production-host-effects.ts:270`), which does not establish equivalence to the former publisher replay taxonomy. |
| G091 | `docs/trident-gates-inventory.md:175` | CANNOT TELL | Publication has no replay resolver input (`trident/production-host-effects.ts:20-32`, `trident/production-host-effects.ts:236-263`). Local rebase escalation requires a configured resolver (`trident/merge.ts:3855-3868`), but that is a different operation and the project composition does not expose a resolver here (`trident/project-build-host.ts:26-35`). |
| G092 | `docs/trident-gates-inventory.md:176` | CANNOT TELL | The direct publication path never claims replay resolution (`trident/production-host-effects.ts:244-260`). Retained local merge owns conflict inspection, but no evidence maps its result to the inventory's publication replay contract. |
| G093 | `docs/trident-gates-inventory.md:177` | CANNOT TELL | The production publication effect has no resolution rounds (`trident/production-host-effects.ts:236-263`). The retained local merge counts conflict rounds (`trident/merge.ts:3815-3841`) but the inspected evidence does not establish the former replay requirement that each round shrink the conflict set. |
| G094 | `docs/trident-gates-inventory.md:178` | CANNOT TELL | Publication itself has no replay loop (`trident/production-host-effects.ts:236-263`). A 12-round ceiling exists in retained local merging (`trident/merge.ts:3826-3838`), but that does not certify the removed publisher replay operation. |
| G095 | `docs/trident-gates-inventory.md:179` | CANNOT TELL | The new publisher does not compose a replay commit message; it pushes the measured commit unchanged (`trident/production-host-effects.ts:244-252`). The product requirement for provenance after removing replay is not stated at this seam. |
| G096 | `docs/trident-gates-inventory.md:180` | CANNOT TELL | No replay commit is attempted by the production publisher (`trident/production-host-effects.ts:236-263`), so neither the old empty-resolution outcome nor a declared replacement taxonomy is reachable here. |
| G097 | `docs/trident-gates-inventory.md:181` | CANNOT TELL | There is no local replay branch advance. The external publication write is protected by a remote lease (`trident/production-host-effects.ts:244-250`), but that is G098's remote CAS rather than evidence for the inventory's local replay CAS. |
| G098 | `docs/trident-gates-inventory.md:182` | PRESERVED | The publisher reads the exact remote branch OID, including empty output for first publication, and passes it to `--force-with-lease` (`trident/production-host-effects.ts:244-250`). The production publication test asserts the pinned push and reaches the remote witness (`trident/production-host-effects.test.ts:153-162`). |
| G099 | `docs/trident-gates-inventory.md:183` | PRESERVED | After push, publication re-reads the remote ref and requires the exact reviewed head/ref pair (`trident/production-host-effects.ts:249-252`). Failure cases separately make lease, push, and witness unreadable and stay unknown (`trident/production-host-effects.test.ts:172-192`). |
| G109 | `docs/trident-gates-inventory.md:198` | PRESERVED | Local mode delegates to `mergeLocalReviewed` with branch, base, worktree, and reviewed head (`trident/production-host-effects.ts:265-271`). Its real production-effect test lands into the checked-out base while preserving the reviewed branch (`trident/production-host-effects.test.ts:249-258`); the driver-level real-effect test reaches `merged` (`trident/production-host-effects.test.ts:414`). |
| G110 | `docs/trident-gates-inventory.md:199` | PRESERVED | The local merge uses a per-run worktree and restores the reviewed branch on every non-landing unwind before teardown (`trident/merge.ts:2276-2305`). Production tests reach dirty-worktree, overlap, base-race, and dirty-base refusals (`trident/production-host-effects.test.ts:388-412`). |
| G125 | `docs/trident-gates-inventory.md:214` | CONFLICTS | See conflict details. The driver catches host exceptions and returns unknown (`trident/build-run.ts:416-419`) but has no build-cleanup dependency or finally block in its dependency vocabulary (`trident/build-run.ts:91-113`). |
| G126 | `docs/trident-gates-inventory.md:215` | CANNOT TELL | The deterministic script still owns preservation policy (`trident/worktree-cleanup.sh:265-292`), but the production effect exposes no lifecycle cleanup operation (`trident/production-host-effects.ts:301-319`). No production caller was established, so the policy cannot be certified as continuously applied. |
| G127 | `docs/trident-gates-inventory.md:216` | CANNOT TELL | The rebuilt outcome vocabulary reports driver uncertainty (`trident/build-run.ts:120-121`, `trident/build-run.ts:416-419`), but no cleanup result is acquired or reported by the production effect (`trident/production-host-effects.ts:301-319`). |
| G153 | `docs/trident-gates-inventory.md:252` | CANNOT TELL | The script refuses invalid arguments before deletion (`trident/worktree-cleanup.sh:108-124`), but the production host never invokes it through its effects (`trident/production-host-effects.ts:301-319`). Script correctness alone does not establish rebuilt-path reachability. |
| G154 | `docs/trident-gates-inventory.md:253` | CANNOT TELL | The script treats unreadable enumeration as preservation (`trident/worktree-cleanup.sh:166`), but no production lifecycle owner calls the script (`trident/production-host-effects.ts:301-319`). |
| G155 | `docs/trident-gates-inventory.md:254` | CANNOT TELL | The script skips the shared checkout and mismatched roots (`trident/worktree-cleanup.sh:169-209`), but its invocation is absent from the production effect interface (`trident/production-host-effects.ts:301-319`). |
| G156 | `docs/trident-gates-inventory.md:255` | CANNOT TELL | The script preserves the PR branch under the named uncertainty conditions (`trident/worktree-cleanup.sh:265-292`), but no completed build cleanup reaches it from the composed host (`trident/project-build-host.ts:59-80`). |
| G157 | `docs/trident-gates-inventory.md:256` | CANNOT TELL | The cleanup script bounds remote reads and disables interactive authentication (`trident/worktree-cleanup.sh:99`), but the production composition has no cleanup call (`trident/project-build-host.ts:59-80`). |
| G158 | `docs/trident-gates-inventory.md:257` | PRESERVED | The retained merge loop refuses after 12 resolution attempts (`trident/merge.ts:3815-3838`) and asks the arbiter only when both a resolver round and the one-per-rebase allowance remain (`trident/merge.ts:3889-3909`). Production local mode calls this merge path (`trident/production-host-effects.ts:270`). |
| G045 | `docs/trident-gates-inventory.md:119` | CONFLICTS | See conflict details. CI acquisition lists one configured workflow run only (`trident/production-host-effects.ts:201-215`). |
| G046 | `docs/trident-gates-inventory.md:120` | CONFLICTS | See conflict details. The adapter requests no check-run/status list or completeness counts (`trident/production-host-effects.ts:205-215`). |
| G048 | `docs/trident-gates-inventory.md:122` | CONFLICTS | See conflict details. The acquired aggregate record has no producer/app row shape (`trident/production-host-effects.ts:205-215`). |
| G050 | `docs/trident-gates-inventory.md:124` | CONFLICTS | See conflict details. An empty aggregate run list immediately becomes absent (`trident/production-host-effects.ts:208-215`), with none of the inventory's grace/base/settled-rollup prerequisites. |
| G051 | `docs/trident-gates-inventory.md:125` | CONFLICTS | See conflict details. Configuration is captured as one `ciWorkflow` string (`trident/production-host-effects.ts:20-31`) and is not freshly resolved after a tentative configuration error (`trident/production-host-effects.ts:201-216`). |
| G160 | `docs/trident-gates-inventory.md:259` | CANNOT TELL | A failed aggregate workflow becomes blocked at the merge gate without entering a fix round (`trident/build-host.ts:131-136`, `trident/build-run.ts:399-405`), but the rebuilt path has no base-excusal synthesis or REQUEST_CHANGES vocabulary. Equivalence to the compound legacy outcome was not established. |

### Conflict details

#### G125 — cleanup is not guaranteed after every builder result

Inventory property (`docs/trident-gates-inventory.md:214`): “Cleanup runs in finally independently of the builder result and delegates deletion decisions to the deterministic cleanup script.” The rebuilt driver catches exceptions and returns `unknown` (`trident/build-run.ts:416-419`); its production effects end at prepare, measure, publish, and merge (`trident/production-host-effects.ts:301-319`). No finally invokes the deterministic cleanup script. Lost: a failed, refused, blocked, or crashed build can leave its build worktree and branch without the required deterministic cleanup attempt.

#### G045 — required contexts are not acquired

Inventory property (`docs/trident-gates-inventory.md:119`): “Protection contexts and ruleset checks are combined, and an ambiguous protection 404 requires independent branch evidence.” The rebuilt adapter queries only `gh run list` for one configured workflow and reads `headSha,status,conclusion` (`trident/production-host-effects.ts:201-215`). Lost: a required context supplied by protection or a ruleset can disappear without being represented in readiness.

#### G046 — producer-list completeness is not acquired

Inventory property (`docs/trident-gates-inventory.md:120`): “Produced-check evidence must include complete check-run and status lists with valid counts; unreadability disables the fast configuration-fault inference.” The adapter accepts at most one aggregate workflow run and never acquires check-run/status totals (`trident/production-host-effects.ts:205-215`). Lost: the rebuilt path cannot distinguish a complete producer census from a truncated or absent aggregate observation.

#### G048 — app-bound identity is collapsed

Inventory property (`docs/trident-gates-inventory.md:122`): “An app-bound required name cannot be satisfied by a classic commit-status row; this checks row shape, not actual app identity.” The rebuilt CI record contains only workflow head, status, and conclusion (`trident/production-host-effects.ts:205-215`; `trident/ci-readiness.ts:3-7`). Lost: producer row shape and app binding are unavailable, so the wrong producer cannot be excluded.

#### G050 — missing-run classification has no prerequisites

Inventory property (`docs/trident-gates-inventory.md:124`): “A missing required name becomes a configuration stop only after grace, nonempty base evidence, and a nonempty settled PR rollup.” An empty workflow-run response immediately returns `absent` (`trident/production-host-effects.ts:208-215`), and readiness immediately converts that to `no-run` (`trident/ci-readiness.ts:22-29`). Lost: queued, conditional, or not-yet-created checks are indistinguishable from a proven configuration omission.

#### G051 — tentative configuration errors are not refreshed

Inventory property (`docs/trident-gates-inventory.md:125`): “A fresh resolved configuration reclassifies a tentative configuration error before it is accepted.” The workflow name is supplied once in host options (`trident/production-host-effects.ts:20-31`) and observation performs no configuration resolution (`trident/production-host-effects.ts:201-216`). Lost: a stale configured name can hold an otherwise viable run with no fresh protection/ruleset reclassification.

### Decisions, vocabulary, and deliberate limits

PRESERVED requires a concrete production call plus a property-reaching test where one exists. Retained code alone is not enough: this is why cleanup-script rows remain CANNOT TELL even though their internal guards still exist (`trident/worktree-cleanup.sh:99-292`). Conversely, replay-only rows remain CANNOT TELL rather than CONFLICTS because the replacement publisher performs no replay at all (`trident/production-host-effects.ts:236-263`); deciding whether direct publication deliberately eliminates those requirements is a product/spec mapping not present in the inspected files.

The two scoped absence searches used the same expressions for absent operations and present controls:

```sh
rg -n 'cleanup|worktree-cleanup|publishChecked|effects' \
  trident/production-host-effects.ts trident/project-build-host.ts
# controls: production-host-effects.ts:236 publishChecked; :301 effects;
#           project-build-host.ts:68 production.effects
# absent in this scope: cleanup, worktree-cleanup

rg -n 'replay|cherry-pick|rebase|force-with-lease|publishChecked' \
  trident/production-host-effects.ts
# controls: :236 publishChecked; :249 force-with-lease
# absent in this scope: replay, cherry-pick, rebase
```

These are claims only about the named production effect/composition files. They do not assert that the retained repository has no cleanup or rebase implementation; the retained script and local merge are cited separately above.

The new production effect introduces no new outcome vocabulary in this report. `GateResult` keeps `allow`, `blocked`, and `unknown`; the driver maps blocked to an orchestrator-addressed stop and preserves unknown as nonterminal (`trident/build-run.ts:148-154`). CI's aggregate `failure` becomes `red`, then the host maps every non-green value to blocked (`trident/ci-readiness.ts:30-32`, `trident/build-host.ts:131-136`). Missing cleanup has no outcome at all, which is the G125 conflict rather than a default classification.

No production code, test, inventory, spec decision, or dependency was changed. No guard was added, so mutation testing is not applicable:

| New guard | Mutation | Red | Restored green |
| --- | --- | --- | --- |
| None; report only | Not applicable | Not performed | Not performed |

Targeted validation was limited to the concrete implementation and composition tests:

```sh
bun test trident/production-host-effects.test.ts trident/project-build-host.test.ts
```

The test command was run in the prerequisite checkout because those files are not present on this branch base: **63 pass, 0 fail, 272 assertions**. Passing tests are cited only where their fixtures reach the property; a green file does not automatically certify every gate. `bash scripts/ci/typecheck-all.sh` checked 51 configurations and passed all 51. `bash scripts/ci/lint.sh` passed. The leak gate reported zero findings from executed rules but could not run its private PII denylist, so its result is **INCOMPLETE, not clean**. Heading/count validation found one `## ` heading, 32 unique assigned rows, and counts of 7/6/19. Citation-bound, restricted-text, staged-whitespace, and staged-file checks were also run. No full suite, push, PR, or merge was performed.
