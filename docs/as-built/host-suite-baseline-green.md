## 2026-10-09 — Host suite passes at baseline on a capacity-pinned host

Refs #1261 (left open). Spec: `docs/spec-items/host-suite-baseline-green.md`.

**What was measured first.** The reported failures came from a suite run at
base `554a2c71`. At the base of this change (`58d5e9a4`), every `bun test`
already runs in the private mount namespace from
`tests/support/process-test-isolation-preload.ts`. There
`trident/process-test-isolation.py` mounts an empty tmpfs over the provisioned
capacity-pin directory. That landed in `918902da4`, after `554a2c71`. That suite log
attributes failures to 47 files. Each was run alone under plain
`bun test --timeout=15000` at this base, and 45 were green. That includes every
file with a relay failure (repl-supervision 37/37, owner-mcp-servers 33/33,
pane-handle-persistence 29/29, project-scope-sleep 31/31). The other two are
covered below:

- `project-build-wiring` failed one case only because the invoking shell's
  GitHub credential leaked in. The runner already scrubs that credential.
- `project-build-e2e` exceeded the 600 s measurement cap. Reversal: dropping the pin directory from the
launcher's masked roots made repl-supervision fail 30 of 37 cases. Restoring it
made the file green again. The pin cause therefore needed no per-file
injection, and none was added.

**Launcher environment.** This was the remaining cause, and it reproduced at
this base. Under `bun run` (which exports `npm_*` and `NODE`),
`project-suite-identity` failed 17 of 46. Every failure was a "portable
package launcher" or "package closure" case. `project-build-e2e -t 'prepared
cross-run package suite proof'` failed 17 of 17. With the predicate's
variables unset, the same commands passed 46/46 and 17/17. The full
`project-build-e2e` passed 598/598 in 838 s. `scripts/run-tests.sh` now unsets
`npm_*`, `NPM_*`, `BUN_*`, `NODE` and `NODE_*` (keeping `NODE_ENV`), plus a
non-empty `ENV`, on entry. It does this for its own test processes only.
`bunPackageLauncherIdentity` is unchanged. A runner selftest
(`scripts/run-tests-selftest.test.ts`, "never inherit the package launcher")
records the environment of the discovery probe and every lane. With the scrub
reverted, it failed with 9 leaked names. `run-tests.sh` is a
`PORTABLE_RUNNER_FILES` member, so proof reuse needs this version deployed. That
does not affect pass/fail.

**Residuals.** Neither reproduces at this base. The "workspace directory
scratch churn" case passed 4 of 4 times, alone under plain `bun test` and under
`bun run`, in 0.6–1.0 s. The case "project dispatch reuses the wake REPL without
a tools-less respawn" passed alone. Chunk 10 of the current plan ran as one
process under `bun run`, with `--timeout=15000 --max-concurrency=16` and the
scrub: 100 files, 1473 pass, 0 fail. That chunk includes `project-build-wiring`
and `project-suite-identity`.

**Capacity-client seam and positive control.** `loadClaudeCapacityPin` takes a
directory, defaulting to the provisioned one, which is now named once as
`CLAUDE_CAPACITY_PIN_DIRECTORY`. `nativeRelayRouteFingerprint` and
`prepareNativeRequestRelay` accept an explicit pin or an injected source.
Omitting it selects the production loader, so every existing call is unchanged.
Nothing in an env var, flag or file selects the source. Two tests cover it in
`runtime/workers/claude-capacity-client.test.ts`:

- A non-root pin fixture must refuse with `repl_unreconciled` in the loader,
  the resolver, the route fingerprint and relay preparation.
- An omitted source must equal the production loader.

Mutation: making the loader's refusal return `undefined` turned the first test
red (47/48). The control, `native-request-relay.test.ts`, stayed 5/5.
`no-direct-anthropic-api` pins the relay's `pin.socketPath` assignment, and
that name is kept.

**Validation at this change.** The stage-1 files passed 841 of 841 in two
batches, among them the changed tests, the capacity and relay consumers, the
runner selftests, the process-isolation tests, the receipt tests and the fence
tests. `scripts/ci/lint.sh` passed. In `scripts/ci/typecheck-all.sh`, 50 of 51
configs passed. The one failure is `app/` (`app/__tests__/support/mount.tsx`:
unused `@ts-expect-error`), which this change does not reach. This builder did
not run the full `bun run test`, because host stage 2 owns it. The per-lane
counts come from that host receipt (16 general chunks, PGLite, device and
real-HTTP).
