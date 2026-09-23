## 2026-09-23 — Preserve the provider-reported model when usage is unavailable

Refs #1196. This is one slice of that issue, not its completion.

**What changed.** `AttemptAccounting.recordOutcome` in
`trident/attempt-accounting.ts` wrote the durable attempt receipt only when an
outcome carried a provider observation or a validated completion carried
usage counts. A validated completion that attested its model but reported no
counts — the shape `runtime/workers/claude-headless.ts` produces whenever the
CLI omits or malforms `usage` and no observation receipt decodes — therefore
dropped its model attribution entirely. The receipt condition now also holds
when the completion carries a non-empty `model_reported`. That receipt is
sourced `bounded-worker-metadata`, stamped with the host observation time, and
keeps the reported model while every counter (input, output, cache read, cache
creation, cost) stays `null`: explicitly unknown, never zero. The observation
branch and the usage branch are unchanged.

**Why.** The acceptance criteria in `docs/spec-items/trident-build-efficiency.md`
require every attempted call to carry its separately reported model alongside
the requested and resolved models, with unavailable metrics left unknown. The
ledger already accepts null counters and the phase projection already reports an
all-null receipt as `unknown`; only the receipt condition ignored the model.

**What did not change.** Telemetry still cannot veto or authorise a result: the
lifecycle write and the returned outcome are untouched, and a refused receipt
still only records `attempt-accounting-refused`. A duplicate or restarted
model-only completion keeps one attempt row and one receipt with no counters
added, and a prior provider-sourced receipt with measured spend for the same
call survives a later model-only completion unchanged. The requested, resolved
and reported models stay three independent fields.

**Measured.**

- `trident/attempt-accounting.test.ts`: model-only completion writes one
  receipt with the reported model and all counters null; the nothing-reported
  completion still writes none; usage-plus-model without observation keeps its
  counters; duplicate, restart, and prior measured spend are preserved.
- `runtime/workers/claude-headless.test.ts`: the invalid-usage completion
  yields `usage: null` together with the attested model.
- `open/__tests__/project-build-e2e.test.ts`: the real host merges unattended
  with every completion model-only, and every attempt row carries a
  `bounded-worker-metadata` receipt with its reported model, null counters and
  an `unknown` phase projection. The existing missing-metadata and native-usage
  tests remain the contrasting controls.
- Mutations: narrowing the condition back to `observation || completed?.usage`
  and widening it to `observation || completed` each redden
  `trident/attempt-accounting.test.ts` while `trident/attempt-ledger.test.ts`
  stays green; the narrowing also reddens the new end-to-end test.

### Review finding: measured observation after a model-only receipt

**Defect, reproduced on the first build of this entry.** After a validated
completion stored a model-only receipt (`bounded-worker-metadata`, every
counter null), a later native observation of the SAME call (for example a
`codex-cli-jsonl` receipt with 17 input, 4 output and 8 cache-read tokens,
ingested by `AttemptAccounting.reconcile`) was refused:
`TridentAttemptLedger.observe` in `trident/attempt-ledger.ts` treated the
differing source as an ownership conflict, so the call's spend stayed null and
only `attempt-accounting-refused` was recorded. A second rule sat behind it: a
provider stamps its observation at call finish, while the host stamps the
metadata receipt after the call returned, so the native observation is always
OLDER and the stale rule would have dropped it silently even with the source
check relaxed. The positive control was the same observation for a call whose
completion reported no model: with no metadata receipt it was ingested.

**Rule.** A receipt whose five counters (input, output, cache read, cache
creation, cost) are all null is attribution only. When the incoming receipt
has the same `receipt_id` and carries at least one measured counter, it
supersedes that receipt whatever its source and whatever its observation time:
measured spend replaces unknown. The reported-model conflict check and the
cumulative-regression check still apply on that path.

**What did not change.** Call ownership is still bound by `receipt_id`: a
measurement for a different call is refused. A measured receipt is never
replaced by an attribution-only one (a different source is an ownership
conflict; the same source is a regression), and between measured receipts the
source check and the newer/stale rules are unchanged. An observation reporting
a genuinely different model over a model-only receipt is still refused, the
metadata receipt is retained, and `attempt-accounting-refused` is recorded.

**Measured.**

- `trident/attempt-ledger.test.ts`: an attribution-only receipt is superseded
  by an older, differently sourced measured receipt for the same call and the
  stored row equals it exactly; a different `receipt_id` and a different model
  are refused with the row unchanged; an attribution-only receipt over a
  measured one is refused both ways; a reopened host replays the measured
  receipt as stale with an identical projection.
- `trident/attempt-accounting.test.ts`: a model-only completion followed by
  `reconcile` with the native observation ends with the measured receipt
  (source, counters and the reported model) and a summed phase projection,
  matching a sibling call that never had a metadata receipt; replay and a host
  restart add nothing; a different reported model is still refused.
- Mutations of `trident/attempt-ledger.ts`: restoring the unconditional
  source-ownership refusal, and applying the stale rule before the
  attribution-only bypass, each redden both tests above while
  `trident/phase-usage.test.ts` stays green.

The remaining gaps tracked by #1196 (including production in-REPL metadata
and the other acceptance items) are unchanged by this entry.
