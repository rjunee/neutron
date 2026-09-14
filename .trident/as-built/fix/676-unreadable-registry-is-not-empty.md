## 2026-09-14 — Unreadable registry refuses a resume decision (#676)

### Change and decision

The resume resolver reads `readRegistryState`, preserving genuine file and row
absence as permission to start fresh, and refusing unreadable bytes or an invalid
target row (`runtime/adapters/claude-code/persistent/spawn.ts:929`). It retains
record normalization (`runtime/adapters/claude-code/persistent/spawn.ts:937`).
The caller resolves this directive before spawning
(`runtime/adapters/claude-code/persistent/spawn.ts:1499`).

Choose a retryable turn refusal over inline retries: transient failures can recover
on the next request, while repeated reads cannot repair malformed JSON and would
delay telling the owner. The error names the read/parse failure and asks for a retry
(`runtime/adapters/claude-code/persistent/spawn.ts:910`). Every registry-based
resume decision rechecks the file; maintaining this protection does not depend on
a watchdog, a successful registry write, or the failing storage system recovering
(`runtime/adapters/claude-code/persistent/spawn.ts:929`).

The error joins `repl_unreconciled`, stamped on the thrown error
(`runtime/adapters/claude-code/persistent/spawn.ts:907`). That existing taxonomy
makes it retryable (`runtime/errors.ts:144`); the turn driver sends its message and
code to the consumer (`runtime/adapters/claude-code/persistent/pool.ts:454`). The
credential ladder exempts other stamped classes from cooldown
(`gateway/wiring/build-llm-call-substrate.ts:1081`). The default for an unstamped
retryable failure is a synthetic 429
(`gateway/wiring/build-llm-call-substrate.ts:1582`), so classification is independently pinned.
The taxonomy description now includes registry continuity failures
(`runtime/errors.ts:147`). Searching `TWO CAUSES` across markdown and TypeScript
found the old description and an unrelated adoption comment about opposite acts;
the latter remains because it describes a separate pair of causes.

### Acceptance and audit

| Decision | Refusal | Honest complement | Evidence |
| --- | --- | --- | --- |
| Registry-derived resume | Malformed JSON, EISDIR, invalid target row refuse | ENOENT and missing row return the fresh directive; valid row preserves its session ID | `runtime/adapters/claude-code/persistent/__tests__/registry-resume.test.ts:10` |
| Owner-facing outcome after boot reconciliation | Typed retryable error and zero spawns | Fresh spawn and completion | `runtime/adapters/claude-code/persistent/__tests__/repl-supervision.test.ts:1342` |

The direct test cases are enumerated by the six-value fixture list at
`runtime/adapters/claude-code/persistent/__tests__/registry-resume.test.ts:10`.
The integration fixture first settles the real adoption gate, then changes the
file, ensuring that an earlier refusal cannot hide the resume guard
(`runtime/adapters/claude-code/persistent/__tests__/repl-supervision.test.ts:1352`).
Repair restores a resumable row in the direct tests
(`runtime/adapters/claude-code/persistent/__tests__/registry-resume.test.ts:35`).

### Mutation evidence

Each mutation printed its landing line and unified diff before running the direct
test file. Every restore reran all six tests successfully.

| Guard / landing line in spawn.ts | Mutation | Red | Restored |
| --- | --- | --- | --- |
| Unreadable, 932 | Throw replaced by `return undefined` | 2 failures | 6 pass |
| Absent file, 930 | Fresh return replaced by refusal | 1 failure | 6 pass |
| Missing row, 938 | Fresh return replaced by refusal | 1 failure | 6 pass |
| Invalid target row, 935 | Throw replaced by `return undefined` | 1 failure | 6 pass |
| Classification, 907 | Stamp replaced by `undefined` | 3 failures | 6 pass |

Re-run independently by the review lane against both files
(`registry-resume.test.ts` + `repl-supervision.test.ts`, baseline 43 pass / 0 fail),
each with its landing line printed and the file diff shown before the run, and each
anchored on a pattern asserted to match exactly one site:

| Guard | Mutation | Mutated | Restored |
|---|---|---|---|
| THE COMPLEMENT — a true absence must STILL start fresh (`spawn.ts:930`) | `return undefined` -> `throw RegistryResumeRefusedError` | **30 fail** | 0 fail |
| the unreadable refusal, i.e. the original defect restored (`spawn.ts:931`) | `throw` -> `return undefined` | 4 fail | 0 fail |
| a schema-dropped row is not an absence (`spawn.ts:934`) | short-circuit the `droppedKeys` check | 2 fail | 0 fail |
| the class is STAMPED, not inferred (`spawn.ts:906`) | delete `substrateErrorClass` from the error | 6 fail | 0 fail |
| the two unreadable reasons stay distinguishable (`spawn.ts:932`) | `state.reason` -> a constant | 4 fail | 0 fail |

The first row is the one that matters most, and it is the defect this kind of fix
usually ships: a resolver that refused BOTH unknown and absent would have broken
first-run for everything, and it costs 30 failures the moment it is tried.

THE STAMP IS LOAD-BEARING, MEASURED RATHER THAN ASSUMED. With the stamp removed,
`classifyThrownSpawnError` falls back to the message matcher and returns
`undefined` — confirmed directly against the refusal's exact text, because
`classifySpawnError` requires `refusing to (resume|serve) session` and this message
says `registry unreadable`. An unstamped retryable error is what
`mapStatusForPoolCooldown(null, true)` turns into a synthetic 429 and a credential
cooldown, so without the stamp a local file-read failure would spend the owner's
provider capacity. That is why the class is carried on the error object and pinned
by a test, rather than left to wording that drifts.

### Validation

- Direct resolver and existing spawn-classifier tests: 19 pass, 0 fail.
- Full touched `repl-supervision.test.ts`: **37 pass, 0 fail** (32 pre-existing
  cases plus the 5 this change adds). CORRECTION, and the correction is the point:
  the build lane recorded `5 pass, 32 fail` and attributed it to a sandbox that
  could not bind loopback sockets. That does not reproduce — the review lane ran
  the same file on the same commit and it is fully green. The integration
  acceptance the lane reported as BLOCKED is therefore met, and the lane's own
  environment, not the change, was the limitation.
- Repository lint (`bash scripts/ci/lint.sh`): passed all nine checks.
- Leak gate: zero findings from available rules, INCOMPLETE because the private
  PII denylist and message denylist are unavailable.
- Full repository typecheck (`bash scripts/ci/typecheck-all.sh`): all 51 configs pass.

### Scope and delivery

The filed citations moved: the old resolver was at `spawn.ts:913`, `getRecord` at
`repl-registry.ts:784`, and the collapsing loader at `repl-registry.ts:708` (paths
under `runtime/adapters/claude-code/persistent/`). This change leaves the loader's
other consumers, explicit resume overrides, transcript storage, and recovery
scheduling alone. It does not introduce a flag or an alternate implementation.
No product decision changes: this enforces the requested continuity contract.

The build-lane instruction requests this staging path; the permanent audit shard
links here. No historical as-built shard is edited. Commit locally only; the
orchestrator owns publication and merge.
