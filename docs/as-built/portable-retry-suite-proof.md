## 2026-09-28 — Reuse measured green suite proof on a direct retry

Related to #1196; this slice does not close its deployed/live acceptance.

A retry previously paid for the same full suite even at the same revision:
the receipt belonged to its original run and workspace, and the dependency
identity included absolute paths and installation inode metadata. Those strict
identities remain the contract for installation and ordinary same-run reuse.

The host now records an additional versioned portable identity for supported
suite commands. It measures canonical dependency bytes, modes and confined local
resolution, selected toolchain and runner utilities, host runner implementation,
and effective environment. Stable inode/ctime checks still protect reads, but
inode numbers are not compared between independently checked installations.
Unmeasured ignored inputs, tracked symlinks/gitlinks, external dependency links,
unsafe overrides and unsupported commands cannot mint portable proof. Bun
configuration must be absent or match the reviewed first-party configuration
with regular, tracked, confined preload files.

Only exact `bun test` or the byte-matched first-party full runner and its helpers
are eligible, with recognized numeric tuning exports. Other configured commands
still execute normally. Governed suites now use an explicit non-login Bash
shell with `BASH_ENV` cleared, so mutable login/startup scripts cannot secretly
supply setup. Projects must make that setup explicit in the suite command.
This is a bounded same-host runner contract, not a claim that arbitrary tests
are hermetic with respect to external services or time.
Ordinary tracked source retains the existing receipt's HEAD plus Git-clean
trust boundary. Index `assume-unchanged` or `skip-worktree` flags can conceal
working-file changes from that check; this slice does not independently hash
every tracked source file or strengthen that pre-existing boundary.

A validated direct retry link nominates a predecessor; it does not by itself
authorize receipt reuse. Its latest original version-2 receipt must be green,
full-suite, and match revision, source round, strategy and portable inputs.
Destination measurement is repeated before adoption. A transaction checks that
the source receipt is still latest and the source remains failed, while the
destination still owns its first observation. The destination records original
run/event/round provenance and returns a current-run observation through the
unchanged review gate. Later invalidation cannot resurrect an older success.

Legacy receipts, red/subset results, unrelated runs and already-adopted receipts
are not cross-run sources. A later retry after an adoption runs fresh proof in
this initial slice. Approval, mutation evidence and review rounds are never
transferred by this mechanism. Existing live receipts were not rewritten.

Validation includes real prepared retry dispatch into a different worktree,
one real Bun suite across the successful source/retry pair, and continuation
through fresh review to merge. Changed revision, dependency bytes, environment,
strategy, legacy/subset/red and invalidated evidence require another suite.
The shell test positively demonstrates that its startup sentinels execute when
explicitly requested, then proves they are excluded from the governed suite.

Semantic mutation checks remove the source-head guard, disable valid adoption,
bypass atomic source validation, remove command admission or environment binding,
and allow inherited shell startup. Each fails its behavioral assertion;
restored implementations pass. Focused command/input tests also cover unknown
launchers, changed utility binaries, tracked external links, and script changes.

Independent adversarial review identified tracked-source links, generic
toolchains and custom Bun preload configuration; all were repaired with
fail-closed admission and paired controls. The review recommends merge subject
to required CI.

Local verification: the complete consuming E2E file passed 395 tests and 5,185
assertions. That run began before the final command/configuration narrowing;
the affected real-Bun retry and startup cases were separately rerun on the final
implementation: 10 tests, 204 assertions, 25.32 seconds. The final
authority/identity/native-probe group passed 64 tests
and 374 assertions; the tightened same-run adoption check then passed all 27
authority tests. Wiring plus authority passed 78 tests. Both root and Trident
TypeScript checks passed. Each of the six semantic mutants failed by assertion,
not parsing, and was restored. Hardlink dependency installation was verified by
an installed compiler file's link count of 45.

The whole-tree local leak invocation was not a usable publication receipt: it
included the worktree metadata pointer and reported pre-existing tree findings
against the local denylist. Publication still requires the canonical exported
tree purity gate, complete shared-host checks, and exact-head CI. No live run
was restarted and no deployment was performed by this change.

The first CI run exposed fixture inheritance of `NEUTRON_TEST_SHARD` from
the outer CI runner (`.github/workflows/ci.yml:467`). Production intentionally
refuses portable proof for that subset selector
(`open/wiring/project-build-dependencies.ts:273`). The nested complete-suite
fixtures now scope out and restore only that outer selector
(`open/__tests__/project-suite-identity.test.ts:9`,
`open/__tests__/project-build-e2e.test.ts:2838`). Paired controls explicitly
retain shard refusal for both admitted command forms and recover portability
after removal (`open/__tests__/project-suite-identity.test.ts:188`, `:230`).
The deadline mutation fixture also anchors the final deadline guard at its
current location, still requiring an assertion failure when it is removed
(`open/__tests__/project-suite-identity-mutation.test.ts:40`). Production code
and receipt admission were unchanged by this CI correction.

Correction verification with an inherited CI shard selector: all 30 identity
and deadline/byte mutation tests passed (249 assertions); the final five portable
identity cases, including both shard-refusal controls, passed (49 assertions).
All nine prepared retry cases plus shell startup exclusion passed (204
assertions). Both TypeScript checks passed. The complete 395-case E2E file was
not repeated for this fixture-only correction; the earlier full-file result
above remains attributed to its measured revision. Exact-head CI remains the
publication gate.
