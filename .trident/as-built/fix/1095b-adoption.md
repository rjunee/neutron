## 2026-09-16 — Observable adoption rebuilt with progressing wakeups (#1095)

### Scope and decisions

Rebuilt on the supplied local main snapshot, without rebasing the previous branch.
Read commits `36cbd62a`, `f8a891f8`, and `57e41c26`; retained their runtime error
plumbing and baseline wait, and rebuilt the wakeup integration. The task requires
this staging path, overriding the standard shard location. No network was used.

An adopted session now requires a nonblank baseline within five seconds
(`runtime/adapters/claude-code/persistent/boot-adoption.ts:178`, :2638, :2837).
The publication guard at :2853 closes and clears an unobservable pane through
the existing unwind at :2485. The new wait also rechecks shutdown and child death
at :2849 and :2856. Shutdown releases ownership instead of closing the survivor.
Empty screens AFTER the baseline still reach detectors, so a prompt can fall and
rise again (:2638). Zero matching detectors alone does not prove a bad screen:
a readable quiet prompt remains adoptable. This is an observation prerequisite,
not a new worker-state classifier.

The five-second host timer and child-exit race at :2840 maintain the publication
invariant without requiring the pane to send another screen. After publication,
the existing host poll positively identifies loss
(`runtime/adapters/claude-code/persistent/herdr-host.ts:1160`); exit wiring passes
that cause at `runtime/adapters/claude-code/persistent/child-exit-wiring.ts:67`,
and session death emits the typed event at
`runtime/adapters/claude-code/persistent/repl-session.ts:501`. Pool eviction follows
synchronously in the same exit callback (`runtime/adapters/claude-code/persistent/child-exit-wiring.ts:141`, :161), before
an awaiting collector resumes and can request the replacement.

`pane_vanished` and `compose_timeout` join `SubstrateErrorClass` and its existing
`SUBSTRATE_ERROR_CODES` table (`runtime/events.ts:67`, `runtime/errors.ts:123`).
Both are retryable; genuine `aborted` remains nonretryable (`runtime/errors.ts:144`).
The collector defaults to genuine cancellation, with caller-supplied typed expiry
(`runtime/collect-tokens.ts:55`, :62). The reminder timer supplies composition
expiry (`reminders/dispatcher.ts:262`); the drain races pending output with the
abort sentinel (`runtime/substrate-text.ts:278`), independent of child output.
The drain status vocabulary remains `aborted` for watchdog termination while its
error carries the cause (`runtime/substrate-text.ts:283`). Wakeup reports all
terminal codes in `failed_by_reason`, defaults untyped errors to `unknown`, and
retains the no-progress and ceiling counters
(`gateway/proactive/work-wakeup.ts:793`, :799). Genuine cancellation is `other`
in that existing failure-kind taxonomy, not a budget-ceiling death.

### Cadence versus progress

The original turn uses `min(turn_timeout, interval * 0.8)` for INACTIVITY
(`gateway/proactive/work-wakeup.ts:559`). Its collector retains the original
absolute ceiling (:769). Progress therefore wins over cadence on this attempt:
no four-minute wall-clock cancellation was restored. Immediate recovery is
eligible only when loss arrived inside that first window (:773). One retry has
`min(turn_timeout, interval * 0.1, absolute_ceiling)` as a hard wall-clock budget
(:560, :775). On the recovery attempt, cadence wins over progress. A later loss
is reported and awaits the next sweep, rather than extending an overdue tick.
The default early recovery envelope is 240 + 30 = 270 seconds within 300 seconds.
These are per-project composition budgets, not a bound on selection, posting,
multiple projects, or event-loop scheduling. Single-flight still skips concurrent
ticks (`loop/index.ts:258`). Retry substrate timeout is classified against that
attempt's own ceiling (:799), not the original 45-minute ceiling.

The supplied #1101 citations were correct before editing (constants :120/:127,
counters :371/:373/:563/:564/:782/:783). The existing progressing-turn test remains
at `gateway/proactive/__tests__/work-wakeup.test.ts:192`; its collector-budget
mutation goes red. New cadence, late-loss, cancellation, retry-ceiling, and
second-loss cases begin at :282, :312, :326, :338, and :353.

