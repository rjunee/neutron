## 2026-09-14 — Launcher tombstones prefer better-informed reasons (#648)

### Change and evidence

The former upsert selected the last report. The shared store now ranks the existing
reason kinds: measured restart/deploy attribution (2), explicitly undetermined
cause (1), unexplained or unrecognised death (0). Ranking is encoded at
`trident/store.ts:38-41`; comparison and conditional write at
`trident/store.ts:1393-1411`. Both directions are enforced inside the same database
transaction. The initial DELETE takes the write lock before reading the current
winner (`trident/store.ts:1388`); BEGIN, rollback and commit are maintained by
`persistence/db.ts:249-273`. Enforcement does not require a dying reporter to remain
alive or coordinate with the other reporters.

Equal ranks select the lexically smaller complete reason using JavaScript string
ordering; exact duplicates decline (`trident/store.ts:1403-1404`). This tie-break
is independent of arrival order and makes no further attribution claim. The
first latch timestamp is retained on replacement (`trident/store.ts:1407-1410`).
Seven-day expiry now runs before selection (`trident/store.ts:1388-1392`), so an
expired report cannot block a new latch.

Running-row updates use the selected reason even when replacement was declined
(`trident/store.ts:1413-1420`). The existing stale-snapshot veto re-reads that
same tombstone (`trident/store.ts:2075-2085`). This does not retrospectively rewrite
all terminal run reasons: the running-row guard remains at `trident/store.ts:1418`.

### Writer ranking and arrival orders

Writers were enumerated by searching `crashRunningByLauncher` and `onChildCrash`
in trident, open, gateway and runtime; the production composition points are
`open/wiring/substrates.ts:572` and `gateway/composition/build-core-modules.ts:605`.

| Reporter | What it can establish | Rank of its reason |
|---|---|---|
| Shutdown report | Confirmed alive-and-killed observation versus undetermined cause (`runtime/adapters/claude-code/persistent/gateway-shutdown-kill.ts:1171-1179`) | 2 or 1 |
| Supervision watchdog | Durable verdict, mapped to gateway-shutdown, unknown or child-died (`runtime/adapters/claude-code/persistent/supervision.ts:559-575`) | 2, 1 or 0 |
| Pool eviction | Explicit child-died report with eviction detail (`runtime/adapters/claude-code/persistent/spawn.ts:1103-1111`) | 0; no restart attribution |
| External liveness probe | Identity-confirmed process death plus durable observation (`runtime/adapters/claude-code/persistent/supervision.ts:1143-1151`), or pid-only absence that cannot establish attribution (`runtime/adapters/claude-code/persistent/supervision.ts:1171-1176`) | 2 for established attribution, 1 for undetermined, 0 for unexplained |

A direct measured shutdown has more cause information than an absence probe.
A process-identity-backed record can recover that measurement after restart;
a pid-only observation cannot. Rank follows the resulting reason kind, not the
reporter's name: a later watchdog may carry equally good attribution. The push
sink composes the three kinds at `open/wiring/trident-child-crash-sink.ts:78-107`;
pull composes them at `trident/tick.ts:664-682`.

Shutdown delivery, watchdog retry and the external loop can arrive in either
order. Watchdog retry is explicit at
`runtime/adapters/claude-code/persistent/supervision.ts:577-582`; pull catches a
failed latch and retries on its cadence (`trident/tick.ts:688-696`). No scheduling
assumption enters the comparator.

### Outcome vocabulary and compatibility

The write joins the existing boolean claim convention: true for an accepted
write, false for a declined replacement. The exemplar's meaning was read at
`trident/store.ts:1490-1493`. False acknowledges a delivered death; it is not an
exception that should trigger a delivery retry. A structured
`launcher_crash_report_declined` event carries `disposition=no-op`, incoming rank
and retained rank (`trident/store.ts:1424-1433`). The log makes the result visible
even where an adapter consumes only promise completion.

Push continues after an awaited resolved latch (`open/wiring/trident-child-crash-sink.ts:79-88`);
pull wakes recovery after a resolved latch (`trident/tick.ts:683-687`). This is
intentional: a declined reason can still latch a newly running row with the
retained explanation. Both latch interface declarations admit the boolean
result while retaining void-compatible injected callbacks
(`open/wiring/trident-child-crash-sink.ts:42`, `trident/tick.ts:176`).

Reason kinds reuse the existing delivery classifiers, including undetermined
before deploy when markers overlap (`trident/delivery.ts:962-977`); delivery
reports undetermined as unknown with an explicit uncertainty summary and measured
attribution as deploy-restart. Unrecognised prose is lowest rank, rather than a
new owner-facing error class (`trident/store.ts:41`). Existing database rows are
classified directly, without schema conversion (`trident/store.ts:1393-1398`).

