## 2026-09-19 — Isolate the Open Trident boot fixture and expose launch failures

The production-composition test now fixes and restores the instance model provider and clears project model routes while it runs. Its launch assertion compares the complete result, so a future `failed` response shows the launcher's error instead of only a status mismatch.

CI shard 4 had one `pi` launch fail before host construction, but the launcher error was not printed. The failure did not reproduce in an isolated run, twenty repetitions, or a local replay of the exact 100-file shard chunk. This is test isolation and diagnostic coverage, not a verified production root-cause fix. The next CI run must be checked for a recurrence and its error.

Both provider arms pass with deliberately hostile ambient model settings; replacing the project selection with `anthropic` fails the `pi` arm, and replacing it with `pi` fails the `anthropic` arm. The consuming project-build end-to-end file passed all 100 tests, and the Open TypeScript project type-checked.
