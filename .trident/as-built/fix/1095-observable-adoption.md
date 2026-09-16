## #1095 CI fixture follow-up

### Changes and decisions

This follow-up preserves the existing implementation and repairs three test files.
The file list was enumerated with `git diff --name-only HEAD` before adding this record.

- G6 extracts the default abort literal after the caller override at
  `gateway/wiring/__tests__/g6-error-string-conformance.test.ts:409`, matching
  `runtime/collect-tokens.ts:61`. Both classification assertions remain at :412-413.
- The reminder timeout test requires the exact `compose_timeout` code and message at
  `reminders/__tests__/background-compose-in-flight.test.ts:115`, then checks release
  at :119. This implements the deliberate distinction in `SPEC.md:315` and the
  existing producer at `reminders/dispatcher.ts:264`; the obsolete abort expectation
  was a test defect, not a reason to undo that decision.
- The surviving-child fixture delivers its prompt from `beginOutput` at
  `runtime/adapters/claude-code/persistent/__tests__/adopted-repl-serves-a-turn.test.ts:224`.
  Its old attach-time screen arrived before the ownership guard at
  `runtime/adapters/claude-code/persistent/boot-adoption.ts:2638`; the bounded baseline
  wait at :2837-2848 therefore had nothing to observe. The existing fixture convention
  was checked at `runtime/adapters/claude-code/persistent/__tests__/boot-adoption-host.ts:222`:
  it also emits screens only when output begins. The original answer, identity and
  zero-spawn assertions remain at `adopted-repl-serves-a-turn.test.ts:340` and :362.

No new production outcome or guard is introduced. The counter remains maintained
by the producer's finally block (`reminders/dispatcher.ts:268`). No product decision
changed in this follow-up. The task-specific staging location overrides the usual
as-built location for this record.

### Reproduction and mutation evidence

Each listed test file was run separately with `bun test`; no directory sweep ran.
G6 reproduced 15 pass / 1 fail and now passes 16 / 0. The reminder file reproduced
5 / 1 and now passes 6 / 0. Every mutation below printed its actual source line,
ran, and was restored immediately.

| Property | Mutation and location | Mutated result | Restored result |
| --- | --- | --- | --- |
| Producer extraction | Change default abort literal to cancelled, `runtime/collect-tokens.ts:61` | G6 15 / 1 | 16 / 0 |
| Abort classification | Remove aborted arm, `gateway/wiring/build-live-agent-turn.ts:2338` | G6 15 / 1; expected true, received false | 16 / 0 |
| Typed timeout | Change code to aborted, `reminders/dispatcher.ts:265` | Reminder 5 / 1 | 6 / 0 |
| Counter release | Remove decrement, `reminders/dispatcher.ts:273` | Reminder 2 / 4; expected idle, received busy | 6 / 0 |

An initial counter mutation changed `<= 0` to `< 0` at :274 and stayed green.
That mutation could not falsify the public predicate: the else arm stored zero,
and the predicate tests greater than zero (`reminders/dispatcher.ts:237`). The
missing-decrement mutation above exercises an actual wrong answer instead.

### Citation corrections and search scope

The filed selection citation still resolves to
`gateway/proactive/work-wakeup-selection.ts:106`. Its dispatcher :197-212 citation
still describes the gate; executable release is at `reminders/dispatcher.ts:273`.
No other numeric filed citation was relied on. The outdated G6 direct-literal
extractor now follows the override at `runtime/collect-tokens.ts:61`.

A whole-tree content search for `RELEASED ON THE ABORT PATH`, the G6 phrase
`policy flag that`, and the positive control `Deliver the baseline` found the
updated G6 comment and fixture comment. Historical incident prose was not rewritten.
A local `git grep` against origin/main found the old direct abort literal at
`runtime/collect-tokens.ts:60`. That ref was not fetched: this lane forbids network
access, so no claim is made about remote freshness.

### Verification limits and deliberately omitted work

The adoption file could not run its three cases locally: its beforeAll sink bind
failed both before and after the fixture repair. An independent `Bun.serve` with
port zero also failed to listen. Thus the reported CI timeouts, restored adoption
success, and adoption-fixture mutation remain unverified in this environment.
No substitute test was used to claim those cases passed. A socket-capable runner
must run `runtime/adapters/claude-code/persistent/__tests__/adopted-repl-serves-a-turn.test.ts`.

No live process or pane experiment, full suite, network operation, push, PR creation,
or merge was performed. No production fix was rebuilt and no existing history was
rewritten. The G6 extractor-only update preserves the characterized behavior;
external synthesis sign-off was not available and is left to the orchestrator.

### Local gates

`bash scripts/ci/lint.sh` passed (exit 0). `git diff --check` passed.
The record has exactly one level-two heading.
`bash scripts/ci/leak-gate.sh --tree .` returned exit 3: zero findings from
executed rules, but the private PII denylist and message denylist checks could not
run because their input was unavailable. This is an incomplete result, not a pass.

`bash scripts/ci/typecheck-all.sh` passed: all 51 project configurations.
This is the repository CI typecheck command (`.github/workflows/ci.yml:265`).
