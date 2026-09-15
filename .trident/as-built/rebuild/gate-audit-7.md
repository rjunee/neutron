## Gate audit 7 — the final 35 rebuilt-path rows

### Scope, enumeration, and governing mapping

**All 35 assigned gates are classified: 7 PRESERVED, 18 CONFLICTS, 10 CANNOT TELL.** Enumeration was mechanical: the lane's two explicit ID lists were joined to their unique inventory rows, spanning `docs/trident-gates-inventory.md:89`, `docs/trident-gates-inventory.md:99`, `docs/trident-gates-inventory.md:106`, `docs/trident-gates-inventory.md:171-182`, `docs/trident-gates-inventory.md:187`, `docs/trident-gates-inventory.md:195-196`, `docs/trident-gates-inventory.md:215-216`, `docs/trident-gates-inventory.md:226-232`, `docs/trident-gates-inventory.md:252-259`, and `docs/trident-gates-inventory.md:269`. Each row's property, implementation, certification, and loss statement was read.

Both predecessor records were read from their locally recorded commits before implementation inspection. Audit 4's unresolved boundary was that direct publication performs no replay; audit 5's was that `prepareWork` had no production implementation. Both are now inspectable: the production composition supplies the effects at `trident/project-build-host.ts:62-75`, and preparation writes verified host context at `trident/production-host-effects.ts:391-402`.

The fetched `origin/main` tree was queried with one tracked-file command. It returned the positive control `CONTRIBUTING.md`, both named production files, and the current `trident/gates/` files. Thus the claim concerns the fetched ref, not merely this checkout. The product mapping is explicit: the replacement must preserve deterministic publication, cleanup, admission, and recovery as host-owned services (`docs/trident-routing-gap.md:154-156`), while the inventory assigns publication/replay and cleanup IDs to that cutover (`docs/trident-routing-gap.md:164-174`). Therefore omission is not evidence that replay or cleanup became obsolete.

### Classification table

