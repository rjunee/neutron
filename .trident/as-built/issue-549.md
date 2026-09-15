## Issue 549 — scheduled wakeups honour paused builds

### What changed

The scheduled-wakeup prompt now confines progress to the current inline turn and explicitly forbids dispatching or restarting a background build (`gateway/proactive/work-wakeup.ts:407-409`). When an item remains bound to a stalled run, the prompt tells the agent to leave that run parked instead of stopping, reaping, replacing, or restarting it (`gateway/proactive/work-wakeup.ts:397-403`).

The guard is applied by `buildWakeupPrompt`, the shared prompt constructor exported to production and tests (`gateway/proactive/work-wakeup.ts:351-369`). It does not introduce an error or verdict, so it adds nothing to the existing outcome vocabulary; the existing `BLOCKED:` reply route remains unchanged (`gateway/proactive/work-wakeup.ts:410-413`). The regression test continuously maintains the prompt invariant for both unbound and stalled work (`gateway/proactive/__tests__/work-wakeup.test.ts:688-708`).

### Decisions

Both dispatch invitations were removed. Removing only the general tool-list invitation would have left the stalled-run branch authorizing replacement dispatch; that branch previously occupied `gateway/proactive/work-wakeup.ts:397-401` and is now the leave-parked instruction at `gateway/proactive/work-wakeup.ts:400-402`.

The tool surface was deliberately not narrowed. Its exact injected shape is already a safety property tested at `gateway/proactive/__tests__/work-wakeup.test.ts:130-134`; the behavioral boundary belongs in the scheduled-wakeup prompt because the same tools remain necessary for inline progress.

No `SPEC.md` decision or spec item changed: this change enforces the issue's existing behavior rather than changing the product target.

### Mutation evidence

| Guard | Mutation | Red | Restored green |
|---|---|---|---|
| Scheduled wakeups say “Never dispatch work or start/restart a background build” (`gateway/proactive/work-wakeup.ts:409`) | Replaced “Never” with valid permissive text, “You may”; printed the mutation at line 409 | `a scheduled wakeup acts inline and NEVER dispatches or restarts a background build`: 0 pass, 1 fail | Same named test: 1 pass, 0 fail |

The complete touched test file passed 39 tests with 123 assertions. `bash scripts/ci/lint.sh` passed every gate. `bash scripts/ci/typecheck-all.sh` checked 51 configurations but remained red on unrelated existing errors in `app/tsconfig.json`, `gateway/transcription/__tests__/whisper-install.test.ts:186`, `onboarding/history-import/__tests__/zip-writer.ts:10`, and `logger/__tests__/fire-and-forget.test.ts:301`; none is modified by this change.

### Deliberately not done

The wakeup loop, work selector, background tool list, and result taxonomy were not changed. The defect is the two prompt authorizations, while prompt construction already feeds the production sweep (`gateway/proactive/work-wakeup.ts:576-588`) and the loop still reports the same existing counters (`gateway/proactive/work-wakeup.ts:430-437`).
