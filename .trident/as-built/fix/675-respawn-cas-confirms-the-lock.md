## 2026-09-14 — Confirm the respawn claim lock (#675)

### Change and evidence

The respawn claim now uses `withOwnedRegistry` with a required refusal disposition
at `runtime/adapters/claude-code/persistent/supervision.ts:245` and
`runtime/adapters/claude-code/persistent/supervision.ts:285`. The helper tests acquisition
before invoking the mutator and skips saving on failure
(`runtime/adapters/claude-code/persistent/repl-registry.ts:1192`). The underlying lock
still executes its callback when acquisition fails
(`runtime/adapters/claude-code/persistent/registry-lock.ts:118`,
`runtime/adapters/claude-code/persistent/registry-lock.ts:177`). Previously the claim
called plain `withRegistry` and returned `go` without consuming that report; the
original issue's normal stamp citation at supervision.ts:239-262 was actually
supervision.ts:275-277 in the checked-out base (force was :256-258).

Both ordinary and forced claims share the ownership helper. A prevented write returns
`registry-write-refused` before dispatch
(`runtime/adapters/claude-code/persistent/supervision.ts:288`), while the existing
process-local gate is released in `finally`
(`runtime/adapters/claude-code/persistent/supervision.ts:349`). The helper maintains
this precondition on every attempt, including when the lock implementation reports
failure; it does not require a failing lock service to run recovery code.

### Vocabulary and decisions

The named reason joins `RespawnRefusalReason`
(`runtime/adapters/claude-code/persistent/session-respawn.ts:53`). Its existing admin
switch defaults to HTTP 500 with the reason preserved
(`runtime/adapters/claude-code/persistent/admin-respawn-session.ts:72`); the watchdog
uses `outcome.ok` to report whether it respawned
(`runtime/adapters/claude-code/persistent/supervision.ts:619`). Returning the refusal
preserves that contract rather than throwing through watchdog iteration.

The returned outcome carries an Error stamped `repl_unreconciled`
(`runtime/adapters/claude-code/persistent/supervision.ts:39`,
`runtime/adapters/claude-code/persistent/supervision.ts:291`). This existing class is
retryable (`runtime/errors.ts:144`), and the thrown-error classifier reads its stamp
before examining its wording
(`runtime/adapters/claude-code/persistent/classify-spawn-error.ts:91`). The credential
consumer reserves provider cooldowns for stamped `rate_limited` and `http_status`
(`gateway/wiring/build-llm-call-substrate.ts:1067`). This change adds no turn error
emission; the returned Error preserves the class for any caller that propagates it.

The `prevented` check also refuses an unreadable registry even when the mutator's
result says no record (`runtime/adapters/claude-code/persistent/repl-registry.ts:1209`).
The fixture uses a directory read error; malformed JSON is intentionally rebuildable
and would not exercise that branch
(`runtime/adapters/claude-code/persistent/repl-registry.ts:751`).

The misleading force comment and the helper's old six-site scope statement were
corrected. Whole-tree searches for `bypasses the in-flight/cooldown gates`,
`what is left below is the indifferent four`, and `Six writes in this subsystem`
found those source comments; `THE ENTRY POINT FOR A WRITE` was the positive control
for the final search (`runtime/adapters/claude-code/persistent/repl-registry.ts:1110`).
No product decision changed; SPEC.md remains the existing target.

### Acceptance and mutation evidence

Cases are enumerated by the two-value force loop and two standalone tests in
`runtime/adapters/claude-code/persistent/__tests__/respawn-claim.test.ts:37`,
`runtime/adapters/claude-code/persistent/__tests__/respawn-claim.test.ts:72`, and
`runtime/adapters/claude-code/persistent/__tests__/respawn-claim.test.ts:81`:

- Failed acquisition preserves populated rows field-for-field and byte-for-byte,
  makes no spawn call, and allows a subsequent successful retry.
