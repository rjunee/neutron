## 2026-09-27 — Prepared native-child termination across a physical host reboot

Legacy unsigned native dispatches cannot retrospectively acquire an original
pre-input refusal receipt. A terminal workflow and a missing parent process also
cannot prove that escaped native descendants are dead. The restart spec now
defines a separate, independently authenticated physical-host recovery protocol.

`runtime/workers/native-host-termination.ts` defines pinned Ed25519 preparation
and fresh challenged boot evidence. `open/wiring/native-host-termination.ts`
accepts preparation only on the original measured kernel, for the exact durable
native-child lease and a canonical terminal native-dispatch attempt. Migration
0161 and `gateway/project-admission-store.ts` persist a separate admission gate.
The consumer records `terminated-by-host-reboot` and removes only the unchanged
full lease in one transaction after a different authenticated kernel boot.
Run, attempt, result, armed request and publication provenance remain untouched.
Other unresolved work remains held; no workflow is redispatched.
Ordinary token/work completion cannot delete a pending preparation's reserved
lease; only authenticated recovery consumes that token. A changed trust pin
refuses, while restoration of the original authority remains recoverable.

`open/composer.ts` awaits consumption before native actor construction and
workflow/chat replay. The actual `open/server.ts` entrypoint loads its pin from
the fixed effective-UID operator configuration, checking root ownership,
non-writable ancestry, and symlink refusal. Its Unix client requests only a
challenged boot observation. Missing authority cannot consume prepared records;
present malformed configuration refuses startup. The independently deployed
supervisor owns peer authorization, signing, historical-placement verification
and hardware-bound host identity; application boot UUIDs and cloned machine-id
values are not substitutes.

`open/prepare-native-host-termination.ts` is the executable operator bridge: it
reads a bounded signed preparation from stdin, resolves the server's ordinary
install configuration under its effective UID, and reports only prepared/refused.
It does not create or migrate a database. Exercising that path exposed Bun's
requirement for an explicit writable-open bit when creation is disabled;
`persistence/db.ts` now sets `readwrite: !readonly`. Existing-only writing,
missing-file refusal and read-only write refusal have regression coverage.

Verification: 155 focused tests passed, covering recovery, protected configuration,
real server-entrypoint wiring, admission, native dispatch, migration snapshot and
table-ownership conformance, plus operator preparation and persistence. Both root
and Trident TypeScript checks passed.
Semantic mutations that removed the same-kernel refusal and forced permanent
refusal each failed the corresponding test assertion; restored code passed.
Removing either ordinary-release exclusion independently failed its positive
prepared-token retention assertion. Removing writable existing-only support or
allowing file creation also independently failed the persistence regression.
The earlier recovery candidate passed all 356 consuming tests in
`open/__tests__/project-build-e2e.test.ts` inside the authenticated private PID/proc
test boundary, before the final operator-bridge and release-exclusion additions.
Those final additions were checked with the focused affected tests; the combined
integration gate is separate. The workspace dependency verifier passed. These are offline implementation
checks, not evidence of a live host reboot or deployment restoration. Live
preparation, signing-key provisioning, physical restart and dispatch acceptance
remain separate operator-controlled deployment work.

The first combined host gate executed all 1,725 declared test files and refused
publication on two failing lanes. Three explicit migration-ledger expectations
omitted migration 161; adding that ordinal preserved their exact-order, drift
and skip assertions, and all 27 affected tests passed. The reaper startup timer
fixture also invoked the real process-signalling sweep while polling a deadline.
It now holds a local command stub until stop drainage, asserting immediate
startup, the exact Python command, default cadence and timer clearing without
signalling host processes. Its focused test passed; independent mutations that
disabled immediate startup or changed the default cadence failed their semantic
assertions. These necessary fixture repairs do not substitute for the final
combined gate on the frozen repaired candidate.

A later combined run passed all 51 TypeScript configurations and executed all
1,725 test files, with 17 of 18 lanes passing. Its remaining entrypoint failure
was test-environment coupling: a configured installation's protected authority
became an unmapped owner inside the test user namespace, and the production
root-ownership guard correctly refused it. The test launcher now privately masks
only the existing fixed authority directory, without changing host files or the
production loader. Installed and absent synthetic configurations pass actual
namespace controls, retain neighboring configuration, and preserve original file
bytes and metadata. Eight boundary tests pass with 49 assertions; removing the
overlay fails the authority-absence assertion, while masking its parent fails
the known-present neighbor control. Both mutants retain the valid absent case.
The actual dual-entrypoint regression passes seven tests with 20 assertions,
and the unchanged authority guards pass 20 tests with 57 assertions. An early
nested-runtime fixture crash was discarded as fixture failure, not counted as
mutation evidence. A final combined gate was required on this correction.

That final gate completed with exit 0 at clean implementation revision
`c1f8f958600d6f804c3893dba717ad08fc706b0f`, using
`python3 -B trident/process-test-isolation.py -- bash scripts/check-shared-host.sh`.
All 51 TypeScript configurations passed, explicitly including root and Trident.
All 1,725 declared, discovered, assigned and executed files were accounted for:
1,489 general, 22 database, 43 device and 171 HTTP files; all 18 partitions passed.
The actual `open/__tests__/project-build-e2e.test.ts` consuming surface executed,
and the previously failing dual-entrypoint control passed in the HTTP partition.
The source hashes and worktree were unchanged before and after this gate. This
receipt identifies the tested implementation revision, not a later publication
head; exact-head CI remains required. Independent Astra and bounded Fable reviews
approved the recovery implementation and final harness correction. No live
preparation, physical restart, deployment restoration or unattended merge follows
from these offline results.

Publication CI subsequently rejected the operator bridge's bare `console.log`
under the existing console guard. The necessary repair at
`open/prepare-native-host-termination.ts:49` writes the same newline-terminated
JSON directly to stdout, following the existing machine-output convention at
`open/diagnostics-cli-impl.ts:228`. The signed-input, configuration, database and
admission checks and the exit-code mapping are unchanged. No guard exemption or
logger prefix was added.

On the repaired source, the actual `bash scripts/ci/lint.sh` completed with exit
0, including zero console violations. The native-host termination and protected
authority test files passed all 53 tests with 203 assertions; root and Trident
TypeScript checks passed. The configured-preparation positive control at
`open/wiring/__tests__/native-host-termination.test.ts:68` accepts valid signed
evidence, and its actual CLI refusal checks at lines 79–84 require exit one,
exact `{"status":"refused"}` plus newline, and empty stderr. An independent
mutation adding an invalid stdout prefix failed the exact-output assertion at
line 83; restoring the source passed the operator test with 13 assertions.
The repaired CLI source SHA-256 is
`8e7d51d666ef8296ecb92fbcd652b5415ce0cc8babf606eb8fa4ab8410cea501`.
These focused checks do not transfer the earlier combined-gate receipt to the
changed source; publication CI must validate the repaired head.
