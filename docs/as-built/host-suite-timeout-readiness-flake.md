## 2026-09-28 — Keep host suite timeout proof independent of worker startup

The host suite timeout starts when the process owner is spawned, before the
worker interpreter is ready (`trident/host-suite.ts:60-73`). The timeout test
required a heartbeat from that worker first, so a busy CI runner could satisfy
the timeout contract and still fail the test with a zero heartbeat.

The timeout test now verifies that the result remains interrupted evidence even
if the deadline arrives before worker readiness. Its finite worker fallback
still makes disabled timeout signalling return an ordinary zero exit. Separate
tests wait for live TERM-resistant heartbeats before cancellation, verify their
cessation, and require an unrelated sibling suite to keep advancing without
receiving TERM. Their fixtures now have cooperative release files, so a broken
descendant kill fails at the advancing heartbeat instead of hanging
(`trident/host-suite.test.ts:154-196`). The low-timeout test retains explicit
coverage of timeout before worker readiness. No production cancellation code
changed.

Verification: the final focused host suite passed three consecutive runs (26
tests each), the consuming Open end-to-end file passed 379 tests, and root and
Trident typechecks passed. Scoped mutations each failed as intended: disabling
the host timeout signal yielded an ordinary zero exit; disabling descendant
SIGKILL left the target heartbeat advancing; sharing the cancelled signal with
the sibling exposed a TERM marker. Each mutation was restored before the final
focused runs.