- Successful acquisition writes the stamp, clears the forced cap, dispatches one
  resume for the existing session, and refuses a second in-flight attempt.
- The refusal keeps its class after replacing the Error message.
- An unreadable registry refuses a decision that could not be saved.

Every mutation's landing line was printed and its git diff inspected before the
run. Each restored run passed all six new tests (44 assertions).

| Guard | Mutation and landing line | Mutated result | Restored result |
| --- | --- | --- | --- |
| Lock acquisition | `runtime/adapters/claude-code/persistent/repl-registry.ts:1192`: `if (!acquired)` → `if (false)` | RED 3/6: both unheld-lock cases returned success, and the class case lost its Error | GREEN: 6/6 |
| Successful acquisition complement | `runtime/adapters/claude-code/persistent/repl-registry.ts:1192`: `if (!acquired)` → `if (true)` | RED 4/6: both held-lock cases refused, and both retry-after-failure assertions | GREEN: 6/6 |
| Error class | `runtime/adapters/claude-code/persistent/supervision.ts:39`: stamp → `rate_limited` | RED 2/6: both message-independent class assertions | GREEN: 6/6 |
| Prevented write | `runtime/adapters/claude-code/persistent/supervision.ts:288`: remove `claim.prevented` arm | RED 1/6: unreadable case returned session-not-found | GREEN: 6/6 |


### Validation and limits

The focused command ran `bun test` on six explicit files under
`runtime/adapters/claude-code/persistent/__tests__/`: `respawn-claim.test.ts`,
`session-respawn.test.ts`, `repl-registry.test.ts`, `registry-lock.test.ts`,
`classify-spawn-error.test.ts`, and `admin-respawn-session.test.ts`.
Result: 80 passed, zero failed, 255 assertions.

The new tests intercept only `getOrSpawnSession` at the final spawn boundary
(`runtime/adapters/claude-code/persistent/__tests__/respawn-claim.test.ts:32`). They
exercise the real lock, registry, planning, and dispatch paths, but do not launch
a child process or establish its channel. An initial live-host fixture could not
bind its reply socket in this environment and was replaced before delivery.
No existing tests were weakened or skipped. No whole-suite run, new feature flag,
backend change, generic registry policy change, push, PR creation, or merge was
part of this lane.

`bash scripts/ci/lint.sh` passed all checks. `git diff --check` and the
single-heading check passed. The leak gate reported zero findings from rules
that ran, but INCOMPLETE because its private PII denylist was unavailable.
The orchestrator must run the complete purity gate before publication.

`bash scripts/ci/typecheck-all.sh` passed all 51 discovered TypeScript configs,
including the root and runtime configs. This is the repository-wide typecheck
command documented in CONTRIBUTING.md.

### Review lane re-verification (2026-09-14)

Rebased onto `origin/main` at `735fa505`. All four mutations above were re-run
independently after the rebase with the landing line printed and the file diffed
before each run; the RED counts in the table are the review lane's own
measurements, which are higher than the build lane's first record for three of
the four (the build lane counted the directly-targeted cases, not every case the
mutation reds). Each restoration returned 6/6 GREEN.

Post-rebase suites: `bun test runtime/adapters/claude-code/persistent/__tests__/`
— 1553 pass, 7 skip, 0 fail across 102 files. `scripts/ci/typecheck-all.sh` — 51/51.

NOT VERIFIED HERE, and stated rather than implied: no production caller of
`respawnReplSession` reads `outcome.error`. The three callers (the wedge/crash
tick at `supervision.ts:619`, the cwd-drift tick at `supervision.ts:711`, the
model-update tick at `supervision.ts:966`) read `outcome.ok`, and the admin
endpoint reads `outcome.reason`. None is on the composer's credential-cooldown
path, so the `repl_unreconciled` stamp is forward-defence for a future
propagator; its correctness is pinned by test, not by a production consumer.
