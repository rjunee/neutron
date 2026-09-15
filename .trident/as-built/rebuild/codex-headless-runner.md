## Codex headless runner

### What changed

Added the `openai-codex` `WorkerRunner` at `runtime/workers/codex-headless.ts:73-146`. It probes CLI/login availability before admission (`runtime/workers/codex-headless.ts:25-35`), accepts only cross-provider headless build/fix turns (`runtime/workers/codex-headless.ts:79-87`), waits directly on the spawned wrapper (`runtime/workers/codex-headless.ts:108-123`), and constructs successful outcomes only from the requested trailer file (`runtime/workers/codex-headless.ts:125-139`).

The spawn boundary removes every `GH_*` and `GITHUB_*` variable while retaining unrelated environment values (`runtime/workers/codex-headless.ts:37-41`, `runtime/workers/codex-headless.ts:98-108`). Both existing wrappers now select `codex exec resume <thread_id>` when continuity is requested (`trident/codex-build.sh:1445-1449`, `trident/codex-review.sh:536-541`). The existing `--sandbox danger-full-access` argument remains unchanged at `trident/codex-build.sh:1449`, as required by the lane brief.

### Decisions

The runner supports `build` and `fix`; other roles join the contract's existing `capability-unsupported` refusal vocabulary and default to `refused`, never `failed` (`runtime/workers/codex-headless.ts:23`, `runtime/workers/codex-headless.ts:83-96`). Non-headless placement similarly uses `placement-unavailable`. CLI/login probe failures use `provider-not-connected`. Wrapper exit 3 uses `cli-contract`; missing or malformed success trailers remain `unknown`; actual process failures use the existing `failed` classes (`runtime/workers/codex-headless.ts:118-139`).

`needs_approval_decision` remains literally `false` in the shared contract (`runtime/bounded-work.ts:77-87`) and the compile-time regression is at `runtime/workers/codex-headless.test.ts:70-74`.

### Mutation table

| Guard | Compiling mutation | Red evidence | Restored green |
| --- | --- | --- | --- |
| Trailer is the result source | Read `req.brief.path` at `runtime/workers/codex-headless.ts:127` | trailer test received `unknown`, expected `completed` | runner file green |
| Spawn credential scrub | Retain all names at `runtime/workers/codex-headless.ts:38` | child environment contained `GH_TOKEN` | runner file green |
| Startup admission probe | Return support unconditionally at `runtime/workers/codex-headless.ts:86` | startup-probe test received `{ok:true}` | runner file green |
| Unsupported role refusal | Add `arbitrate` at `runtime/workers/codex-headless.ts:23` | capability test received `{ok:true}` | runner file green |
| Build thread resume | Make the resume condition false at `trident/codex-build.sh:1445` | argv was `exec --strict-config -c`, not `exec resume thread-42` | build wrapper file green |
| Review thread resume | Make the resume condition false at `trident/codex-review.sh:537` | argv was `exec --model gpt-5.6-sol`, not `exec resume thread-42` | review wrapper file green |

The restored focused files passed 164 tests with 611 assertions: `runtime/workers/codex-headless.test.ts`, `trident/codex-build.test.ts`, and `trident/codex-review.test.ts`.

The runtime and Trident TypeScript projects passed in the 51-project typecheck matrix. The matrix as a whole remained red on pre-existing diagnostics in `app/tsconfig.json`, `gateway/transcription/__tests__/whisper-install.test.ts:186`, `logger/__tests__/fire-and-forget.test.ts:301`, and `onboarding/history-import/__tests__/zip-writer.ts:10`. Repository lint passed every reported gate.

### Deliberately not changed

The changed-file list was enumerated by combining `git diff --name-only feat/bounded-work-contract` with `git ls-files --others --exclude-standard`: it contains only the runner, its test, the two wrappers and their tests, plus this record. The runner invokes the existing measured-trailer wrapper rather than duplicating its git, integrity, or atomic-rename gates. The build wrapper's sandbox argument remains byte-for-byte unchanged at `trident/codex-build.sh:1449`.
