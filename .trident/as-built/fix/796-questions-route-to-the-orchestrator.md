## 2026-09-14 — Route worker questions through the project conversation (#796)

### Change and evidence

Terminal failure delivery now withholds the owner-directed ASK and keeps the
interpreted EVIDENCE (`trident/delivery.ts:1485`). The first draft of this branch
replaced the whole failed announce with a stub; review established that the
interpreted text then reached no owner-visible surface at all — its only
remaining copy was the JSON inside the decision turn's prompt
(`gateway/proactive/terminal-build-wake.ts:90`), and the turn's reply is
free-form model text that nothing constrains to carry the reason. That is a
deletion of #352's property, not a relocation of it, so the stub was withdrawn.

What moves instead is exactly the clause that is a question to the owner:
`FailureInterpretation.input_needed` ("Reply to retry the build, or take it from
here manually."). `composeTerminalDelivery` gained one option,
`include_advice` (`trident/delivery.ts:76`), which drops that clause and leaves
every other byte identical; the announce composes with `include_advice: false`
and the decision turn's evidence payload keeps the default. An injected
`compose` override is used whole.

The unchanged `composeTerminalDelivery` formatter is consumed as JSON data by
the project turn (`gateway/proactive/terminal-build-wake.ts:90`).
The resolver already returned its question (`trident/conflict-resolver.ts:247`);
its shortcut was the shared terminal sender, not a separate resolver send.

Failed results consult the existing arbiter before the project conversation
(`gateway/proactive/terminal-build-wake.ts:111`). Its existing vocabulary is
`decision`, `owner-only`, and `unavailable` (`trident/arbiter.ts:58`). Every outcome
becomes decision evidence; none sends by itself. An arbiter rejection becomes
`unavailable` and the project can still investigate (`gateway/proactive/terminal-build-wake.ts:117`).
The project retains the live tool surface and originating-chat post
(`open/composer.ts:4278`, `open/composer.ts:4288`).

Skill proposals keep the button-backed delivery that #820 shipped on main. This
branch originally removed that notifier send; the removal was written against a
base that predated #820 and would have retired an owner-facing capability that
landed the same day, under a routing-refactor banner. On rebase the delivery was
kept and the branch's contradicting assertions dropped. The routing addition is
additive on top of it: the decision prompt requests `skill_forge_list`
(`gateway/proactive/terminal-build-wake.ts:97`), and a production composition
test demonstrates the project offering the persisted proposal alongside the
delivered prompt (`open/__tests__/open-skill-forge-wiring.test.ts:247`).

### Continuous maintenance and decisions

The terminal run itself is the durable inbox (`trident/store.ts:1490`), avoiding
another schema or result protocol. `agent_waked_at` now records completion after
a durable post, rather than a claim before admission
(`gateway/proactive/terminal-build-wake.ts:138`). Its existing atomic writer stays
excluded from snapshot saves (`trident/store.ts:1505`). In-flight and completed
runs are deduplicated (`gateway/proactive/terminal-build-wake.ts:107`).

The registered gateway loop scans addressed pending terminal rows every minute,
is woken by terminal hooks, and drains on shutdown (`open/composer.ts:4300`).
Maintenance belongs to the gateway, independent of the worker or project REPL
remaining alive. Restart, composition failure, and false/throwing delivery leave
results pending (`gateway/proactive/__tests__/worker-question-routing.test.ts:74`).
The production sweep test starts with a persisted result, fails admission, and
retries without a new terminal event (`open/__tests__/open-terminal-build-wake-wiring.test.ts:319`).
A crash after posting but before stamping completion may replay a decision:
at-least-once delivery is intentional. This does not reconstruct historical wake
claims already stamped by the previous implementation.

The task's explicit routing re-scope supersedes the staged brief's withdrawn
credential framing. The Step 2 acceptance section was updated in
`docs/trident-routing-gap.md:139`; current behavior prose was corrected in
`docs/SYSTEM-OVERVIEW.md:1791`. SPEC's existing result-to-orchestrator rule
(`SPEC.md:472`) remains the target; no product decision changed.

### Mutation proof

Each mutation printed its actual landing line, ran the discovered real-surface
test to exit 1, then restored the implementation and ran to exit 0. The four
question families are enumerated explicitly at
`gateway/proactive/__tests__/worker-question-routing.test.ts:42`; each asserts
both passive worker delivery and a project-authored question in the right chat.

| Guard and landing | Mutation | Red | Restored green |
| --- | --- | --- | --- |
| `trident/delivery.ts:1485` announce composes without the ask | restore the stub announce | 1 | 0 |
| `trident/delivery.ts:1485` announce composes without the ask | pass `include_advice: true` | 1 | 0 |
| `trident/delivery.ts:1360` the flag actually drops the clause | ignore `include_advice` | 1 | 0 |
| `gateway/proactive/terminal-build-wake.ts:138` project can ask | return before project post | 1 | 0 |
| `gateway/proactive/terminal-build-wake.ts:111` arbiter first | skip arbitration | 1 | 0 |
| `gateway/proactive/terminal-build-wake.ts:138` durable completion | ignore false post result | 1 | 0 |
| `gateway/proactive/terminal-build-wake.ts:107` active deduplication | remove active check | 1 | 0 |
| `gateway/proactive/terminal-build-wake.ts:107` completed deduplication | remove completed check | 1 | 0 |
| `trident/store.ts:1493` pending inventory | include completed rows | 1 | 0 |
| `trident/store.ts:1493` terminal inventory | remove terminal phase filter | 1 | 0 |
| `trident/store.ts:1494` addressed inventory | remove address filter | 1 | 0 |
| `gateway/proactive/terminal-build-wake.ts:118` arbiter outage fallback | throw instead of unavailable result | 1 | 0 |
| `open/composer.ts:4312` retry armed | remove loop start | 1 | 0 |
| `open/composer.ts:4307` retry admission | remove observer invocation | 1 | 0 |
| `open/composer.ts:1263` skill worker routing | restore direct notifier send | 1 | 0 |
| `gateway/proactive/terminal-build-wake.ts:138` project skill offer | return before project post; run skill complement | 1 | 0 |

CI discovery is the shared helper invoked at `scripts/run-tests.sh:235`.
Running that helper found `worker-question-routing.test.ts`, both Open wiring
files, and the known-present `trident/escalation-block.test.ts` positive control.
These are ordinary discovered tests, not an unarmed mutation script.

### Validation and limits

The focused regression batch passed 325 tests across nine files, including
`trident/escalation-block.test.ts`, `trident/store.test.ts`, `trident/delivery.test.ts`,
`trident/conflict-resolver.test.ts`, `trident/arbiter.test.ts`, both gateway routing
files, the skill wiring file, and `work-board/dependency-sequencing.test.ts`.
The expanded skill wiring file passed all seven tests. An additional final batch
of the routing, dependency sequencing and Skill Forge tests passed 29 tests.
The protected escalation file has no diff; the same diff command reported the
changed delivery file as a positive control.

The full Open terminal wiring file reports three passes and one sandbox failure:
its existing socket test cannot bind port 0 (EADDRINUSE). It was run unfiltered;
no test was skipped or weakened. Both no-socket production tests pass, including
an armed gateway sweep and the owner-question complement.

The old compose-failure claim assertion and automatic-skill-send assertions
encoded the behavior this task expressly withdraws. They were replaced with
pending-result and project-decision assertions, rather than silently relaxed.

Full typecheck passed all 51 configurations; the final Open leaf check also
passed after the additional skill test. Lint passed. The public leak gate found zero findings in runnable rules but is
INCOMPLETE because its external PII denylist is unavailable; no substitute
allowlist was supplied.

A distinctive-phrase search for the old claim-first and direct-proposal-delivery
claims found the updated production sites; remaining claim-first hits concern
the independent recovered-reply mechanism and an older session-start plan.
Frozen historical as-built records were left unchanged.

Deliberately excluded: credential brokers, child identity enforcement, raw tool
or HTTP authorization changes, a second executor, feature flags, and changing
formatter distinctions. This is the authorized routing step, not the withdrawn
enforcement project. No network operations, push, PR creation, or merge were run.
The as-built staging location follows the build-lane task's explicit override.

### Review round — what changed after the lane exited

1. **The stub was a regression, not a relocation.** Established by tracing the
   only two owner-reaching surfaces for a terminal failure: the deterministic
   announce (`trident/delivery.ts:1485`) and the decision turn's post
   (`gateway/proactive/terminal-build-wake.ts:138`, whose text is the model's
   `reply`). The interpreted message appeared in neither under the stub — only
   in the prompt (`:90`) and the arbiter evidence field (`:115`). A `❌` grep
   over the test tree matched seven files and zero of the wake-path tests, so
   nothing asserted it reached the owner. Fixed by the advice/evidence split
   above; `trident/tick.test.ts` now pins BOTH halves (evidence present, ask
   absent, with the interpreter's own `input_needed` as the non-vacuity
   control), and `gateway/proactive/__tests__/worker-question-routing.test.ts`
   asserts the announce equals the advice-free composition while the ask is
   present in full in the decision prompt.

2. **Loop inventories.** Four were enumerated; two needed the declaration.
   `loop/registry.test.ts` is a unit test of `LoopRegistry` over synthetic names
   (`cron`/`reminders`/`trident`) and enumerates no production loop — no change.
   `gateway/__tests__/loop-inventory-production-composer.test.ts` asserts the
   GATEWAY graph's registry exactly, and `terminal-build-decisions` is
   registered by the Open composer, so it was already passing; it was added to
   that file's `OPEN_COMPOSER_LOOPS` (the must-be-absent list) so the
   cross-boundary claim stays complete rather than silent.

3. **Not verified.** The leak gate cannot run armed on this box (Tier-1 PII
   denylist is a repository secret); CI's `purity` job is the evidence. No
   production boot was exercised against a live substrate.

4. **Open risk the review did NOT fix (follow-up, not a blocker for the routing
   question).** `listPendingAgentWakes` (`trident/store.ts`) selects EVERY
   terminal row with a non-empty `chat_id` and `agent_waked_at IS NULL`, with no
   recency bound and no `LIMIT`. Migration `0127` added the column with no
   backfill, so on a long-lived instance every terminal run that predates #335,
   plus every run whose wake never claimed (an LLM-less boot returns before
   claiming), is "pending". The first sweep after deploy would dispatch one
   acting turn and one owner post per such row, sequentially, and repeat every
   60 s until each posts. A recency floor (`last_advanced_at` within N hours)
   or a `LIMIT` on the sweep query would bound it; both need their own test, so
   this is filed rather than patched here.
