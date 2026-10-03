## 2026-10-03 — Isolate fake native lifecycle fixtures from host provisioning

Fake PTY and registry fixtures assumed an unregistered self-host. A provisioned
relay changes both authentication fingerprints (`repl-session.ts:903`) and
spawn registration (`native-request-relay.ts:12`), so those fixtures could fail
before reaching their lifecycle assertions. The four persistent adapter test
files now select the unregistered route through per-test spies for both capacity
reads, restoring them after each test. The same explicit route selection covers
the HTTP replay, Open boot adoption and conversation credential handoff fixtures:
`gateway/http/__tests__/replay-redelivery.test.ts:47–58`,
`open/__tests__/boot-live-agent-adoption.test.ts:193–198` (restored at `239–240`)
and `open/__tests__/conversation-credential-handoff.test.ts:48–64`. Their replay,
secret-freshness and busy-owner assertions remain the behavior being exercised.
See
`runtime/adapters/claude-code/persistent/__tests__/spawn-failure-revokes-credential.test.ts:29–39`,
`spawn-setup-uncertainty.test.ts:13–24`, `operator-cap-rearm.test.ts:19–28` and
`evict-deletes-only-its-own-entry.test.ts:54–77` in that directory.

The Codex boot fixture explicitly applies its intended private or non-private
directory mode after creation, because a restrictive umask otherwise converts
the negative permission case into a private directory
(`open/__tests__/open-trident-prod-boot-wiring.test.ts:154–156`). Its existing
recovery assertion still distinguishes the authorized private case from the
negative cases (`open-trident-prod-boot-wiring.test.ts:187`). This is a test-only
repair under the registered/unregistered contract in
`docs/spec-items/claude-same-agent-continuation.md:18–24`.

Validation used base revision `261e5dec0d55fc57fbc109f5b2c9e869a31fb1b0` plus
this test-only diff. From the repository root, `bun test` with the four
persistent test files named above and the Open boot test passed **52 tests,
0 failures** under `umask 0022`. The same command under `umask 0077`, adding
`runtime/adapters/claude-code/persistent/__tests__/native-request-relay.test.ts`,
passed **55 tests, 0 failures**. Those additional controls exercised registered
socket launch and refused unknown process/dead socket registration
(`native-request-relay.test.ts:8`, `native-request-relay.test.ts:35`) in the same
process as the scoped spies. Root `bunx tsc --noEmit` and
`bunx tsc --noEmit -p trident/tsconfig.json` both exited 0, including after the
three HTTP fixture additions. A separate delta command naming the three HTTP
files above plus `native-request-relay.test.ts` passed **53 tests, 0 failures**
under each of `umask 0022` and `umask 0077`. These receipts cover the eight changed
test files in two focused subsets; they are not a combined eight-file run.
The initial sandboxed
subset could not bind its scratch loopback sink; successful test receipts used
the approved execution environment with loopback binding available. The full
shared-host gate and publication validation remain the integrating change's
responsibility; these receipts establish focused behavior only.
