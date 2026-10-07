## 2026-10-07 — Retained trusted sudo launchers preserve Codex account admission

Issue #1451: treating the child command in a retained sudo launcher's argv as
native Codex subjected that parent to the native mixed-UID refusal. The canonical
classifier now resolves this ambiguity using actual executable identity. Codex
executable recognition and a Codex first argv entry retain precedence; only the
ambiguous second entry can be disambiguated by matching the protected canonical
system sudo device/inode
(`runtime/adapters/codex-cli/codex_account_observation.py:219`).

The reference is obtained by walking the literal `/usr/bin/sudo` path through
directory descriptors and no-follow opens, refusing all symlink components.
Every ancestor and the regular executable must be root-owned and have no
group/other write permission; canonical path, identities, ownership, modes and
metadata form retained evidence
(`runtime/adapters/codex-cli/codex_account_observation.py:88`). That evidence is
checked again within inspection and participates in the existing second census
pass, alongside raw executable target, device/inode, all four UIDs, PID/start and
argv (`runtime/adapters/codex-cli/codex_account_observation.py:253`). An unavailable
or untrusted reference leaves native recognition and its mixed-UID refusal in
place. Ordinary wrappers therefore preserve their account behavior on a system
without sudo. The child's population membership continues to use credential UIDs
(`runtime/adapters/codex-cli/codex_account_observation.py:206`).

The regression fixture uses the real canonical sudo file identity with synthetic
proc credentials, protected ownership evidence and a missing environment. The
ownership seam represents host-root ownership inside the mandatory single-UID
test namespace, which cannot map host root; production retains the actual
root-ownership check. Independent same-account natives
remain busy and distinct accounts admit; a separately observed foreign-UID child
does not enter the requested population
(`runtime/adapters/codex-cli/account-writer-test.py:184`). Counterfeit sudo,
unprotected/nonregular ancestry, symlink references whose resolved destination is
otherwise protected, unmatched deleted identity, reference changes,
process evidence changes, mixed-UID native/wrapper controls and no-sudo wrapper
controls exercise the opposite direction. The existing deleted-executable
controls also continue to run. Nine additional restoration mutants test this
classification and its proof retention
(`runtime/adapters/codex-cli/account-observation-mutation-test.py:34`). Acceptance
lives in `docs/spec-items/instance-project-provider-resolution.md`.

Focused validation passed: `python3 -B runtime/adapters/codex-cli/account-writer-test.py` (25 tests),
`account-observation-client-test.py` (10 tests), and
`account-observation-mutation-test.py` (26 semantic mutants rejected, each with a
passing baseline). `bash scripts/ci/typecheck-all.sh` passed all 51 owned
TypeScript projects, including `open/tsconfig.json` and root `tsconfig.json`.
The ordinary-user consuming gate with Bun 1.3.13,
`bun test --timeout 15000 runtime/adapters/codex-cli/account-writer-lock.test.ts`,
passed all 18 tests and 61 assertions in 6.58 seconds after the reference-path
correction under the mandatory private proc boundary. Its outer environment
omitted `BUN_INSTALL_CACHE_DIR`, retaining the existing package-launcher guard.
The canonical ordinary-user `bash scripts/check-shared-host.sh` subsequently
passed on source head `3aa43e1264a59ea1d909289be8b1bc8ef9cb1a57`: lint, all
51 TypeScript projects, and all 1,795 discovered test files across 19 bounded
lanes, including the consuming project-build E2E. The complete command exited
zero in 2,153.56 seconds. Its before/after suite input identity remained
`2297b7879d9280ce43a15ed6801d3a1a3ef642544c09c2c73b7b791a8f9b29c5`.
Independent native security and bounded external source reviews both returned
GO for that source. This final amendment records the completed validation;
installed signed census observation and fresh runtime admission remain separate
delivery acceptance.
