## 2026-10-04 — Reconcile authenticated dead Chat ownership before ordinary reprofile

A consumed host-reboot proof could release an exact native-child hold while a
bare shell still occupied the historical Chat slot. Proactive adoption correctly
refused its changed credential fingerprint, and normal placement correctly
refused to overwrite the occupied slot. Neither result licensed deleting the
registry record, changing its grants, or killing the remaining shell.

The installed-owner reconciliation surface now verifies the original signed
evidence digest's exact byte preimage, the historical registry artifact, the
consumed different-boot observation and a fresh current-boot challenge. The
composition helper fences admission while the runtime compares the exact parent
and workspace journal, verifies no current transcript owner and relinquishes only
the dead Chat ownership. The old shell remains in a historical tab. Interrupted
cross-journal completion stays placement-blocked and can retry only with the
same authenticated identity. No fingerprint or grant is written by reconciliation.

An ordinary authorized turn resumes the native session and records its actual
new-generation launch profile. The cap remains until the existing independently
signed exact-generation cap-rearm operation clears it. Proactive fingerprint
guards, original workflow provenance and unrelated child holds remain intact.
This addresses the dead-record edge of #1237 and #1342; it does not close their
broader acceptance or claim live deployment success.

Local evidence: 33 focused tests passed with 137 assertions, including signed
same-boot refusal, remapping both registry and journal to a valid foreign shell,
between-probe registry/journal/authority races, and interrupted journal rename
after a committed registry write. The consuming
`open/__tests__/project-build-e2e.test.ts` case passed through signed historical
proof, real SQL admission refusal/release, actual same-session spawn with the
current full tool/planner profile, signed new-generation cap rearm, and the real
plan/build/review/publish/merge harness. Its model/PTY boundary and host authority
are synthetic; it exercises unregistered self-host credentials, not a live
registered relay. Existing registered-parent preparation tests independently
cover the route/profile refusal boundary.

Open and runtime TypeScript checks passed. Three temporary semantic mutations
failed as required: removing the different-boot check accepted signed same-boot
evidence; removing historical pane equality accepted a valid remapped shell;
refusing every reconciliation broke the consuming successful build case. All
mutations were restored before final validation. Full repository gate and live
operator/deployment acceptance are separate evidence, not established by these
focused checks.

Review controls additionally passed five real-store release cases (success,
transient failure, lost acknowledgement, persistent failure and replacement
epoch). The consuming case now hashes actual `saveRegistry` output, refuses a
project deletion between request and commit, and injects a transient fence
release failure after both ownership records changed. It retries only the exact
fence and still completes the build (26 assertions). Removing the locked project
existence check made this case fail; the predicate was restored. Cleanup now
shuts down the synthetic child before removing its pool mapping.

The initial shared-host gate passed all 51 TypeScript configurations. Its test
run encountered surrounding credential-routing fixture failures, including an
interactive credential-cooldown case independently reproduced on the unchanged
base revision. That run was stopped for the approved review-fix window, with
its logs retained; it is not a completed full-suite pass. The changed Open and
runtime typechecks passed again after the review fixes. CI and live deployment
remain separate gates.

Four intended self-host fixture suites now explicitly mock absence of a native
relay route, restoring the discovery function after each test. This adds 27
test lines without changing production discovery, host registration or the
registered-route refusal controls. The credential-lane, protocol-cooldown,
skill-forge and production-boot suites respectively passed 29, 4, 7 and 19
tests. Grouping them with the unchanged registered-native-chat-auth controls
passed 76 tests with no failures. Removing the fixture mocks reproduced the
original 13, 3, 2 and 4 failures; restoring them restored the 76-test pass.
These controls isolate synthetic credentials from ambient host registration;
they do not substitute for a completed exact-head full-suite gate.

The next isolation batch covered seven fixture files: the same absence-of-route
boundary also fixes background composition, reminder dispatch and memory wiring.
Their direct baseline failure counts were 7, 1 and 5; their isolated runs passed
9, 1 and 12 tests. All seven edited fixtures, the unchanged doctor suite and
unchanged registered-auth controls passed together: 123 tests, zero failures
across nine files. The doctor's 25 original tests already passed; nested
expected-failure output was not a reason to change it. No production predicate,
assertion or host registration was removed or relaxed by this fixture batch.

The subsequent exact-head shared-host gate completed all 1,781 discovered files
and all 51 TypeScript configurations, but exited 1: three general-lane failures,
one failure in the first HTTP batch, and 223 failures with 16 errors in the last
HTTP batch. Its suite input identity stayed unchanged. These results are retained
as a failed full gate, not carried forward as a passing receipt.

The final test-only batch also isolates arbiter, leak-fixer and durable-chat
fixtures. More importantly, the existing private process-test mount boundary now
hides the invoking host's quota registration alongside its operator authority.
The preload enters that boundary when host registration exists, preserving the
exact test invocation. Both default fingerprint discovery and native parent
registration therefore see an unregistered synthetic test host; explicit signed
relay fixtures still use their own real pin and socket. Production discovery and
refusal predicates are unchanged, and missing host directories are not created.

The boundary tests passed 11 cases. The 28 failing HTTP fixture files, related
route fixtures and signed registered-route controls passed together across 41
files: 511 passes, one existing live-API opt-in skip, zero failures. Removing the
quota-directory mask produced 17 passes and seven failures, including the default
discovery guard and six admission-generation cases; restoring it restored the
pass. The protected outer registration's before/after digest stayed identical.
Root and Trident TypeScript checks passed on this test-only batch. A new canonical
full gate remains required; none of these focused results claims deployment.
