---
title: Project-owned Herdr workspaces and sleep lifecycle
group: platform
status: open
priority: P0
cutover: true
needs_spec: false
---

# Project-owned Herdr workspaces

Owner-directed on 2026-09-23; see SPEC.md's decision of that date. The locked
pivot, `docs/plans/harness-orchestrator-pivot-2026-09-11.md:85-102`, retains one
project conversation and native same-provider subagents. Terminal organisation
does not create another conversation or another worker.

Each active project has its own Herdr workspace. General and any genuinely
shared helper that must remain warm belong to the separate `Neutron General`
workspace. General has a distinct scope, including from a project named general.
The first tab is `Chat`; separate agent processes have meaningful role/task tab
names. Native harness children remain native children; a task view must not
launch a duplicate worker merely to provide a tab.

Workspace identity comes from explicit instance/project scope and a durable
creation record, corroborated against the live server. Names, cwd, inherited
workspace environment, and an unverified saved handle are not identity. Creation
is reserved before the RPC; an interrupted or ambiguous creation is not retried
as a fresh workspace. A missing or mismatched ownership marker refuses use.
The marker is a correlation value, not a credential against an actor controlling
the same Herdr server.

Background work can wake a workspace without starting a model conversation.
An inert, owned `Chat` placeholder reserves the first tab; opening chat replaces
it only after verifying its exact recorded process identity. It does not start
a model or request tools. An activity lease must retain it only while actual work
keeps the project awake. Creation must preserve focus. Existing chat panes are adopted through the
existing REPL identity checks, never overwritten by a new chat spawn.

Closing a workspace or replacing a whole tab requires an atomic server-side
ownership/contents guard. A previously sampled pane list is insufficient because
a new pane can arrive before the close. Without that guard, retire only verified
owned panes and leave the workspace for lifecycle reconciliation. A real Chat
gets a fresh tab before the inert placeholder pane is retired; unrelated splits
in the former placeholder tab survive.

A project is awake while a conversation, queued dispatch, build, pending
approval, or unresolved live child requires it. After work and foreground
activity end, retirement preserves transcripts, closes verified owned panes,
clears their ownership claims under lock, and closes the empty workspace. A new
message or due project work wakes it. Unknown liveness does not license closure.
Gateway restart preserves active work and is not a sleep event.

## Acceptance

- [ ] Explicit project placement creates separate workspaces for two projects
      and General, even when their display names and cwd match; it never falls
      back to an inherited workspace on missing manager or invalid identity.
      Verify: `project-workspaces.test.ts`, `herdr-project-placement.test.ts`.
- [ ] Concurrent creation cannot produce two workspaces for one scope. A crash
      reservation, inaccessible server, mismatched marker, or ambiguous result
      refuses new creation; a positively absent old workspace can be recreated.
      Verify: `project-workspaces.test.ts` with both accepting and refusing cases.
- [ ] Worker placement reserves a stable operation ID and immutable request
      digest before dispatch. Pending, ambiguous and completed same-ID retries
      cannot allocate another pane or overwrite the prior cleanup receipt;
      distinct verified operations remain usable after worker failure. A typed
      server error alone does not release workspace creation or Chat repair.
      Verify: `project-workspaces.test.ts`, `worker-placement.test.ts` with
      lost-reply, restart, changed-payload and distinct-operation controls.
- [ ] Chat is tab zero, named `Chat`; worker tabs describe their role/task. A
      second spawn cannot replace a live Chat tab, while a proven-closed chat
      can be replaced. Worker-first wake reserves Chat without starting a model;
      replacing a foreign placeholder is refused. Tab labels are asserted on actual RPC requests.
      Verify: `project-workspaces.test.ts`, `herdr-project-placement.test.ts`.
- [ ] Production Claude/Codex conversation and worker composition resolves the
      actual per-dispatch scope, including General, and routes through this
      manager. Verify consuming Open composition and
      `open/__tests__/project-build-e2e.test.ts`.
- [ ] Sleep refuses busy, queued, uncertain, foreign, and unverified sessions;
      an idle owned workspace closes without deleting conversation history and
      resumes on wake. Restart adopts surviving work without duplication.
      Verify lifecycle integration tests and a fresh deployed live cycle.

The first change supplies workspace ownership and terminal placement only.
Production composition and safe sleep/retirement are subsequent slices; this
item remains open until those consuming paths and live behaviour are verified.

2026-09-24 (refs #1226): cross-provider bounded workers — headless Claude plan,
review and synthesis, the Codex build wrapper and the Codex review seat — now
get a task-view tab in their dispatch's project workspace (`Neutron General`
for General), placed through this manager from production composition
(`open/wiring/project-build.ts`, `open/composer.ts`). The tab shows a copy of
the worker's own output (Claude's single JSON result arrives only at exit, so a
Claude tab is presence-only while it runs); results, usage, exit status and
cancellation still come from the native process. Placement failure runs the
worker unplaced and records why. Each worker has a durable operation reservation;
an ambiguous worker blocks its own retry without blocking distinct verified
operations. Workspace creation and Chat repair stay reserved on ambiguous or
typed-error replies. View-pane retirement re-verifies the recorded follower identity
through the live pane process sample before any close and refuses changed or
unknown identity; worker results and receipts are published before view
cleanup. No acceptance box is ticked: conversation placement, General
owner admission and sleep/retirement remain open. See
`docs/as-built/place-cross-provider-bounded-workers.md`.

