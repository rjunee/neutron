## 2026-10-03 — Isolate authentication and installer permission fixtures

The authentication fingerprint tests implicitly assumed an unregistered host.
A protected native relay registration selects a route fingerprint before the
credential derivation (`runtime/adapters/claude-code/persistent/repl-session.ts:903-911`).
That made the synthetic credential tests compare the host route instead of
creating their isolated fingerprint key. The fixture now explicitly mocks an
unregistered route in both the test process and its restart subprocess, restoring
the spy afterward. Synthetic registered and invalid routes exercise the consuming
function's route precedence and refusal without accessing host registrations
(`runtime/adapters/claude-code/persistent/__tests__/auth-fingerprint.test.ts:10-16,92-114`).

The installer tests also assumed that a create mode of 0644 defeats the process
umask. Under 0077 their intended unsafe inputs were actually 0600, so the tests
failed before invoking the installer. Each unsafe fixture now explicitly sets
0644 after creation; the existing assertions still require successful repair,
refusal when chmod does not stick, and refusal when stat cannot verify permissions
(`tests/integration/install-env-perms.test.ts:134-137,187-190,212-215,293-296`).

The same ambient route assumption affected adoption credential rotation,
warm-import reset, native launch evidence and configured-host subprocess tests.
Their fixtures now explicitly select unregistered pin and route lookups and
restore the bindings. The configured-host test writes a temporary child preload,
restores its spies after the child suite, and removes the temporary directory;
both selected backends still complete the original asserted turn
(`runtime/adapters/claude-code/persistent/__tests__/configured-pty-host.test.ts:101-125`).
The other hooks retain their existing adoption, reset and launch controls
(`runtime/adapters/claude-code/persistent/__tests__/adoption-claim-is-a-compare-and-set.test.ts:249-268`,
`runtime/adapters/claude-code/persistent/__tests__/import-warm-session-reset.test.ts:37-47`,
`runtime/adapters/claude-code/persistent/__tests__/native-parent-launch-evidence.test.ts:18-33`).

Project build wiring and native-child lease fixtures likewise select unregistered
pin and route lookups, restoring them even if fixture cleanup fails
(`open/__tests__/project-build-wiring.test.ts:38-48`,
`open/wiring/__tests__/project-build-native-child-lease.test.ts:33-43`). Installed
tree and workspace identity tests explicitly establish their initial 0644 file
and 0755 directory inputs before measuring the subsequent 0600 and 0700 changes
(`open/__tests__/project-installed-tree-probe.test.ts:108-119`,
`open/__tests__/project-suite-identity.test.ts:669-675`). The atomic writer's custom
mode test sets umask 0022 only for the synchronous API call and its output
assertion, then restores the previous umask. It still observes the actual file
created by the API, while the separate default-mode control still requires 0600
(`runtime/__tests__/atomic-write.test.ts:44-60`).

The six owned test files passed under both 0022 and 0077: 74 tests, zero failures,
476 assertions with Bun 1.3.13, with isolated local socket binding enabled.
The five additional fixture files passed under both masks separately: 134 tests,
zero failures and 787 assertions.
Root and Trident typechecks passed (`tsc -p
tsconfig.json --noEmit` and `tsc -p trident/tsconfig.json --noEmit`). An additional
diagnostic run of the existing native
relay tests could not bind their temporary Unix sockets in the execution sandbox;
it does not establish a relay-suite pass. The required complete suite remains an
integration gate on the final candidate. Production authentication, permission
guards and the test runner are unchanged.
