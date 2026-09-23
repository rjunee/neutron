## 2026-09-23 — Reconcile the shipped retry-visibility spec item to done (#1212)

`docs/spec-items/surface-infra-retries-to-the-owner.md` now reads `status: done`. Its
measured-defect prose is replaced with a present-tense account of the shipped behaviour and its
provenance, and its five acceptance criteria are ticked, each with the consuming test it was
re-proven against. One negative assertion was added to `trident/infra-retry.test.ts`. Runtime
behaviour is unchanged: `git diff --stat origin/main...HEAD` names only the spec item, this
record and `trident/infra-retry.test.ts`:

```
 docs/as-built/1212-reconcile-retry-visibility-spec.md |  99 ++++++++++++++++++
 docs/spec-items/surface-infra-retries-to-the-owner.md | 106 +++++++++++++--------
 trident/infra-retry.test.ts                           |  10 +-
 3 files changed, 172 insertions(+), 43 deletions(-)
```

No `.ts` production file changed. `docs/spec-items/README.md` was regenerated with
`bun run scripts/spec-items-index.ts` and came back byte-identical: the index renders no
`status` column, and this item has `cutover: false`, so it never appeared in the cutover list.

### Why the queue was stale

The behaviour shipped in #904, merged 2026-09-15 as `5d72f26f`. It closed #535 and wrote
its record at `.trident/as-built/fix/535-fix.md`. The canonical item under `docs/spec-items/`
(the single queue, per `docs/process/work-tracking.md:98-111`) was never edited: its history has
one commit, the #514 split of 2026-09-12. So it still described the `on_infra_retry` callback
as passed only by a test and the retry count as absent from `RunProgress`, after both had
shipped. The mismatch surfaced while selecting an unshipped card for #1196, and #1212 was filed
for it. `.trident/as-built/fix/535-fix.md` is immutable and was not touched.

### What was re-proven, criterion by criterion

1. **Production composition supplies `on_infra_retry`.**
   `gateway/composition/build-core-modules.ts:824-825` assigns it to
   `deliverInfraRetry(tridentWiring.delivery_sink ?? router, run, attempt, cause)`.
   `rg -n "on_infra_retry" --glob '!**/*.test.ts' --glob '!**/*.md'` names that line plus the
   orchestrator declaration (`trident/orchestrator.ts:448`) and read (`:1299`, handed to the
   retry step at `:2508`). Pinned by `gateway/__tests__/trident-crash-recovery-wiring.test.ts:37-40`.
2. **Told once per run; zero retries means no notice.** `trident/infrastructure-retry.ts:92`
   enters the retry path only for an `infrastructure` classification. The observer runs at
   `:121-130`, only after a successful durable claim and only when `claimed.infra_retries === 1`,
   and a throw is caught and logged. `trident/infra-retry.test.ts:246-270` drives three retries
   through a throwing observer and asserts exactly one attempt-1 call, four fires,
   `infra_retries === 3`, and a phase that is not failed. The zero-retry negative is now
   asserted at `trident/infra-retry.test.ts:209` (see below).
3. **`RunProgress` carries the count.** Declared at `trident/run-progress.ts:73` and emitted at
   `:247`. `trident/run-progress.test.ts:53-58` reads `infra_retries === 2`. Both client decoders
   keep it (`app/lib/work-board-client.ts:432`, `landing/chat-react/work-board-client.ts:485`).
   Remeasured: deleting the interface field made `tsc --noEmit -p trident/tsconfig.json` exit 2
   with `trident/run-progress.ts(246,5): error TS2353: Object literal may only specify known
   properties, and 'infra_retries' does not exist in type 'RunProgress'` and
   `trident/run-progress.test.ts(55,14): error TS2339`. Deleting the emitted field instead made
   `trident/run-progress.test.ts:55` fail at runtime. Both mutations were reverted with
   `git checkout`, and `git status` showed the file clean.
4. **Mid-retry never reads failed.** `trident/run-progress.ts:243-245` selects `retrying` for
   `!terminal && run.infra_retries > 0`. Pinned by `trident/run-progress.test.ts:53-58`, by
   `app/__tests__/work-board-helpers.test.ts:109-119` (tag `Retrying`, colour `build`, pulse only
   with a fresh heartbeat) and by `landing/chat-react/__tests__/work-board-tab.test.tsx:250-291`.
   Remeasured: flipping `> 0` to `< 0` at `:243` made `trident/run-progress.test.ts:56` receive
   `building`. Reverted.
5. **Exhaustion still fails terminally, naming the budget.** `trident/infrastructure-retry.ts:93-111`
   fails the run with `infrastructure failure persisted after N automatic retries (budget N) —
   not retrying again. Last measured cause: …` and `inner_verdict: 'REVIEW_NOT_RUN'`. Pinned by
   `trident/infra-retry.test.ts:215-244`.

Supporting the delivery path, though not a criterion itself: `trident/delivery.ts:1451`
`deliverInfraRetry`, pinned by `trident/delivery.test.ts:65-74` (one message carrying
`Retrying automatically (attempt 1)` and the cause, and none for a run without a chat).

### Why the one test hunk

Criterion 2 says "Assert the negative too: a run that retries zero times produces none." The
told-once test pins once-per-run behaviour, but the zero-retry case held only by construction:
the genuine-failure test asserted `infra_retries === 0` while running with no observer at all.
That test now passes a recording observer and asserts it was never called
(`trident/infra-retry.test.ts:183-188`, `:209`). The change is test-only and introduces no
gate. Positive control: a temporary unconditional observer call at the top of
`tryInfrastructureRetry` turned exactly this assertion red (`infra-retry.test.ts:209`,
alongside the told-once test). The file was then reverted.

### Checks run

- `bun test scripts/__tests__/spec-items-index.test.ts`: 38 pass, 0 fail. The index regen is a
  no-op.
- `bun test trident/infra-retry.test.ts trident/run-progress.test.ts trident/delivery.test.ts
  gateway/__tests__/trident-crash-recovery-wiring.test.ts`: 129 pass, 0 fail.
- `bun test app/__tests__/work-board-helpers.test.ts`: 64 pass, 0 fail. Run separately,
  `bun test landing/chat-react/__tests__/work-board-tab.test.tsx`: 45 pass, 0 fail.
- `bun test open/__tests__/project-build-e2e.test.ts`: 205 pass, 0 fail, 2227 assertions.
- `tsc --noEmit -p tsconfig.json` and `tsc --noEmit -p trident/tsconfig.json`: 0 errors each.
- `scripts/ci/typecheck-all.sh`: 50 of 51 tsconfigs pass. `app/tsconfig.json` fails with
  `TS2688: Cannot find type definition file for '@types'`, from the worktree's
  `app/node_modules` install shape. The identical error reproduces at the base with this diff
  stashed, and no `app/` file is in this diff.
- `scripts/ci/lint.sh` is clean, and `git diff --check` is clean.
- Full suite (`bun run test`): 1642 of 1642 declared files ran, and 16 of 18 lanes passed. The
  two red lanes fail only in `trident/project-driver-recovery-mutation.test.ts` and
  `tests/integration/github-credential-wired.open.test.ts`. Both files are red on their own at
  the base `843741e7` (without this diff), and neither touches a file in this diff.
