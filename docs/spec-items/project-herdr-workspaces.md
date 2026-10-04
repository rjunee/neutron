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

Empty workspace retirement uses a separately advertised protocol capability,
`owned_empty_workspace_retirement`, and the single atomic RPC
`workspace.retire_empty_owned`. Its request binds `workspace_id`, the exact
`workspace_token_key`/`workspace_token_value` ownership marker, and a durable
`operation_id`. The server checks the marker and that **no pane remains** at the
mutation boundary, with no intervening operation; it must not close a pane,
process, tab group or sibling workspace as a side effect. A workspace id reused
with another marker returns `mismatch`, never `gone`. An absent workspace returns
`gone`; the exact empty owned workspace returns `retired`; a populated workspace
returns `not_empty` without mutation. The `workspace_retirement` reply echoes all
four request fields. Both an unsupported server and a refused or uncertain reply
leave the workspace ownership claim intact; no raw `workspace.close` fallback is
permitted. This is a required server contract, not a claim that released Herdr
already supplies the capability.

The client reserves the exact workspace/Chat observation and operation under the
existing scope journal lock before this RPC. A stale observation, mismatched
acknowledgement or concurrent journal change cannot erase ownership. Lost replies
remain reserved across gateway restart; retry reuses the same operation and marker.
An exactly correlated `not_empty` or `mismatch` refusal may release only the
retirement reservation under compare-and-swap, retaining ownership with a new
observation revision; uncertainty never releases it. A foreign pane's arrival
must not permanently strand the next verified Chat wake.
Confirmed retirement clears workspace/Chat claims but retains worker operation
tombstones, so sleep/wake cannot re-dispatch an already completed operation. Wake
can then create a fresh workspace and resume the same conversation transcript.

A project is awake while a conversation, queued dispatch, build, pending
approval, or unresolved live child requires it. After work and foreground
activity end, retirement preserves transcripts, closes verified owned panes,
clears their ownership claims under lock, and closes the empty workspace. A new
message or due project work wakes it. Unknown liveness does not license closure.
Gateway restart preserves active work and is not a sleep event.

Chat creation preserves the server-returned terminal/runtime birth receipt with
the tab/pane identity. Authenticated dead-owner relinquishment retains that exact
receipt and exposes the remaining shell as a cleanup obligation, not an absent
scope. Automatic cleanup requires the original receipt, current placement and
marker, idle scope evidence, and the advertised owned-pane input-hold and
retirement capabilities. It durably reserves the hold token and input epoch,
checks exact acknowledgements and journal compare-and-swap, and retires only
through `pane.retire_held_owned`. Lost replies retain the reservation for exact
retry; no raw close, lease deletion or inferred historical receipt is permitted.
Before any retirement is issued, a known busy/refused scope releases its exact
hold and restores readiness under compare-and-swap. Release intent is durable:
an uncertain release can re-hold the same original target/token, accept the
newly acknowledged epoch and re-prove idle from scratch. An already issued
uncertain retirement never acquires this release/re-arm authority.

An apparently idle shell foreground is insufficient. While input is held, a
strict local kernel census must identify the same shell PID/start/boot, UID,
session and terminal, positively enumerate both shell and observer, and find no
other direct child, session member or terminal member. Unreadable or changed
evidence refuses retirement. Recheck the held input epoch, kernel identity and
scope admission immediately before the guarded mutation. Foreign splits remain;
only the existing atomic empty-workspace operation can remove their container.

Legacy shells whose journals lack the creation receipt require a distinct,
explicit privileged **current-shell retirement authority**, never automatic
backfill from a live pane. A protected operator request and durable audit bind
the scope, held maintenance operation, server identity, current pane birth and
exact kernel shell identity. The operator independently verifies canonical
asleep state, no leases or unresolved work, departed recorded native owners and
the same held kernel census, then uses the same guarded pane operation. The
receipt records present authority, not invented historical ownership. It cannot
release maintenance, rewrite the ownership journal or registry, clear leases,
or raw-close a pane/workspace. Ordinary reconciliation subsequently observes
confirmed absence and retires the empty owned workspace. This is the deliberate
operator-only legacy authority in the 2026-10-04 Decisions Log, not a runtime
fallback or a new privilege for tenant code.

Operator deployment maintenance may hold one explicitly registered scope's
ordinary draining fence without restarting its gateway. An operation-bound
durable hold prevents even an older gateway's recurring recovery from reopening
that fence. Acquisition is atomic; existing work releases normally; there is no
expiry, fabricated completion, lease deletion or cap release. Only the privileged
local actuator owns hold release, after independently verifying the deployed
target, canonical asleep transcript and disappearance of the recorded native
process. A mismatch or unreadable observation preserves the hold. This does not
replace sleep's own ownership, native-child, foreground or idle checks.

