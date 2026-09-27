## 2026-09-27 — Record explicitly linked command phases at execution

The temporary dashboard already accepts explicit phase observations through the
validated, locked append path (`scripts/build-timeline-sources.ts:475`). The new
`scripts/build-timeline-command.ts:35` exposes `recordCommandPhase` and a CLI that
wrap one actual argv invocation, supplying forward evidence for the existing
[dashboard specification](../spec-items/temporary-build-timeline-dashboard.md).
This does not reconstruct historical work or introduce the future Core.

The wrapper requires explicit repository/PR links, a recognized phase and public
label. Its invoking model is supplied explicitly or remains unknown. It generates
opaque UUID evidence, appends an open observation before spawning, and appends a
new event with the same phase identity after observed exit
(`scripts/build-timeline-command.ts:46`). All five usage metrics remain null:
command duration supplies no provider usage. Failed commands retain their measured
interval and exit code in the evidence text. Multiple PR links remain one shared
span in the existing consumer (`trident/build-timeline-catalogue.ts:126`).

Run from the desired command working directory, pointing `--output` at the same
operator-controlled journal configured as `TIMELINE_OBSERVATIONS`:

```sh
bun scripts/build-timeline-command.ts \
  --output observations.jsonl --pr example/project#7 \
  --phase test --label 'Focused tests' --model unknown \
  --timeout-ms 60000 -- bun test scripts/build-timeline-command.test.ts
```

Repeat `--pr owner/repository#number` for explicitly shared work. Supported phases
are `plan`, `build`, `fix`, `review`, `test`, `ci` and `deploy`. Model omission or
`--model unknown` means null. Labels and model identifiers are public metadata;
use short non-sensitive names. The wrapper limits their syntax and length and
never derives them from argv, output, environment or paths. Child stdin/stdout/
stderr remain inherited; command output is not journalled. The required timeout
is 1–86400000 milliseconds and bounds the direct child with SIGKILL. Commands
remain responsible for descendant cleanup; this is not a process-tree supervisor.

The CLI emits a JSON `command-phase-result` receipt on stderr and preserves the
child exit code, including when completion recording fails. Callers must inspect
its independent `recording.status`; command exit zero alone does not establish
successful recording (`scripts/build-timeline-command.ts:118`). A refused start
emits `command-phase-refused`, exits 125, and does not execute the command. Spawn
failure reports exit 127; signals use 128 plus the signal number. A killed wrapper
or failed completion append leaves the start unclosed. The consumer shows an open
span with unknown liveness, never inferred successful completion. Error receipts
do not include underlying filesystem errors or private paths.

Validation on base `71f4aa84803735102c71d79f8836ae974383e507` with producer blob
`40dc7ec17b02891ca321b107f44dcbd463a8b27c` and test blob
`f4bcefb644f3850b00a3bd0461a7cdcf9872d2ea`: both
`bunx --no-install tsc --noEmit` and
`bunx --no-install tsc --noEmit -p trident/tsconfig.json` exited 0.
`bun test scripts/build-timeline-command.test.ts scripts/build-timeline-sources.test.ts scripts/build-timeline-codex-import.test.ts trident/build-timeline.test.ts trident/build-timeline-html.test.ts scripts/__tests__/build-timeline-server.test.ts`
passed 58 tests with 652 assertions, zero failures. The initial checks required
repairing local dependency links and permitting the server fixture's loopback
listener; the final run passed with those test prerequisites satisfied.
The actual `bash scripts/ci/lint.sh` gate initially rejected the test's two
relative cross-workspace imports. Both now use `@neutronai/trident` aliases
(`scripts/build-timeline-command.test.ts:7`); the complete lint gate exited 0,
and the focused tests and both TypeScript checks passed again after that change.
The command fixtures verify durable start-before-execution, actual failed
exit and duration, multi-PR consumption, unknown metrics, invalid/missing links,
public metadata refusal, literal argv, unexported command output, spawn failure,
timeout, failed journal completion with both exit zero and nonzero, and a killed
observer. Two temporary semantic mutations were rejected: inventing a PR link
for missing attribution, and refusing null model context. Each targeted control
exited 1; both mutations were reverted. Full shared-host suite, CI and live
deployment remain separate operational validation; this record does not claim
those checks or historical phase completeness.

Combined-candidate CI at `d1b4da4ed1d47fb2ea9df7343fb9c7b33ffc7701`
subsequently exposed two registry assertions naming the command producer as
unregistered. The existing identity-name detector conservatively matches the
public-text validator's character classes (`scripts/build-timeline-command.ts:29`).
The new registration describes that regex match without claiming a direct
environment read (`tests/integration/identity-env-readers-registry.test.ts:408`).
A consuming test at `:977` compares the producer's source against the real
`migrations/db-path.ts` reader, preserving positive and negative controls.
The detector and producer are unchanged. Temporarily removing the registration
reproduced both CI failures with exit 1; restoring it passed the registry suite
(26 tests, 119 assertions). Adding that exact registry suite to the focused
command above passed 84 tests across seven files with 771 assertions. This repair
was checked on `15fcc895efcad96690fef09cd3996e8126b80a43` plus registry blob
`d9d39f3441cf5c924273ebeb7cd8e00e4075268a`. Both root and Trident
TypeScript commands above and the actual `bash scripts/ci/lint.sh` gate exited 0
again. No full-suite rerun or publication was performed in this repair worktree.
