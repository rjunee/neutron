## 2026-09-14 — Persist secrets despite a reused PID and crash remnant

### Change and evidence

Issue #634's filed mechanism is a staging-name collision, not a PID ownership
read. The former name at `open/persisted-secret.ts:151` on the base used PID plus
a counter reset on restart. Exclusive creation returned null on collision,
reaching the fallback. Current creation and refusal are at
`open/persisted-secret.ts:157`; the caller's persisted result is at
`open/persisted-secret.ts:438`, with warning and ephemeral fallback at
`open/persisted-secret.ts:454`.

`stagingSecretPath` now generates eight random bytes per attempt, retaining PID
only as a diagnostic (`open/persisted-secret.ts:135`). The installer uses it at
`open/persisted-secret.ts:154`. The kernel's exclusive creation at
`open/persisted-secret.ts:157` maintains the collision refusal on every attempt,
independent of whether the previous process is alive. Foreign staging files are
left untouched; our successful file is published by rename at
`open/persisted-secret.ts:192`, and a failed write cleans our file at
`open/persisted-secret.ts:180`.

The subprocess fixture begins with a weak target requiring rotation and the old
first-attempt staging name, before any loader call
(`open/__tests__/persisted-secret.test.ts:25`). Disk bytes, mode, source, warnings
and remaining staging entries distinguish the foreign remnant from the current
attempt's consumed file (`open/__tests__/persisted-secret.test.ts:61`). The
complement injects a failure after exclusive creation and verifies our cleanup,
foreign retention and the existing warning (`open/__tests__/persisted-secret.test.ts:74`).

### Decisions and limits

Followed the filed issue's random-name design. The pane claimant precedent mints
random identity per pass at
`runtime/adapters/claude-code/persistent/boot-adoption.ts:2602`. The closer staging
exemplar uses eight random bytes at
`runtime/adapters/claude-code/persistent/sink-coordinates.ts:520` and exclusive
creation at `runtime/adapters/claude-code/persistent/sink-coordinates.ts:527`.
Both sites were read before implementation. Exporting the name builder permits
a direct uniqueness contract, as that staging exemplar does.

Randomness makes accidental collisions improbable, not impossible. Exclusive
creation still refuses an actual collision. This does not authenticate against a
same-user adversary replacing filesystem entries. It requires no remnant reaper
or cooperation from a crashed process.

The existing outcome vocabulary remains `persisted | ephemeral`
(`open/persisted-secret.ts:41`). Successful installation joins `persisted` at
`open/persisted-secret.ts:438`; actual I/O failure retains the warning and
`ephemeral` fallback at `open/persisted-secret.ts:454`. No new error value needs
classification. The foreign-remnant success test records no warning and a
persisted result; the owned-write failure records the fallback event.

Deliberately did not change lock ownership, stale-lock policy, filesystem failure
policy, or introduce remnant adoption/deletion. The task's ownership-read wording
was corrected in the progress record against the filed issue. The search
`rg -n 'process.pid|readFileSync|openSync\(tmp' open/persisted-secret.ts` had
positive controls for actual reads and the staging open; it showed a name
collision rather than a staging read. A whole-tree search for
`Per-process temp-name sequence|pid \+ counter|tmpSeq|Fresh identity per attempt`
matched only the replacement comment (`open/persisted-secret.ts:134`), the
positive control, before this record was added. No other matching prose needed
correction.

Acceptance is recorded in `docs/spec-items/persisted-secret-staging-identity.md`;
the index was regenerated. No product decision in `SPEC.md` changed. This record
uses the build-lane staging location explicitly requested for this branch.

### Mutation evidence

Each mutation was applied alone. Its actual landing line and `git diff` were
printed before running the targeted test. Each row went RED, then GREEN after
restoring the production file. All tests live in
`open/__tests__/persisted-secret.test.ts`.

| Property | Mutation and printed landing line | RED observation | Restored |
| --- | --- | --- | --- |
| Foreign remnant cannot force fallback | Restore PID/counter at `open/persisted-secret.ts:137` in mutated file | :63 expected persisted, received ephemeral | GREEN |
| Per-attempt random identity | Constant hex suffix at `open/persisted-secret.ts:136` | :91 expected 128 distinct names, received 1 | GREEN |
| Owned staging still publishes | Replace rename with `void tmp` at `open/persisted-secret.ts:192` | :63 expected persisted, received ephemeral | GREEN |
| Owned failed staging is cleaned | Replace first staging unlink with `void tmp` at `open/persisted-secret.ts:180` | :81 observed an extra staging file | GREEN |

### Validation

- `bun test open/__tests__/persisted-secret.test.ts open/__tests__/session-cookie-secret.test.ts open/__tests__/owner-bearer.test.ts`: 37 passed.
- `bun test scripts/__tests__/spec-items-index.test.ts`: passed.
- `bash scripts/ci/lint.sh`: passed.
- `bash scripts/ci/typecheck-all.sh`: all 51 configurations passed.
- `bash scripts/ci/leak-gate.sh --tree .`: exit 3, INCOMPLETE; zero findings in rules run, external PII denylist unavailable.