2026-09-25 (refs #1226): production composition now places every owner
conversation (Claude REPL and Codex native owner) as its scope's `Chat` through
the shared strict host, for the dispatch's exact scope (General is the manager's
null scope; a literal `general` project keeps its id); a missing manager on Herdr
refuses rather than inherit a workspace. A credential rotation is a verified
handoff through the ONE composer lifecycle owner
(`open/wiring/project-scope-lifecycle.ts`): the old exact REPL is retired through
the pool before the manager places the new Chat. The same owner adds safe sleep:
it reads the #1237 leases (any boot), pending approvals, the liveness census and
owner foreground activity read-only, refuses busy/queued/build/approval/child/
uncertain/foreign/unverified scopes, and retires an idle owned Chat pane-only with
its transcript and a resumable registry row kept; wake is the next admitted
dispatch, which resumes the same session in a fresh Chat of the same workspace;
the wake pin is the durable registry row (`asleep_at`), so it survives a gateway
restart. A per-scope lifecycle lock plus the pool's fenced, synchronous re-read of
the admitted evidence immediately before termination refuses work admitted during
a sleep. An idle timer (`NEUTRON_PROJECT_SLEEP_IDLE_MS`, default 30 min, `0`
disables) re-arms on every exit of a dispatch. A live survivor adopted on boot is
never slept blind (a pre-#1237 parent reads `legacy-unknown`). Deferred: no
producer admits an `approval` lease yet (pending approvals are read from
`tool_approvals`; instance grants are skipped, and any other approval whose topic
cannot be attributed keeps every scope awake); #1237's maintenance fence was not
used for sleep because it bumps the generation and survives a crash; Codex owners have no exact retirement
authority, so their sleep refuses; the workspace itself is never closed until an
atomic server-side guard exists. No acceptance box is ticked: the live-cycle box
needs a fresh deployed live cycle. See
`docs/as-built/project-herdr-workspaces-routing-and-sleep.md`.

2026-09-25 review round (refs #1226): a live Claude -> Codex switch hands the
Claude Chat off resumably before the Codex owner starts; Codex -> Claude is
refused up front with its recovery path (no Codex retirement authority yet). The
handoff re-censuses after waiting the owner's turn out and needs the exact pooled
owner's parent turn (excluding the pending requesting dispatch's inspector signal),
children and shells positively idle. A spawn in flight is never absence. Sleep
checks that the manager's live Chat is the pool owner's pane. A pending record
whose workspace is positively absent is recreated; other pending records still
refuse (operator remedy recorded in the as-built). Still no acceptance box ticked.
2026-09-25 round 2 (refs #1226, PR #1309): the census exempts owner-installed MCP
servers whose running argv is exactly an approved configured launch, so they no
longer read as busy shells. A `refused` handoff is yielded non-retryable with its
recovery path; `busy` and `unknown` stay retryable. An ambiguous Chat owner never
licenses a new Chat spawn: only a same-key join onto a survivor proceeds. A
pending workspace record no longer skips the same-ID worker digest and state check
(:63-68).

## Production composition investigation

General already follows the instance provider choice
(`instance-project-provider-resolution.md:10-13`, `open/composer.ts:850-858`),
and native owner admission uses the selected configured global seat in place
(`CodexCredentialService.resolveGeneralOwnerCredential`). General is an explicit
null owner namespace through conversation, controls, installed MCP and helper
admission; project owners still require their own complete project marker and
credential grant. Missing General credentials refuse visibly without reviewer
rotation or credential copies. This owner integration does not yet establish
production terminal placement or safe workspace retirement. The terminal manager's
`null` General scope must never become the literal project id `general` to bypass
those checks. Adapter placement propagation alone does not complete this criterion.

Production Chat routing also requires a verified credential handoff. The pool can
select another credential (`runtime/credential-pool.ts:228-240`), which names a
different warm REPL (`runtime/adapters/claude-code/persistent/pool.ts:302-310`).
The workspace manager correctly refuses a second live Chat owner
(`runtime/adapters/claude-code/persistent/project-workspaces.ts:182-186`).
Connecting that manager to conversation dispatch without coordinating scope-wide
admission, live child/work evidence and exact old-owner retirement would block
credential rotation. Optional adapter plumbing does not provide that handoff.

Cross-provider headless workers currently consume pipes and process exit status
(`runtime/workers/claude-headless.ts:158-164`, `runtime/workers/codex-headless.ts:242-246`).
Herdr supplies rendered screens and no exit code. Their terminal placement must
preserve structured result and cancellation evidence; launching a second worker
for a tab does not satisfy the requirement. Same-provider children stay native.
