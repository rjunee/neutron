## 2026-09-26 — Drain chat recovery before persistent owner teardown

Refs #1342 and the restart spec's retry-and-fencing requirement
(`docs/spec-items/a-gateway-restart-keeps-the-project-repls.md:143`). Recovery's
stop previously ran only among late composition cleanups, after persistent REPL
shutdown had stopped supervision timers. A held recovery could settle between
those phases and rearm timers that no subsequent phase stopped.

The composition now exposes an awaited `on_shutdown_start` hook. The gateway
invokes it before graph and persistent REPL teardown, and before graph disposal
on post-composition boot failure. Open wires the same idempotent recovery drain
there and retains it in ordinary cleanup for direct-composer disposal. The
scheduler exposes its stop handle synchronously, before its first pass runs;
graph readiness still awaits that pass. A drain failure does not authorize
teardown to race unfinished recovery. Autonomous retry cadence and native
provider authority are unchanged.

Six focused tests passed (24 assertions): held recovery blocks mocked persistent
teardown, settled recovery permits it, recovery-created timers stop at teardown,
and unavailable-host retry still runs without client traffic. Stopping during a
held first pass drains it; stopping before that pass prevents it from starting.
The test boots a
temporary local gateway with stub platform and mocked persistent-process
teardown; no provider or terminal daemon is launched or signalled. Moving the
hook back after REPL teardown made the held-recovery control fail because
teardown had already run. Restoring the ordering restored the passing result.
Root and Open TypeScript checks passed. Full-suite and served restart evidence
remain coordinated integration gates, not receipts earned by this correction.