### Mutation evidence

Every row printed the changed source line, ran the listed command, restored the
source in a finally block, then reran the same command. The table records the
final run. An initial reporting script searched for the replacement text when
printing the line and could print an earlier occurrence; this was corrected to
use the unique original match offset, and the entire matrix was rerun.

| Guard | Actual changed line | Command | Mutated red | Restored green |
| --- | --- | --- | --- | --- |
| baseline decision | `runtime/adapters/claude-code/persistent/boot-adoption.ts:2853`: `if (false) {` | `bun test runtime/adapters/claude-code/persistent/__tests__/observable-adoption.test.ts` | 2 fail, exit 1 | 8 pass, exit 0 |
| delayed baseline delivery | `runtime/adapters/claude-code/persistent/boot-adoption.ts:2651`: `baselineResolve?.(false)` | `bun test runtime/adapters/claude-code/persistent/__tests__/observable-adoption.test.ts` | 1 fail, exit 1 | 8 pass, exit 0 |
| blank baseline | `runtime/adapters/claude-code/persistent/boot-adoption.ts:2638`: `if (!claimConfirmed) return` | `bun test runtime/adapters/claude-code/persistent/__tests__/observable-adoption.test.ts` | 1 fail, exit 1 | 8 pass, exit 0 |
| post-wait shutdown | `runtime/adapters/claude-code/persistent/boot-adoption.ts:2849`: `if (false) {` | `bun test runtime/adapters/claude-code/persistent/__tests__/observable-adoption.test.ts` | 2 fail, exit 1 | 8 pass, exit 0 |
| death before publication | `runtime/adapters/claude-code/persistent/boot-adoption.ts:2856`: `if (false) return await unwind('the pane exited before publication', child)` | `bun test runtime/adapters/claude-code/persistent/__tests__/observable-adoption.test.ts` | 1 fail, exit 1 | 8 pass, exit 0 |
| exit cause wiring | `runtime/adapters/claude-code/persistent/child-exit-wiring.ts:67`: `session.onDeath()` | `bun test runtime/adapters/claude-code/persistent/__tests__/pane-vanished-outcome.test.ts` | 1 fail, exit 1 | 4 pass, exit 0 |
| pane classification | `runtime/adapters/claude-code/persistent/repl-session.ts:501`: `t.channel.push(false` | `bun test runtime/adapters/claude-code/persistent/__tests__/pane-vanished-outcome.test.ts` | 2 fail, exit 1 | 4 pass, exit 0 |
| compose expiry | `reminders/dispatcher.ts:265`: `code: 'aborted',` | `bun test reminders/__tests__/background-compose-in-flight.test.ts` | 1 fail, exit 1 | 6 pass, exit 0 |
| first cap | `gateway/proactive/work-wakeup.ts:559`: `const first_timeout = turn_timeout` | `bun test gateway/proactive/__tests__/work-wakeup.test.ts` | 1 fail, exit 1 | 57 pass, exit 0 |
| retry cap | `gateway/proactive/work-wakeup.ts:560`: `const retry_timeout = turn_timeout` | `bun test gateway/proactive/__tests__/work-wakeup.test.ts` | 2 fail, exit 1 | 57 pass, exit 0 |
| late retry gate | `gateway/proactive/work-wakeup.ts:774`: `false) throw firstErr` | `bun test gateway/proactive/__tests__/work-wakeup.test.ts` | 1 fail, exit 1 | 57 pass, exit 0 |
| pane-only retry | `gateway/proactive/work-wakeup.ts:773`: `if (!(firstErr instanceof SubstrateCallError) &#124;&#124; false &#124;&#124;` | `bun test gateway/proactive/__tests__/work-wakeup.test.ts` | 2 fail, exit 1 | 57 pass, exit 0 |
| progress ceiling #1101 | `gateway/proactive/work-wakeup.ts:769`: `reply = (await deps.llm.compose(spec, { timeout_ms: first_timeout })).trim()` | `bun test gateway/proactive/__tests__/work-wakeup.test.ts` | 5 fail, exit 1 | 57 pass, exit 0 |

