## 2026-09-28 — Share a crash-recoverable observation-journal lock

The explicit phase recorder, manual native turn registration and private dashboard
refresh previously coordinated through a create/unlink `.lock` marker. A process
death during append left the marker behind, so replay could not reach the partial
record repair path. Deleting a marker based on age or PID would risk bypassing a
live writer or a reused PID.

The public recorder and registration command now use one shared, permanent
mode-0600 lock-file inode and a nonblocking kernel advisory lock. The paired
private refresh candidate imports that same helper from its public checkout;
it must pin this change before activation. The kernel releases ownership on
process death; callers never unlink a valid marker.
Old empty or foreign create/unlink markers fail closed for an operator-supervised
transition after former writers have exited. The journal and checkpoint remain
unchanged by the lock migration itself.

Evidence: the focused public recorder and registration suites pass, including a
live-holder refusal, process-kill release, stable-inode check, and legacy-marker
refusal. The deploying consumer separately tests a partial append held across a
process kill, retry, exact replay, and subsequent explicit recording. Both
repositories typecheck against this candidate pair. No host service, environment
or observation journal was changed by this PR.