| Gate | Inventory | Verdict | Rebuilt-path evidence or exact boundary |
| --- | --- | --- | --- |
| G020 | `docs/trident-gates-inventory.md:89` | PRESERVED | The rebuilt path accepts only the persisted launch base after full-OID validation (`trident/production-host-effects.ts:176-184`) and constructs the diff through the range-argument builder (`trident/production-host-effects.ts:168-171`), so an unpinned, padded, empty, or option-shaped base never becomes shell text. |
| G030 | `docs/trident-gates-inventory.md:99` | CANNOT TELL | Preparation copies the externally supplied source brief and appends only a context-file instruction (`trident/project-build-host.ts:49-60`); the context writer serializes snapshot/previous/findings without composing branch-log or branch-brief prompt data (`trident/production-host-effects.ts:391-402`). No production caller in the inspected tree supplies the source briefs, so their neutralization and caps cannot be inspected. |
| G037 | `docs/trident-gates-inventory.md:106` | PRESERVED | The driver calls `advanceRalph` before returning continuation (`trident/build-run.ts:405-410`); the production effect compares the stored iteration/checkpoint/head and atomically appends the consumed marker plus next checkpoint (`trident/production-host-effects.ts:266-280`). `trident/build-run.test.ts:464-483` reaches both continuation after consumption and blocked/unknown handoffs that never acknowledge continuation. |
| G087 | `docs/trident-gates-inventory.md:171` | CONFLICTS | Publication goes from readiness directly to remote-ref observation and push (`trident/production-host-effects.ts:324-340`); it never reads the remote base, acquires its object, or proves a fork point. Lost: a branch can be published without the inventory's proof that replay contains only this branch's work. |
| G088 | `docs/trident-gates-inventory.md:172` | CONFLICTS | The direct publication sequence performs no depth read or unshallow acquisition before ancestry decisions (`trident/production-host-effects.ts:324-340`). Lost: shallow history is not repaired before the base relationship is relied upon. |
| G089 | `docs/trident-gates-inventory.md:173` | CONFLICTS | Publication creates neither a patch nor a scratch worktree; it directly pushes the measured head (`trident/production-host-effects.ts:330-340`). Lost: unreadable/empty replay material and unavailable isolation are never refused. |
| G090 | `docs/trident-gates-inventory.md:174` | CONFLICTS | No apply result or unmerged-path observation exists between readiness and push (`trident/production-host-effects.ts:330-340`). Lost: wholesale apply failure cannot be distinguished from a real conflict before resolver authority. |
| G091 | `docs/trident-gates-inventory.md:175` | CONFLICTS | The publisher has no resolver dependency and directly pushes after readiness (`trident/production-host-effects.ts:324-340`). Lost: replay conflicts have neither a configured resolver requirement nor the inventory's conflict-attention outcome. |
| G092 | `docs/trident-gates-inventory.md:176` | CONFLICTS | The publication effect makes no unmerged-state, staged-content, or residual-marker check (`trident/production-host-effects.ts:324-340`). Lost: a claimed replay resolution is not independently inspected. |
| G093 | `docs/trident-gates-inventory.md:177` | CONFLICTS | No replay resolution loop exists in the publication effect (`trident/production-host-effects.ts:324-350`). Lost: repeated resolver calls need not demonstrate a shrinking conflict set because the required replay stage is absent. |
| G094 | `docs/trident-gates-inventory.md:178` | CONFLICTS | Publication has no replay-round counter or ceiling before its direct push (`trident/production-host-effects.ts:324-350`). Lost: replay resolution has no 12-attempt publication bound. |
| G095 | `docs/trident-gates-inventory.md:179` | CONFLICTS | The measured commit is pushed unchanged and no original message is read (`trident/production-host-effects.ts:332-340`). Lost: a replayed commit would have no enforced original subject/provenance preservation. |
| G096 | `docs/trident-gates-inventory.md:180` | CONFLICTS | Publication has no replay commit or empty-resolution classification (`trident/production-host-effects.ts:324-350`). Lost: an empty resolution and other commit failures do not enter the required conflict-attention vocabulary. |
| G097 | `docs/trident-gates-inventory.md:181` | CONFLICTS | The only compare-and-swap is the remote push lease (`trident/production-host-effects.ts:332-340`); there is no local replay branch advance against the pre-replay head. Lost: a concurrent local writer can invalidate the unpublished replay result without the required local CAS refusal. |
| G098 | `docs/trident-gates-inventory.md:182` | PRESERVED | The publisher parses the exact observed remote OID (or empty state) and supplies it to explicit `--force-with-lease` (`trident/production-host-effects.ts:332-338`). `trident/production-host-effects.test.ts:193-201` reaches first publication and asserts the empty explicit lease plus the remote result. |
| G103 | `docs/trident-gates-inventory.md:187` | PRESERVED | The replacement performs no seen-pin reordering: the host measures the complete file-backed binary diff (`trident/production-host-effects.ts:164-174`) and serializes that exact snapshot into turn context (`trident/production-host-effects.ts:396-401`). The preparation test compares the complete persisted context to its input (`trident/production-host-effects.test.ts:300-315`), so uncertainty cannot select a partial reordered artifact. |
| G106 | `docs/trident-gates-inventory.md:195` | CANNOT TELL | The gate invokes `options.mutation.readClaim(snapshot)` before proof (`trident/build-host.ts:171-177`), but `readClaim` remains an injected policy dependency (`trident/build-host.ts:33-37`; `trident/project-build-host.ts:33-36`). No inspected production constructor establishes that fallback bytes come only from the reviewed commit. |
| G107 | `docs/trident-gates-inventory.md:196` | PRESERVED | Merge readiness is checked and the remote merge command carries the reviewed snapshot as `--match-head-commit` (`trident/production-host-effects.ts:353-381`). `trident/production-host-effects.test.ts:235-258` reaches the real command and asserts its complete argv and merged witness. |
| G126 | `docs/trident-gates-inventory.md:215` | CONFLICTS | The composed production effects end at prepare, measure, publish, and merge (`trident/production-host-effects.ts:389-407`), and `createProjectBuildHost.run` has no cleanup unwind (`trident/project-build-host.ts:77-83`). Lost: dirty/unverifiable trees and mode-specific branch retention never receive the required deterministic cleanup attempt. |
| G127 | `docs/trident-gates-inventory.md:216` | CONFLICTS | The production run catches an exception as `unknown` but acquires no cleanup exit/output evidence (`trident/project-build-host.ts:77-83`). Lost: preserved or uninspected work has no cleanup result in the rebuilt outcome. |
| G132 | `docs/trident-gates-inventory.md:226` | CANNOT TELL | The host adds only “Read the host turn context” to the supplied brief (`trident/project-build-host.ts:49-60`); `prepareWork` does not add the no-question/abort instruction (`trident/production-host-effects.ts:391-402`). Whether the injected source brief contains it cannot be seen without the production caller that constructs `workers`. |
| G133 | `docs/trident-gates-inventory.md:227` | CANNOT TELL | The same composer appends only the context reference (`trident/project-build-host.ts:49-60`), so verbose-output redirection can only reside in the unobserved supplied brief. |
| G134 | `docs/trident-gates-inventory.md:228` | CANNOT TELL | Neither the per-role brief suffix nor serialized turn context supplies process-kill restrictions (`trident/project-build-host.ts:49-60`; `trident/production-host-effects.ts:391-402`); the externally supplied source brief remains the unresolved owner. |
| G135 | `docs/trident-gates-inventory.md:229` | CANNOT TELL | Installed repository hooks do refuse an unreadable or empty HEAD (`.githooks/pre-commit:20-30`), but the required Forge diagnostic-wrapper instruction is not composed by the production preparer (`trident/project-build-host.ts:49-60`). The compound property cannot be certified from the unseen source brief. |
| G136 | `docs/trident-gates-inventory.md:230` | CANNOT TELL | Publication is host-owned after review (`trident/build-run.ts:500-520`), but the host-generated brief suffix contains no instruction that Forge stop after committing (`trident/project-build-host.ts:49-60`). The worker-side prohibition remains uninspectable at the missing source-brief constructor. |
| G137 | `docs/trident-gates-inventory.md:231` | CANNOT TELL | One supplied brief is copied separately for every role (`trident/project-build-host.ts:49-60`), while preparation writes the same context shape for every role (`trident/production-host-effects.ts:391-402`). Without the caller-supplied role briefs, reflection's inclusion for builders and exclusion from review/synthesis cannot be established. |
| G138 | `docs/trident-gates-inventory.md:232` | CANNOT TELL | Deterministic review decisions are delegated to the panel gate (`trident/build-host.ts:168-177`), but preparation adds no evidence-backed minority-veto rubric (`trident/project-build-host.ts:49-60`). The prose rubric can only be in the uninspected supplied review brief/source. |
| G153 | `docs/trident-gates-inventory.md:252` | CONFLICTS | Although the retained script refuses invalid inputs (`trident/worktree-cleanup.sh:108-124`), no production effect invokes it (`trident/production-host-effects.ts:389-407`). Lost on the rebuilt path: cleanup can end without this pre-deletion validation running. |
| G154 | `docs/trident-gates-inventory.md:253` | CONFLICTS | The retained script preserves failed enumeration (`trident/worktree-cleanup.sh:166-177`), but the production run never calls the script (`trident/project-build-host.ts:77-83`). Lost on the rebuilt path: unreadable enumeration produces no preservation result. |
| G155 | `docs/trident-gates-inventory.md:254` | CONFLICTS | The script skips the shared checkout and mismatched roots (`trident/worktree-cleanup.sh:166-170`; `trident/worktree-cleanup.sh:207-212`), but it is absent from the production lifecycle (`trident/production-host-effects.ts:389-407`). Lost on the rebuilt path: those ownership checks do not continuously protect teardown. |
| G156 | `docs/trident-gates-inventory.md:255` | CONFLICTS | The script's branch retention covers preserved trees and unreadable/missing/mismatched remote state (`trident/worktree-cleanup.sh:262-295`), but no production completion invokes it (`trident/project-build-host.ts:77-83`). Lost: the only local ref to built work receives no required retention decision. |
| G157 | `docs/trident-gates-inventory.md:256` | CONFLICTS | The retained script configures its bounded, noninteractive remote read (`trident/worktree-cleanup.sh:91-100`), but production has no cleanup invocation (`trident/production-host-effects.ts:389-407`). Lost: post-run cleanup has neither this hang bound nor its fail-preserving result. |
| G159 | `docs/trident-gates-inventory.md:258` | CANNOT TELL | Review preparation serializes snapshot, prior payload, findings, and request (`trident/production-host-effects.ts:391-402`), but no coverage flag or partial-coverage instruction is composed there. The synthesis/review sources are injected policy (`trident/project-build-host.ts:33-36`), so their treatment of truncated coverage is not inspectable. |
| G160 | `docs/trident-gates-inventory.md:259` | PRESERVED | Base-matched red CI becomes advisory, and an otherwise approving panel is changed to `review-advisory-only` blocked rather than fix (`trident/gates/review-ci.ts:31-37`; `trident/gates/review-ci.ts:46-50`). A thrown review is blocked before any synthesis verdict exists (`trident/build-run.ts:280-285`). `trident/gates/review-ci.test.ts:9-16` reaches base-excused red and proves it blocks without becoming a fix. |
| G165 | `docs/trident-gates-inventory.md:269` | PRESERVED | The former cheap delta classifier has no role in the rebuilt decision path: every non-resumed build plans/builds (`trident/build-run.ts:364-417`) and every resulting nonempty revision enters readiness, suite, CI, and review (`trident/build-run.ts:430-459`). Thus its risky optimization is deliberately absent rather than reused without its predicate. |

