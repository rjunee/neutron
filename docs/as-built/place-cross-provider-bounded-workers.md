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
  (`runtime/workers/worker-placement.ts:130-155`). It never names `claude`, `codex` or
  `codex-build.sh`, and it never receives a gateway credential.

Placement goes through the strict `createProjectWorkspaceHost`, so every tab is created by
`ProjectWorkspaceManager.applyLayout`. On the first worker in a scope, that means
`workspace.create`, the reserved Chat placeholder, `tab.move` of Chat to index 0, and then
the worker `layout.apply`. The tab label is `<Role> · <task>`, where the task is the card
slug, capped at 48 characters (`workerTaskLabel`, `worker-placement.ts:119`).

The host detaches from the pane at once. Nothing polls or reads its screen, which the
tests assert with an immediate output gate and a 10ms poll. Placement runs beside the read
path and never in front of it. When the worker exits, `release()` appends an exit marker
and starts the bounded, identity-verified close without waiting for it (see the review
round below); the close records the receipt.

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
| Restart adopts, with no duplication | "restart adopts …": a fresh runner reads the durable receipt with zero new CLI invocations and zero new tabs, and closes the stale pane recorded in the placement receipt (`claude-headless.ts:323`, `codex-headless.ts:296`, `codex-review.ts:120`) |
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

### Review round 2026-09-24 (PR #1269 review comment 5817470299)

An independent review of the first build (`5d1dd603`) found two P1 defects. Both are
fixed on top of that commit; the placement-failure policy above is unchanged.

**P1-A: retire closed a saved pane id without re-checking what it named.** At
`5d1dd603`, `retire()` (`worker-placement.ts:237-240`) read `{state:'placed', pane}` and
called `closeHandle(pane)`, which only checks the protocol and sends `pane.close`. A Herdr
restart re-issues pane ids, so a stale receipt could close replaced work (spec lines
24-28 and 39-42).

- The `placed` receipt now records the follower identity seen at placement: `pane`, the
  host-reported `pid`, the `viewPath` the follower tails, and the `taskLabel`.
- Every close goes through one path, `closeOwned` (`worker-placement.ts:250`). That covers
  the in-run close, the late close after a placement timeout, and `retire()`
  (`worker-placement.ts:340`). It calls `inspectHandle` first (pane.get plus
  pane.process_info) and decides with `followerOwnsPane` (`worker-placement.ts:195`):
  - `gone` is a positive absence: the receipt becomes `closed` and no `pane.close` is sent.
  - Unknown identity is refused, with no `pane.close`, and the receipt stays `placed` so a
    later retire can look again. Unknown means the host is unavailable or times out, the
    process sample has an empty argv, or the receipt is a legacy one with no identity.
  - Changed identity is refused and recorded as `disowned`, so it is never targeted again.
    Changed means the argv does not end with the recorded view path, lacks the exact
    follower script, or shows a different pid.
  - The pane label is never consulted.
- A late pane after a placement timeout is closed by the same path. The `unplaced`
  timeout verdict is only rewritten back to the identity-bearing `placed` record when
  that pane could not be retired, so a later retire still has a target.
- Only one side, the attempt or the timeout, ever writes the placement verdict.

**P1-B: waiting for view cleanup could expire a finished worker.** At `5d1dd603`,
`claude-headless.ts:367` ran `finally { await view.finish() }` before `expired()`, the
decode, the receipt and the publish. `finish()` could wait up to 15s for placement and
then 5s for the close. The same shape existed in `codex-headless.ts:269` and
`codex-review.ts:223`, ahead of the trailer read and the receipt commit (spec lines
105-109).

- `finish()` is replaced by a synchronous `release()`. It writes the exit marker, closes
  the view file and starts the cleanup, keeping the cleanup promise on the session with
  its rejection absorbed. `settled()` exposes that promise for tests.
- The runners call `release()` without awaiting it (`claude-headless.ts:370`,
  `codex-headless.ts:271`, `codex-review.ts:169` and `:225`). Exit classification, the
  deadline check (`claude-headless.ts:373`), the observation settle, the receipt and the
  publish therefore never wait on a pane RPC.
- A stalled or failed close cannot change an outcome. A pane it leaves behind stays
  `placed` for the verified retire.

Tests, each with its refusing side:

| Claim | Positive | Refusing / complement |
| --- | --- | --- |
| Retire closes only a verified follower | worker-placement "retire closes the recorded view pane once …": exact `pane.get`, `pane.process_info`, `pane.close` sequence; the in-run close has the same sequence in "view session tees bytes …" | "retire REFUSES a pane whose live identity changed" (argv, pid and view-path variants) → `disowned` with no `pane.close`, and a second retire sends no RPC; "the in-run close refuses a pane whose identity changed …" |
| Unknown identity is not ownership | "… (process-info-fails)" closes once the failure clears | "retire REFUSES unknown identity" (failing process_info, empty argv, pane.get transport error, legacy receipt): no `pane.close`, receipt unchanged; "… reported gone" records `closed` after `pane.get` alone |
| Result before cleanup | "a stalled view close cannot expire a within-budget result" (Claude: 3s budget, 4s held close → `completed`, result and receipt written, pane still `placed`); "a stalled view close never holds the build result …" (Codex build); "… never holds the review verdict …" (Codex review) | "a stalled placement neither delays nor changes the result …" (held `layout.apply`: same outcome, receipt `pending` at return, then the late pane closes); worker-placement "a placement that outlives its timeout …" |
| Restart re-verifies | "restart adopts …" in all three worker suites: the first host's receipt carries the identity, and the replacement sends `pane.get`, `pane.process_info`, `pane.close` | the changed/unknown matrix above |