For a settled, independently observed idle and uncapped native parent, the
existing operator respawn may replace an abandoned/poisoned process before the
existing idle timer sleeps its replacement. Active turns, pending inbound replay,
unknown native work and changed ownership refuse this maintenance procedure.
The procedure never uses force to cancel active work or release a cap. Verify the
held old-recovery, real turn-finalization, idle-respawn, canonical-sleep and genuine
post-release wake sequence in `open/__tests__/project-scope-sleep.test.ts`, and the
cross-connection hold/release controls in `gateway/operator-maintenance-hold.test.ts`.

Invoke only from a wholly root-owned, protected, clean committed artifact.
The maintained local entrypoint is `open/operator-maintenance.ts`: `hold`
consumes an explicitly selected root-protected request file and creates a new
0600 root-protected audit; `record-owner` captures an exact replacement generation
and kernel process identity after all previously recorded owners have exited;
`release` consumes that audit and the current gateway PID. If the replacement
already slept before its live PID could be recorded, `record-owner` instead
records a distinct completed-sleep observation: exact generation, sleep timestamp
and channel, **not** a historical PID or exit attestation. The same held operation,
old gateway identity, drained leases and absent/valid target-empty replay are
required. All previously observed original processes must be gone; a strict fresh
whole-process census must establish no possible transcript owner. Unknown reads
refuse; seeing the census process is its positive control. The asleep identity is
reread around the census, and the census repeats during release.

The actuator neither invokes respawn nor changes a registry row. Its fixed
additive compatibility bootstrap executes only the reviewed 0167 SQL, committing
the exact schema and hold together. A protected, fsynced **prepared operator
audit**, written first, binds the operation, canonical DB, observed old gateway
and its migration owner, and independently selected reviewed artifact commit/SQL
hash. A separate postcommit observation records successful application. The old
gateway's actual protected code tree determines the existing owner marker;
the separately protected bootstrap artifact never claims to be that owner.
**Every canonical `_migrations` row stays unchanged.** This is an operational DDL
audit, not a canonical migration receipt. Old-code restart remains valid; the
ordinary new runner later really executes the idempotent migration 0167 and
records its normal provenance. None of the ordinary runner's six pre-write
guards, owner binding, repair acknowledgements or marker bytes changes.
Unsupported ledger formats and partial/altered maintenance schema refuse.
Recovery after an audit-append failure requires the exact durable operation hold
and exact schema, never a prepared record alone. A failed pre-hold attempt retains its
audit; retry uses a new explicit operation only after establishing that no hold
was acquired. There is no automatic expiry or generic unlock command.

Release requires the exact held operation/fence, no remaining admission leases,
strictly absent or valid target-empty pending replay, a canonical asleep row for
the recorded native generation or completed-sleep observation, and physical
disappearance of every previously recorded native process. Replay and registry
reads refuse symlinks, nonregular files and changed/unreadable bounded files.
The replacement gateway must run the exact tracked `open/server.ts`
inside the clean protected target tree, start after its tracked source files,
own the health listener, return the expected instance identity, and retain its
kernel identity through the final check. Static checkout or health evidence alone
does not authorize release. Refusals emit only controlled reason codes, never
tokens, raw exceptions, replay payloads or private paths. Verify these directions
in `open/operator-maintenance.test.ts`, `open/operator-maintenance-evidence.test.ts`
and `migrations/operator-maintenance.test.ts`.

## Acceptance

- [ ] Creation-authorized dead Chat remnants remain discoverable after restart;
      guarded cleanup accepts an idle owned shell and refuses changed birth,
      marker, epoch, background work, missing receipt and late admission. Lost
      replies preserve exact retry; foreign splits survive. Verify
      `workspace-relic-retirement.test.ts`, `project-relic-cleanup.test.ts` and
      consuming `open/__tests__/project-build-e2e.test.ts` placement fixtures.
      Legacy deployment cleanup additionally requires the separate protected
      current-authority actuator proof; local fixtures do not claim live closure.

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
- [ ] Project document/opening composition is on demand and session-less, with a
      fresh toolless worker in its explicit project's named task tab. Settlement,
      cancellation and failure retire that worker without disturbing Chat or
      deleting conversation history. Unknown closure retains cleanup identity
      until exit is confirmed, including through the gateway shutdown sweep.
      Shutdown fences pending startup before its first turn, waits a bounded
      interval, and retains exact late-child cleanup without injecting a prompt;
      an ambiguous placement retains its operation
      reservation rather than launching a duplicate retry. Verify:
      `open/__tests__/project-compose-lifecycle.test.ts`, including warm Chat,
      missing-manager, lost-reply and unconfirmed-close controls.
