## 2026-09-24 — Reconcile the retry-visibility spec item to its shipped state (#1212)

Issue #1212 records that `docs/spec-items/surface-infra-retries-to-the-owner.md`
still read `status: open` and still claimed that production never supplied
`on_infra_retry` and that `RunProgress` carried no retry count. Both claims were
true on 2026-09-12 and false since PR #904 (merge commit
`5d72f26fa5a7d58688d94ebac8a250a91b73d087`, an ancestor of the base
`14d91edcd43d1e2cbd47ab15d61193d49d782702`), which closed inbox issue #535 and
recorded its work in `.trident/as-built/fix/535-fix.md`.

This change is a queue reconciliation. It changes three paths:

- `docs/spec-items/surface-infra-retries-to-the-owner.md` keeps its slug and
  frontmatter, changes only `status` from `open` to `done`, replaces the
  measured-defect prose with present-tense shipped behaviour and provenance, and
  checks all five acceptance criteria, each citing the consuming test that proves it.
- `trident/infra-retry.test.ts` changes a test only: the `(b) genuine failures never
  auto-retry` case now supplies a recording `on_infra_retry` observer and asserts it
  was never called. The criterion "a run that retries zero times produces none" was
  previously true only by code reading; it is now pinned by a test.
- This record.

`docs/spec-items/README.md` was regenerated with `bun run scripts/spec-items-index.ts`
and is byte-identical, because the renderer has no status column.

**No production file changed.** Retry runtime behaviour is unchanged: the budget,
the backoff schedule, the atomic claim, the once-per-run notification, the
`retrying` projection and terminal exhaustion are exactly as #904 left them.

### Why the queue was stale

The item was split out of SPEC.md on 2026-09-12 (#514) describing the two gaps as
measured then. PR #904 closed the inbox issue and wrote its record under
`.trident/as-built/`, but never touched the queue file. `docs/process/work-tracking.md`
§3.4 makes `docs/spec-items/`, not the inbox, the answer to "what is done", so the
queue kept reporting shipped work as open.

### Verified provenance at the base

- Composition: `gateway/composition/build-core-modules.ts:80` imports
  `deliverInfraRetry`; `:823` wires `begin_infra_retry`; `:824-825` wires
  `on_infra_retry` to `deliverInfraRetry(tridentWiring.delivery_sink ?? router, …)`.
  Outside tests and docs, `on_infra_retry` appears only there and in
  `trident/orchestrator.ts` (`:451` declaration, `:1303` read, `:2531` passed into
  `tryInfrastructureRetry`).
- Delivery: `trident/delivery.ts:1451-1466` posts the retry notice with the measured
  cause to the originating topic and returns without sending when there is none.
- Once only: `trident/infrastructure-retry.ts:114-136` claims the retry atomically,
  sets the backoff from `INFRA_RETRY_BACKOFF_MS` (`:11`), and calls the observer only
  when the claimed row reads `infra_retries === 1`, catching a throw.
- Exhaustion: `trident/infrastructure-retry.ts:93-111` fails the run with a reason
  naming the budget and records `REVIEW_NOT_RUN`.
- Projection: `trident/run-progress.ts:53` (`retrying` label), `:73`
  (`infra_retries`), `:245-249` (`retrying` only while non-terminal with a positive
  count). Both clients accept and render it (`app/lib/work-board-helpers.ts:235,338`,
  `landing/chat-react/WorkBoardTab.tsx:223,319`) as the literal `Retrying` tag.
  The clients parse `infra_retries` into their wire type but no card renderer
  reads it, so the count reaches the wire and the card does not print it; #904's
  record keeps the round display authoritative. The spec item says this plainly
  rather than claiming an on-card attempt count, and notes that the once-per-run
  notice always names attempt 1.

### Tests

All test shells ran with `CLAUDECODE` and `AI_AGENT` unset.

- Baseline before any edit: `bun test trident/run-progress.test.ts trident/infra-retry.test.ts gateway/__tests__/trident-crash-recovery-wiring.test.ts scripts/__tests__/spec-items-index.test.ts app/__tests__/work-board-helpers.test.ts`: 152 pass, 0 fail. `bun test landing/chat-react/__tests__/work-board-tab.test.tsx`: 46 pass, 0 fail.
- After the change, the same five-file run: 152 pass, 0 fail, 658 `expect()` calls
  (the new check is an assertion inside an existing test, so the test count is unchanged).
- `bun test landing/chat-react/__tests__/work-board-tab.test.tsx`: 46 pass, 0 fail.
- `bun test open/__tests__/project-build-e2e.test.ts`: 287 pass, 0 fail.
- `tsc -p tsconfig.json --noEmit` and `tsc -p trident/tsconfig.json --noEmit`: no errors.

### Mutation evidence

Both mutants were applied to production files only temporarily; each file was
restored and the final diff contains no production change.

| Mutation | Red evidence | Restored |
|---|---|---|
| In `trident/infrastructure-retry.ts`, call `onInfraRetry` before the `classifyInnerFailure` branch, so a genuine failure also notifies | `trident/infra-retry.test.ts:208` `expect(calls).toEqual([])` received `[{ attempt: 1, cause: "review found a correctness defect" }]`; 7 pass, 2 fail (the told-once test also went red) | 9 pass, 0 fail |
| In `trident/run-progress.ts:245`, change `run.infra_retries > 0` to `< 0` | `trident/run-progress.test.ts:58` expected `"retrying"`, received `"building"`; 39 pass, 1 fail | 40 pass, 0 fail |

### Deliberately not changed

- `.trident/as-built/fix/535-fix.md` is #904's own record and stays as written.
- No "attempt N" counter was added to either card. Criterion 3 asks that the wire
  carry the count so a card *can* render it, and that deleting the field reds a
  test; both hold. Printing the number on the card would change runtime UI
  behaviour, which this reconciliation must not do.
- `docs/as-built/wire-fable-arbiter.md` and `docs/as-built/spec-items-split.md`
  still describe the historical gap; merged shards are immutable.
- PR #1213, the failed earlier attempt at this reconciliation, was not adopted,
  rebased or cherry-picked; this change was built fresh from the base above.
