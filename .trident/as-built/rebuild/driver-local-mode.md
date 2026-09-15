## 2026-09-15 — Local merge mode in the rebuilt driver

### Positive case first

`trident/build-run.test.ts:554` reaches `merged` with `pr: null` and asserts that publication was not invoked. `trident/build-host.test.ts:405` exercises the composed host and driver with local observations and an observed landing. `trident/gates/local-merge.test.ts:39` runs the driver against real Git, lands the reviewed commit, and verifies that the branch remains and the base contains that commit.

### Change and decisions

- `merge_mode` is separate from the workflow mode (`trident/build-run.ts:65`). Local runs skip the publication effect (`trident/build-run.ts:336`) and confirm their landing through a host observation (`trident/build-run.ts:356`). Bound PRs refuse local mode (`trident/build-run.ts:151`). PR publication still requires the actual open PR (`trident/build-run.ts:342`); its regression is `trident/build-run.test.ts:590`.
- G109 stays in `merge.ts`. The host calls `localMergeReadiness` (`trident/build-host.ts:66`), which calls the existing preservation policy, drift measurement and drift decision (`trident/merge.ts:1653`, `trident/merge.ts:1655`, `trident/merge.ts:1658`). The wrapper additionally measures isolated worktree and common repository identity (`trident/merge.ts:1644`). The wrapper shares the existing drift algorithm.
- Local admission retains G016 branch ownership, changing only the base-ref source and remote-fetch selection (`trident/gates/project-admission.ts:30`). A real repository without a remote must still establish prior ownership (`trident/gates/local-merge.test.ts:94`). Publication keeps mutation proof and fix lineage (`trident/build-host.ts:101`); local eligibility uses G109 instead of PR CI and PR refs (`trident/build-host.ts:108`).
- Local confirmation measures the retained branch and ancestry in the local base (`trident/build-host.ts:76`, `trident/build-host.ts:79`). It cannot certify a deleted or rewritten branch. Local effects are required to retain and merge the reviewed commit without rewriting it (`trident/build-run.ts:95`).

### Outcome vocabulary and maintenance

These observations join the existing `GateResult` vocabulary, not a new error taxonomy (`trident/build-run.ts:22`). `gateStop` explicitly routes `blocked` to the orchestrator and preserves `unknown` with the current step identity (`trident/build-run.ts:135`, `trident/build-run.ts:138`). Host exceptions remain unknown (`trident/build-run.ts:362`). No worker assertion supplies a gate result: completed trailers are still corroborated against host measurements (`trident/build-run.ts:241`).

G109 is re-measured at publication and merge (`trident/build-host.ts:103`, `trident/build-host.ts:108`). G016 remains at admission (`trident/build-host.ts:94`), so a fresh run can provision its branch and worktree later (`trident/build-host.test.ts:440`). Those observations run in the host and do not require the worker to remain alive. Post-write confirmation independently checks the result. As with the existing PR effect seam, the trusted merge effect must enforce its reviewed-head and base pins at the write (`trident/build-run.ts:350`); readiness is not an atomic lock (`trident/merge.ts:1636`). This lane does not implement a new concurrent landing engine.

The post-merge measurement may have an empty diff against the newly advanced base. Confirmation therefore requires the same retained head, no PR, and measured ancestry rather than the old diff (`trident/build-run.ts:355`, `trident/build-host.ts:79`). The real Git test measures the diff again after the write (`trident/gates/local-merge.test.ts:51`) and asserts the empty result (`trident/gates/local-merge.test.ts:63`). Restoring the old diff-equality condition makes that positive case red.

### Test-design correction

An initial new test expected an additional G109 measurement during admission. That expectation was wrong: branch/worktree provisioning may follow admission. It was removed alongside that premature probe, and a regression now asserts that admission can precede provisioning (`trident/build-host.test.ts:440`). That regression was red with the premature probe and green after its removal. G109 refusal coverage remains at the publication and merge boundaries (`trident/build-host.test.ts:353`).

