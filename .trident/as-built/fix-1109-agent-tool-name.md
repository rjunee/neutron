## 2026-09-17 — the granted subagent tool must be the one the CLI exposes (#1109)

### What changed

`SUBAGENT_TOOL_NAME` is defined once at `runtime/workers/claude-in-repl.ts:19`
and consumed in two places that previously named the tool independently:

- the dispatch prompt interpolates it (`runtime/workers/claude-in-repl.ts:83`);
- the live grant list imports it (`gateway/wiring/build-live-agent-turn.ts:70`,
  inserted at `:354`).

The literal `'Task'` is removed from the grant array. It is not kept beside the
new name: there is no second path and no flag.

Gateway depends on runtime and never the reverse (`gateway/wiring/build-live-agent-turn.ts:70-72`
already imports `@neutronai/runtime/...`), which is why the constant lives in
runtime rather than in the gateway file that grants it.

### The breaking version, recorded because the next rename should cost minutes

**Claude Code 2.1.273**, installed 2026-09-16 20:32:39 UTC — `/var/lib/neutron/.cc-version`.
That release renamed the subagent tool `Task` → `Agent`.

Between that upgrade and this change, every trident dispatch was refused. The
REPL issued a correct call and received:

```
No such tool available: Agent. Agent is disabled for this session,
in subagents as well as here.
```

Measured consequences, all from the live instance:

| run | elapsed to `build-driver-settled` |
|---|---|
| `b4f22a9d` | 42.6s |
| `a5ad7c49` | 44.5s |
| `5dbe37c8` | 43.7s |

Each is spawn + `DISPATCH_TIMEOUT_MS`: the Agent call fails instantly, then the
host waits out the budget for metadata that can never be written. The session's
`subagents/` directory holds five `agent-*.meta.json` files, all dated 00:18 to
04:16 — before the upgrade, when `Task` still existed. None since.

### The test pinned the defect

`runtime/workers/claude-in-repl.test.ts` previously asserted the grant list
contains `'Task'`, under the name *"live conversational tool surface grants the
CLI Task name"*. It therefore passed **because** the grant was wrong: a guard
cannot catch a rename it is pinning.

It now asserts the grant and the prompt AGREE through the shared constant, and a
separate case pins the constant to the name this CLI exposes. The entry check
strips comment lines so prose about the old name cannot fail the negative.

### Mutation table

| # | Mutation | Result |
|---|---|---|
| M1 | grant reverts to the literal `'Task'` — the actual bug | 26 pass, 1 fail |
| M2 | prompt restates the name instead of using the constant | 26 pass, 1 fail |
| M3 | constant reverts to the pre-2.1.273 name | 26 pass, 1 fail |

Restored: 27 pass, 0 fail. `bunx tsc` clean for both `gateway` and `runtime`
tsconfigs; `bash scripts/ci/lint.sh` clean.

### NOT verified by this branch

**A real dispatch reaching `plan:0` on 2.1.273.** Every test here drives a fake
`composeActingTurn`; none spawns the CLI, so none can prove the live tool surface
accepts the call. That acceptance is inherently post-deploy — the live run cannot
happen until this is deployed — and it is discharged by a real card dispatch
after the deploy, not by this suite. A green run here is not evidence of it.
