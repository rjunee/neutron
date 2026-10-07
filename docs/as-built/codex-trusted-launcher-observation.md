## 2026-10-07 — Retained trusted sudo launchers preserve Codex account admission

Issue #1451: treating the child command in a retained sudo launcher's argv as
native Codex subjected that parent to the native mixed-UID refusal. The canonical
classifier now resolves this ambiguity using actual executable identity. Codex
executable recognition and a Codex first argv entry retain precedence; only the
ambiguous second entry can be disambiguated by matching the protected canonical
system sudo device/inode
(`runtime/adapters/codex-cli/codex_account_observation.py:219`).

The reference is obtained through directory descriptors and no-follow opens.
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
unprotected/nonregular ancestry, unmatched deleted identity, reference changes,
process evidence changes, mixed-UID native/wrapper controls and no-sudo wrapper
controls exercise the opposite direction. The existing deleted-executable
controls also continue to run. Eight additional restoration mutants test this
classification and its proof retention
(`runtime/adapters/codex-cli/account-observation-mutation-test.py:34`). Acceptance
lives in `docs/spec-items/instance-project-provider-resolution.md`.

Focused validation passed: `python3 -B runtime/adapters/codex-cli/account-writer-test.py` (24 tests),
`account-observation-client-test.py` (10 tests), and
`account-observation-mutation-test.py` (25 semantic mutants rejected, each with a
passing baseline). `bash scripts/ci/typecheck-all.sh` passed all 51 owned
TypeScript projects, including `open/tsconfig.json` and root `tsconfig.json`.
The ordinary-user consuming gate with Bun 1.3.13,
`bun test --timeout 15000 runtime/adapters/codex-cli/account-writer-lock.test.ts`,
passed all 18 tests and 61 assertions under the mandatory private proc boundary,
using a fresh owned native cache. The project-build E2E and complete partitioned
suite remain outstanding at this record's implementation freeze; focused results
do not substitute for those gates.
