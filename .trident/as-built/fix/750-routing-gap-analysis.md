## 2026-09-14 — Establish current build routing and the replacement order

### Delivered

Added `docs/trident-routing-gap.md`: current execution, bounded dispatch, owner-visible routes, and a serialized three-step replacement with file territories, deletions and gate preservation obligations. This is the documentation-only investigation requested by #750, not implementation of #545.

The current build composes a separate ticker/orchestrator/firer (`gateway/composition/build-core-modules.ts:641`, `gateway/composition/build-core-modules.ts:827`), using a warm factory distinct from the project conversation (`open/wiring/substrates.ts:545`, `open/wiring/substrates.ts:265`). #716 queues terminal decisions into the project conversation (`open/composer.ts:4340`). Routing already uses model-derived family/transport branches (`trident/inner-workflow.mjs:688`, `trident/inner-workflow.mjs:2326`); it is not adequately described as only kind-based.

The owner-path analysis enumerates all 28 literal workflow `agent()` call sites, the general dispatch and three outer helper constructions, the eight authenticated sink URL arms, and production terminal observers. Structured escalations and authored resolver questions reach terminal delivery before the project decision observer (`trident/delivery.ts:755`, `trident/delivery.ts:1123`, `trident/terminal-observer.ts:36`). The sink authenticates a child session but its tool/todo arms do not check the spawn-time bridge grant (`runtime/adapters/claude-code/persistent/pool-state.ts:519`, `runtime/adapters/claude-code/persistent/pool-state.ts:564`, `runtime/adapters/claude-code/persistent/pool-state.ts:657`). This is a static authority-gap finding; no credential access or live exploit was attempted. Exact scopes, positive controls and conditional external-capability limits are in the document.

### Decisions and ordering

Pin the inventory's missing guards first, confine worker output/authority second, then atomically replace orchestration and provider-relative dispatch. The inventory's 165 preservation entries include 18 unpinned entries and 156 Silent loss classifications (`docs/trident-gates-inventory.md:3`). The proposed cutover names those IDs, preserves pure interpretation functions required by the unchanged escalation test (`trident/escalation-block.test.ts:31`), and deletes execution paths rather than leaving compatibility executors. Native-child authority confinement and configured Kimi harness support are pre-activation proof obligations; the current Kimi path is a text API request (`trident/kimi-review.ts:207`).

The baseline measurement is now 9,339 / 6,316 / 1,171 lines (16,826 total), correcting the brief. Earlier filing/baseline measurements remain identified as such. The parser citation is corrected to `trident/escalation-evidence.ts:49`; the owner-visible test remains `trident/escalation-block.test.ts:173`. No design decision changed. §3.3 remains headless per call on a reused thread (`docs/plans/harness-orchestrator-pivot-2026-09-11.md:109`).

The record is staged under `.trident/as-built/` as explicitly required by this lane's task, overriding the normal `docs/as-built/` destination. There is one record with exactly one `## ` heading.

### Validation and mutation table

| Guard | Mutation | Red result | Restored green |
| --- | --- | --- | --- |
| Not applicable: this change adds no executable guard or test. | None performed, as required by the documentation-only task. | Not claimed. | Not claimed. |

- `bash scripts/ci/typecheck-all.sh`: passed all 51 configurations. This is the repository's typecheck entry point.
- `bash scripts/ci/lint.sh`: passed.
- No test files changed; no test suite or mutation experiment run.
- Citation existence/line bounds and the 28-call enumeration were checked against the current source. A lexical consumer index reserves 140 candidate files for the cutover; its scope and positive controls are recorded in the document.
- `git diff --cached --check`: passed. The staged path enumeration contains only this record and `docs/trident-routing-gap.md`; the record has exactly one `## ` heading.
- `bash scripts/ci/leak-gate.sh --tree .`: exited 3, INCOMPLETE. The rules that ran found zero findings; the owner PII denylist was unavailable, so tree/message PII checks did not run. This is not a clean leak certification and must be completed by the reviewing environment.

### Deliberately not done

No runtime code or tests changed, no acceptance box checked, no spec decision reopened, and no deployment or network operation performed. This audit does not claim sandbox completeness, a successful autonomous merge, or that a source-string test proves gate survival. No new owner-question checkpoint protocol, feature flag, shim or second executor is proposed. The implementation steps describe required future verification; those checks have not been performed here.