- [ ] Sleep refuses busy, queued, uncertain, foreign, and unverified sessions;
      an idle owned workspace closes without deleting conversation history and
      resumes on wake. Restart adopts surviving work without duplication.
      Verify lifecycle integration tests and a fresh deployed live cycle.
      Teardown fences a sampled sleep at the final pool retirement check and
      prevents delayed idle retries or dispatch finalizers from arming timers.
      A fresh lifecycle can still use and sleep the same surviving conversation.
      Verify the shutdown controls in `open/__tests__/project-scope-sleep.test.ts`.
- [ ] Empty-workspace cleanup uses only the advertised atomic operation: an empty
      owned workspace retires; an arriving foreign pane or changed ownership survives.
      Lost replies, stale acknowledgements and concurrent journal rewrites never
      clear a newer claim; exact retry survives restart, with worker tombstones and
      conversation history retained. Unsupported servers keep pane-only behavior.
      Verify `owned-empty-workspace.test.ts` and consuming
      `open/__tests__/project-scope-sleep.test.ts`, including both accepting and
      refusing controls; complete the server contract and deployed live cycle.

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
dispatch, which resumes the same session in a fresh Chat (of the same workspace
when the server does not support atomic empty-workspace retirement);
the wake pin is the durable registry row (`asleep_at`), so it survives a gateway
restart. A per-scope lifecycle lock plus the pool's fenced, synchronous re-read of
the admitted evidence immediately before termination refuses work admitted during
a sleep. An idle timer (`NEUTRON_PROJECT_SLEEP_IDLE_MS`, default 30 min, `0`
disables) re-arms on every exit of a dispatch. A live survivor adopted on boot is
never slept blind (a pre-#1237 parent reads `legacy-unknown`). Deferred: no
producer admits an `approval` lease yet (pending approvals are read from
`tool_approvals`; instance grants are skipped, and any other approval whose topic
cannot be attributed keeps every scope awake); #1237's maintenance fence was not
used for sleep because it bumps the generation and survives a crash; the scope
lifecycle does not consume Codex retirement authority, so Codex sleep refuses;
the workspace itself is never closed until an
atomic server-side guard exists. No acceptance box is ticked: the live-cycle box
needs a fresh deployed live cycle. See
`docs/as-built/project-herdr-workspaces-routing-and-sleep.md`.

2026-09-28 (refs #1226): the client now consumes the atomic empty-workspace
retirement contract above after exact Claude Chat retirement, and retries an
uncertain completion from the durable reservation on a subsequent sleep request
after gateway restart (not automatic boot reconciliation). A
capability-negative server retains the pane-only behavior. The server operation,
safe live-server handover, adopted-pane migration and live acceptance remain open;
Codex sleep is still refused. No acceptance box is ticked by these client fixtures.
See `docs/as-built/owned-empty-workspace-retirement-client.md`.

2026-09-25 review round (refs #1226): a live Claude -> Codex switch hands the
Claude Chat off resumably before the Codex owner starts; Codex -> Claude is
refused up front with its recovery path (Codex retirement is not wired into this
scope lifecycle). The
handoff re-censuses after waiting the owner's turn out and needs the exact pooled
owner's parent turn (excluding the pending requesting dispatch's inspector signal),
children and shells positively idle. A spawn in flight is never absence. Sleep
checks that the manager's live Chat is the pool owner's pane. A pending record
whose workspace is positively absent is recreated; other pending records still
refuse (operator remedy recorded in the as-built). Still no acceptance box ticked.
2026-09-28 review (refs #1226, PR #1309): the census exempts a direct MCP service
only through an immutable receipt of the parent's exact spawn generation and
kernel identity, corroborated by the child's marker, identity and current parent
edge. Current approval settings cannot relabel an already running process.
Missing original evidence remains unknown. The receipt survives gateway handover
and is reclaimed when its adopted child retires. A `refused` handoff is yielded non-retryable with its
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
rotation or credential copies. Fresh Codex owner terminal placement is wired as
recorded above; Claude conversation placement and pane retirement are wired by
the scope lifecycle above. Workspace closure and live acceptance remain open.
The terminal manager's
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