### Validation and limits

`bun test gateway/proactive/__tests__/work-wakeup.test.ts runtime/__tests__/o3-substrate-error-codes.test.ts runtime/adapters/claude-code/persistent/__tests__/pane-vanished-outcome.test.ts runtime/adapters/claude-code/persistent/__tests__/observable-adoption.test.ts reminders/__tests__/background-compose-in-flight.test.ts gateway/wiring/__tests__/g6-error-string-conformance.test.ts scripts/__tests__/spec-items-index.test.ts`:
143 pass, 0 fail. The adoption unit fixture stubs HTTP startup and credential
derivation; reconciliation, registry, detectors, cleanup and publication remain
real (`runtime/adapters/claude-code/persistent/__tests__/observable-adoption.test.ts:20`).

The two socket integration files touched, `adopted-pane-latches.test.ts` and
`adopted-repl-serves-a-turn.test.ts` under the same test directory, could not bind
the reply sink during setup in this environment. They are not reported green.
No assertions were skipped or weakened to bypass that setup failure. The latter
fixture now emits its baseline after `beginOutput`, respecting the existing
claim gate. The isolated dead-child fixture initially expected a closed verdict,
but actual exit cleanup changes the durable identity before unwind; the existing
`undecided` outcome is the correct refusal. Its exact expectation was corrected,
while its no-publication assertion remains. The shutdown fixture uses the real
registered pass entrypoint so shutdown actually reaches it.

`bun run typecheck` reports Script not found. The repository matrix command is
used instead; final matrix and lint results are recorded below.

### Documentation and deliberate exclusions

Added a new dated decision at `SPEC.md:313`; older decisions remain immutable.
Acceptance is in `docs/spec-items/observable-pane-adoption.md:14`, with the rollup
regenerated by `bun run scripts/spec-items-index.ts`.

Whole-tree `rg` for `cc-llm-call: aborted|wall-clock composition|first screen is a baseline`
found the default collector producer at `runtime/collect-tokens.ts:62` as a
positive control, the historical incident comments in wakeup/reminders/open,
G6's live-agent abort classifier, and frozen history. Those historical/default
cancellation statements remain applicable; the collector doc now explicitly
states its override. The immutable earlier adoption decision stays unchanged.
No claim of a fetched remote ref is made: the task forbids network and designates
the supplied local main ref as the base.

Did not redesign scheduling, alter the original progressing-turn ceiling,
introduce flags, change worker-state classification, or run the whole suite.
No push, PR creation, or merge is part of this lane.

### Final gate follow-up

Typechecking found three test-fixture typing errors: parameterized screen arrays
were interpreted as argument lists, a fixture supplied an unsupported option,
and the exit-hook fixture omitted its required optional-valued registry field.
Named screen-case objects now deliver actual arrays. This was a meaningful
reachability correction: the empty-screen-list case previously threw in fake
output delivery before the baseline wait. The entire 13-row mutation matrix was
rerun after fixing it; baseline bypass now fails both refusal cases. The final
scoped run remains 143 pass / zero fail. No assertions were loosened.

The full typecheck matrix checked 51 configurations: 49 passed, with errors only
in runtime and root from those fixtures. Both corrected configurations are rerun
with `bunx tsc --noEmit -p runtime/tsconfig.json` and
`bunx tsc --noEmit -p tsconfig.json`; results are recorded below.

`bash scripts/ci/leak-gate.sh --tree .`: exit 3, zero findings from executed rules;
PII and commit-message denylist checks lack their private input. This remains an
incomplete result. `git diff --check` passed. The as-built contains exactly one
level-two heading. SPEC comparison before commit: four additions, zero deletions.

Final corrected typechecks both exited 0: runtime and root. The remaining 49
configurations passed in the matrix run, so all 51 configurations have passing
checks against their final inputs. `bash scripts/ci/lint.sh` exited 0.
Final scoped tests after the readonly fixture-array correction: 143 pass, 0 fail.
The socket integration setup failures and incomplete leak-gate result above remain
limitations of this handoff, not passing checks.