### Deliberate scope

The task preserves existing local-mode support, so it does not change a product decision in SPEC.md. Legacy orchestration, conflict resolution, worker cleanup and external publication wiring were deliberately left to their existing owners. The new local contract uses a retained reviewed commit; it does not promise to accept a rewritten rebase head as the same reviewed revision. The record uses the lane-requested staging path rather than the default docs/as-built location.

### Validation

Final bounded validation: `bun test trident/build-run.test.ts trident/build-host.test.ts trident/gates/ trident/merge.test.ts` — **248 pass, 0 fail**, across the nine files enumerated by that command. This includes the unchanged legacy merge regression file (105 tests).

`bun run typecheck` reported that the script is not defined. The installed compiler, `tsc --noEmit -p trident/tsconfig.json`, passed; the final invocation used an incremental cache outside the repository. `bash scripts/ci/lint.sh` passed. `git diff --check` passed.

The leak gate reported **INCOMPLETE**, with zero findings in executed rules: the private PII file/message denylists were unavailable. This is an explicit validation limit, not a clean leak-gate result.

The mutation table follows below. Each table row was enumerated from the executed mutation cases; each case prints its exact changed source line, runs a named test with the wrong verdict, restores the source, and runs the test again. No test assertion was relaxed for a mutant.

### Mutation table

Every row below compiled with `tsc --noEmit -p trident/tsconfig.json`, returned test exit 1 under mutation, and returned exit 0 after restoration. The exact changed line is reproduced in the mutation column. T identifiers name the tests that actually failed, not just the test filter.

- T1: `trident/gates/local-merge.test.ts:68` — G109 branch, isolation, repository identity, dirt and head gates refuse.
- T2: `trident/gates/local-merge.test.ts:81` — G109 actual overlapping base drift blocks; unavailable observations remain unknown.
- T3: `trident/build-host.test.ts:384` — local host confirmation measures retained branch and base ancestry.
- T4: `trident/build-host.test.ts:353` — local host gates use local evidence without remote publication or CI.
- T5: `trident/build-run.test.ts:579` — local mode rejects PR identity and changed landing revision.
- T6: `trident/build-run.test.ts:560` — local mode requires independent merge confirmation.
- T7: `trident/build-run.test.ts:590` — PR mode still requires a real PR after publication.
- T8: `trident/gates/local-merge.test.ts:94` — local admission preserves branch ownership without a remote.
- T9: `trident/build-run.test.ts:597` — local revision is pinned across the publication boundary.
- T10: `trident/gates/local-merge.test.ts:39` — G109 real local worktree and branch allow, landing retains the reviewed branch.

