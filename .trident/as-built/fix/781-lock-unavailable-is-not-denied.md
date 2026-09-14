## 2026-09-14 — Missing flock FFI does not refuse Claude trust seeding (#781)

### Change and decision

The trust seed refuses only an unacquired lock on an FFI-capable process
(`runtime/adapters/claude-code/persistent/ensure-claude-trust.ts:106`). Missing FFI
warns once per process and continues the existing read/merge/atomic-rename seed
(`runtime/adapters/claude-code/persistent/ensure-claude-trust.ts:78`,
`runtime/adapters/claude-code/persistent/ensure-claude-trust.ts:101`,
`runtime/adapters/claude-code/persistent/ensure-claude-trust.ts:109`).

Choose possible concurrent lost trust updates over refusing every launch. The cost
is explicit in the code: absence of serialization is degraded service, not proof
of a denied lock. The seed's former blanket refusal was wrong for missing FFI.
The sink's warn-and-proceed ruling is appropriate for this state, as read at
`runtime/adapters/claude-code/persistent/sink-coordinates.ts:737`. Its denied-lock
policy remains different: this change preserves the trust seed's refusal to write
a shared config after an actual failed acquisition. The sink independently reports
its weaker replacement guarantee (`runtime/adapters/claude-code/persistent/sink-coordinates.ts:741`).

The existing test seam accepts null to force missing FFI, including after native
library initialization (`runtime/adapters/claude-code/persistent/registry-lock.ts:47`,
`runtime/adapters/claude-code/persistent/registry-lock.ts:52`). Undefined restores
native loading. Capability and acquisition remain distinct facts; the helper's
boolean callback contract remains at `runtime/adapters/claude-code/persistent/registry-lock.ts:114`.

### Outcome vocabulary and continuous enforcement

The degraded outcome joins the existing successful string return, the config-file
path (`runtime/adapters/claude-code/persistent/ensure-claude-trust.ts:104`), plus a
stderr warning. It introduces no new error classification. Denial retains
`SpawnConfigurationError.substrateErrorClass = spawn_configuration`
(`runtime/adapters/claude-code/persistent/spawn-configuration-error.ts:5`). The
classifier validates that stamp (`runtime/adapters/claude-code/persistent/classify-spawn-error.ts:99`),
and the taxonomy defaults it to non-retryable (`runtime/errors.ts:106`).

Consumer enumeration: whole-tree `rg -n 'ensureClaudeTrust|classifyThrownSpawnError'
--glob '*.ts' --glob '!**/*.test.ts' --glob '!**/__tests__/**'` found the seed's
production caller at `runtime/adapters/claude-code/persistent/spawn.ts:332`; it
ignores the returned path and continues spawn. The two classifier consumers are
`runtime/adapters/claude-code/persistent/pool.ts:455` and
`runtime/adapters/claude-code/persistent/pool.ts:636`. Both emit the classified
code's retryability and close the channel; unclassified errors default to retryable
at lines 456 and 637 respectively. Missing FFI now avoids that error path entirely.

The check runs before each seed body, via the helper callback
(`runtime/adapters/claude-code/persistent/registry-lock.ts:119`,
`runtime/adapters/claude-code/persistent/registry-lock.ts:178`). On capable hosts,
the stable sidecar inode and kernel flock maintain serialization; the kernel
releases locks on process death (`runtime/adapters/claude-code/persistent/registry-lock.ts:15`).
No process cooperation after a crash is required. Serialization is explicitly not
promised when FFI is unavailable.

### Tests and mutation evidence

The modified test file is
`runtime/adapters/claude-code/persistent/__tests__/ensure-claude-trust.test.ts`.
Its four test declarations are at lines 23, 34, 58 and 78, enumerated with
`rg -n "^test\("`. The denial fixture contains 19,531 existing entries and requires
byte preservation. Missing-FFI and normal acquisition assert actual new project
trust and preserved config; missing FFI seeds twice and warns once. The existing
cross-process test still requires both project entries to survive.

Each mutation printed its actual changed source line before running the relevant
test. Every row went RED, then the source was restored; the restored file passed
all 4 tests with 33 assertions.

| Guard / landing line | Mutation | RED evidence | Restored |
| --- | --- | --- | --- |
| Trust capability split, ensure-claude-trust.ts:106 | Replace condition with `!acquired` | Missing-FFI test throws configuration error | GREEN |
| Denial refusal, ensure-claude-trust.ts:106 | Replace condition with `acquired && flockAvailable()` | Denial classification becomes undefined | GREEN |
| Acquired success, ensure-claude-trust.ts:106 | Replace condition with `flockAvailable()` | Normal acquisition throws | GREEN |
| Warning emission, ensure-claude-trust.ts:112 | Replace condition with `acquired && !warnedUnavailable` | Expected one warning, received zero | GREEN |
| Warn once, ensure-claude-trust.ts:112 | Replace condition with `!acquired` | Expected one warning, received two | GREEN |
| Missing-FFI test seam, registry-lock.ts:52 | Return cached `_lib` instead of null | Expected capability false, received true | GREEN |

The last mutation ran the whole trust file so the preceding denial control had
initialized native FFI; this makes the cached-handle mutation reachable.

### Validation and scope

- Modified trust test file: 4 passed, 33 assertions.
- Adjacent registry-lock.test.ts: 6 passed, 9 assertions.
- Repository lint (`bash scripts/ci/lint.sh`): passed.
- Repository typecheck (`bash scripts/ci/typecheck-all.sh`): all 51 configurations passed.
- Focused sink test `-t 'a NONZERO flock reports'`: passed (1 test, 3 assertions);
  this exercises the unchanged sibling contract without socket fixtures.
- Leak gate: exit 3, INCOMPLETE; zero findings in rules that ran, but local PII
  denylist rules for files and commit messages could not run.
- `git diff --check`: passed. Staged as-built heading count: exactly one.
- Full adjacent sink-restart-survival.test.ts plus registry-lock.test.ts run:
  40 passed, 19 failed. Socket fixtures failed in this restricted environment
  (`runtime/adapters/claude-code/persistent/__tests__/sink-restart-survival.test.ts:74`,
  `runtime/adapters/claude-code/persistent/__tests__/sink-restart-survival.test.ts:414`).
  An independent Python socket creation probe returned PermissionError, errno 1.
  No test assertions were weakened or skipped.

The corrected blanket serialization comment was searched across the working tree
with `rg -n 'Every Neutron seed reads and writes under this lock|cannot acquire Claude trust config lock' .`.
Only the positive-control error text matched, at
`runtime/adapters/claude-code/persistent/ensure-claude-trust.ts:107`.

Deliberately did not change the sink policy, generic helper outcome contract,
error taxonomy, or add a deployment requirement for FFI. This is the degradation
choice authorized in the filed brief, not a new product architecture decision;
SPEC.md and spec items are unchanged. The staged record location follows the
explicit build-lane instruction. No push, PR creation, or merge is part of this lane.
