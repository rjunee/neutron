## 2026-09-15 — Split the publication cluster from the orchestrator

### What changed

The publication path is now `publishBuiltCommit` in `trident/publication.ts:79`, with its dependencies passed explicitly through `PublicationDeps` at `trident/publication.ts:69`. The orchestrator retains a narrow adapter at `trident/orchestrator.ts:1564` and its two existing call sites continue to invoke that adapter at `trident/orchestrator.ts:2030` and `trident/orchestrator.ts:3563`. The orchestrator is 547 lines shorter than the baseline; the moved module is 595 lines.

The existing publication failure taxonomy remains unchanged: `classifyPublishFailure` at `trident/orchestrator.ts:893` still maps recognized push failures and defaults unrecognized failures to `publish-unknown` at `trident/orchestrator.ts:907`. This move adds no outcome. Continuous wiring is maintained by the typed `PublicationDeps` boundary at `trident/publication.ts:69`, the orchestrator adapter at `trident/orchestrator.ts:1564`, and the unchanged integration suite.

### Gate relocation and mutation evidence

The old locations were enumerated by property in the pre-move `publishBuiltCommit` body, not copied from the stale inventory locations. Each mutation compiled and produced a wrong runtime answer. After every mutation was restored, the complete focused validation returned 308 pass, 0 fail, and 2668 expectations.

| Gate | Old line(s) | New line(s) | Existing covering test | Compiling mutation at new line | Red result | Restored result |
|---|---:|---:|---|---|---:|---:|
| G083 | `trident/orchestrator.ts:1614`, `:1622` | `trident/publication.ts:86`, `:67` | `trident/orchestrator.test.ts:391` | invert PR-mode guard at line 59 | 0 pass, 7 fail | 308 pass, 0 fail |
| G084 | `trident/orchestrator.ts:1646`, `:1647` | `trident/publication.ts:118`, `:92` | `trident/orchestrator.test.ts:1396` | reject allowed lineage at line 92 | 2 pass, 4 fail | 308 pass, 0 fail |
| G085 | `trident/orchestrator.ts:1662` | `trident/publication.ts:134` | `trident/orchestrator.test.ts:472` | reject readable observation at line 107 | 0 pass, 3 fail | 308 pass, 0 fail |
| G086 | `trident/orchestrator.ts:1669`, `:1674` | `trident/publication.ts:141`, `:119` | `trident/orchestrator.test.ts:3128` | invert pinned-base ancestry result at line 119 | 0 pass, 1 fail | 308 pass, 0 fail |
| G098 | `trident/orchestrator.ts:1778`, `:1783` | `trident/publication.ts:250`, `:228` | `trident/orchestrator.test.ts:1486` | lease against the publish head instead of the observation at line 228 | 0 pass, 1 fail | 308 pass, 0 fail |
| G099 | `trident/orchestrator.ts:1791`, `:1795` | `trident/publication.ts:263`, `:240` | `trident/orchestrator.test.ts:974` | reject the matching remote witness at line 240 | 0 pass, 1 fail | 308 pass, 0 fail |
| G100 | `trident/orchestrator.ts:1411`, `:1807` | `trident/publication.ts:53`, `:252` | `trident/orchestrator.test.ts:1257` | invert the real-claim conflict guard at line 252 | 0 pass, 1 fail | 308 pass, 0 fail |
| G101 | `trident/orchestrator.ts:1819`, `:1822` | `trident/publication.ts:291`, `:267` | `trident/orchestrator.test.ts:1908` | treat successful PR creation as failure at line 264 | 0 pass, 1 fail | 308 pass, 0 fail |
| G102 | `trident/orchestrator.ts:1943`, `:2083`, `:2107` | `trident/publication.ts:415`, `:528`, `:552` | `trident/orchestrator.test.ts:2997` | allow a readable empty changed-path result at line 388 | 0 pass, 1 fail | 308 pass, 0 fail |
| G103 | `trident/orchestrator.ts:2018`, `:2042`, `:2070` | `trident/publication.ts:490`, `:487`, `:515` | `trident/orchestrator.test.ts:776` | make the reorder eligibility count impossible at line 487 | 0 pass, 1 fail | 308 pass, 0 fail |
| G139 | `trident/orchestrator.ts:1728`, `:1744`, `:1817` | `trident/publication.ts:200`, `:189`, `:262` | `trident/orchestrator.test.ts:9725` | create the PR before preflight at temporary line 151 | 0 pass, 1 fail | 308 pass, 0 fail |

### Baseline and validation

Before the move, `bun test trident/orchestrator.test.ts trident/gates-inventory-citations.test.ts` returned 308 pass, 0 fail, and 2668 expectations across two files. After the move and all restored mutations, the same command returned the same counts. `bunx tsc -p trident/tsconfig.json --noEmit` completed successfully. Inventory implementation citations now resolve to the moved gates at `docs/trident-gates-inventory.md:167` through `docs/trident-gates-inventory.md:187` and `docs/trident-gates-inventory.md:233`.

### Decisions and deliberate omissions

This is a mechanical move: refusal strings, check ordering, conditions, and tests were not revised. I retained the established export surface by re-exporting publication helpers from `trident/orchestrator.ts:7`. I did not rename helpers, clean up comments, alter types beyond the dependency boundary, touch the excluded execution or adapter areas, or change `SPEC.md`; the product decision did not change.