Tests that asserted a `closed` receipt straight after `run()` now wait for it with
`until`, because cleanup is detached from the outcome. That includes the E2E "Codex
owner …" test, which also checks every closed pane on the fake server.

Mutations, run by hand and reverted:

- `closeOwned` treating every inspection as owned makes the three changed-identity tests,
  the four unknown-identity tests and the in-run refusal red (8 fail, 16 pass).
- `await view.settled()` after `release()` in `claude-headless.ts` makes "a stalled view
  close cannot expire …" and "a stalled placement neither delays …" red. The same await
  in `codex-headless.ts` and `codex-review.ts` makes their held-close tests red.
- Dropping `placement: workerPlacement` from the Claude runner in
  `open/wiring/project-build.ts` still makes the E2E "Codex owner … labelled tab …" red.
- Decoding the view file instead of the piped bytes in `claude-headless.ts` makes
  "placed worker: one CLI process, identical outcome …" red. The screen-independence test
  stays green, because the outcome still comes from the exit status.

#### Second review (APPROVE) and the disposition of its minor findings

The trident review of the fix round (`f307c451`) returned APPROVE with two minor findings
and two nits. The run that published it then stopped because the cross-model review seat
failed at host dispatch. That was an infrastructure fault, not a verdict on the code. The
branch was brought forward onto current main by a merge, with no rebase and no conflict,
and re-verified there. No runtime code changed in this step. Line numbers below are at
the merged head.

- **M1: a kept pane is retired only on a same-step resume.** A pane whose close was
  refused as unknown, or whose close timed out, stays `placed`. Only a later resume of
  the same step retires it (`retire()`, `worker-placement.ts:340`). The follower
  (`VIEW_FOLLOW_SCRIPT`, `worker-placement.ts:130-149`) never exits on its own. Each such
  Herdr fault can therefore leave one idle follower and its tab. Disposition: not fixed in
  this slice. Pane and workspace retirement belongs to the sleep and wake lifecycle, which
  the spec puts out of scope here (spec lines 46-51, acceptance 72-75). The cost is
  bounded: one idle, credential-free follower (launched under `env -i`) and one tab per
  fault. Evidence is not affected, because no result, usage, exit or cancellation read
  goes through the pane.
- **M2: the restart path awaits `retire` before decoding the receipt.** The resume
  branches call `await options.placement?.retire(...)` before they read the durable
  receipt (`claude-headless.ts:323`, `codex-headless.ts:296`, `codex-review.ts:120`). On a
  Herdr stall this adds at most `inspectTimeoutMs + closeTimeoutMs`, 5s each by default
  (`worker-placement.ts:234-235`). No deadline check follows the wait on these paths.
  `claude-headless.ts` checks `expired()` only on the fresh-launch path (`:344`, `:373`).
  The recovered outcome therefore cannot change. Disposition: recorded as a follow-up, to
  make the resume retire non-blocking the way `release()` is.
- **Nits.** The composer wiring is asserted by a source-text match in
  `project-build-terminal.test.ts`. It stays, because it is mutation-red: dropping the
  wiring turns it and the E2E red. The red trailer-publication lane in the earlier host
  suite (`trident/codex-build.test.ts`) was unrelated, and main has since fixed it (#1257).

Re-measured on the merged base:

- Placement suites: `worker-placement`, `claude-headless`, `codex-headless`,
  `codex-review`, `project-runners`, `herdr-project-placement`, `project-workspaces` and
  `project-build-terminal` give 232 pass, 0 fail.
- Consuming E2E (`open/__tests__/project-build-e2e.test.ts`, whole file): 308 pass,
  0 fail. Main's model-tier cases account for the rise from 299.
- Mutations, each reverted:
  - `closeOwned` treating every inspection as owned (`worker-placement.ts:260`): 8 fail
    and 16 pass in `worker-placement.test.ts`. The failures are the three
    changed-identity tests, the four unknown-identity tests and the in-run refusal. The
    `project-runners.test.ts` control stays green (36 pass).
  - `await view.settled()` after `release()`:
    - `claude-headless.ts:370`: 2 fail, "a stalled view close cannot expire …" and "a
      stalled placement neither delays …".
    - `codex-headless.ts:271`: 1 fail, "a stalled view close never holds the build
      result …".
    - `codex-review.ts:225`: 1 fail, "a stalled view close never holds the review
      verdict …".
  - Dropping `placement: workerPlacement` from the Claude runner
    (`open/wiring/project-build.ts:494`): the E2E "Codex owner: every cross-provider Claude
    worker gets a labelled tab …" goes red. It is green in the unmutated whole-file run.
  - Decoding the view file instead of the piped bytes (`claude-headless.ts:374`): 24 fail
    and 18 pass in `claude-headless.test.ts`, including "placed worker: one CLI process,
    identical outcome …". The screen-independence test stays green.

### Out of scope, still open

This does not retire the Chat placeholder or change conversation placement. It does not
cover General owner admission or credential handoff, or the sleep and wake lifecycle. No
acceptance box in `docs/spec-items/project-herdr-workspaces.md` is ticked.