| Guard and changed line | Actual mutation | Red test | Mutated / restored |
| --- | --- | --- | --- |
| branch (`trident/merge.ts:1642`) | `if (!branch \|\| branch === base) return { kind: 'allow' }` | T1 | RED 1 / GREEN 0 |
| isolation (`trident/merge.ts:1644`) | `if (!worktree \|\| realpathOrSelf(worktree) === realpathOrSelf(repo)) return { kind: 'allow' }` | T1 | RED 1 / GREEN 0 |
| worktree-read (`trident/merge.ts:1646`) | `if (!top.ok \|\| !top.stdout.trim()) return { kind: 'allow' }` | T2 | RED 1 / GREEN 0 |
| isolation (`trident/merge.ts:1647`) | `if (realpathOrSelf(top.stdout.trim()) !== realpathOrSelf(worktree)) return { kind: 'allow' }` | T1 | RED 1 / GREEN 0 |
| repository-read (`trident/merge.ts:1650`) | `if (roots.some(r => !r.ok \|\| !r.stdout.trim())) return { kind: 'allow' }` | T2 | RED 1 / GREEN 0 |
| repository-match (`trident/merge.ts:1651`) | `if (realpathOrSelf(roots[0]!.stdout.trim()) !== realpathOrSelf(roots[1]!.stdout.trim())) return { kind: 'allow' }` | T1 | RED 1 / GREEN 0 |
| preservation (`trident/merge.ts:1654`) | `if (dirt !== null) return { kind: 'allow' }` | T1 | RED 1 / GREEN 0 |
| drift-unknown (`trident/merge.ts:1656`) | `if (!drift.assessable) return { kind: 'allow' }` | T2 | RED 1 / GREEN 0 |
| review-pin (`trident/merge.ts:1657`) | `if (drift.branch_head_sha !== head) return { kind: 'allow' }` | T1 | RED 1 / GREEN 0 |
| drift-hold (`trident/merge.ts:1658`) | `if (shouldHoldForBaseDrift(drift, new Set(), { hold_when_unassessable: true })) return { kind: 'allow' }` | T2 | RED 1 / GREEN 0 |
| host-exception (`trident/merge.ts:1660`) | `} catch { return { kind: 'allow' } }` | T2 | RED 1 / GREEN 0 |
| retained-branch (`trident/build-host.ts:78`) | `if (tip.stdout.trim() !== snapshot.head) return { kind: 'allow' }` | T3 | RED 1 / GREEN 0 |
| ancestry-negative (`trident/build-host.ts:82`) | `? { kind: 'allow' }` | T3 | RED 1 / GREEN 0 |
| ancestry-unknown (`trident/build-host.ts:83`) | `: { kind: 'allow' }` | T3 | RED 1 / GREEN 0 |
| local-config (`trident/build-host.ts:68`) | `: Promise.resolve({ kind: 'allow' })` | T4 | RED 1 / GREEN 0 |
| bound-mode (`trident/build-run.ts:151`) | `if (local && input.mode === 'bound_pr') return { kind: 'merged', snapshot: { head: '', diff: '', pr: null } }` | T5 | RED 1 / GREEN 0 |
| confirmation-source (`trident/build-run.ts:152`) | `if (local && !deps.confirmLocalMerge) return { kind: 'merged', snapshot: { head: '', diff: '', pr: null } }` | T6 | RED 1 / GREEN 0 |
| no-local-pr (`trident/build-run.ts:169`) | `if (local && snapshot.pr !== null) return { kind: 'merged', snapshot: { head: '', diff: '', pr: null } }` | T5 | RED 1 / GREEN 0 |
| PR-required (`trident/build-run.ts:343`) | `return { kind: 'merged', snapshot }` | T7 | RED 1 / GREEN 0 |
| confirmation-verdict (`trident/build-run.ts:357`) | `if (confirmation) return { kind: 'merged', snapshot }` | T6 | RED 1 / GREEN 0 |
| confirmation-config (`trident/build-host.ts:72`) | `if (!options.local) return { kind: 'allow' }` | T3 | RED 1 / GREEN 0 |
| confirmation-read (`trident/build-host.ts:77`) | `if (!tip.ok) return { kind: 'allow' }` | T3 | RED 1 / GREEN 0 |
| local-admission-ref (`trident/gates/project-admission.ts:31`) | `const baseRef = local ? `refs/remotes/origin/${project.baseBranch}` : `refs/remotes/origin/${project.baseBranch}`` | T8 | RED 1 / GREEN 0 |
| local-publication-pin (`trident/build-run.ts:343`) | `return { kind: 'merged', snapshot }` | T9 | RED 1 / GREEN 0 |
| local-head-after-merge (`trident/build-run.ts:355`) | `if (merged.value.head !== reviewed.head \|\| merged.value.pr !== null) return { kind: 'merged', snapshot }` | T5 | RED 1 / GREEN 0 |
| local-diff-after-merge (`trident/build-run.ts:355`) | `if (!corroborates(reviewed, merged.value) \|\| merged.value.pr !== null) return blocked('Local revision changed during merge')` | T10 | RED 1 / GREEN 0 |
| local-no-publication (`trident/build-run.ts:336`) | `await deps.publish(snapshot)` | T10 | RED 1 / GREEN 0 |
