## 2026-09-15 — Production cleanup on the rebuilt path

### What changed and why

The production wrapper now owns the unwind: `withProductionCleanup` calls the build inside `try`, converts a thrown host call to the existing build `unknown`, and invokes cleanup from `finally` at `trident/project-build-host.ts:42-51`. `createProjectBuildHost.run` routes the production build through that owner at `trident/project-build-host.ts:93-101`. Cleanup therefore does not depend on a worker, gate, or effect returning normally.

The cleanup effect invokes the retained deterministic script with the repository, branch, and mode-derived branch policy at `trident/production-host-effects.ts:392-396`; no deletion decision was copied into TypeScript. The classifier requires coherent command status, exit code, and the script's terminal `RESULT` record for `cleaned` or `preserved`, and maps every other return, timeout, or throw to `failed` at `trident/production-host-effects.ts:397-404`.

The outcome joins the existing `BuildRunOutcome` vocabulary as a required `cleanup` member of `ProjectBuildOutcome` at `trident/project-build-host.ts:40-51`. Existing build kinds (`merged`, `blocked`, `built`, `continued`, `refused`, `failed`, and `unknown`) remain unchanged; cleanup therefore cannot rewrite the build verdict. The cleanup classifier has three explicit answers (`cleaned`, `preserved`, and `failed`) at `trident/production-host-effects.ts:42-45`, and its default is `failed` at `trident/production-host-effects.ts:401-404`, never success or preservation.

The continuous in-process maintainer is the production wrapper's `finally` at `trident/project-build-host.ts:48-50`; it does not depend on the failing worker still functioning. If the whole creating process is gone, the independently supervised reaper runs immediately at startup and then on its timer at `trident/worktree-reaper.ts:1887-1901`; its state-driven sweep covers terminal rows without transition-time code at `trident/worktree-reaper.ts:27-35`.

### Build-ending census

The list is complete because it enumerates every member of `BuildRunOutcome` defined at `trident/build-run.ts:132-140`; the test instantiates all seven kinds at `trident/project-build-host.test.ts:117-143`.

| Build ending | Cleanup attempted | Build verdict retained |
| --- | --- | --- |
| `merged` | yes | yes |
| `blocked` | yes | yes |
| `built` | yes | yes |
| `continued` | yes | yes |
| `refused` | yes | yes |
| `failed` | yes | yes |
| `unknown` | yes | yes |
| thrown effect | yes | converted to existing `unknown` |
| abort throw | yes | converted to existing `unknown` |

### Gate evidence and certification

