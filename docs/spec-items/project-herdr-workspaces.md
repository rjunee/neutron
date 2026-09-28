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

2026-09-28 (refs #1226): fresh native Codex owners now receive the same durable
workspace journal as bounded workers from production Open composition. The helper
occupies `Owner helper · Codex`; its existing native TUI occupies `Chat`. General
remains null, distinct from a project named `general`. Missing or mismatched
placement refuses new launch; successor generations and General account handoff
retain the explicit scope. Existing live owners are adopted in place without
moving or retiring their panes. See `docs/as-built/codex-project-workspace-placement.md`.
Claude conversation credential handoff, full sleep activation and the fresh
deployed live cycle remain open; no acceptance box is ticked by this slice.

## Production composition investigation

General already follows the instance provider choice
(`instance-project-provider-resolution.md:10-13`, `open/composer.ts:850-858`),
and native owner admission uses the selected configured global seat in place
(`CodexCredentialService.resolveGeneralOwnerCredential`). General is an explicit
null owner namespace through conversation, controls, installed MCP and helper
admission; project owners still require their own complete project marker and
credential grant. Missing General credentials refuse visibly without reviewer
rotation or credential copies. Fresh Codex owner terminal placement is wired as
recorded above; Claude conversation placement and safe workspace retirement remain
open. The terminal manager's
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

### Native Codex account handoff

Account selection and native conversation ownership are separate claims. Changing
a selected seat, a credential file, or `CODEX_HOME` does not transfer an existing
conversation. The account's refreshable credential stays in its one canonical
home; transcript transfer must not copy or link credential material. A project
still requires its explicit project grant: permission to use a global review
seat is not permission to replace a project conversation's account.

The implementation sequence is: reserve scope-wide admission; verify the target
grant and identity; obtain complete native idle evidence and the exact old-owner
retirement receipt; exclusively stage the original transcript in the target
account's namespace; resume and attest the same native thread/session and the
target account; only then publish the successor owner. Until that acknowledgement,
the old owner is retired, not silently reusable, and the new one is not admitted.
An ambiguous intermediate result stays reserved across restart. Existing owner
records remain immutable evidence, not files to delete to make admission pass.
The exact source binding and target are durably prepared before the retirement
request. A clean authenticated busy refusal, corroborated by the unchanged live
binding and absence of retirement markers, may record an explicit immutable
abort. Unknown or lost replies never abort. Restart may finish preparation only
from the exact completed retirement/death receipt; it cannot first wake the old
account in an ordinary successor generation. This includes the crash boundary
after retirement completes but before transcript staging is reserved.
The retiring marker is published only after the final fenced native census is
idle, immediately before process close, with no intervening asynchronous gap.
Late-busy evidence creates no marker and permits the explicit abort above.
Failure to publish the marker is unknown: retain reservation without closing
the native owner. Canonical path aliases may name the same configured grant;
normalization must not change account identity or admit an unconfigured home.

General admission consumes the existing selected global seat as a candidate;
selection is not itself ownership. Before retiring the retained owner, an
on-demand metadata-only native read must report the expected backend account and
explicit permission for ordinary included usage. Its process must have exited
before successor launch. The successor repeats that check in its own native
process. Missing windows, reset times and available reset credits do not establish
permission. This is not a periodic generative probe or a new quota selector.

The native path override is not itself identity: the installed protocol permits
it to override a supplied thread id. Check the returned identity and an independent
native read against the reserved predecessor. The transcript destination may
change; the original conversation, project scope and history must not.

- [ ] The native capability check proves same-thread/session/history continuation
      between disposable homes with no credential file or upstream provider.
      Same-home resume is a positive control; a missing target transcript must
      not be mistaken for a successful transfer. Verify:
      `runtime/adapters/codex-cli/persistent/project-owner-cross-home.smoke.ts`.
- [ ] The consuming handoff checks both target grant and account identity and
      rejects missing, changed, foreign or merely reviewer-scoped authority.
      General and an actual project named `general` remain distinct.
- [ ] Busy, pending native requests, descendants, raw input and unknown ownership
      refuse retirement. A fully idle, exactly attested owner can transition.
      Retirement and target admission share a scope reservation; a second caller
      cannot start a competing owner between them.
- [ ] Transcript transfer is reserved before writing and corroborated by the
      completed retirement receipt, exact predecessor identity and content digest.
      Existing foreign destinations, symlinks, changed source bytes and ambiguous
      partial writes refuse. No credential bundle is copied or linked.
- [ ] Resume preserves the native thread/session and original history, while
      independently attesting the selected target account. A successful RPC for a
      different thread, account or project cannot commit the owner pointer.
- [ ] Failure or restart at every transition boundary neither resurrects the
      retired owner nor creates a second one. A completed transition remains
      adoptable with its immutable predecessor and successor evidence.

The General implementation and native capability measurement are recorded in
`docs/as-built/codex-general-account-handoff.md`. These criteria do not claim that
project-account rotation or authenticated production switching has been verified.
The consuming checks are `open/__tests__/codex-account-handoff.test.ts` and the
`project-owner-account-handoff`, `project-account-probe`,
`project-control-bootstrap-handoff`, `project-owner-helper-retirement` and
`project-control-retirement` tests under
`runtime/adapters/codex-cli/persistent/`. Project-wide grant selection and Claude's
complete native idle authority remain outside this General handoff slice.

Cross-provider headless workers currently consume pipes and process exit status
(`runtime/workers/claude-headless.ts:158-164`, `runtime/workers/codex-headless.ts:242-246`).
Herdr supplies rendered screens and no exit code. Their terminal placement must
preserve structured result and cancellation evidence; launching a second worker
for a tab does not satisfy the requirement. Same-provider children stay native.
