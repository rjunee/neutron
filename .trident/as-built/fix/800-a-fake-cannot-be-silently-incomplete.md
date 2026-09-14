## 2026-09-14 — Require complete hosts when constructing merge orchestration

### Change and decision

Issue #800. Selected the structural direction: `DiffOutputHost` requires an explicit
`writesDiffOutput` capability (`trident/git-mode.ts:1234`). The shared fake factory
supplies that capability and the output-file behavior together
(`trident/testing/diff-output-host.ts:9`). `spawnCapture` and both credentialed
factories declare it over their real process implementation
(`trident/git-mode.ts:1236`, `trident/git-mode.ts:1265`, `trident/git-mode.ts:1295`).

Merge dependency construction and orchestrator construction reject a bare callback
synchronously, before executing commands; the orchestrator checks even when custom
merge dependencies are provided (`trident/merge.ts:1864`,
`trident/orchestrator.ts:2348`, `trident/testing/diff-output-host.test.ts:26`). The
composition input carries the same required type
(`gateway/composition/input/misc-input.ts:86`). Existing fake construction sites
use the shared factory, including overrides applied by spread
(`trident/crash-recovery.test.ts:86`).

Moving measurement to another dependency was rejected because the existing file
measurement already avoids capturing the patch. Requiring its capability at
construction repairs the seam without replacing the evidence path. This is an
explicit structural contract, not proof that arbitrary injected code tells the
truth: the deliberate broken-capability fixture still refuses missing evidence
with `measured_bytes: null` (`trident/merge.test.ts:129`).

### Vocabulary and continuous enforcement

The new refusal is a built-in `TypeError` for invalid dependency construction
(`trident/git-mode.ts:1243`). It propagates synchronously to the constructor caller,
before a run exists, rather than entering the run-failure vocabulary
(`trident/orchestrator.ts:2348`). Existing merge outcomes retain their classification:
measured oversized holds use the authored refusal; unknown measurement falls into
merge mechanics (`trident/orchestrator.ts:5369`, `trident/orchestrator.ts:5388`).

Type checking rejects incomplete typed hosts. The runtime constructor checks cover
JavaScript callers and casts. Neither mechanism waits for the fake to execute.
Actual evidence remains checked on every merge independently of the capability
claim: unsuccessful commands or absent files fail closed, and only a real file's
size becomes a measurement (`trident/merge.ts:237`, `trident/merge.ts:244`).

### Validation and mutation evidence

The new suite checks synchronous refusal, zero commands before refusal, successful
factory construction, UTF-8 byte counts, measured zero, preserved binary evidence,
and real git output across all three production factories
(`trident/testing/diff-output-host.test.ts:26`, `:52`, `:72`, `:80`). Existing tests
retain the exact 1,048,576 / 1,048,577 boundary and null refusal
(`trident/merge.test.ts:103`, `:112`, `:129`).

An initial raw-byte test was wrong: `spawnCapture` trims its returned stdout
(`trident/git-mode.ts:1223`). The test now captures raw git stdout and keeps the
exact equality assertion (`trident/testing/diff-output-host.test.ts:94`). Failed
git commands creating empty output files remain covered (`:103`).

Every mutation below printed the changed source line, failed, and was restored.
The runtime mutations ran the new seven-test suite; the type mutation ran the
trident TypeScript configuration and explicitly required unused expected-error
diagnostics at both construction assertions.

| Guard or contract | Mutation | Mutated | Restored |
|---|---|---|---|
| Capability predicate, `trident/git-mode.ts:1242` | Replace condition with `false` | RED | GREEN |
| Merge constructor, `trident/merge.ts:1864` | Remove assertion | RED | GREEN |
| Orchestrator constructor, `trident/orchestrator.ts:2348` | Remove assertion, fixture uses custom merge deps | RED | GREEN |
| Fake writes output, `trident/testing/diff-output-host.ts:17` | Disable write | RED | GREEN |
| Preserve explicit binary file, `trident/testing/diff-output-host.ts:17` | Unconditionally overwrite | RED | GREEN |
| Fake factory capability, `trident/testing/diff-output-host.ts:21` | Return `false` capability | RED | GREEN |
| Structural type, `trident/git-mode.ts:1234` | Remove capability intersection | RED: both expected-error directives unused | GREEN |

Final validation: 954 tests pass across 29 unique focused files; the initial five
crash-recovery failures pass after repairing the spread override. All 51
TypeScript configurations pass via `bash scripts/ci/typecheck-all.sh` (the root
package scripts are enumerated at `package.json:57`; its known `start` entry
was the positive control for the typecheck-script search). `bash scripts/ci/lint.sh` passes. The generated
index suite passes 38 tests, included in that total. `git diff --check` is clean.
The full test suite was not run.

The leak gate reports INCOMPLETE: zero findings from rules that ran, but the
private PII denylist is unavailable. Secret-backed verification remains for the
orchestrator before publication.

Suite enumeration used changed test paths from `git diff --name-only`, all
`honourDiffOutput` imports from `rg -l`, and explicitly added real-git,
credentialed-runner, git-mode, and generated-index checks. The baseline
`git grep -l honourDiffOutput HEAD -- '*.test.ts'` enumerated nine importing suites
(with merge.test.ts as the positive control), rather than the task's ten; the
real-git merge suite is also validated. The acceptance file names these suites
(`docs/spec-items/a-fake-cannot-be-silently-incomplete.md:32`).

### Scope and limits

Kept the existing gate policy, byte boundary, and unknown-versus-zero semantics.
Did not add a second measurement path, product switch, RSS benchmark, or new
run-failure status. The capability is not a security boundary against a caller
that explicitly lies about its implementation; the filesystem gate remains the
safety boundary (`trident/merge.test.ts:136`).

The as-built record is staged under `.trident/as-built/` as explicitly required
by the build-lane brief, overriding the repository's usual record location.
The orchestrator owns publication and merge; this lane stops at a local commit.
