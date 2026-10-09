## 2026-10-09 — Nested package-launcher fixtures own their outer environment

Refs #1460 and #1196. An outer `bun run test` supplies package-launcher inputs
such as `npm_lifecycle_event` and `NODE`. The synthetic launcher fixtures inherited
those inputs, so the production measurement correctly refused portable proof even
for the fixtures' nominally clean cases. A direct test invocation did not expose
that mismatch. The production launcher measurement and its refusal rules are
unchanged.

The focused identity fixture and the prepared cross-run package cases now use a
shared test-only environment scope. It removes the launcher inputs for the
synthetic setup, restores their original values and presence afterward, removes
fixture-added launcher inputs, and leaves unrelated environment changes intact.
`NODE_ENV`, `PATH` and the production host-suite environment are not normalized by
this helper. The prepared fixture registers restoration with its existing reverse
cleanup stack. Deliberate hostile inputs introduced inside each test still reach
the real measurement and its existing refusal controls.

The new regression launches a real outer package script, first checks that Bun
actually supplied its launcher inputs, and then consumes the existing focused
identity test or prepared retry test in a child process. Both consumers failed on
their portable-identity assertions before the fixture calls were added. The
restoration control passed. With the fixture repair, all three tests passed.

Measured focused verification through a real outer package script: 49 tests and
264 assertions across the focused identity and environment regression files;
26 prepared cross-run bare/package cases and 642 assertions. Both runs had zero
failures. Changed-file lint passed.

Removal mutation: leaving the outer launcher inputs in place made both consuming
regressions fail again on the nominated portable-identity assertions. The existing
`npm_config_script_shell` refusal case remained green under that mutation (one
test, three assertions). Restoring the helper restored both consuming regressions
to green. These are focused controls; they do not claim full-suite or live Work
Board acceptance for the broader Trident workstream.

Completed local validation used implementation tree
`8024c4828e75a3530209f7b92fde8aee1ec43d24` against base
`58d5e9a44f495ac9001a00e17edd3bf87c64415c`; only this completion receipt was
added afterward. `bash scripts/ci/typecheck-all.sh` passed all 51 configurations.
`bun run test` executed all 1,800 discovered files: 28,006 passed, 24 skipped,
one failed, and zero additional errors. Every database, device and HTTP lane
passed, including the prepared package consumers. The full run remains **FAIL**:
the unchanged `project-owner-retirement.test.ts:12` threw `EBADF` while reading
`child.exited`, before its retirement assertions. This repeats the separately
tracked #1457 failure; an isolated recheck passed both tests and 17 assertions
without a source change. That narrow pass does not replace the full-run result.
This run used the package script's single-worker default, not the shared-host
wrapper. Full lint and layering checks passed. Independent code reviews found
no merge blocker; non-blocking regression refinements are tracked in #1461.
Exact-publication-head CI remains a separate required merge gate, and unattended
Trident acceptance is not claimed by this repair.