### Conflict properties verbatim

The contradiction and loss evidence is in the classification row for each ID; this register supplies the required property in the inventory's own words:

| Gate | Inventory property |
| --- | --- |
| G087 | “Replay requires a readable remote base, available base object, and a provable fork point rather than a stale local-base fallback.” (`docs/trident-gates-inventory.md:171`) |
| G088 | “Replay requires readable depth and successful unshallowing when needed before ancestry decisions.” (`docs/trident-gates-inventory.md:172`) |
| G089 | “Replay refuses an unreadable or empty patch and an unavailable scratch worktree.” (`docs/trident-gates-inventory.md:173`) |
| G090 | “A failed apply with no unmerged paths is a wholesale failure, not permission to invoke the conflict resolver.” (`docs/trident-gates-inventory.md:174`) |
| G091 | “Replay conflicts require a configured resolver that actually reports resolution; otherwise they raise the conflict attention outcome.” (`docs/trident-gates-inventory.md:175`) |
| G092 | “A claimed resolution must be checked against readable unmerged state and staged content, including residual conflict markers.” (`docs/trident-gates-inventory.md:176`) |
| G093 | “Each replay resolution round must shrink the remaining conflict set.” (`docs/trident-gates-inventory.md:177`) |
| G094 | “Replay conflict resolution cannot exceed MAX_CONFLICT_ROUNDS (12).” (`docs/trident-gates-inventory.md:178`) |
| G095 | “Replay must read the original commit message before composing its replay commit.” (`docs/trident-gates-inventory.md:179`) |
| G096 | “A resolution that leaves nothing to commit is a conflict attention outcome; other commit failures also stop publication.” (`docs/trident-gates-inventory.md:180`) |
| G097 | “Replay advances the branch with compare-and-swap against the old head.” (`docs/trident-gates-inventory.md:181`) |
| G126 | “Cleanup preserves dirty/unverifiable trees and retains local-mode branches; PR branch deletion needs a matching remote copy.” (`docs/trident-gates-inventory.md:215`) |
| G127 | “Cleanup reporting cannot treat missing exit evidence as success or confuse preserved output with successful removal.” (`docs/trident-gates-inventory.md:216`) |
| G153 | “Cleanup refuses invalid arguments, unknown modes, or a non-repository before attempting deletion.” (`docs/trident-gates-inventory.md:252`) |
| G154 | “An unreadable worktree enumeration is preservation, not an empty successful cleanup.” (`docs/trident-gates-inventory.md:253`) |
| G155 | “Cleanup skips the shared checkout and paths that are no longer the registered worktree root.” (`docs/trident-gates-inventory.md:254`) |
| G156 | “Cleanup preserves a PR branch when any worktree was preserved, the remote cannot be read, the branch was never pushed, or remote and local heads disagree.” (`docs/trident-gates-inventory.md:255`) |
| G157 | “Cleanup bounds remote reads when timeout is available and disables interactive git authentication.” (`docs/trident-gates-inventory.md:256`) |

