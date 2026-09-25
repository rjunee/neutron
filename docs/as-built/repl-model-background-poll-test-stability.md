## 2026-09-25 — Synchronize the REPL model poll race test with the request

Refs #1320. Governing spec: `docs/spec-items/repl-model-background-poll-test-stability.md`.

The device test for a background REPL model read racing an acknowledged switch could fail at its setup assertion under shared host load. It slept 5.1 seconds for a production interval scheduled at 5 seconds and then assumed the second GET had begun. The same timing assumption was present in the test that discovers an owner after opening the screen.

The mock now signals the GET count when a request starts, and those two cases wait for the second GET before asserting on its effects. The model control and its 5-second production poll are unchanged. The race still holds the background response until after the switch is acknowledged, then checks that the displayed model remains the acknowledged one.

The focused 18-test file passed, including the positive case that applies the next focus GET after it completes, and two concurrent reruns of the race case passed. A temporary reverse mutation removing the component's generation check made that case fail with `Model: cheap` instead of `frontier`; the guard was restored. Root, app and Trident TypeScript checks passed. This validates the test synchronization locally; it does not constitute a shared-host or served-product receipt.