### Validation and mutation table

Tests enumerate all three unequal-rank pairs in both arrival orders, and both
orders of distinct equal-rank reasons at every rank
(`trident/launcher-crash-precedence.test.ts:44-83`). Promotion and downgrade tests
exercise the actual stale snapshot veto; the reopening fixture exercises an
existing tombstone and the selected running-row explanation
(`trident/launcher-crash-precedence.test.ts:121-132`).

Each mutation printed the landing line and patch diff before its test run, then
restored the original implementation and passed the same targeted test selection.

| Guard / final landing line | Mutation | Red | Restored green |
|---|---|---:|---:|
| Promotion, `trident/store.ts:1403` | Replace higher-rank comparison with false | 3 failed | 3 passed |
| Downgrade refusal, `trident/store.ts:1403` | Accept every unequal rank | 3 failed | 3 passed |
| Equal-rank choice, `trident/store.ts:1404` | Reverse lexical comparison | 6 failed | 6 passed |
| Equal-rank prerequisite, `trident/store.ts:1404` | Remove rank equality | 2 failed | 3 passed |
| Duplicate refusal, `trident/store.ts:1404` | Use less-than-or-equal | 6 failed | 6 passed |
| Measured rank, `trident/store.ts:40` | Return zero | 2 failed | 3 passed |
| Undetermined rank, `trident/store.ts:39` | Return zero | 1 failed | 3 passed |
| Selected row reason, `trident/store.ts:1413` | Always use incoming reason | 1 failed | 1 passed |
| Decline logging, `trident/store.ts:1424` | Log accepted instead of declined | 1 failed | 1 passed |
| Delivery classifier priority, `trident/store.ts:39-40` | Classify deploy before undetermined | 1 failed | 15 passed (full new file) |

The last mutation initially survived: measured versus quoted-undetermined still
selected the measured reason through the lexical tie-break, so that fixture could
not distinguish the rankings. Added a competing lexically preferred undetermined
report (`trident/launcher-crash-precedence.test.ts:108-113`), keeping the existing
assertions; the same mutation then failed. The two rank-erasure mutations ran
before the classifier priority alignment, when their landing lines were 39 and
40 respectively; both exact lines were printed in those runs.

### Decisions and deliberate limits

No schema change, detector rewrite, new cause taxonomy, global terminal-row
rewrite, or scheduling dependency. Information here means the filed issue's
reason-kind ordering, not a claim that every piece of process evidence is retained
in the reason string. Attribution validation remains with the producers.
No change to SPEC.md's product decisions. Acceptance is in
`docs/spec-items/launcher-crash-report-precedence.md`; its generated index was
updated. Corrected stale unconditional-write prose in the shutdown module and
its spec item; historical records remain immutable. The sweep searched
`unconditionally`, `identical sentence` and the upsert signature, with the store
upsert as a positive control.

This record uses the task-mandated staging destination. No push, PR creation or
merge is part of this build lane.

### Local check results

- `bun test trident/launcher-crash-precedence.test.ts trident/store.test.ts trident/tick-liveness.test.ts open/wiring/__tests__/trident-child-crash-sink.test.ts runtime/adapters/claude-code/persistent/__tests__/gateway-shutdown-kill.test.ts scripts/__tests__/spec-items-index.test.ts`: 296 passed, zero failed, 1049 assertions.
- `bash scripts/ci/lint.sh`: passed all reported gates.
- `bash scripts/ci/typecheck-all.sh`: all 51 configurations passed (the repository equivalent of typecheck; root package.json has no typecheck script).
- `git diff --check`: passed.
- `bash scripts/ci/leak-gate.sh --tree .`: incomplete (exit 3), zero findings from executed rules; private PII denylist checks unavailable. The configured publication gate still needs to run.

The broader prose sweep also corrected historical present-tense wording in
`runtime/adapters/claude-code/persistent/repl-registry.ts:294`,
`runtime/adapters/claude-code/persistent/__tests__/poison-eviction-live-work-guard.test.ts:1325`
and `open/wiring/__tests__/trident-child-crash-sink.test.ts:213-217`.
The eviction test file was therefore run as well, together with the updated sink
test: 18 passed and 28 failed. Its network-dependent fixtures
could not complete their handshake: `Bun.serve({port: 0})` itself fails to listen
in this build environment, while the test waits for the first message
(`runtime/adapters/claude-code/persistent/__tests__/poison-eviction-live-work-guard.test.ts:150`,
`:276`). An isolated copy of that test from HEAD reproduced the same first-case
failure (zero passed, one failed). The temporary copy was removed. No assertion,
timeout or test selection in the repository was weakened to obtain green.
