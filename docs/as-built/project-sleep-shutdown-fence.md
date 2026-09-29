## 2026-09-29 — Fence project sleep during gateway shutdown

Refs #1342 and #1226. The workspace target says gateway restart is not a sleep
event (`docs/spec-items/project-herdr-workspaces.md:78`). Composition calls the
scope lifecycle's teardown (`open/composer.ts:1718`), but clearing its existing
timers did not invalidate a sampled sleep or prevent a late retry/finalizer from
arming another timer. Both consuming regressions first failed by observing a
real Chat retire after lifecycle teardown.

The lifecycle now closes permanently for its gateway lifetime. Sleep checks this
state at entry and before requesting retirement, and the pool's final synchronous
`stillIdle` callback checks it again (`open/wiring/project-scope-lifecycle.ts:502`,
`:549`). That callback is consumed immediately before process termination
(`runtime/adapters/claude-code/persistent/pool.ts:566`). Teardown also prevents
timer rearming (`open/wiring/project-scope-lifecycle.ts:607`). Retirement already
started before teardown is not undone; subsequent workspace cleanup is left for
reconciliation when teardown has begun.

The consuming controls (`open/__tests__/project-scope-sleep.test.ts:513`, `:546`)
hold retirement or an idle census across teardown and inspect the real pool
child, Herdr close requests, durable asleep marker, and timer-driven sleep
outcomes. A fresh lifecycle reuses the same owner and can sleep it normally.
Removing the final shutdown fence fails the survival control; unconditionally
refusing at that fence fails the fresh-lifecycle control. Removing the timer
guard separately fails the observed sleep-attempt count. All mutations were
restored.

Validation: focused workspace/lifecycle and credential-handoff tests passed
(99 tests across four files); root and Trident TypeScript checks passed. The
full partitioned gate is coordinated on the integrated candidate. These fixture
results do not claim deployed restart/reboot acceptance, migrated legacy panes,
or safe retirement of any live helper. No live pane was closed.

The local whole-tree purity scan failed on the linked-worktree pointer and
existing-tree denylist matches; it is not reported as a passed gate. Publication
and merge still require the integrated candidate's checks.
