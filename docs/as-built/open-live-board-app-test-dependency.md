## 2026-09-30 — Declare the app workspace used by the Open live-board consuming test

The workspace import at
`open/__tests__/work-board-recovery-refusal-live.test.ts:10` passed with a manually
linked local dependency layer but failed in CI's frozen install: Open and root
typechecks reported TS2307, and the test shard failed to load the same module.
`open/package.json:40` now declares `@neutronai/app` as a workspace development
dependency, with the matching entry at `bun.lock:494`. The existing development
dependency at `open/package.json:41`, consumed by
`open/__tests__/project-build-e2e.test.ts:63`, provides the same test-only pattern.
No production imports or external dependency versions changed.

A real frozen isolated install created the package-local app link, and the
repository dependency verifier passed. Removing only the declaration and lock
entry, clearing the stale app link, and repeating the frozen install left the
actual TypeScript resolver unable to resolve the consuming import. Restoring
the declaration and lock entry recreated the link and resolved the same source.
This paired control avoids treating a leftover manual link as dependency proof.

Root, Open and Trident TypeScript checks passed. The affected live-board consuming
file passed one test with 14 assertions; the full lint gate passed. New-head full
CI remains required. Historical broad test receipts are not attributed to this
dependency-only repair, and no live or deployed acceptance is claimed.

The native-child ownership control at
`open/wiring/__tests__/project-build-native-child-lease.test.ts:103` now uses a
bounded five-second observation budget. CI spent 277 milliseconds in that
non-deadline case against the shared fixture's 50-millisecond budget and returned
`unknown` before observing the parent turn end. Its malformed-trailer and held
lease assertions are unchanged; the uncertainty controls retain 50 milliseconds.
This is test scheduling slack, not a runtime authority or deadline change.
The complete native-child lease file passed seven tests with 45 assertions;
root and Trident TypeScript checks passed with the combined repair.
