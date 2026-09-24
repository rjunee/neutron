## 2026-09-24 — Exercise device deadlines on the harness clock

Three project/session-cache regression cases waited for production
eight- and fifteen-second deadlines. They now advance the existing harness
clock through the production timers. React's zero-delay flushing remains real;
the clock is restored after each test. The independent failure watchdog uses real
timers so a stalled assertion still fails promptly while the harness clock is
paused. Production deadlines and code are unchanged.

The tests assert pending state immediately before the deadline, expiry at the
deadline, and the resulting retry/socket or error surface. Healthy construction
just before expiry remains cached, and completed settings requests cancel their
abort timers. Both original consuming test files and the complete device lane
still execute; no test selection or gate changes.

On the same checkout and host, the two files improved from 14 passing tests in
36.50 seconds to 15 passing tests in 3.71 seconds. The complete device lane passed
411 tests across 43 files in 50.60 seconds. The earlier live suite measured that
lane at 83.51 seconds; that cross-run comparison is observational, not a controlled
benchmark. No p95 claim is made from these samples.

Semantic mutation controls changed the actual production timer call sites:
delaying both deadlines one hundredfold made three consuming assertions fail;
firing both at half the deadline made four fail, including healthy construction.
Restoring the production code returned the suite to green. Both TypeScript
projects and lint are checked before publication. This is a bounded test-runtime
improvement under the existing build-efficiency specification, not completion
of its wider recovery, scheduling, or deployed measurement criteria.
