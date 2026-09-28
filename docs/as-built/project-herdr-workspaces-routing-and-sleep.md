## 2026-09-25 — Owner conversations routed through project workspaces, with a verified credential handoff and safe sleep/wake (#1226)

Refs #1226 (kept open until a fresh deployed live cycle is verified). Three tasks on one branch.

**T1 — conversation placement.** The live-chat substrate places every owner-conversation
spawn with the dispatch's exact conversation scope through the ONE strict project-workspace
host composed in `open/composer.ts` (`createConversationTerminal`); the durable Codex owner
receives the journal path and its Chat placement. General is the manager's `null` scope and
the literal project `general` keeps its id. On Herdr without a manager the placement still
travels, so the spawn refuses instead of using an inherited workspace.

**T2 — credential handoff.** `open/wiring/project-scope-lifecycle.ts` is the one project-scope
lifecycle owner. It pins a scope's Chat credential while usable; a re-key retires the old exact
REPL through `retirePersistentRepl` (the pool fences, waits a committed turn out, confirms the
exit) before the manager places the new Chat, so rotation is never blocked by the manager's
single-live-Chat refusal.

**T3 — safe sleep/wake.** The same owner gained `awake`, `sleep`, `isAsleep`,
`resumeCredentialFor`, `armIdle`/`disarmIdle`:
- Awake evidence, read-only: every #1237 lease of the exact scope, from ANY boot (restart
  expires nothing); `hasUnresolvedNativeChildForChat`; pending `tool_approvals` attributed to
  the scope through the owner topic roots; census `busy` (awake) and
  ambiguous/unidentified/legacy-unknown/unknown, a thrown or unbound census (`unknown`); owner
  foreground activity within the idle window. An INSTANCE grant (no topic, or a ritual,
  ritual-egress, host-deploy or MCP-server approval, named by `INSTANCE_GRANT_APPROVALS` in
  `open/composer.ts` from their owners' own name functions) is skipped: the gateway decides it
  whatever Chat is awake and nothing expires it, so counting it kept every scope awake forever.
  Any other approval that cannot be attributed still makes every scope `unknown`.
- `sleep` refuses a Codex owner, an ambiguous owner, a foreign/unverified slot (the manager's
  read-only `inspectChat` sample, taken BEFORE any kill), and a `gone`/`placeholder` sample
  while the pool shows a live owner (contradictory evidence, `unknown`); then an awake scope,
  then a mid-turn owner (it never waits).
- **Race closure (lock + fence + synchronous re-read).** Every sleep and every handoff for one
  exact scope runs under one in-process promise lock (`withScope`), so a dispatch arriving
  mid-sleep is handed off after the sleep settles and wakes it. The pool's
  `retirePersistentRepl(key, undefined, { keepResumableRow, stillIdle })` fences the key,
  claims its gate, and calls `stillIdle` — the lifecycle's SYNCHRONOUS admitted evidence
  (leases, native child, approvals) — with no await between that read and termination. Work
  admitted since the async read returns `deferred`, which the lifecycle reports as a refusal
  naming the arrived reason. A sleep never joins a retirement already in motion, schedules no
  drain retry, and lifts its own fence on every outcome except a termination begun without a
  confirmed exit. #1237's `beginMaintenance` fence was NOT used: it bumps the scope generation
  (which reads as a generation replacement to the census) and persists across a crash, both
  changes to #1237 admission semantics this card may not make.
- Retirement keeps the conversation resumable: the registry row goes through the new funnel
  transition `sleepPane` (inside `withOwnedRegistry`; the pane-ownership guard lists it): no
  pid, port, pane handle or claim, the same session id, `has_session` kept, and a durable
  `asleep_at`. The transcript is untouched, the pool's confirmed exit closes the Chat pane, and
  the manager re-samples the slot as gone. Never `workspace.close`; unrelated panes survive.
- **Wake pin is durable.** `isAsleep` and `resumeCredentialFor` read the scope's asleep rows
  from the registry (`readAsleepConversations`: exact conversation scope, newest first,
  credential from the key); process memory is never the pin, so a wake after a gateway
  restart keys the same pool identity and `--resume`s the same session into a fresh Chat at
  tab zero of the SAME workspace. The next spawn's registry merge drops `asleep_at`.
- The live-chat substrate disarms the scope's idle timer when a dispatch starts and re-arms it
  in a `finally` on EVERY exit of the event stream (settled, early consumer exit, error);
  `NEUTRON_PROJECT_SLEEP_IDLE_MS` (default 30 min, `0` disables). Timers are in-process and
  re-arm on the next turn after a restart.
- The census sessions probe (`open/wiring/project-liveness.ts`) drops pool candidates whose
  RECORDED conversation scope is another one, so General and a live literal `general` project
  no longer both read `ambiguous`; a candidate with no recorded scope is still ambiguous.
- `ProjectWorkspaceManager.inspect` reads its journal through a new read-only
  `WorkspaceJournal.read` instead of `update` (no rewrite on a sample).

**Evidence.** `open/__tests__/project-scope-sleep.test.ts` (15 tests, real `ProjectAdmission`
over a migrated database, strict host over `FakeHerdrWorkspaceServer`, real persistent spawn):
idle retirement (exactly one `pane.close` naming the Chat pane, no `workspace.close`, one
`workspace.create`, transcript kept, asleep row asserted, wake argv `--resume <sessionId>` in
the same workspace); refusals for conversation, queuedDispatch, build and liveChild leases and
a previous-boot conversation lease; approval (attributed → refused, unattributable → unknown);
instance grants (no topic, ritual, ritual-egress, host-deploy, MCP server) → idle, a topic
approval still refuses; census busy and every uncertain census → unknown; foreground; a
mid-turn owner; a lease admitted INSIDE the retirement window → refused, fence lifted, row not
asleep, the Chat serves the next turn and nothing retires it later; a gone/placeholder sample
→ unknown with nothing killed; foreign token and moved Chat pane refuse with nothing closed;
General vs literal `general` sleep independently and the census probe returns each its own
parent; rotation still hands off after a sleep/wake; the idle timer sleeps a settled scope, a
dispatch before it fires disarms it, and a consumer that stops at the completion still arms
it; restart: a FRESH lifecycle and live-chat family (round-robin pool that would pick the
other credential) wake the slept scope on the same key and session with one Chat.
`open/__tests__/boot-live-agent-adoption.test.ts`: a live Herdr survivor adopted on boot is
the scope's owner; `sleep` reads `unknown` (legacy-unknown census) with no close, no spawn,
the pane still attached and the row untouched. `open/__tests__/project-build-e2e.test.ts`:
two projects (one the literal `general`) and General sharing one display name build through
ONE manager, each dispatch's workers landing only in its own scope's workspace; an invalid
placement identity creates no workspace and every receipt records the refusal.

**Mutation results** (guard `open/__tests__/project-scope-sleep.test.ts`, control
`open/__tests__/conversation-credential-handoff.test.ts` green):
(a) the pool's fenced `stillIdle` re-read disabled → the race test red;
(b) the durable wake pin returns nothing → idle retirement, rotation-after-wake and restart red;
(c) the early-exit `finally` arm reverted to arm-after-loop → the early-exit timer test red;
(d) the census scope filter removed → the census probe test red.
Earlier rounds: lease evidence dropped, the foreign/unverified refusal skipped, and
`keepResumableRow` ignored each red their tests.

**Relaunch round (CodeQL).** CodeQL flagged js/insecure-randomness (alert #71): the pool's
`random` strategy drew its index from `Math.random()` in `runtime/credential-pool.ts`, and that
pick flows into the credential handoff (`lifecycle.handoffChat(…, { credentialId })` in
`gateway/wiring/build-llm-call-substrate.ts`). The strategy now draws `crypto.randomInt(
available.length)`; eligibility (cooldown filter, early `null` on an all-parked pool), the
`candidate === undefined` guard, `use_count`/`last_used_at` accounting, the round-robin cursor
and `selectCredentialById` are unchanged. The alert is repaired, not suppressed.
`runtime/credential-pool.test.ts` gains the first `random` tests: a single credential is picked
and accounted; 200 picks never touch a parked credential and their counters sum to 200; an
all-parked pool yields `null` with no counter moved; picks leave the cursor and the #1226 pinned
owner selection alone. They assert membership and counters only, never a specific pick.
Mutation: `const idx = randomInt(available.length)` → `const idx = available.length` turned the
single-credential, cooldown and cursor/pin tests red (3 of 35) and green again when restored;
the control `open/__tests__/conversation-credential-handoff.test.ts` stayed green (9/9).

**Review round (2026-09-25, PR #1309 findings).**
- Live provider switch. Claude -> Codex: before a Codex owner starts for a scope with an exact
  Claude owner, the substrate hands that owner off through the same verified handoff, keeping
  its registry row RESUMABLE (`keepResumable`), so the Codex TUI's Chat placement finds an empty
  slot and switching back `--resume`s the Claude conversation. Sleep decides the Codex refusal
  from the FOUND owner: a Claude owner left in a scope now set to Codex still sleeps; only a
  scope with no Claude owner (Codex, or a live Chat the pool does not own) refuses.
- Handoff census gate. The handoff waits the owner's turn out ITSELF (phase polling), then
  re-reads the census immediately before each retirement attempt and requires parent turn,
  children and shells to be positively idle (unknown in any part is `unknown`; busy children
  refuse; a busy parent or shell waits, bounded). The pool retires in the re-verified mode
  (`SleepRetirement` with `keepResumableRow: false`), so its own drain retry never retires the
  key behind that re-census.
- A Chat spawn in flight is not absence: `ownerFor` reports it (`spawning`), a dispatch on
  another key gets `chat_handoff_busy` and spawns nothing, and the same key is joined.
- Sleep compares the manager's live Chat pane with the pool owner's pane; a mismatch is
  `unknown` before anything is retired.
- Manager reconciliation: a pending record whose recorded workspace is POSITIVELY absent
  (`workspace_not_found`) is recreated. A pending record whose workspace survives, or that
  names no workspace, still refuses (uncertain work is never reclaimed).
- The gateway-side Codex helper-tab placement goes through the composition's shared strict host
  (`projectWorkspaceHost`, never written to the launch file), and a journal refusal raised
  before any Herdr RPC (`ProjectWorkspaceRefusal`) unwinds the exclusive launch file.

**Round-2 repair (PR #1309, owner finding).**
- Requester-aware handoff census. `buildLiveAgentTurn` marks its dispatch active in
  ActivityInspector before the substrate drains, and the credential handoff runs inside that
  drain, so the scope-wide inspector signal counted the REQUESTING turn as the old owner being
  busy: an idle owner answered `chat_handoff_busy`. `ProjectLivenessSurface.census` takes
  `{ excludePendingDispatch }`; the handoff gate asks for it and the production census then
  omits only the inspector signal. The pool's exact-session active turn, held turn slot and
  poisoned state still decide the parent turn; child, shell, identity and unknown rules are
  untouched. Sleep and maintenance keep the scope-wide census.
- Own MCP services. The shell probe exempted only the dev channel and the tools bridge, so an
  owner-installed stdio MCP server (a direct child of the REPL for its whole life) made every
  census read shells `busy`, blocking handoff and sleep. The final implementation stamps
  each actual MCP launch with a fresh marker and records the parent's exact session,
  generation, channel and kernel identity in a write-once private receipt. The census
  corroborates that receipt against each direct child's marker, kernel identity and current
  parent edge, rechecking the parent and exempted children after walking descendants.
  Approval changes cannot relabel an existing child. Missing or unreadable evidence is
  unknown; a foreign marker remains busy. Descendants of an exempt service are still walked.
- Final refusals. A `refused` handoff (native child work, an unresolved native child, the pool
  refusing retirement, a Chat held by a non-Claude owner) is yielded `retryable: false` with its
  reason (and so its recovery path) in the message, on both the Claude credential handoff and
  the Claude -> Codex switch; `busy` and `unknown` stay retryable. `code` is unchanged.
- Ambiguous owner fails closed. With several live owners for one exact scope the dispatch is
  still pinned to a survivor's credential, and a same-key join onto a survivor (the ambiguous
  owner now carries the survivors' exact pool keys) is served as before. A dispatch that would
  SPAWN instead yields the retryable `chat_handoff_unknown` ("ambiguous Chat owner: N live
  sessions ...") and starts nothing; an all-parked pool still answers `all_cooldown` first.
- Pending worker digest (spec :63-68). `ProjectWorkspaceManager` returned a pending record for
  the absence probe BEFORE validating worker reservations, so a same-ID worker retry against a
  pending record whose workspace was positively gone was recreated and placed a second time.
  The reservation validation and the same-ID digest/state check now run first for every
  existing record: a changed payload refuses as `worker operation payload changed`, the same
  payload as `worker operation <state>; reconcile before retry`, both before any Herdr RPC. A
  distinct operation ID after proven absence still recreates the scope.
- Evidence. `open/__tests__/conversation-credential-handoff.test.ts` drives the REAL
  `buildLiveAgentTurn`, ActivityInspector, `buildProjectLiveness` over the real admission
  fixture, the lifecycle, pool and workspace manager (only the child's OS and transcript probes
  are scripted): a held old-owner turn is `chat_handoff_busy`; unknown child or shell is
  `chat_handoff_unknown`; a busy child is `chat_handoff_refused`; a busy shell is
  `chat_handoff_busy`; the plain census still reports pending scope activity busy; idle
  rotation succeeds while the requester is active, with one surviving Chat, one
  `workspace.create` and the old child exited. The same suite rebuilds the ambiguous case over
  two REAL live survivors (join served; would-spawn refused with no spawn and no credential
  fault; all parked is `all_cooldown`) and asserts refusal retryability.
  `open/__tests__/project-scope-sleep.test.ts` covers the Claude -> Codex refusal (final) and
  busy (retryable) with no Codex start and the Chat untouched.
  `open/__tests__/project-liveness-wiring.test.ts` proves the handoff census never consults
  the inspector signal while the default census does, and reads a real process tree: the
  exact spawn receipt permits idle, another marker remains busy, and missing or changed
  generation evidence is unknown. `gateway/project-liveness-census.test.ts` pins kernel
  identity, parentage and descendant checks. `open/__tests__/open-mcp-servers-wiring.test.ts`
  proves through the production composer that approval alone never exempts a running
  process; the original spawn receipt is required. `runtime/.../__tests__/project-workspaces.test.ts`
  pins the pending-record digest refusal and the distinct-ID recreation.
- Mutations. Guard `open/__tests__/conversation-credential-handoff.test.ts`, control
  `open/__tests__/project-scope-sleep.test.ts`: (a) the handoff census counting the requester
  again reds the consuming test's idle rotation (`failed` instead of `replied`) while the
  control stays green; (b) the opposite direction, the handoff census gate licensing
  unconditionally (a foreign/unverified close allowed), reds the same test at descendant
  refusal (`replied` instead of `failed`). Also: dropping the ambiguous fail-closed branch
  reds the ambiguous test; mapping `refused` back to retryable reds the four refusal
  assertions; the former configured-command exemption was superseded by spawn proof; restoring
  the old pending-first order reds the digest test. Each was restored before the gates.

**Blocked work / deviations.**
- Codex -> Claude live switch: the scope lifecycle does not consume native Codex retirement authority, so a
  Claude dispatch for a scope whose Chat slot holds a live non-Claude owner is refused up front
  (`chat_handoff_refused`, final so non-retryable, nothing closed, no spawn) with its
  recovery path in the message:
  switch the project back to Codex, or end that owner session. Pinned by
  `conversation-credential-handoff.test.ts`. Consuming native Codex retirement in
  this cross-provider scope handoff remains future work.
- Operator remedy for a stuck pending Chat record (a placement interrupted mid-operation,
  e.g. by a restart): after confirming no live work in it, close that scope's Herdr workspace;
  the next placement proves its absence and recreates the scope. A pending record that names
  no workspace (a creation reply lost) still needs the journal row removed by hand.
- Ambiguous owners (several live owners for one exact scope, left by pre-#1226 rotations) are
  a DOCUMENTED BYPASS, not a handoff: nothing picks one to kill, and nothing reconciles them
  automatically (restart adoption adopts each survivor). The dispatch is pinned to a survivor's
  credential so the pool serves that survivor (a same-key join); a dispatch that would spawn
  another conversation fails closed with the retryable `chat_handoff_unknown` (round 2). While
  every survivor's credential is parked the scope therefore cannot be served until a park
  lifts or the survivors are reconciled by hand. Sleep refuses the scope while it stays
  ambiguous. Pinned by `conversation-credential-handoff.test.ts`.
- Rotation on an adopted pre-#1237 survivor: its census parent reads `legacy-unknown`, so when
  its credential is parked (429/401) every dispatch in that scope fails with the retryable
  `chat_handoff_unknown` until the park lifts or the survivor is replaced. Before #1226 the
  pool served those turns on another credential (a second REPL). Bounded to survivors without
  an admission generation and to the park's duration.
- Two concurrent cold dispatches that pick different credentials before either spawns: the
  second gets `chat_handoff_busy` (retryable) instead of a second Chat; converging both on one
  pick would need the credential choice under the scope lock.
- No producer admits an `approval` lease (owned by #1237, not edited here); pending approvals
  are read from `tool_approvals` instead.
- A true admission fence for sleep would need #1237 to offer a fence that neither bumps the
  generation nor survives a crash; recorded, not edited. The in-process lock covers this
  gateway's dispatches; the synchronous re-read covers anything admitted in between.
- Codex owner sleep refuses: native retirement authority is not wired into the scope lifecycle.
- The manager does not delete the Chat slot on sleep: its `applyLayout` treats a record
  without `chat` as invalid, while a slot naming a positively gone pane is already an empty
  slot. Retirement is therefore a read-only sample before and after the pool's exact close.
- Workspace closure stays out until Herdr offers an atomic server-side ownership guard.
- If the asleep row's credential is parked when the scope wakes, the pin is not usable and the
  wake spawns a FRESH session on the selected credential's key (the old transcript stays on
  disk, not resumed). The old row is left in place: inert (no pid, pane or claim), outranked by
  any newer asleep row of the scope, and never swept.
- A service wrapper that forks still leaves its descendants busy. Legacy parents without
  original MCP spawn receipts remain unknown. Their current settings cannot reconstruct
  that evidence, so handoff and sleep refuse until a new authorized spawn supplies it.
- The adopted-survivor case covers refusal only: a survivor predating #1237 always reads
  `legacy-unknown`, so no fixture can sleep one without faking the census.
- The T2 rig is duplicated in the new suite rather than extracted to `tests/support/`.
- Host-owned, recorded not edited: a cancelled (`stopped`) prior run is not a retry source
  (`retryModeSource` in `trident/build-mode-state.ts` requires phase `failed`), and the launch
  leftover-branch guard (`trident/launch-preparation.ts`) inspects only the local ref, so the
  relaunch pinned its base to main and recreated the branch empty. The plan step carried the
  published history forward with merge commit dfd1e5c41 instead of rebuilding, because
  publication is a lease-checked force push that would have overwritten PR #1309.
- Host-owned, left as is: the task ledger under `.trident/ledgers/` at the PR head already shows
  T3 ticked by the earlier worker fix round.
- Round 2: the candidate's separate as-built shard for the requester-aware census was folded
  into this one, because the as-built guard allows one new shard per branch.
- Round 2, host-owned, recorded not edited: the launch again created the branch empty at main
  (a stopped prior run is no retry source; the leftover-branch guard reads only the local ref),
  and the plan step fast-forwarded to the published head b7070a3f instead of rebuilding,
  because publication is a lease-checked force push that would have overwritten PR #1309.
- Round 2, host-owned, left as is: the ledger under `.trident/ledgers/` already shows T3 ticked.
- Round 2: the spec's suggested `worker-placement.test.ts` does not exist; the pending-record
  digest tests live in `project-workspaces.test.ts`, beside the other journal tests.

### MCP spawn evidence and adopted receipt cleanup — 2026-09-28 review

The following evidence records the isolated PR-head follow-up at `8f03391cc`;
its source line references are to that frozen revision.

The original configured-command exemption could reinterpret a running process after
settings changed. `runtime/adapters/claude-code/persistent/spawn.ts:273` now stamps
each actual service configuration with a distinct random marker, strips inherited
markers from the parent, and records the exact spawned owner before publication
(`spawn.ts:582`). The write-once receipt is read against session, generation, channel
and kernel identity in `mcp-service-identity.ts:32`; the census verifies direct
parentage and stable process identity as well as marker membership
(`gateway/project-liveness-census.ts:328`). This remains correlation inside the
existing same-OS-user trust boundary, not a credential against that user.

An adopted session previously reconstructed its cleanup list without the new
receipt. `boot-adoption.ts:2499` includes it for both tool-bridge configurations.
The consuming adoption tests (`__tests__/boot-adoption.test.ts:197`) establish a
real receipt, adopt the pane, refuse busy retirement without touching receipt or
pane, then retire the idle exact owner and observe receipt removal. The shutdown
control at line 225 leaves both the pane and readable receipt available to the
next owner. Real-process Open census tests prove that approval alone cannot
relabel an existing process, changed generations remain unknown, and foreign
markers remain busy. The spawn test also checks distinct service markers, their
absence from the parent environment, and exact receipt membership.

Validation on the isolated PR-head follow-up: 255 tests passed across ten affected
files (generation replacement, census, Open liveness wiring, credential handoff,
MCP composition, scope sleep, config containment, boot adoption, owner MCP spawn,
and spawn-failure cleanup). Both `tsc --noEmit -p tsconfig.json` and
`tsc --noEmit -p trident/tsconfig.json` passed. Semantic mutations were restored:
omitting adopted receipt cleanup failed both retirement cases while shutdown
preservation passed; premature cleanup during survivor handover failed shutdown
preservation while both retirement cases passed; accepting a foreign marker
failed both the descendant walker and real-process Open census tests.

That was focused old-head evidence; the integration below adds current-main proof.
The full host gate, review, deployment and a served restart/sleep cycle remain
outstanding. No live acceptance box is ticked.

### Current-main integration and failed-spawn rollback — 2026-09-28

This subsection records the first integration at `6c682f9e4`; its source line
references name that revision. The retry-fence follow-up below supersedes its
initial uncertain-child retention behavior.

The isolated integration combines main `055727a87765` with the frozen follow-up
`8f03391cc`. Conflict resolution preserves main's validated Codex workspace
authority and startup/account recovery, while passing the shared project host
through those paths. Project/grant records remain the workspace source; no second
placement callback was retained. The original dirty worktree and reviewed
old-head candidate were not changed.

Independent review found that writing the MCP receipt could throw after a host
returned a live child but before exit cleanup was installed. The setup catch in
`runtime/adapters/claude-code/persistent/spawn.ts:678` now revokes registration,
terminates that exact child, and only then deletes its configuration. If exit
remains unproven, it retains the child handle, configuration and reservation
through the reservation's existing TTL instead of authorizing an immediate retry.
`__tests__/spawn-failure-revokes-credential.test.ts:34` injects an occupied receipt
through the actual spawn path and checks termination before config deletion; a
healthy-spawn control stays live. `__tests__/spawn-setup-uncertainty.test.ts:13`
pairs an unconfirmed stop with a confirmed stop and checks the durable reservation
as well as config, receipt and child-handle retention.

Main's autonomous recovery and this branch's retained sleep rows also required a
semantic integration guard. `startup-recovery.ts:28` excludes `asleep_at` rows
from boot/sweep recovery without discarding their transcript or row. The fixture
in `__tests__/startup-recovery.test.ts:74` skips an explicitly asleep row and
resumes the same active row. The consuming scope-sleep suite still proves that a
new admitted turn after restart wakes the retained session.

The bounded integration gate passed 973 tests across 28 affected files, with
9,093 assertions, including native recovery, account handoff, shared placement,
build end-to-end routing, scope sleep, adoption, MCP census and helper retirement.
The additional uncertain-exit fixture passed both cases. Both root and Trident
`tsc --noEmit` projects passed. Restored semantic mutations proved that omitting
child termination fails the exact-kill assertion while healthy spawn passes;
removing the asleep-row guard fails the skip assertion while active recovery
passes; and releasing an uncertain reservation fails its retention assertion
while confirmed-exit cleanup passes. These are local consuming checks, not a
full host gate or live deployment acceptance.

### Uncertain failed-setup retry fence — 2026-09-28 review follow-up

Independent review of `6c682f9e4` reproduced two live children from repeated
starts when receipt persistence failed, termination remained unconfirmed, and
the caller had no registry. Keeping the child mirror was insufficient: rejection
removed the pool promise, while unsupervised callers never had a reservation.
Even a supervised reservation has a TTL, not proof of child exit.

`runtime/adapters/claude-code/persistent/spawn.ts:81` now retains failed-setup
ownership in an exact-child map separate from the promise pool. It refuses before
boot adoption and at spawn entry until that child is positively exited. The
confirmed-exit callback identity-guards mirror removal, stops its watchers,
unlinks its configuration, releases its exact reservation and removes the fence.
It cannot clean a successor through an old child callback.

`__tests__/spawn-setup-uncertainty.test.ts:13` drives production `start()` with a
fake host that returns a child, makes the receipt write fail and ignores both
termination signals. With and without a registry, two further starts produce no
second child and retain the original evidence. After that exact child exits,
cleanup completes and another start succeeds with one new live child. The
confirmed-termination control remains separate in the same fixture.

The focused retry, ownership, adoption, respawn, sleep and handoff suite passed
229 tests across 12 files with 1,199 assertions. Both root and Trident typechecks
passed. Removing fence publication made the no-registry retry create a second
child; making the fence permanent broke cleanup after confirmed exit in both
registry modes. Both mutations left the separate confirmed-termination control
green and were restored. This is a bounded local follow-up, not a full host gate
or served restart acceptance.

### Replacement publication on current main — 2026-09-28

After independent approval of `d584bc296`, the reviewed integration was
transplanted onto main `d3902039179` as a new non-Trident branch. The transplant
had no conflicts: before this evidence update, its complete tree delta from the
approved integration had the same stable patch identity as main's two new
changes, #1380 and #1383. No reviewed runtime or test semantics changed.

The four consuming suites (`boot-adoption`, `spawn-failure-revokes-credential`,
`spawn-setup-uncertainty`, and `startup-recovery`, under the persistent adapter's
`__tests__` directory) passed 109 tests with 504 assertions on this publication
candidate. The local publication scan additionally required a test-local map
identifier to avoid a denylist component collision; its contents and assertions
are unchanged. Both `bunx tsc --noEmit -p tsconfig.json` and
`bunx tsc --noEmit -p trident/tsconfig.json` passed. The original dirty worktree,
Trident-owned #1309 branch and reviewed integration were preserved.

This replacement publication does not close #1309 or #1342. A full local
shared-host suite was deliberately deferred to avoid concurrent heavy validation;
the earlier focused receipts are not asserted as a full-suite pass for this head.
Required remote CI, merge review, deployment and served recovery/sleep evidence
remain separate gates. No live acceptance criterion is marked complete.
