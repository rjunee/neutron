## 2026-09-24 — Explicit current Codex model tiers for Trident

Implementation for #1274; deployment and a fresh served-run proof remain pending.
The initiating defect was a live reviewer requesting `sol` while the registry
resolved it to the older `gpt-5.6-sol`. The 2026-09-24 installed Codex catalog
advertised `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, and `gpt-5.6-terra`.
It did not advertise `gpt-6-terra`; the same slug search found the three GPT-6
positive controls and the existing Terra ID. The official
[model catalog](https://developers.openai.com/api/docs/models) independently
confirmed the GPT-6 names. Availability was checked through model metadata;
these tests do not establish live provider inference availability.

`trident/model-tiers.ts:150` now resolves the four explicit classes without
substituting Terra with another class. `runtime/configured-models.ts:2` reserves
Astra so configured API seats cannot shadow it. The flagship Codex review default
is Astra in `trident/phase-models.ts:243`, `trident/inner-workflow.mjs:487`, and
`trident/codex-review.sh:510`. The direct build wrapper defaults to medium-work Sol
at `trident/codex-build.sh:1396`; explicit phase choices keep their selected tier.
This does not add automatic task-complexity routing or change provider placement.

Both wrappers now refuse empty or whitespace-only model values before model
execution (`codex-review.sh:511`, `codex-build.sh:1397`). Nonempty IDs are passed
exactly to the CLI. The old empty-model test that only checked for absence of
`--model` was replaced with exit-code, diagnostic, and no-execution assertions;
absence alone also passed when the wrapper refused, so it could not establish
the old claimed fallback behavior. Existing review gates and failure handling
are unchanged. The immutable SPEC decision records the owner rule; the current
system overview was corrected, and historical records retain their original IDs.

Verification:

- Registry, phase coverage, workflow dispatch, review source, and settings
  producer/client tests: 247 passed. Wrapper/workflow suites passed, with exact
  argv assertions for each Codex class and paired empty-model refusals.
  Configured-chat and instance-model-provider consumers: 44 passed.
- `open/__tests__/project-build-e2e.test.ts:1644` checks each exact ID on native
  build requests while Claude review remains headless. The cases at `:3337`
  check every tier and the unconfigured Astra review default through the real
  read-only headless runner, exact CLI argv, and a simulated merge. Attempt
  accounting at `:1441` also asserts the resolved Sol ID.
- Root and Trident `tsc --noEmit` passed. No full repository suite was run while
  the independent live acceptance run was active.
- Semantic mutants in both directions: removing the two empty-model guards
  produced four expected refusal-test failures; unconditional refusal produced
  eight expected exact-model test failures. Allowing Astra seat shadowing and
  rejecting all configured seats each failed the paired configuration test.
  Restoring Sol's stale ID failed both the native-build and headless-review E2E
  consumers. Restored controls passed (15 guard cases and both Sol consumers).
- The E2E socket fixtures initially met sandbox `EPERM` at local Unix socket
  bind: the full file completed with 290 passed and nine environment refusals.
  All nine affected cases passed with the required socket permission;
  the same targeted rerun also passed all nine native/headless tier cases
  (18 passed total). This was an environment refusal, not a code failure.
- The local leak gate was not green: a clean export of fetched base `519c1eae8`
  independently reproduced 455 denylist findings (167 substring and 288 word
  matches). The worktree scan had the same counts plus its local git pointer.
  No leak rule or allowlist was changed. Publication still requires the normal
  CI gate; these baseline findings are not represented as a clean check.

The tests use scripted provider outcomes and do not prove the deployed process
has adopted this registry. Keep #1274 open until the reviewed revision is
deployed and a fresh run records the requested tier and exact resolved model.
