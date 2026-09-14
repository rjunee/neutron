## 2026-09-14 — a deploy hands a live build to the next gateway

### What changed

The #538/#539 prerequisites had already replaced both blockers recorded by this item: herdr is the wired out-of-process host (`runtime/adapters/claude-code/persistent/herdr-host.ts:2-9`), the shutdown walk consults a locked durable pane-and-generation row before killing (`runtime/adapters/claude-code/persistent/pool.ts:1115-1133`), and boot reconciliation routes an identified pane into adoption (`runtime/adapters/claude-code/persistent/boot-adoption.ts:893-907`).

This change adds the missing composition proof. The new case installs the retiring wrapper in the real pool, invokes the real `shutdownAllPersistentRepls` walk, begins a fresh gateway lifetime, and enters through `createPersistentReplSubstrate` for the next turn (`runtime/adapters/claude-code/persistent/__tests__/adopted-repl-serves-a-turn.test.ts:311-343`). The observable result is one reply naming the surviving pane and pid, with zero host kills and zero new spawns (`runtime/adapters/claude-code/persistent/__tests__/adopted-repl-serves-a-turn.test.ts:328-343`). The host fixture now counts kills and models non-destructive detach separately (`runtime/adapters/claude-code/persistent/__tests__/adopted-repl-serves-a-turn.test.ts:138-140,185-225`).

The shutdown-survival suite's loopback listener setup is scoped to the group that performs the HTTP credential assertion, so listener-free real-teardown cases remain independently runnable (`runtime/adapters/claude-code/persistent/__tests__/gateway-shutdown-survival.test.ts:449-455`).

### Decisions

The chosen outcome remains workflow survival, not a second drain path. The shutdown survivor is allowed only when the durable row names the exact pane and generation (`runtime/adapters/claude-code/persistent/gateway-shutdown-survival.ts:78-110`); the next lifetime adopts that same pane rather than launching a replacement (`runtime/adapters/claude-code/persistent/boot-adoption.ts:893-907`). This uses the single path #539 installed.

Criterion 1 is ticked because the shutdown-to-useful-turn sequence now pins the composed behaviour (`docs/spec-items/a-deploy-must-not-kill-builds-in-flight.md:41-65`). Criterion 2 stays unticked: simultaneous failure of the durable registry and live reporting channels still leaves no deploy attribution for the next boot (`docs/spec-items/a-deploy-must-not-kill-builds-in-flight.md:68-90`).

The new outcome adds no error or verdict. It composes the existing `ShutdownSurvivalVerdict` vocabulary, whose two values are `survive` and `kill` (`runtime/adapters/claude-code/persistent/gateway-shutdown-survival.ts:52-59`). There is therefore no unclassified default.

### Mutation evidence

| Guard | Mutation and landing evidence | RED | Restored GREEN |
|---|---|---|---|
| The real shutdown walk takes the survival arm | `runtime/adapters/claude-code/persistent/pool.ts:1133` changed from `if (survival.kind === 'survive')` to `if (false && survival.kind === 'survive')`; the printed landing line showed the mutation at 1133 | `gateway-shutdown-survival.test.ts --test-name-pattern 'LEAVES a findable'`: expected `child.killed` false, received true | Same selection: 1 pass, 0 fail; restored line printed at 1133 |

### Verification

- `bunx tsc --noEmit` — green.
- `bunx eslint runtime/adapters/claude-code/persistent/__tests__/adopted-repl-serves-a-turn.test.ts runtime/adapters/claude-code/persistent/__tests__/gateway-shutdown-survival.test.ts` — green.
- `bun test runtime/adapters/claude-code/persistent/__tests__/gateway-shutdown-survival.test.ts --test-name-pattern 'LEAVES a findable'` — green after restoration.
- The full `adopted-repl-serves-a-turn.test.ts` file could not run in the restricted build lane: its existing reply-sink `beforeAll` was refused permission to bind loopback, before any test body ran. This is recorded as no result, not as green.

### Deliberately not done

No drain/defer path or feature switch was added. The survivor path replaces the formerly unavoidable shutdown kill for findable herdr panes (`runtime/adapters/claude-code/persistent/pool.ts:1127-1194`). Quarantined, unfindable, and in-process children retain the kill path because no next lifetime can safely recover them (`runtime/adapters/claude-code/persistent/gateway-shutdown-survival.ts:35-39`). The absolute reporting criterion was not ticked or weakened (`docs/spec-items/a-deploy-must-not-kill-builds-in-flight.md:68-90`).
