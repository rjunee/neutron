## 2026-10-07 — Isolate observer trust with the private test process table

The test launcher already masked native recovery and quota registrations, but
left the host observer pin visible. A present observer pin is checked for root
ownership by `runtime/adapters/codex-cli/codex_account_client.py:51` and `:68`;
that trust describes the host process table, not the private test namespace.

`trident/process-test-isolation.py:132` now includes
`/etc/neutron/codex-observer` in the existing explicit private tmpfs boundary.
The directory-presence check at `:141` avoids asking bubblewrap to create missing
parents through the host bind mount. Production pin validation and observer
transport selection are unchanged. `docs/testing-runner.md:158` documents all
three masked registrations.

The real synthetic installed/absent probe at
`trident/process-test-isolation.test.ts:47` now covers observer trust alongside
the existing roots. It checks the effective UID/GID, retained neighboring
configuration, writable private authority, original file contents and metadata,
and continued absence of an uninstalled root (`:69`–`:98`). The fixture mounts
its synthetic `/etc` read-only before invoking the actual launcher; it does not
write to live host configuration.

Verification: `bun test trident/process-test-isolation.test.ts` passed all
12 tests with 73 assertions through the authenticated private namespace. Removing
only the observer mask caused the installed observer probe to fail with
`live operator authority leaked into the test instance`; its absent-root sibling
still passed. Restoring the mask passed both observer probes with 16 assertions.
Namespace tests used host namespace permission; sandbox denial was not treated
as verification. Full admission consumer checks belong to the integrating PR.
