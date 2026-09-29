## 2026-09-29 — Measure the Bun package-suite launcher before portable retry reuse

The strategy generator correctly retains `bun run test` for Bun package
scripts: executing its raw script would lose package-local executable lookup.
The portable identity producer previously admitted only bare `bun test` and
the verified first-party Bash runner, so this generated strategy could produce
green host evidence without a portable identity. This change extends the
normative contract in `trident-build-efficiency` to the narrowly measured package
launcher. It supersedes that command limitation in the immutable
`portable-retry-suite-proof` record without changing historical receipts.
The package-manager contract remains at `trident/test-strategy.ts:46` and
`trident/test-strategy.ts:173`.

`open/wiring/project-build-dependencies.ts:426` admits exact `bun run test` with
known numeric tuning exports only when `scripts.test` is exactly
`bash scripts/run-tests.sh`, lifecycle hooks are absent, and the existing
runner/helper byte checks pass. Two fresh controlled sibling packages observe
the inner Bash through `/proc`, the transformed PATH, Node/Bun coordinates,
child environment digest and startup-option digest. Only positively matched
package-root fields normalize. Both normalized observations must agree
(`open/wiring/project-build-dependencies.ts:276`, `:313`).

The admitted Linux default system-shell rule measures the complete bash/sh/zsh
candidate set, including missing candidates, under the observed PATH. It does
not claim to identify a transient interpreter that already exec'd. The selected
Bun and Node bytes and versions, actual inner Bash and every first-party runner
utility are measured. Ancestor PATH coordinates remain exact; populated ancestor
bin directories may exist but cannot supply a shadowed launcher tool or serve as
dependency-installation evidence. Existing local dependency confinement remains
mandatory. Missing Node, generated aliases, unsupported configuration or
environment transformations, startup injection and shadowed tools refuse the
portable key while the normal fresh suite remains available. No Bun-version
allowlist, tracing privilege or new runtime launcher is introduced
(`open/wiring/project-build-dependencies.ts:348`).

The consuming test begins at `buildTestStrategyDetail`, prepares real Bun
workspace dependencies from an offline tarball, executes the original complete
host suite, and dispatches a distinct nested retry worktree. A package-local
executable proves the package-manager PATH is actually used. The unchanged
predecessor is adopted with its original provenance and exactly one suite
invocation; review and merge gates still execute. Changed dependencies,
environment, strategy, revision, hooks, configuration, runner, ancestor shell
selection, absent Node, startup input, and red/subset/legacy/invalidated receipts
require fresh proof. Focused identity tests cover the paired closed-launcher
controls and preserve the existing bare-Bun/Bash cases
(`open/__tests__/project-build-e2e.test.ts:3407`,
`open/__tests__/project-suite-identity.test.ts:278`).
The revision-changing and environment-changing consuming variants establish
overall non-adoption, not which individual launcher guard caused refusal;
the focused identity cases separately exercise those policy refusals.

The tiny consuming fixture contains one real passing test named with the
runner's discovery sentinel. Bun 1.3.13 omits its `across N file` summary when
every test is filtered out; this explicit fixture control makes the unmodified
first-party discovery audit observable. All fixture tests then execute in the
complete suite. The runner and its coverage guard are unchanged.

Author verification used an isolated worktree based on
`5d7ceafd116fac21c6054efa11d4e7cba27289a4`, with matching package/lock bytes and
offline dependencies copied from that frozen checkout. The workspace verifier
passed, and module-resolution controls selected this worktree's Trident and
changed Open module. This is bounded author evidence, not a repository-wide
suite or a live deployment receipt:

- `bun test open/__tests__/project-suite-identity.test.ts`: 44 passed.
- `bun test open/__tests__/project-build-e2e.test.ts -t 'prepared cross-run (bare|package) suite proof'`:
  the initial 23-case matrix passed; the additional Bash-shadow and startup-input
  consuming cases passed, and the corrected explicit-PATH Node-absent case passed.
- Root and Trident TypeScript checks (`tsc --noEmit -p tsconfig.json` and
  `tsc --noEmit -p trident/tsconfig.json`) passed.
- Two valid-program semantic mutants were killed by the consuming tests:
  rejecting the launcher lost legitimate portable proof; accepting a constant
  unmeasured launcher digest incorrectly adopted an ancestor-shell-shadow retry
  (one suite invocation instead of the required two). Restored controls passed.

Existing receipts are not retrofitted. No predecessor approval or mutation proof
is inherited. Independent code review, the combined repository checks, publication
and a served-revision witness remain separate requirements.

Independent review of author commit `dc8f29c5bdbf568a0878f0e0b934818f673d1c7e`
found that the probe could execute an ancestor-bin shell before its observed
PATH was rejected. The correction derives the admitted package/ancestor/inherited
PATH first and validates every potentially selected shell and tool before each
probe launch (`open/wiring/project-build-dependencies.ts:348`, `:386`). Each
actual observed vector and tool-byte record must still match that admission;
both normalized observations remain mandatory. Harmless ancestor bin directories
are still supported.

The additional focused nested-worktree sentinel proves an executable ancestor
wrapper writes its marker independently, never writes during identity-only
measurement, and leaves portability intact when removed. The consuming Bash
shadow case also proves that the wrapper runs when the governed fresh suite is
subsequently requested. The affected checks passed 17 focused cases and three
consuming cases; both root and Trident typechecks passed. These supplement the
earlier 44-case and 26-case evidence rather than claiming a new complete run.
Two further valid-program mutants exercise the ordering guard in both
directions: disabling preflight fails the consuming marker-absence assertion;
inverting admission loses legitimate original portable proof. Both were killed
by behavioral assertions, and the restored consuming controls passed.
