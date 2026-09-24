## 2026-09-24 — Contain the recorder race test without a process-wide audio mock

The recorder release-race test replaced `expo-audio` with `mock.module`, which Bun retained across later test files in the device lane. Its inert playback exports displaced the observable harness player, so the playback test passed alone but failed when the whole lane ran. Before this change, the same 42-file device command exited 1 with 399 passing and 10 failing tests, all in playback.

The recorder test now uses the existing harness audio stub and sets a per-test gate on `prepareToRecordAsync`. It releases that gate at the precise mid-start point each case exercises, and clears it after the file. The test no longer replaces a process-global module. A first attempt to forward the harness exports through a persistent module mock passed a two-file probe but stalled twice in the complete lane, so it was discarded.

With the module mock removed, the identical 42-file command exited 0: 409 passing, 0 failing. The same device lane passed 409/0 inside the partitioned full suite. App TypeScript typecheck and the 51-config typecheck matrix passed. As a reverse check, temporarily bypassing the new prepare gate made the tap mid-start race case fail (3 passing, 1 failing); the bypass was removed and the gate restored. This establishes that the test still distinguishes a blocked native prepare from an immediate one.

The local partitioned full suite executed all 1,660 discovered files but exited 1: 9 of 18 lanes failed. Seven general chunks had failures outside these changed app test files, as did the PGLite lane after three attempts and the real-HTTP lane; the latter logs include real GBrain serve timeouts and listener bind failures. The local full-suite result is red, not a passing gate receipt. CI remains the merge gate.

Refs #1242.