### Conflict interpretation and outcome vocabulary

The 18 conflict rows are G087-G097, G126-G127, and G153-G157. Their inventory properties and losses are stated row-by-row above. The publication conflicts join the existing `GateResult` vocabulary (`allow`, `blocked`, `unknown`) at `trident/build-run.ts:33-39`; because no replay operation exists, its conflict-attention outcomes never enter that vocabulary, and direct publication can return `allow` after leased push/PR witness (`trident/production-host-effects.ts:324-350`). Cleanup has no rebuilt outcome at all: the production wrapper's default for thrown host work is only `unknown` (`trident/project-build-host.ts:79-83`), so preservation/removal evidence is not classified.

The cleanup invariant has no continuous maintainer in the replacement lifecycle. The retained script contains the safe decisions (`trident/worktree-cleanup.sh:166-177`; `trident/worktree-cleanup.sh:262-295`), but a mechanism that is never invoked cannot maintain them. This does not depend on the failing worker cooperating; the missing piece is a host-owned finally/unwind, exactly the ownership required by `docs/trident-routing-gap.md:154-156`.

The scoped absence controls used the same searches for missing operations and known-present siblings:

```text
rg -n 'replay|cherry-pick|rebase|publishChecked|force-with-lease' trident/production-host-effects.ts
positive controls: trident/production-host-effects.ts:324 publishChecked; :337 force-with-lease
absent in that production publisher: replay, cherry-pick, rebase

rg -n 'cleanup|worktree-cleanup|prepareWork|publishChecked' trident/production-host-effects.ts trident/project-build-host.ts
positive controls: trident/production-host-effects.ts:324 publishChecked; :391 prepareWork
absent in the composed production lifecycle: cleanup, worktree-cleanup

rg -n 'createProjectBuildHost|ProjectBuildHostOptions' trident --glob '*.ts' --glob '*.mjs'
positive controls: trident/project-build-host.ts:26 ProjectBuildHostOptions; :42 createProjectBuildHost
other hits are tests; no production caller constructs the source briefs
```

