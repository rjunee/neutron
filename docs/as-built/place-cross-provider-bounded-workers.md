## 2026-09-24 — Place cross-provider bounded workers in their project Herdr workspace

Refs #1226 (the issue stays open). Cross-provider bounded workers now get a visible,
correctly labelled tab in their dispatch's project Herdr workspace. That covers headless
Claude plan, review and synthesis under a Codex owner, the Codex build wrapper, and the
Codex review seat under a Claude owner. General-scoped runs land in `Neutron General`.

### Design: the tab is a view of the worker, not the worker

Herdr has no exit codes; it offers rendered screens. The worker's evidence is its pipes,
its trailer and receipt files, and its exit status. Moving the worker into a pane would
turn that evidence into a screen, and starting a second worker for the tab would be a
second provider process. Neither is allowed, so the worker stays the runner's native
detached child, exactly as before. Two things are added:

- The runner copies the SAME stdout bytes it decodes into a private per-step view file
  (`claude-headless.ts:211`, `codex-headless.ts:261`, `codex-review.ts:184`).
- Once the native child exists, the runner places a tab
  (`claude-headless.ts:175`, `codex-headless.ts:266`, `codex-review.ts:172`). The tab
  runs a small, credential-free follower of that file. Its argv is `env -i` plus the bun
  binary plus `VIEW_FOLLOW_SCRIPT` plus the view path
  (`runtime/workers/worker-placement.ts:106-127`). It never names `claude`, `codex` or
  `codex-build.sh`, and it never receives a gateway credential.

Placement goes through the strict `createProjectWorkspaceHost`, so every tab is created by
`ProjectWorkspaceManager.applyLayout`. On the first worker in a scope, that means
`workspace.create`, the reserved Chat placeholder, `tab.move` of Chat to index 0, and then
the worker `layout.apply`. The tab label is `<Role> · <task>`, where the task is the card
slug, capped at 48 characters (`workerTaskLabel`, `worker-placement.ts:95`).

The host detaches from the pane at once. Nothing polls or reads its screen, which the
tests assert with an immediate output gate and a 10ms poll. Placement runs beside the read
path and never in front of it. `finish()` appends an exit marker, closes the pane
(bounded), and records the receipt.

### Wiring

- `open/wiring/project-build.ts` builds one `createWorkerPlacement` per dispatch from
  `context.workerTerminal`. It hands that placement and `taskName: run.slug` to both
  `createClaudeHeadlessRunner` and `createCodexHeadlessRunner`. The Codex runner forwards
  it to the review seat transport.
- `open/composer.ts` creates ONE shared host for all dispatches, lazily, through
  `createWorkerTerminalHost(projectBuildStateRoot, { env })`. Sharing it means one manager
  serializes placements per scope. The scope comes from `workerPlacementScope`, using the
  run's own work-board scope key:
  - The owner slug is General, which becomes `projectId: null` and `Neutron General`.
  - A project whose id is literally `general` keeps that id and gets its own workspace.
  - The label is the project's name from `projects`, or its id if there is no name.
- `open/wiring/project-build-terminal.ts` returns `null` unless the configured terminal
  host is Herdr. A test runner (bun pty under `NODE_ENV=test`) or a bun-host service
  therefore never touches a live Herdr. The journal lives in the private
  `herdr-workspaces/` directory under the build state root. The state reaper only removes
  directories named for terminal runs, so it leaves this one alone.
- Same-provider work is unchanged. `createProjectRunners` uses the headless runner only for
  the other provider, so the native in-REPL child is never placed
  (`project-runners.test.ts`, "native same-provider work is never placed").

### Policy on placement failure: unplaced execution, evidence preserved

If there is no Herdr host, or the manager refuses (ownership mismatch, invalid scope,
connect failure, a failing `workspace.create` or `layout.apply`), or placement exceeds
15s, the worker runs exactly as it would without a terminal. The step's
`<key>.placement.json` receipt records `unplaced` and the reason:
`herdr-unconfigured`, `placement-refused: …`, or `placement-timeout after …`.

There is never a fallback to an inherited or ambient workspace, and every recorded
`layout.apply` names a workspace the manager created. The build's outcome, result and usage
are identical to an unplaced run. Blocking or failing the build over a missing view would
put an invisible display surface in front of real work, so this policy was chosen instead.

### Invariants and their tests (positive and refusing)

| Invariant | Tests |
| --- | --- |
| Evidence comes from pipes, files and exit status | "screen-independence" in the claude-headless, codex-headless and codex-review suites: a success-shaped screen, and a forced `pane.read` reply, leave a failed worker failed, with the same outcome as the unplaced baseline |
| One worker process per dispatch | The "placed …" tests in each suite: exactly one CLI, wrapper or model-turn invocation, an outcome identical to baseline, and the view file holding the decoded bytes |
| Cancellation kills the whole process group | "cancelling a placed …": a forked grandchild dies; every `process.kill` target is `-<worker pid>` and never the gateway's own group; the view pane is closed |
| Restart adopts, with no duplication | "restart adopts …": a fresh runner reads the durable receipt with zero new CLI invocations and zero new tabs, and closes the stale pane recorded in the placement receipt (`claude-headless.ts:323`, `codex-headless.ts:294`, `codex-review.ts:120`) |
| Placement failure is unplaced and never ambient | worker-placement.test.ts (four failure modes); "placement failure …" in each worker suite; the E2E "a refused placement …" and "no terminal host …" |
| Native children unchanged | project-runners.test.ts, with the cross-provider positive control |
| General never becomes `general` | worker-placement.test.ts (two workspaces, two journal rows); project-build-terminal.test.ts; the E2E "General-scoped Codex review seat …" |

The exact RPC sequence of a worker-role spawn through the strict host, and the refusal of
an unplaced spawn with zero `layout.apply`, are pinned in
`herdr-project-placement.test.ts`. The consuming E2E
(`open/__tests__/project-build-e2e.test.ts`) drives `prepareProjectBuild` with a real
strict host over a scripted Herdr server. It asserts `Plan · <slug>`, `Review · <slug>`,
`Review · <slug>` and `Synthesis · <slug>` tabs in the project's workspace, and a merged
build.

### Mutation results (run by hand)

- Dropping `placement: workerPlacement` from the Claude runner in
  `open/wiring/project-build.ts` turns the E2E "Codex owner: every cross-provider Claude
  worker gets a labelled tab …" red. The same test is green unmutated, and the
  `project-build-terminal.test.ts` control stays green.
- Targeting `child.pid` instead of `-child.pid` in `claude-headless.ts` turns "cancelling
  a placed worker kills its own process group …" red.
- Removing the view's `detach()` in `worker-placement.ts` turns the Claude "placed worker
  …" test red, because the host starts reading the pane's screen.

### Out of scope, still open

This does not retire the Chat placeholder or change conversation placement. It does not
cover General owner admission or credential handoff, or the sleep and wake lifecycle. No
acceptance box in `docs/spec-items/project-herdr-workspaces.md` is ticked.
