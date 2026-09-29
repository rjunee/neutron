## 2026-09-29 — Fair selection for bounded terminal decision sweeps

The project REPL owns build decisions under
`docs/spec-items/the-orchestrator-owns-the-build-loop.md` and the locked pivot
design §3.1. This repair changes selection in the existing store/composer path.
It does not establish the umbrella's unattended dispatch-to-merge criterion.

The previous query always returned the oldest five pending terminal runs.
Refusal correctly left them pending, but therefore made every later sweep
select them again. A production-composition test with five fenced wakes and a
sixth ready project reproduced starvation: the second sweep again attempted
only the first five. The test was red on the old selector.

`trident/store.ts` now reads a circular page ordered by
`(last_advanced_at, id)`, capped at five even when a caller requests more.
`open/composer.ts` retains the last attempted tuple between sweeps, advancing
in `finally` after an observer attempt. Inbox read failures leave that cursor
unchanged. Selection is read-only; completion remains the observer's write
after a durable post (`gateway/proactive/terminal-build-wake.ts:142-144`).
Restart resets the in-memory position to oldest first. Deleted or completed
cursor rows still define a position; no offset into a shrinking inbox is used.

The composed regression exercises real maintenance refusal, durable reply rows,
and completion stamps. It proves that the sixth project receives its reply,
the held rows remain pending with no leases, and reopening the held project
allows every row to complete once without exceeding five attempts per sweep.
Read-failure and observer-failure variants distinguish preserving a position
from advancing past an attempted row. Store controls cover timestamp ties,
wraparound, incoming rows, deletion, completion, restart, active and unroutable
rows, invalid limits and bounded larger-limit requests. The pre-existing store
ordering test now injects the clock: `save()` assigns `this.now()` and had
ignored the fixture's supplied snapshot timestamps.

The guarantee is progress across settling sweeps for a finite stable inbox.
It is not an end-to-end deadline. The chat runner sequences work with
`prior.then(work)` (`gateway/wiring/build-live-agent-turn.ts:1236-1239`);
`composeActingTurn` queues `dispatchSpec` at lines 1268–1270, and its timeout
starts inside that function at lines 1285–1287. Waiting behind an unsettled
earlier turn has no bound supplied by this four-minute acting budget. Repeated
restarts or an indefinitely growing inbox also have no fairness deadline from
this cursor. This change leaves those separate concerns unchanged.

Focused validation on base `14b211946a450569200a8d8c4cd0737cad2f6388` plus this
change: root `tsc --noEmit -p tsconfig.json` and
`tsc --noEmit -p trident/tsconfig.json` passed. The following single invocation
passed **830 tests, zero failures, 8,301 assertions** in 815.97 seconds:

```sh
bun test trident/store.test.ts \
  open/__tests__/open-terminal-build-wake-wiring.test.ts \
  open/__tests__/open-terminal-deploy-wake-wiring.test.ts \
  open/__tests__/project-build-e2e.test.ts \
  gateway/proactive/__tests__/terminal-build-wake.test.ts \
  gateway/wiring/__tests__/build-live-agent-turn-admission.test.ts \
  gateway/wiring/__tests__/build-live-agent-turn-overlap.test.ts \
  runtime/workers/claude-composer.test.ts \
  runtime/workers/claude-acting-turn.test.ts
```

The initial sandboxed two-file run passed 182 tests but could not bind the
existing loopback socket fixture; the complete focused run above included that
fixture with the required local test permissions. Dependencies were installed
offline from the unchanged frozen lockfile, with workspace links resolving into
the tested checkout.

After the focused run, removing the composer's cursor argument restored oldest
selection: all three `five held wakes` variants failed. Restoring the argument
passed all three with 87 assertions. The restored production blobs matched the
tested source: composer `1f346a4e66925e1fe17b65fb5c88c522edc929f5`, store
`5c4afa0bb64d6af2384aa5a0fe9b32f93a27f33c`. `git diff --check` passed; regenerating
the spec index produced no diff.

A direct-worktree purity scan failed on local worktree metadata and matches
from the configured local denylist; it is not a clean publication receipt.
The configured tracked-tree purity check, complete host suite, exact-head CI,
cross-model review and deployment remain publication gates.
