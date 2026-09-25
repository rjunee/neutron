## 2026-09-25 — Pin read-only test path admission at the dispatcher

The #1294 classifier and its later trailing-write repair were already on main.
This change adds a consuming `dispatchBoardBoundBuild` control: running the
existing Open E2E test starts beside a live run that claims its path, while an
edit of that same test is held with the writer's run recorded and no extra run
row. The test exercises the actual admission and hold path with a real store.

The parser, store, dispatcher and identity registry suites passed 271 tests
together on the publication base. Root and Trident TypeScript checks passed.
The full Open E2E and shared-host suite are separate publication gates.