| Gate | Inventory property | Where it lives now | Certification and permissive mutation |
| --- | --- | --- | --- |
| G125 | Cleanup runs in finally independently of the builder result and delegates deletion decisions to the deterministic cleanup script. | `trident/project-build-host.ts:42-51`; `trident/production-host-effects.ts:392-400` | `trident/project-build-host.test.ts:117-143`; replacing the line at `trident/project-build-host.ts:50` with a synthetic failed result skipped the effect and made the named G125 test red; restoration made it green. |
| G126 | Cleanup preserves dirty/unverifiable trees and retains local-mode branches; PR branch deletion needs a matching remote copy. | Delegation and mode selection are at `trident/production-host-effects.ts:394-400`; the retained decisions remain at `trident/worktree-cleanup.sh:223-257` and `trident/worktree-cleanup.sh:262-311`. | `trident/production-host-effects.test.ts:91-117` plus `trident/worktree-cleanup-sh.test.ts:126`, `:200`, and `:589`; changing the exit-3 classifier at `trident/production-host-effects.ts:400` to require exit 0 made the named G126/G127 test red; restoration made it green. |
| G127 | Cleanup reporting cannot treat missing exit evidence as success or confuse preserved output with successful removal. | `trident/production-host-effects.ts:397-404`; verdict separation is at `trident/project-build-host.ts:40-51`. | `trident/production-host-effects.test.ts:91-117` and `trident/project-build-host.test.ts:146-150`; the exit-3-to-exit-0 mutation at `trident/production-host-effects.ts:400` made the classifier test red; restoration made it green. |
| G153 | Cleanup refuses invalid arguments, unknown modes, or a non-repository before attempting deletion. | The production call delegates all supplied arguments at `trident/production-host-effects.ts:394-396`; refusal remains at `trident/worktree-cleanup.sh:108-127`. | `trident/worktree-cleanup-sh.test.ts:605-625`; replacing the `finally` call at `trident/project-build-host.ts:50` skipped the refusing implementation and made G125's all-endings test red; restoration made it green. |
| G154 | An unreadable worktree enumeration is preservation, not an empty successful cleanup. | Delegated at `trident/production-host-effects.ts:396`; the retained decision is `trident/worktree-cleanup.sh:166-177`; exit 3 becomes `preserved` at `trident/production-host-effects.ts:400`. | `trident/worktree-cleanup-sh.test.ts:426`; the exit-3-to-exit-0 mutation at `trident/production-host-effects.ts:400` made the production classifier test red; restoration made it green. |
| G155 | Cleanup skips the shared checkout and paths that are no longer the registered worktree root. | Delegated at `trident/production-host-effects.ts:396`; retained checks are `trident/worktree-cleanup.sh:166-170` and `trident/worktree-cleanup.sh:207-212`. | `trident/worktree-cleanup-sh.test.ts:335` and `:381`; replacing the `finally` call at `trident/project-build-host.ts:50` skipped those checks and made G125's all-endings test red; restoration made it green. |
| G156 | Cleanup preserves a PR branch when any worktree was preserved, the remote cannot be read, the branch was never pushed, or remote and local heads disagree. | PR mode delegates `delete-branch` at `trident/production-host-effects.ts:394-400`; retained checks are `trident/worktree-cleanup.sh:265-295`. | `trident/worktree-cleanup-sh.test.ts:552`, `:563`, and `:578`; the exit-3-to-exit-0 mutation at `trident/production-host-effects.ts:400` made the preservation classifier test red; restoration made it green. |
| G157 | Cleanup bounds remote reads when timeout is available and disables interactive git authentication. | Delegated at `trident/production-host-effects.ts:396`; retained enforcement is `trident/worktree-cleanup.sh:86-100`. | `trident/worktree-cleanup-sh.test.ts:500` and `:523`; replacing the `finally` call at `trident/project-build-host.ts:50` skipped the bounded implementation and made G125's all-endings test red; restoration made it green. |

### Mutation table

| Guard | Mutation printed before test | Red observation | Restored observation |
| --- | --- | --- | --- |
| `trident/project-build-host.ts:50` | `finally { cleanup = { kind: 'failed', detail: 'mutation skipped cleanup' } }` | G125 test: 0 pass, 1 fail; first `merged` result received `failed` instead of `cleaned`. | G125 test: 1 pass, 0 fail, 10 assertions. |
| `trident/production-host-effects.ts:400` | changed `result.exit_code === 3` to `result.exit_code === 0` | G126/G127 classifier test: 0 pass, 1 fail; exit 3 preservation received `failed`. | G126/G127 classifier test: 1 pass, 0 fail, 8 assertions. |

### Validation

- `bun test trident/production-host-effects.test.ts trident/project-build-host.test.ts trident/build-run.test.ts`: 244 pass, 0 fail, 940 assertions.
- `bun test trident/worktree-cleanup-sh.test.ts`: 29 pass, 0 fail, 117 assertions; this enumerates every cited retained-script certification in the gate rows.
- `bash scripts/ci/typecheck-all.sh`: 51 configurations checked, all pass.
- `git diff --check`: pass.

### Deliberately not changed

`trident/worktree-cleanup.sh` was not edited; it remains the single owner of deletion and preservation decisions at `trident/worktree-cleanup.sh:15-25`. `trident/build-run.ts` was not changed because its driver already returns the complete build-ending vocabulary at `trident/build-run.ts:132-140`, while the production wrapper owns thrown-host conversion at `trident/project-build-host.ts:42-51`. No replay publisher, gate module, build-host implementation, feature flag, or alternate cleanup path was added.