These absence claims are scoped to the named rebuilt production files/caller search. They do not claim the retained repository lacks replay or cleanup implementations.

### Verification and deliberate limits

No production code, guard, or test was changed. Therefore mutation testing is not applicable:

| New guard | Mutation | RED | Restored GREEN |
| --- | --- | --- | --- |
| None; report only | Not applicable | Not performed | Not performed |

Targeted verification covered only cited rebuilt components: `bun test trident/production-host-effects.test.ts trident/project-build-host.test.ts trident/build-run.test.ts trident/gates/review-ci.test.ts trident/ci-readiness.test.ts` passed **246 tests, 0 failures, 945 assertions**. Passing a file is not treated as proof unless the cited fixture reaches the property. `bash scripts/ci/typecheck-all.sh` checked 51 TypeScript configurations and all passed; `bash scripts/ci/lint.sh` reported zero findings in every lint subgate; `git diff --check` passed. The leak gate found zero findings in the rules it could execute, but its private PII denylist was unavailable, so that result is **INCOMPLETE, not clean**. Structural checks found exactly one `## ` heading and 35 unique classification-table IDs.

I deliberately changed no production code, tests, inventory, or product decision. I did not infer prompt content from an interface or test fixture. I did not treat retained cleanup-script correctness as rebuilt-path reachability, and I did not reinterpret direct publication as permission to delete replay requirements because the cutover document explicitly requires their preservation (`docs/trident-routing-gap.md:154-174`). The launcher integration remains outside this report; each CANNOT TELL row instead names the concrete missing source-brief or policy constructor needed to settle it.
