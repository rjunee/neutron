# AS_BUILT

Running log of what shipped, newest first. One entry per merged change.

## 2026-08-12 — the owner can connect GitHub, and the agent stops pointing at a terminal (#551, #552)

Two halves of one failure, so one change. The owner's codegen could not push or
open a pull request because no GitHub token existed, and the agent's advice was
to run `gh auth login` — on a machine he has no shell on. A button without the
advice fix leaves the agent recommending the shell; the advice fix without a
button points at a surface with no control on it.

**#551 — the entry point.** The entire GitHub device-flow backend was already
merged and composed: `github/device-flow.ts`, `github/connect.ts`,
`github/credential.ts`, `trident/git-mode.ts`, and
`gateway/http/github-connect-surface.ts` behind route slot
`app_github_connect_surface` → `/api/app/github-auth`. **No client on any surface
called it.** That is why it survived: the backend tests passed, the route
resolved, and a composition-coverage test asserted the slot was mounted. Not one
of them asked whether a human could start the flow.

So both clients grew a GitHub section on the Integrations surface they already
had — web `landing/chat-react/IntegrationsTab.tsx` over the new
`landing/chat-react/github-connect-client.ts`, mobile `app/app/integrations.tsx`
over the new `app/lib/github-connect-client.ts`. It follows the Google connect
section's shape and NOT its flow: those rows drive an OAuth redirect, and this is
a device flow, so the screen is built around the CODE rather than the button.
Connect POSTs to start; the `user_code` is displayed large and monospaced; Copy
puts it on the clipboard in one press (the owner is usually reading it off a
phone and typing it into something else); the `verification_uri` is a real link;
and the client polls the status route at GitHub's own 5s floor until it answers
`connected`, then re-renders — no manual refresh, which is what separates a flow
from a wall of instructions. The mobile screen additionally re-reads on
foreground, since "tap Open GitHub, approve, come back" is one gesture there. The
`device_code` is the bearer half of the exchange; the surface never returns it and
neither client renders it, asserted against a response that carries one anyway.
The web section sits OUTSIDE the `/api/cores/integrations` load: the control a
blocked owner needs must not wait on an unrelated round trip.

**#552 — the advice.** `MISSING_CREDENTIAL_DOCTRINE` in
`gateway/wiring/operating-doctrine.ts`: when a capability is blocked by a missing
credential, name the in-product surface the owner can reach to supply it, and
never give a shell command as the remedy, because the owner cannot be assumed to
have a terminal on the machine the agent runs on. It names GitHub and the failure
that produced it concretely. It is doctrine rather than a persona line because it
is product behaviour every install should have, not a preference the owner might
edit away. It is phrased UNCONDITIONALLY — no branch on deployment shape, which
is both shorter and strictly better, since naming the surface is right either way
and a branch is only something for the model to get wrong.

**Verified — and the verification is the point of this change.** A test that
asserts a component rendered would have passed on the broken build, because the
component was fine and nothing reached it.

- The web reachability gate carries a `github-connect` affordance, probed at BOTH
  layouts after walking the owner's real path (header menu → Admin). It needed a
  third probe phase, `inAdmin`, because the things you adjust live behind that
  menu rather than in the tab band.
- `landing/chat-react/__tests__/github-connect-reachable.test.tsx` (12) and
  `app/__tests__/github-connect-reachable.test.tsx` (12) PRESS the control and
  assert the wire: the POST leaves, the code renders, Copy reaches the clipboard,
  `Linking` gets the URL, the poll flips to connected and then STOPS, an
  in-flight flow shows its existing code without starting a second, the
  gateway's error is shown verbatim, and the `device_code` never renders.
- The doctrine rule is asserted against the COMPOSED system prompt in
  `gateway/wiring/__tests__/build-live-agent-turn.test.ts`, not only against the
  module — a rule nothing splices in is the same defect one layer up.
- Mutation-proved, each mutation confirmed APPLIED by grep before the result was
  believed (two mutation tests in this repo have silently not applied and gone
  green): renaming the web control's class reds both layouts of the reachability
  gate; making Connect call status instead of start reds 6 of 12 web and 7 of 12
  mobile assertions; disabling the poll effect reds exactly the poll test.
- `bash scripts/ci/typecheck-all.sh > /tmp/neutron-typecheck.log 2>&1` — 51
  tsconfigs, all pass. `scripts/ci/lint.sh` and `scripts/ci/leak-gate.sh` clean.

NO FEATURE FLAGS — single code path, on by default.

## 2026-08-12 — a dirty worktree is preserved, never force-removed (#541)

The inner workflow's `finally{}` cleanup is now the checked-in
`trident/worktree-cleanup.sh`, and every worktree removal in `trident/merge.ts`
goes through the same gate: a tree with uncommitted changes — **including
untracked files** — or one whose `git status` cannot be read at all is
PRESERVED, its paths printed, exit 3. A clean tree is still removed, with a
plain `git worktree remove` rather than `--force`, so git's own dirty check is a
second gate behind ours.

What it replaces was a cheap-model agent handed "MUST succeed on every path;
ignore individual command failures … `git worktree remove --force` … `git branch
-D`". That block runs on success, on REQUEST_CHANGES, on throw and on abort, and
the last two are precisely when Forge died mid-edit and the worktree holds the
only copy of the work. On this repo's PR #171 it took 197 insertions across 7
files, none of them recoverable. There is no LLM judgement left in the
destructive path: the workflow's agent runs one fixed command and reports its
output through a schema, the same shape as the head and CI probes, and is told
that a non-zero exit means work was preserved on purpose rather than something
to retry around.

`git branch -D` was closed as the same loophole, since it loses commits just as
thoroughly. In pr-mode the local branch is deleted only when `git ls-remote`
proves origin holds that exact sha; never pushed, behind, or an unreachable
origin all keep it and say why. Local mode never touches the branch — it is the
only copy of the build and the outer loop merges it. `merge.ts` inherits the
gate at all three of its removal sites, including the lingering build worktree
`freeBranchFromWorktrees` used to force away; a dirty one there now fails the
merge loudly instead, naming the path in the operator's words ("trident
PRESERVED uncommitted work … recover or delete it, then re-run the merge")
rather than letting git's raw "already checked out at `<path>`" reach chat.
That is the right trade when the alternative is deleting work to make a merge
convenient.

Four ways a preserve-by-default gate can turn into a nuisance, all closed:

- **Only stdout decides.** `git status` and `ls-remote` are read with stderr
  captured separately. Folded together (`2>&1`), any warning git prints on a
  perfectly clean tree — an unreadable subdirectory, a trace — parsed as a dirty
  path: worktrees leaked forever, pr-mode branch teardown never ran, and the
  alarm fired on runs that had preserved nothing.
- **The shared checkout is never a candidate — in BOTH copies.** git refuses
  `worktree remove` on a main working tree, and `merge.ts` legitimately leaves it
  on a feature branch after a stale-rebase recovery; scoring that refusal as a
  preservation pinned the exit at 3 for good. It is skipped, and a branch git
  won't delete because it is checked out there is reported as
  `KEPT … reason=checked-out` at exit 0 — origin already has the sha, so nothing
  is at risk. The cross-model reviewer caught that only the shell twin skipped
  it: `freeBranchFromWorktrees` would have scored the refusal as preserved work
  and thrown, failing the merge over a checkout holding nothing uncommitted, on
  every retry. It is unreachable today only because `mergeLocal` step (0a) moves
  the checkout onto base first — too thin a guarantee to leave the twins
  disagreeing about, so `merge.ts` now skips the first `worktree` record exactly
  as the shell twin's `n > 1` does.
- **The probe must point at a worktree ROOT — in BOTH copies.** `git -C <dir>
  status` walks up to the enclosing repo, so a registered path that has stopped
  being a worktree root (an empty leftover directory, a `.git` file deleted while
  the directory survived) reports the shared checkout's dirt as its own:
  recovery instructions naming files that are not in the named tree, exit 3 on a
  run that preserved nothing, and pr-mode branch teardown pinned at 3 for as long
  as the stale directory sits there. `rev-parse --show-toplevel` must name the
  path itself, in the shell script (`SKIPPED … reason=not-a-worktree-root`) as
  well as in `merge.ts`. A rev-parse that says *nothing* is a different answer
  from one naming another repo, and still preserves — absence of evidence is not
  evidence of absence when the failure mode is unrecoverable.
- **Only exit 3 means preserved work.** Usage errors exit 2 (documented, and now
  actually 2 rather than bash's `${1:?}` 1) and a wrong script path exits 127 —
  the caller reports those as a cleanup FAILURE, because a script that never ran
  inspected nothing. But the *reading* of that code is generous, because it comes
  back through a transcribing agent: a string `"3"` counts, a missing field falls
  back to the `___EXIT=` marker in the output, and an output full of `PRESERVED`
  records with no code at all still raises the alarm rather than the "NOTHING was
  inspected" line. A wasted look costs a minute; the inverse costs the work.

Two ways the gate could have failed *itself*, also closed. The output is bounded
by construction — a 20k-line dirty tree (one un-ignored `dist/`) would otherwise
push the `RESULT` line and the exit marker out of the transcriber's window, so
the dirty list is capped at 50 paths with a count and the exact command for the
rest. And the one network call cannot hang: the cleanup runs from a `finally{}`
that fires on throw and abort with nobody at a keyboard, so `ls-remote` runs with
`GIT_TERMINAL_PROMPT=0` and, where coreutils `timeout` exists, a 20s deadline —
blowing it is just another unreachable origin, which keeps the branch.

One thing this fix deliberately does NOT do: unwedge itself. `runWorktreePath` is
keyed on `run.id` + `run.slug`, both stable across retries, so a preserved dirty
merge worktree makes every retry fail at the same path until a human clears it.
That is the trade, stated where it is made rather than papered over: a wedged
merge is recoverable, a force-removed conflict resolution is not. The error names
the path and the two ways out.

Tested against real git repos rather than a mocked host — the bug is only
observable on a real working tree — covering untracked-only, modified, staged,
unreadable, ignored-files-only, clean, already-gone, and other-branch trees, an
untracked file inside an untracked DIRECTORY (what `--untracked-files=all`
actually buys: the individual paths, not one collapsed `?? feature/`), a clean
tree whose git warns on stderr, a shared checkout parked on the branch, and the
four branch-teardown outcomes, a registered path that is no longer a worktree
root sitting next to a dirty shared checkout, a 600-file dirty tree, and an
`origin` whose transport never answers. The exit-code reader is EXECUTED, lifted
out of the shipped `inner-workflow.mjs` rather than grepped for.
Mutation-verified, 20 mutations applied and killed: dropping
`--untracked-files=all` (both copies), folding stderr back into either probe,
un-skipping the main working tree, exiting 1 on a usage error, restoring
`--force` (both copies), downgrading exit 3 to 0, dropping the worktree-root
guard (both copies), treating an unverifiable status as clean, treating
rev-parse silence as "not ours", dropping the `existsSync` gate, dropping the
operator-facing throw, calling every non-zero cleanup exit a preservation,
rejecting a string exit code, dropping the `___EXIT=` fallback, dropping the
PRESERVED-records fallback, removing the dirty-list cap, and dropping
`GIT_TERMINAL_PROMPT=0` / the `ls-remote` deadline.

## 2026-08-11 — the inactivity watchdog no longer kills a build whose planner is thinking (#185)

`PROFILE_WARM_FIRE` now sets a 30-minute inactivity window, threaded through
`buildLlmCallSubstrate` and the Claude Code adapter to
`PersistentReplSubstrateOptions.turnTimeoutMs`.

Both owner attempts at the Email Core P1 build died on this (2026-08-07,
2026-08-10), and the cause was in the launcher rather than in trident's review
half. The workflow's agents run as sidechains of the fire session, so the
launching turn stays open for the whole build; that session was guarded by a 90s
window advanced by PTY bytes from the child; a reasoning-heavy step emits none;
and on a trip the pool poisons and respawns the warm session, killing the
detached build it hosts. The Aug 7 planner transcript ends with
`[Request interrupted by user]` at 23:19:21 with the respawn logged 8 seconds
later — no checkpoint, no PR, no parseable result, surfacing to the owner as
"terminal result missing/garbled". Since Ralph mode's first step is `plan:fable`
at max effort over SPEC.md plus a governed plan doc, a larger plan died more
reliably.

The new window sits below the 45-minute absolute ceiling, which remains the
terminal authority, so a genuinely wedged launcher still dies. Every other
profile is unaffected, and that is asserted rather than assumed.

Worth recording: this watchdog replaced a fixed 180s cap that was removed on
2026-07-01 because it killed one of the owner's working builds. The replacement
killed one too, by a different mechanism, because "actively working" was measured
as terminal chatter.

Tested against the production composer's output rather than a hand-built config
literal, so it fails if `substrates.ts` stops passing the profile.
Mutation-verified: removing the window from the profile fails four tests, and
keeping it while the factory silently stops threading it fails two.
## 2026-08-11 — a nit may not cost a round (#184)

`enforceSeverityGate` in `trident/inner-workflow.mjs` now enforces
deterministically what the synthesis prompt has always merely asserted: a
non-blocking finding does not block a merge on its own. A `REQUEST_CHANGES` is
downgraded to `APPROVE` only when every finding is explicitly `minor` or `nit`,
and the findings survive on the returned verdict. Nothing posts them to the PR:
they reach the next round's fix prompt if a later gate re-blocks, and on a clean
downgrade they are dropped, since the APPROVE-path terminal result carries no
findings.

The rule had no enforcement, so it held only as far as one model's obedience.
It did not hold: PR #171 saw a reviewer seat return APPROVE with four MINOR/NIT
findings while the synthesis returned REQUEST_CHANGES, and on 2026-08-11 six of
six capped lanes terminated REQUEST_CHANGES with none converging — a reviewer
asked for findings always finds some, so a loop that blocks on non-blocking
findings cannot terminate by construction.

The gate can only turn a rejection into a pass, so it refuses whenever anything
is ambiguous. It enumerates the NON-blocking severities rather than the blocking
ones, which makes an unknown, absent or misspelled severity block rather than
pass; a rejection carrying no findings at all is left untouched; and it runs
first in the chain so the CI gate and the cross-model gate both retain the last
word. Red CI and a deferred reviewer still veto an `APPROVE`, and a rejection
carrying a `blocker` or `major` is never downgraded.

What `blocker` and `major` do NOT do is veto an `APPROVE`. `enforceSeverityGate`
returns early on any verdict that is not `REQUEST_CHANGES` and no later gate
reads severities, so an `APPROVE` carrying a blocker finding merges on green CI
with no deferred peer — asked for only by the synthesis prompt, which is the
same unenforced-rule shape this section exists to remove. Known gap, recorded
rather than papered over.

Tested against the real function extracted from the `.mjs` and evaluated rather
than a hand-copied duplicate. 18 tests, 55 assertions, mutation-verified:
admitting `major` to the non-blocking set fails two of them, and dropping the
empty-findings guard fails one.

The prose guards that police the docblock are mutation-verified too, and the
carve-out that exempts the one past-tense record of #184's claim is bounded by a
literal at BOTH ends. It used to run to the next `)`, which meant deleting the
citation's closing paren — an ordinary copy-edit — silently stretched the
exemption over the entire IMPLEMENTED section: a present-tense "the mutation
prover still vetoes a bad APPROVE today" written in the swallowed region passed
at 17 pass / 0 fail. An exemption that widens on its own is a gate that stops
firing with nobody watching, so an edit to either end now throws instead.

## 2026-08-08 — one cancel surface reads and stops both build lifecycles (#515)

The `codegen_status`, `codegen_fetch`, and `codegen_cancel` tools now keep their
legacy Code-Gen tracker behavior and fall through to the foundational Trident run
store when the reference is not a legacy task. References accept the globally
unique full run id, or an unambiguous displayed id prefix / run slug across the
single-owner database. This reaches General and project-board runs even though
the Core factory context carries only the owner handle. Blank and ambiguous
references are rejected without changing any run. A live
Trident run is atomically moved to `stopped` through the existing terminal-write
chokepoint. A run that already reached `done`, `failed`, or `stopped` is returned
truthfully with its phase and persisted failure reason; it is not mislabeled as
an unknown run. Malformed tool payloads retain the Code-Gen input-error contract
instead of leaking native property-access errors. Tool cancel uses a dedicated
terminal-observer composition: delivery is a no-op because the tool result is the
user notification, while board reconciliation and skill-forge audit still run.
This is a run-lifecycle control only and
does not add chat-turn cancel or a Stop button. An already-started inner workflow
cannot currently be killed; the durable run is stopped so its eventual output
cannot advance or merge through the Trident loop.

Mutation-named gateway tests pin the contract: removing Trident termination
leaves the durable row live; hiding an already-terminal row restores the false
alarm; bypassing the legacy tracker breaks the path that already worked; and
removing read routing, prefix resolution, project scope, or production factory
wiring makes the corresponding test fail.

## 2026-08-06 — push registration self-heals on foreground, so a signed-in device stops going dark

Branch `fix/push-registration-self-heal`. ISSUES #487 (the residual its
observability half deliberately left open).

**The defect was not in the push path.** `push_dispatcher` is composed
(`open/composer.ts:3001`), passed (`:5144`), attached as the reminder loop's
`on_fired` (`gateway/composition/build-core-modules.ts:396-397`), and
`pushReminder` reads the token table first and no-ops when it is empty — by
design. It behaved exactly as written. The defect was that NOTHING EVER
REGISTERED A SECOND TIME: `enablePushForUser` had two call sites, both inside
the login flow (`app/app/login.tsx:228,352`), and nothing subscribed to
AppState. A session survives launches for weeks, so a device that signed in once
never called the endpoint again.

**Measured, not inferred.** On the live instance 2026-08-06,
`device_push_tokens` held **0 rows** and the server journal showed **zero**
`devices/register` requests in 14 days. Every proactive surface — morning brief,
evening wrap, idle nudges, and a ritual re-approval request — was therefore
visible only when the owner happened to open a client. That is not a theoretical
cost: the same day, both the morning brief and the evening wrap skipped for 16
hours because a re-approval prompt sat unseen.

**Shipped.** `app/components/PushRegistrationSync.tsx`, mounted inside
`AuthSessionProvider` in `app/app/_layout.tsx` next to `DiagnosticsSync`, calls
`enablePushForUser` on authenticated launch and on every background→active
transition. Register upserts on `(project_slug, device_token)`
(`gateway/push/store.ts:91-94`), so repeat calls cost one request and one
`updated_at`; once the OS holds a permission decision,
`requestPermissionsAsync` resolves from it without UI, so this never nags.
Foreground rather than launch-only is load-bearing — an Expo token rotates while
the app stays warm, and permission is granted in the OS Settings app, which
returns through `inactive → active`.

**The decisions live in `app/lib/push-registration-sync.ts`, which imports
neither `react-native` nor `expo-notifications`,** because the app suite cannot
load either — the same constraint that put the outcome→diagnostic mapping in
`push-observability.ts`. Logic reachable only from inside the component would
have been untestable, and untestable is how a self-healing mechanism quietly
stops healing.

**Tests + mutation results.** `app/__tests__/push-registration-sync.test.ts`,
9 tests. Three mutations, each red: making `cameToForeground` ignore `prev`
(so every `active` re-registers) reds the already-active arm; deleting
`<PushRegistrationSync />` from the root layout reds the mount arm; and moving
the guard clear out of `finally` into the success path reds the throwing-enable
arm. The third mutation is the one worth naming — a leaked guard would stop
registration healing after its first transient failure, with nothing looking
broken. A first attempt at that mutation SURVIVED because it left the `finally`
in place alongside the added clear: the guard was doubled, not tested. No
feature flag; the sync ships on as default behaviour.

**Not yet verifiable end-to-end.** A registered row requires the owner to open
the app on a build carrying this change, so #487 stays open until
`device_push_tokens` holds a row. Shipping is not the same as proving, and the
empty table is the only evidence that counts.

## 2026-08-06 — the daily email digest reads the inbox; it had never once succeeded

Branch `fix/email-digest-project-label`.

**Found by reading the live journal while answering "does the email core cover
what my email app does", not from a bug report.** The Email Core's triage
scheduler was composed, wired, started, and firing on time — 15:00 UTC = 08:00
owner-local, every day. Every fire died on both connected mailboxes:

```
[open-cores] event=email_account_read_failed operation=listMessages
  error="Gmail API 400: Invalid label: Neutron/<project_id>"
```

**Two defects, stacked, and the loud one hid the quiet one.**

1. *Mechanical.* `cores/free/email/src/google-client.ts` appended the project
   label NAME as a second `labelIds` value. Gmail's `labelIds` takes label IDs;
   a system label's id equals its name (`INBOX`), a user label's does not
   (`Label_7`), so the request was invalid by construction. The same file knew
   better in two places — the draft and send paths resolve the name through
   `ensureLabelImpl` because "threads.modify wants a label_id, NOT a label_name"
   (`:338`), and `search` AND-s `label:<name>` into `q`. The list path now does
   what `search` does. It also fails SOFT: an unknown label in `q` returns an
   empty set instead of a 400, so "nothing matches yet" stops being reported as
   "your request is invalid".

2. *Semantic, and worse.* `triage-scheduler.ts` scoped the inbox read to
   `Neutron/<project_id>` at all. That label is applied only by the draft/send
   paths, to mail Neutron itself wrote — so a FIXED version of the old call would
   have composed the owner's morning digest from his own outbound threads. The
   tick now reads the whole `INBOX`; `project_id` selects where the digest is
   POSTED, never which mail counts.

**Why it survived a 46-test suite: the tests only ever counted whether the
scheduler FIRED.** They passed identically before and after the scoping was
removed, and passed with the in-memory client filtering the seeded message out —
a digest composed over an empty inbox is indistinguishable from a working one if
nothing asserts what it saw. This is the forbidden pattern in CLAUDE.md
("integration tests that only assert bookkeeping"), caught in the wild.

**Tests + mutation results.** Four new tests. `triage-scheduler.test.ts` gains
"the inbox read carries NO project scope" and "the digest actually SEES ordinary
inbox mail" — restoring `project_id` to the tick reds BOTH. `backend.test.ts`
gains a `q`-vs-`labelIds` pair; putting the label name back into `labelIds` reds
one. 70 tests green across the four related suites. No feature flag.


## 2026-08-05 — the ritual lane is deleted; a ritual is a reminder that fires into the owner's own session

Branch `fix/issue-504-delete-ritual-lane`. ISSUES #504 + #506; decision of record:
neutron-managed `SPEC.md` § Decisions Log 2026-08-05, which OVERTURNS the
sandboxed-ritual-substrate design of 2026-07-20.

**The problem, in one branch.** `reminders/tick.ts` routed a due row with a
non-null `ritual_id` to `ritual_executor.fire(reminder)` INSTEAD of the nudge
dispatcher. Downstream of that single fork a normal reminder composed on the
project's warm pooled session and inherited everything it has — Cores, the
native-MCP tool bridge, calendar, Drive, memory — while a ritual spawned a fresh
ephemeral `cc-ritual-*` REPL that wired NO tool bridge. So the morning brief could
not read the owner's calendar: granting `mcp__neutron__calendar_list` in its
`tool_surface` validated and then failed, because the MCP server it named did not
exist inside the sandbox. **The lane built to make rituals SAFE was the lane that
made them USELESS.** All three bundled rituals (`morning-brief`, `evening-wrap`,
`kaizen`) were affected through that one line; there was no fourth.

**The fix is a deletion, not a flag.** `reminders/tick.ts` now hands EVERY due row
to `dispatcher.dispatch` and has no `ritual_id` branch, no `ritual_executor`
option, and no knowledge of rituals. `reminders/dispatcher.ts` became the ONE
fire-time path: it asks a ritual fire PLANNER (new `reminders/ritual-fire.ts`) what
the row composes from and what must be recorded, then composes and posts through
the same `llm.compose` call and the same outbound for both kinds. A `nudge` answer
composes the stored message; a `skipped` answer writes a durable
`code_ritual_runs` 'skipped' row and posts nothing; a `fire` answer writes a
`'running'` row, composes the APPROVED PROMPT on the owner's warm `cc-agent-*`
session, posts, and settles the ledger.

**Deleted** (with their tests, not orphaned): `reminders/ritual-executor.ts`,
`reminders/ritual-retry.ts`, `reminders/prompt-path.ts`,
`reminders/ritual-agent-base.md`, `makeRitualSubstrate` (`open/wiring/substrates.ts`),
`PROFILE_RITUAL` (`gateway/wiring/substrate-profiles.ts`) and its
equivalence-net entry, the separate `agent_kind:'ritual'` concurrency lane +
`MAX_CONCURRENT_RITUALS` (`runtime/subagent/spawn.ts`, `registry.ts` — one lane
now), `CompositionInput.ritual_executor_factory` (replaced by the
`init_ritual_planner` install hook), and the orphaned
`collapseAttemptsToOccurrences`. The `AgentKind` union member `'ritual'` and
migration 0106's CHECK are RETAINED for historical rows, documented as legacy —
dropping a value from a SQLite CHECK means a table rebuild.

**The security moved to the approval gate, which is now the only boundary.** Kept
and exercised on every fire: fail-closed `validateRitualFire`, the content-hash
binding recomputed from LIVE bytes, `RITUAL_ID_RE`, the non-empty-`tool_surface`
pin (#361), the approval records, and the `code_ritual_runs` ledger.

**⚠️ `tool_surface` is now an APPROVAL DECLARATION, not a runtime grant — a
mechanical consequence.** A ritual composes on the owner's warm pooled session,
whose `--tools` allow-list is fixed at SPAWN, and the persistent-REPL reuse guard
EVICTS AND RESPAWNS a warm child whose requested surface differs
(`runtime/adapters/claude-code/persistent/spawn.ts:824,837`). Passing a per-ritual
surface would not restrict the ritual — it would destroy the owner's live chat REPL
on every fire and his next chat turn would destroy it again. This also exposed a
PRE-EXISTING defect: `reminders/dispatcher.ts` had its own narrower
`['Read','Glob','Grep']` default, so **every fired reminder was already evicting
the owner's warm chat session.** `LIVE_AGENT_TOOL_NAMES` is now exported from
`gateway/wiring/build-live-agent-turn.ts` and threaded by the composer as
`tool_names`. The bundled defs' `description` strings were rewritten to stop
promising "no shell, no writes, no network" — that string is rendered verbatim into
the approval prompt, so under the new runtime it was the gate lying to the owner at
the moment he decides.

**`RITUAL_TIMEOUT_MS` 45 min → 10 min, ONE constant.** A ritual is now one AWAITED
turn inside a SINGLE-FLIGHT tick, so its budget is also the longest it can stall
every other due reminder. The constant is hashed into the approval grant by BOTH
the request and check sides; a second constant for the real budget would have made
every approved ritual compute a different hash at fire time and refuse as
`unapproved` forever (caught before merge). Changing it invalidates existing
approvals BY DESIGN — the runtime changed from a read-only sandbox to the owner's
fully-capable session, so an old grant must not silently carry over.

**New `service.reapprove(id)` + a hash-aware boot sweep, because otherwise that
invalidation is a silent death.** `enable()` refuses once `<id>.def.json` exists and
the sweep treated that file as "done", so a ritual whose live hash lost its grant
had no prompt and no fire — only durable 'unapproved' rows nobody reads.
`bundled-ritual-enable.ts` now consults `status()` and re-requests when the live
hash has NO grant, leaving `pending` alone and `denied` denied. This also closes a
pre-existing silent death: an owner editing `<owner_home>/rituals/<id>.md`.

**Collapsed to ONE morning brief.** `gateway/proactive/morning-brief.ts` DELETED
with its cron (`proactive.morning_brief`), its `tasks.proactive` config keys
(`sources`, `composeBrief`, `brief_hour`, `brief_interval_ms`) and its test. It
declared `calendarToday`/`entityDeltas`/`projectStatus` providers that **nothing in
production ever supplied** — only its own test — the persona-gen shape, and the
reason its brief had to say "I couldn't check your calendar". The RITUAL survives
because it is the one that can reach a Core. `proactive_brief_log` +
`ProactiveStateStore.hasBriefForDay`/`recordBriefForDay` are left in place unused
rather than migrated away. (`onboarding/overnight/morning-brief.ts` shares the
filename but is the OVERNIGHT-WORK reporter — wired, working, untouched.)

**ISSUES #506 — a failed ritual is now diagnosable.** The old lane recorded
`failure_reason: "retry exhausted after 1 attempts: failed"` (inner cause: the
literal word `failed`) and logged nothing that named the ritual, so a real
`evening-wrap` failure had no trace on either surface. `composeTurn` now returns the
CAUSE rather than a bare null, the ritual path writes that verbatim into the ledger
(capped by `MAX_RITUAL_FAILURE_REASON_CHARS`), and the failure is logged at ERROR
with ritual_id + run_id. The `1 attempts` puzzle is also explained: the deleted
`alreadyDelivered` guard keyed on `reminder_id`, which a RECURRING ritual reuses
across occurrences, so one past `finished` row suppressed every future retry — moot
now that the retry machinery is gone.

**Tests.** New: `reminders/ritual-fire.ts` coverage via a rewritten
`reminders/bundled-rituals.test.ts` (fail-closed unapproved → durable row + NO turn
+ NO post; approved → ONE turn carrying the approved prompt bytes and the LIVE-CHAT
surface incl. `Bash`, ledger running→finished, body posted; empty turn → recorded +
noticed failure), `gateway/wiring/__tests__/reminder-compose-tool-surface-parity.test.ts`
(cross-layer: `reminders` cannot import the gateway constant, so nothing else can
see both halves), `open/__tests__/open-reminder-dispatch-tool-surface.test.ts`
(walks the REAL composer, captures the AgentSpec that reaches the substrate).
Rewritten: `reminders/tick.test.ts` (the OLD suite pinned "a ritual routes to
`ritual_executor.fire`, NEVER the dispatcher" — the exact defect; it now pins one
dispatch target for every row), `gateway/composition/build-core-modules-ritual-planner.test.ts`,
`runtime/subagent/spawn-lane.test.ts`. Six mutations applied and ALL SIX killed:
reintroduce the second lane (5 fail), fail-open validation (2), skip the ledger
write (3), break the nudge post path (14), restore #506's tautological reason (1),
drop the composer's `tool_names` (1). Suites green: `reminders/` 377 pass / 3 skip,
plus the affected gateway/open/runtime files; `bunx tsc -p tsconfig.json` and
`bash scripts/ci/typecheck-all.sh` clean.
## 2026-08-05 — mobile chat opens at the bottom, and only anchors a message top when it is unread

Branch `fix/issue-505-chat-initial-anchor` (ISSUES #505). Changed:
`app/lib/chat-core/chat-initial-anchor.ts` (new),
`app/components/ChatSyncSurface.tsx`,
`app/__tests__/support/stubs/flash-list.tsx`,
`app/__tests__/chat-opens-at-the-bottom.test.tsx` (new).

(Paths are repo-relative, as every entry in this file is. A FILESYSTEM-absolute
path would carry the owner's home directory into a permanently public tree, and
the leak gate rejects it — it caught these four lines on the first CI run.)

**Reported:** switching to a project opened it at the TOP of the last message
instead of the bottom of the transcript — only visible when that message is
taller than the screen, which most agent replies are, so it read as "the app
opened half-way up a wall of text".

**It was not an unread anchor firing unconditionally; there was no unread anchor
at all.** The surface passed FlashList
`maintainVisibleContentPosition.startRenderingFromBottom: true`, and on a
transcript taller than the screen that prop's only positioning effect is
`initialScrollIndex = dataLength - 1`
(`@shopify/flash-list/src/recyclerview/RecyclerViewManager.ts:332-339`), which
scrolls to `getLayout(lastIndex).y` — the last item's TOP edge
(`recyclerview/hooks/useRecyclerViewController.tsx:596-600`). Its own docblock
scopes it to "chat-like interfaces when there are only few messages"
(`FlashListProps.ts:406-408`). The bug was height-dependent for the same reason
the fix works: the last item's top edge is only a reachable offset when that item
is taller than the viewport, and otherwise the native scroll view clamps it back
to the content bottom — which is why a short final message always looked right.
That clamp is verified in RN's source, not assumed
(`RCTScrollView.m:571-593` Paper, `RCTScrollViewComponentView.mm:858-876` Fabric;
neither sets `scrollToOverflowEnabled`).

**Read state already existed and was reused, not reinvented.** `ChatMessage.read_by`
is the server-assigned set of device ids that have read a message
(`chat-core/types.ts:164-170`), merged by set-union (`chat-core/store.ts:114`),
patched from `receipt_update` (`chat-core/sync-engine.ts:125`) and persisted in the
mobile SQLite store (`app/lib/chat-core/sqlite-store.ts:85,405,444`), so it
survives the cold open a project switch performs. The new module only reads it;
no schema change, no second vocabulary.

**The rule, in one pure function.** `chatInitialAnchor(rows, selfDeviceId)` returns
the top of the first unread inbound row when unread exist, else the transcript
bottom. `anchorScrollProps` turns that into FlashList's
`initialScrollIndex` / `initialScrollIndexParams`. The bottom case is expressed as
a deliberate overscroll past the last row's top edge, fed through FlashList's OWN
`viewOffset` rather than corrected afterwards — `applyInitialScrollIndex` re-applies
its offset on a `setTimeout(…, 0)`
(`useRecyclerViewController.tsx:596-613`), so a `scrollToEnd` issued from a layout
effect would be undone a macrotask later. Changing the offset the library targets
means both of its applications land on the content bottom: one mechanism, no
correction after paint, no visible jump, and no animation (the initial position is
a starting point, not a transition). `startRenderingFromBottom` stays for its other
job — the top margin that pushes a transcript shorter than the screen down to hug
the composer (`RecyclerView.tsx:597-608`).

**Two failure directions closed deliberately.** The anchor is FROZEN per project on
the first snapshot carrying both a row and a device id, because
`onViewableItemsChanged` starts marking rows read the instant the surface paints —
a live recomputation would erase the unread anchor before FlashList applied it. And
the anchor degrades to `bottom` whenever the read signal cannot be trusted (no
device id yet, or not one row read by this device), because `read_by` is optional
and additive: a history synced before receipts existed presents as entirely unread,
and anchoring on that would open a long transcript at its very first message —
worse than the bug. The receipt-eligibility predicate is now shared between the
anchor and the marker so the two sets cannot drift; a row the anchor counted but
the marker never reported would stay unread forever.

**Mutation-tested, four ways.** Stripping the bottom overscroll (the original bug)
reds 3; collapsing the rule to "always bottom" (the naive fix) reds 3, including
the unread regression arm; making the overscroll conditional on row count reds the
short-last-message arm; and unwiring `{...anchorProps}` from the FlashList reds
exactly the two wiring tests while the pure arms stay green. The FlashList test
stub now records its props, because that stub does not virtualise and has no scroll
offset — the honest assertion at this level is which position the surface ASKS for,
and the step from that ask to a pixel stays a device claim. No feature flag; the
behaviour ships on as the default.

## 2026-08-04 — the two voice-transcription clients now fail the same way

Branch `fix/voice-client-error-shape-parity` (ISSUES #503). Changed:
`app/lib/voice-transcription-client.ts`,
`landing/chat-react/voice-transcription-client.ts`,
`app/__tests__/voice-transcription-mirror-parity.test.ts`,
`app/__tests__/voice-transcription-settings.test.ts`.

**Two divergences, both outside the guard that was supposed to cover them.** The
app and web voice-transcription clients hand-declare the same wire shapes on
purpose (no browser package in the Metro bundle), and the mirror-parity guard
added alongside them pins those shapes. It pins what goes over the WIRE. Two
things that are not wire shapes drifted underneath it.

**One: the web client had no request timeout.** The app client aborts at 15s and
throws `timeout`; the web client had nothing, and `fetch` has no default on
either runtime. A connection that is accepted and then goes nowhere — a server
restarted under an open tab, a proxy that stops answering — left the web card on
its loading line forever. The web client now runs the app's mechanism verbatim:
an `AbortController` passed to `fetch`, a `timeoutMs` option defaulting to the
same `REQUEST_TIMEOUT_MS = 15_000`, cleared in a `finally`, and on abort the same
`VoiceTranscriptionClientError` with code `timeout`, status `0`, and the same
wording. The point of the pair is that the two surfaces fail identically; a
shorter web timeout would have been defensible on link quality alone but would
have made the same dead server read differently on each surface, which is the
divergence being closed rather than a new one worth opening.

**Two: `VoiceTranscriptionClientError` took its arguments in opposite orders.**
`(status, code, message)` on the app side, `(code, message, status)` on the web
side. Both files are near-mirrors, both orders read plausibly, and each file was
internally consistent — so nothing was red. A construction copied between them
produced a silently wrong error object: a status where a code belongs.

**Converged on `(code, message, status)`, which meant moving the app side.** The
naive read is that the app side should win, because in these two files it has
more construction sites (5 to 2). Across the repo it is the other way round:
`(code, message, status)` is what 23 client-error classes take, including every
one of this file's siblings in both trees (`app/lib/tabs-client.ts:50`,
`cores-client.ts:125`, `reminders-client.ts:188`,
`landing/chat-react/tabs-client.ts:58`, and the rest). Converging on the app's
order would have made voice-transcription the odd one out among 25 and relocated
the same copy-between-files hazard to a much larger blast radius. Five call sites
moved: three in `app/lib/voice-transcription-client.ts` (the timeout, the
non-JSON `bad_response`, and the non-2xx server body) and two in
`app/__tests__/voice-transcription-settings.test.ts`. No `catch` block moved —
every consumer reads `.code` / `.status` by name (`voice-transcription-view.ts:194`).

**The guard now covers constructor shape.** Three layers, because no single one
of them is sufficient:

  - COMPILE-TIME. `ConstructorParameters<typeof C>` is the parameter list as a
    tuple, and tuple assignment is element-wise and positional; asserted both
    ways it pins parameter types AND order. The fields the constructor populates
    (`code` / `status` / `message`) are pinned separately, so a rename or a
    retype cannot pass by keeping the tuple assignable.
  - SOURCE TEXT. `tsc` never compares parameter NAMES, so a future same-typed
    swap — `(code, message)` against `(message, code)` — produces identical
    tuples and passes every type-level assertion. The constructor's parameter
    list is read out of both files and compared in order, and pinned to its
    literal value so a broken extractor cannot pass vacuously by returning an
    empty list on both sides.
  - BEHAVIOUR. `bun test` does not typecheck, so on the test job the above is
    inert. Both clients are driven over the same 409 body, the same non-JSON
    404, and the same hanging connection, and the thrown errors are asserted
    field-identical. This is the layer that catches a transposition at a CALL
    SITE inside either client rather than in the declaration.

`VoiceTranscriptionClientOptions` also joined both the type-level drift guards
and the existing source-text interface comparison, which is what mechanically
requires the web client to keep carrying a `timeoutMs`.

**Mutation-tested.** Reverting the app side to `(status, code, message)` reds the
source-text guard, the behavioural guard, and the typecheck job. Deleting the
web timeout reds the timeout parity test in ~500 ms via a sentinel race rather
than hanging the suite, and reds the options-parity and default-constant tests.
A successful request is unaffected by either change.

**Still an outlier.** `app/lib/admin-personality-client.ts:75` is the one
remaining `(status, code, message)` client error in the repo. It has no mirror,
so it is not this defect, but it is the same shape and worth a follow-up.

## 2026-08-04 — the model watchdog adopts only what is demonstrably newer

Branch `fix/issue-491-model-watchdog-newer-only`. Changed:
`runtime/adapters/claude-code/persistent/model-update-watchdog.ts`,
`runtime/adapters/claude-code/persistent/supervision.ts`,
`runtime/adapters/claude-code/persistent/__tests__/model-update-watchdog.test.ts`,
`runtime/adapters/claude-code/persistent/__tests__/model-update-watchdog-wiring.test.ts`.

**The problem.** `decideModelUpdate` compared the probed model id to the baseline
for EQUALITY. Equal meant `no-change`; everything else fell through to a comment
reading "A genuinely new model" and returned `notify` — and the `notify` arm
adopts the id as the runtime default and writes it to `last_known_model`. So
"different from what we run" was being read as "newer than what we run", which it
is not. A probe answering with an older id, a variant, or a garbled value moved
the owner's model backwards, and because the answer was persisted the downgrade
survived restarts with no moment at which it would correct itself.

**The fix is a rank, not a comparison.** `compareModelRecency` parses an id into a
family plus a numeric version tuple (`claude-opus-4-7` → `opus` + `[4,7]`) and
ranks the probe against the baseline. Only `newer` may be adopted. `older` and
`unknown` — unparseable, or a different model family — are refused and logged.
The rank is derived from the id itself rather than from a registry of known
models on purpose: a registry-membership test would rank every genuinely new
model as unrecognised, which is precisely the model the watchdog exists to pick
up, so it would trade this bug for the stale-model incident that motivated the
watchdog. `claude-opus-6` ranks newer than `claude-opus-5` on the day it ships,
with no code change.

**The same bug had a second, restart-scoped copy.** The re-hydrate-on-start path
re-applied a persisted `last_known_model` on mere inequality with the configured
base. That re-pinned a downgraded id on every subsequent boot, and it also meant
a persisted id could override a LATER release's `BEST_MODEL` seed — silently
undoing an upgrade the owner installed. It now requires a `newer` rank too.

**Family-scoped ranking closes a hole the fallback set could not.**
`isFallbackModel` lists specific lower-tier ids, so an unlisted one such as
`claude-sonnet-5` sailed past it and would have been adopted as the new best
model. A different family now ranks `unknown` and is refused regardless of
whether anyone remembered to list it.

**The watchdog's log channel was dead.** `startModelUpdateWatchdogForInstance`
never passed `log` or `onError`, so `startModelUpdateWatchdog` fell back to its
`() => {}` default and every operational line it emits — probe failed, fallback-id
outage — went nowhere in a real install. The graceful upgrade underneath it was
already wired to `log.info`; the watchdog itself was not. Both are now wired to
the same logger, because a guard whose observability is dead code cannot tell the
owner that a weird probe happened.

**A stale test fixture was asserting the bug was correct.** The wiring test
probed `claude-opus-4-9` and asserted the runtime flipped to it. Once the
`BEST_MODEL` seed moved to `claude-opus-5`, that assertion was demanding a
DOWNGRADE — and it passed, because the code under test performed one. The fixture
is now a constant with an explicit rank assertion, so the same rot fails loudly
instead of silently inverting the test's meaning.

Refused probes advance the 6h gate rather than retrying in 15 minutes like
`skip-outage` does. An outage is the probe lying and the truth returns within
hours, so a fast retry recovers; a downgrade or unrankable answer may be the
CLI's stable, correct report about a changed world, and a fast retry loop would
then spawn a probe child four times an hour forever with no path to resolution.
Nothing is broken meanwhile — the id was never adopted.

## 2026-08-04 — the voice-transcription parity guard the docblock promised now exists (ISSUES #498)

Branch `fix/voice-transcription-mirror-parity-498`. New:
`app/__tests__/voice-transcription-mirror-parity.test.ts`. Changed:
`app/lib/voice-transcription-client.ts`,
`landing/chat-react/voice-transcription-client.ts` (docblocks only).

**The problem.** `app/lib/voice-transcription-client.ts:21-23` told every reader
the duplicated web/app wire types were "held honest mechanically by
`__tests__/voice-transcription-mirror-parity.test.ts`, which diffs the two type
declarations, exactly as `tab-descriptor-mirror-parity.test.ts` does." The
sibling it cited is real. The file it cited was not — `ls app/__tests__/` had no
such entry. So the shapes behind `/api/app/voice-transcription` were declared
twice, by hand, with nothing comparing them.

This is worse than an ordinary stale comment, and the difference is worth naming
because the same sentence pattern will recur. A docblock that says *this works*
invites a reader to check it. A docblock that says *this is checked* tells the
reader the checking is already done, so nobody checks. Naming a real precedent
and a plausible filename is what made it credible. The fix is to make the
sentence true, not to soften it: deleting it would have removed the claim and
left the drift risk exactly where it was.

**What was built.** The named test, using the mechanism the cited precedent
already uses rather than a second idiom — `tsc` is the guard, `bun test` is the
backstop:

- Bidirectional structural assignment through values typed as one side and
  assigned to the other and back (`tab-descriptor-mirror-parity.test.ts:67-68`).
- `never`-guarded difference assertions in the vocabulary of
  `agent-engagement-mode-mirror-parity.test.ts:73`, generalised to key sets:
  `Drift<A, B> = Exclude<A, B> | Exclude<B, A>` is `never` exactly when the two
  sides agree, and a `never` parameter cannot receive a live member. This is not
  ornamental. Bidirectional assignment ALONE does not catch an OPTIONAL field
  added on one side — width subtyping accepts an extra property on a non-fresh
  value in both directions — and mutation M2 below confirms the `Drift`
  assertion is the only thing that reds on it.
- Two fully-populated samples, each annotated with its own side's type so each
  is excess-property-checked against its own declaration, asserted deep-equal
  including a recursive key-tree comparison.
- Both clients driven over the same server payloads (current, pre-backend-choice,
  empty) with their outputs asserted equal. `normalizeStatus` — the old-server
  defaulting logic — is copied verbatim into both files, and that copy is
  invisible to the type check.

**Were they already drifted?** No. Diffing the two type blocks
(`app/lib/voice-transcription-client.ts:30-106` against
`landing/chat-react/voice-transcription-client.ts:26-104`, semicolons
normalised) leaves only two doc-comment wordings on `binary_downloadable` and
`binary_present`. Nine wire types, structurally identical. The test
characterizes that agreement rather than repairing a break.

**Mutation results.** Six mutations of the web declaration, each reverted:
M1 required field added → typecheck RED (TS2322 on the `never` guard + TS2741 on
the sample). M2 OPTIONAL field added → typecheck RED, and ONLY on the `never`
guard. M3 `installed_bytes` retyped `number`→`string` → RED. M4
`whisper_version` renamed → RED. M5 a member added to `WhisperInstallPhase` →
RED. M6 `normalizeStatus` default changed `null`→`'local'` → typecheck GREEN,
`bun test` RED on the pre-backend-choice case. So the type layer and the
behaviour layer each catch what only they can see.

M1-M5 red the typecheck job, not the test job. That is structural, not a gap:
`bun test` does not typecheck, so no runtime assertion can observe a type-only
edit. `scripts/ci/typecheck-all.sh` runs `tsc -p app/tsconfig.json`, whose
`include` is `**/*.ts` and therefore covers `app/__tests__/`. Both docblocks now
say so explicitly rather than leaving a reader to assume the test job is the
guard.

**Other corrections to the docblock.** The claim of parity with
`tab-descriptor-mirror-parity.test.ts` was imprecise in one way worth fixing:
that test pins its two mirrors against a THIRD leg, the engine's own
`tabs/registry.ts` declaration. There is no third leg here. `buildStatus()` at
`gateway/http/voice-transcription-surface.ts:104` is declared `Promise<object>`,
so the server carries no type at all for the shape it sends; the two clients are
the only declarations that exist. Both docblocks now state that the guard is
two-sided and why. The route table, the one-way key claim, the server-side
download claim and the no-browser-dependency claim were each checked against the
code and all hold (`gateway/http/voice-transcription-surface.ts:178-275`;
`OpenAiKeyStatus` carries presence and provenance only; no file under `app/`
outside `__tests__/` imports `@neutronai/landing`).

## 2026-08-04 — an expired Google grant now says so, in chat

Branch `feat/oauth-reconnect-chat-notice`. New:
`gateway/cores/oauth-reconnect-notice.ts`,
`gateway/cores/__tests__/oauth-reconnect-notice.test.ts`. Changed:
`gateway/cores/oauth-token-manager.ts`, `gateway/cores/mount-open-cores.ts`,
`gateway/composition/wire-cores-surfaces.ts`,
`gateway/composition/input/cores-input.ts`, `open/composer.ts`.

**The problem.** A Google OAuth client left in Testing has its refresh tokens
expired by Google roughly weekly, so a connected account dies on a schedule. The
system already KNEW: a refresh that comes back `invalid_grant` fires
`onInvalidGrant` (`gateway/cores/oauth-token-manager.ts:599`), and the one
supplied callback marked every affected Core `install_failed_runtime`
(`gateway/composition/wire-cores-surfaces.ts:66`). That is internal state visible
only to someone already looking at the Integrations list. Nobody told the owner,
so a Core stopped working and he found out days later by noticing that something
he relies on had quietly not been happening.

**Both halves existed; the join did not.** The detector was wired and
`gateway/http/deliver.ts` is the one out-of-turn delivery seam with an existing
precedent for exactly this shape (`open/credential-lapse-notice.ts`). This change
is the missing consumer: `onInvalidGrant` now also posts ONE durable
`durability: 'inert'` message per dead grant, naming the account and carrying a
reconnect link. One message per expired thing, never a digest — two grants dying
in the same hour produce two messages, so acting on either is one unambiguous
act.

**It was wired to the wrong manager, and would never have fired.** There are TWO
`OAuthTokenManager`s on a box. The one carrying `onInvalidGrant`
(`wire-cores-surfaces.ts:61`) serves the HTTP surfaces and chat tools, which read
status and never drive a refresh. The one every Google-backed Core actually
resolves its token through (`gateway/cores/mount-open-cores.ts:282`) had no
callback at all. So the detector fired on the manager that does not refresh and
was absent from the one that does — a feature that compiles, tests, and never
runs in production. The notifier is now built once at the composition root and
shared by both: a grant DIES on the runtime manager and comes BACK on the surface
manager (the OAuth ingest re-grants through `exchangeAndPersist`), and one shared
instance is what lets the latch and its reset arm agree.

**The link is the Integrations page, not a consent URL.** Minting a Google
consent URL into the message looks right and cannot work: starting a grant writes
a `cores_oauth_pending` row with a TEN-MINUTE TTL
(`gateway/cores/oauth-pending-store.ts:18`), swept on expiry. This notice exists
precisely because the owner is not looking when a scheduled refresh fails, so a
URL minted at notice time is dead by the time he reads it — failing in the worst
way, as a link that looks like the fix and errors. The message instead links to
`INTEGRATIONS_RETURN_PATH` (`gateway/http/cores-oauth-broker-surface.ts:135`),
the same destination a completed grant already returns him to, whose Connect
control mints a fresh consent URL at the moment he taps it. It is a markdown
link rather than a `ButtonOption` because a tapped button's `value` is handed to
the model as `user_text` unless it matches one of two hardcoded sentinels
(`gateway/wiring/build-live-agent-turn.ts:960,975`); a markdown link is tappable
on both clients with no model turn in between, and options ride only on
`durability: 'reply'` (`gateway/http/deliver.ts:163`) anyway.

**Dedup, and its reset arm.** `onInvalidGrant` fires per REFRESH ATTEMPT and
every Core retries, so the naive join buries the chat. The latch is
`IncidentEdgeTracker` — the same rising-edge dedup the watchdog and the
credential-lapse notifier use — keyed by grant label, committed only after the
durable row lands, so a persist failure re-attempts instead of swallowing the one
message that mattered. `OAuthTokenManager` gained `onGrantHealthy`, fired from
`put` (the reconnect edge) and from a refresh that succeeded; without it the latch
never clears and the feature would notify once and then stay silent through every
future expiry. Two honest limits, both inherited from the precedent: the latch is
in-memory, so a restart while a grant is still dead re-tells him once; and unlike
the tick-driven precedent this notifier is called CONCURRENTLY, so a synchronous
in-flight check-and-set closes the window where `candidates` would hand the same
uncommitted incident to two callers.

**Tests + mutation results.** New `gateway/cores/__tests__/oauth-reconnect-notice.test.ts`
(15 tests). Four mutations, each red: removing the dedup latch reds 3 tests
including "three refresh attempts post exactly ONE notice"; removing the
in-flight guard reds the concurrent-refresh test; neutering `onGrantHealthy` reds
"after a reconnect, the NEXT death notifies again"; and dropping the
`noteHealthy` call from `put` reds the wiring test that proves the reset arm is
more than a field. The message is asserted to name the account, to never render
the hex account key, and to degrade to the SERVICE name rather than an anonymous
"a token expired" when the address cannot be read.

## 2026-08-04 — supervisor alerts stop corrupting the timeline; the rail goes quiet at rest

Branch `fix/rail-idle-dot-and-alert-timestamp`. Two independent defects the owner
hit in live use, one PR, two commits. Changed: `open/wiring/app-ws.ts`,
`open/composer.ts`, `chat-core/web-session.ts`, `chat-core/stores/opfs-store.ts`,
`landing/chat-react/ChatApp.tsx`, `landing/chat-react.html`,
`app/components/ProjectRail.tsx`, `docs/SYSTEM-OVERVIEW.md`, plus four test files.

### 1. Supervisor alerts sorted to the bottom of the transcript

**The symptom.** The owner sent a message and days-old `⚠️ Supervisor alert`
bubbles jumped BELOW it, each still printing its own true date, so the transcript
grew a `Fri Jul 24` divider underneath today's messages.

**Not a timestamp bug.** The tempting read is that the alert envelope's
`ts: Date.now()` is a push time that should be the event time. It is not: `ts` is
the EMIT time by contract (migration 0079 — "unix-ms emit time, used as the wire
`ts` on replay"), the alert is emitted the moment it fires, and the rendered
clocks were always correct. Substituting `WatchdogAlert.detected_at` would have
been actively wrong — detectors write it in SECONDS (`watchdog/detectors.ts`,
`now / 1000`) while every chat timestamp is MILLISECONDS, so it dates each alert
to 1970. A test asserts `ts > 1e12` precisely to kill that fix.

**The real cause is the missing `seq`.** The notifier broadcasts straight to the
socket registry, deliberately bypassing `AppWsAdapter.send` — the only path that
appends a `chat_log` row and stamps a `seq`. The frame is therefore a
`durability: 'none'` send, but it never said so, and `chat-core/web-session.ts`
persisted it anyway. `compareForDisplay` (`chat-core/store.ts`) orders every
`seq === null` row after all sequenced ones, so each persisted alert became a
permanent bubble pinned below the live transcript. `resolveImportRunningStatusDelivery`
already documents this exact tail-pinning seam for the import status bubble; the
two differ only in the right remedy (that one wants durability, an alert wants
ephemerality).

**Three parts.** (a) `buildWatchdogAlertEnvelope` — new pure exported builder in
`open/wiring/app-ws.ts`, consumed by the composer — tags the frame
`system_notice: true`, which is simply the truth about it. (b)
`chat-core/web-session.ts` now honours `isTransientSystemNotice` before
persisting: this is the WEB HALF of FIX #333, which mobile has had since
`mobile-session.ts:361` and web never got, so web was also persisting every
cold-start "⏳ Waking up…" ack. (c) `OpfsChatStore.hydrate` drops unreconcilable
agent rows (`role === 'agent' && seq === null`) — a browser that already ran the
buggy build still holds them, so without this one-time self-repair the fix is
invisible to the owner.

**Known trade-off, deliberately not decided here.** A `system_notice` frame
renders as the centred pill, which self-clears after 15s
(`controller.ts` `systemNoticeStaleMs`). That is consistent with the composer's
own framing of this push as a best-effort SECONDARY surface over the durable
`watchdog_alerts` ledger, but it does make an alert easy to miss. Choosing a
louder surface is a product decision for the SPEC, not something to smuggle into
a bug fix — flagged rather than taken.

### 2. The rail's idle dot painted a hollow grey ring

The owner: "i dont want this hollow grey circle when there is no activity. I only
want to see a pulsing indicator when there is activity." `railDotClass` now
returns `car-rail-dot-none` for idle, a rule with no background, border or ring —
matching the phone rail, which made the same change first and which this PR's
docblock update stops describing as a deliberate divergence.

Only the PAINT changed. The function stays TOTAL and the span stays in the tree
with its `role="button"`, `tabIndex`, `aria-label`, keyboard handler and `::after`
hit pad, because the dot is the Activity Inspector's ONLY entry point — nothing
else calls `onOpenActivity`. Rendering no element would have removed it and made
an idle scope uninspectable, which is the property the original always-visible
ring existed to protect.

`attention` is untouched and still paints. `railDotClass` never sees the
inspector's `wedged`/`dead` vocabulary at all — the rail runs on `ProjectActivity`
(`idle | working | attention`) from `deriveProjectActivity`, whose `attention` arm
covers a failed not-done item or a stalled live run. A regression test asserts
`attention` resolves to a class with a real fill; mutating that arm to fall
through to the unpainted slot reds it.

## 2026-08-04 — enable/disable connected accounts per project (ISSUES #500)

Branch `feat/per-project-account-selection`. New:
`migrations/0115_project_account_selection.sql`,
`project-credentials/account-selection-store.ts`,
`gateway/cores/__tests__/project-account-selection.test.ts`,
`gateway/http/__tests__/project-accounts-surface.test.ts`,
`landing/chat-react/__tests__/settings-tab-accounts.test.tsx`. Changed:
`gateway/cores/core-credential-resolver.ts`, `gateway/cores/mount-open-cores.ts`,
`gateway/http/project-credentials-surface.ts`, `gateway/http/route-slots.ts`,
`gateway/composition/input/app-surfaces-input.ts`, `open/composer.ts`,
`landing/chat-react/SettingsTab.tsx`,
`landing/chat-react/project-credentials-client.ts`, `landing/chat-react.html`,
`migrations/scope-rekey.ts`, `migrations/expected-schema.txt`,
`docs/SYSTEM-OVERVIEW.md`, plus the fixtures in six existing test files.

**The problem.** Every project read every connected account. Core installations
are `scope='global'` and documented "Project-agnostic"
(`cores/runtime/installations-store.ts:53`), and
`CoreCredentialResolver.accountsFor` returned EVERY account for a service
(`gateway/cores/core-credential-resolver.ts:30`) — so a question asked inside a
work project swept a personal calendar and mailbox, and each newly connected
account made every query in every project noisier and slower.

**Connecting stays global; only selection is per-project.** A grant is a fact
about the owner's identity — one consent, one access token, one refresh token,
one thing to rotate. Making the GRANT project-scoped would mean re-consenting to
the same Google account once per project and keeping N copies of one credential
alive. So the grant is untouched and `accountsFor` gained a filter.

**Enforced at the resolver seam.** `accountsFor` is the primitive every Core
reads through — `resolve` narrows it to the primary, `accountsResolverFor` wraps
it lazily — so filtering there means every consumer honours the selection and
none can drift. The connected-set construction moved to a private
`connectedAccountsFor`; `accountsFor` is now that call plus one `filter`, a
single return point with no branch to bypass.

**The subtle part: which project id the filter uses.** `SERVICE_SCOPE` forces the
GLOBAL sentinel for Email/Calendar when choosing which credential STORE supplies
the material. The filter deliberately does NOT reuse that forced value — it uses
the REAL active project id, because Email and Calendar are exactly the services
an owner connects several accounts to. Reusing the sentinel would have compiled,
passed a shape test, and made the whole feature a no-op for the only services
that need it. Mutation M2 below is that exact mistake, and it reds.

**Unset means enabled, by construction.** Storage is a DISABLE list
(`project_account_selection`, STRICT, PK `(owner_slug, project_id, service,
account_id)` which is also the read index). A project with no rows sees every
account — the pre-#500 behaviour, so shipping this changes nothing until the
owner narrows something — and a newly connected account has an `account_id` no
existing row can name, so it stays visible everywhere including in projects that
already narrowed. An enable-list needed a second "configured yet?" bit for the
first property and would have hidden the second until every project was
re-visited. A CHECK forbids the `''` project id, so the General/cron frame can
never inherit a narrowing. `owner_slug` is registered in
`migrations/scope-rekey.ts` — stranding these rows on a rename would silently
RE-ENABLE accounts a project had turned off.

**Surface.** `GET`/`PUT /api/app/projects/<id>/accounts` on the existing
`app-project-credentials` rung. PUT is idempotent both ways (enable DELETEs the
row, disable inserts one) and returns the whole refreshed view so the client
cannot drift from the server. It reads that view from the SAME resolver the
Cores resolve against, so the toggles shown are definitionally the accounts
swept. This is a project route while #486 moved GLOBAL credential authoring off
project surfaces — consistent, not in tension: #486 was about instance-wide
state, and an account selection can only ever mean something inside one project.
Disabling the last account for a service is allowed and the UI says "Off for
this project" so off never reads as broken. `account_id` is a SHA-256 prefix, so
the server sends a humanised label and the client renders that.

**Consumers that bypass the seam.** None in production. The three
`credentialResolver === undefined` fallbacks in `gateway/boot-cores-factories.ts`
(lines 138, 177, 234) call `googleOAuthAccessToken` → `OAuthTokenManager
.getServiceAccessToken` directly, but `gateway/cores/mount-open-cores.ts:417`
always supplies the resolver, so those branches are reachable only from
resolver-less tests. `gateway/cores/integrations.ts:273,481,493` and
`gateway/http/cores-oauth-surface.ts:714` also call `listGrants` directly — those
are the CONNECT/DISCONNECT management surfaces, which must stay global by
definition (you connect and revoke an account instance-wide), so they are
correctly outside the filter, not bypassing it.

**Tests + mutation results.** 29 targeted tests across three new files
(resolver/store behaviour, HTTP surface, web UI). Every expectation is a literal
— emails, ids and counts typed out rather than derived from the fake's own data.
Sixteen mutations, all red: M1 remove the filter (6 fail); M2 filter with the
global-forced project id (6); M3 `disabledAccountIds` always empty (9); M4 invert
to an enable-list (8); M5 swap the `setEnabled` branches (11); M6 view always
reports enabled (2); M7 `humaniseAccount` leaks the hex id (2); M8 drop
`owner_slug` from the store's WHERE (1); M9 surface PUT writes a constant project
(3); M10 surface accepts a non-boolean `enabled` (1); M11 UI sends the unflipped
value (2); M12 UI drops the all-off notice (1); M13 UI renders the raw
`account_id` (1); M14 store stops rejecting the `''` sentinel (1); M15 store
stops rejecting a blank `account_id` (2); M16 view drops services with no
accounts (1).

Two of those survived first and both were real findings, fixed rather than
excused. M14 survived because the SQL CHECK also refuses the row, so "something
threw" passed while the store's own guard was dead — but a raw SQLite constraint
error escapes the surface's error mapping as a 500 where the contract is a 400,
so the test now asserts the typed `AccountSelectionValidationError` and its code.
M16 survived because the fake OAuth manager answered `listGrants` for any service
name, so "every selectable service is listed regardless of what is connected" was
never actually exercised; the fake is now service-aware and the property is
pinned.

## 2026-08-04 — a finished Google connect returns the owner to his accounts (ISSUES #495)

Branch `fix/oauth-callback-redirect-495`. Changed:
`gateway/http/cores-oauth-broker-surface.ts`, `landing/chat-react/config.ts`,
`landing/chat-react/ProjectShell.tsx`, `docs/SYSTEM-OVERVIEW.md`. New:
`landing/chat-react/__tests__/oauth-return-tab-boot.test.tsx`. Also
`gateway/__tests__/cores-oauth-broker-surface.test.ts` and
`landing/chat-react/__tests__/config.test.ts`.

**The reported bug, and the second one underneath it.** Completing a Google
grant ended on a static page reading "Connected — you can close this tab and
return to Neutron", so getting back to the connected-accounts list meant closing
the tab and navigating there by hand. The owner reported it twice. The obvious
fix — redirect instead of rendering — could not be written as stated, because
there was no URL to redirect TO: the web shell's active tab was
`useState(CHAT_KEY)` and nothing anywhere in the client read a tab from the page
URL (`?tab=`, `#admin` and `/admin` were all inert). Sending him to `/chat` would
have landed him on Chat, one navigation short of where he asked to be. So the
deep-link is half the change.

**What shipped.** The broker's success path returns `303 See Other` to
`<instance-origin>/chat?tab=admin` — a real HTTP redirect, because the consumer
is a browser mid-redirect-chain from Google and redirect handling is the one
thing that can be relied on there. The origin comes from the pending row's
`dispatch_url`, which is the instance's own base URL (`ownerBaseUrl`, which
deliberately never follows the broker); no new config value, no hardcoded host,
and correct whether the broker is co-located or central. `?tab=admin` names the
global Admin descriptor, and carries no `?project=` on purpose — Admin is
global-scope and renders only in General, so pinning a project would open a tab
set without it.

**The grant cannot ride along.** The target is `new URL(dispatch_url).origin`
plus a module constant; `.origin` discards path, query and fragment, and neither
`code` nor `state` is in scope where it is built. The callback's OWN URL still
carries them, so the response also sets `referrer-policy: no-referrer` — without
it a same-origin (self-host) redirect would hand the full callback URL to the app
as a `Referer`. That closes a leak the module docblock had been claiming was
already closed.

**Failures deliberately do NOT redirect.** Every error arm keeps its terminal
page. A silent bounce back to Settings after a grant that did not complete looks
exactly like success; the reason stays on screen instead.

**Client side.** `initialTabKeyFromLocation` parses `?tab=<key>` (shape-validated
to a bare descriptor key, so a hostile link cannot smuggle markup or a URL), and
`ProjectShell` applies it once the scope's tab set has resolved. It has to be an
effect: the tab resolver runs on mount and unconditionally resets the active tab
to Chat, so a seeded `useState` value never renders. The apply is latched to the
first resolved scope, or the key would re-select itself on every later project
switch.

**Mutation results.** Fourteen mutations, all red — seven on the broker
(reverting the page, sourcing the origin from a constant, leaking `state` into
the query, dropping the referrer header, redirecting on failure, pointing at the
wrong tab key, renaming the engine's `admin` key), seven on the client. The
expected URLs are written out literally rather than composed from the shipped
constant, without which several of those mutations would have agreed with
themselves and stayed green. One mutation SURVIVED and changed the code: an
earlier draft screened the boot key against the tab set, and deleting that guard
stayed green because `resolvedActiveKey` already clamps an unknown key to Chat.
The guard was deleted as dead code rather than the mutation waved through.

## 2026-08-04 — a second Google account no longer overwrites the first (ISSUES #494)

Branch `fix/oauth-identity-scope-494`. Changed:
`gateway/http/cores-oauth-surface.ts`, `gateway/cores/oauth-token-manager.ts`,
`docs/SYSTEM-OVERVIEW.md`. New:
`gateway/__tests__/cores-oauth-identity-scope.test.ts`. Also
`gateway/cores/__tests__/google-multi-account.test.ts` (one added case).

**The bug was one missing scope, not a missing feature.** Per-account grant
labels (`<service>#<account_key>`) already existed and were already read through
by every path. The key is minted from the address `exchangeAndPersist` resolves
at Google's userinfo endpoint — but `runOAuthStart` built the authorize URL's
`scope` param as the union of the Cores' MANIFEST-declared scopes, and a sweep of
every declared scope in the tree yields only `calendar`, `gmail.*`, `drive`,
`documents`, `spreadsheets`. No `openid`, no `userinfo.email`. So userinfo could
never answer, every grant was anonymous, every grant for a service landed on the
bare `<service>` label, and the second account replaced the first. The whole
multi-account scheme was inert on a scope nobody had asked for.

**Which identity scope, and why that one.** Chosen from the endpoint actually
being called rather than from convention. `GOOGLE_USERINFO_URL` is
`.../oauth2/v3/userinfo`, the alias of the `userinfo_endpoint` in Google's OpenID
discovery document (`https://openidconnect.googleapis.com/v1/userinfo`) — the
OIDC UserInfo endpoint, which serves only tokens issued with `openid`. `openid`
alone returns just `sub`, so the `email` claim needs the email scope too
(Google's own OpenID Connect guide gives the request as
`scope=openid profile email`). Both are requested; `profile` is not — the address
is the entire requirement and name/picture would widen the consent screen for
data nothing reads. Seeded into the scope set in `runOAuthStart`, so it applies
to every grant this gateway starts, not only to newly-added Cores.

`prompt` became `select_account consent`. Without `select_account` a second
account is unreachable for an owner with one signed-in Google session: Google
resolves the consent against that session, so "add another account" silently
re-grants the one already connected — correct labels, still one account.

**The migration was decided, not defaulted.** `retireLegacyRowFor` already
retired a bare row on an EXACT address match and left a differently-addressed one
alone. It also returned early on a bare row with NO address, which is exactly the
#494 population — and leaving those is not neutral: `listGrants` adopts an
un-keyed row as an account, so after re-consent the install would carry the keyed
grant AND a phantom anonymous one, reading the same mailbox twice, forever. It
can never resolve itself either, because that row's access token was minted
without `openid`, so re-querying userinfo with it returns nothing and no future
exchange can ever match it. An anonymous bare row is now retired unconditionally
once a keyed grant has been written for the service. Safe by construction: a bare
label is one row per service, so it holds the LAST account to consent and no
other — any earlier account's tokens were already overwritten, which is the bug
itself. Identified bare rows keep the exact-match rule untouched.

**Both shapes read during the transition.** Nothing is rewritten at boot, so the
grant an install holds today keeps working until its owner re-consents.
Confirmed against the code, not assumed: `listGrants` adopts the un-keyed row
(and skips the Core-install echo, which has no `:refresh`/`:meta` companion);
`CoreCredentialResolver.accountsFor` maps it to `account_id: 'default'` with a
working accessor; `getServiceAccessToken`, `getStatus`, `handleStatus`,
`buildIntegrationsStatus` and install's `resolveServiceGrantLabel` all resolve
through it. A resolver-level case for the ANONYMOUS shape (the owner's actual
rows — the pre-existing case covered only an identified one) was added.

**The tests run the causal chain, not its shape**: real `/start` → the real
authorize URL → a fake Google that honours the scope it was asked for → real
`/ingest` → how many grants exist. Nine mutations were run and all nine red:
emptying the identity scopes, dropping either scope alone, not seeding the set,
dropping `select_account`, reverting the retire guard, making retire
unconditional, making the account key non-deterministic, and making a null email
fatal. **Three of those did not red on the first attempt** — the fake Google
computed its identity requirement from `GOOGLE_IDENTITY_SCOPES`, so emptying the
constant made `every()` vacuously true and the test agreed with the source by
construction. Google's rule is now spelled out literally in the fake.

**One pre-existing defect observed and NOT fixed here** (out of scope, no bearing
on the anonymous rows this migrates): on every ingest the Core install lifecycle
echoes the token it was handed back under the bare MANIFEST label
(`cores/runtime/lifecycle.ts` persistOrRotate), which for a legacy IDENTIFIED
un-keyed grant is that grant's own access row — so it transiently holds the
just-connected account's token until that token expires and the row's own
refresh_token takes over. Worth an ISSUES entry.
## 2026-08-04 — bounded transient recovery for the ritual background path (ISSUES #489)

Branch `fix/ritual-transient-recovery`. New: `reminders/ritual-retry.ts`,
`reminders/ritual-transient-recovery.test.ts`. Changed:
`reminders/ritual-executor.ts`, `reminders/tick.ts`, `reminders/ritual-runs.ts`,
`reminders/ritual-delivery.ts`, `agent-dispatch/service.ts`,
`agent-dispatch/substrate-turn.ts`, `open/composer.ts`,
`gateway/composition/build-core-modules.ts`,
`gateway/composition/input/notifier-input.ts`, `reminders/AGENTS.md`,
`docs/SYSTEM-OVERVIEW.md`, plus the existing ritual tests.

**The defect, reproduced first.** An interactive turn that meets a rate-limit
degrades visibly and the owner retries by hand. A ritual has nobody watching, and
the two ways one could fail had OPPOSITE bugs — which is why a fix for either
alone would have read like a fix for both.

A transient failure of the SETTLED TURN ran exactly once. Driving a fired
`morning-brief` whose turn returned an overloaded 529, then twenty more ticks:
`substrate turn attempts: 1`, one `failed` row, one failure notice, no brief, and
the recurring row already advanced to tomorrow. A transient failure during fire
STARTUP did the reverse. With the run store throwing `SQLITE_BUSY` on every
write, twenty-five ticks produced `startup attempts: 25`, `code_ritual_runs rows:
0`, `posts to the owner: 0` — the executor re-threw, the tick reverted the claim
to the row's original (already-due) `fire_at`, and it re-fired every 30 seconds
indefinitely with nothing written and nothing said.

**One policy behind both** (`reminders/ritual-retry.ts`). The decision is
three-valued, deliberately the same shape as `open/credential-usage-monitor.ts`'s
`CredentialStanding`: `transient` backs off and re-attempts, `permanent` fails
loudly and records why, `indeterminate` neither retries nor claims success. The
classification is read off the O3 taxonomy (`runtime/errors.ts` — a
`NeutronError`'s `code` and `retryable`), never from message prose, so an error
earns a retry only by carrying a class. The practical consequence is stated in
the module: widening recovery means stamping more producers, not loosening the
matcher.

`agent-dispatch/substrate-turn.ts` had been observing that class and dropping it
— `drainToOutcome` builds a `SubstrateCallError` with `code`/`retryable`/
`retry_after_ms` verbatim, and the runner returned only `{result, status}`. It
now carries it out on the additive, optional `DispatchTurnResult.failure`, which
is what lets the ritual executor tell an overloaded upstream from a missing
binary.

**Bounded, and re-armed forward.** `RITUAL_MAX_ATTEMPTS = 4` with a pure
exponential backoff of 2 min → 8 min → 32 min, so the last re-attempt lands ~42
minutes after the first failure and a 7 a.m. brief still arrives in the morning.
The backoff function reads no clock — it returns a delay and the caller adds it to
its own injected `now`, so nothing here can regrow a wall-clock timing assertion
(the ISSUES #438 gate). `fire()` no longer signals through rejection: it returns a
`RitualFireOutcome`, and `{claim:'retry', retry_at_ms}` is what makes the tick
re-arm at a LATER instant instead of the already-due one. That single change is
the difference between recovery and the loop.

**Exactly-once delivery, guarded twice.** A retry is refused outright if anything
has already been delivered for the occurrence: durably, by a `finished` row on the
occurrence (new `RitualRunStore.listByReminder`), and in-process by a latch marked
BEFORE the post leaves rather than after. A run store that cannot answer "already
delivered?" answers `true` — a missed retry costs one late ritual, a wrong retry
costs a duplicate morning brief, and only one of those is acceptable.

**Nothing ends in silence.** Success, retry-scheduled, retry-exhausted, permanent
failure and unclassified failure are each distinguishable from `code_ritual_runs`
alone via the `failure_reason` prefix — which matters because every marker in the
tick is error-level, so a clean run emits no log line at all. Retried attempts of
one occurrence collapse to one occurrence for the escalation rule
(`collapseAttemptsToOccurrences`), so a single busy morning cannot counterfeit
"failed 3 consecutive runs".

**Five mutations, each red on the intended test.** Removing the classification
reds 10 tests including both regressions; removing the idempotency guard reds
only the two exactly-once tests; removing the attempt cap reds only the runaway
test; making the tick re-arm at the ORIGINAL `fire_at` reds the three tests that
pin the backoff instant; and treating an unclassified failure as transient reds
the five that pin the middle value — including the startup regression, which is
the test that proves `indeterminate` is doing work rather than decorating a
boolean.

No feature flag, no dual path: recovery is the default behaviour.

## 2026-08-04 — a lint so wall-clock timing assertions cannot regrow (ISSUES #438)

Branch `test/wall-clock-bound-gate`. New: `scripts/ci/wall-clock-bound-check.mjs`,
`scripts/ci/wall-clock-bound-check.d.mts`, `scripts/ci/wall-clock-bound-check.test.ts`.
Changed: `scripts/ci/lint.sh` (CHECK 5), plus six test files triaged below.

**What changed.** The sweep two entries down removed the wall-clock timing
assertions that existed; this adds the gate that stops the class coming back. A
new assertion comparing REAL elapsed time against a threshold now fails
`scripts/ci/lint.sh` on the PR that introduces it, rather than being discovered
weeks later by a red shard on somebody else's branch.

**The matcher is AST-based, and keys on the EXPRESSION rather than the variable
name.** This is the whole design point. The ad-hoc grep that found the original
violations keyed on variables called `elapsed` / `took` / `duration` / `ms`, and
was wrong in both directions: it missed
`expect(Date.now() - start).toBeLessThan(2000)` entirely (same flake class, but
the delta is bound to no name at all), and it flagged a doc-comment that QUOTED a
removed bound plus a fake-timer harness call that was never a violation. The gate
recognises exactly one shape — **a real-wall-clock DELTA as the subject of an
`expect(...)` with a threshold matcher** — however that delta is spelled: inline,
bound to any name, or wrapped in `Math.abs` / arithmetic. It reads every clock
source (`Date.now`, `performance.now`, `Bun.nanoseconds`, `process.hrtime`,
`new Date().getTime()`), not just the two that happened to be in the tree.

Three exclusions are decided on principle rather than by allowlist, which is what
keeps the false-positive rate at zero without a hand-maintained file:

- **A comment is never an AST node**, so quoted bounds are structurally invisible.
- **Exact-equality matchers (`toBe`, `toEqual`) are out of scope.** A delta can
  only be asserted exactly equal to a constant under a LOGICAL clock — real wall
  time is never exactly N — so `expect(Date.now() - started).toBe(900)` under
  `installHarnessClock()` is correctly ignored, with no knowledge of the harness.
- **The delta must be an ASSERTION SUBJECT.** That separates the ~40
  `while (Date.now() - start < timeoutMs)` polling loops and `waitFor` helpers in
  the repo (a test WAITING for something) from a test asserting how fast the box
  is. A clock read minus a numeric CONSTANT is likewise a past timestamp, not a
  duration, so fixtures like `last_event_at: Date.now() - 10 * 60_000` are not hits.

**The gate ships GREEN, via a marker that requires an argument.** A bound with no
deterministic substitute carries `// WALL-CLOCK-BOUND-OK: <justification>` on the
assertion. At least 60 characters of prose after the colon is REQUIRED —
continuation `//` lines count — and a bare marker is rejected as its own failure
class, so an opt-out stays an argued exception rather than a silent one. Starting
green is deliberate: a standing-red gate trains people to merge past it, which is
precisely how a permanently-failing check in this repo once hid a second,
completely dead check for days.

**The sweep's own census was wrong, and this found six it missed.** The prior
commit reported "3 kept"; its message then described four, and the tree actually
carried five surviving `KEPT DELIBERATELY` bounds. Running the AST matcher over
`main` returned **11**. The six the name-keyed grep never saw are triaged here in
the same fixed order (delete if a deterministic assertion already covers the
contract, else convert, else keep with a written justification) — five of the six
are the inline `Date.now() - x` form, exactly the blind spot predicted:

- **Deleted** — `onboarding/wow-moment/__tests__/action-runner.test.ts` (a
  never-settling action already asserts `reason: 'timeout'` twice, and a broken
  timeout never settles at all, so it reds on the test timeout);
  `gateway/__tests__/composition-tasks-projection-wiring.test.ts` (labelled an
  mtime sanity guard but never read the mtime — it timed the whole test body,
  which the test's own comment says the coalescing guarantee is not about, and
  `waitForFileContaining` above already gates on the flush);
  `runtime/adapters/claude-code/persistent/__tests__/persistent-repl-substrate.test.ts:465`
  (the 60 s construction ceiling it guarded against is four times the 15 s
  per-test timeout, so a regression reds on the timeout first).
- **Converted** — `app/__tests__/harness-clock-selfcheck.test.ts`, from a
  `Math.abs(Date.now() - real_now) < 60_000` window to
  `expect(Date.now()).toBeGreaterThanOrEqual(real_now)`. Strictly stronger: a
  failed uninstall lands ~1.7e12 ms below the captured timestamp, and monotonicity
  cannot flake in either direction.
  `gateway/http/__tests__/voice-transcription-surface.test.ts` — its bound was
  VACUOUS, the same defect the sweep found in the profile-pic pipeline: the fake
  transport answered instantly, so a handler that DID await the download would
  have returned just as fast. `make()` now takes a `fetchImpl`, the test passes a
  fetch that never settles, and getting a 202 back at all is the proof.
- **Kept with a marker** — `doc-search/chunk.test.ts`, the ReDoS guard. Elapsed
  time is the only observable separating linear scanning from catastrophic
  backtracking: a regression returns the SAME chunks, just exponentially later,
  and the per-test timeout only catches a total hang rather than the quadratic
  rescan this guards against. Measured 0.25 ms unloaded and 0.33/0.38/0.44 ms
  (6.0 ms first-run outlier) under 2x CPU oversubscription, against 1000 ms.

**Survivors: six, each marked.** The five from the sweep
(`app/__tests__/transcript-warmer.test.ts`,
`onboarding/profile-pic/__tests__/storage.test.ts`,
`open/__tests__/onboarding-warm-conversational.test.ts`, and two in
`persistent-repl-substrate.test.ts`) keep their existing paragraph-long
justifications, now prefixed with the machine-readable marker, plus the ReDoS
bound above.

**The gate was mutation-tested, because a guard that cannot fail for the reason
it claims to test is worthless.** Injecting
`expect(Date.now() - mutT0).toBeLessThan(2_000)` — the inline form the old grep
missed — fails the gate with exit 1 and names the file:line. Re-marking that same
bound `// WALL-CLOCK-BOUND-OK: flaky` still fails, under the distinct
"unjustified" heading. Stripping the marker token from all six survivors makes all
six reappear as offenders, proving the markers are load-bearing rather than
decorative. 24 unit tests pin the detector, one per false positive and false
negative described above.

## 2026-08-04 — the Cores OAuth broker can live somewhere else, and its register cannot be stolen

Branch `feat/cores-broker-remote-config`. Changed:
`gateway/http/cores-oauth-broker-surface.ts`, `open/composer.ts`,
`docs/SYSTEM-OVERVIEW.md`. New: `open/cores-broker-binding.ts`,
`tests/integration/cores-oauth-remote-broker.open.test.ts`. Tests:
`gateway/__tests__/cores-oauth-broker-surface.test.ts`.

**Why — half of a two-deployment flow was unreachable.** The broker was written
to run either co-located (a self-host is its own broker) or centrally (one host
serves many instances), and `gateway/composition/input/cores-input.ts` says
outright that in the central deployment "its instances leave this unset". Nothing
let them. The composer derived the HMAC secret from this instance's own random
AES keyfile — a value no other host can know — pinned `identityBaseUrl`,
`ownerBaseUrl` and `redirectUri` all to one env, and mounted the local broker
surface unconditionally. A hosting layer had no way to point an instance at a
central broker.

**And `register` was a blind upsert.** `ON CONFLICT(state)` overwrote
`project_slug` alongside `dispatch_url`, so any holder of the shared HMAC secret
who learned somebody else's `state` could take the row over entirely and repoint
the callback at a host they control. PKCE kept the payoff small — the verifier
never leaves the originating instance, so a stolen code is unexchangeable — but
that is a reason the blast radius was small, not a reason to keep the primitive.

**What landed.** `open/cores-broker-binding.ts` resolves ONE binding (origin,
secret, and whether this process serves the broker) from two optional envs.
Declare neither and everything is exactly what it was: own origin everywhere,
keyfile-derived secret, broker mounted. Declare
`NEUTRON_CORES_OAUTH_BROKER_BASE_URL` + `NEUTRON_CORES_OAUTH_BROKER_SECRET` and
`identityBaseUrl` + `redirectUri` follow that origin, the secret is the supplied
deployment-wide one, and the local broker surface is not mounted — while
`ownerBaseUrl` stays this instance, because it is the `dispatch_url` the broker
relays back to and following the broker there makes the callback undeliverable.
Half a declaration is refused with a named env in the boot log rather than
silently downgraded. No flag, no second path: the downstream code reads the same
three fields whichever way they resolved.

Separately (its own commit), the conflict clause now updates only while the
stored `project_slug` matches the incoming one and drops `project_slug` from the
SET entirely; a mismatch is a no-op answering 409 `state_owner_mismatch`. Retry
idempotency, the reason the upsert exists, still works — an honest re-start always
mints a fresh random `state`, so a cross-owner collision never happens
legitimately, and a self-host with one owner can never trip the guard.

**Tests attack the properties, in both directions.** The takeover test reads the
row back out of the table, because a rejection that still wrote is not a
rejection. Mutation-verified: restoring the blind upsert reds the takeover test;
`DO NOTHING`, or refusing every conflict, reds the same-owner retry test; moving
`ownerBaseUrl` to the broker origin, always mounting the broker, keeping the
co-located secret, or treating a partial declaration as co-located each red the
seam test. Every seam assertion reads the value the real
`buildOpenGraphComposer` produced, never a hand-built config object.

Per SPEC § Decisions Log 2026-08-04.

## 2026-08-03 — a credential set inside one project no longer changes every project

Branch `fix/credential-scope-boundary`. Changed:
`gateway/http/project-credentials-surface.ts`,
`landing/chat-react/project-credentials-client.ts`,
`landing/chat-react/SettingsTab.tsx`, `landing/chat-react/IntegrationsTab.tsx`,
`landing/chat-react.html`, `app/lib/project-credentials-client.ts`,
`app/app/projects/[id]/settings.tsx`, `app/app/integrations.tsx`,
`open/__tests__/route-slot-coverage-inventory.ts`, `docs/SYSTEM-OVERVIEW.md`.
New: `gateway/http/__tests__/project-credentials-surface-scope.test.ts`. Tests:
`landing/chat-react/__tests__/project-credentials-client.test.ts`,
`landing/chat-react/__tests__/settings-tab.test.tsx`,
`landing/chat-react/__tests__/integrations-tab.test.tsx`,
`gateway/__tests__/project-credentials-production-composer.test.ts`,
`gateway/__tests__/open-route-matrix.test.ts`.

**Why.** A project's Settings tab carried a project/global scope toggle on its
add-credential form, and a delete on every inherited row. The server honoured
both, so a key typed while standing inside ONE project rewrote the default EVERY
other project inherits, and an ✕ next to an inherited row deleted it everywhere.
Two writers for one fact, from a screen whose whole frame says "this project".
The owner found it by clicking around: global settings living inside project
settings tabs.

**What landed.** The route is now the scope. The credentials surface grew a
project-less GLOBAL family (`/api/app/credentials[/<service>]`) alongside the
per-project one, mirroring how `codex-credential-surface.ts` already splits its
global and per-project routes, and both are served by the same
`app-project-credentials` rung. The project routes reject `scope: 'global'` (and
`?scope=global`) with HTTP 400 `scope_not_allowed` — a refusal, not a silent
downgrade, so a stale client shows an error instead of writing somewhere the
owner was not looking. Neither client has a `scope` argument left to pass: the
method you call decides.

The capability MOVED rather than disappearing. Authoring the instance-wide
defaults now lives on the surface that is actually global — a "Shared
credentials" section in the web Admin tab and on the mobile Integrations screen,
with the same add / list / remove it had before. Project Settings keeps SHOWING
the inherited defaults, because knowing the key exists is what makes a project's
settings legible; each one is labelled with where it is changed.

**Verified.** The server tests read the store back after a REFUSED request, so a
400 that still wrote would fail them. Mutation-tested: restoring the old
scope-honouring handler turns 5 of them red. The client tests assert the
captured request (method + URL + body), not which controls are on screen — a tab
with no toggle that still posted `scope: 'global'` would pass a
control-presence check and fails these.

## 2026-08-03 — the web Admin tab could show a Google account but not connect one

Branch `feat/web-admin-oauth-connect`. Changed: `landing/chat-react/IntegrationsTab.tsx`,
`landing/chat-react/integrations-client.ts`, `landing/chat-react.html`,
`gateway/http/cores-oauth-surface.ts`, `docs/SYSTEM-OVERVIEW.md`. New:
`landing/chat-react/integrations-oauth-view.ts`,
`landing/chat-react/__tests__/integrations-oauth-view.test.ts`. Tests:
`landing/chat-react/__tests__/integrations-tab.test.tsx`,
`landing/chat-react/__tests__/integrations-tab-unmount.test.tsx`,
`landing/chat-react/__tests__/integrations-client.test.ts`,
`gateway/__tests__/cores-oauth-surface.test.ts`.

**Why.** The Admin tab's "Connected accounts" section was a viewer. It mapped
each account to a label, a status line, its scopes and a Connected / Not
connected badge, and stopped there — no action control anywhere in the section.
The only Connect button on the whole tab was Connect Codex. So the owner sat in
front of rows reading "Not connected" with nothing to click, and could not
connect Google from the web at all. The mobile client had had the full flow
since WAVE 2; the web client got the read half of it.

**What landed.** `IntegrationsClient` gains `oauthStart` / `oauthDisconnect`,
mirroring the RN `CoresClient`, and the tab drives them. Connect is a two-step on
purpose: `/start` is bearer-gated, so the tab does the authenticated fetch and
then navigates to the `authorize_url` that comes back — the public
`accounts.google.com` consent page. A link straight to `/start` would 401, which
is why the control is a button over the client seam and not an anchor. The
navigation goes through an injected seam so a test can watch the hand-off
actually happen; asserting the button renders would pass against a button wired
to nothing, and that is the failure mode this repo keeps producing.

Rows are now grouped by SERVICE rather than listed flat, because a service holds
more than one account. The server returns one row per connected account under a
composite `<service>#<account_key>` label, so each account gets its own
Disconnect addressed by its full label, and a service that already has accounts
keeps an "Add another account" action — without it the second and third Google
account are unreachable, and the owner runs three. Connect always sends the bare
service label; the composite one is not manifest-declared and `/start` rejects
it. The account key is a hex digest, so the displayed title is the humanised
service and the account is named on the status line instead, matching what the
mobile client already did.

**The disconnect route was unreachable.** Widening the web client alone would not
have worked: per-account disconnect could not be performed by ANY HTTP client.
The route matched a literal `#` in the path, and `#` cannot survive the wire —
in a URL it opens the fragment, and a fragment is never sent to the server. Every
client percent-encodes the label, so the path arrived holding `%23`, missed the
character class, and fell through to a 404. The route now accepts the encoded
form and decodes it, re-checking the decoded value against the character class it
always enforced so nothing new gets in. Mobile was hitting the same 404 and is
fixed by the same change.

## 2026-08-01 — the rest of the tasks block was never switched on

Branch `fix/wire-tasks-crons-shared-store`. Changed: `open/composer.ts`,
`gateway/cores/mount-open-cores.ts`, `gateway/composition/build-core-modules.ts`,
`gateway/composition/input/tasks-input.ts`, `tasks/reminder-link.ts`,
`reminders/store.ts`, `docs/INVARIANTS.md`, `docs/SYSTEM-OVERVIEW.md`. New:
`open/__tests__/open-tasks-wiring.test.ts`. Tests:
`tasks/__tests__/reminder-link.test.ts`.

**Why.** #439 fixed one instance of a shape; the same config block held five
more. `composition.tasks` declares six capabilities and gates each on a `=== true`
flag, and the only production composer set exactly one of them. So the
focus-score convergence cron, the LLM backlog ranking cron, the task-to-reminder
link, the STATUS.md / ACTIONS.md projection and the canonical-store seam were all
declared, all tested, and all dead — while the input's own doc comment read
"production wires all three." Nothing caught it because every wiring test
hand-builds the config literal the composer should have produced and then asserts
the gate works: that proves the consumer, never the producer.

**What landed.** `open/composer.ts` now sets the whole block. Two of the five were
unambiguous — refreshing time-derived focus scores and ranking a backlog both
degrade safely with no credential and post nothing to the owner. Two were
judgement calls and were investigated before being switched on rather than
deleted: the projection turned out to have live readers (the bundled kaizen
ritual globs `Projects/*/ACTIONS.md` for stalled work, and doc-search indexes both
files into the agent's `doc_read`), and the reminder link turned out to be a
coherent create/reschedule/cancel layer sitting on a store-identity fracture.

The fracture is the fifth. Open built THREE `TaskStore`s over one db — the
composition fallback, the app HTTP surface's, and the Tasks Core adapter's — and
a `TaskStore` is where the mutation-subscriber list lives, so a write through any
of them landed the row and fired nothing. One store now, threaded into all three.

The reminder link needed two behaviour fixes before it was safe as a default:
re-opening a completed task got its reminder back (it changed neither status-
to-terminal nor the due date, so it fell through every branch and left the task
open with a live due date and nothing scheduled), and a due date already in the
past no longer schedules at all — the onboarding history-import seeder bulk-creates
tasks from LLM-proposed dates and each past-dated one was due on write. Renaming a
task now rewrites its pending reminder body too (`ReminderStore.retitle`), because
the reminder message IS the task title.

Two smaller truths corrected while in there: the projection writer's default log
sink is a no-op, so a failed write was invisible — the composition now supplies
one, and it immediately surfaced a real teardown-race write failure in an existing
test. And invariant #23 claimed the link write shares the task mutation's
transaction; it never did.

**The test that would have caught it.** `open/__tests__/open-tasks-wiring.test.ts`
runs the real composer and reads its real output. The two store-identity tests go
further than reading a field: they subscribe to `composition.tasks.store`, then
drive a write through the app HTTP handler and through the Tasks Core adapter and
demand the subscriber fired — an assertion that the row reached the table cannot
tell one store from three. Every assertion was mutation-verified by deleting the
wiring it covers and watching it red.

## 2026-08-01 — the reachability gate reaches the phone

Branch `test/reachability-mobile`. New: `app/__tests__/reachability-inventory.ts`,
`app/__tests__/reachability.test.tsx`,
`app/__tests__/reachability-inventory-complete.test.ts`. Changed:
`app/__tests__/support/stubs/expo-document-picker.ts` (now counts its calls).
Doc: `docs/SYSTEM-OVERVIEW.md`. **Test-side only — no production code changed.**

**Why.** The gate merged the day before (#52) reported its own scorecard
honestly: it caught two of the five features that shipped unreachable in one day,
and named mobile as the largest remaining gap. The most expensive of the five was
mobile — `ChatSyncSurface` rendered `<InputComposer>` without its four `onVoice*`
props, so the mic rendered perfectly, took every press, and answered "Voice
messages are not available yet." Five green unit files agreed everything was
fine, because a unit test asserts a PART works and none of them asserted the
product still reached it.

**What landed.** Mobile's half of the inventory: eleven things the owner must be
able to do, probed against the REAL project shell (`app/projects/[id]/_layout.tsx`
over the routing harness, with the real header, rail, tab bar, usage client and
the real `ChatSyncSurface` inside `<Slot/>`) on both shipped platforms. Every
probe PRESSES and then demands an effect a missing handler cannot fake — a
microphone that opened, a frame on the socket, an OS picker that ran, a route that
changed, a measured meter — because a presence probe passes on the broken build.
Plus a completeness gate that reads the composer's own optional callbacks out of
the source and reds when one is neither probed nor excluded in writing.

**A verified correction to #52's stated obstacle.** It reported the harness
"fixed at one screen size — `HARNESS_SCREEN_WIDTH` 393 — so the mobile
wide/tablet branch remains untestable". That constant only feeds
`getBoundingClientRect`; `useWindowDimensions()` comes from
`documentElement.clientWidth`, which happy-dom reports as **0**, and widening it
was already solved by `withWideViewport()` in `usage-meter.test.tsx`. The deeper
finding is that width is the wrong axis for mobile at all: all seven width
branches in the app are `Platform.OS === 'web'`-gated and web is not a shipped
platform, so the phone renders ONE layout. Parity therefore runs across
ios/android, and the completeness gate re-derives that claim from source each run
so it reds the day a real tablet layout appears.

**Mutation-tested.** Deleting `{...voiceHandlers}` — the literal shipped omission
— reds both platforms with the owner's sentence; dropping one of the five voice
callbacks reds hold-to-talk alone; dropping `pickAttachments` reds attach;
dropping `usage=` reds the meter; an unprobed new optional callback, an
un-web-gated width branch and a renamed props interface each red the completeness
gate.

**Deliberately not covered**, in `docs/SYSTEM-OVERVIEW.md` § Reachability gate
alongside #52's list: playback behaviour and anything about audio actually
sounding (behaviour, not reachability), the mobile surfaces outside the shell and
chat, and a real device.

## 2026-08-01 — kaizen: the weekly pass that notices you have corrected this four times

Branch `feat/kaizen-ritual`. New: `reminders/rituals/kaizen.md`. Removed:
`reminders/rituals/daily-delta.md`. Changed: `reminders/bundled-rituals.ts`,
`open/composer.ts` (comment), `reminders/AGENTS.md`,
`cores/free/reminders/{package.json,src/mcp-tools-extra.ts,src/backend.ts}` (tool
copy), tests in `reminders/`. Doc: `docs/SYSTEM-OVERVIEW.md`.

**Why.** Nothing in this system was responsible for noticing a pattern ACROSS
time. The corrections log has recorded every correction since it shipped, the
reflect pass promotes individual ones, and nothing ever stood back and said: this
same lesson has landed four times, so the defect is in the system and not in the
instance. That judgement is the entire ritual, ported from the owner's legacy
harness.

**What landed.** `kaizen`, the third bundled ritual, replacing `daily-delta`.
Weekly, it reads `corrections/corrections-log.md`, `diary/*.md`,
`persona/SOUL.md`, `Projects/*/ACTIONS.md` + `STATUS.md`, the sibling
`rituals/*.md`, a grepped `logs/server.log` and
`diagnostics/client-reports.jsonl`; groups corrections by LESSON rather than
wording; labels anything seen 3+ times SYSTEMIC and refuses an instance-level fix
for it; and ends with three changes each naming the file that would change.

**What did NOT port, stated rather than silently dropped.** The legacy ritual
auto-filed its top three into an issues list. `GATED_WRITE_TOOLS` refuses
Write/Edit at fire time, and Open has no owner-side issues file by policy, so
kaizen PROPOSES and the owner acts. Its cron-health section had gateway log files
to read; here the ritual log (`code_ritual_runs`) and the chat history are
SQLite-only, so kaizen can see which rituals EXIST but not whether they ran, and
reasons from the corrections log, the server log and the client reports instead.

**Egress.** kaizen is the first shipped def to declare `egress: 'web'` — the
ecosystem scan is half of what it is for. The separate `ritual-egress:<id>` grant
path existed and had never been exercised by anything a fresh install ships; a
new test drives it end to end and proves approving the CONTENT leaves the ritual
unscheduled until egress is approved on its own. Read-broadly plus network-reach
in one agent is an exfiltration shape, so the template forbids putting anything
read on disk into a query and forbids opening `.env` / `.secrets` / `*.db`.
`WebFetch` is deliberately not granted.

**It reaches him.** `silent: false`, so the report posts through
`ReminderOutbound` → `deliver(durability:'reply')` as a durable history row.
Skill Forge spent months persisting proposals into a `log.info` and telling nobody
(#51); the unit test therefore asserts the POST, not the flag. Mutation-verified
three ways: flipping `silent` to true fails it, dropping `WebSearch` from the
surface fails it, and deleting the template while keeping the def fails it.

**daily-delta removed cleanly.** Template, def, wiring, Core tool copy and tests
went together, and a test pins the absence so a def can never outlive its
template. The owner dropped it because its job was proving the system worked,
which the reachability gates now do directly.

## 2026-08-01 — the reachability gate: coverage that asks whether the owner can still DO it

Branch `feat/reachability-gate`. New:
`landing/chat-react/__tests__/reachability-inventory.ts` + `reachability.test.tsx`,
`open/__tests__/reachability-inventory.ts` + `reachability.test.ts` +
`reachability-inventory-complete.test.ts`. Doc:
`docs/SYSTEM-OVERVIEW.md` § Reachability gate. No production code changed.

**Why.** Four regressions reached the owner through green CI in a day, and they
were one bug wearing four hats: **a part worked and the product could not reach
it.** Voice recording, mounted by a host screen that never passed its props. A
usage meter absent from the wide layout, in an app where no test had ever rendered
a wide layout. `/code`, written and unit-tested and never added to the composer's
filter chain, so every `/code` went to the model. Unit tests assert that a part
works; nothing asserted that the product still reaches it, and no amount of the
former produces the latter.

**What landed.** An inventory of what the owner must be able to do, as data, with
the owner-facing sentence to print when each stops being true — and three gates
that prove it against the real thing rather than against a mounted part:

- the REAL app shell (`ProjectShell` with the real controller, session, tab
  resolver, usage client; fake socket, injected fetch, no model) mounted at BOTH
  shipped layouts, probing eight affordances;
- the REAL Open composition over a live `Bun.serve` and the unified
  `/ws/app/chat` socket, TYPING `/status`, `/reset` and `/code` and requiring the
  composed chain to claim each one without the model seeing it;
- a completeness gate that reads the product's real command factories out of
  `gateway/boot-chat-command-filters.ts` and fails when one is neither probed nor
  excluded in writing, with a reason.

**The two ideas doing the work.** *Layout parity*: an affordance reachable at one
width and missing at another fails unless the inventory records why — which is the
general form of the usage-meter bug rather than a test for that one instance.
*Self-extension*: a new `/`-command reds the gate on the PR that adds it, so the
inventory cannot quietly stop describing the product. Failure text is the owner's
sentence ("You cannot attach a file — the attach control is missing from the
composer"), asserted as the value so it lands in any runner's diff, and a healthy
run prints nothing.

**Where it runs.** The ordinary CI shards — no workflow change, no schedule, no
notifier. All four incidents were introduced by a merge, so the moment that
matters is before the merge. Nothing in it touches the network, a model or a
clock, which is the property that lets a red be believed.

**Mutation-tested, all four:** reintroducing the wide-branch `usage` omission reds
the wide layout and the parity check; renaming the attach control reds both
layouts; dropping `statusChatCommandFilter` / `tridentCodeChatCommandFilter` from
the chain names `/status` and `/code` as lost; an unaccounted-for filter factory
reds the completeness gate.

**Not covered, stated plainly** (full list in SYSTEM-OVERVIEW): the mobile app —
so the voice-props incident would still have got through, and the device harness
that could catch it is pinned to one screen width (`HARNESS_SCREEN_WIDTH` 393), so
the mobile wide branch stays untestable; playback behaviour, so the looping voice
note is out of reach; CSS, since happy-dom renders a tree and not a layout;
`/remind` and `/cal`, excluded with written reasons because they claim
conditionally and a red would be ambiguous; and anything post-deploy, since this
is a pre-merge gate and not a monitor.

**Found while building it.** `tests/e2e-browser/onboarding_walkthrough.py`, the
only real-browser check in the repo, is orphaned in two independent ways: it is a
`.py` file and `scripts/lib/discover-test-files.sh` globs `.test.*`/`.spec.*`
only, and nothing in `.github/workflows/` references it. It also prints `E2E SKIP`
and exits 0 whenever no server answers, so it can prove nothing indefinitely and
look fine doing it.

## 2026-07-30 — the idle nudge is switched ON, against a test that proves it does not repeat

Branch `fix/idle-nudge-user-activity-watermark`. `channels/button-store.ts`,
`gateway/proactive/idle-topic-enumeration.ts` (new), `open/composer.ts`,
`gateway/proactive/__tests__/idle-nudge-no-repeat.test.ts` (new).

**The feature was finished and deliberately withheld.** `open/composer.ts` did not
supply `listIdleTopics`, so `build-core-modules.ts:1086` never registered the sweep
cron, and `open/__tests__/open-proactive-activation.test.ts` asserted that absence
to pin the withholding on purpose. The reason was sound: switching it on would have
nudged the owner about the same thing every hour, indefinitely. So this change is
not "wire up a feature" — it is removing the two reasons it had to stay off.

**Defect 1 — the watermark polluted itself.** The nudge posts through
`buildButtonStoreProactiveSink`, which persists a durable row into `button_prompts`
via `persistInertAgentTurn`. The activity watermark was `MAX(created_at)` over that
same table with no speaker filter. `evaluateNudgeGate` only skips while activity has
NOT advanced past the watermark stored at the last nudge — so the nudge's own row
advanced it, the sweep read its own bubble as "the user came back", and dedupe was
defeated on the first cycle after every post.

The table records the speaker (`resolution_speaker_user_id`), and everything the
system authors stamps a `__system__` sentinel — `persistInertAgentTurn` and
`sweepExpired`'s synthesized `__timeout__`. So `listTopicsByUser` now returns TWO
watermarks rather than redefining the one it had:

- `last_created_at` — unchanged, every row, agent posts included. This is the
  SIDEBAR's ordering key, and an agent bubble is a message; narrowing it would have
  traded a nudge bug for a rail-ordering bug.
- `last_user_activity_at` — the `resolved_at` of turns a real person took. System
  rows contribute nothing, and neither do unresolved agent prompts (an unanswered
  question is not the owner showing up).

**Defect 2 — enumeration saw one namespace.** The owner speaks under both
`web:<owner>` (React web) and `app:<owner>` (Expo app-ws), and they are independent:
a conversation handled on the phone leaves no trace under `web:`. `listTopicsByUser`
took exactly one root, so the sweep would have nudged about work just dealt with on
the other device. It now accepts a string OR an array of roots, unioned in one
grouped scan, with `project_id` attributed by longest-matching root.

**The enumerator emits ONE candidate, not a fan-out.** `buildOwnerIdleTopicEnumerator`
returns a single candidate — the owner's General app-ws topic, the same target as the
morning brief — because the P6 ranker writes one `current_focus_pick` per instance per
day. A candidate per project topic would post the identical pick into every topic. Its
`last_activity_ms` is the max `last_user_activity_at` across both roots and all their
project descendants. Enumeration failure yields zero candidates, never a dead cron.

**The bar, and how it was met.** `idle-nudge-no-repeat.test.ts` (10/0) runs the REAL
sweep against a real database with the real sink shape — the nudge's post genuinely
lands in `button_prompts`, because a stub sink would hide the exact bug this file
exists to disprove. Four idle cycles after a nudge with no intervening user activity
produce exactly ONE post. Both mutations were applied and confirmed to fail it:
reverting `last_user_activity_at` to an unfiltered `MAX(created_at)` breaks 3 tests
including the headline one; collapsing enumeration to a single root breaks 4. The
inverse direction is pinned too — a real user turn re-arms the nudge and a second one
fires — so the fix cannot be a silence bug wearing a spam bug's clothes. The ≥7
`rateNudge` floor was already supplied by the composer and is confirmed to take effect
now that enumeration reaches it (6/10 stays silent, 7/7 posts, an abstain skips).

`open-proactive-activation.test.ts` no longer asserts the feature is off; it asserts
the wiring, and that the enumerator yields the single expected candidate.

**Deploy note:** this is gateway/composer code. It needs a SERVER-SIDE deploy to take
effect — there is no over-the-air path for it.

## 2026-07-31 — an authenticated caller outside the process can put a message in the owner's chat

Branch `feat/system-notice-route`. `POST /api/app/system-notice`
(`gateway/http/system-notice-surface.ts`, `appSystemNotice` slot in
`route-slots.ts`, wired in `open/composer.ts`).

**The gap was a missing seam, not a missing mechanism.** `gateway/http/deliver.ts`
already calls itself "the ONE out-of-turn delivery seam" and already does the hard
part — durable row first, best-effort live push routed by topic grammar. What it
had was three callers, all of them inside this process:
`substrate-notice-sink.ts:134`, `recovered-reply-store.ts:236`, and the
reminder/brief/ritual wiring in `open/composer.ts`. Nothing exposed it over HTTP,
so anything running outside the gateway could act on the owner's box but could not
tell him it had. This route is that one missing entry point; it authenticates,
validates, and calls `deliver`. No second delivery path was built.

**`durability: 'inert'`, and the choice is the substance of the feature.** The
transient `'none'` pill the substrate sink uses writes no row, so it exists only
for whoever is connected at that instant. An out-of-band announcement is by
definition the case where the owner is elsewhere — that is why something else had
to speak — so a live-only bubble would be gone by the moment it was needed.
`'inert'` persists an already-resolved agent history turn (speaker `__system__`),
which is in the transcript when he next opens the app and never becomes the active
prompt his next message attaches to.

**It is the system talking, not the owner.** Routing this through
`POST /api/app/chat/send` was rejected: that path persists a `role: 'user'` turn
and dispatches an agent turn from it, which would both fabricate words the owner
never said and spend a model turn to relay a sentence that needs no reasoning.

**Auth reuses the instance-scoped bearer and adds nothing.** The same
`AppWsAuthResolver` the rest of `/api/app/*` gates on. In production `jwks` mode
that is RS256 against the identity service's published keys, unexpired, non-empty
`sub`, and a `slug` claim constant-time-equal to this instance's — an
account-scoped bearer with no `slug` is refused outright, which is what stops a
token minted for one install from posting into another. No shared secret and no
new token type were introduced. The tests run that real mode against a generated
key pair and assert both halves of every rejection: 401 AND `deliver` never
touched, because a 401 returned after the message was already posted is still a
hole. Mutation-tested — deleting the `resolveBearer` branch turns six of the
fifteen red.

**Deliberately contentless.** The caller supplies the finished sentence. There is
no `reason` enum and no event taxonomy: the route knows how to post a notice and
nothing about what any particular deployment might want to announce. The topic is
fixed at composition to the owner's bare `app:<owner>` topic, so a caller chooses
words and nothing else.

**Not verified:** no live end-to-end call against a running instance with a real
identity-service bearer; the route is proven by the surface tests plus the
composition characterization test that pins `app_system_notice_surface` into the
real `composeOpen` output (the done-means-served proof that it is mounted, not
merely written).

## 2026-07-31 — the tab-bar divider is now the usage meter

Branch `feat/usage-meter`. Ryan: *"two very thin lines … the line that separates the
tab bar from the chat window … starting green until we hit 85%, then yellow until
we hit 95%, then red until we max out. The whole line changes color, not just the
piece at the end. Line for session usage above line for weekly usage."*

**This was a surfacing job, not an instrumentation one.** Anthropic already reports
both ceilings on the response headers of any authenticated call
(`anthropic-ratelimit-unified-5h-utilization` / `…-7d-utilization`). What Open
lacked was any way to ASK: every turn goes through the spawned `claude` binary,
which surfaces no response headers, so the figures are unobservable from normal
traffic. `auth/credential-usage-probe.ts` asks with a one-token
`POST /v1/messages` whose body is never read — the same auth-tier probe class as
`auth/max-oauth.ts`'s token check, carrying no owner content, no `system` field
and no signature.

**One credential, and the right one.** `open/active-credential.ts` walks the same
precedence `resolveOpenLlmPool` uses but resolves one tier further than dispatch
needs: the ambient tier carries an empty secret by contract, which is correct for
spawning `claude` and useless for measuring, so the token is read from
`<CLAUDE_CONFIG_DIR|~>/.claude/.credentials.json`. That is the file the `claude`
CLI re-reads per turn, so reading it is the literal definition of "the credential
we are actively using" — and it is why the meter is correct on a hosted instance
that swaps that file underneath, with no hosting-side code and no multi-account
concept anywhere in this repo. `ANTHROPIC_API_KEY` is billed per token and has no
window, so it reports unsupported rather than an empty bar.

**Unknown is a first-class state, and it looks like nothing.**
`open/credential-usage-monitor.ts` measures every 60 s on a `SupervisedLoop` and
caches; `GET /api/app/usage` answers from memory and always 200s, with
`{available:false, reason}` when there is nothing to report. A reading older than
five minutes stops being quoted — a utilization figure describes a rolling window,
so a stale one is wrong rather than merely old — while a single failed probe keeps
the last good one. Both clients decode defensively and never coerce a missing
number to zero: an empty coloured track would assert "0% used", which is a claim,
and the point of the unavailable state is that there is none to make.

**Both surfaces, and it IS the divider.** Web: `landing/chat-react/UsageMeter.tsx`
sits between `.car-topbar` and `.car-stage`; the topbar dropped its own
`border-bottom` and the active tab dropped its -1px overhang, because a notch in a
fill bar reads as a wrong number rather than as a fused tab. Mobile:
`app/components/UsageMeter.tsx` is the last child of `ProjectTabBar`'s
`narrowBand`, which likewise dropped its `borderBottomWidth`. Thresholds and the
band function live in `contracts/credential-usage.ts` and are imported by the
gateway, the browser bundle and the app, so the three cannot disagree about where
amber starts. No feature flag; the meter is the default and only path.

**Tests.** `auth/__tests__/credential-usage-probe.test.ts` (11/0) pins the header
read and the classifications that would otherwise be invisible: a 200 without
windows is `no-windows`, never a zero, and a 429 without windows is FULL rather
than empty — the moment the bar is supposed to be red.
`open/__tests__/credential-usage-monitor.test.ts` (14/0) covers every way the meter
could lie: no network call without a credential, a reading kept through a blip,
dropped once stale, dropped outright on a dead credential, and the token
re-resolved each tick. `gateway/__tests__/app-usage-surface.test.ts` (5/0) pins
"nothing to report" as a 200. `landing/chat-react/__tests__/usage-meter.test.tsx`
(6/0) and `app/__tests__/usage-meter.test.tsx` (10/0) assert on both trees that an
unavailable reading renders NO fill node and no `progressbar` role, and that the
whole fill recolours as one unit at each threshold.
`open/__tests__/open-composition-fields-characterization.test.ts` boots the real
Open composer and now requires `app_usage_surface` in its output — the
done-means-served proof that the route is actually mounted.

Two existing guards were extended deliberately rather than relaxed: the loop
inventories (`open/__tests__/loop-inventory-{open-composer,boot-shell}.test.ts`)
now name `credential-usage` in the complete running set — the loop arms
UNCONDITIONALLY, because an uncredentialed box does a cheap env/file check and no
network call, so a credential added later starts reporting without a restart —
and the create-project fetch shim in `landing/chat-react/__tests__/component.test.tsx`
exempts the shell's usage poll the same way it already exempts `/tabs` and
`/work-board`, since that assertion counts the create POST, not shell chrome.

**What was checked on a real screen, and what was not.** The one thing source
review cannot answer is whether two 1px rules are legible at phone density, so the
SHIPPED CSS (extracted from `chat-react.html`, not retyped) was rendered on a cloud
Android 14 device at 422 dpi across seven states. It reads correctly: each line is
wholly ONE colour along its filled length, session sits above weekly, the fill
grows from the left, the amber and red bands are unmistakable against the dark
stage, the `min-width` floor keeps a 0.2% reading visible as a sliver, and the
unavailable state is indistinguishable from ordinary window chrome — which is the
whole point of it. NOT verified on device: the React Native component itself
(reaching it needs a native build, which is a local Gradle run and is off-limits),
and the live probe against a real subscription. Those rest on the harness tests.

## 2026-07-31 — the mobile rail shows nothing when nothing is happening

Branch `fix/rail-idle-dot-invisible`. WAVE 3.5 made the rail's corner dot the Activity Inspector's entry point, and to guarantee it stayed reachable it gave the idle state a visible resting form: a quiet hollow ring. That reasoning was sound and its rendering was not. On a 72px rail with every project stacked in a column it put a grey circle on every single row, permanently. The owner, on device: *"remove that ugly grey hollow circle on every project in the rail. the pulsing dot should only show up if there's activity, otherwise nothing shows. that area can still be tappable for the inspector even if nothing visible. its an 'advanced' feature."*

**Only the paint was removed.** `ActivityDot` (`app/components/ProjectRail.tsx:117`) renders a transparent, DOT-sized `dotSlot` for `idle` instead of the ring. `railDotKind` is untouched and still returns `idle`, the active row still wraps the corner in its `dotPress` Pressable with the same `hitSlop`, and the slot holds the box open — so the inspector's touch target has exactly the geometry it had, and a row does not shift the moment a dot lights up. Invisible but tappable is the intent, not an oversight: an advanced affordance the owner asked to be undiscoverable.

The obvious implementation — return `null` for idle — would have done the visible half correctly and silently unshipped the feature, because the target is sized from the box the dot occupies and nobody would notice an invisible control had stopped working. That is what the new tests are for.

**Web/mobile divergence — CLOSED (2026-08-04).** This entry originally recorded the web rail keeping `.car-rail-dot-idle`, on the reasoning that the complaint was specific to the narrow phone rail. The owner then raised the identical complaint about the web rail, so web now paints nothing at rest too (`car-rail-dot-none`) and the two surfaces are one rule. See the 2026-08-04 entry below.

**Tests.** `app/__tests__/rail-idle-dot-not-painted.test.tsx` (new, 6 tests) pins all three halves: nothing is painted (asserted on computed fill and border width, not just on the absence of a testID, so "make it very subtle instead" fails too); the corner box matches a painted dot's geometry exactly; and pressing the active row's invisible corner still opens the inspector without also switching project. The geometry assertion was mutation-tested — collapsing `dotSlot` to 0×0 reds it. `rail-dot-misclick.test.tsx` is unchanged in behaviour; its "inert, not removed" case is annotated to say it is about a dot that has something to report.

**Verified, and not.** Typecheck and ESLint clean on the app package; the three rail test files green (22 tests). The PRE-change rail was reproduced on an emulator — a ring in the corner of every row. The AFTER state was **not** confirmed visually: the emulator was stopped part-way through (it was bogging down the owner's laptop), so what backs this is the harness and the component, not a screenshot of the result. Worth a glance on device. JS-only — no native module, no manifest change, so it ships over-the-air ahead of the next binary. No feature flags.

## 2026-07-31 — a rail tap is a tap, not a load

Branch `perf/instant-project-switch`. Switching projects had been CORRECT since the previous entry; it had not been instant. Ryan: *"I don't want to see like three screen repaints and a loading indicator appearing for a second and disappearing. I just want tap and instant switch."*

**What was measured first.** The release APK on `emulator-5554`, filmed with `screenrecord` at 30 fps and diffed frame by frame across eight rail taps (a script per run: press-and-hold 300 ms so the release moment is visible, then classify every change point by screen region). Every switch produced four to six distinct repaints. In order, on one tap: the screen did nothing for 70–130 ms; the content pane went blank; the tab bar showed the pre-fetch default (Chat / Apps / Tasks / Reminders / Docs) for 3–4 frames and then flipped to the real set; a "Connecting…" strip and a hydrating spinner; **"No messages yet. Say hello 👋"** over a project with a full transcript; and finally the transcript, ~800 ms after the finger left the glass.

**Three of those were the shell asking the wire for answers it was already holding.** `GET /api/app/projects` — the rail's own call — returns `ProjectListEntry extends ProjectSettings` for every solo project, out of the same `projects` table and `project_members` join the per-project settings GET reads. The tab set for every rail project is resolvable before any tap. The last-tab preference is a per-device value only this process writes. So:

- **`app/lib/project-settings-cache.ts` (new)** — `ProjectsClient` files every settings doc it receives (read, privacy, rename, emoji; one choke point, no writer to forget) and `fetchProjects` files every **solo** list row. `ProjectStateProvider` starts an unresolved scope from that doc, keeping `loading` true so the authoritative fetch still runs and still replaces it. **Solo only**: a `shared` row's settings fields are gateway-filled defaults, and caching one would be the fabrication ISSUES #393 banned. A scope nothing has been told about still gets the loading pane — the cache removes a wait, it never invents a scope, and an error is never papered over.
- **Per-scope tab sets** — `_layout.tsx` held one `fetchedTabs` that a switch reset to `null`; that reset IS the flash. It is now a `Map<project_id, TabDescriptor[]>`, which removes both the reset and the reason for it (a lookup by id cannot return the previous project's routes). Each visit still refetches and merges. The shell additionally prefetches the tab set for the rail's top 12 projects, 600 ms after the list lands so it never contends with the first paint.
- **Synchronous route resolution** — `LastTabStore` keeps an in-memory mirror of every value it has read or written (`knows` / `peek` / `prime`), and `projectTabRouteSync` turns a tapped id into its route with no `await`, so `router.replace` runs in the same tick as the press. A miss returns `null` and the caller falls back to the async read rather than guessing a tab.
- **`useMobileChat` no longer settles hydration on the seeded socket status at attach.** That declared the transcript loaded while `messages` was still empty, so a WARM re-attach rendered the empty state over a full history. The store read that follows settles it with the messages in hand; the hydration floor still guarantees the spinner comes down.

**Device-verified, before and after, on the same eight switches.** Published to the `preview` channel and re-filmed, twice. Tab-bar repaints after the header swaps: **9 across 7 switches → 0, in both after-runs**. Content pane covered by the shell's loading pane: **6 of 7 switches, 100–200 ms → 0 of 7, in both** (the one remaining is the Documents tab's own list fetch, a different pane). The header, rail highlight and tab bar now all reach the destination in ONE repaint. Time-to-first-repaint after finger-up did not separate from frame noise on this emulator (~50 ms vs ~83 ms medians, n=7) — the synchronous path is proven by a test that hangs the store and still navigates, not by the film. TOTAL time-to-settle is unchanged and varies 0.4–2.8 s across runs in both directions: that tail is the transcript arriving over the network from a live instance, and nothing here touches it.

A follow-up commit removed a NUL byte the rail-id join/split pair had been using as its separator. Both halves agreed so the behaviour was correct, and the leak gate failed the build anyway — a tracked file containing a NUL is opaque to every text rule above it, which is the hiding place that rule exists to close. It is now a memoised id array plus a comma-joined effect key, so there is no separator to get wrong.

**What is NOT fixed, and why.** The transcript still arrives ~800 ms after the switch, and "No messages yet. Say hello 👋" still flashes for ~170 ms before it on a COLD scope. Both are the chat transport, not the shell: `hydrationSettled` treats `status === 'open'` as proof the resume replay has been applied, and on device it is not — the socket opens before the reply arrives. Fixing that honestly needs a resume-complete signal the app-ws protocol does not have, or reversing a deliberate prior decision (ISSUES #402, pinned by `mobile-project-switch-spinner.test.tsx`), so it is reported rather than quietly changed here. The warm session cache also still holds only `MAX_WARM_SESSIONS = 3` sockets, so most switches on a rail of eight are cold; raising it trades sockets for warmth and the real answer is server-side topic multiplexing, already tracked in `session-cache.ts`.

**Tests.** `app/__tests__/project-switch-is-instant.test.tsx` (new) forces each "already answered" case and then makes the corresponding request never come back: settings hung and the switch renders anyway; tabs hung and the real set is on screen from the first frame; the last-tab backing sealed and the tap still navigates. A fourth pins the other half of the rule — a scope nothing has been told about still shows the loading pane. The three behavioural ones fail on the pre-change code, verified by stashing the source files and re-running. `rail-tap-lands-on-the-tapped-project.test.tsx`'s loading-pane test now resets the cache explicitly to reach the un-warmed path it is about.

**Verified.** `bash scripts/ci/typecheck-all.sh` clean (the one local failure is a stale generated `app/.expo/types/router.d.ts`, gitignored and absent in CI; the underlying typed-route complaint in `handleTabSelect` is pre-existing and untouched). ESLint clean apart from one pre-existing `import/first` warning. No feature flags, no dual code paths.

## 2026-07-31 — a rail tap lands on the project it names

Branch `fix/rail-tap-lands-on-previous-project`. THIS is the root cause of the switch defect the two previous passes bounded but did not find. It is not hydration, not the settings gate, not the socket: the router was told to go somewhere else, and the app obeyed.

**What the owner saw.** Every rail tap on a project landed on the PREVIOUSLY-ACTIVE project. From General with another project previously active, tapping a third one went to that previous project — not to the entry project, not to General. The rail highlight never moved to what was tapped, and the content pane spun during the bounce. General was the one entry that always worked, and nothing explained why.

**How it was found.** The release build routes no console output to logcat, so the trace came out through the accessibility tree: a temporary probe rendered the router's live state and a ring buffer of navigation events into a `testID`, read back with `uiautomator dump` (RN maps `testID` to Android `resource-id`). The probe itself had to be fixed once before it told the truth — this app builds with the React Compiler, which caches any render sub-expression with no reactive dependency, so a module-level `LOG.join()` read at render froze at its first value. The log is delivered through state now. The trace, with project names neutralised:

    press=harbor; rail:tap=harbor:cur=willow;
    wp:mount=harbor;     ← the waypoint resolved the RIGHT scope
    shell=harbor;        ← the shell moved to it
    wp:mount=willow;     ← …then it was re-mounted on the PREVIOUS scope
    shell=willow;
    wp:go=willow/chat    ← …and it navigated there

**Three facts compose into that.** (1) The project shell is ONE root-stack screen named `projects/[id]` (`app/app/_layout.tsx`), and expo-router treats a dynamic segment as diverging only when the route NAME is exactly `[id]` — `matchDynamicName` is `/^\[([^[\]]+?)\]$/`, which does not match `projects/[id]` (expo-router 6.0.24, `build/matchers.js`). So an in-app switch is applied to the CHILD navigator and the root route keeps the id you came FROM, permanently. (2) The shell rendered the loading pane INSTEAD of `<Slot/>`; `<Slot/>` IS the `[id]` group's navigator, so that unmounted it, and the remount re-seeded from the stale parent and opened at its initial route — the `/projects/<id>` waypoint — carrying the previous project's id. (3) The waypoint's whole job is to navigate, so it took the owner back. **General's immunity falls out of (2):** General has no settings doc to fetch, so it is never `loading`, so its slot never unmounted.

**The fix is three removals, no timeouts and no retries.** A rail tap now resolves the destination tab AT THE TAP SITE and replaces ONCE, straight to `/projects/<id>/<tab>` — the id travels in a closure instead of being re-derived from a router that can answer with the previous project (`lib/project-tab-route.ts`, new, which owns the last-tab resolution both callers share). The shell now draws the loading, offline and not-found panes as an OPAQUE OVERLAY above a permanently-mounted `<Slot/>` instead of in place of it, so no navigator is ever destroyed mid-switch. And the waypoint — still the entry for a cold start or a deep link to `/projects/<id>` — latches the first scope it resolves, so a router that re-reports the previous project cannot steer it.

**Device-verified, which is the only verification that counts here.** Published to the `preview` channel and run on `emulator-5554` against the owner's live instance. Reproduced first on the shipped bundle (the tap on another project left the shell where it was; a later tap from General landed on the previously-active project). After the fix, eight consecutive switches — including the discriminator case, from General to a third project with another project previously active — each landed on the TAPPED project with the rail highlight moved and the chat surface mounted. Last-tab preservation, tapping the already-active project (ISSUES #401), warm and cold deep links to both `/projects/<id>` and `/projects/<id>/chat`, and cold start all still behave. Bundle identity was proven at RUNTIME, not from APK strings: with the emulator's network cut, the offline pane and the chat surface are now present in the same accessibility dump — they were mutually exclusive on every prior build, so only this code can produce it.

**Tests.** `app/__tests__/rail-tap-lands-on-the-tapped-project.test.tsx` pins each of the three links in the terms the harness speaks: the tap navigates straight to a tab route (never the waypoint), the slot stays mounted under the loading pane, and the waypoint hands off to the scope it was entered with even when the router reverts underneath it mid-read. The harness models the PATH as its single source of truth and so cannot reproduce expo-router's stale route PARAMS (its own header says so) — the third test drives the revert through the path instead, which is the same question asked in the harness's own terms. All four fail on the pre-fix code and pass on this one, verified by stashing the two source files and re-running.

Verified: `tsc --noEmit` unchanged (one pre-existing typed-route error in `handleTabSelect`, untouched); `scripts/ci/lint.sh` clean; the new file 4/0; the eight neighbouring rail/switch suites 69/0; the full app suite unchanged against the branch point (the same 12 in-process cross-test-pollution failures before and after, all passing when their files are run alone). No surface change, so no `SYSTEM-OVERVIEW.md` edit. NO FEATURE FLAGS.

## 2026-07-31 — every project connects: the scope the warm cache could pin forever

Branch `fix/every-project-connects`. Second attempt at the project-switch defect; the first one made it worse, and the evidence that says so is server-side.

**What the server log settles.** Before the previous fix, switching projects opened a session for each one (`session_open topic=app:owner:<project>`, four distinct scopes inside a minute). After it, across fifteen minutes of the owner actively switching, the gateway logged session opens for exactly TWO topics, ever — the General scope and the one project that already worked. Not "connects then fails": no other project ATTEMPTED a connection at all. That rules out hydration, rendering and the server in one line, and it points at the only thing between a mounted chat surface and a socket: session construction. (The shell gate above it is also cleared: `GET /api/app/projects/<id>/settings` answers 200 in ~1ms for every one of the failing scopes, probed against the live install.)

**Where a scope could become permanently unreachable.** `session-cache.ts` cleared its `pending` entry only when a construction SETTLED. A factory that neither resolves nor rejects therefore pinned its key for the life of the process: every later mount of that project took the `pending` branch, awaited a promise that would never answer, and never reached `start()`. One bad construction and the owner could not open that project again until the app restarted — the exact shape of "these projects, never, for fifteen minutes". `acquireSession` now runs the construction under `SESSION_BUILD_TIMEOUT_MS` (8s — generous on purpose; it bounds a hang, it does not police latency) and retracts only its own attempt, so the acquire after a wedge builds from scratch.

**And the attach was not allowed to report failure.** The whole attach ran in a bare `void (async () => …)()` with no `catch`, so a rejected `acquireSession` produced an unhandled promise rejection and nothing else: no status, no log, no second attempt. It now catches, logs, settles the hydrating spinner (there is nothing left to wait for) and RETRIES up to `MAX_ATTACH_ATTEMPTS`, with the budget reset per (identity, scope). A failed attach has to be a moment, never a state.

**The store is the DEVICE's, not the topic's.** There is one `neutron-chat.db` holding one per-user transcript, and a project view is a FILTER over it (`use-mobile-chat.ts` renders `all.filter(m => matchesProject(m, projectId))`). Building a store per topic opened another connection to the same file and re-ran the schema open for every project the device had not visited — the only async native work in the session factory, repeated for no gain inside the cache's construction critical section, and (because the warm cache keeps earlier sessions and their connections alive by design) the piece whose cost grows with exactly the population that stopped connecting. `sharedMobileStore()` builds it at most once per process; every session after the first constructs with no native work at all. A failed build is not memoised. Queue reads are already topic-scoped (`send-queue.ts` takes `topic_id` on every call), so sharing the object partitions exactly as the shared file always did.

**What was RULED OUT, so the next reader does not re-suspect it.** The mount abandoned mid-construction — the leading hypothesis going in — is not terminal: the next mount finds the cached entry and `start()` is unconditional, so it reconnects. That is now an explicit test rather than a belief.

**Tests.** `app/__tests__/every-project-connects.test.tsx` drives the real surface on the device-shaped harness and asserts the thing the server log said was missing: a SOCKET for that project. The load-bearing case pre-wedges a scope's construction, mounts it, and requires a socket to exist afterwards — a test that merely asserted "the spinner comes down" would have passed on the shipped code, which already had a hydration floor, while the owner still could not open a single project. Existing chat suites now reset the shared store per test, since a device-wide store is device-wide.

**4 mutations, each verified to have changed the file's bytes.** Removing the construction deadline failed both wedge tests (9.3s and 12.0s — clamped, so a wedge reports as a failure rather than stalling the runner); swallowing the attach failure failed the end-to-end case; reverting to a per-topic store failed the sharing case. The fourth — dropping a defensive `entries.set` on the join path — SURVIVED, because no test reaches that branch and I could not construct one that does; rather than ship an unexercised guard, the line was removed.

Verified: `tsc --noEmit` exit 0; `every-project-connects` 8/0, `session-cache` + `mobile-project-switch-spinner` + `mobile-chat-send-on-device` 27/0. NOT device-verified — nothing here is reachable from the harness on real hardware. No surface change, so no `SYSTEM-OVERVIEW.md` edit. NO FEATURE FLAGS.

## 2026-07-30 — an invite can be WITHDRAWN, and two smaller residuals (ISSUES #421)

Branch `fix/connect-invite-revoke-residuals`. With Connect served from every install and the guest page mounted, a real invite link works end to end — which made three deliberately-unpatched residuals matter for the first time.

**An invite could not be revoked, and that was worse than one unwanted guest.** `ConnectGuestInviteStore` had two terminal states and the owner drove neither: the guest redeems it, or the clock passes it. So an owner who sent a link to the wrong address waited out the 7-day ceiling. Because `connect/surface-gate.ts` opens the WHOLE `/connect/v1` prefix while a live invite exists, that unwanted link did not merely risk one join — it held a cross-boundary API reachable from the internet for a week.

Migration `0110` adds `revoked_at_ms`. It is a **status transition, not a delete**, and the reasoning is in the migration header: a delete would also close the gate, but the owner loses the audit trail (the question after sending a link to the wrong address is "did I ever invite them, and when did I take it back?"), the boundary loses the ability to make an informed refusal for a token it knows was withdrawn, and an unrecoverable delete races an in-flight handshake where a guarded UPDATE composes with the existing single-use claim guard. `revoke` is guarded (`revoked_at_ms IS NULL`) so it is idempotent and a re-revoke cannot overwrite the original timestamp, and PROJECT-SCOPED so the primary key alone cannot reach an invite on a project the caller did not name. `claimInTx` refuses a revoked invite before the claim, and the claim's own UPDATE carries the guard so a revoke landing mid-handshake still wins. The gate's live-invite probe gains `revoked_at_ms IS NULL`, and the partial index is widened to match.

**What a revoked holder sees is deliberately indistinguishable from an expired one.** `guest-auth-handler.ts:publicRefusal` is the single place that decision is made: `revoked` collapses onto the 410/`expired` response byte-for-byte, and `invite-preview` collapses it onto the same 410 `gone` a spent invite returns. The #421 assessment accepted the existing not-found / expired / already-used split against 256-bit entropy; revocation is the owner's private act and there is no reason to widen an unauthenticated surface for it. The only party who can hold a token that hashes to a real row is the person the owner sent it to, and telling them "you were withdrawn" is a social disclosure with no product benefit — the action is the same either way. That is not a lie to a human, because no human reads that JSON: the guest reads the accept page, whose copy is now one message true of all three causes ("This invite is no longer valid. Ask the inviter for a fresh link."). The truthful distinction survives owner-side.

**It is WIRED, not API-only.** `GET /api/app/projects/<id>/connect-invites` (the owner's ledger, with each invite's derived state) and `POST .../connect-invites/<invite_id>/revoke` join `app-projects-surface.ts`; `open/wiring/connect-owner-surface.ts` implements both against the real store, and it is composed at `open/composer.ts:3014`. The ledger is not a nicety — the raw token is unrecoverable after issuance, so without it the owner has no handle to name. `ConnectMembersClient` gains `listInvites` / `revokeInvite`, and `ProjectSettingsDrawer` renders an "Outstanding invites" list with a Withdraw button, gated on `canManage` (the same gate as issuing: taking an invite back is the inverse of sending it; member revoke stays owner-only, since that ejects a person). The drawer shows only `live` invites — the server's ledger is complete, but a Withdraw button is only meaningful on an invite that can still be redeemed. `invite_id` IS the `token_hash`: not a credential (redemption needs the raw token) and it drives nothing the owner-authenticated response does not already contain.

**An unconfigured rate-limit bucket is no longer `Infinity`.** On a fail-closed limiter guarding two unauthenticated endpoints, a config value nobody wrote is exactly when you want the conservative answer. `DEFAULT_BUCKET_MAX = 10` — the tightest cap the production wiring configures — applies to any bucket the caller did not set. Nothing relied on the old behaviour: the sole production caller configures four of five buckets and the fifth (`events`) has no `check()` call site anywhere in `connect/api/server.ts`. The old unit test asserted the defect as intended behaviour, which is why it survived; it now asserts a bounded, finite default driven off the exported constant.

**The accept page cites no absent documents.** Its footer asserted agreement to a Terms page and a Privacy page, linked by path; neither path is in `landing/routes.ts`, so both 404 on every install, and Neutron Open is self-hosted software with no service operator to have published them. Deliberately not replaced with drafted legal text — inventing terms on behalf of whoever runs the install would be worse than the dead links. The real agreement was always the mandatory, project-specific disclosure that gates the Join button. What remains is the one fact the disclosure does not cover: what becomes of the two values the form collects.

**Tests.** `open/__tests__/open-connect-served.test.ts` grew four cases driving HTTP at the REAL composed Open surface over the live `Bun.serve` harness — revoking through the route the app calls closes the surface on the next request; a revoked token is refused at the handshake with bytes compared against a genuinely aged-out invite's; revoke is idempotent, project-scoped and 401s unauthenticated; and every `href` the served page renders is fetched and must return 200, which is stronger than grepping for the two literals. Plus store-level revocation + ledger units, the limiter default, the app client's wire shape, and a source-level pin that the drawer actually calls `revokeInvite` (there is no render harness for that component in this repo, and the pin says so).

**16 mutations, every one verified to have changed the file's bytes: 15 defect mutations all killed, 1 control (a comment-only edit) survived as designed.** Two of them changed this PR rather than confirming it, which is the point of running them. (a) Reinstating `DEFAULT_BUCKET_MAX = Infinity` did not fail the suite — it HUNG it, because the new test looped to the constant. A test that wedges on the exact defect it exists to catch is a stalled CI job, not a signal; the probe is now clamped and finiteness asserted first. (b) Deleting the claim UPDATE's `revoked_at_ms IS NULL` guard survived, because every non-concurrent path is already covered by the pre-check above it and no test drove the race the guard exists for. Rather than report it and move on, the race's one observable consequence — a pre-check fed a pre-revocation row — is now driven directly, and the mutation is killed twice over (removing the guard, and removing the pre-check while leaving the guard).

NO FEATURE FLAGS.

## 2026-07-30 — the Connect invite link now lands on a page (ISSUES #421 residual)

Branch `feat/connect-accept-page`. #421 made a self-hosted Open install SERVE Connect and proved the API end to end: the owner issues an invite, a guest previews it, handshakes, receives a bearer minted by that install's own key, and posts a turn that is accepted and durably attributed. What it left, deliberately rather than half-wired, is the surface a human meets. `landing/connect-accept.ts` and `connect-accept.html` had shipped in this package for months imported by nothing but their own jsdom test, while `open/wiring/connect-owner-surface.ts:95` minted the link `<base>/connect/accept#<token>` and the app displayed it. No route mounted the page, so every guest who clicked a real invite got the default 404. Correct API, dead product.

**Two paths join `LANDING_ROUTE_MANIFEST`** (`landing/routes.ts`) — `/connect/accept` and `/connect/accept.js` — and `landing/server.ts` serves them: the static page, and its client lazily bundled from `connect-accept.ts` and cached, the same shape as `/invite.js` including the rising-edge `bundle_build_failed` latch. Both are disjoint from the Connect API prefix `/connect/v1/*`, and the landing rung is consulted ahead of the connect rung, so neither shadows the other. The Open owner gate routes landing-manifest paths to `openFetch`, which is a pure passthrough for anything that is not `/`, `/chat`, or an SPA deep link — so the guest page is reachable without an owner cookie, which is the entire point.

**The token stays in the fragment.** A fragment is never sent to a server: the request line is a bare `GET /connect/accept`, identical for every guest and every token, and the client reads `window.location.hash`, SHA-256s it in the browser and sends only the hash to `invite-preview`. Moving it to a query parameter would put a live single-use invite into access logs, `Referer` headers and browser history. The page is served `no-store` with `referrer-policy: no-referrer` and a hash-based CSP (`buildStaticPageCsp`, the renamed helper the Telegram onboarding page already used).

**The page is ALWAYS SERVED — not behind the Connect surface-state gate.** It is static bytes, byte-identical in every state. Gating it would convert `GET /connect/accept` into a free, unauthenticated probe of exactly the state `connect/surface-gate.ts` exists to conceal — "this install currently has a live invite or a live collaborator" — which is strictly worse than serving an inert page. Everything state-dependent stays behind the gate: on a closed install the page renders and its preview fetch 404s, so the guest is told the link is not valid. A spent or expired token gets 410 and reads "expired or already been used — ask the inviter for a fresh link"; an unknown one gets 404 and reads "not valid". Those two statuses are the pre-existing, rate-limited, field-free API answers; the wording is not where an oracle could live, so conflating the copy would cost a real person a useful message and buy nothing.

**Tests.** `open/__tests__/open-connect-served.test.ts` grew three cases that drive browser-shaped GETs at the REAL composed Open surface over the live `Bun.serve` harness — a test that imported the module or asserted a handler was constructed would have passed throughout the outage. They pin: the invite link's own path and fragment shape, a 200 carrying the page's actual control ids and its script tag, a 200 for the bundle carrying the preview + handshake URLs, byte-identical bytes with the surface closed and open, and the two dead-token statuses. 5 defect mutations, 5 killed (unmounting the manifest path, deleting either handler, moving the token into a query string, serving the wrong bytes); 2 benign mutations survived. Every mutation verified to have changed the file's bytes. `connect-accept.html` also stopped pointing its icon at `/favicon.png`, which has never existed in this package. NO FEATURE FLAGS.

## 2026-07-30 — the leak gate's Tier-1 PII rule can now run BEFORE a push

Branch `fix/leak-gate-local-pii-prepush`. The Tier-1 PII denylist is a repository secret (`LEAK_GATE_PII_DENYLIST_B64`), so it existed only inside CI, and `scripts/ci/leak-gate.sh` said as much when run by hand: *"Tier-1 PII denylist SKIPPED — context 'local' has no access to repository secrets."* An author therefore had **no pre-push signal at all** for the one class of leak that cannot be undone. A push is copied to GHArchive/BigQuery within the hour; a bad file can be force-pushed away and CI blocks it before a merge, but a commit message or PR body is permanent for everyone. On 2026-07-30 exactly that happened — private proper nouns went out in a commit message and a PR body, CI caught them, the branch was scrubbed and force-pushed, and the first push was already mirrored. Care is not a control.

**The denylist now has a second source: a plain-text file OUTSIDE the repo** — `$LEAK_GATE_PII_DENYLIST_FILE`, else `${XDG_CONFIG_HOME:-$HOME/.config}/neutron/leak-gate-pii-denylist`. Outside every working tree on purpose, so no `git add` in any repository can reach it; the list itself names the strings it bans, which is why it has never been committable. Only the SOURCE differs from CI — it feeds the same `compile_denylist` and the same rules, so there is no second matcher to drift. It is consulted only when the env var is unset **and** `IN_CI=0`: gating on the CI flag rather than on emptiness is what keeps the 2026-07-29 fail-closed guarantee intact, since a file planted on a runner can then never stand in for the secret (mutation-tested in both directions).

**`--messages-only`** scans commit messages + PR title/body and nothing else. The full tree scan takes ~100 s on this repo and a 100-second pre-push hook is a hook that gets `--no-verify`'d; the surface it would add is also the remediable one. It is REFUSED inside GitHub Actions, so it can never become a way to skip the tree scan in CI. `LEAK_GATE_HEAD_SHA` bounds the window to the sha actually being published, which is not always `HEAD` (`git push origin <sha>:main`, a push from a non-current branch).

**`.githooks/pre-push` + `scripts/install-git-hooks.sh`** (`core.hooksPath`, so hook changes arrive with a pull rather than a re-run). The hook blocks the push on a finding **and on an INCOMPLETE result** — "I could not check" must never be worth less than a failed check, which is the precise defect that let Tier-1 sit dead for ~3,700 CI runs. The installer refuses to arm the hook when no denylist resolves: a control and its pattern source ship together or neither is real. Outside contributors have nothing to put in that file and do not need the hook; CI runs the same gate on their PR.

**A local run that cannot load a denylist no longer prints a green.** It reports `RULES THAT COULD NOT RUN: …` and `LEAK GATE: INCOMPLETE`, exit **3** (0 clean / 1 findings / 2 config error / 3 incomplete). The fork-PR path inside CI is deliberately untouched — still exit 0, still re-scanned by `leak-gate-nightly.yml` — because failing every outside contributor's PR over a secret GitHub withholds by design would be noise, not safety. Two "green" assertions in the existing self-tests were asserting a `SILENT ✅` produced with the PII rule switched off; they now supply a synthetic denylist and assert a real green, and `gateEnv` pins the denylist file path so a maintainer's own list can never leak into a fixture run.

**Tests.** `scripts/ci/leak-gate-selftest.test.ts` — 50 pass. The load-bearing cases perform a REAL `git push` against a bare remote through the installed hook (a hook invoked only directly proves nothing about whether it ever fires) and assert the remote did not move; plus the reworded-message push that must SUCCEED, the armed-hook-with-a-vanished-denylist block, and the installer's refusal leaving `core.hooksPath` untouched. 12 mutations, 12 killed, each verified to have changed the file's bytes and paired with a test that exercises the mutated line. Every token in the suite is a neutral invention. NO FEATURE FLAGS.

## 2026-07-30 — a resurrected Retry button no longer RENDERS as live (ISSUES #419)

Branch `fix/419-spent-button-server-state`. #415 closed the dangerous half of this defect: `claim_button_prompt` gates on `ButtonStore.resolve`'s `was_new`, so a second tap does not dispatch and the agent never re-runs. What it deliberately left open is the half the owner actually SEES. Both clients kept spent-ness in session-local memory — a `chosenByPrompt` `useState` on native (`app/components/ChatSyncSurface.tsx`), a controller-instance `Map` on web (`landing/chat-react/controller.ts`) — and a reply row's TTL is TEN YEARS, so nothing ever retires the affordance. Any remount (tab switch, project switch, navigation, page reload) discarded the memory and drew a live, tappable Retry on an already-answered prompt. The owner taps and nothing happens: a surface asserting something untrue about system state, the same family as #386 and the activity dot that pulsed for days.

**Spent-ness is now SERVER state.** After the claim, the surface calls `AppWsAdapter.recordPromptChoice` (`channels/adapters/app-ws/adapter.ts:646-712`), which does two things and needs both:

- **stamps** the answer onto the agent message that carried the prompt — `AppChatStore.markPromptChosen` (`persistence/app-chat-store.ts:264-329`) writes `chosen_value` into the row's opaque `meta` blob and `applyPersistedAgentMeta` re-hydrates it on replay, so a cold open / reinstall / second device gets the answer through the ordinary replay path with no new mechanism;
- **fans** `{v:1,type:'prompt_resolved',message_id,prompt_id,chosen_value,seq?,ts}` (`wire-types/app-ws-envelope.ts`) to every live device. This is not optional: a pure component remount never reconnects — it re-reads the DURABLE LOCAL store — so without the live frame the answer would not be on the client's disk when the remount reads it, and the button would come back.

`markPromptChosen` is FIRST-WRITE-WINS and returns the RECORDED value, so calling it on a REFUSED claim is deliberate and useful: the tap the server will not honour is exactly the tap sent by a stale surface, and re-broadcasting the recorded answer heals it. The lookup is `json_extract(meta_json,'$.prompt_id')`, not a `LIKE` over the blob — a substring match hits a prompt id embedded in a doc-ref URL or a citation title and spends the wrong row (mutation-tested).

**One rule, both surfaces.** `spentChoiceValue(message, localChoice)` (`chat-core/types.ts`) is THE spent-ness predicate: durable server value first, this session's optimistic tap second. Native and web both call it — the `isColdStartAck` precedent from #6, so there cannot be two divergent answers to "is this button spent?". The optimistic layer stays, but only as the immediate-frame collapse it always should have been; its old comment claiming a fresh cold-open could never show an answered-but-open prompt was simply false and is corrected in place. On the client the merge is terminal — `pickAgentMeta` takes `incoming ?? existing`, so a receipt/reaction/edit re-upsert or a replay of the ORIGINAL envelope cannot un-spend a prompt — and `SyncEngine.applyPromptResolved` drops a frame whose `prompt_id` disagrees with the stored message's. The native on-device store gains a `chosen_value` column (`app/lib/chat-core/sqlite-store.ts`, idempotent `ensureColumn`), which is what makes the remount work on device rather than only in memory.

**A dead line, found by mutation and removed.** `chosen_value` was initially added to `AGENT_META_KEYS`; removing it changed nothing, because `outgoingToEnvelope` has no path that sets `chosen_value` — an emit is always a fresh, unanswered prompt. It was an unreachable line that looked load-bearing, so it is gone and the reason is recorded next to the list.

**Tests.** Four suites, GENERAL scope throughout (#415 learned that a project-scoped test can let a mutation survive because the view filtered the row out for an unrelated reason). `gateway/__tests__/app-ws-prompt-spent-server-state.test.ts` — real `Bun.serve` + real surface + real `AppChatStore` over real SQLite + real `ButtonStore` + the real `buildButtonPromptClaim`, driving a real chat-core `SyncEngine`: remount, cold open, the refused-but-healing re-tap, first-write-wins. `app/__tests__/chat-prompt-spent-after-remount.test.tsx` — the REAL `ChatSyncSurface` mounted, pressed through the same accessibility affordance a thumb uses, then UNMOUNTED AND REMOUNTED over the warm session's durable store. `landing/chat-react/__tests__/prompt-spent-after-remount.test.ts` — the same for a page reload (new controller + session, same store). Plus `chat-core/__tests__/buttons.test.ts` (merge terminality, misrouted frames, decoder) and `persistence/app-chat-store.test.ts` (stamping, topic scoping, the substring trap). Each remount suite carries an explicit CONTROL case that removes the server's record and shows the button coming back live — the defect, reproduced, so the passing case cannot be vacuous. 20 mutations, all killed (two survived first and are reported in the PR, not quietly fixed: the dead meta key, and the un-spend merge rule which had no test until one was written). NO FEATURE FLAGS.

**Not device-verified.** Nothing in this repo's harness renders a real screen; the native test proves wiring, press-reachability and render structure under react-native-web, not pixels on a phone.

**A CI gate this PR turned red, and fixed rather than bypassed.** Adding three test files broke `run-tests.sh shard partition > 4 shards partition the set exactly` — not a gap or an overlap, the BALANCE assertion (`max - min <= 1`). The sharder round-robined each of the three lanes (general / PGLite / device) from index 0 INDEPENDENTLY, so every lane's remainder landed on the same low-index shards and `max - min` could reach 3. It held on main by arithmetic luck and broke the first time a PR added files across two lanes. The round-robin cursor now CARRIES ACROSS lanes (`scripts/run-tests.sh`), making the three lanes one continuous round-robin over a fixed concatenated order — balanced within one file by construction, each lane still spread proportionally, the partition function otherwise unchanged (same gaps/overlap properties, only phase-shifted per lane). Shard sizes went 270/269/268/268 → 269/269/269/268. Mutation-tested so the repair did not trade a false positive for a false negative: a real GAP (drop one file from every slice) → red, the ORIGINAL per-lane-reset imbalance → red, a real OVERLAP (two shards share a slice) → red.

## 2026-07-30 — mobile chat: the four iMessage defects (composer clipping, bubble rhythm, the inspector, the "Waking up…" bubble)

Branch `fix/imessage-chat-ux`. Ryan asked three times for the chat screen to match iMessage and named four things; all four are addressed here, plus one harness fault found on the way.

**1. The composer and send button were not fully visible.** The keyboard-overlap lift already landed (#5, `lib/keyboard-inset.ts` `keyboardOverlap`) and is untouched. What was missing is the OTHER state — keyboard DOWN. `react-native-safe-area-context` was a declared dependency of `app/` with **zero imports anywhere in the app**, and the project shell hard-codes its top inset and applies no bottom inset at all (`app/app/projects/[id]/_layout.tsx:729-733`), so the surface runs to the physical bottom of the screen and the composer's fixed 16pt bottom padding sat under a 34pt home indicator. New pure `composerBottomInset` (`app/lib/keyboard-inset.ts:60-103`) adds the safe area **only while the keyboard is down** — with the keyboard up the surface is already lifted by the full overlap and the keyboard covers the indicator, so adding it again floats the bar over dead background. `InputComposer` takes the value as `bottom_inset` (`app/components/InputComposer.tsx:108`, applied at `:289`); `ChatSyncSurface` computes it (`:450-454`). The bar is also reshaped to iMessage: pill-radius field, bare attach glyph, a 34pt circular ↑ send button (label still "Send").

**2. Too much padding at the bottom of each message bubble.** Three separate causes, none of them iMessage's. (a) `bubbleWrap` carried a uniform `marginVertical: SPACING.xs`, i.e. 8pt between EVERY pair of bubbles regardless of who sent them; the gap is now a function of the sender (`bubbleGapPt` — 2pt inside a run, 8pt at a sender change, 0 at the top of the list) applied per row as `marginTop`. (b) 8pt vertical bubble padding → 6. (c) the delivery-tick row rendered INSIDE every outgoing bubble; it is now outside the bubble and shows for the newest outgoing message only, iMessage-style — a FAILED send is exempt and always shows, because that glyph is the retry button. Tail corners now follow the run (one tail per run, not one per bubble). All of the geometry lives in `app/lib/chat-bubble-metrics.ts:93-166`, next to the width cap, for the same reason.

**3. The inspector's ✕ was unreachable and the panel was cramped.** `ActivityInspectorDrawer`'s header used a hard-coded `paddingTop: SPACING.xxl` (32pt) — shorter than the notch on every modern iPhone — over a 16pt glyph with 4pt of padding, a ~24pt target. Now `safeArea.top + SPACING.sm` (`:295`) and a full 44pt HIG target with `hitSlop` (`MIN_TAP_TARGET_PT`, `:79`). Type came up off 11pt monospace to 13/19, the two clocks read as a labelled pair with a divider, the state gets a colour dot matching the rail, and the row list takes the bottom safe area.

**4. "Waking up…" rendered as a real chat message.** The gateway sends the cold-start ack as a live-only `agent_message` with `system_notice: true` and no `seq`, and `AppWsAdapter.send` deliberately skips the durable row (FIX #333). The web client has always routed it to a separate transient `systemNotice` channel — but the predicate that does so was a PRIVATE function inside `landing/chat-react/controller.ts`, so the native client, which shares `chat-core` and not that file, had no such behaviour: `normalizeInbound` turned the ack into an ordinary `ChatMessage` and the on-device store kept it forever (it survives a reload; the resume replay can never reconcile it, because the server has no such row). Fixed by moving the predicate into the shared package — `isColdStartAck` / `isTransientSystemNotice` / `systemNoticeText` (`chat-core/types.ts:432-481`) — and having BOTH surfaces import it, so there is one mechanism rather than two. `MobileChatSession.handleInbound` drops a transient frame before persisting (`app/lib/chat-core/mobile-session.ts:352-360`); a pure reducer mirrors the web clearing rules including the FIX #347 late-ack latch (`foldSystemNoticeFrame`, `app/lib/chat-core/chat-render-model.ts:86-152`); `useMobileChat` exposes `systemNotice` and re-arms the turn on send; `ChatSyncSurface` renders it as a centered pill in the list footer, never a bubble. Notice folding runs BEFORE the project filter on purpose — the ack carries no `project_id`, so `frameMatchesProject` would drop it in every project view, and the socket is already topic-scoped.

**Harness fault found and fixed.** `app/__tests__/support/stubs/flash-list.tsx` imported `View` from the `react-native` SPECIFIER. Two app suites register a process-global `mock.module('react-native', …)`, and the harness's source-rewrite covers `app/{app,components,lib,features}` but not the stubs directory — so depending on chunk composition the stub's `View` rendered `null` and EVERY transcript row silently disappeared from mounted chat tests. Now imports the sibling stub directly. Six of seven order-dependent failures came from this; the seventh was a global `mock.module('../lib/markdown-render')`, which the new suite works around by asserting on rows rather than agent body text.

**Tests.** New `app/__tests__/imessage-chat-ux.test.tsx` — 21 tests, one describe per defect. Mutation-tested: 11 mutants, 11 caught (composer always/never adding the safe area; the bar ignoring `bottom_inset`; a uniform bubble gap; the tick back on every bubble; a hard-coded 32pt inspector header; a 24pt close target; 11pt rows; persisting the transient notice; the pill never clearing; flag-only ack detection; no late-ack guard). Verified: `tsc --noEmit` exit 0 (root + app); `bun test app/__tests__` 1257/0; `chat-core/__tests__` 145/0; `landing/chat-react/__tests__` 450/0; lint, depcruise and leak gates all green.

**NOT device-verified.** The harness fakes every layout rect and the safe area, and cannot render an iOS keyboard. Everything above is proven as wiring + arithmetic + render structure; how it LOOKS on Ryan's phone is unverified until he runs a build. No OTA was published.

## 2026-07-28 — `neutron import-legacy` imports `<vault>/Archive/` as ARCHIVED projects

Branch `feat/legacy-import-archived-projects`. Lane A previously listed the archive in the dry run and deliberately imported none of it, as an open decision. The owner decided: import them, as archived. `neutron import-legacy` now walks both trees — `Projects/` → rail projects, `Archive/` → rows with `archived_at` set (migration `0096_project_archived.sql`), i.e. present in `listArchived()` (`gateway/projects/sqlite-store.ts:534-551`) and absent from the rail's `list()` (`:332-338`).

**The ordering is forced, and getting it wrong fails SILENTLY.** `setContent` reads through the store's private `readRow`, which filters `deleted_at IS NULL AND archived_at IS NULL` (`gateway/projects/sqlite-store.ts:474-486`); its create-nothing guard at `:214` therefore returns null for an already-archived row, the UPDATE never runs, and the description/persona vanish with no error and no exception. So `importOneArchivedProject` runs `ensureProjectRow` → `setContent` → `materializeProjectScaffold` → **`archive()` last**. Archive-first still produces an archived row and still reports `created-archived`; only the content is gone. The tests therefore assert the CONTENT landed, never merely the flag, and a second test reaches the same fact from the other side (`restore()` then read through the store — content readable after restore can only have been written before the archive).

**The non-project test is OBSERVABLE STRUCTURE, not a name list.** The Lane A dry-run carried a hardcoded predicate (`/^\d{4}$/ || 'system' || startsWith('entities-pre-rebuild') || startsWith('resources-areas-pre')`); re-measured against the live tree it was wrong in both directions. `Archive/system` HAS a STATUS.md and is a project. `milestone-2026`, `pre-compass` and `workflow-research-stale` have NO STATUS.md and the name list was calling them projects. And `2026/` is neither: it is a year CONTAINER whose two children (`aurora` 57 docs, `server-migration`) are both full projects, which the name list dropped on the floor. The replacement rule, in `legacy-import/scan-legacy-archive.ts`: a dir with a top-level `STATUS.md` is a project (every dir in the live `Projects/` tree has one — zero misses, so it is the vault's own marker); a dir with no `STATUS.md` whose subdirectories ALL have one is a container and its children are the projects; everything else is not a project, with the counted evidence recorded and printed. Unanimity rather than "any" keeps the two big infrastructure snapshots (0 of 18, 0 of 14) far from `2026/` (2 of 2) instead of on a knife edge. Nesting stops at depth 2 deliberately.

Measured on the real vault: **23 dirs → 19 archived projects** (17 at depth 1 + 2 under `2026/`), 5 not projects, 1 container.

**Re-run semantics (own set of outcomes, disjoint from the active path's).** `created-archived` on the run that creates the row; `existing-archived` thereafter — left byte-for-byte alone, no content write, no re-archive, no scaffold. Content is imported ONCE. An edited the legacy harness `one_liner` does NOT re-converge onto an archived row: `setContent` physically cannot write there and the importer will not un-archive to work around it. `skipped-deleted` still never resurrects a soft-deleted id.

**Archived in the legacy harness but ACTIVE in the target DB → `skipped-active`: nothing is touched, and the report says so.** Archiving it would yank a project the owner is actively using off their rail as a side effect of a migration; converging it would overwrite live content with stale archived text. Neither is a call an importer makes for the owner — the Admin tab archives it in two clicks. The bind target is resolved BEFORE any write (`resolveBindTarget`, `gateway/wiring/project-create.ts:83-99`) so a live row that merely NAME-collides with an archived slug is protected too, not just an exact id match.

Manifest records gained `source_kind: 'active' | 'archived'` and `archive_container` so a later lane can tell rail from archive without re-deriving anything. Two new hard stops (exit 2) join the slug-identity one: archive dirs that are not slug-stable, and two archive sources claiming one `project_id` (which would silently converge onto one row). Five display-name overrides added for archive slugs title-casing renders wrong (`ab-claude-vps`→AB Claude VPS, `gamma-acquisition`, `legacy-agent-optimization`, `theta-loan-refinance`, `server-migration`); `pad()` now always leaves a trailing space so an over-long cell pushes the next column right instead of welding to it ("Acquire Delta Groupyes").

**All three mutations were killed.** (1) Archive BEFORE writing content → 6 failures, led by the content-landed test. (2) Remove the non-project exclusion (every dir is a project) → 10 failures including `EXCLUDES a non-project dir`. (3) Remove the `skipped-active` guard → exactly the 2 live-row tests, and nothing else.

59 pass / 0 fail across `open/__tests__/legacy-import-archived.test.ts` (24 new) + the two pre-existing `legacy-import*` files. Verified beyond unit tests with a dry run against the real vault into a throwaway `NEUTRON_HOME`: 25 active CREATE + 19 CREATE-ARCHIVED, 5 exclusions each printed with its evidence, 18 degraded archive sources named, 0 assertion failures.
## 2026-07-28 — the legacy harness cutover, MEMORY lane (`open/legacy-import/memory/`)

Branch `feat/legacy-memory-importer`. The memory replay: MemoryStore drawers + the MemoryStore knowledge graph + Claude auto-memory + `~/legacy/Memory/` notes → GBrain pages and typed edges. Dry-run by default, `--apply` to write, resumable, converging on re-run, and it refuses to write rather than fuse two records into one slug. No CLI subcommand is wired yet — the lane is a library with injected seams (see "wiring" below).

**The schedule risk was the first deliverable, and it is not a risk.** The migration plan flagged memory as "the single largest transform-effort class" with ~9340 items, and nobody had ever run a replay at that volume. Two real measurements against a live `gbrain serve` stdio child (host at load average ~20):

- *Scaling bench* — 4000 individual chunk bodies (avg 432 B) into a fresh PGLite brain: **4000 pages / 190.0 s = 21.06 pages/s**, p50 33 ms, p95 123 ms, `get_stats page_count` 4000. Rate does NOT degrade with depth; it rose monotonically 10.3 → 21.1 pages/s across the run (JIT + PGLite warmup), so brain depth is not a scaling risk.
- *The real corpus, end to end* — the actual 1179-page plan (7.97 MB, avg 6.8 KB/page): **1179 pages / 151.1 s = 7.80 pages/s**, 0 failed, 6 edges, read-back verification OK for all 1179. **171.6 s wall including verification.**

The 2.7× gap between the two is page SIZE (whole reassembled documents vs single chunks), not page count. Either way: **the memory replay is ~2.5 minutes, not hours.** No special cutover window is needed. `DEFAULT_PAGES_PER_SECOND` tracks the real-corpus figure (7.8). Caveat carried in the code: the measuring host had no embedder (no `OPENAI_API_KEY`, Ollama not installed), so this is the keyword+graph write path; a brain with a live embedder embeds on write and will be slower.

**Every source count in the plan had drifted; all were re-measured.** Chroma snapshot `~/legacy/backups/memory-store/2026-07-28/chroma.sqlite3`: 8948 embedding rows (plan said ~8948 ✓). Claude auto-memory: **547 files across 39 project dirs**, not the ~65 in the plan — an 8× miss. `~/legacy/Memory/`: 327 notes ✓. Knowledge graph: 10 entities / 6 triples ✓. Raw total 9838.

**8948 chroma rows are only 295 documents, and replaying them as rows would have been wrong.** 8921 of the rows carry `source_file` + `chunk_index` and are RAG chunks of just 257 distinct files (max `chunk_index` 189); 11 have an empty `source_file`; 27 are whole-document `diary_*` entries. Replaying rows would write 8948 fragment pages that GBrain then re-chunks — chunks of chunks, each with provenance identical to its 189 siblings. So the reader reassembles chunk groups per source file. Reassembly is safe because MemoryStore's chunks do not overlap: the worst case (190 chunks of `2026-03-28-peptide-stack.md`) sums to 46 529 chars against a 47 849-byte file, i.e. a partition minus per-chunk trimming. Net plan: **1179 pages** (295 drawer + 547 auto + 327 note + 10 KG entity) + 6 typed edges.

**`MemoryStore.add` discards metadata, so provenance had to go into the page body.** `gbrain-memory/gbrain-memory-store.ts:32-39` passes `metadata` to `resolveSlug` (:142-147) and then calls `put_page` with `{slug, content}` only. Every other key is dropped, and the sources are one-time snapshots that get decommissioned — dropped means gone. The lane therefore serializes provenance as a YAML frontmatter block in the body: `legacy_source`, `legacy_id`, plus `legacy_room|wing|hall|topic|type|agent|date|filed_at|added_by|ingest_mode|extract_mode|source_file|chunks|imported_at`. Values are emitted as JSON scalars (a strict subset of double-quoted YAML), so colons, quotes, `#` and newlines are safe; absent keys are omitted rather than written as `''`; key order is deterministic so the checkpoint hash is stable. Auto-memory files already ship their own frontmatter (`name`/`description`/`type`/`originSessionId`) — those keys are hoisted into the SAME block rather than stacked under a second fence, flagged by `legacy_had_frontmatter`. A non-uniform metadata value within a chunk group is recorded as `legacy_meta_conflict_<key>` instead of quietly taking the first value.

**That turned out to be better than a workaround: GBrain parses it back into structured storage.** `get_page` against the imported brain returns the block as a structured `frontmatter` field (body in `compiled_truth`) — verified directly: `{"legacy_source":"memory-store-drawer","legacy_room":"technical","legacy_wing":"delta","legacy_filed_at":"2026-04-08T17:04:05.947947","legacy_source_file":"/home/owner/.legacy-agent/…/2026-02-17.md",…}`. The provenance lands queryable, not merely preserved as text.

**Slug collisions are the sources' dominant hazard, and the strategy is three layers plus a refusal.** The 547 auto-memory files share only 402 distinct basenames — `MEMORY.md` appears 35 times, `legacy_feedback.md` 7, a dozen `feedback_*.md` names 6 each; `~/legacy/Memory/` has ~30 `daily/<date>.md` + `kaizen/<date>.md` pairs. A basename slug would have silently fused ~145 files. So: (1) a per-lane prefix (`vmem-drawer-`/`vmem-note-`/`vmem-auto-`/`vmem-kg-`) makes cross-lane fusion impossible by construction; (2) the slug body normalises the FULL discriminating key — project dir + relative path, directories included — never a basename; (3) keys over 72 chars are truncated with an 8-hex tail derived from the full key, so truncation cannot fuse either (the KG's sentence-length entity ids need this). And then `detectCollisions` runs over the entire planned slug set before a single write; a non-empty result ABORTS the apply with the full collision set printed. We never pick a winner. The real corpus plans clean: **0 collisions across all 1179 pages**.

**Resumable + converging from the start.** An append-only JSONL ledger at `<owner_home>/migration/legacy-memory-checkpoint.jsonl` records `{slug, sha256, at, lane}` per confirmed write. A re-run skips a slug whose content hash is unchanged and REWRITES it when the source changed, so an interrupted run continues instead of restarting and an edited note converges. Append-only line-delimited is deliberate: a crash truncates at most the trailing line, which the loader discards (a rewritten whole-JSON document could be truncated to nothing). A failed page is NOT checkpointed, so the resume retries it. Proven against the real brain: second apply = 0 written / 1179 skipped / 0 failed.

**Verification found a real hole in the `MemoryStore` contract.** The first real 1179-page apply verified as FAILED with "1079 missing" — and the import was fine; the verifier was wrong. `MemoryStore.query({query:''})` routes to `list_pages` (`gbrain-memory-store.ts:82-95`), and gbrain's handler hard-clamps it: `clampSearchLimit(p.limit, 50, 100)` — `gbrain/src/core/operations.ts:1256` — max 100 rows, and the op exposes no `offset` (`operations.ts:1223-1238`), so it cannot be paginated. `query({query: slug})` routes to `search`, a CONTENT search that false-negatives on any page not containing its own slug text (3 of ~25 sampled). And `MemoryStore` has no `get` at all (`memory-store.ts:32-66`). **So the typed contract cannot prove a >100-page import landed.** Resolution: a narrow injected `PageReader` (`get_page`), exactly parallel to the `LinkWriter` (`add_link`) seam and justified the same way. Without a reader the verifier still runs but reports `enumerationCapped` rather than manufacturing phantom missing slugs — that degradation has its own regression test.

**Typed edges need a different dependency than pages.** `add_link` is not on `MemoryStore`; its only in-tree caller uses the raw client (`gbrain-memory/GBrainSyncHook.ts:349-354`, `{from,to,link_type,context}`). KG entity ids are sentence-length strings and GBrain edges join page slugs, so each entity is written as its own page first and the triples join those slugs. A triple whose endpoint has no entity row is REPORTED as dangling, never fabricated. `add_link` proved idempotent on `(from,to,link_type)`: three apply runs left exactly 3 edges on `vmem-kg-legacy-agent`, matching the 3 source triples.

**Both required mutations were killed, plus a subtler third.** (A) `renderPage` returning the bare body → 5 fails including both NET-1 tests. (A2, the realistic regression) keeping the fence and `legacy_source`/`legacy_id` but dropping the provenance loop → 3 fails, still including both NET-1 tests. (B) `detectCollisions` returning `[]` → 3 fails, including the refusal test asserting the apply throws AND that nothing was written. The NET-2 fixture is a genuine hole in path→slug normalisation rather than a contrived one: `a/b.md` and `a-b.md` both normalise to `a-b-md`.

Wiring: `open` does not depend on `@neutronai/gbrain-memory` (the memory-backend swap seam bars product modules from naming the raw transport), so the lane takes three structural interfaces — `PageStore` (satisfied by `GBrainMemoryStore`), `LinkWriter`, `PageReader` — and the composer supplies adapters over the raw client for the latter two.

Beyond unit tests, the lane was run end to end against the REAL sources three times into throwaway brains: a dry run (writes nothing, 9838 raw items → 1179 pages, 0 collisions, 0 unparseable, 0 dangling triples), a clean full apply (above), and a re-apply proving 0 written / 1179 skipped / 0 failed with verification still OK.

37 pass / 0 fail in `open/legacy-import/memory/__tests__/memory-import.test.ts`.

**Also in this branch: a pre-existing timing flake in `gateway/__tests__/cores-tasks-projection-wiring.test.ts` (shard 4/4).** It waited for the debounced (30ms) projection writer with a FIXED `setTimeout(120)`, so it only ever had ~90ms of slack; on a loaded runner the flush landed later and `readFileSync` threw ENOENT before a single assertion ran. Nothing in this branch touches `gateway/` — the failure is the fixed sleep, reproduced locally by shortening it (identical ENOENT, identical line). Replaced with a `statusAfterFlush` poll that returns as soon as STATUS.md contains the expected rows and otherwise returns whatever is there at the deadline, so the same `toContain` assertions still fail loudly. Mutation-verified: dropping the `store: canonicalStore` passthrough — the exact regression this file guards — still fails it. `composition-tasks-projection-wiring.test.ts` carries the same fixed-sleep pattern and is the next candidate to flake; left alone here rather than widening an unrelated branch.

## 2026-07-28 — the legacy harness ENTITIES import lane (`open/legacy-import/entities/`)

Branch `feat/legacy-entities-importer`. Dry-run-by-default importer for the one-time the legacy harness→Neutron cutover of the global entity corpus. `bun run open/legacy-import/entities/cli.ts --source ~/legacy/entities --data-dir <NEUTRON_HOME> [--apply]`. Independent of the projects lane — entities are global, not project-scoped — and confined to its own subdirectory.

**The measured shape of the source, which differs from the audit the brief was written against.** 1309 importable entity files, not 1319: `originals` 947 / `companies` 216 / `people` 140 / `domains` 3 / `ideas` 2 / `concepts` 1 / `meetings` **0**. The higher counts were counting the legacy harness's own scaffolding — 10 `README.md` / `INDEX.md` / `_template.md` files that live inside the entity directories and are not entities. `meetings/` holds a README and an empty `inbox/`, so the `meeting` kind imports nothing; `inbox/` and `archive/` are empty. So the `legacy_kind` remap is **5 files** (3 domains + 2 ideas), not 6.

`ENTITY_KINDS` stays frozen at 6 (`runtime/entity-format.ts:39-46`). `domains`/`ideas` map to `concept` and the source directory is preserved as `legacy_kind`.

**The thing the audit missed entirely: the legacy harness pages already carry their own `## Timeline`.** 1160 of the 1309 files use the same gbrain compiled-truth + `---` + `## Timeline` shape Neutron does, holding 2331 rows. Handing such a body to `writeEntity` as `compiledTruth` would embed the exact sequence `extractCompiledTruth` stops at (`runtime/entity-format.ts:382-389`) — so every LATER writer that rebuilds a page from `extractCompiledTruth(existing)` (the scribe, the reflect pass) would silently drop everything from that point down, on 1160 of 1309 pages. A data-loss bomb planted across the whole import, invisible on the day it lands.

So the import splits the page the way the codec will read it back: rows become real Neutron `TimelineEntry` rows (full-precision ts taken from the row's own `<!-- … ts:<iso> … -->` when present), folded into ONE atomic write via `timelineAppend`'s array form (`runtime/entity-writer.ts:100-107`). **615 of those pages keep content BELOW their rows — overwhelmingly the owner's later `## Verbatim` blocks with their `EXACT-PHRASE RULE` markers** — and a naive "split, keep the rows, discard the rest" would have thrown 618 lines of his own words away. The trailing block is re-joined to the head verbatim; a survey confirmed rows and trailing content never interleave (545 rows-only, 615 rows-then-content, 0 interleaved).

**Collision strategy: quarantine the whole group, never elect a winner.** `entitySlugify` (`runtime/entity-slug.ts:33-39`) is narrower than the legacy harness's filenames, and `writeEntity` merges timelines on a same-slug write (`runtime/entity-writer.ts:448-449`) — so two different files landing on one slug fuses two distinct entities into one page, unrecoverable in place. The full plan is computed before any byte is written; a colliding destination excludes **every** member (picking one silently decides which of the owner's pages is canonical), reports all source paths, and the run exits non-zero. The rest of the corpus still imports — aborting 1309 files over 2 would be a worse trade than a loud partial with an exact repair list. Second, independent line of defence on disk: a destination that already exists is written only when its `legacy_source` frontmatter names THIS source file (`converging`); a page written by a different source (`foreign-import`) or by no importer at all (`occupied`, e.g. one the scribe authored) is refused. That is what distinguishes "re-import of the same file", where the timeline merge is correct, from "two different files", where it is catastrophic. Measured on the live tree: **0 collisions today**.

**Byte fidelity is a mechanism, not an intention.** The one transform `writeEntity` applies to `compiledTruth` is `ensureTrailingNewline(compiledTruth.trimEnd())` (`runtime/entity-format.ts:122`); the writer's own contract says the caller supplies the body and "the writer never edits it" (`runtime/entity-writer.ts:96-99`). The importer pre-applies exactly that expression so the body handed over is a fixed point of it, records `legacy_body_sha256`, and **verifies by reading the page back off disk** and re-hashing through the codec's own `extractCompiledTruth`. A second check re-reads through `extractTimeline` and asserts every converted row landed. `legacy_source_sha256` fingerprints the entire original file, `legacy_body_tail_sha256` the re-joined block, `legacy_body_raw_sha256` the pre-normalisation body for the 147 files with trailing whitespace — so the single lossy transform is itself on the record.

Verified end to end against the real tree into a temp data dir (read-only on `~/legacy`): 1309 written, 0 fidelity failures, 0 collisions; re-run wrote 0 and converged 1309 byte-identically. An audit written independently of the importer confirms **0 source content lines missing** from the 1309 written pages.

**A mutation SURVIVED and it was the important one.** Neutering `verifyBodyFidelity` to always pass killed nothing — because the tests proved the SPLIT (so no realistic page reaches the verifier in a failing state) and left the safety net itself unasserted. Fixed with three tests that make it fire: a page carrying a SECOND embedded separator that survives the split, plus direct tests that tamper with a written page and pass a row that was never written. Six mutations now all die: collision detection removed (3 fail), per-line body re-trim (1), body verification neutered (2), trailing block dropped (2), timeline rows dropped (3), timeline verification neutered (1). 29 pass / 0 fail, `open/legacy-import/entities/entities-import.test.ts`, all fixtures synthetic and in a temp dir.
## 2026-07-28 — ISSUES #367: an instance's ROOT URL 404'd, because the gate never routed `/` to the handler that could serve it

Branch `fix/367-root-url-404`. Typing your own instance URL returned "Not Found"; only `/chat` worked. Verified live before touching anything — a bare `GET /` returned 404 both through the reverse proxy (`https://owner.example.com/`) and directly against the instance's own port, so it was current code rather than a stale deploy.

**The handler was never missing.** `openFetch`'s `/` branch — valid cookie → `302 /chat`, otherwise cold-start — has been sitting at `owner-gate.ts:380` the whole time, correct and fully covered by tests. The gate's `invokesOpenFetch` predicate simply never matched bare `/`: `isLandingRoute('/', 'GET', false)` is deliberately false (the landing page is invite-gated) and no other predicate matches the root, so the request fell through to `next()` and the default handler 404'd. The fix adds `isBareRoot` to that predicate.

**The original issue blamed the wrong file** (`landing/server.ts:921-925`). Fixing what it described would not have fixed the bug — a reminder that a tracker entry's stated root cause is a lead, not evidence.

**Why this survived so long, and the test change that matters more than the fix.** Every test in `open-owner-gate.test.ts` called `openFetch` DIRECTLY; `makeGate` did not even return the gate. So the suite exercised the handler and never the predicate that decides whether to call it — the "exists ≠ wired" shape, one layer up from where it is usually caught. `makeGate` now returns `gate`, and the new assertions go through `gate.apply`, which is the only place this class of bug is visible.

Mutation-verified: removing `isBareRoot` fails 2 of the 5 new tests. The other three are the must-not-regress cases — `/?invite=` still routes, a non-GET `/` still falls through, and `/api/app/*` still reaches the app surface (a widened gate would have broken every API call on the instance).

**A characterization test had locked the bug in.** `gateway/http/__tests__/auth-gate-seam-both-modes.test.ts` asserted `bare GET / → default handler, status 404` as an invariant. It was never a statement that 404 was right: the C5b suite exists to prove a seam refactor reproduced `main` EXACTLY, so it pinned whatever `main` did — and `main` 404'd. That test now asserts the corrected target (fresh visitor → cold-start `302 /chat?start=` + owner cookie; valid cookie → `302 /chat`; the default handler is never reached), with the same precision as before, and its comment says plainly that it previously encoded the defect.

Gates: 42 pass / 0 fail across `open/__tests__/open-owner-gate.test.ts` + `gateway/http/__tests__/auth-gate-seam-both-modes.test.ts`; the rest runs in CI.
Gates: 21 pass / 0 fail in `open/__tests__/open-owner-gate.test.ts`; the rest runs in CI.
> **CLOSED FOR NEW ENTRIES (2026-07-28).** Write new as-built entries as one file
> per entry under [`docs/as-built/`](as-built/README.md) instead.
>
> Every PR used to prepend here, at the same offset, so two open PRs conflicted by
> construction rather than by subject — five rebases in one evening across four
> unrelated PRs, every resolution being the same mechanical "keep both". That toll
> scales with concurrency, and the M2 migration fans out across independent lanes
> on purpose. One file per entry makes the conflict impossible instead of easy.
>
> This file stays exactly as it is and remains the place to read history through
> 2026-07-28. Nothing is migrated out of it.
## 2026-07-28 — `neutron import-legacy`: Lane A of the the legacy harness cutover (PROJECTS)

Branch `feat/legacy-projects-importer`. `neutron import-legacy [--dry-run] [--legacy-home <path>]` — a new `bin/neutron` subcommand execing `open/import-legacy-cli.ts` via bun, the same bootstrap shape as `doctor`/diagnostics (thin loader arms the process safety net, then dynamically imports the impl).

Lane A lands first because every other lane (documents, entities, tasks, memory, history) foreign-keys to `projects.id`.

**No hand-written SQL, by construction.** `migrations/table-ownership.json` allows exactly three writer files for `projects`, and `migrations/__tests__/table-ownership-conformance.test.ts` fs-walks the repo asserting set equality both directions — a migration script inlining `INSERT INTO projects` fails CI on arrival. The importer composes the sanctioned writers instead: `ensureProjectRow` (row + cli wow-shell `topics` binding, one transaction) → `SqliteProjectSettingsStore.setContent` (converge description/persona) → `materializeProjectScaffold` with `projectDocComposer: null` (deterministic templates, so no LLM runs during a migration).

**`seedDefaults` was in the design and was deliberately dropped.** It inserts strictly at `id = seed.id`, bypassing `resolveBindTarget` (`gateway/wiring/project-create.ts:82-99`) — on a non-fresh `NEUTRON_HOME` where a live row's NAME slugifies to the same id under a different id, it mints exactly the duplicate row `ensureProjectRow` exists to prevent. Run after `ensureProjectRow` it is a guaranteed no-op anyway. The only column it sets that `ensureProjectRow` omits is `agent_engagement_mode`, which carries `NOT NULL DEFAULT 'all_messages'` (migration 0088), so the row is well-formed without it.

**The parser is tolerant, not schema-strict, because the real tree is messier than the template.** Measured across every live project dir: there is NO `name:` key in ANY STATUS.md (so display names are derived from the slug via the rail's own `humaniseProjectId` plus a 5-entry override table — `ab`→AB, `ab-website`→AB Website, `xyz`→XYZ, `zenith`→ZENITH, `orion-spv`→Orion SPV); 2 dirs have no YAML frontmatter at all; `ab` uses a different schema entirely (`project`/`status`/`updated`); `globex` and `northwind` carry inline `#` comments after values, and `northwind`'s `one_liner` only reads as empty AFTER comment-stripping. Comment-stripping follows the YAML rule — a `#` inside a quoted value is data, and a `#` with no preceding whitespace is not a comment. Every field is optional and every degradation is NAMED rather than filled in.

**Empty sources do not erase.** A project whose `one_liner` is absent/empty keeps whatever description the row already carries, rather than being nulled (`setContent` maps `''` → SQL NULL, so the patch simply omits fields we don't have).

`--dry-run` opens the DB with `readonly: true, create: false`, so "writes nothing" is enforced by the connection rather than by discipline. It reports the 25-row table, the degraded sources by name, collisions against the target DB (recommending a fresh `NEUTRON_HOME`), the slug-identity assertion, and the 23 `Archive/` dirs (19 projects + 4 vault-infrastructure) as an explicit open decision.

Slug identity is asserted, not assumed: all 25 dir names are currently slug-stable, but a non-identity slug is a HARD STOP (exit 2) on both paths, because a silently renamed id orphans every FK the later lanes hang off.

**Both required mutations were killed.** Disabling the slug-identity assertion failed 2 tests (scan-level and CLI hard-stop); removing the `setContent` call failed 5 — including, unexpectedly, the FIRST-run test, which proved `setContent` is load-bearing on the create path too, not just on re-runs: `ensureProjectRow` leaves `persona` NULL by design and passes `description` through `synthesizeProjectContext`'s clamp/ensure-sentence, so without the converge step no project ever receives its verbatim `PROMPT.md` persona.

Verified end-to-end beyond unit tests: a dry-run against the real vault (25/25 CREATE, 8 degraded named, 0 collisions, 0 assertion failures, `NEUTRON_HOME` untouched), and a real apply + re-run into a throwaway home showing content converging on changed sources with no duplicate rows or topics and a hand-edited README preserved.

35 pass / 0 fail across `open/__tests__/legacy-import-parser.test.ts` + `open/__tests__/legacy-import.test.ts`; table-ownership conformance still 9/0.

`humaniseProjectId` in `gateway/http/app-projects-surface.ts` gained an `export` solely so the importer's leaf-local copy can be drift-guarded against it, mirroring the existing `slugifyProjectId` / `defaultProjectIdSlugifier` arrangement.

## 2026-07-28 — `projects.persona` finally has a WRITER (M2 Lane A prerequisite)

Branch `feat/project-content-writer`. `SqliteProjectSettingsStore.setContent(slug, id, {description?, persona?})`.

`projects.persona` was READ and fully WIRED — resolved at `open/composer.ts:1332`, threaded into the live turn at `:3431` → `gateway/wiring/build-live-agent-turn.ts:1936` — but **nothing could write it after insert**. `update()` accepts only privacy/engagement/name/emoji (`sqlite-store.ts:168-176`) and `upsertSeed` is INSERT-only, so the value a row was born with was the value it kept forever. A stale comment in `project-persona-resolver.ts:5-7` claims persona is "written by the settings drawer + onboarding"; nothing writes it.

That made the the legacy harness importer ONE-SHOT: a project's `one_liner` and `PROMPT.md` persona had to be correct on the first run or be unfixable without hand-editing SQLite. A dry-run → inspect → real-run flow needs the importer to CONVERGE on its source, which is the property the tests pin.

Deliberately NOT on the `ProjectSettingsStore` interface: no HTTP route writes these fields, so putting it there would advertise a surface capability that does not exist and force the in-memory seam to implement a method nothing exercises. Stays inside the CI-enforced writer allowlist (`migrations/table-ownership.json`).

**A mutation SURVIVED, and fixing the test found a real defect in the method's own design.** Dropping the `readRow(...) === null` early return caused ZERO failures at first — an `UPDATE` cannot create a row, so "creates nothing" held either way. But the UPDATE's `WHERE id = ?` carries **no `deleted_at` filter**, so without that early return the write LANDS on a soft-deleted row and only the subsequent (filtered) `readRow` makes the method report null. The caller sees "no such project" while a deleted project's persona has silently changed. The test now reads the raw column unfiltered and asserts it is untouched; the mutation is killed.

Two smaller mutations also verified: an empty string must write SQL NULL (or a never-set persona and one explicitly set to `""` read back differently), and an empty patch must not stamp `updated_at` (a no-op write would float a project up the owner's rail during an import that changed nothing).

8 pass / 0 fail, `gateway/projects/__tests__/sqlite-store-set-content.test.ts`.
## 2026-07-28 — the scribe captures the owner's reflective passages VERBATIM again (M2 cutover blocker)

Branch `feat/scribe-verbatim-originals`. Found while auditing what M2 actually requires, not from a bug report — which is why it is worth recording carefully: it would have degraded the owner's data silently, starting the day he cut over.

In the legacy harness the scribe appended his reflective passages **verbatim and unparaphrased** to `entities/originals/` — his largest entity class, **949 pages** of his own words. Neutron has the `original` kind and writes it, but as a **one-line LLM-synthesized fact** (`scribe/reflect/reserved-kinds.ts:48,55`), and `ScribeExtraction` had no passage field at all. The 949 existing pages migrate faithfully; it was the ONGOING capture that was broken. Post-cutover the corpus would have stopped growing and started accreting summaries.

`ScribeExtraction` now carries `originals`, and the prompt asks for copied passages — but the prompt is not the mechanism, because a model told "copy exactly" still paraphrases sometimes, and a paraphrase stored as the owner's own words is worse than storing nothing.

**The guard is the actual fix.** Each passage must be a contiguous substring of the source turn after a deliberately NARROW normalisation — whitespace runs, zero-width chars, curly→straight quotes, unicode dashes, ellipsis. Case, punctuation and word order are NOT normalised: normalising them would let a real paraphrase through. That single substring property kills paraphrase, reordering and stitched-fragments at once. It fails CLOSED — with no source turn available, everything is dropped as unverifiable, so there is no path that yields an unverified original.

Better than verification: `normalizeWithMap` keeps a per-character offset map back to the source, so a keeper's passage is **replaced by the exact source slice** before storage. Byte-identity is by construction rather than by the model behaving — a smart-quoted "copy" is accepted and the owner's straight-quote bytes are what land on disk.

Minimum 40 normalised chars, because below that a substring match stops being evidence and becomes coincidence ("I think that's right." appears verbatim inside a message paraphrased entirely elsewhere). It sits under the existing 80-char whole-turn floor (`scribe/scribe-budget.ts:80`) so it never binds. Drops are reported, never swallowed.

Writes append rather than replace (originals accrete), raw with no blockquote or indent — any per-line prefix would mean the stored bytes are not the owner's.

**Wiring: no new composer thread was needed, and that is stated rather than claimed as work.** The capability rides the existing live path — `open/wiring/app-ws.ts:902` → `memory.ts:317` → `createScribe` → `runExtraction` → `writeExtractionToGBrain`. So it is proven end-to-end instead: a test boots the real Open composition over a live `Bun.serve`, opens `/ws/app/chat`, sends one reflective turn, and asserts a real `entities/originals/<slug>.md` appears on disk with the owner's bytes in it and the model's curly apostrophes absent.

Mutation-verified both directions: removing the guard fails 6 tests; removing the write call fails 3 (including the prod-boot wiring test). Neither survived. 179 pass / 0 fail across `scribe/__tests__` + the wiring tests.

## 2026-07-28 — ISSUES #412: reading a project no longer CREATES one

Branch `fix/412-get-must-not-create-projects`. `SqliteProjectSettingsStore.get()` persisted a default row for any unknown project_id, and `list()` reads that same table — so `GET /api/app/projects/<any id>/settings` was, in effect, a project-creation endpoint.

It fired in production on 2026-07-28. One tap on a mobile rail tile navigated to `/projects/general`, the shell fetched settings for that id, and a real empty project named "General" appeared in the owner's instance, showing up in the web rail as a duplicate beside the synthetic General scope.

**The fix.** `get()` still returns the canonical `buildDefaultSettings` doc for an unknown id — the settings drawer renders exactly as before — it just no longer writes it. That is provably identical to the old persist-then-reread result: `buildDefaultSettings` sets `emoji: defaultProjectEmoji(name)` and `rowToSettings` resolved a NULL emoji column through `resolveProjectEmoji(null, name)`, the same call (`contracts/default-emoji.ts:237`). `update()` materialises the row before its `UPDATE`, since otherwise the statement would match zero rows and a PATCH on a new id would silently vanish. A PATCH that changes nothing is treated as a read and creates nothing, so the hole cannot reopen through a different verb. `InMemoryProjectSettingsStore` got the identical treatment — it is the seam most surface tests run against, and a divergence there lets a green test describe behaviour production does not have.

**The tracker's stated premise was wrong, and checking it is what made the fix small.** ISSUES #412 guessed the auto-seed existed so a freshly-onboarded project would have a settings row on first open, and warned to audit the other `get()` callers first. There is exactly ONE production caller: `handleGet` at `gateway/http/app-projects-surface.ts:889`, a direct pass-through from the settings route. Onboarding does not depend on it — real projects are written by the wow-moment, and boot uses `seedDefaults`. So no `ensure`/`create` API split was needed; the fix collapsed to "stop writing in `get`".

**Mutation-tested in both directions.** Restoring the original upsert in both stores fails 5 of the 7 new tests in `gateway/__tests__/projects-read-does-not-create.test.ts`, including the HTTP-level one. Removing the new materialise-on-write fails "a real PATCH DOES materialise the project". A test that fails only one way would not have shown the fix is the right size.

Three existing tests encoded the old contract and were updated rather than deleted — one was literally named *"returns every seeded project after their settings have been read"*. They now create via a write using the same `buildDefaultSettings` name, so every downstream assertion about names and emoji is unchanged; only the verb that creates the row is.

Gates: root tsc 0, lint 0, leak 0, depcruise 0. Suites run locally: the four projects suites, the unified surface suite, the app project-tabs suites, route-matrix, launcher-seed — 7 + 31 + 84 + 7 pass, 0 fail. The FULL suite runs in CI (it is not run on the owner's machine).

**Does NOT clean up the existing row.** The stray `general` project still sits in the owner's tenant DB; deleting it is his call. This stops the next one being created.
## 2026-07-28 — CI parallelised: independent gate jobs + a 4-way sharded suite

The owner asked whether we could lean on CI instead of his laptop. Open's CI was ONE job with seven sequential steps on a 2-core/7GB runner, so a 2-minute typecheck error surfaced only after a 12-minute test run — which is why running gates locally had become the fast-feedback path by default.

**Now:** `typecheck`, `lint`, `purity` and `layering` are independent jobs that report in 1-3 minutes, and the suite runs as a 4-leg `shard` matrix.

**`NEUTRON_TEST_SHARD=<i>/<n>` in `scripts/run-tests.sh`** — cross-runner sharding, distinct from the existing `NEUTRON_TEST_JOBS` (intra-machine). Placed AFTER discovery, the bun cross-check and the lane split, so a shard is a slice of what gets EXECUTED, never of what gets VERIFIED — every shard still validates the full discovered set against bun's own walk. Round-robin over both lanes independently, so the serial PGLite lane is spread rather than dumped on one runner.

**The coverage guarantee changed shape, and that is the risk worth naming.** Unsharded, the runner proved coverage alone: discovered N, executed N. Sharded, no single run can claim that. The whole-suite guarantee now rests on three legs — identical deterministic discovery on every shard, a partition with no gaps or overlap, and every shard being required to report. Each has a test: the partition in `scripts/__tests__/run-tests-shard.test.ts` (unions the slices and asserts they equal the full set exactly), the reporting in the CI aggregator guards.

**The `test` job is now an AGGREGATOR and must keep that exact name.** `test` and `CodeQL` are required contexts on `main` with a strict policy; matrix-ifying `test` would rename the context to `test (1)` etc., it would never report, and every PR would block forever with nothing failing to point at. So the legs are named `shard` and `test` needs them all, with `if: always()` — without it a failing gate SKIPS the aggregator, and a skipped required check does not block a PR.

Shard runners restore `CONCURRENCY=4` / `CHUNK=100`: the #193 OOM mitigation dropped them because ~1000 files ran on one 7GB box, and each runner now carries a quarter of that.

**Mutation-verified, and one guard was found weak by it:** widening the matrix to 6 while leaving the spec at `/4` fails; dropping `if: always()` fails; dropping a gate from `needs` fails; flipping `fail-fast` fails — but only after tightening, because the first version matched the string anywhere in the file including the COMMENT explaining the setting, so the mutation initially survived.

Gates: 13 pass (shard partition) + 14 pass (workflow guards). Open is a public repo, so these extra runners cost nothing.

**Follow-up, same day — the first CI run on this PR failed and taught something worth keeping.** The parallel structure worked immediately (layering 31s, purity 33s, lint 44s, shards ~2m50s, and the aggregator correctly failed CLOSED), but two jobs were red:

1. `typecheck` — an unchecked `undefined` in one of the new workflow guards. Caught in 2m37s by CI rather than after a 12-minute test run, which is the whole point of the split.
2. `shard 4/4` ONLY — three of `run-tests-selftest.test.ts`'s fixtures failed. **Root cause: the self-tests spawn child `run-tests.sh` runs with `...process.env`, so they INHERITED `NEUTRON_TEST_SHARD=4/4` from the CI runner and their 5-file fixture was sliced to 1 file.** A test that fails on exactly one shard reads like flakiness; it was configuration inheritance.

Fixed by making those fixtures hermetic against the WHOLE `NEUTRON_TEST_*` prefix rather than the single variable that bit — the next knob CI sets would land the same way. Mutation-verified: reverting to `...process.env` reproduces 4 failures under `NEUTRON_TEST_SHARD=4/4`, and the fixed version passes 11/11 both with and without the variable set.


## 2026-07-28 — ISSUES #316: `install.sh` refuses to update a checkout pointing at the wrong repo

Branch `fix/316-install-origin-check`. A re-run over an existing `~/neutron/core` used to `git pull --ff-only` against whatever origin that checkout happened to carry. The owner hit it on 2026-06-20: an earlier test install had cloned from a LOCAL path, so the canonical `curl https://neutronagent.ai/install.sh | sh` "succeeded" while pulling local code and never touching the public repo. Nothing in the output said so — the failure is silent by construction, which is what makes it worth a guard rather than a doc note.

`assert_clone_origin` now runs BEFORE the pull and aborts on a mismatch, naming both URLs and offering three ways out (remove the dir, re-point it yourself, or `NEUTRON_REPO=<that origin>` to install from it deliberately).

**It aborts rather than re-pointing, deliberately.** Repairing in place would mean `remote set-url` + `fetch` + `reset --hard`, which silently discards whatever the user had in that directory. An install script must not destroy a working tree to fix its own assumption. The `NEUTRON_REPO` escape hatch means anyone who genuinely wants a different source can say so, and then the origins match — asserted in the tests, so the advice the error prints is known to work.

**Half the work is false-positive prevention.** `normalise_git_url` folds scheme, `.git` suffix, trailing slash, `git@host:path`, `ssh://git@host/path` and host case, so five equivalent spellings of the same repo all pass. A guard that blocked `git@github.com:rjunee/neutron.git` would break people who did nothing wrong, which is worse than the bug it fixes.

**Mutation-tested both directions.** Deleting the wiring call fails the "actually WIRED" test (the seam drives the function directly, so every other test stays green — that is precisely the built-but-never-wired shape this repo keeps hitting, and why the wiring has its own assertion). Replacing the normalised comparison with a naive string compare fails 5 tests, 3 of them equivalence cases.

Gates: root tsc 0, lint 0, leak 0, depcruise 0, `shellcheck -S error` clean. `tests/integration/install-clone-origin.test.ts` 11 pass; all five install suites together 45 pass / 0 fail.

## 2026-07-28 — ISSUES #364: the WS round-trip test had TWO deadlines and the smaller one was invisible

Branch `test/364-ws-budget-final`. `app-ws-surface.test.ts` failed once in a full-suite run and passed 3/3 in isolation — a real flake, not a broken assertion.

`waitFor`'s private cap was **1500ms**, which made that helper the binding constraint on every WS assertion in the file. Two competing deadlines, where the smaller is a constant buried in a helper, is the shape that makes a deterministic assertion look flaky. The cap is now non-binding (30s) and the ONE test that flaked carries an EXPLICIT `20_000` budget, so the governing deadline is visible at the test rather than inherited.

**Measured, and the honest result is that I could NOT reproduce it:** 0 failures across 5 runs under 10x CPU saturation. The issue reports the failure from a FULL-SUITE run, which spawns many subprocesses, so the trigger is subprocess/FD contention rather than raw CPU. **There is therefore no before/after for this change** — saying otherwise would be the overclaim that reddened `main` twice earlier today.

What IS measured: with the private cap removed, a never-arriving event failed via bun's per-test default at **5007ms** — only ~3x the old cap, so it would have remained the binding constraint under load. That measurement is precisely why the explicit 20s budget exists. With it, the same mutation fails at **exactly 20s**, confirming a genuine break still surfaces rather than hanging.

**Why widening is right HERE and was wrong for #408:** these assertions are deterministic (`session_ready` either arrives or does not), so the allowance was the only thing wrong. #408's anchor-race assertion is nondeterministic by construction — it compares `Date.now()` against a filesystem timestamp — and no timeout could ever fix it, which is why that one is skipped pending a production seam.

Gates: root tsc 0, lint 0, leak gate silent, 22 pass / 0 fail.

## 2026-07-28 — ISSUES #103: a gateway restart during the fire minute no longer re-posts the daily triage

Branch `fix/103-restart-idempotent-triage`. The per-day guard is the in-memory `lastFired` Map, which a restart wipes. `start()` then runs its immediate tick — deliberately, so a boot at 08:00:10 does not miss the day's only window — and a restart DURING the fire minute therefore re-posted the day's triage to the owner. Scribe fan-out is watermark-protected, so nothing corrupts; the duplicate CHAT POST was the entire defect.

`triage_cache` already persists `fired_at` per project, so the restart-proof answer is one query: `listRecentTriage(1)`, compared by local day. The immediate tick now skips when a fire already landed today.

**Scoped to the IMMEDIATE tick, deliberately.** `upsertTriage` is also written by the manual `/triage` chat command (`chat-commands.ts:300`) and by the tools surface (`tools.ts:332`), and the row carries no source column — so a durable check cannot distinguish a scheduled fire from a manual one. Applying it to the RECURRING tick would let a manual triage silently suppress the day's scheduled post, a behaviour change well beyond this bug. Narrowing it to the restart window fixes exactly what is broken.

The durable read is also gated on `isFireTime` first, so an off-hour restart takes the path it always did, and a store-read failure returns false — firing twice is far less bad than never firing at all.

**The tracker entry's path was stale** (`cores/free/email-managed/src/` → `cores/free/email/src/`), but unlike #363 and #372 its FIX DIRECTION held up against the code exactly as written.

Mutation-verified: restoring the original immediate tick fails the restart test; making the durable check ignore the local day (suppressing forever) fails the next-day test. Gates: root tsc 0, lint 0, leak gate silent, 170 email-core tests pass.

## 2026-07-28 — ISSUES #406: give the I/O-bound GATE tests a budget proportional to their work

Branch `test/406-io-bound-gate-timeouts`. Three tests inherit bun's 5s default while walking the repo tree or spawning subprocesses, and report `(fail)` at ~5000ms — a TIMEOUT, not an assertion failure — whenever the machine is loaded.

**Measured, not assumed** — the lesson from the anchor-race episode applied deliberately, since I broke `main` twice there by rewriting a test without first measuring its baseline:

| | failures |
|---|---|
| BEFORE, 5 runs under 10× CPU saturation | **4** |
| AFTER, 4 runs under the same 10× saturation | **0** |

(The fifth "after" run was cut off by my own command timeout, so this is reported as 4 runs rather than 5. 4-of-5 failing versus 0-of-4 is decisive enough to act on; inflating it to 5 would be exactly the overclaim that caused the earlier mess.)

**Why raising a timeout is the right fix here and was NOT the right fix for the anchor race.** In the anchor race the ASSERTION itself was nondeterministic — it compared `Date.now()` against a filesystem timestamp, so no timeout could make it reliable and that test is now skipped under #408. These three are the opposite: the assertions are fully deterministic and only the wall-clock allowance was wrong. A gate that walks every `tsconfig.json` on disk, or boots a real composition, is not a unit test and 5s was never the right budget for it.

These have never failed in CI, whose runner is not competing with an emulator and two builds. The cost being removed is local: a false-positive generator trains you to skim past red, which is the habit the green-CI rule exists to break — and it did briefly bury two genuine anchor-walker failures in noise.
## 2026-07-28 — ISSUES #411: the General sentinel must be URL-PATH-safe, not just validator-illegal

Branch `fix/411-general-sentinel-url-safe`. Fixes a regression **I shipped in #460**, caught by driving the app on a device.

**What #460 got right and what it got wrong.** #410 was real: `'general'` is a legal project id, the owner's instance has one, and using it as the scope sentinel made that project unreachable. Mirroring the web client was the right instinct. Copying web's VALUE was not.

Web's `GENERAL_CONV_ID` is `#general`, and on web that string is only ever a MAP KEY — it keys the conversation runtime host and the frozen-vm cache slot, and never enters a URL. **Mobile puts the rail id straight into the route `/projects/[id]/chat`, so its constraint set is strictly larger.** `#general` needs percent-encoding (`%23`) and `#` is the URL fragment delimiter.

**Observed on-device, deterministically:** with #460 installed, tapping the General scope tile landed on the PROJECTS LIST instead of the chat — reproduced twice from different starting projects. `/projects` is exactly where `/projects/#general` resolves if the `#` is treated as a fragment.

**The fix.** `'~general'` is rejected by the same gateway validator (`[A-Za-z0-9_.-]+`) so it keeps #410's collision-proofing, and `encodeURIComponent` leaves `~` ALONE, so the route is literally `/projects/~general/chat` with no encoding at all. Both properties confirmed by executing them rather than reasoning about them.

**Why the unit tests missed it:** nothing in them exercised the ROUTER. They asserted the sentinel was validator-illegal and that topics resolved correctly — both true of `#general`. The new tests assert the missing property directly: the sentinel must survive `encodeURIComponent` unchanged, and the route it builds must round-trip through URL parsing.

Mutation-verified against all three sentinels now known to be wrong: `'#general'` fails 2, `'general'` fails 3, `'__general__'` fails 2. Gates: app tsc 0, root tsc 0, lint 0, leak gate silent, 1141 app tests pass.

**NOT yet verified on-device** — a build is required, and #460 is exactly why that matters: it passed every gate and still broke the one thing it was meant to fix.

## 2026-07-28 — ISSUES #404: the duplicate "Work" tab was a key-vs-route-leaf collision

Branch `fix/404-work-tab-key-collision`. The owner's device showed `Chat | Work | Work | Documents`. Diagnosed from the LIVE payload rather than by reading code.

`GET /api/app/projects/alpha/tabs` on the running instance returns exactly FOUR tabs with unique keys — `chat`, `work_board`, `documents`, `settings`. So the duplicate was entirely client-side.

**The mismatch.** `tabs/registry.ts:78` defines the tab with `key: 'work_board'` and `mount.target: 'workboard'` — the key and the route leaf are DIFFERENT strings, deliberately (the registry comment says as much: the visible label became "Work" while the internal identifier stayed `work_board`). Mobile collapsed both into one constant, `WORK_TAB_KEY = 'workboard'` — the LEAF value used as a KEY. So `ensureWorkTab` compared a registry key against a route leaf, never matched the tab the gateway had already sent, and appended a second one.

**A second defect fell out of the same mismatch.** `tabBadges` is built with `WORK_TAB_KEY` and `ProjectTabBar` looks badges up by `tab.key`, so the live-run badge was attaching to the injected phantom rather than to the real tab. Nobody would have noticed a badge that silently never appears.

The constant is now split: `WORK_TAB_KEY = 'work_board'` (registry identity, what badges key on, what the gateway sends) and `WORK_TAB_ROUTE_LEAF = 'workboard'` (the `workboard.tsx` file route, mirroring the registry's `mount.target`). Web already had this right — `landing/chat-react/tabs-client.ts:110` uses `work_board`.

Mutation-verified both halves: restoring the conflated key fails 3 tests; building the route from the key instead of the leaf fails 3. The new test uses the VERBATIM live payload, so it fails the moment the client stops recognising what the server actually sends. Gates: app tsc 0, root tsc 0, lint 0, depcruise 0, leak gate silent, 1134 app tests pass.
## 2026-07-28 — ISSUES #410: the General sentinel is collision-proof, matching web

Branch `fix/410-general-sentinel-collision`. `GENERAL_PROJECT_ID` moves from the bare string `'general'` to **`'#general'`**, mirroring the web client exactly.

**The defect.** `'general'` is a perfectly legal project id. The owner's instance has one: `GET /api/app/projects` returns `id: 'general', name: 'General', emoji: '🟢'` alongside alpha, theta, iota and six others. Since #453 collapsed that rail id to the no-project scope, **that real project became unreachable from mobile** — its transcript at `app:<user>:general` had no way to be selected, and one rail tile stood for two different conversations.

Measured on the live instance before fixing:
```
project_id=general            -> app:owner:general    seq=0     0 messages
NO project_id (the scope)     -> app:owner            seq=18   15 agent + 3 user
project_id=alpha (control) -> app:owner:alpha   seq=14    8 agent + 6 user
```

**The fix was settled by precedent, not by picking from options.** #410 was filed with three candidate approaches; reading the web client answered it. Web hit this class of bug first, tried `__general__`, and discovered that is ALSO a validator-legal project id — Codex found a cache-slot leak between the two scopes — then settled on `'#general'`. The gateway's `sanitizeProjectId` accepts only `[A-Za-z0-9_.-]+`, so the leading `#` can never be a real project id: collision-proof by construction rather than by convention. **Confirmed by executing the validator, not by reading it:** `'general'` → legal, `'__general__'` → legal, `'#general'` → rejected.

So option (1) in the issue as filed — "use `__general__` or a reserved prefix" — was specifically the answer that had already been tried and failed. The real mistake was mobile inventing a second model instead of mirroring web, which the original dispatch brief had explicitly asked for.

The router percent-encodes the sentinel, so the path is `/projects/%23general/chat`; `projectIdFromPathname` decodes it, and the tests assert BOTH the encoded and decoded forms since `usePathname()` does not contractually guarantee either.

Mutation-verified against both known-bad sentinels: `'general'` fails 3 tests, `'__general__'` fails 2. Gates: app tsc 0, root tsc 0, lint 0, leak gate silent, 1136 app tests pass.

**Not verified on-device yet** — the acceptance test is that on this instance the General scope's 18 messages and the real "General" project's own (empty) transcript are independently reachable and visibly distinct.

## 2026-07-28 — Revert both anchor-race de-flake attempts and SKIP the test (ISSUES #408)

Branch `revert/anchor-race-deflake`. `main` went red twice in one night from my own attempts to de-flake one test, so this restores the pre-#452 file and skips the single nondeterministic case.

**Why neither attempt worked.** The invariant is `writer_mtime > delete_time`, and the materialiser's max-mtime-wins fold treats EQUAL as stale. `delete_time` is `Date.now()` inside `DocStore.deleteDoc`; `writer_mtime` comes from the FILESYSTEM via `fstat`. Nothing available to the test forces an order between those two clocks, so the assertion is a bet on timing in every form:
- **#452** (flat 50ms sleep → one-way signal) removed a delay that was load-bearing for ORDERING as well as for the window, and for the millisecond gap. Measured 5 failures in 12 runs.
- **#456** (two-way handshake + wait for the clock to strictly advance) fixed ordering and still failed in CI at 9ms, which points at filesystem timestamp resolution rather than at scheduling — a 1ms advance is meaningless if `mtimeMs` is coarser than that on the runner's filesystem. Unproven; recorded as the leading hypothesis, not a conclusion.
- The ORIGINAL 50ms form is flaky too: 2 failures in 5 local runs. So this was never a green test that I broke; it was a bet that CI had been winning.

**Why skip rather than leave flaky.** A test that reddens `main` at random trains people to merge past red — the precise habit the green-CI rule exists to break, and #405 shows how much that habit can hide. A visible, tracked gap is safer than an intermittently-red gate.

**What a real fix needs, recorded in #408 so the guard can be rebuilt rather than lost:** a production seam — an injectable clock in `DocStore` — so both stamps can be FORCED into a known order instead of raced. That is a deliberate change to shipping code and did not belong in an unsupervised test repair at 07:40.

The regression it guarded is real: pre-fix, `delete_time` was sampled at the hook site instead of before the slow `recordCommit()`, so the deleter's event out-stamped a concurrent writer's and the anchor flipped dead while the file still existed. Verified after the skip: 12/12 green locally, 30 pass / 1 skip / 0 fail.
## 2026-07-28 — The project shell's chrome follows the rail selection (found on-device)

Branch `fix/shell-follows-rail-selection`. Third defect in this rail sequence found by driving a real build rather than reading a diff.

**Observed on AVD `neutron-test` against the live instance:** with #453 installed, tapping General correctly swapped the transcript to General's messages — and left the header reading **"PROJECT / Alpha"** with the rail highlight still on Alpha. So the child chat screen saw the new id while the shell did not.

**Cause.** The `[id]` layout read its id from `useLocalSearchParams`, which is STICKY inside a layout: navigating `alpha → general` keeps the layout mounted, so it kept reporting `alpha` while the freshly-rendered child screen correctly saw `general`. The layout now derives the id from `usePathname()` via `projectIdFromPathname()`, keeping the search param only as the fallback for a non-project path. Because the state provider, the header and the rail highlight all read that one value, fixing it in one place fixes the whole chrome.

Mutation-verified, and the mutation earned its keep: dropping the `projects` root guard initially left EVERY assertion green, exposing a real coverage gap — a two-segment path under a different root would have yielded its second segment as a project id. Added `/settings/notifications` and `/cores/dtc-analytics` cases; the mutation now fails. Gates: app tsc 0, root tsc 0, lint 0, leak gate silent, 1039 app tests pass.

**Not yet verified on-device.** The fix is unit-proven and the cause matches the observed split exactly, but I have not watched the header change on a device. Saying so rather than implying otherwise.

## 2026-07-28 — Fix the anchor-race de-flake that turned a flake into a red main (own-goal, recorded)

Branch `fix/anchor-race-two-way-handshake`. **#452 broke `main`.** Owning it plainly: the de-flake replaced a flat 50ms sleep with a one-way signal, and that sleep was load-bearing for TWO things, not one.

1. **Ordering.** The writer's own `commit()` is instant under the stub, so on a fast host the writer could finish its rename + fstat + hook BEFORE the deleter even reached `commit()`. `writerLanded` was then already resolved, the deleter sailed straight through, and the interleaving under test never happened. The 50ms sleep had been slowing the WRITER too, which is what kept the deleter ahead.
2. **A wall-clock gap.** The invariant is `writer_mtime > delete_time`, and the materialiser's max-mtime-wins fold treats EQUAL as stale. With the sleep gone the writer's rename landed in the SAME millisecond as `delete_time`, so the anchor flipped dead. Measured flake rate from this alone: **5 failures in 12 local runs (42%)**.

That 42% is also why #452's own CI passed and the post-merge `main` run failed — pure luck on both sides. A probabilistic test that passes once is not evidence, and I treated it as evidence.

**The fix makes both guarantees explicit and keyed on observable conditions rather than on a guessed interval:** the handshake now runs BOTH ways (the writer waits for the deleter to be inside `commit()`; the deleter waits for the writer to land, so neither can run first), and the writer additionally waits for the wall clock to strictly advance past the instant `delete_time` was sampled — one tick, not 50ms. Both waits are bounded and reject loudly rather than hanging.

Verified: 8/8 green, plus 5/5 green under 10× CPU saturation. Mutation-verified two ways — re-sampling `delete_time` at the hook site (the original regression) still fails; removing the clock-advance reproduces the red at 5/12.
## 2026-07-27 — The owner session cookie's `Secure` flag now FAILS CLOSED

Branch `fix/392-owner-cookie-fail-closed`. Closes ISSUES #392, the hardening follow-up to #303 (which is fixed, deployed and verified — this is not a reopen).

**What it was.** `Secure` was derived from `resolveRequestScheme`, which prefers `X-Forwarded-Proto`. A client-supplied `X-Forwarded-Proto: http` could therefore STRIP `Secure` from the owner's session cookie. Not exploitable on the hosted deployment — Caddy overwrites the client value, verified live 2026-07-25 against the hosted deployment — but Open is self-hosted software and we do not control every proxy placed in front of it.

**What it is now.** `shouldSetSecureCookie` inverts the polarity: `Secure` is the DEFAULT, dropped only for a request that is demonstrably a plain-http loopback dev session. Three conditions, all required: no `x-forwarded-*` header of any kind, a browser-supplied `Host` that is loopback, and a plain-http socket scheme. Keying the proxy check on header PRESENCE rather than value is what closes the original hole — a hostile `X-Forwarded-Proto: http` now forces `Secure` ON.

The loopback exemption has to stay: browsers drop a `Secure` cookie over plain http, so requiring it would lock a self-hoster out of `bun start` on 127.0.0.1. `isLoopbackHost` covers the whole `127.0.0.0/8` block, `localhost`, and `[::1]`, and rejects the lookalikes an attacker would reach for (`127.0.0.1.evil.com`, `localhost.evil.com`).

**Consequence, stated rather than buried:** a self-hoster serving plain http on a NON-loopback address (a LAN IP) now gets a `Secure` cookie the browser refuses to store, and must terminate TLS. That is the intended direction of the trade — an unexpected deployment gets a protected cookie and a visible failure instead of an unprotected cookie and a silent one.

**Two `#303` tests had to change, and the distinction matters.** `an unrecognised X-Forwarded-Proto falls back to the socket scheme` was asserting `.not.toContain('Secure')` — it encoded the exact behaviour #392 removes, so it was PINNING the weakness and its assertion is now inverted with a comment saying why. The other, `direct plain-http self-host (no header) keeps the cookie NON-Secure`, was describing a REQUIREMENT and exposed a real gap: a constructed `Request` (and a client that omits `Host`) carries no `Host` header, so host resolution now falls back to the request URL's own host. That cannot re-open the hole, because a proxied request is already forced Secure by the header-presence check.

Mutation-verified three ways: restoring the header-derived polarity fails 5 tests; keying the proxy check on header VALUE instead of presence fails 2; a naive substring loopback match fails 2. Gates: root tsc 0, lint 0, leak gate silent, 26 owner-gate + cookie-policy tests pass.
## 2026-07-27 — The app is declared NATIVE-ONLY, so an OTA no longer needs `--platform android`

Branch `fix/400-app-native-only`. Closes ISSUES #400. The owner: *"App is native only."*

`eas update` defaults to `--platform all` and failed outright on the web export: `op-sqlite` is a native module and is reachable from the app's web entry (`chat.tsx` → `ChatSyncSurface` → `use-mobile-chat` → `op-sqlite-store`). Nothing web could satisfy that import, so every OTA had to be published `--platform android` — a footgun for anyone who did not already know, and the natural command simply broke.

The web target was never real: nothing consumes the app's web build, and the actual web client is `landing/chat-react`, served by the gateway. Keeping an Expo-web target would have meant a SECOND web client covering the same ground. So the fix is to say what is true — `app.json` now pins `"platforms": ["ios", "android"]` and drops the `web` block.

Verified by running it, not by reasoning: `npx expo export` **with no platform flag** exits 0, and `dist/metadata.json` contains exactly `['android', 'ios']`. Previously the same command failed on the web bundle.

Dead `Platform.OS === 'web'` branches (26 sites across ~10 files) are unreachable now but are NOT removed here — that is a mechanical sweep with its own regression surface, and it belongs in its own reviewable change rather than riding along with a two-line config fix.

## 2026-07-27 — Warm chat sessions: switching projects reuses a live session instead of rebuilding it

Branch `fix/402-warm-session-cache`. Second half of ISSUES #402. The first half stopped the empty state flashing during a switch; this half removes the reason the switch was slow at all.

**What it was doing.** `useMobileChat` constructed a `MobileChatSession` inside an effect keyed on `projectId` and `stop()`-ed it on cleanup. Every switch therefore paid the full cost again: open the sqlite store, open a WebSocket, complete the handshake, send `resume`, wait for the replay. The owner on device: "switching between projects is slow, flickers, briefly shows the no message error, then loads."

**What it does now.** `app/lib/chat-core/session-cache.ts` keys sessions by `topic_id` and reference-counts them. Releasing the last reference does NOT stop the session — it goes idle and stays connected, so returning to a project re-attaches to a live socket with its transcript already resumed. Idle sessions are evicted least-recently-used beyond `MAX_WARM_SESSIONS` (3), which is what keeps this a cache rather than a socket leak: a device that visits twenty projects holds at most three idle sockets.

Because a session now OUTLIVES the view that created it, `MobileChatSession`'s callbacks could no longer be captured once at construction — the second mount would have driven the first mount's dead closures. They became a `subscribe()` listener set; constructor-supplied callbacks register as the first subscriber, so the existing option shape is unchanged and every existing test still passes.

**Two things that would otherwise have been quiet bugs, closed deliberately:**
- **Backgrounding now quiets every cached socket**, not just the visible one. Fanning AppState only to the on-screen session would have left the warm sockets heartbeating in the background — trading switch latency for battery, silently.
- **Sign-out stops every cached session.** A warm socket is authenticated with the identity's bearer and must die with it; leaving one running past sign-out is the same shape as ISSUES #398, state outliving the credential that scoped it.

**What this is NOT.** The optimal design is one multiplexed socket subscribing to many topics, which makes warmth free. That needs a server-side subscription frame — app-ws binds exactly one topic per connection from its query string — so it is a protocol change, not a client change. This is the correct client-only increment, and the multiplexing work is tracked rather than pretended away.

Mutation-verified: making release stop the session fails 3 tests, removing eviction fails 1, and making sign-out skip `stop()` fails 1. Gates: app tsc 0, root tsc 0, lint 0, depcruise 0, leak gate silent, 1030 app tests pass.
## 2026-07-27 — General's rail entry opens General's transcript (found on a running emulator)

Branch `fix/general-rail-scope`. Follow-up to #450, which put General back in the mobile rail. Tapping it opened a permanently empty chat — caught by installing the build on an emulator and driving it, not by reading the diff.

**Why.** `GENERAL_PROJECT_ID` is a sentinel that only *looks* like a project id. It has to: the rail selects by id and the only chat route is `/projects/[id]/chat`. So it travelled through the router and reached `appWsProjectTopicId` unchanged, deriving `app:<user>:general` — a topic that has never existed and never will. General is the NO-PROJECT scope; its topic is `app:<user>`. The rail entry pointed at nothing.

**The fix.** `railIdToScope()` in the pure view module collapses the sentinel to the empty scope, and `useMobileChat` calls it once at the top so topic derivation, the socket URL and the transcript filter cannot disagree. This mirrors the web client's `scope = input.project_id ?? 'general'` in the other direction, and gives the collapse exactly one home.

**Second half: the shell.** `getSettings('general')` 404s, so the project shell rendered "project not found" for the scope holding the largest transcript. General now renders from a synthetic scope identity (name, glyph, no members) — explicitly NOT the ISSUES #393 placeholder pattern: every field is either literally true of General or inert, and the chrome that would misrepresent it stays suppressed. The three project-null early returns collapsed into one gate that narrows properly.

Mutation-verified: letting the sentinel pass through (the original bug) fails 2 tests. Gates: app tsc 0, root tsc 0, lint 0, depcruise 0, leak gate silent, 1026 app tests pass.
## 2026-07-27 — De-flake the anchor-walker delete-vs-write race test

Branch `fix/deflake-anchor-walker-race`. `anchor-walker.test.ts`'s "a writer recreating the doc during the deleter's post-unlink awaits keeps the anchor live" opened its race window with a flat 50ms sleep inside the stubbed `VersionStore.commit()`, betting the concurrent writer would land its rename + fstat + hook inside that window. On the loaded partitioned CI runner it does not, and the test went red for scheduling reasons rather than for the regression it guards — blocking an unrelated PR.

A wall-clock window is a guess about scheduling; an explicit signal is a fact about ordering. The stub now holds the deleter's `commit()` open until the writer's hook has actually fired, so the T4 → T5 → T7 interleaving is guaranteed rather than likely. A bounded 5s reject keeps a genuine break in the sequence loud instead of hanging the suite.

Mutation-verified: re-sampling `delete_time` at the hook site (the original regression) still fails the test — in 12ms rather than 100ms+. Verified green 5/5 under 8x CPU saturation, which is the condition that produced the red.

## 2026-07-27 — Mobile rail UX: General is present, the active entry is tappable, and hydration no longer flashes "no messages"

Branch `fix/401-403-mobile-rail-ux`. Three defects the owner hit on-device in one sitting, all in the project rail. Each was a small piece of logic doing the wrong thing confidently.

**ISSUES #403 — General was missing from the mobile rail.** General is the no-project scope (topic `app:<user>`), not a row in the projects table, so a rail built purely from the projects API can never contain it. The web client already synthesizes the entry; mobile did not, so the scope holding the largest single transcript had no way to be selected. `app/app/projects/[id]/_layout.tsx` now injects General at the head of the rail, mirroring web's semantics.

**ISSUES #401 — the first project could not be opened.** `ProjectRail` guarded its callback with `if (!isActive) onSelect(...)`, so tapping the entry that was already active did nothing. On a cold launch the first project is active-by-default but its chat is not on screen, which made the top rail entry appear dead — the only way in was to tap a different project and come back. The guard is gone (`ProjectRail.tsx:120`); the rail always reports the tap, and the layout routes an already-active id to that project's chat.

**ISSUES #402 (first half) — the empty state rendered before hydration finished.** `ListEmptyComponent` was unconditional, so every switch flashed "no messages yet" over a conversation that was about to load. `use-mobile-chat.ts` now tracks a `hydrated` flag, set when local rows arrive OR the socket reaches `open` (at which point the resume replay has been applied, so a still-empty transcript is genuinely empty). `ChatSyncSurface` shows a hydrating state until then.

`GENERAL_PROJECT_ID` moved from the RN component into the pure `app/lib/project-rail-view.ts` and is re-exported, because a constant living in a component that no unit test can import is precisely how General went missing unnoticed.

**NOT in this change:** keeping project sessions warm in memory. Switching still tears down and rebuilds the session, so it remains slower than it should be. The flicker and the false "no messages" flash are fixed; the warm cache is separate work and is called out here rather than left implied.

Both fixes mutation-verified: restoring the dropped-General behaviour fails 2 tests, restoring the swallowed active-tap fails 1. Gates: app tsc 0, root tsc 0, lint 0, depcruise 0, leak gate silent, 1022 app tests pass.

## 2026-07-27 — App remote diagnostics: JS errors reach the owner's OWN gateway (no USB, no third party)

Branch `feat/app-remote-diagnostics`. The Android app failed on the owner's device three times and nobody could see why: the only diagnosis channel was "plug in a USB cable and run logcat", so each round cost hours of static inference and two of three hypotheses were wrong. The app now reports its own JS errors to the owner's OWN gateway. NO Sentry, NO third party, NO account — Neutron Open is self-hosted, so diagnostics must not require a SaaS. NO FEATURE FLAG: it ships on, as the product, with a single code path.

**WHAT IS COVERED AND WHAT IS NOT — read this before trusting it.** JavaScript errors only: an uncaught JS exception, an unhandled promise rejection, and a React render crash. A **NATIVE crash produces nothing**, because no JS ever runs to catch it. Concretely: the crash that actually blocked the owner this week — an Android provider dying during process start, before the JS bundle loaded — would **NOT** have been captured by this code, and still needs `adb logcat` or an emulator. This closes the JS blind spot; it does not close the native one.

**App side**

- **NEW `app/lib/diagnostic-buffer.ts`** — a capped in-memory ring buffer (`DEFAULT_BUFFER_CAPACITY = 100`), oldest-evicted, no growth path. Pure; no React/RN/Expo imports.
- **NEW `app/lib/diagnostic-redact.ts`** — the redactor. Two mechanisms: an EXACT-value scrub of credentials the process holds (the live bearer, ≥8 chars), plus pattern rules for credentials it does not hold — secret KEY names (`authorization` / `cookie` / `*token*` / `api_key` / …) redacted whatever the value looks like, `bearer <x>` prefixes, three-segment JWTs, a bare `eyJ…` header segment, the `dev:<id>` opaque token, `key=value` shapes inside free text, and a 40-char opaque-run backstop. Bounds depth (4), keys (24), array items (24), string length (2000) and stacks (8000).
- **NEW `app/lib/diagnostic-report.ts`** — `buildClientReport` is the single choke point every report passes through (global handler, error boundary, manual action alike) and re-scrubs every event on the way in. A report carries build metadata (`version`/`build`/`platform`/`os_version`), `session.signed_in` as a bare boolean, and the event window. It deliberately carries NO bearer, NO headers, NO server configuration, and NO user identity — the gateway stamps the authenticated `user_id` itself from the bearer, which is both more trustworthy and not the device's to assert. `describeThrown` normalises non-`Error` throws (`throw 'x'`, `Promise.reject(undefined)`) so the weird cases are not dropped.
- **NEW `app/lib/diagnostic-capture.ts`** — `installGlobalCapture(host, sink)`, with the host globals INJECTED so the real installer is unit-tested with no React Native present. Hooks `ErrorUtils.setGlobalHandler` (always CHAINING to the previous handler, so RN's development redbox still fires), plus `unhandledrejection` and `error` listeners for the web build / hosts that expose them. Every hook is probed, never assumed.
- **NEW `app/lib/diagnostic-queue.ts`** — the persisted queue, the piece that makes a FAILED LAUNCH visible at all. A report is written to durable storage the moment it is created and delivered on the next launch that gets far enough to authenticate. The invariant is **a report is only dropped deliberately**, and four ways of losing one are closed: (1) a failed delivery never prunes — on failure nothing is removed and the reports ride to the next launch; (2) delivery is **CHUNKED** to `MAX_REPORTS_PER_BATCH = 10` and pruning is driven by the gateway's own reported `accepted` count, never by "the POST returned 200" — the gateway keeps at most 10 per request and still answers 200, so a 15-report flush used to destroy the 5 it dropped (Codex r1 P1); (3) every read-modify-write goes through a module-level promise-chain **lock**, because a global-error capture and a rejection capture are both fire-and-forget and could otherwise overwrite each other's append (Codex r1 P1); (4) a report is stamped with the `origin` gateway it was captured against and is delivered ONLY to that gateway — the queue deliberately outlives a server change, so without this a report captured against one instance would be handed to whichever instance the owner pointed at next, disclosing one server's diagnostics to another (Codex r2 P1); a foreign-origin report is never deleted, it just never travels, and ages out through the ordinary cap, so switching back still delivers it, and `origin: ''` (a crash inside the first-run setup gate, before any server existed) is deliverable to the first server configured, by definition; (5) `fitReport` shrinks an oversized report (oldest events first, then string truncation, marked `truncated: true`) to below `MAX_REPORT_BYTES = 80 KiB`, applied on the way in AND on the way out — the gateway enforces its body ceiling *before* sanitising and answers 413, so an oversized report at the head of the queue would 413 every flush forever (Codex r1 P2). The gateway DISCARDS `origin` on ingest: it is a client-side routing field and the instance already knows which one it is. Byte budgets use UTF-8 length, not character count. Bounded at `MAX_QUEUED_REPORTS = 20` / `MAX_QUEUE_BYTES = 256 KiB`, newest-wins. Pruning matches BY `report_id` against a RE-READ, so a report enqueued while the POST was in flight is not destroyed. Total by construction — storage and parse failures degrade to "empty queue" / "not delivered", never a throw.
- **`app/lib/token-storage.ts`** — one new key, `neutron.diagnostics.queue`, on BOTH implementations (`WebTokenStorage` + `NativeTokenStorage`), string-in/string-out so the storage layer stays a dumb seam. Deliberately OUTSIDE `clearAll()`: a crash report is evidence about the app, not the session, and losing it on sign-out would defeat the one case the queue exists for. It carries no credential by construction.
- **NEW `app/lib/diagnostics.ts`** — the runtime: `installDiagnostics()` (idempotent), `recordDiagnosticEvent`, `captureReport(reason)` (build + persist immediately), `flushDiagnostics`, `sendDiagnosticsNow`. Redacts at record time too, so a token never sits in device memory either — not just never on the wire. Platform metadata is resolved through lazy `require` (the same pattern `lib/token-storage.ts` uses) so the module imports cleanly under `bun test`.
- **NEW `app/lib/diagnostics-client.ts`** — `POST {gateway}/api/app/admin/diagnostics/reports` with the EXISTING app bearer. Returns a result rather than throwing on transport failure; the queue treats "not delivered" as ordinary and retries next launch.
- **NEW `app/components/DiagnosticsErrorBoundary.tsx`** — root React error boundary. A render crash is now REPORTED (with the component stack) and shown, instead of producing a blank screen with no information. Wraps both the first-run setup gate and the authenticated tree.
- **NEW `app/components/DiagnosticsSync.tsx`** — flushes once per `(server, user)` pair on the first authenticated render, which is the exact moment a report from a previous failed launch finally has a bearer to travel with. Silent on failure — diagnostics is a passive observer.
- **`app/app/_layout.tsx`** — `installDiagnostics()` at MODULE SCOPE (not in an effect): this file is the app entry point, so a failure during boot happens before any effect would have fired, and a boot failure is exactly what is invisible today.
- **`app/app/settings.tsx` + NEW `app/lib/diagnostics-send-state.ts`** — a "Diagnostics" card with a manual **Send diagnostics** action, and copy that never claims success after a failed POST (the pure branching lives in the helper so `bun test` can exercise it — the app suite does not mount RN components).

**Gateway side (Neutron Open, not Managed)**

- **NEW `gateway/diagnostics/client-report-redaction.ts`** — an INDEPENDENT second redaction pass on arrival, including the presented bearer as an exact needle. Not accidental duplication: the client layer keeps the token off the wire and out of the device's queue; this layer keeps it off the operator's disk even if the client is old, modified, or buggy. Also enforces the batch caps (`MAX_REPORTS_PER_BATCH = 10`, `MAX_EVENTS_PER_REPORT = 100`). Over-long batches are TRUNCATED with the drop count reported, never rejected — the app clears its queue on a 2xx, so rejecting outright would make an over-full queue permanently undeliverable.
- **NEW `gateway/diagnostics/client-report-store.ts`** — `FileClientReportStore`, one JSON object per line at `<owner_home>/diagnostics/client-reports.jsonl`, trimmed to `DEFAULT_MAX_RECORDS = 500` on every append. JSONL because the reader is a person on their own machine with `tail`/`jq`, and the point of this feature is that diagnosis needs no cable, no SaaS, and no sqlite client. `append` fails LOUD (the device keeps its queue on a non-2xx, so a swallowed write would destroy the only copy); `list` fails soft (one torn line never hides the history around it).
- **`gateway/http/app-diagnostics-surface.ts`** — the EXISTING O5 surface gains `POST` + `GET /api/app/admin/diagnostics/reports`, behind the SAME owner gate as the O5 read route (`resolveBearer` from `gateway/http/surface-kit.ts` + the instance-slug cross-check; wrong-slug → 403, everything else → 401). **There is NO unauthenticated write path** — that is precisely why the app carries a persisted queue instead. Body ceiling `MAX_REPORT_BODY_BYTES = 128 KiB`, checked on the declared `content-length` AND on what actually arrived, BEFORE `JSON.parse`. Each record is stamped with the SERVER-observed `user_id` (from the bearer) and `received_at` (server clock) — a device cannot spoof either.
- **`open/composer.ts`** — wired at the existing `createAppDiagnosticsSurface` call site; the store is a REQUIRED constructor option, so there is no "reports disabled" branch that could drift out of test coverage. Reaches production through the already-mounted `appDiagnostics` route slot (`gateway/http/route-slots.ts`) — no new composition field, no new slot.

**Tests (all new unless noted)**

- `app/__tests__/diagnostic-redaction-invariant.test.ts` — a report built from events carrying the bearer in seven shapes (message, stack frame, nested `authorization` key, array element, URL query, `dev:` token, JSON-serialised body) contains neither the token, nor its signature segment, nor a 40-char prefix — both WITH the exact needle and WITHOUT it (pattern rules alone). Also asserts the scrub stays USEFUL: ordinary stack text and short identifiers survive untouched.
- `app/__tests__/diagnostic-queue.test.ts` — survives the process (written by one storage instance, read by a fresh one over the same backing, through the REAL `NativeTokenStorage`), prunes only what the gateway confirmed, KEEPS everything on a failed / thrown / `accepted: 0` send, does not destroy a report enqueued during the flush, never loses the tail of an over-long batch, survives three concurrent appends over a *yielding* backing (a synchronous shim would hide the race), shrinks an oversized report and un-wedges one already sitting in storage, is bounded at 20, reads a corrupt queue as empty.
- `app/__tests__/diagnostic-capture.test.ts` — chains to the previous `ErrorUtils` handler, routes fatal vs non-fatal to the persist vs record path, captures rejections and non-`Error` throws, restores on uninstall, no-ops on a host with neither hook; plus ring-buffer bounds.
- `app/__tests__/diagnostics-client.test.ts` — request shape/URL/bearer header, non-2xx and transport failure as not-ok, empty batch issues no request; plus the manual-send copy.
- `gateway/diagnostics/__tests__/client-report-ingest.test.ts` — against the REAL `FileClientReportStore` on a temp dir: unauthenticated POST 401s AND writes no file, wrong-instance bearer 403s, no part of the presented bearer reaches disk, a token the request never presented is still redacted, server-stamped identity/time override the payload's claim, 413 over the body ceiling, batch truncation reports its drop count, retention is bounded, and the O5 read route + path disclaiming still behave.
- Updated: `gateway/diagnostics/__tests__/app-diagnostics-surface.test.ts` and `diagnostics-compose-e2e.test.ts` supply a real store (required option).

**Mutation-verified** (a test that cannot fail is not a test): neutralising `buildClientReport`'s scrub turns the app redaction invariant red (3 of 6 cases); neutralising `redactString` in the gateway redactor turns the ingest redaction cases red (2 of 15); pruning on any 2xx instead of the `accepted` count, removing the queue lock, disabling `fitReport`, and removing the `origin` filter each turn distinct persisted-queue cases red (1, 1, 3 and 3 of 21). Each was restored and re-run green.

**Codex cross-model review (r1 + r2)** found four real defects in the queue, all fixed above and each now pinned by a mutation-verified test: the batch-limit over-prune (r1 P1), the concurrent-append race (r1 P1), the oversized-report wedge (r1 P2), and — the one with privacy consequences — **cross-server delivery** (r2 P1): the queue survives a server change by design, so a report captured against one gateway would have been flushed to the next gateway the owner configured. `DiagnosticsClient` also now reports `accepted: 0` rather than `reports.length` when a 2xx body does not carry the gateway's count — a stalled queue is recoverable (capped, oldest-evicted) while a wrongly pruned crash report is gone for good.
## 2026-07-25 — mobile app: LOGIN-FIRST — the app opens on login and DISCOVERS its own instance URL

Branch `trident/app-login-first-discovery`. The OPEN/app half of the login-first flow; the control-plane half (`POST /v1/route` returning the instance's PUBLIC base url) already shipped and is live. The owner: *"why does it have to ask? it should just open with a login screen, and once you login it should know the url."* PR #439 (#385 part 1) gave the app a runtime server URL but made TYPING it the FIRST-RUN surface — `app/app/_layout.tsx` rendered the "Connect to your Neutron" form INSTEAD of the `<Stack>` while unconfigured, so a new owner's first task was to know and type a hostname. Now the app opens on LOGIN and learns its own address after authenticating. **NO FEATURE FLAGS** — login-first IS the behaviour, one code path; the typed-URL form is DEMOTED, not duplicated.

- **NEW `app/lib/identity-client.ts`** — the central-identity client, consuming (never rebuilding) two endpoints that already exist on the control plane: `signInWithPassword` (`POST {auth_base}/v1/login` → `{account, accessToken, refreshToken}`) and `discoverInstance` (`POST {auth_base}/v1/route` + Bearer → `{slug, publicUrl, upstreamUrl, accessToken, claims}`), plus `adoptDiscoveredInstance`, which persists the discovered host through the EXISTING `commitServerConfig` path (no parallel writer). Pure-ish by design — no `react-native`, no Expo SDK imports, `fetch` injectable — so the tests exercise the real module. The deadline is armed AND raced, matching `checkServerUrl`, so a `fetchFn` that ignores the abort signal cannot leave the screen spinning — and it covers the BODY READ, not just the headers, because clearing the timer as soon as the fetch resolved would disarm the abort exactly when a service that answers then stalls mid-body still needed it (both cases tested). A non-JSON body is NOT treated as a transport failure: the real status still surfaces as `server`, so an HTML proxy error page can't be reported as "you are offline".
- **`upstreamUrl` is NEVER read.** It is the identity service's INTERNAL loopback (`http://127.0.0.1:<port>`, the reverse-proxy target on the box); a phone that adopted it would dial its own loopback, which is exactly the bug #385 fixed. `discoverInstance` projects the reply down to `{slug, publicUrl, accessToken}`, so the field never leaves the module and no caller can pick the wrong one. A reply carrying only `upstreamUrl`, or an unparseable `publicUrl`, is an honest error rather than salvaged. A test enumerates every app source line (comments excluded) and fails if `upstreamUrl` appears in code anywhere.
- **Two DIFFERENT tokens, not conflated.** `/v1/login`'s `accessToken` is ACCOUNT-scoped (`sub` only) and exists ONLY to authenticate the `/v1/route` call — never persisted, never sent to a gateway. `/v1/route`'s is INSTANCE-scoped (`sub` + `slug`) and is what becomes the session. Asserted directly: the bearer on `/v1/route` is the account token, the persisted session token is the instance one. **The gateway can verify that instance token as of the `jwks` resolver mode below** — until that landed, nothing in Open could, so sign-in succeeded and every authenticated request 401'd.
- **`app/app/_layout.tsx`** — the `'setup'` phase and `ServerSetupGate` branch are GONE; the phase machine is `'hydrating'` → `'ready'` and the Stack always mounts. Hydration is still awaited first (`loadAppConfig()` is synchronous). The #385 invariant that branch enforced — never issue a request against an unconfigured install — moved to two places: `app/app/index.tsx` refuses to leave `/login` while `configured === false`, and deep-link + push-tap routing are now gated on `phase === 'ready' && loadAppConfig().configured` (a push tap must not jump into a project screen that would immediately fetch from nowhere).
- **`app/components/ServerConnectForm.tsx`** — the full-screen `ServerSetupGate` export is DELETED, not left behind. Keeping an unreachable second "Connect to your Neutron" screen would be exactly the dual old/new surface the repo bans; a test fails if the symbol reappears in code. The `ServerConnectForm` itself is unchanged and still owns the normalise → `/healthz` → persist rules.
- **`app/app/login.tsx`** — rewritten as the login-first surface. Primary card: email + password sign-in, then automatic discovery. State is a closed `Stage` union (`idle | busy | picker | no_instance | error`) rather than a bag of booleans, so no flag combination can produce a stuck spinner: several instances → a PICKER over the returned slugs which re-calls `/v1/route` with the choice; zero instances → an explicit "No instance yet" state with Check again; any transport/5xx failure → the real message plus Retry (which re-runs DISCOVERY using the session already held, so a transient failure doesn't cost the password again). The self-host card is mounted OUTSIDE every stage branch, so the fallback is reachable from all of them.
- **ORDERING (a real trap, handled).** `commitServerConfig` wipes the persisted session on a host change, so the flow adopts the host FIRST, `await`s the session write SECOND, and only then calls `setRuntimeServerConfig` — which bumps the epoch, remounts the tree, and makes `AuthSessionProvider` re-hydrate the user from storage. Persisting before adopting would have deleted the token just discovered; a fire-and-forget `setUser` would race the remount and land back on a signed-out `/login`. Both the wipe behaviour and the source ordering are pinned by tests.
- **Honest degradation with no identity service.** When `auth_base_url` is unset the sign-in form is not rendered at all — the screen says identity isn't configured and points at the self-host card, gated on the SAME predicate the client uses (`isIdentityConfigured`), so it can never offer a form the client would refuse. A request with no identity base returns `identity_not_configured` and issues NO fetch (the old failure shape was an empty base concatenated into the schemeless relative URL `'/v1/route'`, which on web resolves against the app's own origin). No URL is ever fabricated.
- **Error taxonomy read from the SERVER, not assumed.** Mapped on the BODY'S SHAPE first and status second, because two distinct routing failures both answer **404** — status alone cannot distinguish them, but the discriminating field the service attaches does: `409 + slugs[]` → several instances (the list feeds the picker), `404 + userId` → the account owns no active instance, `404 + slug` → that slug isn't an active instance we own, `401` → bad credentials or a rejected session token. Verified by reading the control plane's error serialiser and its routing error classes at the SHA that shipped `/v1/route`, not inferred. The reply also carries a `kind` discriminator that would be more direct, but its values name a hosting-layer concept Open's vocabulary gate (`scripts/ci/leak-gate.sh`) excludes from this public tree, so the shape check — equally determined by the server's own output — is used instead. Anything unrecognised degrades to `server` with the REAL status rather than being mislabelled.
- **`app/lib/auth.ts` — the DEAD OAuth lane is DELETED, not left beside the live one.** It held a `signInWithGoogle`/`signInWithApple` implementation built against `<auth-base>/oauth/<p>/start` + `/api/v1/install-token/exchange` — paths the control plane does not serve — with ZERO call sites anywhere in `app/`. Two OAuth implementations, one pointing nowhere, is precisely the dual-code-path trap the repo bans, and it was a live trap: the next agent to "wire up OAuth" would have wired the broken one. `lib/auth.ts` now keeps only the self-host dev-token lane plus the shared `AuthUser` shape; `buildStartUrl` went with it (the service composes and returns the `authorizeUrl` now), and `parseOauthCallback` was retargeted from the old install-token redirect to a standard `?code=&state=` authorization-code redirect. A test enumerates app sources and fails if `install-token`, `signInWithOauthProvider` or `buildStartUrl` reappears in code.

### Round 2 — the two blockers Argus raised, and the majors alongside them

- **BLOCKER 1 (fixed, and proven end-to-end): the instance-scoped bearer was a credential NO Open gateway accepted.** Every `/api/app/*` surface is gated by one resolver, `appOwnerAuth` (`open/composer.ts`), which accepted only the per-install owner bearer (`constantTimeEqual(token, appWsToken)` — a value a phone cannot know) or a base-resolver result whose `user_id === OWNER_USER_ID`. The base resolver had exactly three modes (`channels/adapters/app-ws/auth.ts`): dev-bypass, HS256, unconfigured. The identity service mints the route token as **RS256**, so it hit dev-bypass and was rejected as `malformed_token` — sign-in succeeded, then everything 401'd. Worse, the flow's own adoption probe is UNAUTHENTICATED `/healthz`, so it reported success and hid the failure. **`channels/adapters/app-ws/auth.ts` gains a real `jwks` mode**: offline RS256 verification against the identity service's published JWKS via jose's `createRemoteJWKSet` (which owns fetch, cache, rotation and cooldown — no cache maintained here), configured by `NEUTRON_IDENTITY_JWKS_URL` and an OPTIONAL `NEUTRON_IDENTITY_AUDIENCE`. The claim contract is all-or-nothing: RS256 signature, `exp`, a non-empty `sub`, and a non-empty `slug` claim that constant-time-equals this gateway's own slug. **A token with NO `slug` is REFUSED** — that is the account-scoped bearer every signed-in account holds, and accepting it would let any account drive any install. `jwks_url` **outranks** `bypass`, deliberately: `bypass` is derived from a loopback bind and a hosted instance binds loopback behind a reverse proxy, so checking `bypass` first would make the production mode unreachable on exactly the deployments that need it. There is no credential CHAIN — a token that fails the configured mode is rejected, not retried against a weaker one. A malformed `NEUTRON_IDENTITY_JWKS_URL` throws at composition rather than degrading to "identity quietly off", because a typo must not reproduce the sign-in-then-401 confusion this removes.
- **…and `appOwnerAuth` normalises a JWKS-verified identity onto the owner.** The resolver returns the identity service's account id as `user_id`, but Open is single-owner and everything downstream (the WS channel topic, the owner-timezone write, every `/api/app/*` gate) compares against `OWNER_USER_ID`. Returning the remote account id would authenticate the owner and then deny them, and would fork the chat transcript per account id. Since the control plane mints a slug-scoped token only for that slug's owner, and the resolver already checked the slug, that bearer IS the owner: `if (resolved.mode === 'jwks') return { ...resolved, user_id: OWNER_USER_ID }`.
- **Proven WIRED + SERVED, not merely implemented.** NEW `tests/integration/identity-jwks-bearer.open.test.ts` builds the REAL composed Open graph (same harness as `wide-bind-dev-owner-rejected.open.test.ts`), stands up a REAL HTTP JWKS endpoint on an ephemeral port, mints real RS256 tokens, and drives `/api/app/chat/send`: an instance-scoped token gets **exactly 200 + `{ok:true}`** ("not 401" would also pass on a 403/404/500); an account-scoped token, a token scoped to another slug, and an expired token each get 401; a malformed JWKS url fails composition. The bind is loopback on purpose — the case where `bypass` would otherwise shadow the mode. Mutation-verify: drop the composer's env threading or the owner normalisation and the ACCEPT case goes 401.
- **REMAINING CROSS-REPO STEP (stated, not glossed).** Open can now verify the bearer; the control plane must still thread `NEUTRON_IDENTITY_JWKS_URL` (its own `/.well-known/jwks.json`, which it already serves) into each instance's environment. That is a hosting-layer change and lands in the private overlay repo per the one-repo-per-PR rule — Open first, then the overlay re-pins. **Until that lands, the app's discovered bearer is still rejected on a hosted instance**, so the login-first happy path is complete in Open and pending one env var elsewhere. Recorded here rather than implied to be finished.
- **BLOCKER 2 (fixed): password was the only lane, but the live front door creates PASSWORD-LESS accounts.** An account created through the provider front door is stored with a sentinel non-password hash, and there is no password-set or password-reset endpoint anywhere on the control plane — so an owner who signed up with Google types their email and any password, gets 401 forever, and discovery never runs. Not an edge case: the browser front door is provider-first. **`signInWithOauth` in `app/lib/identity-client.ts`** wires the real lane against the endpoints that exist: `POST {auth_base}/v1/oauth/<p>/start {redirectUri}` → `{authorizeUrl, state, codeVerifier}`, `openAuthSessionAsync` for consent, then `POST …/exchange {code, redirectUri, codeVerifier}` → the same `{account, accessToken, refreshToken}` the password lane returns. **The SERVICE owns PKCE** — it generates and returns the state and verifier and the client replays them; deriving a second challenge client-side would mean two implementations of one protocol, which drift. `state` is checked before the code is spent (asserted: on mismatch the exchange is never attempted). `IdentityFailure` gains `oauth_cancelled` (dismissing the sheet → back to `idle`, no error card), `oauth_unavailable` (a 404 on start = this service offers no such provider, non-retryable) and `oauth_failed`. **`app/app/login.tsx` renders "Continue with Google" / "Continue with Apple" ABOVE the password form** — for a provider-created owner they are the only way in, so they cannot be the buried option — and a test pins that ordering plus the injected `WebBrowser.openAuthSessionAsync` / `Linking.createURL` wiring, so the lane is live rather than a function nobody calls.
- **MAJOR (fixed): the branch decisions moved OUT of the component so the tests are real.** Round 1 covered requirements (d)/(e)/(f) with `expect(src).toContain(…)` against `login.tsx`, which is green over broken behaviour — and was: the retry control's LABEL came from `stage.retry_discovery` while its ACTION branched on `session !== null`, so after a failed second sign-in the button read "Back to sign in" and re-ran discovery on the FIRST account's still-held token, which could sign the device into that account's instance. `expect(src).toContain('void runDiscovery(session)')` passed on exactly that bug. NEW **`app/lib/login-stage.ts`** holds the `Stage` union, `nextStageForFailure`, `clearsSession`, `retryTargetForStage` and `retryLabelForStage` as pure functions (no react, no I/O), and the label is DERIVED from the same predicate that performs the action, so the control cannot contradict itself by construction. The suite now asserts the failure→stage mapping, the session-discard rule, and label/action agreement across every stage × both session states; remaining source pins cover WIRING only and each is paired with a behavioural assertion of the rule it wires.
- **MAJOR (fixed): the persisted `AuthUser.id` was the instance SLUG.** Every other lane sets a user id. Downstream, `'app:' + user.id` becomes the `X-Neutron-Topic-Id` a ZIP import announces and the server parses a `user_id` back out of it — a slug there names nobody, so the import misroutes. `discoverInstance` now also returns `userId`, read off the `sub` of the very token it hands back (unverified — the instance is authoritative — matching how the web client derives it), and the screen persists `instance.userId ?? accountUserId`. `decodeJwtSub` returns `null` rather than guessing for anything unreadable, and `parseDevTokenUserId` was refactored onto it. Tested: the derived id is the `sub`, is NOT the slug, and is `null` for an opaque token; a source assertion fails if `id: instance.slug` returns.
- **MAJOR (fixed): a 24h bearer with the refresh token thrown away.** The instance bearer is short-lived and round 1 discarded the refresh token, so "sign in once and the app knows your instance" would have decayed into "retype your password every day" — the clock undoing the discovery. `IdentitySession` now carries `refresh_token`; a new `neutron.identity.session` storage key persists `{user_id, email, refresh_token, slug}` (inside `clearAll()`, so signing out cannot leave a credential behind that could mint a new one; a corrupted row reads as ABSENT rather than being spent, since spending a garbage refresh token gets the whole family revoked as suspected theft). `renewInstanceSession` reads `exp` LOCALLY (no network) and, only when aged out, refreshes → re-routes PINNED to the adopted slug (auto-routing could otherwise move a multi-instance owner's device to a different instance behind their back) → returns the new bearer plus the ROTATED refresh token. Wired at launch in `app/app/index.tsx`, before any gateway-calling screen mounts. **Only a REFUSED credential signs the owner out**; offline and 5xx both `defer` and retry next launch, so being on a train at launch cannot log anyone out. A self-hosted install (no identity session persisted) is left entirely alone.
- **MINOR (fixed): the entry route now uses the SHARED signed-out guard.** `app/app/index.tsx` redirected on `user === null`, but `AuthSessionProvider` starts at `status: 'hydrating'` with `user` transiently null even for a signed-in install — a login flash on every cold start, recovered only by a mount effect on `/login` that was therefore silently load-bearing. It now routes through `shouldRedirectToLogin` (`status === 'ready' && user === null`), the guard `settings.tsx` / `integrations.tsx` already use, and holds the spinner while hydration is in flight.
- **MINOR (fixed): the self-host lane is locked while discovery is in flight.** It gated only on its own `devBusy`, so saving a LAN host mid-discovery let the still-in-flight adopt overwrite it moments later with a now-stale `previous_gateway_base_url`, corrupting the host-changed session-wipe bookkeeping. Both lanes write the same persisted config; `serverLaneLocked = busy || devBusy` makes that one writer at a time.
- **MINOR (fixed): `describeFailure` gates every branch on the STATUS as well as the field.** The `slugs` branch ran before any status check, so a 500 whose body happened to carry a `slugs` array rendered an instance picker instead of a retryable error — a transient fault turned into a dead end. Now `status === 409 && Array.isArray(body['slugs'])`, matching the documented contract.
- **NITs (fixed):** the "nothing is hardcoded" test matched only the assignment form `= 'https://…'`, so a returned template literal, an object-literal value or a baked `fetch('https://…')` argument all slipped through a test whose stated guarantee is "anywhere" — it now matches ANY http(s) string literal, carries two NAMED reviewable allowances (the localhost suggestion in the self-host form; a third-party favicon endpoint) instead of a category exemption, and a companion test proves the widened regex catches all four forms the old one missed. The instance-picker button no longer no-ops silently when the session is gone (it says so). Both password inputs gained `autoComplete` / `textContentType` so platform password managers fill AND offer to save on the app's new primary surface. Stale docstrings in `lib/server-url.ts`, `lib/config.ts` and `lib/token-storage.ts` that still described the deleted setup gate were corrected, and `app/README.md` — the first doc a future agent reads, and untouched in round 1 — was updated for the login-first boot path and all three sign-in lanes.
- **NIT (reverted): the unrelated gbrain test-timeout bump is GONE.** Round 1 raised `gbrain-memory/__tests__/raw-op-seam-ban.test.ts`'s per-test budget to 30s and justified it with a machine-specific measurement a reviewer could not reproduce. `scripts/run-tests.sh` already runs with `--timeout=15000`, so CI was never near the budget. Reverted to `main`; verified that file still passes on a bare `bun test` (1.38s of the 5s default, measured in this worktree).
- **Round-2 verification, with the environment named.** Run in worktree `/private/tmp/wt-login-first` on macOS (darwin 24.6.0), `bun test v1.3.9 (cf6cdbbb)`: root `bunx tsc --noEmit` clean; `cd app && bunx tsc --noEmit` clean; `scripts/ci/lint.sh` clean; `scripts/ci/depcruise.sh` 8 known violations, 0 new; `scripts/ci/leak-gate.sh` SILENT; `bun test app/` 1037 pass / 0 fail; full `bun test` result recorded in the PR. Round 1 asserted a clean root `tsc` and a green full suite without naming where — reviewers could not reproduce either in a fresh worktree (workspace-symlink resolution), and the root `tsconfig.json` excludes `app/`, which is why the app typecheck is a SEPARATE command above rather than covered by the root one.
### Round 3 — the rotation bug, the predicate extraction, and the diagnostic for the cross-repo gap

- **MAJOR (fixed): a rotated refresh token was DROPPED when the route hop failed, turning one flaky request into a permanent logout.** Refresh tokens are single-use — the moment the service answers a refresh, the token just presented is revoked and the reply carries its replacement. `renewInstanceSession` refreshed, then called `/v1/route`, and on a route failure returned a bare `deferred` that had **nowhere to put** the replacement. So it was discarded, the next launch replayed the revoked token, the service read that as a reuse attack and revoked the whole family, and the owner was thrown back to credentials for good. That exactly inverts this flow's own guarantee that "being on a train at launch cannot log anyone out": a single transient route failure logged them out permanently instead. `RenewalOutcome`'s `deferred` and `sign_in_required` variants now carry `rotated_refresh_token`, threaded through `classifyRenewalFailure` so no exit path past the refresh can silently drop a rotation (`undefined` = the refresh never happened; `null` is a real service value and is preserved as distinct). `app/app/index.tsx` persists it before returning. **The coverage gap that hid this is closed too**: both existing defer tests failed at the REFRESH step, so no test had ever exercised "refresh succeeded, route did not" — there are now four, including the `null`-rotation case.
- **…and the same function's success path no longer risks a partial write.** `Promise.all([setToken, setIdentitySession])` could land the NEW bearer beside the OLD (revoked) refresh token — unrecoverable, since the next launch replays it. The two writes are now SEQUENTIAL with the refresh token FIRST, so the only possible partial state is a fresh refresh token beside a still-valid older bearer, which the next launch simply renews again. Pinned by a test asserting the ordering and the absence of `Promise.all`.
- **BLOCKER (Open's half fixed; the cross-repo step is now a MERGE GATE, not a footnote).** Open can verify the identity bearer, but the hosting layer must still thread `NEUTRON_IDENTITY_JWKS_URL` into each instance's environment — and until it does, login-first is non-functional on a proxied instance: sign-in succeeds and every authenticated request 401s. That is a private-overlay change and cannot land in an Open PR (one repo per PR), so this branch does the two things it legitimately can. **(1) The failure now names itself.** An instance behind a reverse proxy binds to loopback, so `bypass` is on there by derivation; with no JWKS configured the app's RS256 bearer fell into the dev-bypass lane, which cannot verify it. It was still correctly REFUSED — there is no bypass of verification, and that has not changed — but it was refused as *"dev token is empty or too long"*, a message naming nothing the operator did, leaving only an unexplained 401 on every request. `resolveDevBypass` now shape-detects a JWT (three base64url segments) and returns `unconfigured` with the exact variable to set, so the misconfiguration is self-diagnosing from one log line. Genuine `dev:` tokens and ordinary dotted opaque ids still resolve, and an over-long non-JWT still reports the length problem — all four pinned by tests. **(2) The successor is tracked** in the overlay repo's `ISSUES.md`/`SPEC.md` as a merge-blocking follow-up naming the launcher env addition and the re-pin, so nothing depends on memory.
- **MINOR (fixed): the sprint's headline acceptance criterion has executable coverage at last.** "An unconfigured install opens on LOGIN" was asserted only by matching the source text of `app/app/index.tsx` — a test a `prettier` re-wrap breaks and, worse, one that an INVERTED redirect still passes. The component cannot be mounted in the harness (it owns router and session hooks), so the fix is the one this branch already applied to the retry logic: extract the decision. NEW `shouldHoldOnLogin({configured, status, user})` in `app/lib/auth-helpers.ts` is that decision as a value, with seven behavioural assertions including a non-vacuity check (a predicate returning `true` unconditionally would satisfy every hold case while making the app unusable). The remaining source pins cover WIRING only, and one asserts the inline form is GONE so there is a single decision site.
- **MINOR (fixed): a Google sign-in was recorded and displayed as PASSWORD.** `afterSignIn` called `setLane(provider)` and then `runDiscovery` in the SAME render tick, so the closure `runDiscovery` captured still held the previous render's `lane` — `'password'`, the initial state, on a first sign-in. "Continue with Google" therefore persisted `provider: 'password'` and `app/settings.tsx` rendered a PASSWORD badge for an account that has no password. `provider` is now an explicit parameter; the retry and picker call sites pass `lane`, which by then is committed state.
- **MINOR (fixed): a 401 told OAuth owners their email and password were wrong.** Every 401 mapped to *"That email and password did not match an account"*, but 401 is also how the service reports a REJECTED SESSION BEARER — so a Google owner whose token was refused mid-discovery was sent to check a password they never set. The endpoint is not a safe proxy for this (`/v1/login` and the OAuth exchange both send no bearer yet fail for entirely different reasons), so each call site now declares which credential it presented (`password` / `oauth_code` / `session`) and the copy names it. Three tests assert the password lane still says "email and password" and that neither the discovery nor the refresh 401 mentions a password.
- **NIT (fixed): the "nothing is hardcoded" scan no longer exempts whole files.** Two files were skipped entirely, so the stated guarantee ("no instance URL anywhere") did not hold in them — a real instance address added to `lib/server-url.ts`, which already contains one localhost literal, would have passed. Allowances are now per-LINE and name the specific constant they permit, so any other literal in the same file still fails.
- **NIT (fixed): the comment-stripper produced FALSE POSITIVES on block-comment prose.** The forbidden-token scans dropped only lines whose first non-space character was `*`, `//` or `/*`, so a continuation line inside a `/* … */` block that began with a word — e.g. prose explaining why `upstreamUrl` must never be adopted — read as CODE and would have failed the build for documenting the rule. Replaced with a stripper that tracks block-comment state and also removes trailing `//` comments (so a forbidden token cannot hide after real code on one line), shared by both scans, with five mutation cases pinning that prose is exempt and real code never is.
- **NIT (fixed): dead PKCE-era crypto helpers deleted.** `base64UrlEncode` and `hexToBase64Url` had no production caller once the service took ownership of the PKCE challenge; only their own unit tests kept them alive. Removed, with the test's fixture-builder replaced by a local non-exported helper — re-exporting an encoder purely to satisfy tests would have resurrected the code they were deleted for. `base64UrlDecode` stays; `isTokenExpired` reads a JWT payload locally.
- **NIT (fixed): a second label source for the `no_instance` retry.** `retryLabelForStage` returned `'Check again'` unconditionally while `retryTargetForStage` branched on the session, so a sessionless `no_instance` promised a re-check and then bounced to sign-in — the exact label/action divergence that function pair exists to prevent, surviving in the one branch exempted from it. The label is now derived for every stage, and `login.tsx` calls the helper instead of hardcoding the literal (the error card already did). Unreachable today since `clearsSession` is false for `no_instance`, which is precisely why it was worth removing.
- **NIT (fixed): stage cards could render below the fold with no scroll.** The picker, not-provisioned and error cards render after the brand block and the full sign-in card inside a plain `ScrollView` with no ref — on the smallest viewport the first card sits off-screen, so the owner would press Sign in, watch the spinner stop, and see nothing change. That is "a press that does nothing, with no feedback", which this screen explicitly forbids. A ref plus `scrollToEnd` on any stage that renders a card fixes it.
- **NIT (added): an optional `iss` pin.** `jwks` mode verified signature, `exp`, `sub` and the `slug` cross-check, but pinned no issuer, and the audience is optional and unset in practice. `NEUTRON_IDENTITY_ISSUER` is opt-in for the same reason the audience is — the value is one deployment's vocabulary, which this public tree cannot carry. Bounded today (one JWKS, one slug-bearing minter) but cheap defence-in-depth for the day an instance trusts more than one key source, where signature + `slug` alone would accept a token from any issuer in the set. Both the enforced and the not-pinned cases are tested.
- **Round-3 verification, with the environment named.** Worktree `/private/tmp/wt-login-first`, macOS darwin 24.6.0, `bun test v1.3.9 (cf6cdbbb)`: root `bunx tsc --noEmit` clean; `cd app && bunx tsc --noEmit` clean (the root `tsconfig.json` excludes `app/`, so it is a separate command); `scripts/ci/lint.sh` clean across all 5 gates; `scripts/ci/depcruise.sh` 8 known violations / 0 new (baseline unchanged); `scripts/ci/leak-gate.sh` **SILENT**; `bun test` in `app/` **1054 pass / 0 fail**.
- **The full suite has ONE red lane, and it is pre-existing — established by measurement, not asserted.** `scripts/run-tests.sh` reds one lane per run with a ~15000ms timeout on a test that stands up a real HTTP surface. Four clean full runs: this branch failed lane 8 twice (`open-memory-health-wiring` → "boot() folds … memory_health into the SERVED /healthz", 15011ms then 15018ms), and **`main` (`f392e4c7`) reproduced the same class on a DIFFERENT test in a different lane** (run 3 clean; run 4 failed lane 3 on `app-docs surface — GET /history/<sha>` at 15005ms). A different test failing on `main` rules out any single code change. Supporting: the failing file is untouched by this branch, runs 1.55s isolated here and 1.69s on `main` (>9x margin under the budget), and its whole lane 8 passes green in 131s when run alone — the failure needs the full sequential run. The env-bleed hypothesis was tested and DISPROVED: only the lane-10 integration test and the app-ws auth unit test reference `NEUTRON_IDENTITY_JWKS_URL`, the former save/restores it via `createIsolatedHome`, and the two files paired pass in 2.12s — so `createRemoteJWKSet` is never constructed in lane 8 and this round's only composer edit (a pure `readNonEmpty` plus a conditional spread) cannot affect it. Likely mechanism, explicitly UNCONFIRMED: cross-lane socket/handle accumulation, given the many `port <N> in use (EADDRINUSE) — likely the previous server still releasing the socket` lines from earlier lanes. Filed with the measurement table, an investigation plan and candidate fixes as Managed ISSUES #391. Recorded here rather than presented as a clean suite.
- **Round-2 finding NOT fixed, stated plainly.** Renewal runs once per app mount, so a session left open in the FOREGROUND past `exp` 401s with no refresh until relaunch — there is no AppState-resume or 401-triggered renewal hook. Bounded by a 24h access TTL, and the correct fix is a provider-level hook rather than a change to the launch path, so it is documented in `docs/SYSTEM-OVERVIEW.md` and tracked as follow-up rather than bolted on during a review-fix pass. Also carried forward, not fixed here: the pre-existing `tests/integration/orphan-survival.test.ts` flake (unchanged on this branch, flakes on `main` too — its readiness poll proves only that migrations finished, then waits a fixed sleep before signalling, so under load the signal can land before the handler installs), now tracked in the overlay repo's `ISSUES.md` as #390 — alongside #391 for the full-run 15s-timeout class measured above.
- **Brief deviation, stated rather than claimed clean.** The brief asks for its three-token forbidden-string grep over the diff to be EMPTY. It is not: the diff carries `upstreamUrl` in comments, test fixtures and this log — deliberately, since documenting WHY that field must never be adopted is what stops it being reintroduced. Zero CODE reads of it exist, which is what the enforcing test asserts by scanning app sources with comment lines excluded. The other two tokens (the hosted domain and the legacy project name) do not appear anywhere, and `scripts/ci/leak-gate.sh` is SILENT — note that gate is zero-tolerance even in prose, so this sentence deliberately does not quote them.

## 2026-07-24 — mobile app: configurable Neutron server URL, no silent loopback default (ISSUES #385 part 1)

Branch `trident/mobile-server-url-config` (PR #439). The Expo app could never reach a real instance: NO server URL was set anywhere (`app/eas.json` had no env passthrough, `app/app.json` `extra` carried only `router` + `eas`) and `app/lib/config.ts` silently substituted `DEFAULT_GATEWAY_BASE = 'http://127.0.0.1:8080'` — which on a phone IS the phone, so every request failed quietly, and an empty `auth_base_url` produced a schemeless relative URL at `app/lib/auth-helpers.ts:33` / `app/lib/auth.ts:174`. The silent default is what let a broken build ship undetected. NO FEATURE FLAGS — this is the default boot behavior, one code path.

- **NEW `app/lib/server-url.ts`** — the pure, unit-testable core: `resolveServerBases` (per-field precedence **persisted runtime > `extra.neutron_*` > `EXPO_PUBLIC_NEUTRON_*` > unconfigured**; every source normalised, `configured` derived from the NORMALISED value so a degenerate source like `'/'` or `'https://'` can never report a configured install), `normalizeServerUrl` (adds `https://` when schemeless, lower-cases scheme+authority, drops query/fragment, strips trailing slashes, rejects non-http(s), a malformed authority and an out-of-range port), `checkServerUrl` (`GET /healthz`, 8s abort with a plain-language timeout message, and the BODY must parse as the gateway's health JSON `{ status, project_slug, … }` — `gateway/index.ts:786-789` — so a captive portal / router page answering 200 can't validate as "your gateway"; `status:'degraded'` still passes since `/healthz` is 200-when-degraded by design), and `commitServerConfig` (the single normalise → validate → persist path).
- **`app/lib/config.ts`** — `DEFAULT_GATEWAY_BASE` DELETED. `loadAppConfig()` now returns `configured: boolean` and `''` bases when nothing is configured, and stays SYNCHRONOUS (~20 call sites read it inside `useMemo`): the persisted value is hydrated once at boot by `hydrateServerConfig()` into a module-level cache, with `setRuntimeServerConfig()` updating it after an in-app change. The env tier is read as a LITERAL `process.env.EXPO_PUBLIC_*` member expression — `babel-preset-expo`'s inline-env-vars plugin only rewrites that exact form, so aliasing `process.env` into a local would leave build-time configuration dead in every real build (Argus r1 BLOCKER; guarded by a source-invariant test).
- **`app/app/_layout.tsx`** — boot phase machine `'hydrating'` → `'setup'` → `'ready'`. Unconfigured renders `ServerSetupGate` INSTEAD of the `<Stack>`, so no screen can fire a request at nowhere; deep-link + push-tap routing stay disabled until `'ready'` (no navigator mounted before then). WIRED + SERVED — the gate is in the real boot path, not merely implemented.
- **NEW `app/components/ServerConnectForm.tsx`** — one form, two mount points: the full-screen "Connect to your Neutron" first-run gate, and the same form inline in the `app/app/settings.tsx` "Neutron server" card (shows the current URL, "Change server", and signs the owner out + routes to `/login` when the host changes). `http://127.0.0.1:7800` is prefilled in the gate as a VISIBLE, EDITABLE suggestion only — never applied implicitly (the resolver has no default).
- **`app/lib/token-storage.ts`** — two new keys, `neutron.server.gateway_base_url` + `neutron.server.auth_base_url`, on BOTH `TokenStorage` implementations (`WebTokenStorage` + `NativeTokenStorage`) with the existing injectable-backing test seam (`MemoryKeyValueStore` is a `SyncKeyValueStore` BACKING consumed by `WebTokenStorage`, not a third adapter — corrected from an earlier "all three adapters" phrasing per Argus r2). Deliberately OUTSIDE `clearAll()`: signing out must not make the install forget which server it belongs to. Conversely a host CHANGE wipes the session (the old instance's token is meaningless on the new one) — including on the first-run gate, where an OTA'd install can still hold a token minted against the old loopback default; persist happens BEFORE the wipe so a failed write leaves session + host consistent.
- **`app/app.json` + `app/package.json`** — `expo-build-properties` (`android.usesCleartextTraffic: true`) plus `ios.infoPlist.NSAppTransportSecurity.NSAllowsLocalNetworking` + `NSLocalNetworkUsageDescription`, so the `http://<lan-ip>:7800` path this feature exists to enable is actually permitted in a native build. `NSAllowsArbitraryLoads` deliberately NOT set — plain-`http` to a PUBLIC host stays blocked on iOS. UNVERIFIED until a real EAS release build: neither `app/ios` nor `app/android` is vendored (managed workflow), so the effective release defaults these override aren't readable from the checkout.
- **`app/eas.json`** — each profile declares `"environment"` so EAS Build loads that environment's server-side variables (`EXPO_PUBLIC_NEUTRON_BASE_URL`, `EXPO_PUBLIC_NEUTRON_AUTH_BASE_URL`). NO hostname is hardcoded (public repo). Documented SPEC DEVIATION awaiting the owner's ack: the brief asked for an `env` block, but an `eas.json` `env` block takes literals only, so it cannot reference a server-side variable — see `app/README.md` § "Build-time server URL (optional)".
- **Tests** — NEW `app/__tests__/server-url.test.ts` (precedence a/b/c, unconfigured ⇒ `configured:false` with `127.0.0.1` asserted ABSENT, degenerate-source fall-through, normalisation incl. port-range + malformed authority, `/healthz` success / non-2xx / transport-throw / timeout-copy / non-Neutron-200 body, persist + session hygiene incl. the OTA first-run wipe and persist-before-clear ordering). NEW `app/__tests__/server-config-wiring.test.ts` virtualizes `expo-constants` via `mock.module` and imports the REAL `lib/config.ts`, so `hydrateServerConfig()` → module cache → synchronous `loadAppConfig()` is executed rather than assumed (the pure-module-only pattern CLAUDE.md forbids), plus the literal-`process.env` source invariant. `app/__tests__/token-storage.test.ts` extended for the two server keys and their exclusion from `clearAll()`.
- **Copy correction (caught while reviewing, same class as a fabricated citation):** the setup-gate hint and `app/app/login.tsx` both told the owner to run `neutron up`, which is NOT a command — `bin/neutron:82` dispatches `start|stop|restart|status|logs|install|uninstall`, the usage line is `bin/neutron:136`, and an unknown verb exits 1 at `bin/neutron:138`. Both now say `neutron start`.
- **Scope note:** #385 stays OPEN — the app's immediate-crash symptom is part 2, and a fresh build is the next test.

**Argus r2 round (same PR).** Five findings that made the feature unusable or unrecoverable in the real install, plus polish:

- **BLOCKER — the server editor was UNREACHABLE.** `/settings` held the only on-device editor but was registered and never pushed from anywhere (verified by enumerating every `router.push`/`replace` literal in `app/`), so a host that went stale after a DHCP lease change could only be fixed by reinstalling: `configured === true` skips the boot gate. Fixed with a **Settings** entry in the projects header (`app/app/projects/index.tsx`, `projects-settings-btn`), and `app/__tests__/server-editor-reachability.test.ts` now ENUMERATES nav targets so deleting it fails a test rather than a review.
- **MAJOR — the gate prefilled the wrong port.** `LOCAL_DEV_SUGGESTION` was `http://127.0.0.1:8080`; nothing in this repo binds 8080. The harness default is **7800** (`gateway/boot-listener-registry.ts:30` `DEFAULT_LISTEN_PORT = 7_800`, `install.sh:82` `CHAT_PORT=7800`, `bin/neutron:76`), so the mandatory screen failed on its own default. Fixed, and a test now derives the expected port by reading `DEFAULT_LISTEN_PORT` out of the gateway source instead of pinning a second literal.
- **MAJOR — stale config in mounted screens.** `setRuntimeServerConfig` mutated a module cache with no invalidation while ~10 screens freeze `loadAppConfig()` in `useMemo(() => loadAppConfig(), [])`, so an already-open chat kept issuing HTTP + WS at the OLD host after a change. Added a server-config **epoch** + subscription (`lib/config.ts:getServerConfigEpoch` / `subscribeServerConfig`); `app/app/_layout.tsx` keys the whole app tree on it, so a change tears down every screen and every frozen memo.
- **MAJOR — no recovery while unauthenticated.** `/settings` redirects to `/login` as soon as auth resolves to unauthenticated, and `/login` had no server affordance — so "changed to a host whose credential fails" was a dead end. `app/app/login.tsx` now mounts the same `ServerConnectForm` (`login-change-server`). Settings also now bounces on `host_changed` rather than `session_cleared`, which is false when there was no persisted token to clear.
- **MAJOR — OTA would have bricked existing installs.** `updates.url` + `runtimeVersion.policy: appVersion` means a JS-only change reaches installed builds, but the gate depends on native cleartext permissions applied by `expo prebuild` at BUILD time; an OTA'd Android install would render a gate whose LAN probe the platform blocks, with no skip path. **Decision: block the OTA** by bumping `app.json` `version` 0.0.1 → 0.1.0 (mirrored in `app/package.json` + `bun.lock`), so the derived runtimeVersion no longer matches 0.0.1 installs. Ship a native 0.1.0 build first. UNVERIFIED on-device — reasoning from the Expo runtime-version contract, no native build was run.
- **MINOR/NIT** — empty `auth_base_url` now throws `auth_base_url_not_configured` at the boundary (`lib/auth-helpers.ts:requireAuthBaseUrl`, used by `buildStartUrl` + `exchangeInstallToken`) instead of emitting a schemeless relative URL; `commitServerConfig` ROLLS BACK the persisted config when the session wipe rejects; `checkServerUrl`'s deadline is armed unconditionally and RACED so a fetch that ignores the abort signal can no longer leave the form busy forever; a sub-second timeout renders as `20ms` not `0s`; an abort landing during the `/healthz` body read reports the timeout instead of "not like a Neutron gateway"; the setup form warns (advisory, non-blocking) when the scheme is `http` and the authority is not loopback/RFC-1918/link-local/`.local`, since Android's blanket `usesCleartextTraffic` would otherwise send the bearer to a public host in the clear unremarked; `bin/neutron` exit-1 citation corrected `:137` → `:138`; and `app/__tests__/push-deep-link-routing.test.ts` now pins the `phase === 'ready'` gate it silently stopped covering.

## 2026-07-24 — one-click Reconnect button on the auth-reconnect bubble (on-demand install-token handoff)

Branch `feat/auth-reconnect-button` (new PR vs main). Follow-up to the just-merged auth-failure detection (PR #434), which shipped the `AUTH_RECONNECT_BODY` bubble with `options: []` and an explicit deferred follow-up: a client affordance + turn→handoff plumbing for a one-click reconnect. The owner: "even better a button which opens a browser and I auth, if that's possible." This closes that follow-up.

- **`gateway/wiring/build-live-agent-turn.ts`** — the auth-reconnect bubble now carries a single **"Reconnect"** button (value `RECONNECT_AUTH_VALUE = '__reconnect_auth__'`), mirroring the freeze-timeout Retry button's shape. Unlike Retry, a tap does NOT re-run the last message (that would just hit the same invalid token): the turn runner intercepts the sentinel at turn-START — before user-turn persistence and last-message recording, so the opaque value never renders as a user bubble nor becomes a later Retry's recovered text — and instead mints a **fresh install-token handoff on demand**, replying in-chat with the copy-paste terminal command (`buildReconnectCommandBody` wraps it in the gate's "In a terminal on this machine, run: …" UX). The LLM substrate is never dispatched for a reconnect tap. New optional `reconnectHandoff` seam on `BuildLiveAgentTurnInput`; `sendAuthReconnect` gained an `includeReconnectButton` param (button shown only when the seam is wired, so no dead button is ever offered); new `sendReconnectCommand` helper degrades to the static `AUTH_RECONNECT_BODY` manual instructions if the mint returns null / throws.
- **`open/composer.ts` + `open/install-token-handoff.ts`** — the reconnect seam is the extracted, unit-tested `buildReconnectHandoff(installTokenHandler, port)` helper. It drives the SAME `installTokenHandler` the first-time auth gate drives (Open's handler, or a Managed-injected one) via a synthetic `POST /oauth/max/install-token/initiate`, reusing the same signup_id → capture-token → restart flow, just invoked on demand from a chat button instead of the initial auth gate. The minted command is NOT byte-for-byte the onboarding one: the first-time gate mints against the real inbound browser request so `resolveOrigin` honours `X-Forwarded-*` and yields the PUBLIC origin, whereas the reconnect seam mints at a LOOPBACK origin (`127.0.0.1:<NEUTRON_PORT || DEFAULT_LISTEN_PORT>`). That is intended — the bubble instructs the owner to run the command IN A SHELL on the machine running Neutron, and the box reaches its own listener over loopback — but it means only someone with a shell on the box can run it. **Known limitation (tracked, non-blocking at dogfood stage — the owner has box shell):** a shell-less remote owner or a managed-tenant owner (no SSH to the tenant box) cannot run a loopback command; a request-origin-derived reconnect for those deployments is future work (see `docs/SYSTEM-OVERVIEW.md` § install-token auth surface, Known limits). `claude setup-token` itself opens the real browser OAuth consent, so this IS the "opens a browser and I auth" flow within what Anthropic's CLI supports (a terminal trigger is unavoidable — the token is captured from the CLI's stdout; confirmed no pure-browser path exists in the repo). `gateway/boot-listener-registry.ts` now `export`s `DEFAULT_LISTEN_PORT` (single source of truth for the port default); its stale "units pass `--port=`" comment was corrected to note units set `NEUTRON_PORT` env.
- **Tests** — extended `gateway/wiring/__tests__/build-live-agent-turn-auth-reconnect.test.ts`: the auth-invalid bubble carries the Reconnect button when the seam is wired (label/value asserted) and stays buttonless when it isn't; a tap mints the handoff exactly once and replies with the fresh command (NOT a re-run — substrate never dispatched); a failed mint degrades to the static instructions. Extended `open/__tests__/install-token-handoff.test.ts` for `buildReconnectHandoff` — direct coverage of the closure the composer/Managed tenants run verbatim: it drives a real `buildOpenInstallTokenHandler`, mints a loopback-origin command, and returns `null` (degrade, no throw) when the handler yields non-200 / a missing command. NO feature flags. `bunx tsc --noEmit` clean; lint / depcruise (0 new) / leak-gate (0 findings) green.

## 2026-07-24 — Work Board task B: sync the CC orchestrator's native TodoWrite list onto the Work Board (PostToolUse hook → sink → shared store)

Branch `feat/todowrite-workboard-sync` (new PR vs main). WAVE 3.5 Work Board task B (managed SPEC Decisions Log 2026-06-29). The warm orchestrator maintains its own ephemeral multi-step todo list via CC's native `TodoWrite` tool — invisible to the owner and lost with the session. This wires it onto the board automatically, so multi-step work the agent is doing shows up as tracked cards, not only work explicitly created via `work_board_add`. NO FEATURE FLAGS — ships as default behavior on the owner's warm conversational REPL.

- **Observation seam — a NEW `PostToolUse` hook (matcher `TodoWrite`), sibling of the enforce-reply Stop hook.** `runtime/adapters/claude-code/persistent/hooks/todo-sync.ts` is a small `bun`-run subprocess CC invokes after a `TodoWrite` tool call: it reads CC's PostToolUse stdin payload (`tool_name` + `tool_input.todos` — verified against the installed CLI `sdk-tools.d.ts` `TodoWriteInput`: `{ content, status: 'pending'|'in_progress'|'completed', activeForm }[]`) and forwards the list to the substrate reply-sink over the SAME token-gated loopback the tool-bridge + dev-channel use (`SINK_PORT` + `X-Sink-Token` → `POST /todo-sync`). NOTIFY-ONLY (never blocks or mutates the tool call); fail-soft (missing env / bad input / transport error exits 0 silently — a board-sync failure can't perturb the turn). `SESSION_ID` is taken from the hook's baked env, not stdin, so it always matches the sink's session key.
- **Hook wiring — `build-settings.ts` + `spawn.ts`.** `buildSettings` gains an optional `todoSync` config and, when present, emits `settings.hooks.PostToolUse = [{ matcher: 'TodoWrite', hooks: [{ command: 'SINK_PORT=… SINK_TOKEN=… SESSION_ID=… bun <hookPath>' }] }]` alongside the Stop hook (absent ⇒ no `PostToolUse` key, byte-identical for every non-opted REPL). `spawn.ts` passes `todoSync` (with the live `sink.port`/`sink.token`/`sessionId`) ONLY when `enableToolBridge === true` — i.e. The owner's warm conversational REPL. The disposable Trident build REPLs + the untrusted history-import REPL never enable the bridge, so their internal TodoWrite stays build-internal and never lands on the owner's board. Sink token in the command string is consistent with the existing 0600 mcp-config posture (the settings file is written 0600).
- **Sink route + late-bound reconciler.** `pool-state.ts` `ReplSink` gains a `/todo-sync` route (session-scoped, token-gated like `/reply`): it resolves the session's active `projectId` and dispatches to a late-bound `todoSyncRef` (mirror of `replToolBridgeRef`; untyped `todos` pass-through so the runtime module never imports work-board). `repl-sink.ts` adds `setReplTodoSync`/`clearReplTodoSyncIf` (re-exported from `persistent-repl-substrate.ts`). `gateway/composition/build-core-modules.ts` wires the reconciler in the `repl-tool-bridge` module init alongside `setReplToolBridge`, using `input.work_board.store` + `input.project_slug`: it resolves the per-project `workBoardScopeKey(owner_slug, project_id)` (exactly like the `work_board_*` tools) and reconciles through the SAME shared store — so a synced create/update fires the store's `onChange` live-push. Absent board (LLM-less boot) ⇒ ref stays undefined ⇒ `/todo-sync` no-ops (503, fail-soft).
- **Reconcile logic — `work-board/todo-reconcile.ts` (pure, precedent `trident/board-reconcile.ts`).** `reconcileTodosIntoBoard(store, scope, todos)` snapshots the board once, indexes existing cards by their (already-sanitized) title, then per todo: create a card if no title match (status mapped pending→upcoming / in_progress→in_progress / completed→done, `task_type` defaults to 'build'), else move the matched card's status (a no-op when equal). IDENTITY is the card title (CC todos carry no stable id), sanitized the same way the store sanitizes on write; `list()` returns active before completed so first-wins prefers an active card over a stale completed one. IDEMPOTENT: re-running `TodoWrite` with an unchanged list creates ZERO cards and issues ZERO updates (the critical invariant). Duplicate titles within one list collapse to one card. `normalizeTodos(unknown)` coerces the untrusted sink payload (total, never throws).
- **Tests (real state, no bare `toHaveBeenCalled`):** NEW `work-board/todo-reconcile.test.ts` (real `ProjectDb` + `applyMigrations` + `WorkBoardStore`): first call creates N with mapped statuses; second call with the SAME list → 0 created / 0 updated / same ids + unchanged `updated_at` (idempotency); a status transition updates the linked card + stamps `completed_at`; list-grows adds only the new todo; empty/invalid list no-op; dup-title collapse; scope isolation; active-over-completed match; `normalizeTodos` + `todoStatusToBoardStatus` units. NEW `runtime/.../__tests__/todo-sync-hook.test.ts` drives the REAL hook subprocess against a stub sink (async `Bun.spawn` so the in-process stub can service the POST): forwards todos with token + env SESSION_ID; no-ops when env unwired / non-TodoWrite tool / absent todos / malformed stdin. `build-settings.test.ts` +2 (PostToolUse wired alongside Stop with the baked env prefix; coexists with the permissions block; no PostToolUse key when `todoSync` absent).
- **Gates:** `bunx tsc --noEmit` clean; `bun test work-board runtime/adapters/claude-code/persistent gateway/composition` green (125 + 654 + 12 pass); `bash scripts/ci/depcruise.sh` 0 new cross-band violations; `bash scripts/ci/leak-gate.sh` clean (kept comments/tests generic — no tenant slugs / hosted domains). NO FEATURE FLAGS.

## 2026-07-24 — auth-failure detection: classify an invalid/expired-token turn as `auth_invalid` (reconnect prompt) instead of a misleading generic freeze-timeout

Branch `feat/auth-failure-reauth-prompt` (new PR vs main). Real dogfood failure (2026-07-24): a chat turn's underlying `claude` child hit `API Error: 401 OAuth access token is invalid` from Anthropic and (headless) printed `Please run /login` then produced ZERO further PTY output. The activity-based inactivity watchdog correctly detected the silence as frozen but MISCLASSIFIED it as a generic timeout, so the owner saw the useless "That one took too long… tap Retry" bubble instead of the actionable "reconnect your Claude token". The owner: "fix this systematically… popup an auth window in the UX."

- **NEW `runtime/adapters/claude-code/persistent/auth-failure-signature.ts`** — an output-scan signature (sibling of `rate-limit-banner.ts`), wired into the existing `OutputScanner` framework, NOT a from-scratch mechanism. Matches a small credential-shaped pattern set case-insensitively, EACH anchored to the CLI's own `API Error:` chrome on one line (the sibling multi-cue rule): `API Error` + `OAuth access token is invalid`, `API Error` + `invalid x-api-key`, and `API Error: 401` (the status matched ADJACENT to the chrome and as a whole token via `/api error[:\s]+401\b/`, so `4015ms` / a chatty "…the api error was a 401…" can't fire). A bare `401` / `Please run /login` / `403` no longer fires: a bare credential word in benign prose must not latch (Argus r1 Verdict B), and a `403` is a policy/authorization error a token reconnect would not fix (Verdict C). NOTIFY-ONLY (no `keys`). Honest best-effort limitation documented in-file: a text-scrape of a human-facing CLI error, not a structured API, so a reworded banner can miss (degrades to the prior generic timeout, no worse).
- **`spawn.ts`** registers `createAuthFailureDetector()` alongside the rate-limit banner detectors. **`signatures.ts` `runOutputScan`** routes a fired auth signature to the new **`dispatchAuthFailureNotice`** (`types.ts`), which stamps the session's `authFailureAt`/`authFailureMatched` (new `ReplSession` fields), logs an operator stderr notice, and calls the optional `onAuthInvalid` DI seam (`AuthFailureNotice`, mirrors `onRateLimitBanner`; the substrate never imports the gateway).
- **`pool.ts` turn driver** — the auth-failure flag is CLEARED at each turn's start (before the inject, since the banner arrives during it). The per-turn timeout watchdog treats a stamped auth signal as a RECLASSIFICATION of a turn that has ALREADY FROZEN (the inactivity/ceiling window elapsed with no further PTY output — the real "banner THEN silence" shape), NOT a fast-fail on mere presence (Argus r1 BLOCKER fix): a frozen turn with the signal set emits a distinct `{ code: 'auth_invalid', retryable: false, message: 'persistent-repl: auth token invalid — reconnect required' }` (poisoning the warm session like the freeze path) instead of the generic `turn_timeout`, while a HEALTHY in-flight turn whose own reply prose merely echoes a credential string keeps streaming, never freezes, and so is never aborted. New `auth_invalid` value in `SubstrateErrorClass` (`runtime/events.ts`) + `SUBSTRATE_ERROR_CODES` (`runtime/errors.ts`).
- **`gateway/wiring/build-llm-call-substrate.ts`** passes a stamped `auth_invalid` event through UNCHANGED (no pool cooldown — a single-credential box would only launder it into "all cooldown", hiding the reconnect fix behind a quota lie); the unstamped `detectCliAuthFailure` cooldown path is untouched.
- **`gateway/wiring/build-live-agent-turn.ts`** — new `isAuthInvalid()` classifier (message-based, like `isFreezeTimeout`; the two auth phrases contain no `turn timeout`/`aborted` token so an auth failure can never also read as a freeze) + `AUTH_RECONNECT_BODY` + `sendAuthReconnect()`. The terminal-failure handler checks auth FIRST: an auth-invalid turn ships the actionable reconnect bubble (persisted as durable history, `allow_freeform` true, NO Retry button — a re-run would just hit the same invalid token), before the freeze-timeout and generic-failure branches.
- **Reconnect story (investigated per the owner's "button which opens a browser and I auth"):** a pure browser-only re-auth is NOT feasible with what the repo has — `claude setup-token` (the OAuth step) must run on the machine and its printed token captured from the CLI's stdout, which is exactly what `open/install-token-handoff.ts` automates. That handoff is already reconnect-capable AS-IS (its stateless signup_id → persist-token → restart flow works for a refresh, not just first-time setup — no changes needed), so the bubble points at the same `claude setup-token` reconnect command. A one-click in-chat "reconnect" button that drives the handoff end-to-end is a follow-up (needs a client affordance + turn→handoff plumbing), tracked rather than half-built.
- **Tests:** NEW `auth-failure-signature.test.ts` (drives the REAL OutputScanner: real 401 line + each `API Error`-anchored variant fires; a bare credential string WITHOUT the anchor / a `403` / a `4015ms` digit-run / a bare `401` / a 500 do NOT fire; edge-latch no-re-fire; doc-quote + bottom-N guards). NEW `auth-failure-classification.test.ts` (REAL persistent-REPL substrate + fake PTY host: (1) observed line then silence → turn errors `code:auth_invalid` retryable:false, NOT `turn_timeout`; (2) BLOCKER regression — a healthy turn that echoes the credential line but keeps streaming and replies COMPLETES, never aborted). `build-llm-call-substrate.test.ts` adds an `auth_invalid` pass-through case (no cooldown laundering) + the taxonomy matrix. NEW `build-live-agent-turn-auth-reconnect.test.ts` (auth-invalid failure ships `AUTH_RECONNECT_BODY` not `TIMEOUT_BODY`/`FAILURE_BODY`, no auto-retry, no Retry button, persisted; classifier distinctness; seed turn stays silent).
- **Gates:** `bunx tsc --noEmit` clean; affected suites green (`runtime/adapters/claude-code/persistent` — 624 pass — + the live-agent/llm-call wiring); `bash scripts/ci/depcruise.sh` 0 new violations; `bash scripts/ci/leak-gate.sh` clean. NO FEATURE FLAGS.
- **Argus r1 follow-up (this PR, round 2):** the CONFIRMED blocker — the detector aborting a healthy in-flight turn on mere presence of credential-shaped prose — is fixed by the freeze-gate reclassification above (require cue AND subsequent silence); the standalone-cue false-matches (Verdict B) are fixed by anchoring every pattern to `API Error` + boundary-matching the status; the generic-403 misclassification (Verdict C) is fixed by dropping the 403 pattern; the missing `build-llm-call-substrate` auth_invalid coverage (reviewer A) is added.
- **Argus r2 follow-up (this PR, round 3):** (1) CEILING BLOCKER — the absolute-ceiling gate fired the auth verdict on bare elapsed time with no silence check, so a still-streaming (livelocked) turn that earlier printed a credential line could get non-retryable `auth_invalid`, violating the "banner THEN silence" invariant. Fixed in `pool.ts`: both freeze gates now compute a shared `silent = now - lastActivity >= inactivityMs`, and the ceiling gate only applies the auth verdict when `authInvalid && silent` — a livelocked turn gets the retryable ceiling-freeze. (2) MAJOR — the output-scan edge-latch was never reset at turn start, so on a WARM session a prior turn's banner (or an unfenced echo) lingering in the bottom-N window left `present` continuously true → no rising edge → the next turn's real 401 never re-stamped the session (misclassified as a generic timeout). Fixed with a new `OutputScanner.resetLatch(id)` called for the auth detector at each turn start (alongside the existing `authFailureAt` clear), so the second-turn banner re-fires and re-stamps. (3) NIT — the `AUTH_RECONNECT_BODY` user-facing string's em dash removed. New tests: ceiling-livelock stays `turn_timeout`; warm second-turn 401 (prior banner still latched, `spawnCount===1`) reclassifies `auth_invalid`; `OutputScanner.resetLatch` unit coverage (re-arm + unknown-id no-op).
- **codex r3 follow-up (this PR, round 4) — CONFIRMED BLOCKER: stale-banner latch re-arm defeated per-turn scoping.** The round-3 `resetLatch` at turn start (needed for the rising-edge guarantee) had a converse hole: because the auth detector matched on mere PRESENCE within the whole-ring bottom-N window, a turn N that printed a transient/recovered 401 and completed NORMALLY (session NOT poisoned → banner still in the window) let turn N+1 re-fire on that SAME stale banner even when turn N+1 printed no new 401. If turn N+1 then froze for an UNRELATED reason (network stall, slow tool call), the watchdog saw `authFailureAt` set + silence and misclassified it non-retryable `auth_invalid` — the misleading reconnect bubble on a session whose credential was fine. **Fix (codex's "track output written during the CURRENT turn" direction):** per-turn output scoping. `PtyRing` gains a monotonic `totalBytesAppended()` counter + `textSince(mark)` (the retained text appended after a boundary snapshot, clamped to the rolling buffer). `pool.ts` snapshots `session.turnOutputMark = ring.totalBytesAppended()` at each turn start (before the inject, beside the existing `authFailureAt` clear + `resetLatch`). `createAuthFailureDetector(getTurnScopedRing)` now re-windows its `present` on `ring.textSince(turnOutputMark)` — the CURRENT turn's output only — reusing the framework's `buildDetectorContext` so the doc-quote + bottom-N guards still apply; a stale banner appended on a prior turn is BEFORE the mark, so it's invisible to `present` and can't re-arm. `dispatchAuthFailureNotice` re-derives its surfaced `matched` line from the same current-turn slice. The `resetLatch` supplies the rising edge; the scoping supplies the "is it new" test — the two compose, so the round-3 warm-second-turn-401 target (a NEW 401 this turn, which IS in the current-turn slice) still fires + re-stamps. NO feature flag. New tests: `auth-failure-classification.test.ts` STALE-BANNER RE-ARM case (turn 1 recovered 401 + healthy reply, turn 2 prints only benign output then freezes for an unrelated reason on the SAME warm ring → asserts RETRYABLE `turn_timeout`, NOT `auth_invalid`; verified to FAIL on the pre-fix whole-window wiring); `pty-ring.test.ts` coverage for `totalBytesAppended`/`textSince` (monotonic across eviction, mark excludes prior output, clamp when eviction outran the mark).

## 2026-07-24 — install-token persist/restore honors an operator override path (NEUTRON_INSTALL_TOKEN_ENV_PATH) so isolated-instance boots don't lose their captured token

Branch `fix/install-token-tenant-writable-path` (new PR vs main). REAL bug hit live (2026-07-24): an operator running an isolated instance against a SHARED, read-only code checkout (the process runs as a restricted OS user that does NOT own the checkout dir) crashed the `/complete` install-token handoff with `EACCES: permission denied` — `persistOauthTokenToEnv` defaulted to `<cwd>/.env`, which that user cannot write, so activation failed with a raw 500. All functionality lands in Open (Managed is a thin wrapper); this is the Open-side fix.

- **`open/install-token-env.ts`** — new exported `resolveInstallTokenEnvFilePath()`: returns `process.env.NEUTRON_INSTALL_TOKEN_ENV_PATH` (trimmed) when set to a non-empty value, else the existing `defaultEnvFilePath()` (`<cwd>/.env`) UNCHANGED. This is a plain override path, NOT a feature flag — when the var is unset the behavior is byte-for-byte identical, so every single-owner install is 100% unaffected. `persistOauthTokenToEnv`'s default parameter now resolves through this helper (the composer's `persistToken: (token) => persistOauthTokenToEnv(token)` wiring at `open/composer.ts:~1501` inherits it with no call-site change).
- **`open/install-token-env.ts`** — new exported `loadPersistedInstallToken()`: resolves the SAME path, and if the file exists parses a `CLAUDE_CODE_OAUTH_TOKEN=` line (plain or `export`-prefixed, optional surrounding quotes) and seeds `process.env.CLAUDE_CODE_OAUTH_TOKEN` from it — but ONLY when that var is not already set (an explicit credential or Bun's own cwd `.env` auto-load always wins; this is purely a fallback restore). Missing/unreadable file → no-op.
- **`open/server.ts`** — `startOpenServer()` calls `loadPersistedInstallToken()` EARLY, right after `const env = process.env`, ahead of BOTH the injected-composer branch and the Open composer (`buildOpenGraphComposer` → `resolveOpenLlmPool(env)` reads `CLAUDE_CODE_OAUTH_TOKEN` from that same `env`). So a freshly-booted process picks up a previously-persisted token even when the persisted file is NOT at cwd (Bun's cwd-relative auto-load never sees it there).
- **`open/install-token-handoff.ts`** — doc comments updated: the `/complete` header now documents the `<cwd>/.env` writable-cwd assumption and points an operator running multiple isolated instances against one shared checkout at `NEUTRON_INSTALL_TOKEN_ENV_PATH`; the loopback-exposure comment notes the same override as the intended path for a reverse-proxied per-instance deployment. Kept generic (no hosted-domain / multi-tenant vocabulary — leak-gate clean).
- **Tests:** `open/__tests__/install-token-env.test.ts` extended — resolver default/empty-override/set cases; persist routes to the override path via the default parameter (and default-unchanged); `loadPersistedInstallToken` restores (plain + export line, and strips a surrounding pair of double OR single quotes), never clobbers an already-set token, no-ops on missing file / no token line, and round-trips with `persistOauthTokenToEnv`. NEW `open/__tests__/install-token-boot-restore.test.ts` — functional restore→`resolveOpenLlmPool` yields a live oauth pool, plus a boot-source ordering guard asserting the restore call precedes both composer-build sites in `open/server.ts`. The boot-restore suite scrubs BOTH credential vars `resolveOpenLlmPool` reads (`CLAUDE_CODE_OAUTH_TOKEN` tier-2 + `ANTHROPIC_API_KEY` tier-4) in `beforeEach`/`afterEach` so the "before restore → null" assertion is hermetic under any shell / Bun-auto-loaded `.env` (tier-5 ambient is neutralized by the `probeAmbientAuth: () => false` seam).
- **Gates:** `bunx tsc --noEmit` clean; the `install-token-*.test.ts` glob (`-env` + `-boot-restore` + `-handoff`) 30 pass / 0 fail (verified also with `ANTHROPIC_API_KEY` exported → still green, the round-1 non-hermeticity blocker); `bash scripts/ci/lint.sh` all green; `bash scripts/ci/depcruise.sh` 0 new violations; `bash scripts/ci/leak-gate.sh` SILENT. NO FEATURE FLAGS.
- **Follow-up (separate PR, Managed repo):** `SystemdLauncher.launch()` full-overwrites the tenant `EnvironmentFile` from the central token store on every relaunch, silently wiping a manually-recovered on-disk token on the next control-plane restart — tracked for a Managed-side merge (not this repo).

## 2026-07-23 — Work Board Layer B: periodic orchestrator context reset + lossless rehydrate (SPEC WAVE 3.5)

Branch `trident/work-board-hardening` (new PR vs main). The LOCKED remainder of WAVE 3.5 Work Board, task A of two (task B — CC TodoWrite ingestion — remains queued). Keeps the warm orchestrator's live context small with a periodic hard reset + rehydrate, so the `cc-agent-*` REPL stays in the good zone instead of growing until `--resume` wedges. NO FEATURE FLAGS — ships as default behavior.

- **SUBSTRATE-SUPPORT FINDING (the Layer B gating question, answered + recorded).** The CLI persistent-REPL context-editing beta (`clear_tool_uses` tool-result eviction) is NOT available for the interactive `claude` PTY REPL substrate: `grep -rn` for any context-editing / `clear_tool_uses` / tool-result-eviction primitive across `runtime/` `gateway/` `open/` returns ZERO hits, and `claude --help` (v2.1.218) exposes NO context-editing flag (`clear_tool_uses` is a Messages-API beta with no seam into a PTY-driven interactive REPL). Layer B is therefore the composer-side periodic reset+rehydrate SPEC WAVE 3.5 anticipated as the fallback — reusing/extending the just-merged `/reset` primitive.
- **`/clear` file-rotation behavior (Argus r1 major — resolved by reasoning, not a fresh dogfood).** CC keeps appending the SAME pinned `<sessionId>.jsonl` across `/clear`: the per-turn `/clear` reset (`pool.ts`) already relies on that pinned path and the `session-size-watchdog` measures it live, so if `/clear` rotated the sessionId those established backstops would already be broken. The trigger is a per-`ReplSession`-object BASELINE DELTA (`WeakMap`) that fires only on growth SINCE the last reset, so it can never re-fire-loop regardless. **Rotation-robust fallback added:** the post-reset re-measure now stamps the baseline at `measure(session) ?? 0` (was `?? measured`). The old fallback to the PRE-clear size meant that IF `/clear` ever rotated/removed the transcript (re-measure → null), Layer B stayed suppressed until the new file re-grew past the OLD absolute size + threshold (a ~2 MB dead zone that also blinded the size-watchdog). Stamping 0 measures the fresh incarnation's growth from empty — exactly like a respawned `ReplSession` (new object → WeakMap miss → baseline 0). Covered by sweep case (x): after a `/clear` that deletes the JSONL, a new 1500 B transcript (> threshold, < the 2000 B pre-clear size) RE-FIRES — which the buggy `?? measured` baseline would have wrongly suppressed.
- **`runtime/adapters/claude-code/persistent/repl-session.ts`** — `ReplSession` gains a 4th ctor param `readonly cwd: string` (the child's working dir), so the sweep can resolve THIS session's transcript path via `sessionJsonlPath(sessionId, cwd, projectsDir)` off the live object. Sole construction site `spawn.ts:162` passes the in-scope `cwd`.
- **`runtime/adapters/claude-code/persistent/context-reset.ts`** — (a) EXTRACTED the per-session actuation block of `resetPooledSessionContext` into exported `actuateSessionContextReset(session, {acquire_wait_ms, idle_quiet_ms, idle_max_ms, onResetUnderMutex?}) → ActuateContextResetOutcome` where `ActuateContextResetOutcome = {status:'reset'|'busy'|'dead'} | {status:'failed', detail?}` (bounded `acquireTurn` race + self-releasing abandoned slot + `waitForReplIdle` → `child.write('/clear\r')` → **fire `onResetUnderMutex` under the mutex** → sleep → `waitForReplIdle`). The `'failed'` outcome now CARRIES the thrown error's message as `detail`, threaded through `resetPooledSessionContext → {ok:false, reason:'reset_failed', detail}` so the `/reset` reply shows the real cause not "unknown error" (Argus r1 minor — sweep case (xi)). `resetPooledSessionContext` delegates with UNCHANGED external behavior otherwise (existing `context-reset.test.ts` passes unmodified — the refactor-safety gate). (b) NEW `createPooledContextResetSweep(opts?)` returning `{ sweep({substrate_instance_id, user_id, should_reset?}) → SweepReport }`. `SweepReport = { reset: [{project_scope, bytes_live}], skipped: [{project_scope, reason: 'busy'|'under_threshold'|'no_new_turns'|'cooldown'|'dead'|'failed'|'no_transcript'}] }`. Sweep mechanics: a 2-dim pool prefix `[instance, user].join(SEP)+SEP` wildcards BOTH project + credential dims (trailing sep makes a legacy 2-dim key unmatchable); `project_scope = key.split(SEP)[2] ?? 'general'`; per match — rejected/unresolved spawn dropped silently, exited child → 'dead', `should_reset===false` → 'cooldown' (measure nothing), `activeTurn` set → 'busy' (never contend the mutex), then measurement = post-compact bytes via a per-session-object `WeakMap` baseline: `bytes_live = max(0, measured - baseline.bytes)`, `turnsServedThisIncarnation() <= baseline.turns` → 'no_new_turns' (an idle scope is never reset twice — the no-loop invariant), `bytes_live < threshold` → 'under_threshold'; over threshold → `actuateSessionContextReset` **with `onResetUnderMutex: () => opts.onScopeReset(project_scope)`** so the scope's warm topics are un-marked SYNCHRONOUSLY under the mutex the instant `/clear` lands (Argus r1 blocker — see below), on 'reset' RE-MEASURE + stamp `{bytes: measure()??0, turns}` (rotation-robust), push to report. Exported `DEFAULT_CONTEXT_RESET_THRESHOLD_BYTES = 2 MB` (well under the 5/10 MB watchdog wedge bands). Background acquire policy = 2 s (skip busy, retry next tick — NOT the /reset 8 s ride-out). The optional `projects_dir` is documented to be threaded from the composer via the canonical `resolveTranscriptProjectsDir`; `undefined` falls back to `~/.claude/projects` which EQUALS the resolver's output today (`claudeConfigDir` is dormant/RESERVED, no live caller) (Argus r1 minor — future-proofing).
- **NEW `gateway/wiring/context-reset-policy.ts`** — pure DI tick loop (lifecycle cloned from `startSessionSizeWatchdog`: unref'd interval, idempotent `stop()`, exposed `tick()`, `onError` default stderr, overlapping-tick guard). `startContextResetPolicy({sweep, intervalMs?, cooldownMs?, now?, setIntervalFn?, clearIntervalFn?, onError?})`. Tick builds a `(scope) => now() - (lastResetAt.get(scope) ?? -∞) >= cooldownMs` predicate, awaits `sweep(predicate)`, then per reset scope stamps `lastResetAt`; a throwing sweep → `onError` and the loop survives. **The rehydration un-mark is NOT the policy's job** (Argus r1 blocker): it fires inside the sweep under the session mutex, so the policy owns only cadence + cooldown — this closes the window where a post-sweep un-mark left a warm bare turn able to run on an already-cleared REPL. Exports `DEFAULT_CONTEXT_RESET_TICK_MS = 5 min`, `DEFAULT_CONTEXT_RESET_COOLDOWN_MS = 45 min`. NO runtime import (pure DI — the sweep arrives injected), so no new gateway→runtime edge.
- **`gateway/wiring/build-live-agent-turn.ts`** — the rehydration seam. `BuildLiveAgentTurnInput` gains `contextResetSignal?: { subscribe(listener: (project_scope) => void) }`; a `topicScopes: Map<topicKey, scope>` records each warm topic's scope (`turn.project_id ?? 'general'`) alongside `contextSent.add(topicKey)`; the builder subscribes so a scope-S signal deletes every matching `contextSent` topicKey → its NEXT turn re-runs `composeFirstTurnPrompt` (full re-grounding). Over-firing is safe (re-sent system context is "merely redundant, never a correctness break"). **Reset-epoch guard (Argus r2 blocker):** a per-scope `contextResetEpoch: Map<scope, number>` is bumped inside the same subscriber; each turn captures `resetEpochAtStart` at the `isColdFirstTurn` decision and re-checks it before the post-dispatch `contextSent.add` — if a reset for the scope fired in between, the re-mark (and `topicScopes.set`) is SKIPPED so a warm prompt built pre-reset can't resurrect the warm mark on a just-`/clear`-ed REPL.
- **`open/composer.ts`** — the reset bus + policy. A `contextResetListeners` set + `emitContextResetScope` near the `/reset` filter; the `/reset` thunk now AWAITS `resetPooledSessionContext` and, on `outcome.ok`, calls `emitContextResetScope(input.project_id ?? 'general')` before returning — so the manual `/reset` rehydrates through the SAME path (**this closes the known /reset persona-loss gap**: the next turn re-composes cold instead of the warm session losing its system prefix). `buildLiveAgentTurn` gets `contextResetSignal: { subscribe: (l) => contextResetListeners.add(l) }`. In the realmode region (guarded on `liveAgentSubstrate !== null` — an LLM-less boot has no warm sessions to sweep) it builds `createPooledContextResetSweep({ onScopeReset: emitContextResetScope })` (the periodic un-mark now rides the SWEEP, firing under the mutex — Argus r1 blocker) + `startContextResetPolicy({ sweep: cc-agent-${owner_handle} / OWNER_USER_ID })` and `realmodeCleanups.push(() => { policy.stop(); contextResetListeners.clear() })` — the `.clear()` is the single teardown seam for the runner's otherwise-unsubscribed reset-bus listener (Argus r1 nit).
- **Tests (real state / PTY-write assertions, no bare `toHaveBeenCalled`):** NEW `runtime/.../__tests__/context-reset-sweep.test.ts` — fake pool entries + write-capturing fake child + temp projectsDir with real JSONL fixtures: oversized idle → one `'/clear\r'` + report.reset; IMMEDIATE re-sweep → NO write, 'no_new_turns' (the no-loop invariant); under-threshold; `activeTurn` → 'busy' + mutex never acquired; `should_reset` false → 'cooldown' not even measured; mid-file `"isCompactSummary":true` marker → only tail bytes count; 2-dim prefix matches TWO scopes + a legacy 2-dim key is not matched; exited child → 'dead'; **(ix) `onScopeReset` fires per reset scope UNDER the mutex — asserts the `/clear` write already landed (`clearsAtCall===1`) AND the turn mutex is still held (`releasesAtCall===0`) at un-mark time, i.e. "after clear, before releasing control" (blocker); (x) rotation-robust baseline — a `/clear` that deletes the JSONL then a new sub-pre-clear-size transcript RE-FIRES (major); (xi) a PTY-write throw → `resetPooledSessionContext` returns `reset_failed` WITH `detail` (minor).** NEW `gateway/wiring/__tests__/context-reset-policy.test.ts` — DI timers/clock: predicate true for a never-reset scope then false within cooldown then true after; cooldown stamped for EVERY reset scope (multi-scope); throwing sweep → `onError`, next tick still runs; overlapping-tick guard; `stop()` clears the interval (the un-mark assertions moved to the sweep suite where the un-mark now lives). NEW `gateway/wiring/__tests__/build-live-agent-turn-context-reset.test.ts` — warm→signal→cold-again (cold-only `<memory_index>` marker), scope isolation (a reset for scope A leaves scope B warm), unknown-scope no-op. `gateway/__tests__/reset-command-wiring.test.ts` +4 (the composer thunk shape: emit-on-ok with scope / 'general'; NO emit on busy / no_live_session). Existing `context-reset.test.ts` passes UNMODIFIED.
- **Gates (as of Argus r2 round-3):** `bunx tsc --noEmit` clean; `bun test runtime/adapters/claude-code/persistent gateway/wiring` 1261 pass / 5 skip / 0 fail (adds the r2 tests: sweep (xii) re-anchor + (xiii) no_transcript, and the runner reset-epoch mid-turn-race guard); `scripts/ci/lint.sh` all gates green (void-promise gate satisfied via `fireAndForget('context-reset-policy.tick', tick())`); `scripts/ci/depcruise.sh` NO NEW cross-band violations (baseline 8 untouched); branch REBASED onto current `main` (`e73cbf6d`) so the review diff no longer falsely reverts #432. NO FEATURE FLAGS.
- **Argus review r1 (round-2 fixes, this same branch):** blocker — the periodic un-mark was deferred to the policy's post-sweep loop while `actuateSessionContextReset` released each session's mutex right after `/clear`, leaving a multi-session-sweep-wide window where a warm bare turn could run on a just-cleared REPL and lose grounding → un-mark MOVED into the sweep, fired synchronously under the mutex adjacent to `/clear`. Major — the post-reset baseline stamped the stale PRE-clear size on a null re-measure, which would suppress Layer B (and blind the size-watchdog) for ~2 MB if `/clear` ever rotated the transcript → now `?? 0` (rotation-robust) + the pinned-`sessionId` behavior documented from the existing per-turn-`/clear`/size-watchdog reliance. Minors — `reset_failed` now carries the actuation error `detail`; the sweep's `projects_dir` is documented to thread the canonical `resolveTranscriptProjectsDir` (homedir default is correct today, `claudeConfigDir` dormant). Nit — the runner's reset-bus listener now has a teardown seam (`contextResetListeners.clear()` in `realmodeCleanups`).
- **Argus review r2 (round-3 fixes, this same branch):** **blocker** — the un-mark-under-mutex (r1) closes the QUEUED-turn window but NOT the warm/cold-DECISION race: a turn that read `isColdFirstTurn` (chose WARM) at `build-live-agent-turn.ts` BEFORE a sweep fired, then re-marked `contextSent` AFTER the sweep's `/clear` + un-mark, would resurrect the warm mark on a just-emptied REPL and silently drop the Layer B re-grounding. Fixed with a per-scope **reset-epoch** (`contextResetEpoch: Map<scope, number>`, bumped in the `contextResetSignal` subscriber): captured at the warm/cold decision (`resetEpochAtStart`), re-checked before the post-dispatch `contextSent.add` — if the epoch advanced in between, the re-mark is SKIPPED so the next turn re-composes cold. Over-claims softened in the `context-reset.ts` `onScopeReset` docstring, the composer comment, and SYSTEM-OVERVIEW (mutex alone does NOT cover this race). **Major (rebase)** — the branch was stale vs `main` (merge-base `d4f8533e`; the two-dot review diff falsely rendered the merged #432 install-token X-Forwarded fix as reverted) → rebased onto current `main` (`e73cbf6d`); the 3-way merge keeps #432 (the branch never touches `open/install-token-handoff.ts`). **Major** — a CC AUTO-compact between sweeps drops the post-compact measurement below the stored baseline, clamping `bytesLive` to 0 and deferring the next reset toward the 5 MB watchdog warn band → the sweep now RE-ANCHORS the baseline DOWN to the compacted floor when `measured < baseline.bytes` (keeps `turns` so the no-loop gate holds). **Minor** — a freshly-spawned warm session with no transcript on disk was reported `'failed'` every sweep → now a distinct `'no_transcript'` skip reason (`existsSync` distinguishes benign-absent from a genuine read error). **Deferred (single-reviewer minor, not fixed):** manual `/reset` doesn't seed the sweep's WeakMap baseline / policy `lastResetAt`, so one redundant `/clear` can fire on the next sweep tick — genuinely idempotent + one-time + self-healing (the sweep re-stamps its baseline after that one `/clear`), and cross-wiring the manual `/reset` seam into the sweep's closure-private WeakMap adds more surface than the cosmetic redundancy costs; left as-is by design.
- **Round 4 (Argus r3 + codex cross-model panel, this same branch — PR #431):** two independent reviewers CONVERGED on the ONE remaining confirmed blocker. **(1) Dispatch-time reset-epoch recheck (the confirmed blocker).** The r2 reset-epoch closed the DECISION→post-dispatch window but NOT the DECISION→dispatch window: a turn decided WARM at `isColdFirstTurn` and captured `resetEpochAtStart`, but the actual `substrate.start(spec)` (and its silent freeze-auto-retry) re-sent that stale warm prompt without re-checking the epoch — so a sweep `/clear` landing between the decision and the (re)dispatch executed a warm prompt against a just-emptied REPL (lost grounding), and the concrete retry-race (attempt-0 warm freezes → reset fires → attempt-1 re-sends stale warm) went unclosed. Fix in `gateway/wiring/build-live-agent-turn.ts`: `resetEpochAtStart` + a new `effectiveCold` are now `let`; the cold composition is extracted into a `composeCold()` closure; the single `spec` becomes a per-attempt `buildSpec()`; and at the TOP of every retry-loop attempt (immediately before `dispatchOnce()`) the epoch is RE-CHECKED — if it advanced since capture and the turn is warm, it recomposes COLD (`composeCold`) and RE-ANCHORS `resetEpochAtStart` to the dispatch-time epoch, so the post-dispatch guard compares against the ACTUAL dispatch moment (a race-recomposed cold turn that completes un-raced re-marks warm correctly; `moduleLog.info('turn_reset_race_recomposed_cold')`). This is the THREE-POINT protocol: capture at decision → per-attempt dispatch-time recheck + re-anchor → post-dispatch re-mark guard. **Residual, documented honestly:** a sweep ALREADY holding the session mutex when a warm dispatch enters the adapter can still `/clear` first (no seam inside the adapter's `acquireTurn`→inject window) — that lone turn runs ungrounded once and SELF-HEALS next turn because the re-mark guard leaves the warm mark off; full closure would need an adapter-level pre-inject gate, explicitly out of scope for this reviewer-agreed fix shape. **(2) `/reset` partial-failure rehydration (secondary confirmed finding).** `resetPooledSessionContext` short-circuits `busy`/`reset_failed` mid-loop after earlier sessions were already `/clear`-ed, and the composer thunk emitted rehydration only on aggregate `outcome.ok` — so a multi-session reset that cleared session A then hit `busy` on B left A's topics warm-marked against an emptied REPL. Fix: `ResetPooledContextInput` gains `on_reset_under_mutex?`, threaded per-session into `actuateSessionContextReset` (fires the instant EACH session's `/clear` lands, under its mutex); the `open/composer.ts` `/reset` thunk passes `on_reset_under_mutex: () => emitContextResetScope(scope)` and DELETES the aggregate-ok emit (single rehydration path; N emits for N sessions is idempotent-safe). **Tests (race simulations, real state assertions):** `build-live-agent-turn-context-reset.test.ts` +1 — a reset firing mid-flight on attempt-0 (fire + freeze-timeout via a new `makeRacingThrowSubstrate`) makes the retry recompose COLD; asserts the doomed attempt's spec lacks `<memory_index>`, the retry's spec CONTAINS the cold-only marker (this assertion demonstrably FAILS at ccc00f28 — received the stale warm prompt `"second"` — and PASSES with the fix), the memory-index snapshot ran exactly twice, and turn 3 is warm (re-anchor let the re-mark land). `context-reset.test.ts` +2 — a partial reset (session A idle, session B busy, same 3-dim prefix / different credential dim, separate recording hosts) returns `{ok:false, reason:'busy'}` yet fires the hook exactly once with A's `/clear` written + B's not; the all-success path fires it twice with `{ok:true, sessions_reset:2}`; the no_live_session path fires it zero times. The stale `reset-command-wiring.test.ts` composer-thunk mirror was updated to the per-session under-mutex shape (adds the partial-failure regression case). **Gates:** `bunx tsc --noEmit` clean; `bun test gateway/wiring/__tests__ runtime/adapters/claude-code/persistent/__tests__` green (640 / 629); `reset-command-wiring.test.ts` 16 pass; `scripts/ci/lint.sh` all gates green; `scripts/ci/depcruise.sh` NO NEW violations (8 known untouched). NO FEATURE FLAGS.

## 2026-07-23 — /reset chat command: clear the live session's model context via CONTEXT_RESET_COMMAND under the turn mutex

Branch `trident/reset-chat-command` (new PR vs main). Ports task 4 of the input-modalities-commands work — deliberately left UNBUILT in PR #428 because the originally-planned primitive was verify-before-assert'd as WRONG.

- **WHY the respawn primitive was wrong (verified finding).** `respawnSupervisedSession` (`runtime/adapters/claude-code/persistent/supervision.ts` → `session-respawn.ts`) ALWAYS `--resume`s the same transcript ("respawn is always resume") — it PRESERVES context, so using it for `/reset` would be a no-op-that-looks-done. The owner pinned the design 2026-07-23: `/reset` should behave like sending Claude Code's own `/clear` to the live REPL — clear the MODEL's conversation while the underlying `claude` process (its MCP servers / dev-channel / system prompt) stays alive.
- **The right primitive:** `CONTEXT_RESET_COMMAND = '/clear'` (`signatures.ts:164`), actuated exactly as the per-turn import warm-session reset does (`pool.ts:372-402`, holding the `acquireTurn` mutex).
- **NEW `runtime/adapters/claude-code/persistent/context-reset.ts`** — `resetPooledSessionContext({substrate_instance_id, user_id, project_scope, acquire_wait_ms?, idle_quiet_ms?, idle_max_ms?})`. Prefix-matches warm `pool` entries (`pool-state.ts`) on the first three `SESSION_KEY_SEP`-joined key dimensions (credential dimension WILDCARDED — resolved per-dispatch); the trailing NUL guarantees the 3-dim prefix can't false-match a legacy 2-dim key. For each live session: BOUNDED-acquire the turn mutex (`Promise.race` against `acquire_wait_ms`); if the timeout wins, self-release the still-queued slot via `fireAndForget(acquireP.then(r => r()))` so a later turn is never wedged, and return `busy` having written NOTHING; else, under the mutex, run the `pool.ts:378-385` sequence verbatim (`waitForReplIdle` → `child.write('/clear\r')` → sleep → `waitForReplIdle`). Typed outcome: `{ok, sessions_reset} | busy | no_live_session | reset_failed`.
- **`gateway/boot-chat-command-filters.ts`** — `buildResetChatCommandFilter({reset})` mirroring `buildStatusChatCommandFilter` exactly: `isExactSlashCommand(body, '/reset')` word boundary (`/resetfoo`/`/resets` fall through to the LLM), injected reset thunk, reply text composed from the LIVE outcome via exported `formatResetOutcome` (never a canned success — `busy` / `no_live_session` reply honestly that nothing was cleared). `busy` / `reset_failed` carry a structured `error`; `no_live_session` is informational text with no `error`. Re-exported (fn + `ResetChatOutcome` type) via `gateway/composer-contract.ts` → served through the `gateway/boot-helpers.ts` barrel.
- **`open/composer.ts`** — builds `resetChatCommandFilter` next to `statusChatCommandFilter`, binding the thunk to `resetPooledSessionContext` with `substrate_instance_id: 'cc-agent-' + owner_handle` (matches `open/wiring/substrates.ts` `liveAgentSubstrate`), `user_id: OWNER_USER_ID`, `project_scope: input.project_id ?? 'general'` (mirrors `build-live-agent-turn.ts` `turn.project_id ?? 'general'` — the live pool's project dimension). Appended to `buildChainedChatCommandFilter([...])` after `statusChatCommandFilter`, so BOTH the web onboarding chat and the app-ws chat route `/reset` through one path. No `late<T>` holder — all deps exist at chain-build time.
- **Documented limitation (deliberate non-goal):** when NO warm session exists for the scope (e.g. right after a gateway restart, before any turn), `/reset` replies `no_live_session` honestly — but a later cold spawn may `--resume` the prior transcript from the repl-registry, so context is not cleared in that edge. Full cold-reset semantics would need registry surgery on the respawn-is-always-resume machinery, out of scope per the owner's pinned live-session design.
- **Tests:** NEW `gateway/__tests__/reset-command-wiring.test.ts` (claims `/reset`; outcome-derived reply + typed `data`; project_id threading + omission; whitespace/trailing-args tolerance; `/resetfoo`/`/resets`/prose fall through AND never invoke the reset thunk; busy/no_live_session/reset_failed → correct text + `error` shape; chained-last wiring; `formatResetOutcome` variants). NEW `runtime/adapters/claude-code/persistent/__tests__/context-reset.test.ts` — REAL PTY-write behavior (harness cloned from `import-warm-session-reset.test.ts` with a controllable reply gate): warm turn → reset writes exactly one literal `'/clear\r'` AFTER the message and the process survives (spawnCount 1, subsequent turn completes); scope isolation (proj-A reset never touches proj-B; cold scope → no_live_session); busy path (mid-turn reset → busy, writes nothing, then a later turn still runs — proving the abandoned mutex slot self-released); wait-then-proceed (generous budget rides out the turn then clears); empty pool → no_live_session.
- **Gates:** `bunx tsc --noEmit` clean; `bash scripts/ci/lint.sh` all gates green (incl. the void-promise gate for the detached self-release); `bash scripts/ci/depcruise.sh` 0 new violations (baseline untouched). Regression: `import-warm-session-reset.test.ts` + `status-command-wiring.test.ts` green. NO FEATURE FLAGS.

## 2026-07-22 — Dogfood PR #429 Argus r2 on task 10: budget-floor clamp (unrunnable sub-floor deep-research budget) + unbound chat-ack dedup collision + Sonnet dispatcher default

Branch `trident/dogfood-fixes-jul21` (PR #429). Argus round-2 raised one CONFIRMED major (codex veto) + one code-verified minor + two non-blocking nits on the task-10 tool loop. Fixes (all additive, NO feature flags):

- **MAJOR — `budget_ms < ~20s` deterministically failed deep research with a misleading zero-tool error.** The agentic loop reserves `FINALIZE_MARGIN_MS` (20s) of every budget for the forced final-answer turn, so any `budget_ms` below that made the sub-agent finalize on iteration 1 with ZERO tool calls; with `tools_available: true` that trips the orchestrator's grounding gate and fails the whole run with "sub-agent made zero tool calls" whose REAL cause is an unrunnable budget. `budget_ms` was exposed unvalidated on the MCP `research_deep` surface. FIX: new `SUB_AGENT_MIN_BUDGET_MS = 60_000` floor (`cores/free/research/src/manifest.ts`); `dispatchResearchSubAgent` (`sub-agent.ts`) now resolves `budget_ms` robustly (non-finite / non-positive → default, never poisoning `Math.max`/`setTimeout`) THEN clamps UP to the floor. The floor covers BOTH the outer `runWithTimeout` race and the inner dispatch (shared `budget_ms`), so the loop always has room for ≥1 real tool round + the finalize turn. Added an injectable `min_budget_ms` DI-default seam (like `now`) so timeout-path tests still drive tiny budgets; production never sets it.
- **MINOR — unbound `build_dispatched` acks collided on one dedup key.** `work-board/chat-ack.ts` keyed dedup on `${item_id}\0${kind}`; a chat-dispatched build with no board item posts `item_id: ''`, so every unbound build within the 30s window shared `\0build_dispatched` and the 2nd distinct build's ack was silently swallowed. FIX: key is now `${project_id}\0${item_id}\0${kind}\0${title}` — different unbound builds (different titles) each ack; a genuine double-fire of the SAME event still dedups; cross-project events no longer collide.
- **NIT cleanup — `buildRuntimeResearchSubAgentDispatcher` `default_model` fallback was `FAST_MODEL`** (dead on the live path — `sub-agent.ts` always threads Sonnet), contradicting task-7's Sonnet-for-deep-research intent. Changed to `SONNET_MODEL`; removed the now-unused `FAST_MODEL` import + stale comments.

The two remaining r2 nits (grounding gate counting failed tool calls as grounding; the same finalize-margin behavior described above) are intended-per-spec / covered by the floor and left as-is.

Tests: `cores/free/research/__tests__/sub-agent.test.ts` +5 (below-floor clamp; at/above-floor passthrough; omitted→default; non-finite/non-positive→default; `min_budget_ms:0` seam) + 3 existing fast-timeout tests updated to pass `min_budget_ms:0`. `work-board/chat-ack.test.ts` +3 (two unbound different-title builds both post; same unbound build dedups; cross-project empty-item events not suppressed). Green: `bun test cores/free/research work-board` 502 pass / 2 skip / 0 fail; `tsc -p cores/free/research` + `tsc -p work-board` exit 0. NO FEATURE FLAGS.

## 2026-07-22 — Dogfood PR #429 Argus r1 BLOCKER on task 10: cancel a timed-out research sub-agent dispatch so it stops burning LLM/tool resources after its concurrency slot is released

Branch `trident/dogfood-fixes-jul21` (PR #429). Argus round-1 raised one CONFIRMED BLOCKER on the task-10 tool loop (corroborated by a second reviewer's finalize-race nit): `runWithTimeout` (`cores/free/research/src/sub-agent.ts`) is a bare `Promise.race` with NO cancellation, and its `finally` releases the concurrency slot on timeout — but the underlying agentic `dispatch()` loop (`substrate-runtime.ts`) had no abort signal, so an `llm_call` resolving AFTER `budget_ms` kept running: it would parse the response, execute the requested tool, and issue the forced-finalize `llm_call` — all under a slot a NEW job had already claimed. The per-owner concurrency/budget guarantee was broken (an orphaned run could burn a second slot's worth of LLM + tool calls indefinitely).

FIX — cooperative cancellation via `AbortSignal` (additive, no feature flag):
- **`cores/free/research/src/sub-agent.ts`** — `RuntimeSubAgentDispatchInput` gains additive-optional `signal?: AbortSignal`. `dispatchResearchSubAgent` now creates an `AbortController`, threads `controller.signal` into `dispatch()`, and calls `controller.abort()` in the `finally` (alongside `release()`). The `finally` fires on timeout, error, AND success — on timeout this is exactly what tells the orphaned loop to stop; on success/error the dispatch has already settled so the abort is a harmless no-op. The canned dispatcher ignores the field → byte-identical.
- **`cores/free/research/src/substrate-runtime.ts`** — new exported `SubAgentDispatchAbortedError`. The emulated tool loop now calls a `throwIfAborted()` guard (a) at the top of every round (prevents issuing the next `llm_call` / forced-finalize turn after a tool result), and (b) immediately after each `await opts.llm_call(...)` resolves (prevents parsing + tool-execution + any further round on a call that only completed AFTER the outer race already tripped). The thrown rejection is discarded by the outer `Promise.race` (which already rejected with `SubAgentTimeoutError`); its only job is to halt the loop. The v1 tool-less single-call path is untouched (byte-identical).

Single-reviewer minors/nits from r1 (budget_ms ≤ FINALIZE_MARGIN_MS round-0 forced finalize; the intended zero-tool grounding behavioral change; forced-turn tool_call-envelope-as-text; partial-executor rider mismatch) are all non-production-reachable / "bounded and safe" / intended-per-spec and are NOT defects — left as-is.

Tests: `cores/free/research/__tests__/substrate-runtime-tool-loop.test.ts` +T9 (signal aborted while an `llm_call` is in flight → loop throws `SubAgentDispatchAbortedError`, executes NO tool, issues NO second `llm_call`) +T10 (already-aborted signal → zero `llm_call`s, throws immediately). `cores/free/research/__tests__/sub-agent.test.ts` +2 (outer budget timeout releases the slot AND aborts the signal handed to the dispatcher; successful dispatch also aborts the signal on completion — idempotent cleanup). Green: `bun test cores/free/research` 209 pass / 2 skip / 0 fail; `tsc --noEmit -p tsconfig.json` exit 0. NO FEATURE FLAGS.

## 2026-07-22 — Dogfood PR #429 task 10: agentic tool loop in the research_deep sub-agent dispatcher (real vault/web tool grounding)

Branch `trident/dogfood-fixes-jul21` (PR #429). Discovered-root-cause follow-up to task 7. WHY: `research_deep`'s production sub-agent dispatcher (`buildRuntimeResearchSubAgentDispatcher`) was the v1 single-call adapter whose own docstring said "tool-calling is deferred" — it always returned `tool_calls: []` + `tools_available: false`, while the Atlas system prompt (`sub-agent-prompt.ts`) MANDATES research_vault_search/research_web_search/research_web_fetch use. So even on Sonnet (task 7), deep research was closed-book: every claim could only be `confidence:"unverified"`. ROOT-CAUSE CONSTRAINT (planner-verified): native Anthropic Messages-API `tools`/tool_use blocks are impossible here — production `llm_call` is `buildResearchLlmCallForOwner` (`gateway/boot-research-wiring.ts:53-84`) packing system+user into `AgentSpec.prompt` on the CC-subprocess substrate, whose `respondToTool` THROWS (`gateway/wiring/build-llm-call-substrate.ts:915,922`), and direct Anthropic HTTPS is forbidden (`build-anthropic-messages-client.ts:12-20`).

FIX — EMULATE the tool protocol over sequential text `llm_call` rounds (NO feature flags; real default):
- **`cores/free/research/src/substrate-runtime.ts` — the loop.** New exported types `ResearchSubAgentToolExecutor` / `ResearchSubAgentToolExecutors`; new consts `DEFAULT_MAX_TOOL_ROUNDS=6`, `TOOL_RESULT_MAX_CHARS=30_000`, `FINALIZE_MARGIN_MS=20_000`, exported markers `TOOL_CALL_BLOCK_MARKER`, `TOOL_RESULT_BLOCK_MARKER(name)`, `FINALIZE_MARKER`. Options extended (all additive/optional): `tool_executors`, `max_tool_rounds`, `now`. The dispatcher advertises a strict JSON envelope `{"tool_call":{"tool","input"}}` in a module-level `toolProtocolRider(offered)` appended to the sub-agent system prompt (per-tool input-shape hints; plain hyphens, no em dashes), executes the named executor via the injected map, threads a `[TOOL_RESULT <name>]` block into the next round's user prompt (`extractJson`-parsed each round), and loops until the model emits the final brief JSON. Bounded by `budget_ms` (a `FINALIZE_MARGIN_MS` pre-check per round forces the final-answer turn) + `max_tool_rounds` (forced `[FINAL ANSWER REQUIRED]` last turn). Unknown-tool + throwing-executor + `{error}`-returning-executor all thread an error result and record `success:false` while the loop continues; oversized results truncate to `TOOL_RESULT_MAX_CHARS` with a `...[truncated N chars]` suffix. Returns real `tool_calls` + `tools_available: true`. When NO executors are supplied (or none of the requested tools have one), it makes ONE tool-less `llm_call` returning `tool_calls: []` + `tools_available: false` — byte-identical v1 back-compat (degradation, not a flag). Outer `dispatchResearchSubAgent` `runWithTimeout` still races the whole dispatch against `budget_ms`; the internal margin lets the loop self-finalize first.
- **`cores/free/research/src/sub-agent.ts`** — `RuntimeSubAgentDispatchInput` gains additive-optional `project_id` (per-project scoping for tool executors); `dispatchResearchSubAgent` threads `input.project_id` into the dispatch call. `ResearchSubAgentToolCall` shape unchanged.
- **`cores/free/research/src/wiring-production.ts`** — builds the three REAL executors and threads them: `research_vault_search` (resolves the project sidecar via the SAME `ResearchStoreResolver` + runs `searchPriorBriefs`), `research_web_search` (`buildTavilyProvider` + `webSearch`; key re-read PER DISPATCH from a new `tavily_api_key` getter; graceful no-key degradation message), `research_web_fetch` (`webFetch` with its `DEFAULT_WEB_FETCH_ALLOWLIST` + SSRF/DNS-pin guards intact). Each executor is TOTAL (outer try/catch → `{error}`; bad-shape input → `{error: 'invalid input: ...'}`). Manifest now resolves BEFORE the dispatcher. New additive options: `tavily_api_key`, `web_search_fetcher`, `web_fetch_fetcher`, `web_fetch_lookup` (test seams).
- **`gateway/cores/mount-open-cores.ts`** — threads `tavily_api_key: () => input.secretsStore.get({ owner_handle: ownerHandle, kind: 'byo_api_key', label: 'tavily' })` into `buildProductionResearchCoreWiring` (re-read per dispatch → a key pasted in Settings lands without restart).
- **`cores/free/research/index.ts`** — exports the new executor types + loop consts/markers.

This ARMS task 7's zero-tool grounding gate in production: a deep run that goes straight to the brief (zero tool calls) now retries once then fails by design.

Tests: new `cores/free/research/__tests__/substrate-runtime-tool-loop.test.ts` (T1 envelope→executor→threaded-result→final; T2 round cap → 3 llm calls; T3 budget cap → 2 llm calls via injected `now`; T4 unknown tool; T5 throwing executor; T6 v1 back-compat single call; T7 offered-intersection-empty → v1 path; T8 truncation cap); new `cores/free/research/__tests__/wiring-production-tools.test.ts` (real vault round through `deep()` completes + threads `{"hits":[]}`; web_fetch allow-list reject; tavily-absent degradation; tavily-with-key hits via a stub fetcher); UPDATED `gateway/__tests__/research-core-production-composer.test.ts` (harness `llm_call` scripts a vault tool round on the Atlas first turn so the now-armed gate is satisfied). Green: `bun test cores/free/research` 205 pass / 2 skip / 0 fail; `bun test gateway/__tests__/research-core-production-composer.test.ts gateway/__tests__/research-core-mcp-default-project-and-lazy-resolve.test.ts gateway/__tests__/cores-integrations-surface.test.ts` 26 pass / 0 fail; `tsc -p cores/free/research` + `tsc -p gateway` exit 0. Pre-existing depcruise `cores-use-sdk-only` edges (`sub-agent.ts`/`email/tools.ts`/`code-gen` → `runtime/models.ts`, from tasks 7/8) and the task-2 void-promise gate finding are unchanged by task 10 (no NEW layering violation; +4 cruised deps). NO FEATURE FLAGS.

## 2026-07-22 — Dogfood PR #429 task 8: de-hardcode 4 Claude model-id literals through runtime/models.ts resolver

Branch `trident/dogfood-fixes-jul21` (PR #429). The owner: 'that's bad design' — `runtime/models.ts` docstring says 'never hardcode a Claude model id outside this file', yet 4 code literals escaped the resolver. Tasks 1–7 already fixed the 2 research-core literals in task 7. These 4 remain:

- **`tasks/prioritize-llm.ts` — `DEFAULT_TASK_PRIORITIZE_MODEL`.** Was `'claude-haiku-4-5'` (bare literal); now `= FAST_MODEL` (imports `@neutronai/runtime/models.ts`). Exported const is preserved; used at `:137` and re-exported via `tasks/index.ts:55`. `tasks` already declared `@neutronai/runtime` in its package.json — no dep change. LIVE-DEFAULT NOTE: `gateway/composition/build-core-modules.ts` passes `model` only when config supplies one; composition that omits the model key gets this default. Live behavior changes `'claude-haiku-4-5'` → `FAST_MODEL` (`'claude-haiku-4-5-20251001'` by default, `NEUTRON_FAST_MODEL`-overridable). Both ids carry identical pricing rows in `model-pricing.ts:106,:115` — benign.
- **`gateway/tasks/p6/nudge-engine.ts` — `DEFAULT_NUDGE_MODEL`.** Same pattern. Was `'claude-haiku-4-5'`; now `= FAST_MODEL`. Same live-default note as above.
- **`cores/free/email/src/tools.ts` — `resolveModel()` fallback.** Was `return m ?? 'claude-haiku-4-5-20251001'`; now `return m ?? FAST_MODEL`. Default is byte-identical (`FAST_MODEL` resolves to `'claude-haiku-4-5-20251001'`). Import shape mirrors `research-orchestrator.ts:17` (the CI-green cores-band precedent). `email` package.json already declared `@neutronai/runtime`.
- **`cores/free/code-gen/src/substrate-runtime.ts` — `buildCannedCodegenLlmCall` default model.** Was `model: chosen.model ?? 'claude-sonnet-4-6'`; now `= SONNET_MODEL`. Added `"@neutronai/runtime": "workspace:*"` to `cores/free/code-gen/package.json` dependencies (alphabetical, after `@neutronai/prompts`); ran `bun install` to update lockfile.

DO-NOT-TOUCH honoured: the 3 `'claude-haiku-fallback'` DI sentinels (`mcp-tools-extra.ts:146`, `calendar-wiring.ts:223`, `mount-cores-scribe-fan-out.ts:300`) — confirmed benign per-call DI-default placeholders; comments in `auth/max-oauth.ts` and `model-update-watchdog.ts`; `config/index.ts:52-55` VERBATIM-FIDELITY defaults table.

Tests (4 new test blocks, all compare against the IMPORTED const, never a re-hardcoded literal): `tasks/__tests__/prioritize-llm.test.ts` — `DEFAULT_TASK_PRIORITIZE_MODEL === FAST_MODEL`; `gateway/tasks/p6/__tests__/nudge-engine.test.ts` — `DEFAULT_NUDGE_MODEL === FAST_MODEL`; `cores/free/email/__tests__/tools.test.ts` — `email_triage` with `deps.model` absent → `triage.model === FAST_MODEL`; `cores/free/code-gen/__tests__/substrate-runtime.test.ts` — canned response with no `model` field → returned `result.model === SONNET_MODEL`. Green: `bun test tasks cores/free/email cores/free/code-gen gateway/tasks` 568 pass / 0 fail; `tsc -p tasks/email/code-gen/gateway` all exit 0; eslint clean.

## 2026-07-22 — Dogfood PR #429 task 6: chat text-input lag — make the web chat render fan-out identity-stable

Branch `trident/dogfood-fixes-jul21` (PR #429). The owner dogfooding: typing in the web chat text box feels laggy, not snappy like Telegram. ROOT CAUSE (planner render-count probes against the REAL installed `@assistant-ui/react` 0.14.23; the earlier "profile first" framing is satisfied by this evidence): `landing/chat-react/controller.ts` `computeVm()` rebuilt FRESH `RenderMessage` objects (`durable.map(...)`) AND a fresh `messages` array on EVERY `publish()` — 20 call sites, including PER STREAMING TOKEN (`agent_message_partial`). assistant-ui caches its message→ThreadMessage conversion by message OBJECT identity and memoizes each row on it; a fresh identity every publish busted BOTH, so probes measured all 30/30 rows re-converted + re-rendered per publish (vs 0 with stable identities) → a full un-memoized react-markdown re-parse of the WHOLE transcript per token/frame. That main-thread load is the typing lag. REFUTED as the cause: keystroke fan-out through the assistant-ui composer store (0 message re-renders) and parent re-renders alone (assistant-ui memoizes rows internally). Fix (all web, NO feature flags — single live path):

- **`controller.ts` — computeVm is now IDENTITY-STABLE, content byte-identical.** New `private renderCache = Map<string, RenderMessage>`. Each `computeVm` builds each durable row candidate exactly as before, then reuses the PRIOR object (`renderCache.get(id)`) when a total flat comparator `sameRenderMessage(prev, next)` says they're structurally equal, writing the chosen object into a fresh `nextCache` (which auto-prunes vanished ids); live stream bubbles are cached the same way under `stream:<messageId>` (a token append changes `text` → new identity, correct; an unrelated publish mid-stream reuses the bubble). After building the `messages` list, if the PREVIOUS vm's array is the same length with every element reference-equal, the PRIOR array is reused (guarded — the first computeVm runs from the constructor before `this.vm` exists). `sameRenderMessage` is a module-level TOTAL comparator: `===` on every scalar field + flat length/element compares for `attachments` / `reactions` / `options` / `uploadAffordance` (no JSON.stringify, no deep recursion) — a false "equal" would freeze a real update, so it covers every field the VM emits. Outputs are unchanged; ONLY object identities change, so the existing `controller.test.ts` stays green untouched.
- **`ChatApp.tsx` — render-stable context values + selector-ized composer.** Extracted exported hooks `useUploadsCtx(config, fetchImpl)` (memo on `[token, origin, fetchImpl]`) and `useDocLinkCtx(origin, onOpenDocLink)` (memo on `[origin, onOpenDocLink]`; `onOpenDocLink` is a verified-stable `useCallback` at ProjectShell.tsx). Previously both were fresh object literals per render, and a context value change BYPASSES `React.memo` straight into every `AttachmentImage`/`TextPart`. The `Composer` now subscribes to a BOOLEAN selector `useComposer((s) => s.text.trim().length > 0)` and reads the live text imperatively in `send()` via `composerRuntime.getState().text` — so a keystroke re-renders the composer subtree only when the Send button's enabled state flips (empty↔non-empty), not on every character.
- **`Markdown.tsx` — `React.memo` + memoized `components`.** The component export is wrapped in `memo` (an agent bubble whose `text` is unchanged now skips the react-markdown re-parse entirely) and the per-render `components={{pre, a}}` object is hoisted into a `useMemo` keyed `[onDocLink, origin]`. The module-const remark/rehype plugin arrays were already stable.
- **Tests — new `landing/chat-react/__tests__/render-isolation.test.tsx` (4 groups, 7 cases).** T1 (pure controller): an unrelated `projects_changed` publish keeps the SAME `messages` array + every row identity; a streaming token changes the array + ONLY the stream bubble, reusing every durable row; a `reaction_update` changes EXACTLY that row, siblings reused. T2 (end-to-end over the REAL `useChatRuntime` + controller under `AssistantRuntimeProvider` + `ThreadPrimitive.Messages` with counting message/part components, 20 messages): an unrelated frame → 0 durable-row re-renders; 3 streaming tokens → total row re-renders bounded by a small constant (≤15) and 0 for every durable row, NOT O(transcript). T3: `useUploadsCtx`/`useDocLinkCtx` return reference-equal values across host re-renders with unchanged inputs, new identity on input change. T4: `Markdown.$$typeof === Symbol.for('react.memo')` + stable DOM across a parent re-render. Green: `bun test landing/chat-react` 405 pass / 0 fail (398 prior + 7 new; controller/component/snapshot-stability suites untouched); `tsc -p landing/chat-react` + eslint clean. `useNeutronChat.ts` (the #354 adapter memo + SEV1 per-conversation runtime keying) untouched. NO FEATURE FLAGS.

## 2026-07-22 — Dogfood PR #429 task 5: per-project opening variance — de-template the kickoff opening_message prompt + has_context-first work-signal gate

Branch `trident/dogfood-fixes-jul21` (PR #429). The owner dogfooding: some newly-created projects opened with a rich, project-specific starting-plan presentation while others got a generic hardcoded opener, and the rich ones all read like the same message with the nouns swapped. TWO verified root causes, both fixed here.

- **PROMPT CONVERGENCE (`gateway/wiring/build-project-kickoff-composer.ts`).** The `opening_message` system prompt mandated a fixed 3-beat sentence plan including the verbatim beat "that you took a first pass and drafted a starting document, and invite the owner to review it and tell you what to change" — so every opener was that template with nouns swapped. Rewrote the branch to KEEP the hard invariants (output only the message text, 2-3 sentences, second person, grounded ONLY in context / no invented facts, mention the drafted doc so the appended tappable link lands, no links/filenames, no greetings, no em dashes) but BAN stock template phrasing + a fixed sentence order and instruct leading with THIS project's most specific content, so two projects never read alike. The comment block now marks the beats FUNCTIONAL, not verbatim-mandated. Token budget, timeout, `userPrompt()`, and the draft_doc/interest_brief prompts are untouched.
- **GATE STARVATION (`onboarding/openings/kickoff.ts`).** `hasWorkSignal()` required open_threads OR summary/slices OR (rationale AND topics) — strictly divergent from the materializer's own data-sufficiency verdict `MaterializeOutcome.has_context` (`project-materializer.ts` = importCtx || slices; importCtx = `hasRealProjectContext`, which counts the owner's OWN captured `project.rationale`). That owner-stated rationale never reaches `KickoffSignal` (only import-derived `matched` carries rationale — `finalize.ts`), so an owner-described work project with no import match had `has_context=true` yet failed the gate and fell to the generic deterministic opening, while an import-matched sibling got the rich starting-plan doc — the owner's exact variance. `KickoffSignal` now carries `has_context` (from `input.outcome?.has_context ?? false`); `hasWorkSignal` checks it FIRST as the single source of truth, and loosens the outcome-null fallback rationale AND topics → OR (aligned with `hasInterestSignal`). A bare deterministic-template README with no outcome and no import signal STILL does not qualify — the "better nothing than a bad job" line holds, and `has_context:false` projects keep the honest no-context prompt via `buildNoContextProjectOpening`.
- **Tests (`gateway/wiring/__tests__/build-project-kickoff.test.ts`).** Existing helpers default `has_context:false` + `matched:null`, so the thin-work→null non-regression anchor stays green unchanged. Added: work project with has_context alone (owner-described, matched:null, zero slices/summary/threads) → draft-doc; rationale-only match with NO materializer outcome → draft-doc (the AND→OR loosening); and an opening_message prompt-contract test on the REAL `buildProjectKickoffComposer` via a capturing fake client — asserts the OLD mandatory beat is gone, the vary-phrasing instruction + appended-link note are present, and the call rides `OPENING_MESSAGE_MAX_TOKENS`. Green: `bun test gateway/wiring` 613 pass / 0 fail; `tsc -p onboarding` + `tsc -p gateway` + `tsc -p open` clean; eslint clean. NO FEATURE FLAGS.

## 2026-07-22 — Dogfood PR #429 Argus r2 round-3: chat-ack dedup-ordering + cumulative correction-pattern occurrences + astral-safe title truncation

Closes the three surviving Argus round-2 findings on the task-4 branch (the BLOCKER + minor #4 + nit #5 were already resolved in commit `8b5cad1f`; this round takes the two remaining majors + the truncation nit).

- **`work-board/chat-ack.ts` (major): dedup stamp now recorded AFTER a successful post, not before.** The dedup memo `lastPostedAt.set(key, t)` previously ran *before* `resolve_chat_id` + `post`; since the whole body is try/catch-swallowed, a throw in chat-id resolution or transport left the `(item, kind)` entry stamped with no ack ever delivered — muting every retry for the full 30s window. Moved the stamp to run only after delivery returns, so a failed attempt leaves no stamp and an in-window retry can still land once transport recovers.
- **`scribe/reflect/correction-patterns.ts` + `reflect-pass.ts` (major): promoted correction-pattern pages keep a CUMULATIVE occurrence count/list.** `writeEntity` renders `compiledTruth` as a full replacement, so recomposing the page from the current scan window alone shrank an already-promoted page's `Observed N times` count + `## Occurrences` list whenever an older occurrence aged out of the window (the timeline itself was preserved by the writer's append+dedupe, but the human-readable body regressed). `composePatternPage` now takes an optional `priorOccurrences` (the existing page's persisted `reflect:correction-pattern` timeline rows, keyed `<ts>\x1f<body>` byte-identical to `correctionOccurrenceKey`) and UNIONs them into the count + timestamp list; `reflect-pass.ts` finds the existing page first and feeds its rows in. Learning/title/why still derive from the newest current member; timeline rows are still emitted for the current cluster only (no double-write — the writer dedupes).
- **`work-board/chat-ack.ts` (nit): `truncateTitle` measures + slices by code POINTS (`Array.from`), not UTF-16 code units** — an astral char (emoji) straddling the cut index no longer yields a lone surrogate before the ellipsis.
- **Tests.** `work-board/chat-ack.test.ts`: failed-post leaves no dedup stamp (retry re-delivers, then the success dedups); failed-resolve leaves no stamp; astral-heavy title truncates with no unpaired surrogate. `scribe/__tests__/correction-patterns.test.ts`: prior persisted rows unioned into count+list; a prior row already in the window isn't double-counted; no-prior path byte-identical to old behavior. Green: `bun test work-board scribe` 431 pass / 0 fail; `tsc -p work-board` + `tsc -p scribe` clean. NO FEATURE FLAGS.

## 2026-07-22 — Dogfood PR #429 task 4: deterministic chat ack when chat-dispatched work hits the board (+ doctrine spoken-ack)

Branch `trident/dogfood-fixes-jul21` (PR #429). The owner dogfooding: dispatching work from a project chat pops the Work pane instantly but the CHAT stays silent — so it looks like nothing happened. ROOT CAUSE (verified): the live agent is a warm Claude Code REPL whose ONLY chat output is the dev-channel `reply()` tool — exactly ONE per turn, landing at TURN END (`runtime/adapters/claude-code/persistent/dev-channel-impl.ts`; Stop hook `hooks/enforce-reply.ts`; a 2nd reply is turn-id-rejected). A chat-dispatched INLINE job runs INSIDE that turn (doctrine `gateway/wiring/operating-doctrine.ts`) for up to 45 min (`gateway/wiring/build-live-agent-turn.ts` TURN_ABSOLUTE_CEILING_MS), while the card fires `work_board_changed` immediately via the store's `onChange` — so the pane updates but chat is silent until the turn settles, and a spoken ack depended entirely on the model choosing to speak. There is no per-block/mid-turn text delivery to fix (terminal text is invisible by design), so the fix is a deterministic out-of-band post.

- **NEW `work-board/chat-ack.ts` — `buildWorkBoardChatAck({ resolve_chat_id, post, now?, dedup_window_ms? })`.** A tiny side-effect-only poster the AGENT-TOOL layer calls the moment a chat-dispatched board mutation succeeds, putting a short agent-style one-liner into the originating chat RIGHT AWAY — independent of the turn's own reply(). Three kinds: `card_added` (`▸ On the Work Board: "…"`), `build_dispatched` (`⑂ Build dispatched: "…" — running autonomously; the result will post here when it lands.`), `inline_started` (`› Working on "…" now — I'll post here when it's done.`). NEVER throws (whole body try/catch-swallowed — the ack must never perturb a tool result). Per-`(item_id, kind)` 30s dedup (a reconciliation/double-fire can't double-post the SAME event; DIFFERENT kinds for one item — add→dispatch in a turn — both post). Titles > 96 chars truncate to 95 + `…`. Stale memo entries pruned lazily per post.
- **Agent-tool hooks (agent surface ONLY, `work-board/agent-tool.ts`).** `registerWorkBoardToolSurface` opts gains `chatAck?`. `work_board_add` posts `card_added` after a SUCCESSFUL create (both the specDoc and plain-store branches); a validation-failed add posts nothing. `work_board_update` reads the row BEFORE the update and posts `inline_started` ONLY on an `inline_active` false→true flip (true→true and inline-less patches post nothing). Absent `chatAck` → byte-identical to before.
- **Trident build-tool hooks (`trident/work-board-build-tool.ts`).** `TridentBuildToolDeps` gains `chat_ack?`. `work_board_dispatch_build` + `work_board_start` post `build_dispatched` AFTER a successful `dispatchBoardBoundBuild` (title from the bound item via `deps.work_board.get`, else the first line of `task` truncated). A REJECTED/underspecified/unknown dispatch posts NOTHING — the agent must ask the clarifying question (#337 covers that path).
- **Composer wiring (`open/composer.ts`), DI presence NOT a feature flag.** ONE shared `buildWorkBoardChatAck` instance built from `tridentDeliveryChatId` (project_id → chat topic) + `buildClarifyPoster.post?.` (the #337 durable+live app-ws seam — persists AND fans live "exactly like a normal agent reply"; `.post?.` dereffed at fire time so late-binding is a safe no-op). Threaded through `gateway/composition/input/misc-input.ts` (`work_board?.chat_ack`, `trident_build_dispatch?.chat_ack`) + `build-core-modules.ts` into both tool surfaces. Open always wires it; NO env gate. Human HTTP work-board adds and the ▶ HTTP route post nothing (they never call it); cron/reminder tool calls with null project_id acking into General is accepted.
- **Doctrine (`gateway/wiring/operating-doctrine.ts`).** Appended one sentence to the always-rendered board principle (`DOCTRINE_PRINCIPLES[5]`): the automatic confirmation is mechanical, so the agent's own reply must STILL acknowledge the work in its voice — what it's doing, how it runs (inline now vs a dispatched autonomous run), and that results will post here. `BUILD_ROUTING_DOCTRINE` unchanged.
- **Tests.** New `work-board/chat-ack.test.ts` (exact text per kind + truncation, resolver receives project_id incl. null→General, same-(item,kind) suppressed / different-kind not / different-item not / after-window reposts / custom window, injected clock, throwing post + throwing resolver swallowed). Ack seams in `work-board/agent-tool.test.ts` (both add branches, validation-fail no-post, inline false→true posts / true→true no-post / no-inline_active no-post, omitted ack no-throw) and `trident/work-board-build-tool.test.ts` (dispatch_build ok → title, rejected/unknown no-post, start ok → title, omitted ack unchanged). Doctrine test pins the spoken-ack sentence. Green: `bun test work-board trident gateway/wiring` 1323 pass / 0 fail; the four task-4 files 68 pass; `bun test gateway/composition open` 536 pass (1 pre-existing environmental flake — the memory_health `/healthz` test times out under concurrent load with Ollama unreachable; passes 2/2 in isolation). `tsc -p work-board/trident/gateway/open` clean; depcruise clean (new `trident → work-board/chat-ack` edge rides the existing package edge, no new cross-band violation).

## 2026-07-22 — Dogfood PR #429 Argus review of the seed-eviction fix: two BLOCKERs (occurrence-key trailing space + personality-suggester lost update)

Branch `trident/dogfood-fixes-jul21` (PR #429). Argus reviewed the persisted-cluster-identity fix (commit `90f99e18`) and raised two CONFIRMED (2-reviewer) BLOCKERs; both fixed here.

- **BLOCKER — occurrence-key truncation stranded a trailing space, silently defeating the seed-eviction fix (`scribe/reflect/correction-patterns.ts`).** `occurrenceBody` = `truncate(oneLine(...), 500)` with NO trailing trim: a 500-char cut landing right after a space kept the trailing space in the LIVE occurrence key, while every disk path (`runtime/entity-format.ts` render, `extractTimeline`, `mergeTimeline`) `.trim()`s the row body. So for any correction whose one-lined `<wrong> → <right>` exceeds 500 chars, the live key never byte-matched the key reconstructed from the persisted page, `resolveClusterSlug`'s occurrence overlap fell to 0, the fallback slug drifted after seed eviction, and a duplicate/orphan concept page was minted on the live 6h reflect pass — reintroducing the exact identity drift `90f99e18` closed. FIX: `.trim()` after truncate so the live key is symmetric with the persisted (trimmed) row on both sides. One-line change; the persisted-identity mechanism is otherwise unchanged.
- **BLOCKER — background personality-suggestion upsert could regress onboarding phase + resume-window timer via a lost update (`onboarding/interview/live-personality-suggestions.ts`, `onboarding/interview/sqlite-state-store.ts`, `onboarding/interview/state-store.ts`).** The live suggester's fire-and-forget task reads state, runs an up-to-45 s LLM call, then `upsert`s a `phase_state` patch stamping `phase` + `advanced_at` from its STALE pre-call read. The store's UPDATE wrote `phase`/`last_advanced_at` UNCONDITIONALLY (the phase_state MERGE was already safe — it re-reads inside the txn), so a turn that advanced/completed onboarding while the call was in flight got stamped back to the stale phase. FIX: new `preservePhaseAndTimer` flag on `UpsertOnboardingStateInput` — when set AND the row exists, `upsert` preserves the row's CURRENT `phase` + `last_advanced_at` (read inside the same write) while still landing the patch; the caller-supplied `phase`/`advanced_at` become a fallback used ONLY when the row must be re-INSERTed. Applied to both `SqliteOnboardingStateStore` and `InMemoryOnboardingStateStore`; the suggester's write now passes `preservePhaseAndTimer: true`. No CAS/rollback complexity; a foreground write (which owns the transition) omits the flag and is unchanged.
- **Tests.** `scribe/__tests__/correction-patterns.test.ts` — new 500-char-boundary describe: the live key has no trailing space and equals the key rebuilt from the persisted timeline-row body (both RED pre-fix). `scribe/__tests__/reflect-pass.test.ts` — new pass-level seed-eviction-at-the-boundary test (>500-char shared body; ONE page, no duplicate at the drifted slug — RED pre-fix, verified). New `onboarding/interview/__tests__/state-store-preserve-phase-timer.test.ts` (both store impls): a stale background write with the flag does NOT regress a concurrent advance and still lands its patch; without the flag it DOES clobber (proves the flag is load-bearing); absent-row falls back to INSERT. Suites green: `scribe/__tests__/{correction-patterns,reflect-pass}.test.ts` 54 pass; `bun test onboarding/interview` 564 pass; `tsc --noEmit` clean.

## 2026-07-22 — Dogfood PR #429 Argus r2 round-2: correction-pattern slug BLOCKER + personality anchor/fingerprint hardening

Branch `trident/dogfood-fixes-jul21` (PR #429). Argus round-2 raised a CONFIRMED (2-reviewer) BLOCKER on the correction-pattern slug plus three single-reviewer minors/nits on the live personality suggester. Note on scope: reviewer B measured PR #429 at 8,532 insertions / 72 files — that was against a stale local `main`; the executor-mode subsystem (`reminders/ritual-registration.ts`, `runtime/backlink-repair.ts`, `tools/approval.ts`, migration 0107) landed on `main` via #426/#427 and is NOT in this branch's diff. Against `origin/main` the branch is 2,077 insertions / 21 files. The out-of-scope executor findings (`ApprovalManager.cancelPending` returning true for an already-expired row; `backlink-repair` `stats.repaired` over-count) live in files this branch does not touch — logged for whoever owns those files, not fixed here.

- **BLOCKER — correction-pattern slug was NOT window-invariant, and same-slug collisions silently dropped occurrences (`scribe/reflect/correction-patterns.ts`, `scribe/reflect/reflect-pass.ts`).** The interim `stablePatternSlug` derived identity from the digest of the tokens present in a MAJORITY of the cluster's CURRENT `right`-field members. "Majority over current membership" is a function of which members are in the 200-scan window, so as members age in/out the majority set shifts and the slug moves for the SAME lesson (reviewer's counterexample: `right` of `alpha beta`/`alpha gamma`/`beta gamma` → majority {alpha,beta,gamma}; swap one member for `gamma delta` → {alpha,gamma} → different slug → duplicate/orphan page). FIX (a): `stablePatternSlug` now derives from the cluster SEED (its oldest member) alone — the digest of the seed's sorted, de-duplicated `right` vocabulary. `clusterCorrections` already seeds each cluster on its oldest member and later occurrences JOIN it, so the seed is a membership-INDEPENDENT anchor; adding/removing non-seed members no longer moves the slug. (Honest bound: not absolutely window-invariant — if the seed itself ages out, the next-oldest becomes the seed, but its `right` is near-identical by the same premise, so the slug is stable in practice and strictly more so than either prior scheme. The over-claiming "WINDOW-INVARIANT" comments were corrected across both files.) FIX (b): `promoteCorrectionPatterns` now MERGES qualifying clusters that derive the same slug into one page BEFORE writing. Two distinct clusters (low full-text Jaccard, never clustered together) can share a seed `right` vocabulary → same slug; without merging the first cluster's create succeeded and the second hit a CAS conflict (`ifBodyEquals: null` vs the now-existing page) and its occurrences were silently dropped forever, never self-healing. Merging appends both clusters' timeline rows to one page (rows dedupe on `(ts,source,body)`).
- **minor — personality anchor race (`onboarding/interview/live-personality-suggestions.ts`).** A pick RENDERED on turn N could fail to settle `agent_personality` when tapped on turn N+1 if a mid-turn signal change regenerated the memo to a different personalized set in between (`candidatePersonalityAnchorNames` unioned only the CURRENT memo, so the tapped name was no longer an anchor). FIX: new append-only `personality_character_anchor_history` phase_state key accumulates every name ever persisted as an `'llm'` memo; `candidatePersonalityAnchorNames` unions it, so any previously-rendered name still anchors after a regeneration. Written in `maybeKickoff`'s persist path (de-duped, case-insensitive).
- **nit — `signalsFingerprint` was array-order-sensitive.** `['a','b']` vs `['b','a']` produced different fingerprints, forcing an avoidable ~45s Opus regeneration of a frozen memo. FIX: sort copies of `primary_projects`/`non_work_interests` before stringify (the fingerprint tracks WHICH signals are known, not their storage order); the caller's arrays are untouched.
- **nit — stale comment in `onboarding/interview/onboarding-preamble.ts`** claimed the personality option renders "just the name" while the code renders `- name (why)`; comment corrected.
- **Tests.** `scribe/__tests__/correction-patterns.test.ts` — new discriminating test (majority set shifts while the seed is constant → slug unchanged) + caller-ordering invariance. `scribe/__tests__/reflect-pass.test.ts` — new same-slug-distinct-clusters MERGE test (two clusters, one page, all six occurrences preserved). `onboarding/interview/__tests__/live-personality-suggestions.test.ts` — anchor-history union + malformed-history tolerance + fingerprint order-invariance + history accumulation-across-regeneration. Suites green: `scribe/__tests__/correction-patterns.test.ts` + `scribe/__tests__/reflect-pass.test.ts` 42 pass; `bun test onboarding/interview` 561 pass; `tsc -p scribe` + `tsc -p onboarding` clean.

## 2026-07-21 — Dogfood task 2: wire the REAL Opus personality suggester into the LIVE (Path-1) onboarding

Branch `trident/dogfood-fixes-jul21` (Ralph task 2 of the 2026-07-21 dogfood-night plan, PR #429). The live CC-session onboarding rendered the SAME five static personality names (`DEFINED_PERSONALITY_CHARACTERS`) to every owner, because the Opus-backed `PersonalityCharacterSuggester` (built at `open/composer.ts:1284`) was only consumed by the retired phase machine (`engine-spec-resolution.ts`) — never by the live per-turn step guard. This wires the personalized suggester into the live path WITHOUT ever blocking a turn on the 45s call.

- **New coordinator (`onboarding/interview/live-personality-suggestions.ts`).** `buildLivePersonalitySuggestionCoordinator({suggester, stateStore, owner_slug, seed, fireAndForget})` returns `guardCharacters(phase_state)` (memoized picks `[...personalized, ...wild]` or null → caller keeps the static default) and `maybeKickoff(user_id, st)` (never throws, never awaited). Kickoff fires a background generate iff `agent_personality` is unsettled AND ≥1 real signal is present AND (no memo OR memo not `'llm'` OR fingerprint changed) AND no pending run for this user (per-user `Map` dedup, cleared in `.finally`). Only `source==='llm'` results persist; a fallback persists nothing (next turn retries — mirrors the old engine's stored-but-never-frozen rule). Before writing, the task RE-READS the row (avoid stale-phase clobber, the Codex-P1 lesson) and skips if the row vanished or personality settled meanwhile; the upsert preserves `last_advanced_at` (resume-window timer). Memoizes into the SAME `phase_state` keys the old path uses (`personality_character_suggestions` + `..._source`) PLUS a new `..._fingerprint` (`JSON.stringify([name, projects, interests])`) so picks REGENERATE when the owner's signals change (Path-1 collects them incrementally; personality is asked LAST, so LLM picks land in time) and FREEZE once an `'llm'` memo matches. Also exports `computeSuggesterSignals`/`signalsFingerprint`/`hasAnySignal`/`readLiveCharacterMemo`/`candidatePersonalityAnchorNames`.
- **`personality-character-suggester.ts`** — exports `FALLBACK_CHARACTER_NAMES` (both diverse-fallback pools' names; the pools stay module-private).
- **`onboarding-preamble.ts`** — `StepGuardOptions` gains optional `personality_characters`; `StepGuardCopy.lines(ctx)` receives the set to render (the composer's memoized Opus picks, or the static `DEFINED_PERSONALITY_CHARACTERS` default when absent — byte-identical pre-suggester behavior), rendered as `- name (why)` (parens, never em dashes). The preamble goal-4 no longer enumerates a fixed list; it directs the agent to offer EXACTLY the archetype list named in the per-turn `<onboarding_required_steps>` PERSONALITY block (personalized to this owner), keeping the "Something else (I'll describe it)" escape. `DEFINED_PERSONALITY_CHARACTERS` stays the guard default; `DEFINED_PERSONALITY_CHARACTER_NAMES` stays exported.
- **`button-backed-answer.ts`** — the personality anchor (was the static 5 names) is now `candidatePersonalityAnchorNames(input.phase_state)` (static ∪ 16 pool names ∪ memoized picks), so a tap OR typed answer against ANY rendered list (static, diverse-pool fallback, or LLM picks) still deterministically settles `agent_personality`. The import-decision menu shares no character name, so the two steps stay mutually exclusive anchors.
- **`open/composer.ts`** — builds the coordinator after `onboardingStateStore` (seed = `project_slug`) when `personalityCharacterSuggester !== undefined`; inside `onboardingContext` it calls `maybeKickoff(user_id, st)` then reads `guardCharacters(st.phase_state)` and threads the result into `buildOnboardingStepGuardFragment` options. The generate is never awaited on the turn path. NO feature flag.
- **Tests.** New `__tests__/live-personality-suggestions.test.ts` (zero-signal → no generate; signal → generate once + concurrent dedup; llm → persists the 3 keys with re-read phase + preserved `advanced_at`, guard returns the 5 picks in order; fallback → no persist + retry; fingerprint freeze vs regenerate on a new interest; settled/settled-meanwhile → no kickoff/no write; suggester rejection swallowed; anchor union = static 5 ∪ 16 pool ∪ memo). Updated `onboarding-preamble.test.ts` (guard renders the supplied set exactly / static default when absent; preamble references the guard block, no static enumeration) and `button-backed-answer.test.ts` (tap of a memoized Opus name; tap of a pool name with no memo; typed descriptor after a dynamic menu; import options never anchor personality). `bun test onboarding/interview` 561 pass (was 555 at task-2 land; +6 across the Argus r2 hardening rounds); `tsc -p onboarding` + `tsc -p open` clean. NOTE: reachability (a fresh-install live onboarding turn actually rendering the Opus picks) is verified on the box during the dogfood pass, not in jsdom.

## 2026-07-21 — #380 round-3: React chat-client blank-screen CLASS fix — root auto-recovery + full pane guard sweep

Branch `trident/dogfood-fixes-jul21` (Ralph task 1 of the 2026-07-21 dogfood-night plan). The owner still hit full-app blank screens on doc-fetch 503s AFTER PR #417 (which guarded DocumentsTab only). Root cause (per `landing/chat-react/__tests__/doc-pane-unmount-503.test.tsx` header): a setState-after-unmount surfaces in a real browser commit as React's teardown-phase invariant ("Tried to unmount a fiber that is already unmounted"), thrown from React's OWN commit/teardown phase — so it BYPASSES every error boundary (`PaneErrorBoundary`, `ChatErrorBoundary`, which only catch RENDER errors) and React unmounts the WHOLE root → blank until manual reload. Per-continuation guards are whack-a-mole; this adds the CLASS fix (a root-level net) plus finishes the guard sweep.

- **Part A — root auto-recovery (`landing/chat-react/main.tsx`).** `createRecoveryPolicy({ maxRecoveries: 3, windowMs: 60_000, now? })` — a pure, unit-tested bounded crash policy (rolling window, timestamps pruned outside it). `mount(rootEl, mountConfig, policy, opts?)` calls `createRoot(rootEl, { onUncaughtError })` (React 19.1); the handler consults the policy and SCHEDULES recovery on a macrotask (never synchronously from React's error path): on 'remount' it tears down the dead root, clears the container, and remounts with the SAME controller + OPFS store (both live outside React, so the transcript + session survive); on 'fatal' it paints a VISIBLE error card with a Reload button (`.car-fatal` / `.car-fatal-reload`, styled in `chat-react.html`). A silent blank is now impossible. `performRecovery` + `createRecoveryPolicy` + `mount` are exported for tests. StrictMode kept; `boot()`'s config/store/controller construction untouched.
- **Part B — unmount-guard sweep.** Applied the DocumentsTab alive-ref + abort-reads pattern to every remaining async continuation that touches setState: `IntegrationsTab.tsx` (loadCodex/connect/disconnect/archived/restore/saveKey/clearKey) and `SettingsTab.tsx` (codex status/connect/disconnect, creds list, settings GET/PATCH, add/remove credential, rename, emoji, archive) — both now hold a `mountedRef` + `abortRef`, thread an abort signal into GET reads via a `withSignal` wrapper (writes never aborted), and bail every continuation on `!mountedRef.current`. `ChatApp.tsx` — added alive-ref guards to `TopicRail`'s create-project continuation and `ChatSurface`'s history-import upload continuation (progress + then + catch). Audited and confirmed already-safe (no change): `work-activity.tsx` (subscription unsub + timer cleanup), `PlansPane.tsx` (timer cleanup + synchronous summary callback), `WorkBoardTab.tsx` (already fully `aliveRef`-guarded), `useAttachmentDraft.ts`/`useNeutronChat.ts` (Root-owned / no in-hook setState-after-unmount), `tab-overflow.tsx`/`HtmlDoc.tsx`/`DocSidebar.tsx` (no async setState continuations).
- **Tests (discriminating — each goes RED when its half of the fix is reverted; jsdom cannot reproduce the browser fiber invariant, so they pin the defensive contract, per the doc-pane-unmount-503 standard).** New `__tests__/root-recovery.test.tsx` (7): policy window math (3 remounts then fatal; budget refills after the window; defaults); `performRecovery` 'remount' clears + calls remount, 'fatal' paints the card + Reload button and does NOT remount; `mount()` renders through the onUncaughtError-configured root. New `__tests__/settings-tab-unmount.test.tsx` (3): a credential DELETE settling after unmount does NOT refetch the list (RED if the `mountedRef` guard is removed), an in-flight creds READ is aborted on unmount (RED if the abort cleanup is removed), and a load failure while mounted degrades to the pane-local error while siblings survive. New `__tests__/integrations-tab-unmount.test.tsx` (2): in-flight integrations READ aborted on unmount, load failure degrades locally. All existing pane tests stay green.
- **Round-2 (Argus BLOCKER — concurrent-error root-recovery race).** The `onUncaughtError` handler was inlined in `mount()` and closed over a single `root`; two pane 503s settling within the same macrotask tick each recorded a crash and scheduled a recovery, so recovery #2 wiped and orphaned the root that recovery #1 had just remounted (leaked React root + duplicate controller subscription). Fixed by extracting `buildUncaughtErrorHandler(policy, schedule, ctx)` (`main.tsx`) with a per-root `recovering` guard: the first uncaught error records + schedules; every subsequent error for that root is ignored (its recovery is already in flight and will remount a fresh root with its own fresh handler). One error → one recovery. The factory also makes the decision→schedule→`performRecovery` seam directly unit-testable. Added 3 handler-level tests to `root-recovery.test.tsx` (now 10): records+schedules exactly once then clears+remounts; **DISCRIMINATING** — two errors before the tick collapse to ONE record/schedule/remount (RED without the guard); a 'fatal' decision routes to the visible card and does not remount. Also documented the bounded (≤`maxRecoveries`), harmless stale-VM-subscriber note in `mount()`'s docstring (React 19 no-ops setState on unmounted, so a lingering closure can't loop/crash). `landing/chat-react/` suite 397 pass; `tsc -p landing` clean. NOTE: the browser-only teardown invariant is still jsdom-unobservable — #380 stays OPEN until a real-browser repro-then-not-repro on the box.

## 2026-07-21 — Executor-mode reminders: CLOSE Argus r2 round-2 BLOCKER — bundled rituals had no approval/scheduling path (`rituals_enable`)

Branch `trident/executor-reminders-p2` (PR #427). Argus round-2 found (codex-corroborated, independently confirmed against code) that the three bundled rituals (`morning-brief`/`evening-wrap`/`daily-delta`) were seeded + registered at boot but **permanently unusable**: `rituals_propose` refuses their ids (`exists_on_disk`/`duplicate_id` — the seeded `.md` already exists + the def is already registered), the only `requestRitualApproval` caller lived inside `propose`, and `readSchedule` needs an `<id>.def.json` that `seedBundledRituals` never writes (it writes `.md` only). Net: an owner asking to enable `morning-brief` had NO path — the ritual could never be approved, never scheduled, never fired. Closed by adding the missing ENABLE path.

- **New `RitualRegistrationService.enable(id, schedule)`** (`reminders/ritual-registration.ts`). Takes ONLY the id + schedule (the prompt/surface/scope are owned by the already-registered def): resolves the registered def, re-runs the same content guards over the LIVE seeded/owner `<id>.md` bytes (NFC-normalize, reject bidi/zero-width/C0, refuse empty/over-16KiB), never-clobber-guards on an existing `<id>.def.json` (`already_enabled`), writes ONLY the `<id>.def.json` (the seeded `.md` is never written or clobbered), then requests the SAME content-hash-bound owner approval `propose` does. New error codes `unknown_ritual` / `missing_prompt` / `already_enabled`.
- **Shared approval tail.** The register + `requestRitualApproval` + emit-both-prompts + full-rollback block was extracted from `propose` into one `requestApprovalAndEmit({ def, normalized, schedule, register, cleanup })` helper that both `propose` (`register:true`; rollback unregisters + rm's both files) and `enable` (`register:false` — never unregister a bundled def; rollback rm's ONLY the `.def.json`) call — identical approval prompt, content-hash binding, and grant/file rollback. No behavior change to `propose` (its 26 existing tests still pass).
- **Wired end-to-end (`done` = reachable).** New `rituals_enable` MCP tool: `cores/free/reminders/package.json` manifest entry (id + schedule input schema, `write:reminders_core.db`), `TOOL_NAMES` (`manifest.ts`), `RemindersRitualService.enable` + `RemindersBackend.enableRitual` + impl (`backend.ts`), `buildExtraTools` handler (`mcp-tools-extra.ts`) — X2 lockstep so `install-bundled` doesn't hard-fail `manifest_incomplete`. `RitualEnableInput` exported from both barrels. Manifest now declares **9** tools.
- **Tests.** `reminders/ritual-registration.test.ts` — 7 new: `propose` REFUSES a bundled id (proves enable is the required path); `enable` writes ONLY the `.def.json` + mints ONE content-hash-bound grant + emits + creates NO reminder row; owner Approve on an enabled bundled ritual SCHEDULES it (the full blocker close — reminder row appears, `status` → approved+scheduled); `already_enabled` / `unknown_ritual` / `invalid_schedule` refusals; enabled `def.json` survives boot re-registration (skipped as duplicate, bundled def wins). `cores/free/reminders/__tests__/rituals-tools.test.ts` — `rituals_enable` wired-dispatch + fail-closed-when-unwired. `install-lifecycle.test.ts` tool-count 8→9. Suites green: `reminders/` + `cores/free/reminders/` 388 pass / 3 skip; `tsc -p reminders` + `tsc -p cores/free/reminders` + `tsc -p open` clean.
- Honors overturn 3 (registration agent-callable; security in the approval GATE, not the surface) — `enable` fires nothing; the ritual runs only after the owner taps Approve on the code-rendered prompt.

## 2026-07-21 — Executor-mode reminders task 10: CLOSE Argus r1 round-2 (doc-accuracy BLOCKER + deny-on-approved minor)

Branch `trident/executor-reminders-p2` (PR #427). Argus round-1 review of the task-10 docs found one doc-accuracy BLOCKER plus stale citations and one approval-handler minor; all closed here.

- **BLOCKER — `SYSTEM-OVERVIEW.md` misdescribed the `RitualDef` contract.** The ritual-executor section claimed `RitualDef` "declares `id`, the self-contained `prompt` bytes, a `tool_surface`, an `egress` class, a `scope`, a cadence, a tier, and a timeout" — but the interface (`reminders/rituals.ts:131`) has EXACTLY six fields: `id`, `description`, `scope`, `tool_surface`, `egress`, `silent`. Rewrote the bullet to match: the prompt bytes live in the separate `rituals/<id>.md` file (derived from `id`, module header §34-36), the cadence lives on the scheduled reminder row (`ritualCadenceString`, `reminders/ritual-approval.ts:109`), and the model TIER (`RITUAL_MODEL_TIER`, `reminders/rituals.ts:55`) + spawn TIMEOUT (`RITUAL_TIMEOUT_MS`, `reminders/rituals.ts:47`) are module CONSTANTS, not def fields — with a note that the content-hash deliberately binds all six (drawing prompt from file, cadence from row, tier/timeout from constants), so the hash covers more than the def.
- **minor — a DENY re-tap on an already-APPROVED grant silently re-scheduled.** `handleOwnerButtonAnswer` dropped the `:a`/`:d` suffix once a grant left `'pending'`, so the r1 reconciliation branch (self-heal a stranded approved ritual on a re-tap) fired for a Deny tap too. `reminders/ritual-registration.ts:645-666` now reads the re-tapped decision and reconciles ONLY on an APPROVE re-tap; a DENY re-tap on an approved grant is inert with a clear "already approved — this Deny did nothing; re-propose to stop it" message (revoke-via-button is not a v1 path). New regression test (`reminders/ritual-registration.test.ts` — "deny re-tap on an approved grant": no double-schedule, grant unchanged, no second `respondApproval`).
- **Stale citations refreshed** (files grew after the entries were written): `AS_BUILT.md` task-9 backlink wire `open/wiring/memory.ts:214`→`:231` (the `wrapSyncHookWithBacklinkRepair(...)` call; `gbrainSyncHook = backlinkRepairHook` at `:235`), matching `SYSTEM-OVERVIEW.md`; task-8 `renderRitualApprovalBody` `ritual-registration.ts:279-334`→`:301` and `handleOwnerButtonAnswer` `:407-540`→`:611`.
- **Tests:** `reminders/ritual-registration.test.ts` 26 pass; `bun test reminders/` 373 pass / 3 skip; `bunx tsc -p reminders/tsconfig.json` clean.

## 2026-07-21 — Executor-mode reminders: CLOSE Argus r2 (2 BLOCKERs + 3 minors) on tasks 8/9

Branch `trident/executor-reminders-p2` (PR #427). Review-round hardening; no new surface.

- **BLOCKER 1 — completed one-shot ritual could be REPLAYED.** The schedule-on-approve dedup keyed on `status='pending'` only, so once a one-shot fired (row → `'fired'`) a re-tapped Approve minted a fresh reminder. `reminders/store.ts` — `hasPendingRitualRow` → **`hasScheduledRitualRow`**, now `WHERE ritual_id=? AND status <> 'cancelled'` (a fired one-shot still holds the slot; a cancelled ritual can be re-proposed). Call sites in `reminders/ritual-registration.ts:728,813` updated.
- **BLOCKER 2 — concurrent approval answers could DOUBLE-SCHEDULE.** The sync pre-check + awaited INSERT was a check-then-act race (content + egress grants for a web ritual). New migration **`0107_ritual_reminder_unique.sql`** — partial `CREATE UNIQUE INDEX idx_reminders_ritual_scheduled ON reminders(ritual_id) WHERE ritual_id IS NOT NULL AND status <> 'cancelled'` makes "≤1 live-or-completed reminder per ritual" a DB invariant (also closes BLOCKER 1 atomically). `ReminderStore` gains `isRitualScheduleConflict(err)` (matches `UNIQUE constraint failed: reminders.ritual_id`, verified against bun:sqlite); `ensureScheduled`'s create catch treats a conflict as "already scheduled", not a retry-able error. `migrations/expected-schema.txt` regenerated.
- **minor 1 — backlink repair rewrote links inside code.** `runtime/backlink-repair.ts rewriteLinks` now masks via `stripCode` (exported from `runtime/auto-link.ts`) and rewrites a match ONLY when its offset survives stripCode intact — literal `[[white-board]]` in a fence/inline-span is left untouched, matching the extractor.
- **minor 2 — mdlink title dropped.** The optional `(target "Title")` title group is now captured and re-emitted verbatim.
- **minor 3 — correction-pattern slug drifted past the 200-scan window.** `scribe/reflect/correction-patterns.ts` — new exported `stablePatternSlug`: the slug is now `correction-pattern-<digest of the cluster's majority `right`-field vocabulary>` (window-INVARIANT), replacing the oldest-member-id slug that changed every time the scan window slid past the oldest occurrence, orphaning the prior page.
- **Nits (deferred, benign per the findings):** readdirSync-in-async-drain (off the write-response path, single-owner scale), `stats.repaired` overcount (observability-only), promoted-page LLM re-synthesis eligibility (timeline preserved, no wikilinks to lose).
- **Tests:** explicit per-fix assertions — store replay/race + `isRitualScheduleConflict` scoping (`reminders/store.test.ts`), registration race→"already scheduled" (`reminders/ritual-registration.test.ts`), code-fence-skip + title-preservation unit tests (`runtime/__tests__/backlink-repair.test.ts`, `rewriteLinks` exported), window-slide invariance (`scribe/__tests__/correction-patterns.test.ts`). Test-harness fixes for the new invariant: `reminders/ritual-executor.test.ts ritualRow` frees the prior slot; `reminders/rituals.test.ts` 0106-rebuild staging excludes versions ≥ 106 (0107 depends on 0106's column); `migrations/runner.test.ts` expects 107. Suites green: reminders 372 pass, runtime 1561 pass, scribe 133 pass, migrations 40 pass; `tsc -p tsconfig.json` clean.

## 2026-07-21 — Executor-mode reminders task 10: docs close-out + work-board CI fixture fix

Branch `trident/executor-reminders-p2` (PR #427). Docs-only close-out of the executor-mode reminders sprint (engine tasks 0-9 already landed on this branch + PR #426) plus the one CI merge prerequisite.

- **Three doc surfaces updated.** `docs/AS_BUILT.md` — the two new entries above (the a2d93b99 Argus r1 round-2 fixes + this close-out). `docs/SYSTEM-OVERVIEW.md` — a new `## Ritual executor — approval-gated code rituals (reminders/)` section inserted after the Reminders Core section and before `## Proactive messaging`, plus the memory-consolidation cadence text updated for the AS-LANDED Q2 tier split (backlink repair = event-driven on the sync hook; correction-pattern promotion = reflect-pass step 4; daily-delta = bundled ritual). `reminders/AGENTS.md` — full rewrite from the pre-implementation P0 stub to the real reminder-engine + ritual-executor surface.
- **Work-board CI fixture fix (SEPARATE commit `b5d631ad`).** Pre-existing main fixture rot inherited by every branch: `work-board/store.ts:56` makes `task_type: WorkBoardTaskType` a REQUIRED field of `WorkBoardItem`, but the `item()` fixture at `work-board/fragment.test.ts:5-20` omitted it (the only missing field), so the CI Typecheck matrix was RED on any branch. Added `task_type: 'build',` to the fixture (mirrors store.ts field order). `bunx tsc -p work-board/tsconfig.json` exits 0; `bun test work-board/` 74 pass. The executor branch never touched `work-board/`.
- **Sprint close.** Executor-mode reminders tasks 0-10 complete across PR #426 (tasks 0-6R, merged to main `63fe4119`) and PR #427 (tasks 7-10, this branch).

## 2026-07-21 — Executor-mode reminders task 9/8 (Argus r1 round-2 fixes, PR #427)

Branch `trident/executor-reminders-p2` — commit `a2d93b99` closing the five Argus round-1 findings on the task-8/9 ritual-registration + backlink-repair work. `tsc` clean; a new regression test lands per fix (`reminders/ritual-registration.test.ts`, `runtime/__tests__/backlink-repair.test.ts`).

- **BLOCKER — web-ritual CONTENT approval was unreachable.** The live-agent capture keyed ritual eligibility off `latestPromptByTopic` (a single prompt), so once the SEPARATE egress-approval prompt landed the CONTENT Approve token was no longer "latest" and failed the T8 persisted-option-set membership check — a web ritual could never be content-approved, hence never scheduled. Added `ButtonStore.recentPromptOptionsByTopic` (`channels/button-store.ts:881` — the union of recent UNRESOLVED prompt option values) and a separate `priorRitualOptions` computed from it in `gateway/wiring/build-live-agent-turn.ts:743,746,787-794`, so both the content and egress tokens stay capturable while the onboarding capture stays latest-only.
- **BLOCKER — an approved-but-unscheduled ritual could strand.** A transient failure after `respondApproval` left a ritual approved with no reminder row and no self-heal. Extracted an idempotent `ensureScheduled` (`reminders/ritual-registration.ts:653,681,692`, never throws out) and made a re-tap of an already-APPROVED grant RE-DRIVE scheduling; the decision-record step is isolated so a scheduling failure no longer mislabels a recorded decision.
- **MAJOR — a rejecting approval-prompt `emit` left a registered-but-promptless ritual** whose on-disk files + duplicate guard blocked every re-propose. `propose` now FULLY rolls back on emit failure (`reminders/ritual-registration.ts:590-600` — registry `unregister` + delete both `wx` files + `ApprovalManager.cancelPending` on both grants routed through the async mutex) and throws `emit_failed` (`reminders/ritual-registration.ts:153,597`).
- **minor — `rituals_status` mis-labeled a DENIED grant as 'none'.** New `ApprovalManager.findByToolName` (`tools/approval.ts:255`) lets status report the real DENIED state.
- **minor — backlink-repair re-scanned the corpus per job.** The existing-slug enumeration is hoisted to ONCE per drain cycle (`runtime/backlink-repair.ts:302-312` — `enumerateExistingSlugs` inside `drain()` before the queue loop) instead of O(jobs × corpus); eventual consistency preserved because a page created by a concurrent write schedules its own job for the next drain.

## 2026-07-21 — Executor-mode reminders task 9 (Q2 overturn-2): dreaming's uncovered half INTO CORE MEMORY, split by tier

Branch `trident/executor-reminders-p2` (PR #427). The owner's Q2 overturn folds the three pieces of the legacy harness "dreaming" that were NOT covered by scribe/reflect into core memory, split by tier — NOT a separate dreaming ritual. All deterministic where it can be; NO feature flags.

- **(a) Deterministic entity BACKLINK REPAIR, event-driven on the sync hook** — new `runtime/backlink-repair.ts` (`wrapSyncHookWithBacklinkRepair`), a THIRD `SyncHook` wrapper layer wired OUTERMOST in `open/wiring/memory.ts:231` (the `wrapSyncHookWithBacklinkRepair(...)` call; `const gbrainSyncHook = backlinkRepairHook` at `:235`). On every entity write it inspects `newLinks` for a target with no entity page; a UNIQUE strip-hyphen-key match (`[[white-board]]` vs `entities/concepts/whiteboard.md`) → rewrites the source page's compiled-truth wikilinks/mdlinks via `writeEntity` (CAS `ifBodyEquals` on the event body, `backlink-repair:<slug>` provenance timeline row) and self-references the wrapper as the repair write's syncHook so it RE-ENTERS the full chain (GBrain `remove_link`/`purgeDeferred` retracts the broken edge, re-adds the fixed one — ISSUES #102). Orphan (0 candidates) / ambiguous (>1) → logged, NEVER mutated (the always-safe direction). Coalesced single-flight drain + `idle()` seam + re-entrancy guard; termination is structural. `normaliseSlug` exported from `runtime/auto-link.ts` as the single grammar. `stats.repaired` counts committed-only.
- **(b) Correction-pattern promotion as reflect-pass STEP 4** — new `scribe/reflect/correction-patterns.ts` (`clusterCorrections` Jaccard oldest-seed-stable + `composePatternPage`), driven by `runReflectPass` (`scribe/reflect/reflect-pass.ts` step 4) UNCONDITIONALLY of substrate (deterministic; LLM-less boxes included), guarded only on an injected `readCorrections` seam (no scribe→reflection package edge — `open/wiring/memory.ts` wires the real `readRecentCorrections` with `DEFAULT_CORRECTION_SCAN_LIMIT`). ≥3-occurrence clusters promote to a kind-`concept` entity page (window-invariant slug `correction-pattern-<majority-`right`-vocabulary digest>` via `stablePatternSlug` — see the 2026-07-21 Argus-r2 entry above) through the pass's `writeEntity`+`syncHook` → GBrain + `entities/INDEX.md`. Idempotent via timeline `(ts,source,body)` dedupe + `changed:false`. Report gains `correctionsScanned`/`patternsPromoted`.
- **(c) `daily-delta` — a THIRD bundled read-only ritual** — `reminders/rituals/daily-delta.md` (reads `entities/INDEX.md` + `corrections/corrections-log.md` + `diary/`, posts a ≤15-line last-24h memory delta) + a third frozen def in `reminders/bundled-rituals.ts:BUNDLED_RITUAL_DEFS`. Seeds + registers via the existing composer loops (zero composer change); stays UNAPPROVED until the owner's task-8 act. The time-anchored survivor of the split (nothing in memory triggers a daily delta).
- Every sub-part ships BOTH a `toHaveBeenCalled()`-style spy assertion AND an artifact-on-disk assertion; (a) additionally has a `wireMemory`-level wiring proof (`open/__tests__/backlink-repair-wiring.test.ts`). Suites green: runtime 1556 pass/3 skip, scribe 131 pass, reminders 363 pass/3 skip. depcruise clean (no new cross-band violations); no new package edges; no feature flags.

## 2026-07-21 — Executor-mode reminders task 8 (Q3 overturn-3): agent-callable ritual registration with in-chat approval — the approval RENDERING carries the security

Branch `trident/executor-reminders-p2` (PR #427). An agent can now PROPOSE a scheduled, unattended ritual; the ritual only ever fires after the OWNER explicitly approves it in chat. The security lives in the APPROVAL GATE, not in who-can-call.

- **Engine `validateRitualDef` extract + `ritual_id` WRITE path.** `reminders/rituals.ts` — the register-time structural validation (charset, enums, tool-surface/egress consistency, EXCEPT the duplicate-id check) is extracted into an exported `validateRitualDef(def)`; `createRitualRegistry().register` delegates + keeps the duplicate guard (behavior-neutral — `reminders/rituals.test.ts` unchanged, green). `reminders/store.ts:138-167,178-229` — `create`/`createRecurring` accept an optional `ritual_id` (RITUAL_ID_RE-guarded, malformed THROWS fail-closed) and INSERT the column + return it; new `hasScheduledRitualRow(ritual_id)` (charset-guarded `SELECT 1 … WHERE ritual_id=? AND status <> 'cancelled'`; hardened from the original pending-only `hasPendingRitualRow` — see the 2026-07-21 Argus-r2 entry above).
- **Approval id passthrough.** `reminders/ritual-approval.ts:161-215` — `requestRitualApproval` mints `content_id` (+ `egress_id` for web defs) and threads each as `ApprovalRequest.id` so the durable `tool_approvals` row lands under an id the caller returns + encodes into the opaque button token (no side-table).
- **NEW `reminders/ritual-registration.ts` — the engine service (approval-gate rendering + capture).** `propose()` (order matters, all-or-nothing before any write): NFC-normalize the prompt (the NORMALIZED bytes are what is hashed/rendered/written) → reject bidi/zero-width/C0 controls (`RITUAL_PROPOSAL_BANNED_CHARS_RE`, never sanitize silently) → REFUSE empty/over-16 KiB (`RITUAL_PROPOSAL_MAX_PROMPT_BYTES`, never truncate) → `validateRitualDef` → refuse scope≠'instance' (v1) → validate schedule (finite fire_at; recurrence XOR recurrence_spec) → NEVER-CLOBBER (registry.get / `<id>.md` / `<id>.def.json` existsSync) → write both files with fs flag `'wx'` (rollback the `.md` if the `.def.json` write fails) → `registry.register` → `requestRitualApproval` → emit a CODE-rendered, PREFORMATTED, fence-hardened approval `ButtonPrompt` (`renderRitualApprovalBody`) via the injected `emit` seam; NO reminder row, fires nothing (no register-and-fire). `renderRitualApprovalBody` (PURE, `ritual-registration.ts:301`): capability BULLETS not bare tool names (Read/Glob/Grep → "read any file in your Neutron home"; WebSearch/WebFetch → "reach the public internet — content could be sent out"; `GATED_WRITE_TOOLS` → "(CURRENTLY BLOCKED at fire time until sandboxing ships)"; unknown/`mcp__` → raw token "(bridge tool)"), a "Runs UNATTENDED … up to 45 minutes … smart model tier" line, itemized URLs/paths/`mcp__*` refs each in its own fenced block, the FULL prompt inside a backtick fence whose length = max(3, longest internal run + 1) so no prompt content can close it (the button body is Markdown-rendered — `channels/button-primitive.ts:194` — this is the preformatted defense), and a footer "Typing anything else will NOT approve or deny". `handleOwnerButtonAnswer` (`ritual-registration.ts:611`): the deterministic affirmative-act capture — eligibility ONLY from an EXACT `rap:<22-char base64url of the row UUID>:a|d` token that is BOTH regex-valid AND present in the prior prompt's PERSISTED option set (the `captureButtonBackedRequiredField` discipline, `onboarding/interview/button-backed-answer.ts:207-209`); OWNER-only (a non-owner tap is refused WITHOUT touching any row); resolves the `tool_approvals` row via `respondApproval`; on approve, schedule-on-approve IFF `createRitualApprovalCheck(...).isApproved(def, liveBytes)` verifies over the LIVE file bytes (which also requires the egress grant for web defs) AND `!hasPendingRitualRow`; ANY db/fs throw → catch, log, "nothing was changed" and DO NOT schedule (fail closed). `status()`, `loadPersistedRitualDefs()` (boot re-registration of `<id>.def.json`, never throws — boot safety), opaque token codec `uuidToToken`/`tokenToUuid` (full option value ≤ `VALUE_BYTE_CAP` 37). Barrel-exported from `reminders/index.ts`.
- **Delivery seam extension.** `gateway/http/deliver.ts` — `DeliveryEnvelope` gains optional `options` / `idempotency_key` / `metadata`, honored ONLY on durability `'reply'` (threaded into `buildButtonPrompt` AND the routed-push `ChatOutbound.options`, previously hardcoded `[]`). Absent ⇒ byte-identical legacy behavior (`gateway/http/__tests__/deliver.test.ts`).
- **Live-agent capture seam.** `gateway/wiring/build-live-agent-turn.ts` — `BuildLiveAgentTurnInput.ritualApprovalCapture`; the prior-prompt durable-option read is widened to also fire when the capture is wired (not onboarding-only); the capture runs AFTER step-1 user-turn persistence + transcript append and BEFORE the onboarding required-answer capture (so an opaque `rap:` token can never fall through to the personality free-text capture or the substrate). On a non-null result the runner persists an inert confirmation, ships it via `sendSafe`, and returns `replied` WITHOUT dispatching the LLM turn (T8: unrelated reply → null → normal turn).
- **Composer wiring.** `open/composer.ts` — inside `ritual_executor_factory` (the one closure holding the graph `ApprovalManager`): `loadPersistedRitualDefs` after `registerBundledRituals`, then construct `createRitualRegistrationService({ registry, rituals_dir, approvals, store: new ReminderStore(db), project_slug, owner_user_id: OWNER_USER_ID, approval_topic_id, emit: deliver(...durability:'reply'...) })` and assign the outer `let ritualRegistration` binding; `buildLiveAgentTurn` gains `ritualApprovalCapture: (i) => ritualRegistration?.handleOwnerButtonAnswer(i) ?? null`; a late-bound `ritualRegistration: () => ritualRegistration` getter threads through `mountOpenCores` → `buildCoresBackendFactories` (`CoresBackendFactoriesOptions.ritualRegistration`). `llmPool===null` ⇒ factory never runs ⇒ `ritualRegistration` stays null ⇒ capture no-ops + tools throw unavailable (fail closed, no flags).
- **Reminders-Core MCP surface (X2 lockstep — manifest + `TOOL_NAMES` + handlers one commit).** `cores/free/reminders/package.json` `neutron.tools[]` + `src/manifest.ts` `TOOL_NAMES` + `src/mcp-tools-extra.ts` handlers gain `rituals_propose` (write cap; description says it only runs after the OWNER approves in chat) and `rituals_status` (read cap). `src/backend.ts` — a NARROW structural `RemindersRitualService` interface (propose + status; the Core never imports the engine service module) + OPTIONAL `proposeRitual?`/`ritualsStatus?` methods (the `convertToTask?` precedent) dereffing a late-bound `rituals?: () => RemindersRitualService | null` getter PER-CALL + typed `RitualsUnavailableError` (fail-closed when unwired). `gateway/boot-cores-factories.ts` reminders_core branch threads `rituals: opts.ritualRegistration`.
- **ACCEPTANCE proven by tests (REAL `ApprovalManager` + migrated temp DB):** `reminders/ritual-registration.test.ts` (19 tests) — propose happy path (files on disk, one pending grant, content_hash pin, emit-once 2 options within the 37-byte cap, code-rendered body, ZERO reminder rows, `store.create` 0×); **T8** — an unrelated owner reply returns null, a freeform attach never touches the `tool_approvals` row, `respondApproval` 0×, `isApproved` false, `validateRitualFire` → `unapproved`; no-self-approval; approve → schedule-on-approve with `ritual_id` + cadence + no double-schedule; deny; egress two-grant (content-approve alone not enough); over-cap refusal + bidi/zero-width rejection + NFC + fence hardening; never-clobber; cadence/surface widening drops approval; `loadPersistedRitualDefs`. Plus store/approval/deliver/live-agent-capture/reminders-Core suites. `bun test reminders/ migrations/ cores/free/reminders/ gateway/wiring/ gateway/http/ channels/` 1727 pass; `open/ + composition + cores` 413 pass; `tsc -p {reminders,open,gateway,cores/free/reminders}` clean; eslint + depcruise clean on task-8 files.

## 2026-07-21 — Executor-mode reminders task 6R (REQUEST_CHANGES round-4 fixes): 0106 skip_reason CHECK admits gated_tool_surface; sync launch failure settles crashed

Two correctness bugs in the skip-recording / crash-settle paths on PR #426 (branch `trident/executor-mode-reminders`). The T5 security verdict itself PASSED review — the gate (`validateRitualFire` `gated_tool_surface` refusal, `GATED_WRITE_TOOLS`, PROFILE_RITUAL, buildSettings permissions plumbing) is UNTOUCHED; these are the recording/settle paths downstream of it.

- **BLOCKER A — the 0106 `skip_reason` CHECK omitted `'gated_tool_surface'`, re-opening the hot-loop/data-loss class for gated rituals.** The CHECK value list admitted only 4 of the 5 `RitualFireSkipReason` members, but `validateRitualFire` returns `'gated_tool_surface'` for any Bash/Write/Edit/MultiEdit/NotebookEdit ritual (`reminders/rituals.ts:302,367-371`) and the executor persists it verbatim via `insertSkipped` into the STRICT table (`reminders/ritual-executor.ts:389-396`). A gated fire therefore hit `CHECK constraint failed` → `insertSkipped` threw → `fire()` outer catch re-threw → `reminders/tick.ts` `claimRevert` → the occurrence re-fired every 30s tick forever with NO durable `code_ritual_runs` row. FIX: `migrations/0106_ritual_schema.sql:86` — CHECK value list gains `'gated_tool_surface'` (in-place: 0106 is branch-only, absent on main, no recorded checksum in `migrations/runner.ts`, no deployed DB has it — a 0107 would be wrong). `migrations/expected-schema.txt:527` regenerated via `bun migrations/regen-snapshot.ts` (exactly the one CHECK-list line changed). `reminders/ritual-runs.ts:15` stale 3-member header comment corrected to the full 5-member union (doc-only). Tests: `reminders/ritual-runs.test.ts` `test.each` over all 5 members — "insertSkipped accepts every RitualFireSkipReason member against the real 0106 DDL (CHECK lockstep)" — lands a durable row against the REAL migrated DDL (pre-fix, the `gated_tool_surface` case throws `CHECK constraint failed`); `reminders/ritual-executor.test.ts` end-to-end — "gated tool surface (Bash) → durable skipped/gated_tool_surface row, fire() RESOLVES, nothing spawned" (the no-hot-loop proof: `fire()` resolves so the tick does not `claimRevert`).
- **BLOCKER B — a synchronous launch-construction throw wedged the run.** Step (f) of the executor evaluated `deps.resolve_model()` and the `deps.turn(...)` call itself SYNCHRONOUSLY during the `fireAndForget` argument construction — AFTER the durable 'running' row (`insertRunning`) and the LIVE `ritual:<id>` registry record (`spawnSubagent` `on_duplicate:'refuse'`) already existed. A sync throw skipped the never-yet-attached `.catch`, landed in the outer startup catch and re-threw → the tick reverted the occurrence claim WHILE the spawn key stayed live → every re-fire was refused as a duplicate ('failed' rows) and the original run stuck 'running' until boot reap. FIX: `reminders/ritual-executor.ts:559-579` — the `fireAndForget` launch is wrapped in `try/catch`; a synchronous `launchErr` routes through the SAME `settleCrashed` path as a promise rejection (run row → 'crashed', registry `updateTerminal` frees the spawn key since `liveByKey` counts only pending|running, failure notice via the guarded `surfaceFailure`), then `return` (NOT re-throw) so the occurrence is legitimately consumed — no `claimRevert`, no stuck 'running', no live-key wedge. `settleCrashed` (`reminders/ritual-executor.ts:326-362`) is fully guarded and never rejects, so the bare `await` is safe and keeps the settle inside the tick quiescence boundary (task-5R discipline). The step-(f) comment and the outer-catch comment (`reminders/ritual-executor.ts:581-596`) record the sync hazard; the documented `fire()` contract ("never rejects once a durable row exists") is unchanged — this fix makes the code honor it. Tests: `reminders/ritual-executor.test.ts` — "resolve_model throws synchronously → run settles crashed, spawn key freed, fire() resolves; a re-fire is admitted" (includes the regression half: the second fire of the same ritual is ADMITTED, proving the key was freed) and "turn() throwing synchronously (non-promise) settles crashed identically".

Suites green: `bun test reminders/` (316 pass), `bun test migrations/` (40 pass), `bun test gateway/` (2778 pass, 2 skip); `bun x tsc --noEmit -p reminders/tsconfig.json` clean.

## 2026-07-21 — Executor-mode reminders task 6 (Argus round-2 doc/forward-guard fixes): fire() contract docs + GATED_WRITE_TOOLS lockstep note + composer verdict comment

Round-3 corrections on PR #426 (branch `trident/executor-mode-reminders`) — documentation/forward-guard only, no behavior change (all fixes are comments; suites unchanged 74/74 on the two touched suites).

- **MINOR — stale `fire()` contract docs corrected.** `reminders/ritual-executor.ts` — the `RitualExecutor` interface doc (was "`fire(reminder)` never rejects") and the `createRitualExecutor` doc (was "`fire()` NEVER throws") contradicted the round-2 fix that makes `fire()` REJECT on a STARTUP failure (module header line 23; throw sites at the `insertRunning`-recovery re-throw and the outer catch). Both now state the real contract — REJECTS on startup failure so the tick (`reminders/tick.ts`) reverts its occurrence claim; never rejects once a durable row exists; never awaits the detached turn — closing a doc trap for future importers of the exported seam (`reminders/index.ts`).
- **MINOR — `GATED_WRITE_TOOLS` lockstep-maintenance note added.** `reminders/rituals.ts` — the gate is an ENUMERATED denylist (5 built-ins), so a write-capable name NOT in the set (a new built-in, or an `mcp__server__tool` bridge name admitted by `TOOL_TOKEN_RE`) would PASS the gate. Not reachable today (the ritual substrate wires no tool bridge and shipped rituals are read-only with an explicit Read/Glob/Grep allow-list). Comment records the two lockstep lanes + recommends flipping to a read-only ALLOW-LIST (fail-closed for unknown/bridge names) when the OS-sandbox sprint or task 8/9 revisits the gate.
- **NIT — composer `scope_cwd` comment corrected.** `open/composer.ts` — the block comment + throw message said per-project write-containment "lands in task 6"; task 6's T5 verdict is UNPROVABLE, so containment is deferred to the OS-sandbox prerequisite sprint. Comment + throw string now say so (the fail-closed behavior itself was already correct).

## 2026-07-21 — Executor-mode reminders task 6 (Argus r1 round-2 fixes): ritual startup fails CLOSED with claim revert; STAY GATED enforced by code

Round-2 corrections on PR #426 (branch `trident/executor-mode-reminders`).

- **BLOCKER — a ritual startup failure no longer silently consumes the occurrence.** `reminders/ritual-executor.ts` — the `fire()` outer catch used to log-and-RESOLVE any startup throw (`validateRitualFire`, `insertSkipped`, `insertFailed`, or a total run-store outage on the `insertRunning` recovery path), so the tick consumed the #319 claim with NO durable `code_ritual_runs` row and NO launch — a scheduled run lost with one log line. Now `fire()` RE-THROWS a startup failure, and `reminders/tick.ts` reverts the #319 claim (the same `claimRevert` the nudge dispatcher uses: `revertRecurrenceAdvance` for recurring, `reopen` for one-shot) so the occurrence re-fires next tick. Paths that DID land a durable row (skipped/failed/running) still resolve = consume. The detached substrate TURN stays fire-and-forget + fail-soft inside the executor, so a `fire()` rejection is unambiguously a startup loss. The unwired-executor branch still consumes (a permanent condition, not a transient loss). Tests: `reminders/tick.test.ts` (recurring reverts + re-fires, one-shot reopens + re-fires), `reminders/ritual-executor.test.ts` (startup run-store throw → rejects; insertRunning+insertFailed total outage → rejects, spawn key freed, turn never launched).
- **MINOR — a persistent run-store failure at turn settlement no longer leaks the ritual spawn key.** `reminders/ritual-executor.ts` `settleTerminal`/`settleCrashed` — `runs.markTerminal` was awaited UNGUARDED; a throw jumped to `settleCrashed`, which retried the same failing store and never reached the registry `updateTerminal` that frees `spawn_key ritual:<id>` (`on_duplicate:'refuse'`), refusing all future fires until restart. `markTerminal` is now individually guarded so the registry terminal (key-free) ALWAYS runs, independent of run-history persistence.
- **MAJOR — "STAY GATED" for Bash/Write rituals is now enforced by CODE, not absence.** `reminders/rituals.ts` — `validateRitualFire` refuses fail-CLOSED any ritual whose `tool_surface` grants a write/exec-class tool (`GATED_WRITE_TOOLS` = `Bash`/`Write`/`Edit`/`MultiEdit`/`NotebookEdit`) with the new `gated_tool_surface` skip verdict, BEFORE any disk read or approval check. A def may still REGISTER a Bash surface (overturn 1 — Bash is portable) but can never FIRE until the OS-sandbox sprint lifts the gate (T5 verdict UNPROVABLE). Read-only rituals unaffected. Test: `reminders/rituals.test.ts` `test.each([Bash,Write,Edit,MultiEdit,NotebookEdit])`.
- **NITs.** `build-settings.ts` no longer writes a hollow `permissions: {}` for an all-empty input (test added). `ritual-write-containment.e2e.test.ts` — stale `acceptEdits` comment corrected (in-scope acceptance comes from the `allow` rules, not the dropped `acceptEdits`); ARM A now asserts `reachedTerminal` when the channel bound (the no-wedge signal was console-only).
- Affected suites green: `bun test reminders …` 109/109; full `reminders` + composition + auto-approve-gate 406/406; `tsc --noEmit` 0 errors.

## 2026-07-21 — Executor-mode reminders task 6: T5 write-containment spike (HARD SECURITY GATE) — VERDICT: UNPROVABLE

Substrate-layer plumbing + the real-PTY spike for path-scoped ritual write containment, on PR #426 (branch `trident/executor-mode-reminders`).

- **`buildSettings` writes an optional CC `permissions` block.** `runtime/adapters/claude-code/persistent/build-settings.ts` — new `SettingsPermissions` type (`allow`/`deny`/`ask`/`defaultMode`); when `input.permissions` is set, a `permissions` key is emitted ALONGSIDE the existing `hooks.Stop` block (0600 atomic write preserved, empty sub-arrays dropped). Absent ⇒ byte-identical to the pre-task-6 Stop-hook-only write. Re-exported from the adapter boundary (`index.ts`).
- **The `tool-use-approve` auto-approver is now gate-able.** `runtime/adapters/claude-code/persistent/spawn.ts` — the register block that presses `['1','enter']`="Yes" on any tool-use permission prompt (incl. Bash via `runthiscommand`, `signatures.ts:89-90`) is wrapped in `if (options.disableToolUseAutoApprove !== true)`. Every OTHER detector — the wedged-prompt deadlock-recovery ladder (`createWedgedPromptDetector()`, the no-hang backstop), disclaimer-dismiss, rate-limit, resume/compact pickers, banners — stays unconditionally registered. `buildSettings({settingsPath})` now forwards `options.permissions` when present.
- **Two new spawn/substrate options threaded end-to-end (direct call-args, NOT `SubstrateProfile`).** `disableToolUseAutoApprove?` + `permissions?` on `PersistentReplSubstrateOptions` (`persistent/types.ts`), `ClaudeCodeSubstrateOptions` (`runtime/adapters/claude-code/index.ts` + `createClaudeCodeSubstrateAuto` forwarding), and `BuildLlmCallSubstrateInput` (`gateway/wiring/build-llm-call-substrate.ts`, forwarded in the opts-resolution block). NOT routed through `SubstrateProfile` — `PROFILE_RITUAL` stays frozen so `gateway/wiring/__tests__/substrate-profiles.test.ts` equivalence net stays green; a future writing-ritual factory sets these directly.
- **Tests.** `persistent/__tests__/ritual-auto-approve-gate.test.ts` (fake-host): `disableToolUseAutoApprove:true` ⇒ session scanner does NOT carry `tool-use-approve` while `wedged-interactive-prompt`/disclaimer/rate-limit/compact-resume DO; default carries it. `OutputScanner.has(id)` introspection seam added (`output-scan.ts`). `build-settings.test.ts` extended: permissions block written + Stop hook intact + 0600 + no `permissions` key when unset. `persistent/__tests__/ritual-write-containment.e2e.test.ts` (real PTY, `NEUTRON_PTY_E2E=1`, `describe.skipIf`) — the T5 spike; opt-out suite skips it (605 pass / 3 skip / 0 fail in `persistent/`).
- **VERDICT: UNPROVABLE** (recorded in `docs/plans/executor-mode-reminders-2026-07-20.md` → "T5 write-containment spike verdict — 2026-07-21"). A ritual REPL with `skip_permissions:false` + a settings `permissions` block bound its dev-channel MCP in only 1/6 real-PTY runs (vs 2/2 for the no-permissions + `skip_permissions:true` sibling control, interleaved on the same box/creds); the one bound run WEDGED on an interactive tool-use permission prompt (neither the in-scope control write nor the out-of-scope write landed, no terminal state). No out-of-scope file ever escaped, but a clean fail-closed-without-wedge was NOT demonstrated. Consequence: an OS-level sandbox (reserved `SubstrateSandboxConfig`) becomes its own prerequisite sprint; Bash/writing rituals STAY GATED; read-only rituals (task 7) ship under Layer 1. The task-6 plumbing is landed and dormant until that sprint.

## 2026-07-21 — Executor-mode reminders task 5 (Argus r3 fixes): ritual startup joins the tick quiescence boundary

Round-3 corrections on PR #426 (branch `trident/executor-mode-reminders`).

- **The tick now AWAITS ritual `fire()` startup — the data-loss window is closed
  (MAJOR).** `reminders/tick.ts:231` wrapped the whole `ritual_executor.fire(reminder)`
  in `fireAndForget('ritual-fire', …)`, detaching validation + spawn + the durable
  `code_ritual_runs` 'running' insert from the tick body. `ReminderTickLoop.stop()`
  (tick.ts:135-137 → SupervisedLoop quiescence await, `loop/index.ts:319` stop
  awaits `inflight`) could therefore resolve BETWEEN a consumed #319 claim and its
  durable run row — a claimed occurrence consumed with NO durable record = data loss
  on shutdown/crash. Fixed to `await this.ritual_executor.fire(reminder)`
  (`reminders/tick.ts:231`): claim → validate → durable 'running' row now completes
  INSIDE the quiescence boundary. Only the long-running substrate TURN stays detached,
  and that detachment is INTERNAL to the executor (`fireAndForget('ritual-run')`,
  `reminders/ritual-executor.ts:494`) — the tick never blocks on an up-to-45-min run;
  startup is milliseconds of local DB writes plus one prompt read. The now-unused
  `fireAndForget` import was dropped (tick.ts:19) and the guard log key renamed
  `ritual_fire_sync_throw` → `ritual_fire_threw` (it now also covers async
  rejections). Regression test: an un-awaited `runOnce()` + immediate `await stop()`
  with a REAL executor + never-settling turn leaves exactly the durable 'running'
  row — `reminders/tick.test.ts` "a claimed ritual occurrence + immediate stop()
  leaves a durable running row — never zero rows" (deterministically null on the
  pre-fix code).
- **`postNotice` honors spec §267 — one retry then a logged failure notice (minor a).**
  `reminders/ritual-executor.ts:169-193`: a `post()==false` result (the durable
  reply write was swallowed — `gateway/http/deliver.ts:187-188` → `reminder-outbound.ts:41-42`)
  is retried ONCE; a still-false result logs `ritual_notice_post_not_persisted`. A
  THROWN post keeps the existing `ritual_notice_post_failed` catch path.
  `gateway/http/deliver.ts` is unchanged — its `{persisted:false}` reply contract is
  correct and the consumer honors it.
- **Executor-side pre-slice dropped; the formatter owns truncation (minor b).**
  `reminders/ritual-executor.ts:278` no longer `.slice(0, 160)` the settled
  failure reason before handing it to `formatRitualFailureNotice`
  (`reminders/ritual-delivery.ts:60-63`), which owns whitespace-collapse THEN the
  160-char cap. The old pre-slice truncated BEFORE collapse and could under-fill the
  notice. The `:297` 4000-char DB `failure_reason` cap (a different concern) stays.
- Tests: `bun test reminders/` 300 pass / 0 fail; `bun test gateway/` + `bun test loop/`
  green.

## 2026-07-21 — Executor-mode reminders task 5 (Argus r2 fixes): escalation fires after a cancel-broken streak + insertRunning-failure no longer wedges a ritual

Round-3 corrections on PR #426 (branch `trident/executor-mode-reminders`).

- **`shouldEscalate` now re-arms after ANY streak-breaker, not only a success
  (BLOCKER).** `reminders/ritual-delivery.ts` gated re-arm on the 4th (older) row
  being `=== 'finished'`, but `cancelled` also breaks a streak (it is outside
  `FAIL`) — so a fresh 3-failure streak preceded by an operator cancel
  (`[failed,failed,failed,cancelled]`) NEVER escalated, for the streak's entire
  life. Fixed to gate on `!FAIL.has(4th.status)`: any non-failure streak-breaker
  (`finished` OR `cancelled`) re-arms the once-per-streak notice. `FAIL` is now
  typed over the full `RitualRunStatus` union so the un-narrowed 4th-row status
  typechecks. The wrong assertion in `reminders/ritual-delivery.test.ts` was
  corrected to expect `true`.
- **A run-history write that fails AFTER the subagent spawned no longer wedges
  the ritual (minor).** `reminders/ritual-executor.ts`: if `insertRunning` throws
  after `spawnSubagent` persisted its `pending` `ritual:<id>` registry record,
  the catch now marks that record terminal via `updateTerminal` (which never
  rejects) so the `on_duplicate:'refuse'` guard's `liveByKey` no longer sees it —
  every future fire would otherwise be refused as a duplicate with no durable row
  explaining why. Then a durable `failed` run row + failure notice are landed
  best-effort. New test in `reminders/ritual-executor.test.ts` proves the key is
  freed (`liveByKey` undefined, record `crashed`), the failed row exists, the
  notice posts, and the turn never launches.
- **`listRecentTerminal` doc now lists `cancelled` (nit).** The interface comment
  in `reminders/ritual-runs.ts` omitted `cancelled` though the SQL `IN`-clause
  includes it; corrected to match.

## 2026-07-21 — Executor-mode reminders task 5 (Argus r1 fixes): ritual prompt wiring + scope fail-close + cancel/escalation semantics

Round-2 corrections on PR #426 (branch `trident/executor-mode-reminders`).

- **Ritual REPL prompt now actually reaches the spawned agent (BLOCKER).**
  `ClaudeCodeSubstrateOptions` gains `appendSystemPromptFile`, and the DEFAULT
  anthropic factory `createClaudeCodeSubstrateAuto` now FORWARDS it onto
  `PersistentReplSubstrateOptions` (`runtime/adapters/claude-code/index.ts`). It
  was dropped there, so a ritual REPL spawned with the CHAT persona
  (`repl-agent-base.md`) instead of the executor prompt, and the open typecheck
  failed (TS2339 at `gateway/wiring/build-llm-call-substrate.ts:693`). New
  end-to-end test `runtime/adapters/claude-code/persistent/__tests__/append-system-prompt-wiring.test.ts`
  proves the whole chain: the real factory forwards the field AND the spawned
  argv carries `--append-system-prompt-file` (custom when set, `repl-agent-base.md`
  default when unset) — replacing the fake-factory coverage that masked it.
- **Project-scoped rituals fail CLOSED instead of over-granting owner_home
  (MAJOR).** Design doc §Layer 4: 'instance' rituals root at `owner_home`,
  'project' rituals at their project dir. v1 wires ONLY the 'instance' root
  (per-project rooting + write-containment is task 6). The composer's `scope_cwd`
  (`open/composer.ts`) now THROWS for a non-'instance' scope, and the executor
  (`reminders/ritual-executor.ts`) resolves the scope cwd BEFORE any 'running'
  row, landing a durable `skipped` row (new skip reason `unsupported_scope`)
  rather than silently running a project ritual from the owner-wide dir. No
  running-row orphan, no escalation.
- **Operator/shutdown cancel is no longer a scary failure (minor).** New
  terminal run status `cancelled` (migration `0106`, `RitualRunTerminalStatus`).
  `settleTerminal` records `cancelled` (not `failed`), posts NO failure notice,
  and — being outside the `FAIL` set — breaks a consecutive-failure streak rather
  than feeding the escalation.
- **Escalation window ordered by COMPLETION (minor).**
  `RitualRunStore.listRecentTerminal` now orders `ended_at DESC, started_at DESC,
  run_id DESC` (was `started_at DESC`) so 'consecutive' failures are consecutive
  by when they finished; `cancelled` rows are included in the terminal window.
- Migration `0106_ritual_schema.sql` `status`/`skip_reason` CHECK enums extended
  (`cancelled`, `unsupported_scope`); `migrations/expected-schema.txt` regenerated.

## 2026-07-21 — Executor-mode reminders task 5: completion delivery + failure surfacing + boot reap + 30d retention

A ritual's terminal event now reaches the owner. The detached settle chain writes
the durable `code_ritual_runs` row FIRST, then posts through the ONE out-of-turn
delivery seam (`Deliver` → the existing `ReminderOutbound`, concrete impl
`buildButtonStoreReminderOutbound({ deliver })`) — the SAME instance the nudge
dispatcher uses — to the owner's bare `app:<user>` topic. Spec of record:
`docs/plans/executor-mode-reminders-2026-07-20.md`. NO feature flags.

- **Completion delivery** (`reminders/ritual-executor.ts` `settleTerminal`,
  ~ln 209-267): after `runs.markTerminal(...)`, a `finished` non-silent ritual
  posts its final text (`r.result.trim()`), or `formatRitualCompletionFallback`
  when the output is empty; a `silent` ritual posts NOTHING on success. Delivery
  deps `outbound` + `resolve_topic` are REQUIRED on `RitualExecutorDeps`, so the
  composer wiring is TypeScript-enforced.
- **Failure surfacing** (`reminders/ritual-executor.ts` `surfaceFailure`,
  ~ln 189-215): every failure terminal (failed / timed_out / crashed, plus the
  spawn-refusal `insertFailed` path ~ln 262-273) posts exactly one one-line
  notice `Ritual '<id>' <status> (run <run_id>)` (`formatRitualFailureNotice`).
  Silent suppresses SUCCESS output only — failure notices always post. 'skipped'
  rows get no notice.
- **Consecutive-failure escalation** (`shouldEscalate`,
  `reminders/ritual-delivery.ts`): a deterministic once-per-streak rule over the
  last 4 terminal rows (`listRecentTerminal({ritual_id, limit:4})`) — fires one
  `formatRitualEscalationNotice` the moment a streak crosses 3, with zero new
  state. Checked in `surfaceFailure` after the failure row is written.
- **Boot reap of orphaned 'running' rows** (`reapOrphanRitualRuns`,
  `reminders/ritual-delivery.ts`; wired `open/composer.ts` after the ritual
  factory): a `code_ritual_runs` row a PRIOR boot left 'running' is marked
  'crashed' (`markTerminal`'s `WHERE status='running'` guard = idempotency) and
  gets one boot-reap notice. `code_ritual_runs` has NO boot_id — current-boot
  safety is ORDERING: the driver's FIRST statement is a SYNCHRONOUS
  `listOrphanRunning()` snapshot taken during compose, before build-core-modules
  starts the tick loop, so no current-boot 'running' row can exist in it. NOT
  llmPool-gated (orphans from a prior LLM-enabled boot surface even credential-less).
- **30-day retention prune** (`RitualRunStore.pruneOlderThan`,
  `RITUAL_RUN_RETENTION_MS`, `reminders/ritual-runs.ts`): chained after the reap
  at boot; deletes terminal/skipped rows with `started_at` STRICTLY older than
  `Date.now() - 30d`, never 'running' rows.
- **Composer wiring** (`open/composer.ts`): hoisted ONE `reminderOutbound` +
  ONE `ritualRuns` store shared by the nudge dispatcher, the ritual executor, and
  the boot reap; executor factory gains `outbound` + `resolve_topic`; the reap +
  prune fire-and-forget runs unconditionally at compose (fireAndForget precedent
  `composer:888`).
- Tests: `reminders/ritual-delivery.test.ts` (formatters + `shouldEscalate` truth
  table), `reminders/ritual-runs.test.ts` (listRecentTerminal / listOrphanRunning
  / pruneOlderThan + T6 seeded-orphan reap + idempotence), and T3 behavioural
  completion added to `reminders/ritual-executor.test.ts` (artifact-on-disk +
  durable history row + silent + failure-notice variants + escalation streak +
  post-failure resilience). `bun test reminders/` = 290 pass.

## 2026-07-21 — Executor-mode reminders task 4: executor dispatch branch in the TICK + ritual executor + cc-ritual substrate + ritual lane + code_ritual_runs writer

The live wiring that turns a `ritual_id` reminder row into a scheduled, scoped
sub-agent REPL. The tick's #319 claim is reused verbatim for ritual rows, but
they NEVER reach the nudge dispatcher / `on_fired` and NEVER revert their claim —
every attempt is recorded durably in `code_ritual_runs` instead. Spec of record:
`docs/plans/executor-mode-reminders-2026-07-20.md`. NO feature flags. Generic
read-only surface only for now (zero defs registered until task 7).

- **Ritual concurrency lane** (`runtime/subagent/registry.ts` `MAX_CONCURRENT_RITUALS=2`;
  `runtime/subagent/spawn.ts` cap check): a `ritual` spawn counts ONLY live ritual
  rows against the 2-cap; every other kind counts ONLY live non-ritual rows against
  `MAX_CONCURRENT_SUBAGENTS=8`. Bidirectional isolation — a ritual pileup can't
  starve interactive `/dispatch` + Trident, and 8 live builds never block a ritual.
- **Tools threading** (`agent-dispatch/service.ts` `DispatchTurnInput.tools?`;
  `agent-dispatch/substrate-turn.ts`): the runner maps `input.tools` onto stub
  `AgentSpec` ToolDefs (the `trident/conflict-resolver.ts:80-87` precedent) so a
  ritual's `tool_surface` reaches the spawned REPL's `--tools` argv. Omitted →
  the historical toolless `tools:[]` (dispatch family unchanged).
- **`PROFILE_RITUAL`** (`gateway/wiring/substrate-profiles.ts`) — the scheduled
  ritual REPL trust class; byte-identical `{skip_permissions:true}` today, kept
  DISTINCT so the T5 write-containment spike (task 6) tightens THIS grant first.
  Frozen in the byte-identity equivalence test.
- **`append_system_prompt_file` threading** (`gateway/wiring/build-llm-call-substrate.ts`
  `BuildLlmCallSubstrateInput.append_system_prompt_file?` → `ClaudeCodeSubstrateOptions.
  appendSystemPromptFile`, emitted `build-repl-argv.ts:109`). Absent → the
  substrate's `repl-agent-base.md` default (chat persona) — unchanged for every caller.
- **`reminders/ritual-agent-base.md`** (NEW, shipped in the package) — the
  UNATTENDED-executor system prompt (no user present, never ask, use only granted
  tools, one final reply). `RITUAL_AGENT_BASE_PROMPT` absolute path exported from
  `reminders/prompt-path.ts` (module-dir pattern).
- **`makeRitualSubstrate`** (`open/wiring/substrates.ts`) — a FRESH ephemeral
  `cc-ritual-*` REPL per fire, `PROFILE_RITUAL`, `append_system_prompt_file:
  RITUAL_AGENT_BASE_PROMPT`, NO `enableToolBridge`, NO owner-chat sinks; throws on
  empty pool. Single-arg `(cwd)=>Substrate` so it drops into `buildCancellableDispatchTurn`.
- **`reminders/ritual-runs.ts`** (NEW) — the SOLE `code_ritual_runs` writer
  (`migrations/table-ownership.json` entry added). `createRitualRunStore(db)`:
  `insertSkipped` (started=ended=now, skip_reason) / `insertRunning`
  (subagent_run_id + content_hash) / `insertFailed` (spawn-refusal; no subagent
  row) / `markTerminal` (finished|failed|timed_out|crashed + ended_at + output
  truncated to 4000 chars, guarded `WHERE status='running'`). Async `db.run` only.
- **`reminders/ritual-executor.ts`** (NEW) — `createRitualExecutor(deps).fire(reminder)`:
  NEVER throws, NEVER awaits the turn. Validates via `validateRitualFire` + the
  content-hash checker built from the row's LIVE cadence (skip → durable 'skipped'
  row, spawns nothing); `spawnSubagent` kind `'ritual'` on the lane (spawn_key
  `ritual:<id>`, on_duplicate 'refuse'; refusal → 'failed' row, no registry leak);
  'running' row + best-effort registry running-flip; launches ONE substrate turn
  detached via `fireAndForget`. Settlement maps completed→finished, timed_out→
  timed_out, failed/cancelled→failed, rejection→crashed on the run row + drives the
  registry record terminal. STRUCTURAL `RitualTurn` type (no agent-dispatch import)
  so the composer passes the SAME `buildCancellableDispatchTurn` closure. NO
  delivery/notices (task 5).
- **Tick executor branch** (`reminders/tick.ts`) — `ReminderTickOptions.ritual_executor?`;
  after the #319 claim a `ritual_id` row routes to `ritual_executor.fire` via
  `fireAndForget('ritual-fire', …)`, SKIPS the dispatcher + `on_fired`, `fired++`,
  and is NEVER reverted; `runOnce` resolves while the turn is pending. No executor
  wired → the (already-claimed) row is consumed + logged, never a nudge fallback.
  Nudge path byte-identical.
- **Composition wiring** — `CompositionInput.ritual_executor_factory?` (`gateway/
  composition/input/notifier-input.ts`); `remindersModule deps:['approval']` builds
  the executor with the graph's `ApprovalManager` (`gateway/composition/build-core-modules.ts`);
  the Open composer builds the factory (llmPool-gated) reusing the hoisted
  `subagentRegistry` + `makeRitualSubstrate` + `getBestModel`, registry rooted
  `<owner_home>/rituals` (ZERO defs until task 7), scope→owner_home v1 (`open/composer.ts`).
- **Tests** — `runtime/subagent/spawn-lane.test.ts` (lane isolation both directions);
  `agent-dispatch/substrate-turn.test.ts` (tools→spec.tools names / omitted→[]);
  `reminders/tick.test.ts` (ritual→executor not dispatcher/on_fired; nudge contract
  untouched; recurring ritual advances with NO revert on fire() reject; unwired→
  consumed+logged; fire-and-forget proof); `reminders/ritual-executor.test.ts`
  (skip verdicts durable + no spawn; approved → registry 'ritual' + 'running' row
  content_hash + turn input; each terminal mapping; crash; spawn-cap 'failed' no
  leak; fire() never rejects); `gateway/wiring/__tests__/substrate-profiles.test.ts`
  (PROFILE_RITUAL byte-identity + append_system_prompt_file threading);
  `gateway/composition/build-core-modules-ritual-executor.test.ts` (factory invoked
  with the graph ApprovalManager + wired as the tick branch, mutation-kill).
  `bash scripts/ci/depcruise.sh`: NO new cross-band edge.

## 2026-07-21 — Executor-mode reminders task 3: content-hash ritual approval gate + real approval notifier

The approval infrastructure that gates every ritual fire, plus the composer's
FIRST real `approval_notifier` (was a no-op stub). No new table, no migration —
durable grants are ordinary `tool_approvals` rows (migration-0004 DDL,
`migrations/0004_gateway_core.sql:66-79`). Spec of record:
`docs/plans/executor-mode-reminders-2026-07-20.md`.

- **`ApprovalManager.findApproved(project_slug, tool_name)`** (`tools/approval.ts`)
  — a generic synchronous query returning every `status='approved'` row for the
  pair, `ORDER BY decided_at ASC` (mirrors `get`/`listPending`). This is the ONLY
  ritual-agnostic addition to the platform layer; ALL ritual logic lives in
  `reminders/` (a legal services→platform edge — `.dependency-cruiser.cjs`
  `platform-stays-low` forbids the reverse).
- **`reminders/ritual-approval.ts`** (new; `reminders/package.json` gains
  `@neutronai/tools`):
  - `computeRitualContentHash` — SHA-256 hex over a canonical JSON ARRAY of
    (prompt bytes ‖ SORTED tool surface ‖ scope ‖ cadence ‖ model tier ‖
    timeout). JSON-array canonicalization is delimiter-injection-proof; sorting
    the surface makes grant order irrelevant.
  - `ritualCadenceString` — `spec:<cron>` | `legacy:<coarse>` | `once` from the
    row's mutually-exclusive `recurrence_spec`/`recurrence` (`reminders/store.ts:41-49`).
  - `ritualApprovalToolName`/`ritualEgressApprovalToolName` — the namespaced
    `tool_name` (`ritual:<id>` / `ritual-egress:<id>`); `:` is forbidden in both
    the ritual id charset and tool tokens, so these never collide with a real tool grant.
  - `requestRitualApproval` — submits a `prompt-user` request (the FIRST real
    production caller of `ApprovalManager.requestApproval`) carrying the content
    hash in `args_json`; an `egress:'web'` def mints a SECOND, separately-approved
    `ritual-egress:<id>` request bound to the SAME hash (approving content never
    implicitly approves egress). Returns both decision promises without awaiting.
  - `createRitualApprovalCheck({manager, project_slug, cadence})` — implements
    task 2's `RitualApprovalCheck` seam. RECOMPUTES the hash from the LIVE prompt
    bytes on EVERY `isApproved` call (ported the legacy harness prompts are mutable files);
    requires a content grant, and for web defs an egress grant, whose
    `args_json.content_hash` matches. A malformed `args_json` row is skipped
    (never a match, never a throw); DB/manager errors PROPAGATE so
    `validateRitualFire` fail-closes to 'unapproved'. **Design consequence:**
    a cadence change or a `reminders_update` (atomic cancel+create → new id,
    `cores/free/reminders/src/mcp-tools-extra.ts:64`) DROPS approval.
- **`open/wiring/approval-notifier.ts`** (new) — `buildAppWsApprovalNotifier`
  replaces the composer's `approval_notifier: { notify: async () => undefined }`
  no-op (`open/composer.ts`, base composition). Broadcasts a PLAIN-TEXT
  `agent_message` (`Approval requested [<id>]: <tool_name>[ — <description>]`) to
  every live app-ws topic per the `watchdogNotifier` precedent (composer
  ~3338-3364); fail-soft throughout (never throws into `ApprovalManager`; one dead
  socket never stops the rest). NEVER includes prompt bytes / tool surface / args
  beyond `description`, never Markdown — the rich itemized rendering with the
  affirmative-act binding is task 8. `appWsRegistry` (composer :2051) satisfies
  the structural `ApprovalNotifierRegistry` by construction.
- **NO auto-approval anywhere** — every request is `policy:'prompt-user'`; a
  bundled ritual stays unapproved (→ fire-time SKIP) until the owner's explicit
  `respondApproval`. No-self-approval enforcement (`resolution_speaker_user_id`)
  arrives with task 8's ButtonStore surface.
- **Tests** — `reminders/ritual-approval.test.ts` (11 cases: hash determinism +
  per-field sensitivity + order-insensitive surface; cadence-string; single- and
  dual-grant request with durable-record assertions; end-to-end seam bind over the
  real registry with an on-disk prompt; RE-VERIFY-EVERY-FIRE prompt-tamper drop;
  cadence-change drop; egress-separately-approved; denied/pending/malformed
  non-match; throwing-store fail-closed through `validateRitualFire`; no-auto-approve
  pending-decision). `tools/approval.test.ts` +1 (`findApproved` slug/tool/status
  filtering). `open/__tests__/approval-notifier.test.ts` (3: per-topic broadcast +
  body content, malformed-args fallback, dead-socket resilience). All green;
  `reminders/` + `tools/` suites 275 pass; dep-cruiser + tsc (reminders/tools/open) clean.

## 2026-07-20 — Executor-mode reminders task 2: ritual schema + registry module (migration 0106)

The persistent + pure-logic foundation of the ritual layer (executor-mode
reminders — a reminder that spawns a scoped sub-agent REPL at fire time instead of
composing a nudge). Schema + registry only; the tick dispatch branch, approval
gate, and completion delivery are plan tasks 3-5. Spec of record:
`docs/plans/executor-mode-reminders-2026-07-20.md`.

- **Migration `0106_ritual_schema.sql`** — three forward-only DDL units:
  (A) nullable opaque-TEXT `reminders.ritual_id` (0095 `recurrence_spec`
  precedent — the in-process registry is the authoritative validator, a CHECK
  would force a table rebuild per ritual; NULL = nudge row, no backfill); (B) new
  durable `code_ritual_runs` run-history table (own retention, NOT pruned on the
  subagent-registry liveness prune, `runtime/subagent/store.ts:171` — the durable
  answer to "why didn't my morning brief run"; richer status vocab than the
  registry: `skipped`/`running`/`finished`/`failed`/`timed_out`/`crashed` +
  `skip_reason` CHECK-coupled to `skipped` via `CHECK ((status='skipped') =
  (skip_reason IS NOT NULL))`; carries `subagent_run_id`/`content_hash`/
  `failure_reason`/`output_summary`; a `ritual`+`started_at` index and a partial
  `live` index); (C) widened `code_subagent_registry.agent_kind` to admit
  `'ritual'` via create-copy-drop-rename (SQLite cannot ALTER a CHECK), the 0100
  DDL reproduced verbatim with only the enum widened, STRICT + all CHECKs + both
  0100 indexes preserved, rows copied by explicit column list. `expected-schema.txt`
  regenerated (only the three expected shapes — reminders col, new table+indexes,
  agent_kind enum + the RENAME name-quote); `runner.test.ts` version list + 106.
  NO `table-ownership.json` entry — coverage is opt-in and this table has no
  writers yet (the first runtime-writer task adds it).
- **`AgentKind` widened** (`runtime/subagent/registry.ts:25`) to include `'ritual'`.
  Consumers are `Partial<Record<AgentKind,…>>` (watchdog, dispatch prompts) OR
  narrow the union with `Exclude`: trident `DispatchAgentKind` now excludes BOTH
  `'core'` and `'ritual'` (`trident/agent-prompts.ts:50`) so its persona
  `Record`s stay exhaustive — a ritual is spawned by the reminders tick with its
  own `rituals/<id>.md` prompt, never through the trident persona loader (Argus
  round-2 BLOCKER fix: the earlier "compile-safe, only Partial consumers" claim
  was false — `PersonaAgentKind` derives from `AgentKind` via non-partial
  `Record` and broke `tsc`).
- **`reminders/rituals.ts`** — the pure registry + fail-CLOSED fire-time verdict.
  `RitualDef` (charset-guarded id `^[a-z0-9][a-z0-9-]{0,63}$` — traversal
  impossible by construction; `description` non-empty ≤200 chars = the approval
  capability line [task 8]; `scope` project|instance; `tool_surface` NEVER empty
  [#361 toolless-class pin], each entry a tool token [`Bash` allowed — overturn 1,
  security rides the approval gate not exclusion]; `egress` `'none'|'web'`
  register-time-consistent with the surface; `silent`; NO `requires_approval`,
  NO `prompt_path`/`model`/`timeout` fields — approval is a separate content-hash
  record [task 3], prompt derived `rituals/<id>.md`, tier `'best'` + 45-min
  timeout are module constants). `createRitualRegistry({rituals_dir})` →
  `register()` (throws on bad id/dup/empty-or-long description/empty surface/bad
  token/egress-inconsistency; stores a frozen copy) / `get` / `list` /
  `promptPathFor`. Argus round-2: `assertValid` now also runtime-guards the
  `scope`/`egress`/`silent`/`tool_surface` field TYPES (a def can arrive from
  imported user-data JSON the compiler never saw — a bogus `scope:'arbitrary'`
  or `egress:'bogus'` now FAILS CLOSED at register time instead of slipping past
  the consistency checks). Argus round-3 extends this to the two regex-validated
  fields: `def.id` and each `tool_surface` entry now get a `typeof … !== 'string'`
  guard BEFORE `RegExp.test` (which stringifies its argument, so `42`→`"42"` and
  `null`→`"null"` would MATCH the charset and register under a non-string Map key
  / freeze a non-string tool grant into the surface that flows to approval hashing
  + spawn — now both throw). `validateRitualFire(registry, approvals, id, log)`
  async → `unknown_ritual` | `missing_prompt` (missing/unreadable/empty/over-256KB;
  the 256 KiB cap is now enforced from `statSync().size` BEFORE the file is read
  into memory — Argus round-2 minor) |
  `unapproved` (false OR THROW — fail CLOSED) | ok. The `RitualApprovalCheck` seam
  is REQUIRED (no permissive default anywhere), consulted only after the prompt is
  read. A fail verdict logs once and SKIPs — never degrade-to-nudge, never
  `tools:[]`.
- **`reminders/store.ts`** — `ritual_id` is READ-THROUGH only: plumbed through
  `Reminder`, `ReminderDbRow`, `COLS`, `rowToReminder`, and the two return
  literals (`ritual_id: null`). Deliberately NOT added to `CreateReminderInput` /
  `CreateRecurringReminderInput` and NOT written in either INSERT — the only writer
  lands with its validation (registration = task 8, tick wiring = task 4), so the
  column defaults NULL untouched. Public surface exported from `reminders/index.ts`.
- **Tests** — `reminders/rituals.test.ts`: registry round-trip + frozen-copy
  independence; every `register()` invariant is a throw (bad ids, dup, empty
  surface, bad token, both egress inconsistencies, empty/over-long description,
  Bash-surface accepted); all four fire verdicts with `not.toHaveBeenCalled` on
  early skips and `toHaveBeenCalledWith(def, exact-bytes)` on the approval seam,
  approval-THROW → unapproved with a single log line, artifact-grounded happy-path
  marker + no-fallback-shape assertion; constants; 0106 CHECK tests
  (`agent_kind` ritual ok / bogus rejected, `code_ritual_runs` status +
  skip_reason invariant) + a rebuild-preserves-data test (apply 0000-0105, insert
  a legacy `forge` row, apply 0106, assert the row survives field-for-field and
  `ritual` now inserts). `reminders/store.test.ts`: create() defaults `ritual_id`
  null + a raw-`UPDATE` read-through round-trip (the write path deliberately
  doesn't exist yet).

## 2026-07-20 — M2-3 round 2: §7.2 merge-safety gate closes the memory-consolidation arming precondition (Argus r1 BLOCKER)

Task 1 of the executor-mode-reminders branch armed the 6h memory consolidation ON
by default (P0-4), but the memory-system design named two mitigations as "STILL
PENDING before arming" (the §7.2 name-tripwire and merge-loser quarantine) and the
dedup code comments lied about them — `jaccard.ts` claimed "consolidation is not
armed" (now false) and cited a "§7.2 merge name-tripwire" that had no
implementation. Argus flagged the armed-without-mitigation state as a corruption
BLOCKER. This round implements the actual safety gate that prevents the
irreversible false-fusion and makes the comments true.

- **`isMergeSafeCluster` merge-safety gate** (`scribe/reflect/jaccard.ts`), applied
  by `dedupPages` to every candidate cluster BEFORE the irreversible fuse
  (`scribe/reflect/reflect-pass.ts`). Two gates block the two false-positive
  signatures the 0.7 Jaccard cut alone would let through:
  - Gate A (**shared name token**) — HOLDS two DIFFERENT-named entities that reach
    the bar only via shared relation targets (`Bob`/`Carol` each `Works at
    [[org0]]/[[org1]]/[[org2]]` = 0.714 but share no name token). §7.2 residual B.
  - Gate B (**corroboration beyond the name**) — excluding the name, members must
    still be pairwise ≥ threshold similar on BODY-ONLY tokens; HOLDS two DISTINCT
    fact-less entities sharing an identical name (two "John Smith" pages score 1.0
    on name tokens but collapse to empty body sets once the name is excluded).
    §7.2 residual A. Name exclusion is EXPLICIT: each candidate's title tokens are
    subtracted from its body token set before the pairwise score, because
    `stripBoilerplate` only removes the generated `# <Name>` H1 — name tokens that
    appear in PROSE (`John Smith is an engineer at Google` vs `… at Facebook`) would
    otherwise inflate body Jaccard to 0.75 ≥ 0.7 and irreversibly merge two distinct
    people; with title tokens subtracted the score drops to 0.667 < 0.7 → correctly
    HELD (Argus r1 blocker fix).
- **HELD ≠ merged.** A held cluster keeps every member as its own survivor (the
  pass's always-safe missed-merge direction), increments the new
  `ReflectReport.held` counter, and is logged LOUDLY so the owner can hand-merge a
  genuine duplicate the gate was conservative on. Merge-loser quarantine is NO
  LONGER an arming blocker — the gate prevents the false identity-fusion outright,
  and genuine near-duplicate losers are already absorbed into the survivor before
  deletion (no content loss).
- **Comments/docs corrected** to match the armed reality: `jaccard.ts`
  (`DEFAULT_JACCARD_THRESHOLD` + `MIN_DISTINGUISHING_TOKENS` doc), the memory-system
  design doc's "STILL PENDING before arming" block, and SYSTEM-OVERVIEW's dedup
  section (which had downgraded "close before arming" to "corpus-tuning follow-up").
- **Tests** (reproduce-then-fix): `scribe/__tests__/reflect-jaccard.test.ts`
  (`isMergeSafeCluster` holds residuals A + B, passes genuine near-duplicates,
  singleton trivially safe) and `scribe/__tests__/reflect-pass.test.ts`
  (behavioural, real on-disk: two "John Smith" pages HELD with both surviving +
  nothing deleted + `report.held == 1`; `Bob`/`Carol` HELD; genuine near-duplicates
  still merge with `report.held == 0`). Suite: 122 scribe tests green.
- **Argus r1 minors** also addressed: `open/__tests__/reflect-loop-arming.test.ts`
  leak-guard now spies on `SupervisedLoop.start` keyed on the loop's IDENTITY
  (`name`), not the no-longer-unique 6h cadence; `open/__tests__/loop-inventory-boot-shell.test.ts`
  real-boot test timeouts raised 30s→60s to absorb full-suite-parallelism
  contention (a genuinely-hung boot is still a distinct, louder signal).

NOTE: the executor-mode reminders deliverable (ritual schema, executor dispatch
branch, approval gate, T5 write-containment) is NOT built by this PR — it is the
remaining RALPH iterations 2–10 on `IMPLEMENTATION_PLAN.md`. This branch is Task 1
(consolidation flag-collapse) + its arming precondition. P0-1 M2 is NOT done.

## 2026-07-20 — #374 Defect 2a: the LIVE onboarding-complete emit stamps the durable handoff marker ONLY on real delivery (kills the residual post-claim bounce)

Closed the OPEN half of the #374 claim-jank fix. The reconnect-recovery replay in
`open/wiring/app-ws.ts` re-fires `onboarding_completed` while
`onboarding_handoff_emitted_at` is still NULL and phase === `completed`. Migration
0054 (`0054_onboarding_state_handoff_emitted_at.sql`) + #404 made the REPLAY path
stamp after its own send (stopping the INFINITE loop), but the LIVE emit at
finalize never wrote the stamp — so on a Managed box the FIRST reconnect after
finalize still saw a null stamp and re-fired the frame ONCE, bouncing the
just-completed owner to the claim / manual-link screen (#374 Defect 2). The signal
was at-most-once per page load on the replay side but NOT at-most-once across the
live + replay paths.

- **Delivery-aware stamp on the live emit** (`onboarding/openings/finalize.ts`,
  step (5c), right after `deps.emitOnboardingCompleted?.(...)`). The emit seam now
  RETURNS whether the frame reached at least one live socket:
  `fanOnboardingCompleted` (`open/composer.ts`) accumulates the registry
  `send()` boolean (`channels/adapters/app-ws/session-registry.ts` returns true iff
  a device received it) and returns it; `emitOnboardingCompleted` propagates it.
  finalize stamps `onboarding_handoff_emitted_at` (via the SAME
  `OnboardingStateStore.upsert` the replay path uses) ONLY when that delivery is
  true. Gating on delivery — not on the seam being wired (the seam is
  UNCONDITIONALLY wired in production) — is the round-2 correction: a finalize that
  reaches ZERO sockets (a background import-completion watcher fires with the tab
  closed) leaves the stamp null so the reconnect replay still recovers the claim
  redirect exactly once. Guarded + idempotent (only stamp while still null, so a
  coalesced/duplicate finalize never double-stamps) and best-effort + non-throwing
  (a failed stamp never rolls back the completed owner; worst case is one extra
  replay, the pre-fix behaviour).
- **Result**: when the live frame was delivered, the post-finalize reconnect reads
  a non-null stamp and does NOT re-emit → no residual bounce; when it was dropped,
  the null stamp keeps the reconnect replay armed for exactly-once recovery.
  `onboarding_completed` is now genuinely at-most-once across the live + replay
  paths without stranding the offline-finalize owner.
- **Tests** (reproduce-then-fix):
  `gateway/wiring/__tests__/build-onboarding-finalize.test.ts` — a LIVE, DELIVERED
  emit finalize now stamps `onboarding_handoff_emitted_at` (failed on prior main:
  stayed null) + a guard-negative that the app-ws replay predicate
  (`completed && stamp === null`) is false afterwards; a seam-WIRED-but-ZERO-SOCKETS
  finalize (frame dropped) leaves the stamp null so the replay predicate stays true
  (fails under the round-1 seam-gated fix, which stamped and stranded the offline
  owner); and an LLM-less-path (no seam) test that the stamp stays null.
  `tests/integration/claim-redirect-once.open.test.ts` — after a real live+delivered
  finalize, the FIRST reconnect against the real app WebSocket emits ZERO
  `onboarding_completed` frames (failed on prior main: the null stamp let the replay
  re-fire once). Scope: the live-emit stamp only; the Managed claim flow (Defect 1
  start-token + 2b auto-redirect) is a separate PR.
## 2026-07-20 — Per-project isolated onboarding compose (#377 + #378, Approach A)

Closed the two trust-critical onboarding-opening defects (SPEC Decisions Log
2026-07-20 "Per-project session OPENINGS are FULLY LLM-composed + unique per
project"), the SAFE way — WITHOUT the two BLOCKERS the prior attempt (#419) hit
(reusing the live-chat `cc-agent-*` pool key, which could evict an in-flight live
turn (B1) and open a tool-enabled prompt-injection path (B2)). Each half ships a
reproduce-then-fix test that FAILS on prior main.

- **#378 cross-project bleed — isolate BOTH the openings AND the doc materializer**
  (`open/wiring/substrates.ts`, `open/composer.ts`, `gateway/wiring/build-project-doc-composer.ts`,
  `gateway/wiring/build-project-kickoff-composer.ts`). Previously the project-doc
  composer (README / `docs/transcript-summary.md`), the agentic-kickoff DOC
  composer (`starting-plan.md`), and the opening composer ALL shared ONE
  accumulating owner-wide `cc-llm-*` phase-spec session, so project 2/3's docs +
  openings echoed project 1. New `makeComposeSubstrate(project_id)` factory builds
  a per-project `cc-compose-*` substrate with `projectIdResolver: () => project_id`;
  the composers resolve their client through a `clientForProject(project_id)`
  factory (`composeClientForProject`). The warm-pool key folds the project id
  (S3 §2), so each project keys a DISTINCT transcript → no bleed. Closing the DOC
  MATERIALIZER too (not just the openings) is what fully closes #378 (B3 — the docs
  FEED the openings).
- **Approach A safety (fixes #419's B1/B2)** — `cc-compose-*` is a DISTINCT pool-key
  namespace from live-chat `cc-agent-*`, so a compose can NEVER evict/terminate the
  owner's in-flight live-chat turn (B1); it is TOOLLESS (no `enableToolBridge`, new
  `PROFILE_ISOLATED_COMPOSE`) so untrusted project-doc-derived input has no tool
  surface and cannot persist into a tool-enabled live session (B2); and it wires
  NONE of the owner-facing notice/delivery sinks, so compose text/banners never
  post to the owner's chat (B2 side-effect).
- **#377 hardcoded lead removed — opening is FULLY LLM-composed** (`onboarding/openings/kickoff.ts`,
  `gateway/wiring/build-project-kickoff-composer.ts`). Dropped the two hardcoded
  lead scaffolds ("I took a first pass at X and drafted a starting plan" / "I did a
  little digging on X and jotted some starting notes"). The kickoff composer gains
  an `opening_message` kind that composes the presenting chat bubble in the SAME
  per-project isolated session (grounded in the project's signal + the drafted doc
  gist); the kickoff appends the tappable `docs:/` link. On any message-compose
  failure it degrades to the doc's own first prose paragraph — and, for a
  heading-only generated doc, to the doc's OWN first heading text
  (`firstHeadingText`) — always project-unique + document-derived, never the
  retired generic boilerplate (round-2: Argus flagged the last-resort rung as a
  reusable-across-projects hardcoded lead; the heading-derived rung closes it).
- **Tests** — `#378` cross-bleed (real composer, 3 projects, isolated vs shared
  session model — the shared path demonstrates the on-main bleed); white-box
  isolation (`cc-compose-*` keyed by project_id, distinct pool key, toolless, no
  sinks); no-mid-turn-kill (compose never shares the `cc-agent-*` key); #377
  (openings vary per project + no hardcoded lead). `bun test onboarding/` 940/0;
  touched gateway/open wiring suites green.
- **Scope** — ZERO changes to the live-chat `cc-agent-*` turn logic, the phase-spec
  resolver/suggester session, or unrelated onboarding phases.

## 2026-07-20 — #371 (part b): tenant-side auth screen is managed-unreachable

The OSS install-token / Claude-auth surface in `landing/server.ts` is now gated
OFF on a **managed** tenant — the Open-side backstop for #371 (the owner saw a
DUPLICATE auth screen on a managed box). The install-token surface exists for an
OSS self-hoster with no control plane; on managed the control plane owns auth
(the tenant is seeded with the Max token by the control-plane handoff — the #371
control-plane RACE half is already fixed + deployed in the Managed repo), so the
tenant-side screen must be UNREACHABLE.

- **Deployment-role signal reaches the landing server.** `LandingServerOptions`
  gains `deploymentMode?: 'open' | 'managed' | 'connect'`, threaded from the
  canonical `resolveDeploymentMode()` (`NEUTRON_ROLE`) in
  `gateway/wiring/build-landing-stack.ts`. When the option is unwired,
  `createLandingServer` falls back to `resolveLandingDeploymentMode(process.env)`
  (a local mirror of `gateway/deployment-mode.ts` — landing takes no dependency
  on gateway) so the gate holds env-derived even if a composer forgets it. NOT a
  feature flag: the same managed-vs-open discriminator onboarding sequencing uses.
- **Two gates, when role === managed** (`landing/server.ts`):
  the four `/oauth/max/install-token/*` routes are intercepted BEFORE
  `installTokenHandler` (`landing/server.ts:901`), and `GET /chat`'s
  `chatAuthGate` unauthenticated branch (`landing/server.ts:968`) — both serve
  the neutral `renderManagedProvisioningHtml` "workspace is being provisioned"
  page (HTTP 503) instead of the OSS auth screen. Open/self-host default: both
  surfaces serve normally.
- **Reproduce-then-fix test** (`landing/__tests__/managed-install-token-gate.test.ts`,
  8 tests): managed → install-token route + `/chat` gate → 503 provisioning page
  (NOT the OSS screen); open → both serve; `NEUTRON_ROLE=managed` env backstop
  with the option unset. Verified FAILING on prior main (managed install-token
  route returned the OSS handler's 200, not 503).

## 2026-07-20 — #375: post-onboarding workspace opens on General, not a random project

The workspace `/chat` load (notably the post-onboarding Managed claim redirect to
`https://<slug>/chat`, which carries NO topic) used to land on an arbitrary PROJECT
topic — a confusing "where am I?" landing. Root: `landing/chat-react/config.ts`
`resolveBootstrapConfig` read the server-injected `window.__neutron_active_project_id`
(set to the FIRST project row by `open/wiring/owner-gate.ts:216`) as the initial
scope, so a bare load opened whatever project happened to be first.

- **Client default is now General** (`landing/chat-react/config.ts`). New pure helper
  `initialProjectIdFromLocation(search, projects)` decides the initial scope: it
  returns a project id ONLY for an explicit deep-link on the page URL —
  `?project=<id>` (canonical) or `?topic=<id>` (alias) — validated against the
  project-id char class AND the injected project list (unknown/malformed → General).
  Everything else → `null` (General). `__neutron_active_project_id` is no longer read
  for the initial scope (kept on the `WindowLike` type + still server-injected for
  back-compat, marked deprecated). Deep-links to a specific project topic still open
  that project.
- **Tests** (`landing/chat-react/__tests__/config.test.ts`): reproduce-then-fix —
  a bare `/chat` load with `__neutron_active_project_id: 'p1'` injected now resolves
  `projectId: null` (FAILED on prior main, which returned `'p1'`); `?project=`/`?topic=`
  deep-links open the named project; unknown ids fall back to General. Full
  `landing/chat-react` suite green (371 pass, 0 fail).

## 2026-07-20 — Chat #376: a RAW doc-link in a chat message opens the Docs tab

Fixed the live #376 defect (hit 2026-07-20 on the onboarding "first pass" message):
a file/doc link in a chat bubble did NOTHING when clicked. Root cause, verified
against real rendering: `rehype-sanitize` strips a `docs:`/`neutron:` scheme href
BEFORE any click handler can read it, so a bubble carrying the canonical marker
`docs:/<id>/<path>` or the native `neutron://docs/<id>/<path>` shape rendered a
DEAD link (an `<a>` with no `href`). The `app-ws` adapter rewrites LIVE web pushes
to the web `/projects/<id>/docs?path=…` shape (which the client already
intercepts), but the RESUME replay (`appChatRowToEnvelope`) re-emits the persisted
body verbatim, and that body is channel-baked at send time — so a non-web-baked
doc-link reaches the web client raw.

- **FIX (client, in Neutron Open)** — `landing/chat-react/doc-link-nav.ts` adds
  `webifyDocLinkHref`, which normalizes the two RAW project-doc shapes
  (`docs:/<id>/<path>` marker + `neutron://docs/<id>/<encoded path>` native scheme)
  to the same-origin `/projects/<id>/docs?path=<enc>` URL (traversal-guarded,
  anchor-tail-stripped). `landing/chat-react/Markdown.tsx` runs it as a rehype
  plugin (`rehypeWebifyDocLinks`) BEFORE `rehype-sanitize`, so the href survives
  sanitize and the existing `onDocLink` tap-interception (+ SPA-boot handler) open
  it in the Documents tab. External URLs and the already-web shape are untouched.
- **Tests (reproduce-then-fix)** — `__tests__/doc-link-raw-marker-open.test.tsx`
  delivers a RAW `docs:/acme/brief.md` marker, clicks it, and asserts the Documents
  tab activates + the doc opens (FAILS on prior main: the link had no href → the
  click was inert). `__tests__/doc-link-nav.test.ts` adds `webifyDocLinkHref` unit
  coverage (marker, native, nested, anchor-strip, traversal-reject, external
  untouched, `.`/`..` projectId rejected). `landing/chat-react` suite green
  (382 pass, 0 fail on current main post-rebase).

## 2026-07-20 — Work Board #379: trackable work ≠ a Trident build run

Closed the three #379 dogfood defects rooted in "a Work Board card == a Trident
BUILD run" (SPEC Decisions Log 2026-07-20 "Work Board: 'trackable work' ≠ 'a
Trident build run'"). Each ships a reproduce-then-fix test that FAILS on prior main.

- **WRITE — leave a card for ANY substantial work** (`gateway/wiring/operating-doctrine.ts`).
  Lifted "leave a trackable Work Board card for ANY substantial/multi-step work —
  research, analysis, deep work, OR a build: `work_board_add` FIRST, set
  `inline_active` while working, mark done when finished" into an UNCONDITIONAL
  `DOCTRINE_PRINCIPLES` entry (ships every turn). Previously the ONLY card
  directive lived in `BUILD_ROUTING_DOCTRINE` — scoped to explicit builds AND
  phrased "if you have the `work_board_dispatch_build` tool", so a research job
  left no card. Trident-routing specifics stay build-scoped.
- **DISPLAY — a plain active card opens the pane** (`landing/chat-react/WorkBoardTab.tsx`
  `summarize`, `landing/chat-react/PlansPane.tsx` controller). `WorkBoardSummary`
  gains `active` = a non-terminal in_progress/inline_active card with NO live run
  (`linked_run_id: null`). The desktop pane now KICKS OPEN on `running` OR `active`
  rising, stays open while any of running/failed/active > 0, and auto-CLOSES only
  once ALL THREE are zero. Sticky + manual-toggle preserved. Fixes the plain
  in_progress card that never opened the pane.
- **ROUTING + LIFECYCLE — the ▶ routes BY TASK TYPE** (migration `0105`, `work-board/store.ts`,
  `gateway/http/work-board-surface.ts`, `agent-dispatch/board-research-start.ts`,
  `open/composer.ts`, `landing/chat-react/*`). New `task_type` column ('build' |
  'research', DEFAULT 'build') + a minimal web Build/Research picker. The ▶/play
  route now branches: a 'research' card dispatches an **Atlas** research run
  (agent-dispatch), a 'build' card dispatches **Trident**. Research LIFECYCLE
  (`createBoardResearchStarter`): delivers the Atlas result back to the originating
  chat via the durable app-ws poster (persisted → renders in React), and on
  terminal (success OR crash/cancel/timeout) marks the card terminal (done |
  failed) so the pane auto-closes — never stranding it in_progress. Guards:
  surface `409 already_running` on a live linked run + a per-card `spawn_key`
  coalesce (no duplicate Atlas run) + delete-cancels the dispatch run.

> Pre-consolidation history (unit K6, 2026-07-05): the former root `AS-BUILT.md`
> (7,647 lines — the anchored record of behavioral invariants through 2026-07-04)
> is archived VERBATIM at `docs/research/AS-BUILT-archive-2026-07.md`, and the
> former `docs/AS-BUILT.md` (1,469 lines — PTY terminal-detection ports, the
> Trident v2 Workflow cutover, Work Board Phase 1a/1b, parity-gap closures) at
> `docs/research/AS-BUILT-docs-archive-2026-07.md`. This file is the ONE live
> changelog going forward.

## 2026-07-20 — M2-3 / P0-4: `NEUTRON_PERFECT_RECALL` collapsed — perfect-recall lane default-ON, 6h consolidation

Deleted the `NEUTRON_PERFECT_RECALL` feature flag (`runtime/perfect-recall-flag.ts`
+ its test + the sole-consumer `runtime/env-flag-tokens.ts`). The whole
perfect-recall lane — RB1 memory-index manifest, RB3 reflect-consolidation loop,
RB4 supersede, RC2 agent-nexus — is now the UNCONDITIONAL default, and the reflect
consolidation cadence flips 24h→6h ON by default (`DEFAULT_REFLECT_INTERVAL_MS =
6 * 60 * 60 * 1000`, `scribe/reflect/reflect-pass.ts`). This clears the standing
no-feature-flags violation (owner-locked, no dual code paths) and creates the
always-running attachment point the dreaming-half-into-core-memory work needs.
owner-locked: consolidation every 6h, ON by default (neutron-managed SPEC Decisions
Log 2026-07-20; managed SPEC §374-376; deepened plan build-order #1).

- **Four un-gated sites in `open/wiring/memory.ts`** — `memoryIndexHook`
  (wrap-sync-hook-with-memory-index, RB1), scribe `supersede` (RB4), `nexus =
  new NexusStore(...)` (RC2), and the `reflectLoop` `SupervisedLoop` (RB3) are all
  constructed unconditionally. The `WiredMemory` type tightens to non-optional
  (`memoryIndexRead: () => Promise<string | null>`, `nexus: NexusStore`,
  `reflectLoop: SupervisedLoop`), so the composer's `reflectLoop !== null` /
  `memoryIndexRead !== undefined` null-guards are removed (register-before-start +
  quiescing-stop ordering preserved verbatim).
- **LLM-less degrade path survives** — the substrate is still `llmPool`-gated
  (a real runtime condition, not a flag): an LLM-less box gets scribe=null and a
  dedup-only reflect pass, and `immediate:false` means no boot-time LLM call.
- **`supersede` option removed from the public scribe surface** (`scribe/extract.ts`,
  `scribe/index.ts`, `scribe/write-to-gbrain.ts`) — belief-evolution supersede is
  always on; the RB4 `relations[].supersedes` data marker is unchanged.
- **`gateway/nexus/nexus-emit.ts`** drops the dead `isPerfectRecallEnabled`
  re-export (grep-zero importers) and its flag-era doc block.
- Acceptance: `grep -rn "NEUTRON_PERFECT_RECALL|isPerfectRecallEnabled|perfect-recall-flag"
  --include='*.ts'` (excl. node_modules) → ZERO hits; a default-env boot constructs +
  registers + starts the reflect loop at 6h (`reflect-loop-arming.test.ts` asserts
  `describe().intervalMs === 21_600_000` with NO env var set); `bun test` green.

## 2026-07-20 — M2-3: memory-consolidation correctness — 3 dedup/supersede corruption blockers

Closed the three data-integrity blockers that gate the memory build
(memory-system-design-2026-07-20 blockers 1–3). All are correctness fixes to the
consolidation code — now the always-on default (the `NEUTRON_PERFECT_RECALL` flag
that gated it was collapsed the same day; see the entry above). These protect the
owner's canonical corpus from silent permanent corruption when consolidation runs.
Each fix ships with a reproduce-then-fix test that provably FAILS on the prior main.

- **BLOCKER 1 — dedup no longer fuses UNRELATED entities** (`scribe/reflect/jaccard.ts`).
  On main, five fact-less company pages (`# <Name>` + `Mentioned in chat (kind: X).`)
  collapsed into ONE entity in a single transitive pass — the exact corpus shape
  every real install accumulates. Three vectors fixed:
  - (1a) `stripBoilerplate` strips ONLY generated boilerplate before scoring — the
    generated title H1 (label == page title), the generated section headings
    (`## Relationships`/`## Merged`), and the fact-less `Mentioned in chat` line —
    and NEVER a hand-authored factual heading at any level (the #415 over-reach
    stripped ALL H1s and destroyed distinguishing factual tokens → false merges).
  - (1b) `tokenize` KEEPS numeric/alphanumeric tokens (`2024`, `q1`, `v2`) that
    `Intl.Segmenter` marks non-word-like and the old `continue` DROPPED, so
    fiscal-year / versioned / quarterly pages keep their only discriminator
    (ISSUES #373, resolved).
  - (1c) clustering now forms CLIQUES (every pair ≥ threshold — no transitive
    closure; a greedy clique that never over-merges) and requires
    `MIN_DISTINGUISHING_TOKENS` (= 2) non-boilerplate tokens for a page to be a
    merge candidate. The Jaccard threshold stays 0.7, configurable, flagged
    UNVALIDATED (must be re-measured on a real corpus before arming). Known accepted
    residuals to close before arming: (i) two DISTINCT fact-less entities sharing an
    identical ≥ 2-word name still merge (gated behind the merge name-tripwire);
    (ii) two DIFFERENT-named entities each asserting the SAME ≥ 3 relation targets
    can reach 0.714 because relation-verb tokens are not stripped and shared targets
    inflate overlap (`Bob`/`Carol` each `Works at [[org0/1/2]]`). Fix before arming:
    strip relation-verb tokens and/or gate a merge on a shared name token.
- **BLOCKER 2a — supersede survives resynth** (`stripSupersededSentences`,
  `scribe/write-to-gbrain.ts`). The strip is now keyed on the graph TRIPLE
  (predicate, object), not on matching the generated `RELATION_SENTENCE` template.
  On main, once a page was resynthesized into natural prose, every future supersede
  on it was a silent permanent no-op (`works_at NewCo` AND `works_at OldCo`
  asserted forever). Compound sentences are still spared entirely. Accepted residual:
  a single-relation sentence with descriptive prose is dropped IN FULL — the retired
  relation persists as an additive dated timeline row (`works_at oldco`), but
  `stripSupersededSentences` writes NOTHING to the timeline, so the sentence's
  descriptive detail and any co-located still-current non-edge fact (`earns $400k`)
  leave current truth and are not re-recorded. (Runs under the always-on
  consolidation default — see the flag-collapse entry above.)
- **BLOCKER 2b — resynth may not mutate a predicate** (`preservesEdges`,
  `scribe/reflect/reflect-pass.ts`). The accept-gate now compares extracted
  (predicate, object) PAIRS, not just wikilink TARGETS. On main a rewrite that kept
  the target but changed the verb (`Works at [[acme]].` → `Mentions [[acme]].`)
  passed the gate and committed, degrading a `works_at` edge to `mentions` — and
  because supersede is predicate-scoped, that mutated edge could then never be
  retired. Such a rewrite is now REJECTED.

Tests: `scribe/__tests__/reflect-jaccard.test.ts` (dedup vectors, clique,
min-token, numeric tokens, boilerplate strip), `scribe/__tests__/reflect-pass.test.ts`
("a re-synthesis that MUTATES a predicate on a preserved target is rejected"),
`scribe/__tests__/scribe-temporal-invalidation.test.ts` ("a SINGLE-relation PROSE
sentence for a superseded target IS retired"). Full `bun test scribe/` green (119).
Explicitly OUT of scope: blocker 4 (token-budget), doctor sequencing, the
timestamp-ordering guard, the watermark.

## 2026-07-20 — M2-1: the Cores→scribe fan-out now receives the LIVE Google clients

Closed a "wired but does nothing" partial-port. The Cores→scribe phase-2 fan-out
(scheduled Calendar + Email Cores → ambient extraction → GBrain) was CONSTRUCTED
inside `wireMemory` (`open/wiring/memory.ts`) with NO calendar/gmail clients, so
`mountCoresScribeFanOut` fell back to fresh `buildInMemoryCalendarClient()` /
`buildInMemoryGmailClient()` stand-ins. Result: ambient email/calendar → memory
extraction ran but **emitted nothing by construction, even with Google connected**
(the module's own comment said as much). Meanwhile `mountOpenCores` already built
the real OAuth-backed `calendarClient`/`gmailClient` (the SAME instances the
`calendar_core`/`email_managed_core` MCP tools + `/cal`/`/email` filters use) — but
never exposed them, and `wireMemory` (composer `open/composer.ts:~1046`) runs
~100 lines BEFORE `mountOpenCores` (`~:1150`), so they could not simply be passed.

THE FIX — **late-binding**, mirroring the `reflectLoop` precedent (construct early
/ register cleanup early / arm after the dependency exists):
- `MountedOpenCores` now exposes `calendarClient` + `gmailClient`
  (`gateway/cores/mount-open-cores.ts`).
- `mountCoresScribeFanOut` no longer takes clients or starts anything at
  construction; it returns a handle with `arm({ calendarClient, gmailClient })`
  that builds + starts the two schedulers, plus `stop()`/`idle()`. `arm()` is
  failure-atomic (a throw mid-arm tears down what it started) and single-shot
  (second call throws); `stop()` is a safe no-op before `arm`
  (`gateway/cores/mount-cores-scribe-fan-out.ts`).
- `wireMemory` CONSTRUCTS the fan-out (unarmed) + registers its `stop()` cleanup
  early, and surfaces it on `WiredMemory.coresScribeFanOut`; the composer ARMS it
  LAST with `coresWiring.calendarClient` / `coresWiring.gmailClient`, after every
  failure-prone step — so a composition failure between construct and arm leaks no
  running scheduler.

Behaviour: OAuth absent → the clients are in-memory fallbacks and the schedulers
fan out nothing (unchanged, correct degrade for an LLM-less / Google-less box);
Google connected → real events/mail now flow into GBrain with **zero further
wiring**. NO feature flag, one code path. Tests: `mount-cores-scribe-fan-out.test.ts`
(live-client arm → gmail message reaches the scribe writer + the live calendar
client is read; unarmed → schedulers null + `stop()` clean no-op; in-memory arm →
fans nothing; arm-twice guard) and `mount-open-cores.test.ts` (clients exposed).
Suites green: `open/` 334, `gateway/cores/` 76, `scribe/` 109.

## 2026-07-20 — SubstrateProfile refactor (tool-security redesign Step 0)

BEHAVIOUR-PRESERVING refactor — zero runtime change. Prerequisite (correction #6)
for the tool-security redesign (`docs/plans/tool-security-redesign-2026-07-20.md`).

The 8 production `buildLlmCallSubstrate({ ..., skip_permissions: true })` call
sites each hand-copied the security knob inline. That made the coming permission
migration (drop `--dangerously-skip-permissions` → `dontAsk`) 8 risky per-site
edits, which is incompatible with the no-feature-flags rule (a mode-gated scanner
would be a dual code path). This collapses those inline literals into named,
single-source `SubstrateProfile` constants so Phase B becomes N constant edits.

**New:** `gateway/wiring/substrate-profiles.ts` — the `SubstrateProfile` type
(carries the security knobs: `skip_permissions` today; RESERVED shape for
`permission_mode` / `claude_config_dir` / `extra_env` / `sandbox`, none wired
yet) plus six named constants: `PROFILE_TOOLLESS_UTILITY` (memory lane:
cc-scribe/cc-reflection/cc-reflect — toolless one-shots), `PROFILE_WARM_CHAT`
(cc-agent), `PROFILE_PHASE_SPEC` (cc-llm), `PROFILE_UNTRUSTED_IMPORT`
(cc-synthesis — history import), `PROFILE_EPHEMERAL` (makeEphemeralSubstrate),
`PROFILE_WARM_FIRE` (cc-trident-fire). Every constant encodes TODAY's exact
value byte-for-byte (`{ skip_permissions: true }`). UNTRUSTED_IMPORT and
WARM_CHAT are DISTINCT constants even though identical today, because the
redesign diverges them (the untrusted-import grant tightens first).

**Factory:** `buildLlmCallSubstrate` now accepts `profile?: SubstrateProfile`.
A profile field WINS over the matching legacy per-call input
(`skip_permissions` / `claude_config_dir` / `extra_env`); an absent profile
field falls back to it (backward compat for tests/direct callers). The reserved
`permission_mode` / `sandbox` fields are shape-only and NOT applied (no
`ClaudeCodeSubstrateOptions` field yet — that is Phase B / D). Runtime logic of
the factory is otherwise untouched.

**Sites migrated (8):** `open/composer.ts:954` (cc-synthesis),
`open/wiring/memory.ts` ×3 (cc-scribe / cc-reflection / cc-reflect),
`open/wiring/substrates.ts` ×4 (cc-llm / cc-agent / makeEphemeralSubstrate /
makeWarmFireSubstrate) — each now passes `profile: PROFILE_*` instead of the
inline `skip_permissions: true`.

**Safety net:** `gateway/wiring/__tests__/substrate-profiles.test.ts` — asserts
(1) every profile equals `{ skip_permissions: true }` exactly, and (2) for each
of the 8 sites, the RESOLVED `ClaudeCodeSubstrateOptions` from the new `profile:`
form deep-equals the resolved options from the pre-refactor inline form. Any
change to a resolved value is a build BUG, caught here. Suite: `bun test
gateway/wiring/ open/wiring/ runtime/adapters/claude-code/` green (1198 pass, 0
fail, 3 pre-existing skips).

## 2026-07-20 — substrate hardening: env injection + config-file exposure

Three fixes found by an adversarial security review of the tool-security
redesign. All are LIVE weaknesses in today's code, independent of that redesign,
so they ship on their own.

**1. Interpreter-injection env vars were inherited by every child.** `mergeEnv`
(`runtime/adapters/claude-code/persistent/repl-session.ts`) starts from the
gateway's whole `process.env` and deleted ONLY what a composer overlay unset (the
three Anthropic auth vars, ISSUES #49). `NODE_OPTIONS`, `BUN_INSPECT`,
`LD_PRELOAD`, `LD_AUDIT`, `DYLD_INSERT_LIBRARIES` and friends appeared NOWHERE in
the file, so a gateway env carrying `NODE_OPTIONS=--require /path/evil.js` was
arbitrary code execution inside EVERY spawned Claude child. Requires the
gateway's own environment to be poisoned first — defense-in-depth, not remotely
reachable — but there is no legitimate reason to inherit any of them. Now
stripped unconditionally in `mergeEnv` itself, so a new substrate factory cannot
forget it.

**2. The MCP sink TOKEN was written world-readable.** `spawn.ts` wrote the
mcp-config with NO mode argument (process umask) into a shared `tmpdir()` path
with only 4 bytes of entropy — and `--mcp-config <path>` is on the `claude` argv,
so the path is visible in `ps`. Any same-uid process could read the token. Now: a
per-spawn `0700` directory, files at `0600`, and 16 bytes of path entropy.

**3. The per-session settings file was `0644`.** It carries the Stop-hook wiring
today and becomes the session's PERMISSION POLICY under the redesign; a
world-readable security policy would be a hole. Now `0600`.

**Test** (`__tests__/env-hardening.test.ts`): pins the injection-var strip with
and without an overlay, confirms the ISSUES #49 credential scrub still holds, and
confirms `PATH` survives (a naive allow-list would break `bun`, which launches
the Stop hook and both MCP servers). **Verified RED pre-fix** — 2 of 4 fail
without the change. Adapter suite: 596 tests, 0 fail.

NOT fixed here, tracked for the redesign: the MCP bridge's per-PROCESS sink token
and the missing session check before `/tool-call` dispatch, and the
`ensure-claude-trust.ts` lost-update race.

## 2026-07-20 — black screen STILL reachable after #408: guard the doc-fetch unmount race (#380)

**Bug (live, the owner, same day as #408).** A single doc/history pane fetch 503 still
blanked the ENTIRE app. Console: `503` on `…/docs/file?path=…starting-plan.md`
and `?path=history.md`, then `Uncaught Error: Tried to unmount a fiber that is
already unmounted` (chat-react.js), then "An error occurred in one of your React
components" → the top-level boundary caught it and the whole screen went blank.

**Why #408 did NOT catch it.** #408 added `PaneErrorBoundary` around `DocumentsTab`
and `WorkBoardTab` in `ProjectShell` (necessary, and kept — it DOES wrap the tab).
But the "unmount a fiber that is already unmounted" invariant is thrown from React's
OWN commit/teardown phase, NOT from a child render — and an error boundary only
catches errors thrown during a child RENDER. So the pane boundary structurally
cannot catch this class. And there is no boundary above `ProjectShell` at the root
(`main.tsx` renders it bare), so nothing catches it: React does what it does for any
uncaught error and unmounts the WHOLE root → blank screen. (The owner console line
"the top-level boundary caught it" was React's default whole-tree teardown, not a
real app boundary.) #408 fixed the render-throw half and its test proved only that
half (it forced a render throw — it never reproduced the unmount race). The missing
half: `DocumentsTab`'s async doc-fetch continuations (`readFile`, `tree`,
`listComments`, save, and the comment/thread mutations) called `setState` even after
the pane unmounted. On a project switch mid-fetch, the 503 landed on a gone
component → setState-after-unmount → the invariant → blank app.

**Fix (`DocumentsTab.tsx`).** The only real fix is to stop the setState-at-the-
source (a boundary provably can't help here). Two guards:
- **`mountedRef`** — every async continuation bails (`if (!mountedRef.current) return`)
  once the pane unmounts, so no setState-after-unmount can fire the invariant.
- **`abortRef` (AbortController) — READS ONLY** — threaded into every docs READ (GET)
  via a `fetchImpl` wrapper and `abort()`-ed on unmount, so the in-flight 503 is
  actually CANCELLED rather than merely ignored. WRITES (PUT/POST — save, post/reply/
  resolve/escalate comment) are NEVER aborted: a mutation the user just fired must
  still reach the server even if they navigate away within the RTT (aborting it
  would silently drop the write). Writes rely on the `mountedRef` guard alone to
  skip setState-after-unmount. The lifecycle effect is declared BEFORE the fetching
  effects so the controller is fresh before any request fires, incl. StrictMode's
  mount→unmount→remount.
- The nested "refresh the open thread tree" `getThread` in the reply flow got a
  `.catch` — without it, the shared read-abort turned that re-fetch into an
  unhandled promise rejection in exactly the unmount path this change targets.
- The 503 file-open view now shows an inline error + a **"Try again"** retry button
  (`.cdoc-file-retry`) instead of a bare message.

**Test** (`__tests__/doc-pane-unmount-503.test.tsx`): (a)+(b) a 503 doc fetch
degrades to a per-pane error+retry while sibling chat + rail keep rendering and the
pane boundary does NOT trip; (c) unmounting mid-flight ABORTS the in-flight READ
(`init.signal.aborted === true`) and nothing throws past the pane; (d) DISCRIMINATING
mountedRef test — a comment-resolve WRITE held in flight past unmount does zero
post-unmount work (its `mountedRef`-guarded `.then` never fires the observable
`loadComments` refetch), and the write carried no abort signal (proving reads-only).
**Each test is mutation-verified RED**, not just green on the fix: (c) → RED when
the abort threading is removed; (d) → RED when the unmount cleanup that arms
`mountedRef` is removed (Argus round-1's exact mutation — previously left the suite
green); (d)'s reads-only assertion → RED when writes are also aborted.
**Verification depth (honest):** jsdom/happy-dom only, NO headless browser. React 19
silently no-ops setState-after-unmount in the `act()` harness (verified empirically:
0 throws / 0 console errors), so the exact fiber invariant is unreproducible here and
needs a real concurrent-browser commit — same limitation `pane-switch-no-crash.test.tsx`
documents. Because a bare setState-after-unmount is invisible in jsdom, test (d) pins
the guard through the one OBSERVABLE consequence (a suppressed downstream fetch), which
is what makes the `mountedRef` half mutation-detectable at all. chat-react suite: 540
pass / 0 fail.

## 2026-07-20 — black screen on project switch: per-pane error isolation

**Bug (live, the owner).** Clicking to a different project sometimes blanked the
ENTIRE screen. Console showed the #354 signature ("Tried to unmount a fiber that
is already unmounted", "An error occurred in one of your React components"),
plus a 503 on a `docs/file` fetch and a WebSocket that closed before opening.

**Why it was not a #354 regression.** #354's own fix — the memoized assistant-ui
adapter in `useNeutronChat.ts` — is intact and `snapshot-stability.test.tsx`
still passes. A DIFFERENT trigger was reaching the same failure.

**The structural defect, which is independent of the trigger.** The client had
exactly ONE error boundary: `ChatErrorBoundary` at `ChatApp.tsx:1538`, wrapping
the entire surface. `DocumentsTab` (`ProjectShell.tsx:221`) and `WorkBoardTab`
both perform their OWN network I/O on project switch and sat inside it with no
isolation. So a single failed doc fetch took down chat, the rail, the work board
and the docs pane together — the black screen.

**Fix.** New `PaneErrorBoundary` — deliberately NOT a copy of
`ChatErrorBoundary`, which owns a whole-surface "Back to General" recovery; this
one stays visually minor because the point is that everything around it still
works. `DocumentsTab` and `WorkBoardTab` are now wrapped. A pane failure renders
a small inline error with a retry and its siblings keep rendering. The console
line now names the pane, so a bug report says WHICH pane died instead of "a
React component".

**Test** (`__tests__/pane-error-isolation.test.tsx`): pins the ISOLATION, not any
one trigger, so it holds whichever fetch fails — a throwing pane degrades locally
while its siblings survive. **Verified RED** by neutering the boundary's
`getDerivedStateFromError` (reproducing the pre-fix world where the throw escapes
to the app-level boundary): the siblings vanish and the test fails. chat-react
suite: 357 pass / 0 fail.

**NOT fixed here — the trigger.** The 503 came from the docs surface, where
`comments_unavailable` / `versioning_unavailable` / `binary_unavailable` all
return 503 for "optional subsystem not wired". The chat-react docs client handles
ONLY `comments_unavailable` (7 refs); the other two have ZERO handling, and
`versionStore` is not wired in `open/composer.ts`. That is a real follow-up, but
the isolation above is what stops any such failure blanking the app.

## 2026-07-19 — claim redirect is one-shot per OWNER (durable), not per page load

**Bug (live, the owner's managed instance).** After claiming a personal URL the owner
was LOCKED OUT by an infinite loop: chat → the claim page ("Your personal URL is
already set") → "Open my workspace" → chat → claim, forever, on a healthy
instance.

**Root cause.** `on_session_open` (`open/wiring/app-ws.ts`) replays a one-shot
`onboarding_completed` frame on EVERY connect whose persisted phase is
`completed` when `NEUTRON_POST_ONBOARDING_CLAIM_URL` is set. The React client
navigates to the claim page on that frame, deduped by `claimRedirected` — a
field on the CONTROLLER INSTANCE, so it dedupes only within one page load. Every
reload built a fresh controller and re-armed it.

The pre-fix code justified the replay with a comment asserting the loop was
impossible because "once the owner claims they move to a host without the env".
That was FALSE: claiming renames `url_slug`, it does NOT change the tenant
process or its environment, so the SAME process — still carrying the claim URL —
serves the claimed host. Verified against the live process environment.

**Fix.** Gate the replay on `onboarding_handoff_emitted_at` (migration 0052 — a
column the schema has always carried and NOTHING ever wrote; built-but-not-wired,
the persona-gen class) and stamp it AFTER a successful send, so a throwing send
leaves it null and retries rather than burning the one shot. The signal is now
at-most-once for the OWNER across reloads, reconnects and restarts.

**Test** (`tests/integration/claim-redirect-once.open.test.ts`): boots a real
composer + production graph + app WebSocket and counts frames across TWO
successive connects, plus across a genuine process restart. **Verified to
reproduce the live loop pre-fix** (reconnect emits a second frame: expected 0,
received 1) and pass after. No unauthenticated HTTP probe could see this — the
status codes are identical either way; it only exists across a reload.

## 2026-07-18 — Favicon: the tab icon renders again (root cause = an invisible SVG, not a serving gap)

The owner reported NO favicon on his tenant chat tab (`https://<slug>.<managed-host>/chat`),
"used to work fine", hard refresh no help. Four defects, one of which is the actual cause.

**ROOT CAUSE — the SVG was serving fine and rendering invisibly.** `GET /favicon.svg`
returned 200 with correct bytes the whole time, and `landing/chat-react.html:7-9` carried
the `<link rel="icon">` tags; the shell is served verbatim (`landing/server.ts:699-713`
version-injects only `src="/chat-react.js"`), and the Managed auth gate is decision-only
(`gateway/http/compose.ts:130-172`), so the markup provably reaches the browser. The
regression is `233e0c1b` (2026-07-03, the "atom favicon" in this same log at §2026-07-03):
it replaced an icon that had an OPAQUE `#0b0e14` tile + a solid `r=6/64` core with a
TRANSPARENT, stroke-only atom in the fixed light-theme accent `#007aff` at `stroke-width
1.6` on a `0 0 24 24` viewBox. In a 16px tab slot that stroke is `1.6 × 16/24 ≈ 1.07`
device px of mid-blue composited onto Chrome's near-black dark tab strip — present, but
imperceptible. Hence "it used to work fine", and hence a hard refresh changing nothing:
the icon was always loading. `landing/favicon.svg` now restores an opaque rounded tile,
lifts the accent to `#4da3ff` (same rail-header blue family, bright enough over
`#0b0e14`), and moves to `0 0 32 32` @ `stroke-width 2.6` (≈1.3 device px) with a solid
`r=3.2` core. Verified by rasterising the shipped 16px entry over both a white and a
`#202124` backdrop.

**`/favicon.ico` now exists and is served.** There was no `.ico` anywhere in the repo, and
`/favicon.ico` was absent from `LANDING_ROUTE_MANIFEST` (`landing/routes.ts`), so on
Managed the gateway never routed the path to landing at all — the brand-asset allowlist
alone would not have been enough. Browsers request it at the origin unprompted and cache
the 404 negatively in a store a hard refresh does not clear. `landing/favicon.ico` is a
real 6-size (16→256) ICO generated from the SVG geometry by the committed
`scripts/gen-favicon-ico.py` (Pillow, dev-only — regenerate when the SVG changes); it is
declared FIRST in `chat-react.html` + `index.html` as the universal raster fallback, and
added to `site.webmanifest`.

**HEAD is answered on brand assets.** The handlers in `landing/server.ts` and
`landing/boot-impl.ts` were `req.method === 'GET'`-only, so `HEAD /favicon.svg` fell
through to the 404 tail for an asset that demonstrably exists on GET. Both now serve
`GET || HEAD` with identical headers and an empty HEAD body (RFC 9110).

**APEX — NOT FIXED HERE; it is an out-of-tree neutron-managed defect.** `GET
https://<managed-host>/favicon.svg` 404s with `{"error":"not found"}`, which is
`neutron-managed/src/index.ts:642` — the apex is served by the Managed control-plane
process (`<managed-host>` → `127.0.0.1:7780`, per
`neutron-managed/scripts/provision-hetzner.sh:451-473`), which has NO static-asset
allowlist at all. Open's `landing/boot-impl.ts` serves `signup.<managed-host>` (already
200 on `/favicon.svg`), not the apex, so no change in this repo can fix it. Filed as a
Managed follow-up: either give the control-plane router an asset allowlist, or repair the
shadowed `apex-marketing` `file_server` route. The `.ico` + HEAD additions to
`boot-impl.ts` do improve `signup.<managed-host>` and are kept.

Tests: `landing/__tests__/favicon-serving.test.ts` boots the REAL servers and asserts
responses, not route-table bookkeeping — `GET /favicon.ico` 200 + a valid ICO container
header (guards against "fixing" the 404 by aliasing SVG bytes at an `image/x-icon` path),
`HEAD` parity across all four brand assets, the served `/chat` body carrying the icon
links AND every declared href resolving 200, the SVG's 16px stroke/contrast budget, and
the apex-shaped `bootSignup` surface over GET+HEAD.
`landing/__tests__/routes-transition.test.ts` grows an append-only `ADDED_SINCE_C5` list
rather than rewriting its frozen pre-C5 snapshot, so the routing audit trail survives.

## 2026-07-19 — favicon: the SVG was invalid XML, so browsers rendered nothing

**Bug (live, on a hosted tenant, reproduced independently).** No favicon on
`<tenant-host>/chat`. Survived a hard refresh and a fresh
incognito tab, so it was not a cache artifact.

**Root cause.** `landing/favicon.svg` was NOT well-formed XML. Its explanatory
comment referenced the CSS custom property `--accent`, and an XML comment may
not contain a double-hyphen. `xmllint` verdict:

```
favicon.svg:4: parser error : Comment must not contain '--' (double-hyphen)
```

Browsers parse SVG strictly as XML, so the asset served **200 with the correct
`image/svg+xml` content-type and byte-correct contents** and then rendered as
NOTHING. Every signal short of actually rendering it looked healthy, which is
why route/allowlist/caching inspection kept coming back clean. Confirmed by
rendering the served bytes: pre-fix produces an XML parser-error page, post-fix
produces the atom mark.

**Fix.** Reworded the comment so it contains no `--`. Plus
`landing/__tests__/svg-assets-wellformed.test.ts`, which asserts every shipped
SVG has no `--` inside a comment — verified RED against the broken asset and
GREEN after. The class matters more than the instance: any future SVG with a
CSS-variable mention in a comment fails the same way, silently.

**Adjacent gaps found while diagnosing, NOT fixed here** (separate PR in flight):
`/favicon.ico` 404s and is absent from the route allowlist (browsers request it
by default and cache the 404 negatively), `HEAD /favicon.svg` 404s while GET
succeeds (the brand-asset handler is GET-only), and the apex host serves no
brand assets at all.

## 2026-07-18 — `stuck_agent` now means "a dispatched turn stopped progressing", not "a process is quiet"

**P1 user-visible defect.** The owner saw a permanent stream of false
`⚠️ Supervisor alert: stuck_agent` messages in chat on a healthy install, getting
worse with every topic he used.

**Root cause — a category error.** `watchdog_alerts` rows flagged
`cc-agent-dev\0owner\0general\0…` (pid 98137) and `…\0owner\0buddhism\0…`
(pid 22009), `tool_name` `cc-repl`; 26 alerts on a fixed half-hourly cadence, one
per resident REPL. **Both processes were alive and healthy** — `ps` showed real
`claude --session-id … --model claude-opus-4-8` PTYs at 6h29m and 4h55m uptime.
They are the warm per-topic chat REPL sessions, idle only because the owner was not
typing in those topics. The chain: `last_activity_at` is bumped ONLY from the PTY
`onData` handler (`spawn.ts:347`), so it answers "when did this process last EMIT
OUTPUT"; `ProcessRegistry.listStuck` was a pure age filter over that field; and
`StuckAgentDetector` read that age as "not progressing". For a request/response
REPL, silence is the normal resting state — a warm pooled session exists
precisely to sit idle between turns so the next message skips a cold start. The
detector was alerting on correct, healthy, by-design behaviour, forever.

(An earlier diagnosis blamed a long-running history import because the screenshot
timestamps fell in the import window. That was wrong; the import is irrelevant.)

**Fix — model outstanding work explicitly.**
- `ProcessRecord` gains `busy_since: number | null` + `busy_turn_id: string | null`.
- `LiveProcessHandle` gains `markTurnStarted(turnId)` / `markTurnSettled(turnId)`,
  following the existing identity-guarded `touch()` / `markCrashed()` /
  `unregister()` pattern — `markTurnStarted` guards on `pid`, `markTurnSettled` on
  `pid` **and** `turn_id`.
- `listStuck` filters on `busy_since !== null && busy_since < now - threshold`,
  measuring from TURN START. `busy_since === null` ⇒ never stuck.
- The pool driver (`pool.ts`) marks started when it assigns `session.activeTurn`
  and settles **in a `finally`**.

**Leak prevention (the crux — a latched marker would invert the bug into
permanent alerts).** Three independent covers: the dispatch-site `finally` runs on
every unwind (completion, return, throw, cancel, timeout); the turn-id guard stops
a superseded turn's late settle from clearing its successor; and process death
drops the record wholesale via the existing child-exit paths (`unregister` on
clean exit, `markCrashed` → crash queue on abnormal exit).

**Side benefit:** measuring from turn start catches a wedge the old filter
MISSED — a turn that keeps emitting output (spinner / retry loop) but never
completes had fresh `last_activity_at` throughout and never fired.

`crashed_agent` detection is untouched and fully intact. No feature flags, no dual
paths, threshold unchanged (15 min), no name/`tool_name` string special-casing.

Tests: regression reproducing the owner's exact two-REPL situation (fails on `main` —
emits both false alerts with his real pids); outstanding-turn-past-threshold still
alerts; settled turn clears; superseded-turn late settle cannot clear; throwing
turn leaves no permanently-busy record; dying process leaves none either while its
crash stays reportable; chattering-but-never-completing turn now alerts.

`runtime/adapters/claude-code/persistent/__tests__/stuck-agent-turn-wiring.test.ts`
covers the DISPATCH SITE itself — `pool.ts` is the only production writer of
`busy_since`, and every other test seeds the registry by hand, so deleting the
wiring left the suite green while the detector went permanently dead in
production (the "built but never wired" pattern). It drives a real turn through
`createPersistentReplSubstrate` against a gated fake PTY host and asserts busy
mid-turn / clear after settle / clear after cancel. Mutation-verified both ways:
removing `markTurnStarted` or `markTurnSettled` fails it.

Incident dedup is keyed `(name, pid, turn_id)`, not `(name, pid)`. A warm REPL
serves many turns under one pid; without the turn in the key, a second wedged
turn would be suppressed forever by the first turn's still-open key whenever the
first settles and the next wedges between detector ticks.

**Boundaries.** `stuck_agent` is a narrow backstop, not broad protection: the
per-turn driver watchdog abandons on 90 s of PTY silence and caps turns at 45
min, so the band `stuck_agent` uniquely covers is a continuously-emitting turn
that never settles for 15-45 min. And because `markTurnStarted` fires only after
`getOrSpawnSession` + `waitForReplIdle`, a turn wedged in the pre-turn
spawn/handshake phase is not stuck-detectable — it is bounded by
`waitForReplIdle`'s own `maxMs` cap instead.

## 2026-07-18 — Test isolation: the process-global `react` module mock is gone

**Defect (test infrastructure only; no product surface change).** Three `app/`
test files installed their hook-dispatcher stub with
`mock.module('react', ...)` — `app/__tests__/docs-read-hooks.test.ts`,
`app/__tests__/docs-mutations-race.test.ts`,
`app/__tests__/diagnostics-pane-render.test.ts`. In bun that registration is
**global to the test process** and is NOT undone by `mock.restore()` (module
mocks are exempt). Once any one of those files ran, every later test in the
same process that rendered through `react-dom` received the stub instead of
real React. Signature: `TypeError: undefined is not an object (evaluating
'ReactSharedInternals.S')` thrown inside
`node_modules/react-dom/cjs/react-dom-client.development.js`. Measured blast
radius at `main` b1007876: ~92 failures. Minimal repro — the SAME file passes
or fails purely on ORDER:

```
bun test landing/chat-react/__tests__/work-board-tab.test.tsx                       → 17 pass / 0 fail
bun test app/__tests__/docs-read-hooks.test.ts <same file>                          → 17 FAIL
```

That is worse than 92 red lines: a real regression anywhere in the polluted
tail was indistinguishable from the noise.

**Fix — dependency injection, not a bigger mock.** New
`app/lib/hook-runtime.ts` exports `HookRuntime` (the six dispatcher hooks) and
`reactHooks`, the real React implementation. Every unit whose test needs a
substituted dispatcher now takes it explicitly, defaulting to real React:

- `useProjectScopedAsync(projectId, client, hooks = reactHooks)` — the shared
  race-guard primitive; it threads the runtime it is given.
- `useDocFile`, `useDocTree`, `useDocHistory`, `useDeepLinkAnchor`,
  `useDocMutations` — optional trailing `hooks: HookRuntime = reactHooks`,
  forwarded to `useProjectScopedAsync` so one injected runtime covers the
  whole hook subtree.
- `DiagnosticsPane` — optional `hooks?: HookRuntime` prop (its test invokes the
  component directly, so a prop is the seam that reaches it).

Production call sites are unchanged and pass nothing. The substitution is now
scoped to the individual call, so **no execution order can affect any test**.
The read-hooks and mutations suites also drop their `await import(...)` dance
for plain static imports — there is no longer a mock that must be registered
before the module graph links.

**What did NOT change:** no test was skipped, weakened or deleted. Every stub,
harness and assertion is byte-for-byte the same behaviour; the suites still
prove the same `isLatest`-before-`setState` race guards, argument fidelity and
component wiring. The one typing addition is a `LooseHook` alias in the two
driver tests, which reproduces EXACTLY the typing those drivers had while the
hooks were `await import`ed into an `any` (the fixtures are deliberately
partial); `tsc -p app/tsconfig.json` and the root `tsc` are both clean.

**Deliberately still module-mocked:** `mock.module('react-native', ...)` in
`diagnostics-pane-render.test.ts` and `docs-panes-render.test.ts`. react-native
is Flow-typed and cannot be parsed by bun at all, so there is no real module
for any test to load — the stub cannot displace a working implementation the
way the react stub did, and nothing outside `app/` imports it.

**Second, independent order-dependency fixed in the same pass.**
`gateway/__tests__/doc-link-production-composer.test.ts` interpolated the
EAGER `WEB_APP_BASE` constant (frozen at that file's module load) into its
expected URL, while the rewriter under test recomputes `webAppBase()` per call
by design (`wire-types/doc-links.ts:127-130`). Two sibling files set
`NEUTRON_WEB_APP_BASE` at THEIR module load and never restore it
(`runtime/__tests__/doc-links.test.ts:32`,
`runtime/__tests__/doc-links-parity.test.ts:21`), so expected and produced
disagreed purely on ORDER — the test passed alone and failed in the full run.
The assertion now resolves the base the same way the production code does, so
it pins the identical rewrite shape under ANY ambient env (verified passing
both with the var unset and with `NEUTRON_WEB_APP_BASE=https://polluted.example`).
The env leak in those two runtime files is left as-is and noted: nothing now
depends on it, and restoring it mid-run would itself race concurrent files.

**Also updated:** `app/__tests__/docs-hooks-invariants.test.ts` — two
source-text guardrails match the hook signatures by regex, so they were
retargeted at the new signatures. They still pin exactly what they pinned:
`useProjectScopedAsync`'s SCOPE parameters are still asserted to be exactly
`(projectId: string, client: unknown)` with the injected runtime explicitly
accounted for, and `useDocMutations` still acquires exactly ONE gate.

**Suite result** (single `bun test` at the repo root, clean tree):
before 10699 pass / 9 skip / 93 fail / 2 errors (exit 1) → after 10809 pass /
9 skip / 0 fail / 0 errors (exit 0). The skip count is IDENTICAL — nothing was
skipped to reach the number. The total ran RISES 10801 → 10818 across the same
963 files, because the two "errors" were whole-file evaluation failures
(`landing/chat-react/__tests__/html-doc.test.tsx` could not even evaluate
`require('react-dom/client')` under the stub), so those files' tests never ran
at all before.

[`app/lib/hook-runtime.ts`, `app/features/docs/use-project-scoped-async.ts`,
`app/features/docs/use-doc-file.ts`, `app/features/docs/use-doc-tree.ts`,
`app/features/docs/use-doc-history.ts`,
`app/features/docs/use-deep-link-anchor.ts`,
`app/features/docs/use-doc-mutations.ts`,
`app/features/admin/DiagnosticsPane.tsx`,
`app/__tests__/docs-read-hooks.test.ts`,
`app/__tests__/docs-mutations-race.test.ts`,
`app/__tests__/diagnostics-pane-render.test.ts`,
`app/__tests__/docs-hooks-invariants.test.ts`,
`gateway/__tests__/doc-link-production-composer.test.ts`]

## 2026-07-18 — Onboarding finalize: a progress signal, an orienting closing, concurrent openings

**Bug (live, the owner's install).** `onboarding/openings/finalize.ts` awaited
`emitProjectOpenings(...)` — one LLM compose per project — for EVERY materialized
project before emitting the closing. With 9 projects the openings landed one at a
time over several minutes with zero explanation, and the one message that tells the
owner what to do next arrived dead last. Projects silently appeared in the rail with
no orientation. The owner: "its unclear what im supposed to do next."

**Fix (messaging + ordering only; the completion gate is untouched).**
1. **STARTING message** — `ONBOARDING_STARTING_MESSAGE` ("Got it, setting up your
   projects now. One moment while I put everything together.") emitted into the
   owner's General topic through the SAME `deps.emitChatMessage` seam, BEFORE
   persona compose / materialization / the opening composes. Gated on the same
   `emitChatMessage !== undefined` condition as the closing AND on
   `resolveProjects(...).length > 0` (the exact list `materializeProjects` iterates)
   so it never fires when there is nothing to materialize. Its own stable
   `dedupe_key: 'onboarding_starting'` — a joined finalize shares the in-flight
   promise, a re-finalize of a completed row returns at the gate, and a
   deferred-CAS retry collapses on the composer's dedupe row.
2. **Closing copy** now names BOTH affordances: click into each project in the left
   rail, and ask general questions right here in the General chat.
   `ONBOARDING_CLOSING_MESSAGE_NO_PROJECTS` is unchanged (no rail claim, no rail).
3. **Openings run concurrently** through a bounded worker pool
   (`OPENING_COMPOSE_CONCURRENCY = 3`). The openings are mutually independent — each
   targets its own project topic and reads only its own on-disk docs — and the
   per-project try/catch (error isolation) is unchanged. Bounded rather than a bare
   `Promise.all` so a large import cannot fan N simultaneous substrate sessions.

**Also fixed: `persona_files_committed` was never persisted.** Verified live: the
persona files existed on disk (`persona/SOUL.md`, `USER.md`, `priority-map.md`)
while the column read 0. Root cause: NOTHING on the Path-1 finalize path ever wrote
it — `commitPersona` writes the files + invalidates the loader but persists nothing,
and the terminal CAS `UPDATE` set only `phase`/`completed_at`/`wow_fired`
(`onboarding/interview/sqlite-state-store.ts`), so the column sat at its schema
DEFAULT 0 (`migrations/0043_onboarding_state_wow_pushed_at.sql:53`). `commitPersona`
now returns whether it succeeded and the flag rides the SAME atomic terminal write
via a new optional `persona_files_committed` input on
`completeIfPhaseStateMatches` — monotonic (`MAX(persona_files_committed, ?)`), so a
later finalize whose persona compose failed can never clear a committed persona.

**Tests** — `gateway/wiring/__tests__/finalize-progress-messaging.test.ts` (6 tests,
real ProjectDb + real SqliteOnboardingStateStore + the real create-project seams;
asserts the emitted message stream): starting-first-and-once, closing-last naming
both affordances, joined/re-entered finalize never duplicating the starting
message, the zero-project path emitting no starting message and no rail claim,
`persona_files_committed` true after a successful finalize, and false when persona
compose failed.

## 2026-07-18 — Onboarding: the step guard becomes AUDIT-DRIVEN (fixes a live finalize deadlock)

**Bug (live, P0, the owner's fresh install).** Onboarding hung forever after the
personality step and could never finalize. The real row in
`~/neutron/data/project.db`: `phase='work_interview_gap_fill'`,
`completed_at=NULL`, `persona_files_committed=0`, with a `phase_state` holding
`user_first_name=Owner`, a settled import (`import_job_id`), 6 `primary_projects`
and `agent_personality='Yoda'` — but NO `non_work_interests` (his import analysed
to `topics:[]`, so nothing backfilled it).

`auditRequiredFields` correctly refused to finalize on `non_work_interests`
(`post-turn-extractor.ts` finalize gate). But `buildOnboardingStepGuardFragment`
(`onboarding/interview/onboarding-preamble.ts`) inspected only TWO hardcoded
fields — `import_decision` and `agent_personality` — and with both settled it
returned `null`. The live agent therefore received no forcing instruction for the
one field still blocking it, concluded onboarding was over, and went silent.
**The audit required a field the guard could never ask for.**

**Root defect (the general one, not the symptom).** The guard's coverage set was a
hardcoded SUBSET of the audit's required set. Any required field outside that
subset is an unaskable blocker, so adding required field #6 later would have
silently reintroduced the same deadlock.

**Fix — derive the guard from the audit.** `buildOnboardingStepGuardFragment` now
walks `auditRequiredFields(...).missing` (in the audit's own priority order) and
renders one copy block per missing field from `STEP_GUARD_COPY`, typed
`Record<RequiredField, StepGuardCopy>`. It returns `null` exactly when finalize
would fire — the guard and the gate can no longer disagree. Two presentation
categories:
- **`'buttons'`** (`import_decision`, `agent_personality`) — keep the existing
  `[[OPTIONS]]` hard-requirement and their exact locked option lists/wording, so
  the 2026-06-30 and 2026-07-18 fixes are not regressed.
- **`'free_text'`** (`user_first_name`, `primary_projects`, `non_work_interests`)
  — force the ASK in plain conversational form and EXPLICITLY forbid an
  `[[OPTIONS]]` block. The interests copy states outright that onboarding CANNOT
  finish until it is answered.

Conditionality is respected: `import_decision` renders only when `import_offered`
is true, so a box with no import substrate is never asked a question it cannot
honor.

**Deferred (not dropped) during a history import.** Making the guard audit-driven
newly put `primary_projects` / `non_work_interests` in its scope — the two
`PROJECT_DISCOVERY_FIELDS` the extractor deliberately refuses to persist while an
import is uploading/analyzing, and which `buildImportInFlightSteerFragment`
(joined into the SAME prompt at `open/composer.ts`) explicitly forbids asking
about. Forcing them mid-import would have handed the model contradictory
instructions and solicited answers that are then silently discarded (caught by
cross-model review). `StepGuardCopy` therefore carries
`deferred_during_import`, the guard takes an `import_in_flight` option, and the
composer now resolves `importInFlight` BEFORE building the guard so it can be
threaded in. Import-INDEPENDENT steps (`user_first_name`, `agent_personality`)
stay forced, so the interview keeps progressing during the upload; the deferred
steps resume the moment the import lands. Deferred, never dropped — the field is
still never unaskable, only asked at the right time.

**Anti-recurrence is structural, not a convention.** The `Record<RequiredField,
StepGuardCopy>` makes a new union member without guard copy a COMPILE-TIME error
— verified by temporarily adding a 6th field, which produced
`TS2741: Property 'future_field_six' is missing ... but required in type
'Record<RequiredField, StepGuardCopy>'` at `onboarding-preamble.ts`. A runtime
exhaustiveness test iterating the newly exported
`REQUIRED_FIELDS_IN_PRIORITY_ORDER` (`required-fields-audit.ts`) closes the loop
for copy that exists but never renders.

**Docs corrected.** The docblocks in `required-fields-audit.ts` and
`onboarding-preamble.ts` claimed finalize "triggers once personality is settled".
That was false and it masked this deadlock: personality is priority 5, but
`non_work_interests` is audited BEFORE it at priority 4, so a run can have
personality settled and still be blocked.

**Tests.** `onboarding/interview/__tests__/onboarding-preamble.test.ts` (33 pass)
gains the owner-state regression, the per-field exhaustiveness sweep, the
button-list non-regression and the conditionality/free-text-shape cases.
`tests/integration/onboarding-interests-deadlock.open.test.ts` is new and boots
the whole stack (real composer, real `onboardingContext` closure, real post-turn
extractor, real finalize gate + finalizer; the ONLY fake is the substrate, i.e.
the model): from the owner's exact stuck state the guard forces the interests ask, the
owner — modelled faithfully, answering only what they were actually asked —
replies in free text, and onboarding REACHES `phase='completed'` with
`completed_at` stamped. Pre-fix both the regression and the E2E fail on `main`
(the E2E times out waiting for an ask that never comes — the deadlock reproduced
literally).

**Full suite:** `main` baseline 10665 pass / 9 skip / 104 fail / 2 errors;
this change 10690 pass / 9 skip / 92 fail / 2 errors (+25 pass, −12 fail, +13
tests). Not a clean suite: 56 of the 92 are the known-flaky local `happy-dom`
React-client tests, which is what the −12 swing reflects — no React code was
touched. No failure is attributable to this change (the branch failure list
contains none of the added or touched onboarding suites).

## 2026-07-18 — Onboarding: the welcome opener is guarded DURABLY, not per-process

**Bug (live, fresh install, screenshot-confirmed).** The onboarding opener
("…what should I call you?") was emitted TWICE into the owner's General topic.

**Root cause.** `on_session_open` (`open/wiring/app-ws.ts`) gated the auto-start
welcome seed on `seededOnboardingTopics`, an in-memory per-PROCESS `Set`. The
opener it guards is DURABLE: the live runner persists the composed reply as a
`button_prompts` row (`gateway/wiring/build-live-agent-turn.ts:1096`) BEFORE it
sends it (:1126). So the guard's lifetime was strictly shorter than the thing it
guarded — any new process (restart / redeploy / crash / the service bounce a
fresh install performs) began with an empty `Set`, re-seeded on top of the
persisted opener, and the client hydrated BOTH.

Two candidate causes were REFUTED by reading the code rather than assumed: there
is only ONE seed call site (`open/wiring/app-ws.ts:978`; the line-356 reference
was the `Set` declaration, not a second emitter), and the `outcome === 'failed'`
self-heal `delete(...)` could not double-emit — for a `seed_turn` both `'failed'`
returns (:1055, :1069) happen strictly BEFORE the reply is composed, persisted,
or sent, so a failed seed leaves no row and delivers no message. Concurrent
same-process connects were already safe (the `Set.add` was synchronous).

**Fix — replace the weak guard with the durable one already used next door.**
`hasBeenGreeted` reads `landing.buttonStore.latestTurnByTopic` for the General
topic — the SAME "does this topic already have a turn?" check
`ensureProjectOpeningOnEntry` uses for per-project openings. Because the opener
persists before it sends and a failed seed persists nothing, that one check is
simultaneously the de-dupe AND the self-heal, so the compensating
`seededOnboardingTopics.delete(...)` calls are DELETED with no replacement. The
in-memory structure is demoted to `seedInFlightByTopic`, a pure single-flight
latch: the durable read is itself an `await`, so the promise is registered
synchronously (nothing awaited between the `get` miss and the `set`) and a second
racing connect awaits the first instead of dispatching its own turn. Fail-CLOSED
on a store error — a missing greeting is recoverable on the next connect, a
duplicate one is this bug. No flag, no dual path.

**Test.** `tests/integration/onboarding-welcome-seed-once.open.test.ts` boots a
real composer + production graph + app WebSocket (only the substrate is faked)
and counts EMITTED openers — durable rows, live frames, and dispatched turns —
across a single connect, two rapid concurrent connects, and a reconnect after a
genuine process teardown against the same persisted store. Verified to fail on
the pre-fix code (2 openers after restart) and pass on the fix (1). A test that
asserted `Set` bookkeeping would have passed against the bug.

[`open/wiring/app-ws.ts`, `tests/integration/onboarding-welcome-seed-once.open.test.ts`,
`docs/SYSTEM-OVERVIEW.md`]

## 2026-07-18 — Onboarding: the history-import decision becomes a deterministic step

**Bug (live, fresh install).** The assistant asked "what should I call you?", the
owner replied only "Owner", and the assistant answered "Got it, we'll skip the
import for now..." and moved on. The owner was never offered the import and never
chose to skip it. The DB agreed: `onboarding_state.phase='work_interview_gap_fill'`,
`phase_state_json={"user_first_name":"Owner","signup_via":"web"}` — no import
decision captured anywhere. The offer existed ONLY as prose in
`onboarding/interview/onboarding-preamble.ts` (`buildOnboardingPreamble`), with
ZERO capture, so whether the step happened at all was LLM whim and the model
routinely narrated a decision the owner never made.

**Fix — extend the EXISTING per-turn guard; no new gate.** Onboarding stays
LLM-driven plus a deterministic per-turn guard (SPEC Decisions Log 2026-07-18
LOCKED); the phase machine is NOT the gate and is untouched here. This reuses the
mechanism built 2026-06-30 for the IDENTICAL prose-only failure on the personality
step ("a fresh-install run showed ZERO option buttons") — same call site, same code
path, one more audited step.

- `required-fields-audit.ts` — `import_decision` joins the Sam-locked required
  fields, slotted directly after `user_first_name` (where the preamble already
  places the ask: right after the name, before the work questions). It is
  CONDITIONAL on a new `options.import_offered`, which DEFAULTS TO FALSE, so every
  pre-existing caller (including the legacy engine) keeps its exact 4-field
  partition and a box with no import substrate can still finalize. An import that
  actually ran (`import_job_id` / `import_result` on `phase_state`) settles the
  field on its own — uploading an export IS the decision, so a mid-import owner is
  never re-asked.
- `onboarding-preamble.ts` — `buildOnboardingStepGuardFragment` is generalized
  past its single `agent_personality` check: while `import_decision` is missing it
  HARD-REQUIRES the ask as an `[[OPTIONS]]` block over the locked
  `IMPORT_DECISION_OPTIONS` menu (ChatGPT / Claude / neither), and explicitly
  forbids saying it is skipping the import, assuming no export exists, or reading
  an answer to a different question as a decision. The personality section is
  byte-identical (pinned by a test that diffs the two renderings).
- `button-backed-answer.ts` — the SAME turn-start capture (awaited before the
  guard reads `phase_state`, `gateway/wiring/build-live-agent-turn.ts`) now also
  settles `import_decision`, normalizing taps AND free text into
  `chatgpt|claude|neither`. Free text is first-class: "I have claude history",
  "skip", "I don't have a Claude export" all land. Ambiguity (e.g. "I have both")
  captures NOTHING so the guard simply re-asks — a false `neither` is precisely
  the bug — while `"no, my claude one"` stays `claude` rather than being swallowed
  by the decline matcher. The import and personality anchors are disjoint option
  menus, so the two steps can never cross-capture.
- `extracted-fields.ts` + `post-turn-extractor.ts` — `import_decision` gets a home
  on the existing background extractor as the fallback for an answer VOLUNTEERED
  with no button context (never inferred from silence). The extractor's finalize
  gate takes `import_offered` too, so it cannot finalize out from under a step the
  live guard is still forcing.
- `open/composer.ts` — threads `import_offered` (`importSubstrate !== null`, the
  same expression that already decides whether the offer renders and whether the
  upload affordance exists) into the step guard, BOTH finalize gates, and the
  extractor, so the guard and the gates can never disagree about scope.

No feature flags, no dual code paths, no second gate. The orphaned phase-machine
code (`engine.advance` / `ai_substrate_offered` / `LEGAL_TRANSITIONS`) is left
alone — its removal is a separate step gated on this being proven live.

**Tests exercise the LIVE path.** This bug class has recurred because tests mocked
past the real seam, so `tests/integration/onboarding-import-step-guard.open.test.ts`
boots the real composer + production graph + app WebSocket + ButtonStore and fakes
ONLY the substrate (the model). The import question's `[[OPTIONS]]` block travels
the real persistence path (stripped from `body`, durable in `options_json`) before
returning as the `prior_agent_options` the capture keys on. Covered: a name-only
turn carries the guard's import step and leaves `import_decision` unset; a tapped
option and a free-text answer each persist durably and stop the re-ask; a free-text
"skip" records `neither`; the personality step is unchanged on the same path. Unit
coverage added for the audit's conditional field, the guard fragment, and the
capture classifier.

## 2026-07-17 — Trident Ralph re-fire: multi-task builds build every task before merge (#362)

**Bug.** Trident v2 Ralph mode built only the FIRST task then merged. The inner
workflow (`trident/inner-workflow.mjs`) planned once, built `plan.topTask`, and
`log()`-ged `plan.remainingTasks` but never consumed it — it fell straight through
to review→merge. The outer harvest (`orchestrator.applyResult`) mapped inner
APPROVE → done+merge with no remaining-tasks check. The real plan→task→repeat
cycle existed only as DEAD code in `state-machine.ts` (`computeTransition`), which
the exec-model orchestrator no longer drives. Net effect: a multi-task,
spec-driven (`IMPLEMENTATION_PLAN.md`) Ralph build silently shipped INCOMPLETE
after task 1.

**Fix — re-fire, one fresh context per task (no flags, real behavior).**
- `inner-workflow.mjs`: in Ralph mode capture `plan.remainingTasks`. When `> 0`,
  build the ONE task, then return a TYPED intermediate result
  (`checkpoint='ralph-task-built'`, `remainingTasks>0`, verdict non-APPROVE)
  WITHOUT reviewing. Only the FINAL task (`remaining==0`) — and every non-Ralph
  run — runs the review→fix→merge path, so the WHOLE cumulative diff is reviewed
  exactly once before merge. `remainingTasks` is threaded through the terminal +
  failure results too (both `0`/no-re-fire).
- `inner-loop.ts`: `InnerResult` + `parseInnerResult` decode `remaining_tasks`
  (absent/garbled → null = no re-fire; legacy rows unchanged).
- `orchestrator.ts`: `applyResult` re-fires a FRESH inner iteration when
  `remaining_tasks>0` (`refireNextRalphTask`) — reset the sub-agent slot, preserve
  branch/PR + the `'ralph-task-built'` resume checkpoint (so the next fire
  re-enters the branch and re-plans the next task; only `'argus-approved'`
  short-circuits), bump `ralph_round`, cap at `max_ralph_rounds` (fail loudly, no
  infinite loop) — instead of merging. Each re-fire is a brand-new `Workflow`
  launch harvested by the outer loop (fresh context, no accumulation), reusing the
  existing durable `code_trident_runs` row + crash-recovery model.
- The re-fire reset is persisted OUT-OF-BAND in ONE atomic UPDATE via a new
  `persist_refire_reset` seam (`save`/`saveIfActive` deliberately never write the
  workflow-owned `inner_result` column). The single write bundles the
  `inner_result=null` clear WITH the sub-agent-slot release + the `ralph_round`
  bump, so a crash can never strand the row in the (inner_result=null, stale
  terminal sub-agent) state `step()` would reap as "terminal-but-garbled" — the
  crash-recovery guarantee holds (Codex cross-model review [P2]). The patch never
  writes `phase`, so it can't resurrect a concurrently force-terminated run;
  `saveIfActive` still owns the race-guarded phase commit. Wired from the store in
  `gateway/composition/build-core-modules.ts` and the test harness.

**Dead-code decision.** The `state-machine.ts` Ralph cycle (`computeTransition`
`ralph-plan`/`ralph-task` branches) is KEPT, not deleted: it remains the
`stubAdvanceDeps` restart-safe no-op fallback and the executable cross-repo parity
anchor for the legacy harness's `/trident` skill loop (`legacy-fixes.test.ts`), and offers
one-commit revertibility. The re-fire is implemented at the exec-model layer
(orchestrator), which is where the live loop actually runs; the now-stale module
comments in `orchestrator.ts` + `state-machine.ts` were corrected to say so, so no
reader mistakes the state machine for the live driver. (Flagged for the trident
architecture review — a human + Argus may prefer deletion.)

**Tests (real, multi-task).**
- `trident/inner-workflow-ralph-refire.test.ts` drives the REAL `.mjs` body:
  `remaining>0` builds one task + SKIPS review + emits the re-fire result;
  `remaining==0` reviews + approves.
- `trident/orchestrator.test.ts` drives store+tick+orchestrator+migrations
  end-to-end: a 3-task plan re-fires TWICE (fresh context each, resume-folded onto
  one branch/PR), merges exactly ONCE at `remaining==0`, bounds a non-converging
  planner at `max_ralph_rounds`, and never re-harvests a cleared row.
- Full `trident/` suite green (451 pass at commit time; +E2E).

## 2026-07-04 — K9: router-thinking-budget deleted (refactor unit K9)

**Decision: DELETE** `runtime/adapters/claude-code/router-thinking-budget.ts` (+ its
unit test) and correct the misleading comments in
`gateway/wiring/build-llm-call-substrate.ts` that claimed the router-hang
protection was live.

**Incident recap.** The 2026-06-05 router-hang root cause
(`docs/plans/router-call-hangs-rootcause-brief.md`, per the module's own header): the
onboarding classifier's `claude -p` spawn ran with Claude Code's default extended-thinking
budget enabled, so on ambiguous prompts Haiku 4.5 generated a multi-thousand-token
thinking block (cold ~40s / warm 20-36s) before the one-line JSON answer — read as a
"hang." The intended fix was to spawn the router substrate with `MAX_THINKING_TOKENS=0`.

**Why delete, not re-wire.** The module was orphaned — zero production importers (only
its own test imported it; the `runtime/adapters/claude-code/index.ts` barrel does not
re-export it). The wiring its header describes ("the router-dedicated
`buildLlmCallSubstrate` threads this as `extra_env` via `gateway/index.ts`") does NOT
exist: no non-test call site sets `extra_env` anywhere in the repo, so the helpers
(`resolveRouterThinkingBudget` / `routerThinkingEnvOverlay`) were never called on any
live path. The protection was therefore already absent, and the comments were the worst
state — asserting an active hang guard that wasn't. Deletion is the no-behavior-change
option that makes code and comments agree. Re-wiring was rejected because the only
consumer it would protect — the onboarding `llm-router` — is itself already dead code on
every live path and is being removed in the same refactor wave (unit K11:
`llm-router.ts` fires only inside dead `engine.advance`).

**What changed.** Removed the module + test. The `extra_env` field on
`BuildLlmCallSubstrateInput` is KEPT (it is the substrate's generic per-spawn env-overlay
seam, covered by its own substrate unit test); its JSDoc + the inline-apply comment were
rewritten to describe it as a generic knob with `MAX_THINKING_TOKENS=0` as an
illustrative example, noting no production caller sets it today. (This entry was
originally appended to the root `AS-BUILT.md` and carried forward here by K6, the
changelog consolidation.)

## 2026-07-03 — Trident build reliability: worktree isolation + self-healing merge + interpreted failures (#351/#352, no flags)

**Why.** The owner re-ran two same-project builds on `tabs` (dagflow + kvwal) on
2026-07-03; kvwal FAILED at merge with `git checkout branch failed: error: you need
to resolve your current index first`. Root cause: ALL builds for a project shared
ONE checkout `Projects/<proj>/code` with `code_trident_runs.worktree` empty for every
run. A pre-#342 dagcore failure had hard-failed a rebase conflict WITHOUT
`git merge --abort`, leaving `.git/MERGE_HEAD` (timestamped 17:01) in that shared
checkout — so every LATER build's `mergeLocal` tripped over the poisoned index. The
#342 merge logic is correct, but its tests MOCK git (`RunHostCommand` stub), so the
shared-working-tree hazard was never exercised. owner-locked: "Builds need isolated
worktrees" + "when a build fails … interpret it, try to solve it, else describe in
simple terms what happened and what input is needed." NO feature flags; one code
path; leak-gate SILENT. Backend trident only (no chat-react UI touched).

**What shipped.**

- **FIX 1 (#351, P1) — real per-run git-worktree isolation.** `trident/merge.ts`
  `mergeLocal` now provisions a DEDICATED worktree per run
  (`<repo>/.trident-worktrees/<slug>-<id8>`, `runWorktreePath` — deterministic +
  distinct per run, so N concurrent same-project builds never share one) via
  `git worktree add --detach --force … <base>` (detached → no collision with base
  checked out in the shared repo). The whole rebase-onto-latest-base + #342 Forge
  conflict-resolution runs INSIDE that worktree, so a rebase that hard-fails can only
  dirty the throwaway worktree — never the shared checkout. The LAND onto base
  (`git checkout <base>` + `git merge --no-ff <branch>`, still serialized per
  `repo_path` by `withLocalMergeLock`) is the ONLY op touching the shared checkout and
  is conflict-free by construction (the branch already contains base). The worktree
  is torn down on EVERY terminal path (success OR a thrown escalation) via a
  `finally`; a lingering build worktree still holding the branch is freed first
  (`freeBranchFromWorktrees`, parses `git worktree list --porcelain`). The
  orchestrator (`applyResult`) records the path onto `code_trident_runs.worktree`
  (was ALWAYS empty) before the merge, so it's durable for cleanup even on failure.

- **FIX 2 (#351b, P1) — defensive stale-state auto-recovery.** Before touching the
  base repo, `mergeLocal` runs `recoverStaleGitState`: it aborts any lingering
  `MERGE_HEAD` / `rebase-merge` / `rebase-apply` (`git merge --abort` /
  `git rebase --abort`, whose exit code is an accurate "was-dirty" probe) and
  `git reset --hard`s to a clean base. One poisoned checkout can no longer strand
  every future build in that repo — the merge path is self-healing. (Deliberately no
  `git clean` — the shared checkout may hold a real project's untracked files.)

- **FIX 3 (#352, P2) — failed builds are INTERPRETED, never a raw error paste.**
  `trident/delivery.ts` `interpretFailure` (a deterministic classifier — reliable +
  unit-testable, no LLM in the hot path) maps a terminal `failure_reason` to a
  plain-language summary + the SPECIFIC input needed, applied to ALL failure classes
  (not just merge conflicts): `merge-conflict` surfaces the #342 question verbatim;
  `merge-mechanics` DISCARDS raw git stderr ("a git step failed while landing the
  branch"); `review-unresolved`, `hang`, `stale-state`, `infra`, `underspecified`
  each get a human sentence + a retry/review action. The recoverable classes are
  already auto-recovered upstream (stale state → FIX 2; content conflict → the #342
  Forge resolver → no failure message at all), so a run reaching the announce is
  genuinely unrecoverable. `composeTerminalDelivery`'s `failed` branch now renders
  `❌ <slug> — <summary>\n<task>\n<input needed>`.

- **Verified with REAL (non-mocked) git.** `trident/merge-realgit.test.ts` drives
  `mergeLocal` against actual temp repos via `spawnCapture` (the existing
  `merge.test.ts` mocks git — exactly why the bug shipped): (1) 3 concurrent
  same-project builds each in their OWN worktree all land + base repo CLEAN (no
  `MERGE_HEAD`, no stray worktrees, `git worktree list` == 1); (2) a `MERGE_HEAD`-
  poisoned base repo auto-heals + the build lands (never "resolve your current index
  first"); (3) an unrecoverable rebase conflict escalates a PLAIN question (no raw
  git stderr) AND leaves the shared checkout untouched (main unchanged, clean) so a
  LATER build still succeeds. Plus deterministic unit coverage for every
  `interpretFailure` class (no raw-stderr leak invariant). `tsc` clean (root +
  trident); trident (423) + work-board (73) + gateway/open (154) suites green.

- **Codex cross-model review [P1] fixed.** After `recoverStaleGitState` aborts a
  stale rebase/merge OF the feature branch, the shared checkout could be left still
  ON that branch (a legacy poison, or an `--abort` returning HEAD to it), so the
  merge worktree's `git checkout <branch>` would fail "already checked out at
  <shared repo>". `mergeLocal` now `git checkout <base>`s the shared checkout back to
  base right after recovery (before provisioning), and a real-git regression test
  reproduces the exact poison (shared checkout ON the branch mid-rebase → recovers +
  lands).

**Spec-conformance (5-line diff).**
- SPEC (owner-locked 2026-07-03): concurrent same-project builds run in ISOLATED git
  worktrees; the merge path defensively aborts stale merge/rebase state before
  proceeding; a failed build is interpreted + auto-recovered if possible, else
  explained in plain language with the specific input needed (never raw error paste).
- CURRENT (before): all builds shared ONE checkout `Projects/<proj>/code`
  (`worktree` empty); no stale-state cleanup so one old failure poisoned the repo
  (kvwal hit this); failures pasted raw git stderr to chat.
- GAP: all three.
- THIS PR: per-run worktree isolation (`mergeLocal` + `runWorktreePath`, recorded on
  the row) + stale-state auto-abort (`recoverStaleGitState`) + failure
  interpretation/plain-language (`interpretFailure`).
- OUT OF SCOPE (unchanged): the chat-react UI (batch-3/batch-4); the #342 merge LOGIC
  itself (kept — rebase-onto-base + Forge resolver + per-repo serialization).

## 2026-07-03 — UX batch-3: no-flicker project switch · work add-box above Done · clean amber attention dot · bottom-right timestamps (#343/#344/#345/#346, no flags)

**Why.** Four chat/work-board refinements from the owner's live review 2026-07-03:
(1) clicking between projects "rebuilt the whole screen with lots of flickering";
(2) the work-board "Add something to do" box sat BELOW the Done disclosure instead
of at the bottom of the active items; (3) the attention-dot color read as an ugly
brown; (4) the per-message timestamp flipped side with the bubble (right on the
blue user bubble, left on the grey agent bubble). NO feature flags; one code path;
both light + dark preserved; leak-gate SILENT. Stayed clear of trident/build-
lifecycle (#190, already merged).

**What shipped.**

- **#343 — project switch keeps the chat surface MOUNTED (no teardown flicker).**
  `ChatApp.tsx` used to wrap the sole assistant-ui runtime host in `key={convId}`,
  so every project switch UNMOUNTED + REMOUNTED the entire thread + composer,
  flashed the empty state, and lost scroll/draft. Now each visited conversation
  gets its own persistent `MountedConversation` (`.car-conv`) with its own runtime;
  only the active one is un-`hidden`. A per-`convId` frozen-vm cache (`Map`, LRU-
  bounded by `MAX_MOUNTED_CONVERSATIONS`) feeds each surface ONLY its own
  conversation's messages — live when active, its last snapshot when not — so
  switching back to an open project is INSTANT (no refetch flash) and scroll +
  composer draft survive per project. Crucially this PRESERVES the SEV1 switch-race
  fix structurally: no runtime is ever emptied in place by a foreign switch (each
  surface only ever sees its own messages), so the `useClientLookup` index-out-of-
  bounds can't reoccur. The active surface, during its own re-hydration, keeps
  showing its cached snapshot until the live transcript lands (no empty-state flash
  and no shrink). Codex P2 (cross-model review): that snapshot fallback is bounded
  by a grace window (`HYDRATION_GRACE_MS`) — if the transcript is AUTHORITATIVELY
  empty (cleared/expired), after the window the stale snapshot is dropped and the
  surface REMOUNTS onto the empty vm (a remount via a per-conversation epoch key,
  never an in-place shrink), so a genuinely empty transcript can't be masked
  forever. The `chat-rail-stability` regression suite was rewritten to assert
  on the VISIBLE pane (`.car-conv:not([hidden])`) + the new preservation guarantee
  (same DOM node across a round-trip, cached messages instant on return), and still
  guards no-crash / no-boundary across rapid hops.

- **#344 — work "Add something to do" box moves to the bottom of the active items,
  ABOVE Done.** `WorkBoardTab.tsx` rendered the add box as a pinned bottom footer
  (`.cwb-foot`) BELOW the "Done · N" disclosure. It now renders IN-FLOW at the
  bottom of the active list and above Done — final order `[active items] → [＋ Add…]
  → [Done · N]` — in both the populated and empty-board states. `.cwb-foot` CSS
  removed; `.cwb-add` restyled for in-flow placement. (Web only — the mobile work
  board keeps its always-reachable pinned-footer add bar, a platform-appropriate
  pattern; see PR note.)

- **#345 — the attention dot is a clean amber, not brown.** The `--attention`
  token was `#9a6a00` (`chat-react.html`, the `data-theme="light"` block) which
  read as a muddy brown; it's now `#e0a020`, a clean golden amber that stays
  distinct from the build-blue (`--phase-build-fg`) and the failed-red
  (`--phase-failed-fg`). The dark value (`#ffd27d`, `:root`) was already a clean
  pale amber and is unchanged. (Note: the spec labelled the brown value "dark", but
  in the current file `:root` is the dark palette and `data-theme="light"` is light,
  so the brown `#9a6a00` was the LIGHT value — both themes now read clean amber,
  verified in-browser.)

- **#346 — per-message timestamp pinned BOTTOM-RIGHT for both roles.** `.car-time`
  was left-aligned by default and only right-aligned inside the user bubble, so the
  timestamp flipped side by role. It's now `text-align: right` for EVERY bubble
  (grey assistant AND blue user); the full-date hover `title` and the #338 day
  dividers are untouched.

**Verify.** `bunx tsc -p landing/chat-react/tsconfig.json` clean; 307 chat-react
tests pass (incl. the rewritten stability suite + a new work-board order test);
`leak-gate.sh --tree .` SILENT. Booted a QUIET local server and confirmed against
the real served/bundled assets: `--attention` = `#e0a020` (light) / `#ffd27d`
(dark), `.car-time` computes `text-align: right`, and the `.car-conv` mounted-
surface markup renders with rail + composer (no runtime crash from the refactor).

## 2026-07-03 — M1 redesign polish: atom favicon · inline delete confirm · Work pane inside the Chat view (full-width composer) · 2-line work rows (no flags)

**Why.** Four chat-UI refinements the owner asked for (with screenshots) after the M1
redesign shipped: (1) the browser-tab favicon was a generic mark, not the ⚛ atom
in the rail header; (2) deleting a work item took over the whole screen with a
modal; (3) the Work slide-out pane bled onto Documents/Settings (it was mounted at
the shell level, outside the tab hierarchy) and the chat input bar stopped at the
chat column with the pane running beside it to the window bottom (a side-by-side
seam); (4) work rows were single-line with the title cut off ("Ship dagcore: T…").

**What shipped.**

- **Favicon = the ⚛ atom mark** (`landing/favicon.svg`). Reproduces the `AtomMark`
  geometry from `ChatApp.tsx` (center dot + 3 rotated orbit ellipses) in a FIXED
  accent hex (`#007aff`, the light-theme `--accent`) — a favicon can't read page
  CSS vars. The served `/favicon.svg` (`landing/boot.ts` + `landing/server.ts`
  static route) now matches the rail-header icon on the browser tab.

- **Work-item delete confirm is INLINE-in-row, not a modal** (`WorkBoardTab.tsx`,
  `chat-react.html`). Deleted the `.cwb-confirm-backdrop` / `aria-modal` full-screen
  dialog + its CSS; the ✕ now reveals a compact `.cwb-confirm-inline`
  `role="group"` strip WITHIN the item's own row (`InlineConfirm`): a "Remove?" /
  "Cancel build?" prompt + Cancel + a destructive Remove. No backdrop, no screen
  takeover — the board stays visible + interactive. Autofocuses Cancel, Escape
  cancels, focus returns to the ✕ on dismiss. The confirm STATE machine
  (`confirmDelete`, `requestRemove`, the #174 linked-run cancel) is unchanged —
  only the render moved modal → in-row. One `confirmDelete` still means one row
  confirms at a time. Applies to active AND done rows.

- **The Work pane lives INSIDE the Chat view, composer = full-width footer**
  (`ProjectShell.tsx`, `ChatApp.tsx`, `chat-react.html`). The desktop slide-out
  (`PlansPane`) moved OUT of the `ProjectShell` shell level (where it was a sibling
  of the whole tab band, so it bled onto every tab) and INTO `ChatApp`/`ChatSurface`.
  The Chat view's `.car-thread` is now a flex column: a growing `.car-chatstage`
  row (the message column `.car-chatmain` + the pane, which animates its own width)
  ABOVE a full-width `.car-composer` footer. So the chat input bar spans the whole
  content width with the pane LIFTED above it (no bottom seam), and the pane is
  scoped to the Chat tab — hidden with the Chat tabpanel on Documents/Settings,
  state preserved across a round-trip. The shell still owns the `showPane` gate +
  drops the `workboard` tab on desktop; the `.car-stage` grid + `car-stage-pane-open`
  modifier were retired for a plain flex box. `PlansPane` itself is unchanged.

- **Work rows are 2-line (title / tag+round), 1-line when queued** (`WorkBoardTab.tsx`
  web + `app/components/WorkBoardRow.tsx` mobile, `chat-react.html`). Each row stacks
  a `.cwb-row-line1` (dot + FULL title + hover actions) over a muted `.cwb-row-meta`
  (phase tag + `round N`), gated on `hasStatus` (`tag !== null`): a bare queued card
  is a single title line (no empty second line), a bound run shows "Building · round
  1" on line 2, and a done row carries "Merged · <date>" on line 2. Titles no longer
  truncate prematurely (tag/round left line 1).

**Verified.** `tsc` clean (chat-react + app); 297 chat-react unit tests pass
(inline-confirm assertions replace the modal ones; new 2-line/1-line-queued row
test; the desktop pane test asserts the pane lives inside the chat tabpanel and the
`.car-plans-col` open-class shrink). Local dogfood (fresh QUIET install, headless
agent-browser, ≥1024px, BOTH light + dark): tab favicon = the atom; ✕ → inline
Remove?/Cancel/Remove in-row (no backdrop), Escape cancels, focus returns; the
composer spans the full width along the bottom with the Work pane above it; the pane
is GONE on Admin and restored on returning to Chat; a queued item is 1-line with the
full title. `leak-gate.sh --tree .` SILENT.

## 2026-07-03 — General gets a Work surface (desktop slide-out + narrow tab), scoped to its owner_slug board (no flags)

**Why.** M1 follow-up closing the last item the owner flagged directly ("there's no
Work tab in General … an oversight"). After the M1 redesign, desktop Work is a
right-edge slide-out pane (`PlansPane`, PR-4) and below 1024px it's a seated tab —
both mount only for a scope whose tab set carries a `workboard` descriptor.
General's tab set is Chat + Admin (the engine's global set is Admin-only), so
General had NO Work view — even though General-scoped work (builds kicked from the
General chat) lands on a real, backend-reachable board (the `owner_slug` scope key,
`work-board/store.ts`). So that work was invisible. This surfaces it.

**What shipped.**

- **General Work surface, one code path** (`landing/chat-react/ProjectShell.tsx`):
  the `if (isGeneral)` tab-set branch now injects the builtin `work_board`
  descriptor (`GENERAL_WORK_TAB`, `tabs-client.ts`) after Chat —
  `[CHAT_TAB, GENERAL_WORK_TAB, ...globalTabs]` — mirroring how the mobile shell
  injects its Work tab via `ensureWorkTab`. With the descriptor present, the
  EXISTING machinery lights up for General with zero new branch: on desktop
  (≥1024px) the `showPane` gate mounts the `PlansPane` slide-out (edge-handle +
  auto-open-on-kickoff / auto-close, per PR-4); below 1024px Work stays a seated
  tab. General keeps its Chat + Admin tabs — Work is ADDED, not swapped.

- **General board scoping (the `''` ↔ `'general'` reconciliation)**
  (`landing/chat-react/work-board-client.ts`): the web shell scopes General as the
  empty project id `''` EVERYWHERE — the rail's General row is `vm.projectId ===
  null`, and the live `work_board_changed` filter keys off `(framePid ?? '') ===
  projectId`, so General MUST stay `''` for its no-`project_id` snapshot to be
  applied (kickoff auto-open, live dot/tag walk). But the HTTP work-board surface
  keys General on the literal `'general'` id (`workBoardScopeKey(owner_slug,
  'general') → owner_slug`) and 400s on an empty path segment. So the new
  `workBoardPathSegment` helper maps `'' → 'general'` at the URL boundary ONLY
  (never the `//work-board` double-slash the ProjectShell Codex-P2 note flags);
  named ids pass through untouched. No scope-key semantics changed — `store.ts` is
  untouched.

- **Mobile:** unchanged. Mobile General is not yet a navigable scope (its rail has
  no synthetic General entry — `GENERAL_PROJECT_ID` is only used to *detect* a
  General row, never to *construct* one — and `app/lib/projects.ts` has no General),
  so there's no mobile Work-tab-for-General gap to close here without first building
  the whole General-on-mobile surface (out of scope). The existing `ensureWorkTab` +
  `workTabBadgeCount` machinery already applies to the `'general'` id the moment
  General becomes navigable on mobile. Noted in the PR + SYSTEM-OVERVIEW.

**Tests.** `work-board-client.test.ts` (`'' → 'general'` path mapping for
list/create/start, named-id pass-through, no double-slash); `tabs-client.test.ts`
(`GENERAL_WORK_TAB` shape); `project-shell.test.tsx` (narrow General = Chat + Work
+ Admin; desktop General mounts the pane, drops the Work tab, and its board query
targets `/api/app/projects/general/work-board`); `component.test.tsx` create-project
fetchImpls now serve the General board (the pane lists on mount under happy-dom's
desktop viewport). tsc clean; leak-gate SILENT.

**Files.** `landing/chat-react/ProjectShell.tsx`, `tabs-client.ts`,
`work-board-client.ts` + the four test files; `docs/SYSTEM-OVERVIEW.md` (the
"General's Work view" follow-up note flipped to CLOSED).

## 2026-07-03 — M1 UX redesign PR-6: Mobile project rail + seated tabs + Work-badge (LAST redesign PR, no flags)

**Why.** owner-signed-off M1 UX redesign (2026-07-02). PR-6 is the MOBILE
counterpart of PR-3's desktop rail/tabs (the Expo app under `app/`). The owner
explicitly asked for the mobile project rail to show the emoji **and the project
name below it** (Telegram-folder-style) — overriding the prototype's emoji-only
icon rail. Depends on PR-1..5 (all merged). No feature flags — one code path.

**What shipped.**

- **Telegram-folder project rail** (`app/components/ProjectRail.tsx`, new) seated
  on the LEFT of the workspace (`app/app/projects/[id]/_layout.tsx` restructured to
  `[rail | (tabs + content)]` on the narrow/native path). Each entry: emoji +
  **name directly below** (weight bumps on unread, 1-line ellipsis) + a corner
  **work-activity dot** — `working` → pulsing `--work` @2.4s (reduced-motion-gated
  via `AccessibilityInfo`), `attention` → static `--attention`, `idle`/General →
  none. Active project highlighted; tap → `router.replace('/projects/<id>')`; a `+`
  jumps to the project list. Dot logic is the pure `railDotKind`
  (`app/lib/project-rail-view.ts`, unit-tested).

- **Seated tabs** (`app/components/ProjectTabBar.tsx` `NarrowTabBar`): top-rounded
  sheets on a `surface` band, active tab fused to the content sheet (mirrors PR-3
  desktop). Replaces the old underline/pill treatment — one path.

- **Work-tab live-run badge**: the registry emits no Work descriptor, so
  `ensureWorkTab` (`app/lib/project-tabs.ts`) injects a Work tab after Chat over
  BOTH the loading default and the fetched set (idempotent, one path), routed to
  the existing `workboard.tsx`. The tab bar renders a phase-build-tinted `.cap`
  badge for any tab with a positive count; the layout feeds the current project's
  `live_runs`.

- **Rail data (no re-derivation).** SET from `fetchProjects` (HTTP);
  `activity`/`live_runs` overlaid LIVE from the app-ws `projects_changed` frame via
  a new `app/lib/projects-rail-live.ts` subscriber (mirrors `work-board-live.ts`,
  injectable socket). The mobile HTTP `/api/app/projects` never carried these
  fields — the composer-fanned frame is the single source of truth (same as web).

- **Server (minimal):** `on_session_open` (`open/composer.ts`) now pushes the
  current projects snapshot straight to the just-connected topic, so a freshly-
  connected mobile rail seeds on open instead of waiting on the global diff-gate.

- **Theme:** added `work` (#66ccff) + `attention` (#ffd27d) tokens to
  `app/lib/theme.ts` (mirror of the web `--work`/`--attention`); theme lock-test
  updated.

**Tests.** `project-rail-view.test.ts`, `projects-rail-live.test.ts` (fake
socket), `project-tabs-work.test.ts` + theme lock-test — full app suite 693 pass.
App `tsc` clean, root `tsc` clean, leak-gate SILENT.

**Out of scope.** Desktop web (PR-1..5), docs drill-down (PR-5), a rail preview
line, any activity/live_runs derivation outside the composer.
## 2026-07-03 — TRIDENT parallel builds + build lifecycle (#342/#340/#339/#334/#337)

**Why.** The owner's live test 2026-07-03 (SPEC.md Decisions Log, owner-locked). the legacy harness runs
3+ parallel trident builds in one project constantly; Open couldn't. Plus four
lifecycle gaps: a failed build vanished, a finished build never announced, a build
could run untracked, and an underspecified ▶ dumped raw guard text into the pane.
NO feature flags; one code path; leak-gate SILENT. Stayed clear of the pure chat-react
UI polish (#333/#335/#336/#338/#341 — a separate forge, landed as #189; this branch
rebased onto it, resolving the `chat-react.html` `.cwb-drag` overlap by keeping both
#341's grip styling and this PR's `.cwb-fail-reason`).

**FIX 1 (#342, P1) — 3+ concurrent same-project builds.** Each build already runs in
its own worktree and `mergeLocal` already serializes LOCAL merges per `repo_path`
(`withLocalMergeLock`). But inside the lock it did a plain `git merge --no-ff` that
THREW on any conflict — so a 2nd same-project build (branch cut from the pre-1st base)
died on a merge conflict (this killed `dagcore` after `walstore` merged). Now
`mergeLocal` (`trident/merge.ts`): resolves the base, **rebases the build's branch onto
the latest base** (`git checkout <branch>` + `git rebase <base>`), then `git checkout
<base>` + `git merge --no-ff` (a clean no-conflict merge since the branch now contains
base). On a rebase CONFLICT it dispatches a **bounded Forge resolver**
(`trident/conflict-resolver.ts`, `buildForgeConflictResolver` over the composer's
`makeEphemeralSubstrate('cc-trident-resolve')`): a single tool-less CC turn rooted in
the conflicted worktree that resolves + `git add`s the conflicts (the loop runs `git
rebase --continue`), keeping both intents where compatible; it reports `RESOLVED` or
`ESCALATE: <specific question>`. A genuinely ambiguous conflict (or a missing/timed-out
resolver) throws `TridentMergeConflictEscalation`, which `orchestrator.applyResult`
turns into a `failed` run whose `failure_reason` IS the specific question — so it rides
the terminal chat delivery (FIX 3) verbatim, never a raw "merge failed". Bounded: an
8-min per-turn timeout, escalate-on-uncertainty, `MAX_CONFLICT_ROUNDS=12`. Wiring:
`orchestrator.resolve_conflict` → `buildMergeCleanupDeps(run_host, { resolve_conflict })`;
threaded through `input.trident.resolve_conflict` (`misc-input.ts` →
`build-core-modules.ts` → `open/composer.ts`).

**FIX 2 (#340) — a failed build shows FAILED, keeps its link, no revert.** Added a
fourth Work Board lane `'failed'` (migration `0097`, widened CHECK via table rebuild).
`WorkBoardStore.detachRun('failed')` now sets `status='failed'` and KEEPS
`linked_run_id` (was: revert to `upcoming` + null the link, which showed a grey
never-started card and lost the failure). The client already renders a red dot +
failed tag off `run_progress.step_label==='failed'` (kept alive by the retained link);
this PR renames the tag copy to **"Failed"** and renders the `failure_reason` one-liner
(`.cwb-fail-reason` web / `failReason` mobile). Client status unions + parse guards
widened to `'failed'` (`work-board-client.ts` web+mobile — the mobile parser had been
DROPPING any unknown-status item), plus `AppWsWorkBoardItem` + `statusLabel`/`nextStatus`.

**FIX 3 (#339) — terminal builds announce in chat.** Root cause was two-fold: (a) a
board-dispatched run carried `chat_id=null` (the warm-REPL `ToolCallContext.topic_id`
is null by design), so `topicForRun` no-op'd; (b) even with a chat_id, Open's delivery
`ChannelRouter` has NO app_socket adapter registered, so `router.send` threw and was
swallowed. Fix: (a) `resolve_delivery(project_id)` on the dispatch tools + the ▶ route +
`/code` stamps the originating app-ws topic (`<appWsTopicId>[:<project_id>]`, `project_id`
is correctly populated on the tool ctx) onto the run's `chat_id`; (b) a composer-supplied
`delivery_sink` backed by the durable `AppWsAdapter.send` (persists + fans live) replaces
the bare router for on-terminal delivery. Copy is now slug-forward ("✅ `<slug>` — build
done, merged" / "❌ `<slug>` — build failed: `<reason>`").

**FIX 4 (#334) — every build creates a trackable card.** Strengthened
`BUILD_ROUTING_DOCTRINE` (`operating-doctrine.ts`): EVERY build — inline OR trident, any
project incl. General — MUST `work_board_add` a card FIRST (inline builds mark it
inline_active + done); an untracked build is invisible to the owner.

**FIX 5 (#337) — underspecified → ask in chat, not raw guard in the pane.** The ▶ HTTP
route previously mapped an `underspecified` rejection to a 409 whose raw guard message
the client painted into the `cwb-error` pane banner. Now the composer's start closure
posts a short clarifying question to the chat (`buildClarifyPoster`, via the app-ws
adapter) and `handleStart` returns 200 `{asked_in_chat:true}` — no raw text in the pane,
item left quietly pending. The agent-native path already returns the rejection to the
model (which the strengthened doctrine tells to ask in chat).

**Tests.** trident + work-board + composer green incl. a concurrent-merge test and a
3-build serialized rebase+resolve test (`trident/merge.test.ts`), conflict-resolver
marker parsing (`trident/conflict-resolver.test.ts`), orchestrator resolve-vs-escalate
(`trident/orchestrator.test.ts`), `detachRun('failed')` keeps-link + retry
(`work-board/store.test.ts`), delivery copy (`trident/delivery.test.ts`),
`resolve_delivery` threading (`trident/work-board-build-tool.test.ts`), doctrine
always-card + ask-in-chat (`operating-doctrine.test.ts`), and the ▶ underspecified→200
(`work-board-surface.test.ts`). `tsc` clean (root + trident + leaf); migrations snapshot
regenerated (`0097`); leak-gate SILENT; QUIET local boot verified (healthz ok, `0097`
applied).

## 2026-07-03 — UX BATCH-2: 5 chat/work-board polish fixes (#333/#335/#336/#338/#341)

**Why.** Five small UI defects from the owner's live review 2026-07-03. All presentational /
run-progress; no feature flags; kept clear of trident/merge + build-dispatch (a
separate forge owns #334/#337/#339/#340/#342).

**Spec-conformance diff.** SPEC = rail dot pulses in work-blue; transient system pills
never persisted; Fixing shows round 2+; chat has timestamps+date-hover+day-dividers;
drag handle is grip-dots no-border. CURRENT (pre-PR) = rail dot used the separate
`--work` token; waking-up pill persisted→re-hydrated as a bubble on reload; Fixing
showed round 1; chat had no timestamps; drag handle was a bordered `.cwb-btn` box.
GAP = all five. THIS PR = all five. OUT = build-dispatch behavior + trident-parallel.

**What shipped.**
- **#335 rail activity dot (web + mobile).** The `working` rail dot now MATCHES the
  Work-list building dot exactly: the building blue (`--phase-build-fg` /
  `PHASE.build.fg`, not the separate `--work` token) with the shared `cwb-pulse`
  (opacity 1→.4→1, 2s, prefers-reduced-motion gated). `attention` stays a STATIC
  amber (`--attention`) reserved for a genuine stall/failed-not-done.
  (`landing/chat-react.html` `.car-rail-dot-work`; `app/components/ProjectRail.tsx`
  `ActivityDot`.)
- **#333 transient system pills are live-only.** The cold-start "⏳ Waking up…" ack
  now rides a first-class `system_notice: true` flag end-to-end
  (`AgentMessageOutbound` → `buildAppWsSendReply` adapter_options →
  `AppWsAdapter.send`): the adapter fans it out to the live socket but SKIPS the
  durable `chat_log` row (and the project `last_activity_at` stamp), so a
  reload/project-switch can't re-hydrate it as a stray chat bubble. The client
  already routed `system_notice` to the quiet pill.
- **#336 Fixing shows the fix-round.** `deriveRunProgress` derives the displayed
  `round` from the inner checkpoint (the outer `code_trident_runs.round` stays 1 for
  the whole in-process workflow — `checkpoint()` never bumps it): a
  `argus-request-changes` (fixing) step now floors the round at 2; `fix-round-N`
  carries N; a first build stays round 1. (`trident/run-progress.ts` only — no
  inner-workflow edit, to stay clear of the trident forge.)
- **#338 chat timestamps + date-on-hover + day dividers.** `RenderMessage` gains a
  real-wallclock `timestampMs` (durable rows only); a context-keyed meta index
  (`buildMetaIndex`) tags each bubble with a subtle trailing `HH:MM` time (full date
  on hover via `title`) and a centered "Today / Yesterday / Mon Jul 1" day divider
  above the first message of a new calendar day. (`landing/chat-react/controller.ts`,
  `ChatApp.tsx`, `.car-time`/`.car-day-divider` CSS.)
- **#341 drag handle is grip-dots.** The reorder handle drops the `.cwb-btn`
  bordered-box chrome — just the ⠿ grip glyph, muted (`--faint`→`--muted` on hover),
  grab/grabbing cursor — so it reads as a draggable grip, not a third action button
  next to ▶/✕. (`landing/chat-react/WorkBoardTab.tsx` + `.cwb-drag` CSS.)

**Verify.** tsc clean (root + chat-react + trident + app); 415+ chat-react/app-ws
suites green + new tests for the round derivation, the ephemeral-send no-persist path,
and the time/divider helpers; leak-gate SILENT. Both light+dark preserved;
prefers-reduced-motion gated.

## 2026-07-02 — M1 UX redesign PR-4: Work slide-out pane (edge-handle + auto-open/close, no flags)

**Why.** owner-signed-off M1 UX redesign (2026-07-02). PR-4 replaces the desktop
"Work" TAB with a right-edge **slide-out pane INSIDE the chat** — the authoritative
prototype (`neutron-redesign-proto.netlify.app`) behavior, with the owner's sign-off
overrides winning over the design doc's toggle-chip proposal: **an edge-handle is
the only manual control (no toggle button / no X / no close chevron)**, and
**auto-open-on-kickoff / auto-close-when-all-done** is the primary behavior. Depends
on PR-1 (#180 activity/live-run), PR-2 (#181 Work-list rows), PR-3 (#182 rail +
seated tabs). No feature flags — one code path per viewport. Web
`landing/chat-react/` only (NOT docs [PR-5] or mobile rail + Work-badge [PR-6]).

**What shipped.**

- **Desktop (≥1024px): Work is a pane, not a tab** (`ProjectShell.tsx`). Via
  `useMediaQuery('(min-width:1024px)')`, the `workboard` descriptor is dropped from
  the seated tab bar and a new `PlansPane` is mounted instead. **Below 1024px Work
  stays a tab** (mobile Work badge is PR-6) — one implementation per viewport, no
  dual tab-and-pane path. When the Work tab is dropped, an active-tab clamp falls
  back to Chat (reuses the existing resolving-scope guard, now over `visibleTabs`).

- **`PlansPane.tsx` — chrome around the shipped `WorkBoardTab` body** (rows
  unchanged: dot + tag + round, collapsible Done, drag-reorder, ✕-confirm, ▶
  start/retry, add-at-bottom). The pane adds a quiet caps `WORK` header + a live
  count (`● N running` / `● N failed`, activity dot), the edge-handle, and the
  floating-panel container.

- **Edge-handle = the ONLY manual control** (`.car-plans-handle`, a real `<button>`
  with an aria-label "Show work"/"Hide work", Enter/Space operable). It rides the
  pane's left seam — at the window's right edge when closed (the way in), riding to
  the pane's left seam when open. NO toggle button, NO X, NO close chevron anywhere.

- **Auto-open / auto-close (`usePlansPaneController`).** Opens when a plan is kicked
  off (a board item gains a live non-terminal run → the `WorkBoardTab` `onSummary`
  roll-up's `running` rises); stays open while any run is live; keeps open on a
  **failed** run (attention); auto-closes ~5s after ALL runs are clear (running +
  failed both zero). A manual handle toggle pins + persists per-project
  (`localStorage`) until the next auto-kickoff. `WorkBoardTab` gains a pure
  `summarize()` export + an `onSummary` callback (fired on every board change).

- **Floating panel, not a wall** (`chat-react.html`). The chat STAGE below the tab
  band is a 2-column CSS grid (`.car-stage`) whose pane column animates
  `0 → --pane-width` (340px), so the chat column shrinks in lock-step (chat is never
  overlaid). The panel (`.car-plans`) floats flush to the right edge with ~16px
  top/bottom breathing room, rounded left corners (`14px 0 0 14px`), and a soft
  shadow; closed = translated off-screen + `visibility:hidden` (its controls leave
  the tab order). New tokens `--pane-width` + `--ease-out`
  (`cubic-bezier(0.32,0.72,0,1)`); motion gated by `prefers-reduced-motion`. Both
  light + dark palettes preserved.

- **Tests.** `plans-pane.test.tsx` (controller: kickoff-opens / settle-auto-closes
  / failed-stays-open / manual-pin-persists; `PlansPane`: edge-handle is the only
  control + toggles; live running item auto-opens end-to-end) +
  `project-shell.test.tsx` desktop test (Work tab absent at ≥1024px, handle mounted,
  clicking expands the stage grid). Verified locally at 1280×… both themes: no Work
  tab, floating pane below the band, chat shrinks, sticky survives a restart.

## 2026-07-02 — M1 UX redesign PR-3: rail 2-line rows + seated tabs + ⚛ branding (no flags)

**Why.** owner-signed-off M1 UX redesign (2026-07-02). PR-3 reskins the web chat
shell's left rail and tab band to the authoritative prototype
(`neutron-redesign-proto.netlify.app`): a Telegram-style 2-line project rail with
a work-activity dot + preview, an ⚛ Neutron branding header, and real seated tabs
with a workspace-identity seat. Consumes PR-1 (#180) rail fields
(`activity`/`preview`/`preview_from`/`last_activity_at`). No feature flags — one
code path, the old rail-row + underline-tab CSS deleted. Web `landing/chat-react/`
only (NOT the Work slide-out pane [PR-4], docs [PR-5], or mobile [PR-6]).

**What shipped.**

- **⚛ Neutron branding header** (`ChatApp.tsx` `TopicRail` + new `AtomMark`;
  `chat-react.html` `.car-rail-head`). The "PROJECTS" caps label is replaced by an
  inline-SVG atom (`--accent`, 3 rotated ellipses + center dot) + the "Neutron"
  wordmark (16px/700). The new-project `+` moves to the right of the header
  (`.car-rail-newp`) and toggles the inline create form; the old bottom
  "Create Project" button is deleted.

- **Telegram-style 2-line rail rows** (`RailItem`; `.car-rail-item` grid). Emoji
  "avatar" (40px plain glyph) + a corner **work-activity dot** (`railDotClass`:
  `working` → pulsing `--work` @2.4s, `attention` → static `--attention`, else
  none; General has no dot; `prefers-reduced-motion` disables the pulse). Line 1 =
  name (15px/590, 700 unread) + right-aligned timestamp (`formatRailTime` off
  `last_activity_at`: today → `14:32`, this week → `Mon`, older → `Jun 28`,
  tabular-nums). Line 2 = one-line ellipsised `preview` (muted, `--fg-2` unread;
  `You:` prefix when `preview_from==='user'`) + the unread badge. New tokens
  `--work`, `--attention`, `--fg-2`, `--faint` added to BOTH `chat-react.html`
  palettes (light + dark).

- **Narrow (<1200px) icon rail.** A JS `narrow` render branch (`useMediaQuery`,
  test-overridable via a `narrow` prop) collapses the rail to a 68px icon rail:
  avatar + corner dot + a small corner count badge (`.car-rail-count`), names in
  the row `title`. Supports PR-4's rail auto-collapse.

- **Seated tabs + workspace-identity seat** (`ProjectShell` `.car-topbar`/`TabBar`
  + new `WorkspaceSeat`; `chat-react.html` `.car-tab`/`.car-wsseat`). The band is a
  `--surface` strip whose ACTIVE tab lifts onto the content sheet (bg `--bg`, a
  border minus its bottom edge, `margin-bottom:-1px` fusing it to the page); the
  sliding `--accent` underline treatment is DELETED. A workspace seat (active
  scope's `emoji + name`; General → `💬 General`) sits left of the tabs — no
  activity dot (that lives on the rail, per the owner's de-dup). Theme toggle kept.

- **Tests.** `component.test.tsx` (+ new `formatRailTime`/`railDotClass`/`railEmojiFor`
  pure tests, 2-line-row content, work/attention dots, `You:` prefix, narrow icon
  rail) and `project-shell.test.tsx` (workspace seat: General + project). tsc clean,
  leak-gate SILENT. Existing create-project tests updated for the header `+`.

## 2026-07-02 — M1 UX redesign PR-2: Work-list rows + chat message formats (no flags)

**Why.** owner-signed-off M1 UX redesign (2026-07-02). PR-2 reskins the Work-list
rows to a plain-language, non-technical-user bar (the "plain-language" bar) and fixes the
chat message-format split. Depends on PR-1 (#180) `step_label` + the live tick
fan. No feature flags — one code path, the old glyph/arrow code deleted.

**What shipped.**

- **"Plan" → "Work"** user-facing tab label (`tabs/registry.ts`); internal
  `work_board_*` / `cwb-` / DB identifiers unchanged. Onboarding closing +
  preamble copy follow ("its Work, Documents, and Chat").

- **Work-list rows (web `landing/chat-react/WorkBoardTab.tsx` + mobile
  `app/components/WorkBoardRow.tsx`).** Each active row is now
  `[dot] title … [phase tag] [round] [hover actions]`, consuming PR-1's
  `step_label`:
  - **Leading dot** — faint-gray outline before a build starts; a colored
    PULSING dot while a bound run walks building→reviewing→fixing→merging (pulse
    in the tag's color, gated by `prefers-reduced-motion`); solid red on failure;
    solid green when done.
  - **Phase tag** — a small typographic capsule (Building / Reviewing / Fixing /
    Merging / Merged / "Didn't finish"), tinted bg + colored fg, no border, no
    emoji. New phase color tokens in both `chat-react.html` palettes (dark +
    light) and mobile `app/lib/theme.ts`.
  - Deleted the emoji-glyph status noise (📝🔨🔍✅⚠️🚫) + the `⑂`/`›` activity-glyph
    column + the elapsed-minutes timer. `round N` (muted) trails the tag.
  - **Drag-to-reorder** via a `⠿` grip (web: HTML5 DnD + arrow-key parity;
    mobile: pointer/accessibility reorder) replacing the ▲▼ arrows; persists
    `sort_order` via the existing reorder route.
  - **✕ delete asks to confirm first**; ▶ starts a not-started card, ↻ retries a
    failed one.
  - Completed items collapse under a **"Done · N"** disclosure (default closed,
    caret ▸/▾) and show a **"Merged · Jul 2"** datestamp.
  - The **add-something-to-do** affordance moved to the BOTTOM of the list.

- **Chat message formats (web).** Errors + command results stay ORDINARY agent
  chat bubbles (a "build failed" is a message, not a banner) — the Work-list ↻
  covers the "build failed → retry" case. A quiet centered **system-notification
  pill** (`.car-system-pill`) is now the ONLY thing in the system-message style,
  reserved for true notifications: the gateway's cold-start "Waking up…" ack
  renders as the pill (self-clearing when the real reply streams) instead of a
  bubble. (Mobile chat-format parity is a documented follow-up — see PR notes.)

## 2026-07-02 — trident/work-board correctness bundle (3 bugs a live parallel build test exposed)

**Why.** A live test dispatched two trident builds (taskdag + waldb) in parallel
for the same owner. Both built + committed fine, then three engine defects
surfaced: (1) waldb FAILED at merge with `untracked working tree files would be
overwritten: taskdag, dag.ts` — the OTHER build's files; (2) taskdag ended
`subagent_status='completed'` but its `phase` stuck at `forge-init` forever; and
(3) separately, every project's Plan tab showed the SAME list. One PR, no feature
flags, no migration.

**What shipped.**

- **Bug 1 — per-workspace merge serialization.** Two builds in the same project
  share ONE `code` workspace, so their local merges (`git checkout <base>` + `git
  merge --no-ff` in the one working tree) race — A's committed-but-unmerged files
  are untracked when B checks out base. `trident/merge.ts:mergeLocal` now runs
  under a per-`repo_path` promise-chain lock (`withLocalMergeLock`): the 2nd merge
  waits, then merges on a base that already has A's files TRACKED. Keyed on
  `repo_path` so different-project workspaces still merge in parallel; a failed
  predecessor never wedges the queue. PR-mode is untouched (it never merges in the
  shared tree). Verified against REAL git: two concurrent `cleanupAfterMerge` calls
  on one repo land BOTH branches on main with no untracked-overwrite.
- **Bug 2 — robust terminal harvest.** The inner workflow writes
  `subagent_status='completed'` in the same sqlite UPDATE that sets `inner_result`
  via `readfile()`. If that readfile yields null, the run is left `completed` with a
  null/garbled result: `parseInnerResult` returns null (harvest never fires) and the
  completed-write re-stamps `last_advanced_at` (hang watchdog DEFEATED) → stuck at
  `forge-init`. `trident/orchestrator.ts` now treats a terminal `subagent_status`
  with no parseable `inner_result` as a TERMINAL FAILURE (never merges — no verified
  result). Defense-in-depth: `writeTerminalResult` (`inner-workflow.mjs`) flips
  `subagent_status` to `completed` only inside a CASE guarded on the same
  `readfile()` being non-empty, so the columns can't disagree at the source.
- **Bug 3 — per-project Plan board.** The HTTP surface keyed every store call on
  the instance constant `resolved.project_slug`, so all projects collapsed onto one
  board. It now keys on `workBoardScopeKey(owner_slug, <url project_id>)` (new, in
  `work-board/store.ts`): the owner slug bounds the scope (single-owner box), the
  validated URL `project_id` selects the project (General → the bare owner slug,
  which also carries all pre-scoping legacy rows — no migration, no history
  stranded). A cross-scope `store.get` miss stays a 404. The dispatch ▶ path threads
  the same scope so a build resolves a per-project workspace + reconciles on the
  right key. The `work_board_changed` push tags each frame with the per-project
  `project_id` (`workBoardProjectIdForKey`); the app + web clients now apply a
  frame ONLY on an EXACT board match — an untagged frame is the General board
  (projectId `''`/null), NOT a broadcast (Codex P2 fix — else a General/agent
  write clobbered an open project's live view). Interaction:
  fixing #3 does NOT subsume #1 — two concurrent builds in the SAME project still
  share one workspace, so #1's lock is still required.

**Scope note.** The agent `work_board_*` tools + the per-turn injection still key on
the instance slug (hard-overridden in `mcp/server.ts`), so the chat agent and the
General Plan tab share the General board; per-project boards are human/HTTP + ▶
scoped. A deeper per-project agent context is a separate change (out of scope).

**Tests.** Deterministic coverage for all three GATES: merge mutex (serialize on
same `repo_path`, parallel on different, failed-first doesn't wedge) + a real-git
concurrent-merge check; harvest gate (completed+null → failed, completed+garbled →
failed, running+null NOT reaped); surface per-project isolation (A vs B distinct,
cross-scope 404, General→owner-slug legacy rows) + scope-key helpers + onChange
key-passing. `bunx tsc --noEmit` clean; trident + work-board suites green (442 +
84 targeted); leak-gate SILENT.

## 2026-07-02 — M1 Work Board ▶ play button + on-disk spec persistence

**Why.** Two coupled gaps from the live trident test: (1) a Plan card that was
added but never dispatched (or whose build failed) had no way to START/RETRY it
from the board — only auto-dispatch + the `#174` X-cancel existed; (2) a card
persisted ONLY its one-line `title` — the full context/ask lived in session
context and only landed on disk (in `code_trident_runs.task`) AFTER a build
started. So an `upcoming` card's spec did not survive a session reset, and a ▶
that survives a reset had nothing to build from. One PR, no feature flags, no
migration (the `design_doc_ref` column already existed, unused for docs).

**What shipped.**

- **Spec-doc persistence.** `work-board/spec-doc.ts` (pure): a triviality
  heuristic (`shouldPersistSpecDoc` — a short one-liner stays title-only;
  multi-line or ≥20-word specs persist), the `plans/<slug>.md` path, and the
  `neutron-docs:` deep-link ref build/parse + doc-link label. New
  `work-board/spec-doc-service.ts` (`WorkBoardSpecDocService`) is the ONE seam
  coupling the policy to the real `DocStore` + `WorkBoardStore`:
  `createCardWithOptionalSpec` writes the doc to `Projects/<id>/docs/plans/<slug>.md`
  and links the card; `resolveTaskForItem` reads it back as the build spec. An
  `ensureDocsDir` hook (composer → recursive mkdir of the project docs root)
  guarantees the write never silently degrades for a not-yet-materialized project
  scope. A doc-write failure degrades gracefully to a title-only card.
- **▶ start/retry.** `POST /api/app/projects/<id>/work-board/<item>/start` +
  the agent-native `work_board_start` tool, both routing through the SAME
  `dispatchBoardBoundBuild` chokepoint (required-item + ask-before-acting gate +
  `attachRun`), resolving the card's saved spec (doc, else title) as the run
  `task`. A live-run guard 409s a double-start; an underspecified card 409s with
  the clarify guidance; an LLM-less box 501s (dispatch unwired, mirroring
  `work_board_dispatch_build`). `work_board_add` gained a `spec` param; the HTTP
  create route gained a `spec` field — both route through the service.
- **UI.** Web `WorkBoardTab.tsx`: an always-visible ▶ on a startable card (START
  vs RETRY by label) + a tappable `📄 <name>` doc link that opens the Documents
  tab (threaded `onOpenDoc` from `ProjectShell`, reusing the `#148` doc-link nav);
  `cwb-btn-play` + `cwb-doc-link` CSS. Expo `WorkBoardRow.tsx` + `workboard.tsx`:
  the same ▶ + doc-link for parity. `work-board-client.ts` (web + app): a `start()`
  method + `docPathFromDesignRef`/`docLinkLabel` mirrors.
- **§1b unification (one canonical doc).** ▶ feeds the card's doc content to the
  run as its `task`, so the doc IS the spec the trident planning stage reads —
  verified live (the dispatched run's `task` was the doc's full body). There is
  no second user-facing plan doc.

**Spec-conformance delta (owner-locked path adjusted for the docs surface).**

- The spec's owner-locked folder was literally `Projects/<id>/plans/<slug>.md`.
  The `DocStore` confines every SERVED + tappable doc to `Projects/<id>/docs/`
  (`gateway/http/doc-store.ts` resolves the docs root there; only the fixed
  `STATUS.md` basename is surfaced from the project root). A doc at
  `Projects/<id>/plans/…` (a sibling of `docs/`) would NOT be served by the docs
  API nor appear in the Documents tab — breaking the hard requirement that the
  doc is "served by the existing docs store/API + shows in Documents +
  tappable". So the plans folder is nested UNDER `docs/`:
  `Projects/<id>/docs/plans/<slug>.md`. This honours the intent (user-visible
  project docs, a `plans/` folder, tappable) exactly; the only delta is the
  `docs/` prefix, which is what makes it visible at all.
- **§1b write-back deferred (noted, not built).** ▶ makes the card doc the
  READ source-of-truth for the build (`task` = doc content). The spec's further
  ask — the ralph planning stage writing its ELABORATED `IMPLEMENTATION_PLAN.md`
  BACK INTO the card doc — materially reshapes the ralph I/O: the ralph loop runs
  in an ephemeral git WORKTREE and writes `IMPLEMENTATION_PLAN.md` at the worktree
  root, while the card doc lives in `NEUTRON_HOME/Projects/<id>/docs/`; the
  detached inner Workflow has no `DocStore` handle, and ralph only engages for a
  governed repo (`SPEC.md` at the git root), not the common single-context build.
  Per the spec's own "STOP and note the delta rather than fork a second code
  path" instruction, the bidirectional write-back is left for a follow-up. No
  parallel user-facing plan doc is created; the worktree `IMPLEMENTATION_PLAN.md`
  is an existing build-internal artifact (not user-surfaced).
## 2026-07-02 — Trident: per-project git build workspace (brand-new projects are buildable)

**Why.** A trident build for a BRAND-NEW project (no code repo) died ~2 min in —
`worktree` never created, `forge:build` produced no transcript, workflow jumped to
cleanup. Root cause: the dispatch chokepoint wrote the owner HOME dir
(`resolveNeutronHome`, a non-repo) as EVERY run's `repo_path`, so the inner
workflow's `isolation:'worktree'` (`git worktree add`) failed at forge-init before
Forge ran. Only projects that already had a git repo built.

**What shipped.** New `trident/build-workspace.ts:ensureProjectBuildWorkspace`
resolves + git-inits (idempotent, `--initial-branch=main` + an `--allow-empty`
INITIAL COMMIT so `git worktree add` has a HEAD) a per-project
`<owner_home>/Projects/<project_slug>/code` workspace. `dispatchBoardBoundBuild`
(`trident/board-dispatch.ts`) now resolves this FIRST, runs merge-mode/ralph
detection against the RESOLVED workspace, and writes that per-project path onto the
run row's `repo_path` — replacing the old `repo_path = owner_home` assignment (one
code path, no flag). The three dispatch dep interfaces now document `repo_path` as
The owner HOME BASE with an injectable `resolveBuildRepo` test seam. A fresh local
project has no origin → merge mode `'local'` (branch + local merge, no PR); success
= a local BRANCH WITH COMMITS, not a PR#.

**Verified.** `tsc` clean (root + trident); 361 trident tests green;
`trident/build-workspace.test.ts` added (pure-probe + real-git + dispatch-level).
A no-LLM real-git e2e reproduced the original `fatal: not a git repository` failure
on the old path, then drove resolver → `detectMergeMode`=local/`detectBaseBranch`=main
→ `git worktree add` → multi-file branch with commits → real `mergeLocal` →
merged-local terminal state. The full autonomous-LLM `forge:build` leg (#176's
already-verified toolless fix) was not re-driven in this headless run; the git
workspace was the missing precondition and is now proven to satisfy `worktree add`.

## 2026-07-02 — M1 trident-UX hardening: live Plan progress, hang watchdog, X-cancels-run, confirm dialog

**Why.** A live trident test wedged SILENTLY and surfaced four gaps: (1) a
Plan item dispatched to a build showed only a fork `⑂` glyph — no phase, round,
or elapsed, so a running build looked identical to an idle one; (2) a workflow
`agent()` hung (a zero-token model hang) and NOTHING detected it — the run sat
`forge-init` for 30+ min with no error; (3) deleting a Plan card left its trident
run building headless (the `DELETE` never cancelled the run); (4) the X deleted
instantly, so a fat-finger could cancel an expensive running build. One PR, no
feature flags, no migration (all four derive from existing columns).

**What shipped.**

- **Live progress on Plan items (item 1).** New pure `trident/run-progress.ts`
  (`deriveRunProgress`) maps a linked `code_trident_runs` row → `{phase_label,
  round, elapsed_ms, stalled, pr, verdict, …}`. Critically the label is derived
  from `phase` + `inner_checkpoint`, NOT `phase` alone — in the Phase-2a EXEC
  model the outer `phase` stays `forge-init` for the whole inner workflow, so the
  live granularity lives in the checkpoint (`forge-done`→reviewing,
  `fix-round-N`→building round N, `argus-approved`→reviewing). Both the HTTP GET
  surface AND the `work_board_changed` push (`open/composer.ts`) attach
  `run_progress` per bound item; the wire type is `AppWsRunProgress`
  (`channels/adapters/app-ws/envelope.ts`). The web Plan tab
  (`landing/chat-react/WorkBoardTab.tsx`) renders a compact sub-label ("🔨 building
  · round 1 · 4m", "🔍 reviewing · round 2", "✅ merged · PR #7") and shows a
  "⚠️ stalled Nm" warning past `STALLED_WARN_MS` (10 min). Intermediate
  checkpoints don't mutate the board row (no push), so the tab quietly re-polls
  every 15s while any run is live + ticks elapsed off the timestamps.
- **Per-agent hang watchdog (item 2).** `trident/orchestrator.ts` gains a
  `NO_ADVANCE_HANG_MS` (25 min) fail-fast reap: a non-terminal run with an
  in-flight dispatch whose `last_advanced_at` hasn't moved is treated as a
  suspected agent hang → `failed` with a named reason, checked BEFORE orphan
  recovery so a wedged orphan is reaped (not redispatched). A healthy build
  re-stamps `last_advanced_at` on every checkpoint, so it never trips. (25 min,
  not 15 — the only long no-checkpoint window is a single Forge/fix `agent()`
  step, which a large build can legitimately hold 15–20 min; 25 clears that while
  still catching the 30+ min silent wedge far faster than the 2h ceiling. Codex
  review [P1].) The 2h
  `max_inflight_ms` ceiling stays as a defense-in-depth backstop. The reaped
  `failed` transition flows through the existing `on_terminal` hook → terminal
  notification + board reconcile (item back to `upcoming`, fork glyph dark). Only
  the OUTER detector ships — the deeper per-`agent()` inactivity guard isn't
  cleanly reachable from the Workflow `.mjs` without destabilizing #173's routing
  (there's no exposed token-activity stream to the script), so it's deferred.
- **X cancels the linked run (item 3).** `gateway/http/work-board-surface.ts`
  `DELETE` takes an optional `trident_runs` accessor; if the item names a
  non-terminal `linked_run_id` it stops the run (`phase='stopped'`, the existing
  `/code stop` path) BEFORE deleting the card, so a delete can't orphan a running
  build. The detached workflow keeps running to completion in the background but
  produces no effect (terminal runs are never harvested → never merged/delivered).
- **Confirm dialog before X (item 4).** The Plan tab shows a lightweight confirm
  dialog before any `DELETE` fires — "Cancel this build and remove it?" for a
  running/linked item, the lighter "Remove this item?" for an idle one.

**Managed-doc note.** `docs/SYSTEM-OVERVIEW.md` (a Managed doc the orchestrator
syncs on deploy) got a Work-Board section note covering the progress display,
hang watchdog, and X-cancel; flag for the deploy-time sync.

**Tests.** `trident/run-progress.test.ts` (phase/checkpoint→label, stall,
cross-project guard); `orchestrator.test.ts` hang-watchdog cases (in-flight +
stale-orphan reap); `work-board-surface.test.ts` GET-enriches + DELETE-cancels
(+ terminal/unbound no-cancel); `work-board-client.test.ts` `parseRunProgress`;
`work-board-tab.test.tsx` sub-label render, stalled/merged labels, confirm-copy,
and the delete round-trip updated to click through the confirm. tsc clean
(root + chat-react), full relevant suite green.

## 2026-07-02 — Fable-orchestrator model routing in trident's inner workflow

**Why.** owner-locked doctrine (SPEC § Fable-orchestrator, Decisions Log
2026-07-02): Fable 5 (max reasoning) is the ORCHESTRATOR — it does the high-value
thinking (planning, decomposition, verdict synthesis); Opus/Sonnet are
SUBORDINATE EXECUTORS carrying out Fable's specs. There is NO "escalate to Opus".
Before this change every `agent()` in `trident/inner-workflow.mjs` inherited the
launcher-default `opus` and the Ralph planner was FUSED into `forge:build`. No
feature flags — this is the default.

**What shipped.**

- **`FABLE_MODEL = 'claude-fable-5'`** added to `runtime/models.ts` (the single
  source of truth; env override `NEUTRON_FABLE_MODEL`). Verified routable
  2026-07-02 (P-F0 smoke: a workflow `agent({model:'claude-fable-5',
  effort:'max'})` returns cleanly; `workflowProgress.model === 'claude-fable-5'`).

- **Split the fused planner out** (`inner-workflow.mjs`). A dedicated
  `plan:fable` orchestrator `agent()` (Fable, effort `max`) now runs once per
  Ralph iteration: it diffs SPEC.md vs the code, regenerates the
  IMPLEMENTATION_PLAN.md body, picks the single top task, and emits a structured
  EXECUTION SPEC (target files + acceptance criterion + test plan) plus a
  `[mechanical]|[reasoning]` complexity tag (`PLAN_SCHEMA`). `forge:build` is now
  a pure EXECUTOR that implements that one task from the spec and persists the
  plan into its worktree (the planner is read-only — a workflow's agents have
  separate cwds, so a base-branch write would never reach the PR).

- **Per-role `label → {model, effort}` map** (`ROLE_MODEL` + `modelForTag` +
  `routeModel` + `withModel`) threaded into every `agent()` opts: `plan:fable` +
  `argus:synthesis` → Fable; `forge:build`/`forge:fix-round-N` → Sonnet for
  `[mechanical]` / Opus for `[reasoning]` (bias to Opus when the tag is
  missing/ambiguous — the unknown-label default is an Opus executor, never
  Fable); `argus:claude`/`argus:adversarial` → Opus; `argus:codex` → unchanged
  (codex runtime); `checkpoint:*`/`terminal-result`/`cleanup:worktree` → fast
  (Haiku). The model IDS are resolved from `runtime/models.ts` in the launcher
  (`buildWorkflowArgs`) and threaded via `args.models` — the CC Dynamic Workflow
  script has no module resolution, so it can't import the registry and must NOT
  hard-pin an id literal.

- **Observability.** Every spawn logs `trident.agent label=<x> model=<y>
  effort=<z>` (incl. `model=codex-runtime` for the codex peer) so a run is
  tally-able: "N agents, M on Fable, K on Opus, J on Sonnet, C on Codex".

- **Test guards rewritten** (`legacy-fixes.test.ts` FIX 8 + `inner-workflow.test.ts`
  ralph-note): the 2026-06-13 export-control guard (`src` must never contain
  "fable") is REVERSED — replaced by positive assertions of the intended routing
  (plan:fable + argus:synthesis → `MODELS.fable`; forge:* by tag; argus reviewers
  → `MODELS.opus`; unknown → Opus default) + a no-hard-pinned-literal guard
  (`claude-fable-5`/`claude-opus-4-8`/`claude-sonnet-4-6` absent from the .mjs).

**Verification.** P-F0 smoke (fable routes end-to-end) + a real-substrate routing
probe exercising the byte-identical routing map across all 9 roles; the
authoritative harness dispatch record (`workflowProgress[].model`) confirmed:
plan:fable→claude-fable-5, forge[mechanical]→claude-sonnet-4-6,
forge[reasoning]→claude-opus-4-8, argus:claude/adversarial→claude-opus-4-8,
argus:synthesis→claude-fable-5, checkpoint/terminal/cleanup→claude-haiku-4-5.
Tally: Fable×2, Opus×3, Sonnet×1, Haiku×3. tsc clean; 336 trident tests green.
A full end-to-end Forge/Argus build was NOT run from the fleet session (the
`Workflow` tool inherits the session cwd, so `isolation:'worktree'` would branch
neutron, not an external scratch repo); the outer loop exercises it on deploy.

**Note.** `docs/SYSTEM-OVERVIEW.md` in the Managed repo needs a model-routing
update for the trident section — cannot be edited from here; the orchestrator
syncs it on deploy. Auto-mode (#104) is OUT OF SCOPE (separate).

## 2026-07-01 — Documents tab renders `.html` docs as static styled HTML/CSS pages

**Why.** The owner's M1 live test: saving/opening an `.html` doc errored with
`invalid_extension: path must end with .md or .markdown (got 'timer.html')`, and
even once accepted the Documents tab had no way to render it. The owner's revised
(deliberately small) scope: render HTML/CSS statically; complex interactive JS
apps belong in a separate app launcher, NOT the doc viewer. No feature flags —
shipped as the default.

**What shipped.**

- **Docs store/API accepts `.html`/`.htm` end-to-end.** `gateway/http/doc-store.ts`
  gains `HTML_EXTENSIONS` + `DOC_EXTENSIONS` (= markdown ∪ html) + `isDocLeaf`, the
  single allowlist behind the `invalid_extension` gate. Both the tree walker
  (surfaces `.html` leaves) and `validateRelativePath({ requireMd })` (read/list/
  open/write) now use `isDocLeaf`; the error message is derived from the allowlist.
  The duplicate history/comments/diff gate in `gateway/http/app-docs-surface.ts`
  (`assertHistoryPath`) shares `isDocLeaf` so an opened `.html` doc can also load
  its history/comments. `MARKDOWN_EXTENSIONS`/`isMarkdownLeaf` are retained
  (markdown-specific callers unaffected); `doc-search/walk.ts` keeps its own
  markdown-only constant (HTML is not FTS-indexed as markdown — out of scope).
- **Documents renderer renders `.html` as a static styled page.** New
  `landing/chat-react/HtmlDoc.tsx`: `isHtmlDoc(path)` selects the branch and
  `sanitizeHtmlDoc(raw)` parses the doc via `DOMParser` and strips every
  script-execution vector — `<script>` (incl. SVG script),
  `<iframe>`/`<object>`/`<embed>`/`<base>`/`<meta>`/`<link>`/`<frame*>`/`<applet>`,
  all `on*` handler attributes, and `javascript:`/`vbscript:`/`data:text/html`
  URLs — while PRESERVING HTML structure, `<style>` blocks (head + body), and
  inline `style`. The sanitized document's **live `<documentElement>` nodes are
  adopted** into a **Shadow-DOM island** (not an `innerHTML` string — fragment
  parsing strips `<html>`/`<body>`, which would drop `body{…}`/`html{…}` CSS +
  body attributes; Codex P2), so document-level CSS renders correctly and the
  doc's styles stay scoped to their subtree. `importNode`/`appendChild` never
  run the (already-removed) scripts. `DocumentsTab`
  Rendered view branches on `isHtmlDoc(file.path)`; `.md` renders via the existing
  Markdown path unchanged, and Source/Edit still show/edit raw text of either.
  **Design note:** chose a `DOMParser` DOM-walk sanitizer over DOMPurify because
  DOMPurify's document-reconstruction path does not run faithfully under the
  happy-dom test env (verified: it kept `<script>` and dropped `<style>`), which
  would leave the security path untested; the DOM-walk is faithful in both the
  browser and CI. Threat model is trusted single-owner content.

**Tests.** `landing/chat-react/__tests__/html-doc.test.tsx` (sanitize keeps
structure+CSS, strips scripts/handlers/js-URLs incl. an obfuscated `java\tscript:`;
component mounts into a shadow root and no doc script executes) + `.html`/`.htm`
read/list/write round-trip and `.txt`-still-rejected in
`gateway/__tests__/app-docs-surface.test.ts`. tsc (root + gateway +
`landing/chat-react`) clean; leak-gate silent; fresh `NEUTRON_HOME=/tmp/wfi`
boot on :7874 serves the bundle with the `HtmlDoc` renderer and the docs routes
wired.
## 2026-07-02 — Chat typing dots persist for the WHOLE processing window (incl. background builds)

**Why.** The owner's live-test 2026-07-01: he asked the agent to build a meditation-timer
app. Chat showed the cold-start ack ("⏳ Waking up, one moment…") then NOTHING,
while the Plan tab flashed its active-work dot — so he had no signal the agent was
still working. The typing indicator vanished the instant the ack turn settled even
though the real (long/background) build kept running. No feature flags.

**Root cause.** The chat `TypingIndicator` (`landing/chat-react/ChatApp.tsx`) rendered
ONLY on `vm.awaitingFirstToken` (`= awaitingReply && no live stream`). `awaitingReply`
clears on the first token / `agent_message` / `agent_typing end` — i.e. when the ack
turn settles — so the dots disappeared while a dispatched build continued. The
build's progress WAS surfaced to the client (the `work_board_changed` frame that
drives the Plan-tab flashing dot) but that frame was handled out-of-band of the chat
view model, so the chat never reacted to it.

**What shipped.** The typing indicator now uses the standard animated dots (unchanged
appearance) and stays visible for the full processing window: `awaitingFirstToken`
**OR** `hasActiveWork`.

- **New `ChatViewModel.hasActiveWork`** (`landing/chat-react/controller.ts`) — true
  while the active project's Work Board has an `in_progress` item. Derived from a
  dedicated `activeWorkBoardItems` cache that ONLY frames pertaining to the active
  project update (matching `project_id`, or absent → "this project"); a sibling
  project's board on the per-user app-ws topic is ignored so it can't stop the active
  dots (Codex P2). `lastWorkBoard` stays the raw last-frame cache for `WorkBoardTab`
  replay; the active cache clears on project switch.
- **`work_board_changed` now also `publish()`es the chat vm** (was board-tab-only), so
  a build starting/finishing flips the dots on/off. Everything else about the board
  stays out-of-band of chat state.
- **The gate** (`ChatApp.tsx`) is now `vm.awaitingFirstToken || vm.hasActiveWork`.
- **No false-positive at load:** the server pushes `work_board_changed` only on a
  mutation, never on connect, so `lastWorkBoard` is null until work actually happens
  this session — a lingering item from a prior session can't spin the dots on open. A
  trivial quick turn (no board mutation) behaves exactly as before. Dots stop the
  moment the item flips to `done`.

**Tests.** `controller.test.ts` — `hasActiveWork` true on `in_progress`, clears on
`done`, ignores a foreign-project board (updated the "does NOT touch chat vm" test:
board frames now republish so `hasActiveWork` can update; chat MESSAGES stay
untouched). `component.test.tsx` — full render E2E: dots stay through a background
build after the ack `agent_message`, then stop when the board item completes.

**SYSTEM-OVERVIEW.md:** none (behavior fix reusing the existing `work_board_changed`
frame — no new surface or client subscription).

## 2026-07-02 — Connect Codex is a GLOBAL admin credential (was per-project) + project override

**Why.** #167 (Part B) put the Connect-Codex UI only in the per-PROJECT Settings
tab, calling `.connect(projectId, …)`, which made it read as a project-level
setting. But Codex is the **trident cross-model reviewer credential, and trident
runs across ANY project** — so it must be a **GLOBAL** setting in the General
admin UI, not per-project (the owner, 2026-07-02: "this is not a project-level
setting… it should be a global setting, in the general admin UI. There can be a
project-level override if necessary"). No feature flags.

**What shipped.**

- **Global connect is now the PRIMARY surface.** A new account-wide route
  `GET/POST/DELETE /api/app/codex-auth` (`gateway/http/codex-credential-surface.ts`)
  connects Codex at `scope='global'`. The **General → Admin** tab
  (`landing/chat-react/IntegrationsTab.tsx`) renders a "Codex cross-model review"
  section — paste `~/.codex/auth.json`, connection status, disconnect — alongside
  the other global integrations. `codex-credential-client.ts` gained
  `statusGlobal()` / `connectGlobal()` / `disconnectGlobal()`.
- **Store defaults to GLOBAL.** `CodexCredentialService.connect()` now defaults to
  `scope='global'` (materializes to the owner CODEX_HOME `<owner_home>/.codex`);
  validation unchanged (subscription-only, metered `OPENAI_API_KEY` rejected).
- **Per-project OVERRIDE kept, for the edge case.** The per-project Settings
  section stays but is relabelled "Codex review — project override" (clearly
  optional; the primary connect lives in General → Admin). It POSTs the existing
  `/api/app/projects/<id>/codex-auth` route, which now stores `scope='project'`
  under the REAL project id and materializes to a nested
  `codexProjectHome()` = `<owner_home>/.codex/projects/<id>` dir.
- **Resolution honors project → global → unset.** New
  `CodexCredentialService.resolveActiveCodexHome(owner, project_id)` resolves the
  effective CODEX_HOME via the #149 store resolver (project override wins, else
  global, else `null`) with self-healing re-materialization. `status()` reports the
  resolving `scope`. The trident loop threads the GLOBAL CODEX_HOME (the
  trident-wide default); the `codex_connect`/`codex_status` agent tools stay
  global-scoped (the tool context carries only the owner boundary).

**Spec-conformance (5-line diff).** SPEC§ codex-review global cred / CURRENT #167
per-project only / GAP: not global, wrong default / THIS PR: global connect in
General admin + project-override + resolver project→global / OUT-OF-SCOPE: none.

**Files.** `trident/codex-auth.ts` (`codexProjectHome` helper),
`trident/codex-credential.ts` (scope-aware connect/status/disconnect +
`resolveActiveCodexHome`), `gateway/http/codex-credential-surface.ts` (global
route + project override), `gateway/http/compose.ts` (comment),
`open/composer.ts` (comment), `landing/chat-react/IntegrationsTab.tsx` (global
UI), `landing/chat-react/SettingsTab.tsx` (override relabel),
`landing/chat-react/codex-credential-client.ts` (global methods + `scope`). Tests:
service override/resolver, surface global+override routes, client global methods,
IntegrationsTab global-connect render. tsc clean (trident/root/chat-react),
leak-gate SILENT; live boot confirms both routes mounted + auth-gated.

**Verify.** Real-component integration tests exercise connect(global) →
materialize → `codex-review.sh` exit-0 CONNECTED; override stored under the
project home; `resolveActiveCodexHome` project→global→unset; override wins;
removing an override falls back to global; `ensureMaterialized` ignores overrides.
Live server (`NEUTRON_HOME=/tmp/wfcx PORT=7871 bun run open/server.ts`) boots
clean and both `/api/app/codex-auth` + `/api/app/projects/<id>/codex-auth` return
401 (mounted + auth-gated), not 404.

**Codex cross-model review — addressed.**
- **[P1] review resolves through the store resolver (not a static path).** The
  trident orchestrator gained `resolve_codex_home?: (run) => string | null`
  (preferred over the static `codex_home`); the composer wires it to
  `CodexCredentialService.resolveActiveCodexHome(run.project_slug)` so the inner
  review's CODEX_HOME is resolved per-run through the #149 resolver (project
  override → global → unset, self-healing) rather than a raw dir. **Known
  constraint:** trident runs are instance-scoped by `project_slug` (no per-project
  id on a run — see `trident/store.ts` `TridentRun`), so a run resolves the GLOBAL
  default; a per-project override cannot select a different cred *per trident run*
  until runs carry a project id (a larger, separate change). The override
  mechanism itself (store/resolver/status/UI) is fully implemented + tested.
- **[P2] a stale/expired project override is always removable.** `status()` now
  returns `override_present` (a project-scope row exists, even expired — the
  resolver skips expired rows so `scope` would report the global fallback). The
  Settings override section shows "Remove override" whenever `override_present`,
  so an expired override that masks itself behind the global default can still be
  cleaned up.
- **[P2] Settings reflects the EFFECTIVE status after save/remove.** Both
  `connectCodex` and `disconnectCodex` now re-fetch the per-project status after
  their write (the POST/DELETE replies omit `override_present` / the global
  fallback), so the "Remove override" affordance appears right after saving and a
  removed override immediately shows the global fallback (not a hard
  "not connected").

**DECISION FOR THE OWNER — per-project override does NOT reach a trident RUN (by
design of trident, not this PR).** Trident runs are **instance-scoped by
`project_slug`** (the owner boundary) and carry **no per-project credential id**
(`trident/store.ts` `TridentRun`; runs are created with `project_slug` = owner,
`slug` = task slug). So `resolveActiveCodexHome(run.project_slug)` resolves the
GLOBAL default, and a per-project codex override — whose only consumer is the
instance-scoped trident reviewer — cannot change which credential a given trident
run uses. The override is fully built + tested at the store/resolver/status/UI
layer (it honors project → global → unset wherever a real project id is supplied),
the Settings copy is explicit that the trident review currently uses the global
credential, and the override takes effect for trident once builds are
project-scoped (a separate change: thread the originating project id onto the run
+ resolve with it). The owner asked for a project override "if necessary" — flagging
that for trident specifically it is a stored preference, not yet a per-run switch.
Codex cross-model review re-raised this as the remaining item; it is an
acknowledged trident-architecture constraint, not a defect in this diff.
## 2026-07-02 — SEV1 chat project-switch: fresh per-conversation assistant-ui runtime (seamless switch, no error card, no flicker)

**Why.** M1 top-priority (the owner, frustrated): switching projects (or cold-loading
one) frequently tripped the #162 error boundary ("This conversation hit a snag /
Try again"), and "Try again" fixed it — a transient render race, not a real
failure. The owner: "an annoying useless error message is just as bad as a black
screen. fix the underlying problem. This should be seamless." Same root also
caused the tab-bar / input-box flicker on switch. No feature flags. The #162
keyed error boundary was NOT the fix — it only *caught* the throw; the goal was
to eliminate the underlying race so it essentially never fires.

**Root cause (verified).** The assistant-ui message primitives resolve a part by
INDEX into the runtime's live message list (`@assistant-ui/react`
`useExternalStoreRuntime`; `useClientLookup` throws `Index N out of bounds
(length: 0)`). The runtime was a SINGLE stable instance created once at the root
(`main.tsx` `useNeutronChat` → `AssistantRuntimeProvider`). On a project switch,
`controller.setProject` (`landing/chat-react/controller.ts:439`) sets `this.msgs
= []` and publishes an EMPTY list; the ExternalStore adapter handed that emptied
list to the SAME retained runtime while a stale `MessagePart` from the outgoing
project still indexed a position into it → throw mid-render → #162 boundary
trips. #162's keyed *render subtree* remount reduced but did not eliminate the
one-frame race because the RUNTIME itself was never reset per conversation — the
shared runtime shrank in place with old subscribers still attached.

**What shipped.**

- **Per-conversation runtime (root-cause fix).** Split
  `landing/chat-react/useNeutronChat.ts` into `useNeutronChatVm` (vm mirror +
  controller lifecycle — stable across the session, keyed on the controller) and
  `useChatRuntime` (builds the `ExternalStoreRuntime` from the current vm). A new
  `ConversationRuntimeHost` in `ChatApp.tsx` calls `useChatRuntime` and is mounted
  with `key={convId}` (`conversationIdOf(projectId)`), so every conversation gets
  its OWN runtime. On a switch the outgoing runtime is discarded WHOLE — never
  shrunk in place — and the incoming one starts from the already-scoped (empty →
  hydrating) list, so no part ever indexes a stale position. The provider moved
  OFF the root (`main.tsx` now renders `ProjectShell` directly with a
  `useNeutronChatVm` vm) and DOWN to wrap only the chat surface (thread +
  composer), so the TabBar + project rail above it stay mounted.
- **Atomic transition.** A genuinely empty project renders assistant-ui's
  `ThreadPrimitive.Empty` ("Send a message to begin."), never an index into `[]`.
- **Tab-bar flicker fix.** `ProjectShell.tsx` tab-resolution effect no longer
  collapses `tabs` to `[CHAT_TAB]` on every switch before re-fetching (a visible
  two-step flicker). It reconciles IN PLACE: keep the current descriptors mounted
  until the new set resolves, mark the scope in-flight (`tabsScope = null`, which
  the doc-link resolver keys off), and swap in one step — the always-present Chat
  tab (stable key) never remounts. While the fetch is in flight the still-mounted
  descriptors belong to the OUTGOING scope, so every non-Chat tab is DISABLED and
  the active tab is clamped to Chat (Codex P2): a stale button can't be clicked to
  mount a wrong-scope `TabContent` (e.g. the old project's Core iframe) mid-switch.
- **Safety net kept.** The #162 `ChatErrorBoundary` stays as a last-resort catch
  (not removed), but now essentially never fires on a normal switch/load.

**Tests.** `landing/chat-react/__tests__/chat-rail-stability.test.tsx` extended:
the laden-General → empty-project switch now also asserts the boundary card
("This conversation hit a snag") is ABSENT — proving the RUNTIME RESET prevented
the throw, not the boundary catching it. Added a rapid-switch stress test
(General → alpha → beta → empty → General → … 8 hops) asserting no index throw,
no boundary, clean empty state, and no stale-content bleed. Harnesses mirror
production wiring (no external `AssistantRuntimeProvider`; `ChatApp` self-owns the
runtime). Full `landing/chat-react` suite: 231 pass / 0 fail; `tsc -p
landing/chat-react/tsconfig.json` clean; browser bundle + live iso server
(`/chat`, lazy `/chat-react.js`) build and serve cleanly.

## 2026-07-01 — trident-parity Part B: Connect Codex (subscription auth) + agent auto-invokes trident

**Why.** Part A (#165) wired the trident cross-model reviewer (`codex-review.sh`
reads a per-owner `CODEX_HOME/auth.json`) but nothing let the owner CONNECT that
credential, and the live agent still built everything inline (no `/code`
self-routing). SPEC.md Decisions Log 2026-07-01 "Codex cross-model review
REQUIRED". No feature flags.

**What shipped.**

- **M-2 — Connect Codex (subscription auth via the admin panel).**
  `trident/codex-auth.ts` validates a pasted `~/.codex/auth.json`: SUBSCRIPTION
  auth (`tokens.access_token` + `tokens.refresh_token`) is accepted + normalized;
  a metered `OPENAI_API_KEY` (auth_mode=apikey) or a bare `sk-…` paste is REJECTED
  (never the metered path). `trident/codex-credential.ts:CodexCredentialService`
  stores it encrypted in the #149 `project_credentials` store (service `codex`,
  global scope) and MATERIALIZES it to the per-owner CODEX_HOME
  (`resolveCodexHome({ owner_home })` = `<owner_home>/.codex/auth.json`, 0600) —
  the SAME path the trident loop threads into the inner workflow
  (`build-core-modules.ts` now reads `trident.codex_home` from the composer, so
  the loop + the store can never disagree; falls back to `NEUTRON_CODEX_HOME`).
  Status = connected / expired (access-token JWT `exp` past) / not_connected.
  Surfaces: admin-panel HTTP `gateway/http/codex-credential-surface.ts`
  (`/api/app/projects/<id>/codex-auth`), the SettingsTab "Codex cross-model
  review" section (`landing/chat-react/SettingsTab.tsx` +
  `codex-credential-client.ts`), and agent-native `codex_connect` / `codex_status`
  tools (`trident/codex-credential-tool.ts`). A boot-time `ensureMaterialized`
  self-heals the on-disk file from the stored credential.
- **M-K — the agent auto-invokes trident for complex builds.** A build-routing
  complexity heuristic in the operating-doctrine fragment
  (`gateway/wiring/operating-doctrine.ts:BUILD_ROUTING_DOCTRINE`,
  spliced every turn) + the `work_board_dispatch_build` tool description tell the
  live agent to self-route: SIMPLE → inline (Write/Edit); COMPLEX/multi-file/
  needs-review → `work_board_add` + `work_board_dispatch_build`, telling the owner
  why. The tool was already registered on the live agent's surface (verified by
  the prod-boot wiring test); no `/code` command, no feature flag.

**Tests.** `trident/codex-auth.test.ts`, `trident/codex-credential.test.ts` (incl.
connect → `codex-review.sh` sees exit-0 CONNECTED with a mock codex),
`trident/codex-credential-tool.test.ts`, `gateway/http/codex-credential-surface.test.ts`,
`landing/chat-react/__tests__/codex-credential-client.test.ts`, doctrine +
prod-boot-wiring assertions. tsc (root+trident+landing) clean, leak-gate silent.

## 2026-07-01 — SEV1 M1: gate projects on import completion + honest no-context projects + doc frontmatter strip

**Why.** The owner's M1 live test hit four related onboarding defects (SPEC.md
Decisions Log 2026-07-01 "STOP M2" blockers a+b): (a) onboarding created projects
from thin chat answers WHILE the ChatGPT/Claude history import was still uploading
(e.g. at 31%), so projects were born from the wrong signal; (b) a no-context
project opened with a fabricated "here's where X stands ... active, P2" summary;
(c) its seeded `STATUS.md` even scheduled phantom "Deepen + analyze from imported
context" OVERNIGHT work (`autonomous_overnight_enabled:true`) for a project with
zero data; (d) the Documents tab rendered a doc's YAML frontmatter as a raw bold
blob. Single path, no feature flags (the owner approved).

**What shipped.**

- **Import-gate on project creation (fix 1).** `probeInFlightImport`
  (`open/composer.ts`) now also detects an in-progress **chunked upload**
  (`upload_sessions.status='uploading'`, non-expired), not just a live
  `import_jobs` row — closing the window where a turn that settled the last
  required field mid-upload finalized BEFORE the import job existed. The post-turn
  extractor (`onboarding/interview/post-turn-extractor.ts`) drops the
  project-discovery fields (`primary_projects`, `non_work_interests`,
  `dropped_projects`) from its `phase_state` write while an import is in flight
  (import-independent `user_first_name`/`agent_personality` still land). A new
  per-turn `<import_in_flight>` preamble fragment
  (`onboarding/interview/onboarding-preamble.ts` `buildImportInFlightSteerFragment`)
  steers the live agent to skip project questions during the upload.
  `finalizeImportOnboardingIfReady` also blocks `import_upload_pending`.
- **Honest no-context opening (fix 2).** The materializer computes `has_context`
  (matched slices OR `hasRealProjectContext`); `emitProjectOpenings`
  (`gateway/wiring/build-onboarding-finalize.ts`) routes a no-context
  WORK project to `buildNoContextProjectOpening` ("I don't have any context on X
  yet - tell me a bit about it, and what do you want to work on first?") instead
  of the fabricated status. Projects WITH context (and thin hobbies, via the
  kickoff's engaging questions) are unchanged.
- **Minimal no-context STATUS.md (fix 3).** `renderMinimalStatusMd`
  (`onboarding/wow-moment/project-materializer.ts`) writes clean frontmatter
  (`one_liner:""`) + one line "Created during onboarding - no context yet." with
  NO overnight opt-in, NO `## Autonomous Overnight Work` section, NO seeded task,
  and NO `docs/overnight/seed-context.md`. Context-bearing projects keep the full
  STATUS + overnight machinery.
- **Documents frontmatter strip (fix 4).** `Markdown.tsx` gains
  `stripLeadingFrontmatter` + a `stripFrontmatter` prop the Documents viewer
  (`DocumentsTab.tsx`, rendered view) passes; the leading `---\n…\n---` fence is
  hidden from the rendered body. Chat + the Source view are untouched; a bare
  `---` rule is never stripped.

**Tests.** Extractor import-gate (suppress project fields while import in flight,
persist personality; gate off with no import); minimal-vs-full STATUS.md +
`has_context`; honest-vs-real opening routing in finalize; `buildNoContext
ProjectOpening` copy; `stripLeadingFrontmatter` (fence removed, body kept, bare
rule + no-frontmatter untouched, CRLF). tsc clean, leak-gate silent, server boots
clean on a fresh QUIET install (port 7869).
## 2026-07-01 — Chat turn timeout is ACTIVITY-BASED; freezes auto-retry + get a Retry button

**Why.** The owner's live-test 2026-07-01 (frustrated): a chat turn running a long-but-active
build hard-failed at a FIXED 180s wall clock **while the agent was still working**
(`turn_failed elapsed_ms=180009 err=persistent-repl: turn timeout`), then showed a
dead-end "your AI connection may need attention in settings" message — misdiagnosing
a slow turn as a credential problem. "If the agent is still working why arbitrarily
timeout at 180s? Be smarter — look for activity, if it's not frozen keep waiting."

**What shipped (no feature flags).**
- **Inactivity watchdog replaces the fixed per-turn wall clock.**
  `runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts` no longer
  arms `setTimeout(perTurnTimeoutMs)`; it runs an interval watchdog that abandons a
  turn ONLY after `turn_timeout_ms` with NO PTY activity. `session.lastDataAt`
  advances on every byte the `claude` child writes (spinner ticks, streamed tokens,
  tool output — the `onData` handler), so an actively-working turn keeps resetting
  the idle clock and runs as long as it needs; only a genuinely frozen turn trips.
  New `DEFAULT_TURN_INACTIVITY_MS` (90s) + `DEFAULT_TURN_ABSOLUTE_CEILING_MS` (45min
  hard backstop). The liveness keepalive pushes `status` but does NOT touch
  `lastDataAt`, so an alive-but-frozen child is still detected as frozen.
- **`AgentSpec.turn_timeout_ms` repurposed** from "wall-clock budget" to "inactivity
  window"; new additive `AgentSpec.turn_absolute_ceiling_ms` (`runtime/substrate.ts`).
  The composer (`gateway/wiring/build-live-agent-turn.ts`) sends a snappy
  90s idle window for warm turns and a larger 180s window for cold/onboarding turns;
  its own AbortController is now a pure 45min absolute-ceiling backstop that covers
  the cold-SPAWN phase (which runs before the substrate watchdog starts) — the cold
  path's generous window folded into the same scheme, `COLD_TURN_TIMEOUT_MS` deleted.
- **Auto-retry once + honest message + one-click Retry.** On a genuine freeze the
  composer auto-retries the turn once, silently (the substrate poisons+respawns the
  warm REPL, so the retry lands clean). If the retry also freezes, the user gets
  `TIMEOUT_BODY` ("took too long … tap Retry, or just send it again") + a persisted
  Retry button (`RETRY_TURN_VALUE`), `allow_freeform` open — NEVER the misleading
  credential text. A Retry tap re-runs on the last real user message for the topic
  (`lastUserText` in-process map; VALUE_BYTE_CAP is 37 bytes so the message can't
  ride the button value). `isFreezeTimeout` distinguishes a freeze from a real
  credential/connection fault, which keeps its own actionable `FAILURE_BODY`.

**Tests.** `persistent-repl-substrate.test.ts` — activity resets keep an active turn
alive past the idle window; a frozen turn trips at the idle window; the absolute
ceiling bounds a livelocked-but-active turn. `build-live-agent-turn-timeout-retry.test.ts`
— freeze → auto-retry (success → no bubble); retry-also-freezes → TIMEOUT_BODY + Retry
button, not the connection text; non-freeze fault → FAILURE_BODY, no retry; Retry tap
recovers + re-runs the last message; seed freeze stays silent.
`build-live-agent-turn-onboarding-scope-timeout.test.ts` — updated to the new
inactivity/ceiling spec fields.

**Files.** `runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts`,
`runtime/substrate.ts`, `gateway/wiring/build-live-agent-turn.ts`,
`docs/SYSTEM-OVERVIEW.md`, + the three test files above.

## 2026-07-01 — Notes / second-brain core: REMOVED entirely

**Why.** The `notes` core (`cores/free/notes`, `@neutronai/notes`) was a
second-brain port — a per-project `notes.db` sidecar + eight `notes_*` MCP tools +
the `/note` chat command. It is made redundant by the second-brain→GBrain
rip-replace: **GBrain is now the SOLE per-owner memory store.** The notes core
was silently broken until #158 wired its tools; the owner directed "rip it out. we
dont need notes core" (SPEC.md Decisions Log 2026-07-01). No dual path, no flag,
no leftover.

**What shipped (clean deletion).**

- **Deleted the whole `cores/free/notes/` package** (source, tests, manifest,
  UI surfaces, the per-Core migration `0001_drawers_notes_kg.sql`) and the
  notes-only test `gateway/__tests__/notes-production-composer.test.ts`. Reverts
  the effect of #158.
- **Unwired from `gateway/cores/mount-open-cores.ts`:** the `@neutronai/notes`
  import (was `:75`), the `NotesStoreResolver` construction (was `:248-250`), the
  `notesResolver`/`notesDefaultProjectId` args into `buildCoresBackendFactories`
  (was `:289-290`), and `createNotesChatCommandFilter` from the
  `buildChainedChatCommandFilter([...])` chain (was `:332`). The `/note` chat
  command no longer exists.
- **`gateway/boot-helpers.ts`:** dropped the `notesResolver` + `notesDefaultProjectId`
  interface params + destructuring and the entire `notes:` backend factory from
  `buildCoresBackendFactories`.
- **Notes drawer-browser HTTP surface** (dead plumbing only the deleted test ever
  supplied): removed `NotesDrawerBrowserHandler` + `notesDrawerBrowser` from
  `gateway/http/compose.ts`, `notes_drawer_browser_surface` from
  `gateway/composition/input/cores-input.ts` + `gateway/composition.ts`.
- **Launcher seed:** dropped the 🧠 "Notes" tile from `DEFAULT_LAUNCHER_SEED` +
  `SLUG_DISPLAY_DEFAULTS` in `gateway/http/project-launcher-store.ts`; deleted the
  orphan placeholder route `app/app/projects/[id]/notes.tsx`.
- **Dependency:** removed `cores/free/notes` from root `package.json` workspaces
  and `@neutronai/notes` from `gateway/package.json`; regenerated `bun.lock`.
- **Tests:** decremented the discovered/installed core-count sets by 1 in
  `cores-composition.test.ts` (10→9 discovered / 8→7 installed incl. paid-staging;
  the neutron-open carve boots discovered=9 installed=6) and `cores-surface.test.ts`;
  swapped the notes fixtures in `cores-tool-dispatch.test.ts`,
  `launcher-production-composer.test.ts`, `app-tabs-surface.test.ts`,
  `app-launcher-surface.test.ts`, `project-launcher-seed.test.ts`,
  `tabs/__tests__/registry.test.ts`, and the `mount-open-cores` `/note` assertion
  to surviving cores (`reminders_core` / `calendar_core` / `tasks_core`).

**Migrations (safe).** The notes core's sole migration was a **per-Core** bundled
migration inside the package (applied to a per-Core namespace DB at install), NOT
a central `migrations/` entry — the central runner ledger (0001–0096) never
referenced it, so its snapshot/runner tests stay green. It is removed with the
package. On any already-deployed DB the old `notes.*` tables are harmless orphans
(nothing in the runtime reads them). No forward drop migration was added (cheapest,
safe — the task defaulted to leaving orphan tables).

**Verify.** `tsc --noEmit` clean; the four core/launcher composition suites pass
(29/29), the four surface/tab suites pass (55/55). Fresh QUIET install boot
(`NEUTRON_HOME=/tmp/wfnotesrm bun run open/server.ts`) logs **no `core=notes` line
at all** (gone from discovery, not install_ok/failed) and `project=dev
discovered=9 installed=6 failed=3` — discovered dropped by exactly 1; no `/note`
command registered; the GBrain memory path is unaffected.

## 2026-07-01 — Chat: fix one-line message bubble rendering ~2x tall

**Why.** The owner flagged (twice) that a single-line chat message bubble — e.g. the
one-word user message "Owner" — rendered at roughly double the height its text
needs, top/bottom heavy. #141 reduced `.car-bubble` vertical padding (8px→5px)
and `.car-md p` line-height (1.5→1.4) but did NOT fix it, proving padding was not
the (only) cause.

**Root cause.** The USER bubble renders its body as a bare `<p class="car-text">`
(`landing/chat-react/ChatApp.tsx` `TextPart`, role=user), but **no `.car-text`
CSS rule existed** anywhere in `landing/chat-react.html` — the only global reset
is `* { box-sizing: border-box }`. So that `<p>` inherited the UA default
`margin-block: 1em` (~16px top + 16px bottom), stacking on the 5px bubble padding
→ a one-line user bubble ~2x its text height. #141 only touched `.car-bubble` and
`.car-md p` (the AGENT path, whose paragraph margins are already zeroed by
`.car-md > :first-child/:last-child`), so it never reached the user `<p>` — which
is exactly why it missed the owner's user-message evidence.

**What shipped.**

- **`landing/chat-react.html`.** New `.car-text { margin: 0; line-height: 1.4; }`
  rule — zeroes the inherited UA `<p>` margin and matches the agent paragraph
  line-height so a single-line user message hugs its text (bubble height = 5px +
  one line + 5px).
- **`landing/chat-react/message-adapter.ts`.** New `normalizeBody()` strips the
  stray leading newlines + all trailing whitespace from a message body in
  `toThreadMessage` (the single display seam for both bubble types). Both paths
  preserve newlines (`white-space: pre-line` on the user `<p>`, `pre-wrap` on
  `.car-bubble`), so a stray trailing `\n` on a one-line message would otherwise
  render as an extra empty line. Deliberately narrow (Codex P2): leading
  horizontal whitespace is PRESERVED so a Markdown agent message opening with an
  indented code block (`"    npm test"`) still renders as code; INTERNAL blank
  lines (real multi-line messages) are untouched.

**Tests.** `landing/chat-react/__tests__/message-adapter.test.ts` — trailing/
leading-newline strip on user + agent bodies, whitespace-only → empty, and a
`normalizeBody` unit block asserting internal blank lines survive. tsc (leaf
`landing/chat-react/tsconfig.json`) clean; leak-gate silent. Verified on a fresh
quiet boot: the served `/chat` HTML carries the new `.car-text` rule and the
lazily-bundled `chat-react.js` compiles the normalization in.

## 2026-07-01 — Notes Core: wire the four S1 tools (drawer/search/traverse) — ISSUE #330

**Why.** The `notes` manifest declares eight MCP tools, but the install pipeline
only ever invoked `buildTools` (the legacy four: `notes_write/recall/list/link`).
The four Notes-Core-S1 tools (`notes_create_drawer`, `notes_drawer_list`,
`notes_search`, `notes_traverse`) were fully implemented in `buildNotesMcpTools`
against a real per-project `NotesStore` backend — but the barrel never exported a
`buildExtraTools`, so on EVERY owner install those four fell through to
`not_implemented` stubs and boot logged `tool_registration_failed core=notes
code=manifest_tool_unimplemented` four times. NOT vestigial: the store, FTS
search, and KG traverse all exist and are tested; only the install-time wiring
was missing.

**What shipped.**

- **`cores/free/notes/src/mcp-tools.ts`.** New `buildExtraTools(deps)` — a thin
  factory over the existing `buildNotesMcpTools`, mirroring the Research/Calendar
  Core split. `NotesExtraToolDeps` = `{ manifest, project_slug, audit, resolver }`.
- **`cores/free/notes/index.ts`.** Barrel now exports `buildExtraTools` +
  `NotesExtraToolDeps` so `registerCoreTools` discovers the second factory.
- **`gateway/boot-helpers.ts`.** The `notes` backend factory now returns
  `{ backend, resolver }` (was `{ backend }` only). `normalizeBackend` returns the
  object verbatim because `backend` is present, so BOTH the legacy backend
  (consumed by `buildTools`) and the resolver (consumed by `buildExtraTools`) land
  in the one `deps` bundle both factories receive. The four S1 tools take an
  explicit `project_id` per call, so cross-project scope is impossible by
  construction.
- **`cores/free/notes/__tests__/mcp-tools.test.ts`** (new). Asserts
  `buildExtraTools` returns all four handlers, and exercises create_drawer →
  drawer_list, FTS search, KG traverse over a user tunnel, and per-project
  isolation.

**Verified.** Fresh QUIET owner boot (`NEUTRON_HOME=/tmp/wfnotes`): the four
`tool_registration_failed core=notes` lines are GONE; `install_ok core=notes`
stands with all eight tools dispatchable. `discovered=10 installed=7 failed=3` is
unchanged — notes was always `install_ok` (its legacy four registered fine); the
fix eliminates the four per-tool registration failures WITHIN that install. The
remaining `failed=3` are the expected OAuth-not-connected calendar/email/workspace
Cores. The benign `tasks_core tasks_pick_next extra_tool_name_collision` warning
is untouched (buildTools wins; harmless — Tasks intentionally registers that tool
in both factories). tsc clean (notes + gateway), notes suite 66→72 tests green.

## 2026-07-01 — Archived projects: reversible archive via Settings/chat + global Admin restore

**Why.** Projects had soft-delete only (`deleted_at`, migration 0053) — hidden
from every surface with no user-facing way back. The M2 cutover needs a
reversible "put this away for now": the owner's 22 archived projects migrate as an
archive state that stays visible + restorable. This adds a first-class ARCHIVE
lifecycle distinct from delete (the owner Q3, M2 Decisions Log).

**What shipped.**

- **Migration 0095 (`archived_at`).** A nullable ISO-8601 column on the STRICT
  `projects` table (plain `ALTER TABLE ADD COLUMN`, mirroring 0093/0094).
  `NULL` = active (in the rail); set = archived. Orthogonal to `deleted_at` —
  the rail + the archived list both additionally require `deleted_at IS NULL`, so
  a soft-delete always wins. `migrations/expected-schema.txt` regenerated;
  `runner.test.ts` asserts the column lands.
- **Store (`gateway/projects/sqlite-store.ts`).** `list()` (the rail) and
  `readRow()` (settings GET/PATCH) now filter `archived_at IS NULL` alongside
  `deleted_at`. New methods `archive` / `restore` (idempotent; a probe restricted
  to `deleted_at IS NULL` so a deleted project is never archived/restored) +
  `listArchived` (the Admin restorable list, newest-archived-first, emoji
  resolved). Mirrored on `InMemoryProjectSettingsStore`.
- **HTTP (`gateway/http/app-projects-surface.ts`).** `POST
  /api/app/projects/<id>/archive`, `POST .../restore`, and `GET
  /api/app/projects/archived` — all app-ws-bearer-gated. Archive/restore fan a
  `projects_changed` (via the existing `onRailFieldChanged`) so connected rails
  update live; unknown/deleted id → 404. The `/archived` route is an exact path,
  so it can never collide with a project whose id is literally "archived".
- **Settings tab (`landing/chat-react/SettingsTab.tsx`).** An "Archive project"
  action in the Project section with a two-step confirm; on success the project
  leaves the rail and the section shows the archived notice.
- **Admin tab (`landing/chat-react/IntegrationsTab.tsx`).** A new "Archived
  projects" section listing archived projects with a per-row **Restore** button
  (POSTs `/restore`, drops the row, rail picks it back up live).
- **Chat / agent-native (`cores/free/agent-settings`).** New `archive_project` /
  `restore_project` tools (capability-gated, Telegram-confirmed, topic closed on
  archive) so "archive this project" / "restore the Foo project" work in chat.
  `findLiveByName` + `list_projects` now exclude archived rows; a new
  `findArchivedByName` resolves the restore target. System-prompt fragment +
  manifest + TOOL_NAMES updated (nine → eleven tools).

**Tests.** Store archive/restore/listArchived + idempotency + soft-delete guard;
HTTP archive→hide→list-archived→restore round-trip + 404 + method guards; agent
tool archive/restore + list exclusion + honest-failure; React Settings archive
flow + Admin restore/empty-state; migration snapshot + column assertion.

## 2026-07-01 — Project rail redesign: per-project emoji, activity-reorder, unread badge

**Why.** The left project rail (`landing/chat-react` + the mobile `app/` project
list) was a flat list of plain text buttons in a fixed order with no signal of
which project had new activity. The owner asked for a materially upgraded rail:
per-project emoji, most-recent-activity-first ordering (an active project pops to
the top), and a Telegram-style unread count badge — in BOTH the light + dark
themes from the #153 toggle, with NO feature flag.

**Framing.** ONE code path, theme-var-driven (no hardcoded colours), no flag.
Emoji + activity are real columns on the canonical `projects` table; unread is
computed HONESTLY from the existing chat-log read cursor (never a fabricated
badge).

**Schema (migrations 0093 + 0094).** Two nullable `TEXT` columns added to the
STRICT `projects` table via plain `ALTER TABLE ... ADD COLUMN` (mirrors 0088):
- `emoji` — the per-project rail glyph. NULL on legacy rows; the serve-time path
  resolves NULL to a deterministic default from the name, so the rail always
  shows a glyph. New rows persist a concrete default at create/materialize time.
- `last_activity_at` — ISO activity sort key; stamped at create (= created_at)
  and bumped to now on each message fan to the project's topic.
`migrations/runner.test.ts` applied-versions array + `expected-schema.txt`
snapshot regenerated.

**Default emoji (`gateway/projects/default-emoji.ts`, NEW).** Pure, deterministic
picker: a keyword table maps common project themes to a glyph (fitness→🏋️,
read→📚, code→💻, budget→💰, …); an un-keyworded name falls back to a stable
FNV-1a hash over a neutral palette. `resolveProjectEmoji(stored, name)` prefers an
explicit emoji, else the default. `normaliseEmojiInput` bounds + validates a
user-supplied emoji (short, non-ASCII). `GENERAL_EMOJI` (💬) for the General scope.

**Server.**
- `gateway/http/app-projects-surface.ts` — `ProjectSettings` gains `emoji`; the
  list rows gain `last_activity_at` + `unread_count` (new `ProjectListEntry`
  type); PATCH whitelist adds `emoji` with validation (`invalid_emoji`);
  `buildDefaultSettings` + the shared-item projection carry a default emoji.
- `gateway/projects/sqlite-store.ts` — `list()` orders by
  `COALESCE(last_activity_at, updated_at) DESC`, resolves emoji, and computes
  per-project `unread_count` = agent messages on the project topic
  (`app:<user>:<project>`) beyond the owner's highest READ receipt seq
  (`app_chat_messages` ⋈ `app_chat_receipts`; best-effort → 0). New
  `touchActivity(project_id)` stamps the activity key; emoji is written only when
  explicitly patched (so a name edit never freezes a resolved default).
- `open/composer.ts` — `readProjectRows()` (page bootstrap + `projects_changed`
  frame) now serializes `emoji` + `unread` + `last_activity_at`, ordered by
  activity; an agent reply on a PROJECT topic stamps `last_activity_at` and
  re-fans `projects_changed` so connected rails reorder + re-badge live.
- `channels/adapters/app-ws/envelope.ts` — `AppWsOutboundProjectsChanged` per-item
  shape extended with `emoji` / `unread` / `last_activity_at`.
- A settings PATCH that changes a RAIL-VISIBLE field (name or emoji) fans a fresh
  `projects_changed` via the surface's new `onRailFieldChanged` hook (bound to the
  composer's `emitProjectsChangedNow`), so the rail re-renders the glyph/label live
  with no reload — this also fixes the pre-existing "rename doesn't refresh the
  rail" staleness (Codex r1 P2).
- Materialize + create-project INSERTs (`onboarding/wow-moment/actions/
  03-project-shells.ts`, `gateway/wiring/project-create.ts`) stamp a
  default emoji + `last_activity_at`.

**Web client.** `config.ts` `ProjectTab` gains optional `emoji`/`unread`/
`last_activity_at`; `controller.ts` parses them off the frame (unread clamped ≥0).
`ChatApp.tsx` `TopicRail` redesigned: a shared `RailItem` (emoji "avatar" chip ·
label · unread pill); the ACTIVE project's badge is locally zeroed (you're viewing
it). `chat-react.html` rail CSS reworked — emoji chip, accent-lit active row,
bolder unread rows, count pill — entirely `var(--…)`-driven so it reskins with the
light/dark toggle. `SettingsTab.tsx` — the disabled emoji SEAM is now a real
editable control (PATCH `{ emoji }`, like the name rename).

**Mobile (`app/`).** Project list wired for parity: `ProjectListItem`/`Project`
carry `emoji` + `unread_count` + real `last_activity_ms` (parsed from
`last_activity_at`, replacing the fake now-stamp); `ProjectCard` renders the emoji
+ an unread badge; the list sorts most-recent-activity-first; the settings emoji
SEAM becomes an editable field (PATCH `{ emoji }`).

**Unread semantics.** Honest + best-effort. Unread only counts agent messages
beyond the read cursor; a caught-up project reads 0. The active project shows no
badge (viewing = read). No fake counts (the existing `chat-topics-surface`
no-fake-unread contract is untouched — this feature computes real values for the
rail only).

**Follow-up (noted, out of sprint scope).** Agent-native emoji edit — the
`agent-settings` Core exposes `rename_project` but not yet a `set_project_emoji`
tool. The HTTP PATCH surface + mobile client already accept `emoji`; adding a 10th
tool to that Core's manifest/capability-guard/test contract is deferred to a
follow-up so this sprint stays focused on the rail. Per-project unread on the
General scope is also not badged (onboarding lives there; low value).
## 2026-07-01 — Reminders: faithful cron cadence (the legacy harness parity)

**Why.** Neutron's reminder store only understood COARSE recurrence
(`weekly` / `monthly` / `occasional`, fixed +7d/+30d/+14d deltas). The M2
cutover must migrate ~66 real cron reminders (`0 9 * * *`, `0 9 7 2 *`,
`0 */6 * * *`, `0 14 1 1,4,7,10 *`, …) FAITHFULLY, which those coarse labels
cannot represent. This brings the store + tick loop to full 5-field cron
parity. The SMART / context-aware side (literal / smart-wrap / pattern-template
composition at fire time) was ALREADY at parity in `reminders/message-shape.ts`
+ `dispatcher.ts` — cron rows flow through that unchanged, so a migrated smart
reminder still composes a fresh context-aware message at fire.

**Framing — extend the ONE path, no flags, no dual system.** A reminder recurs
when EITHER cadence column is set; the tick loop's single `computeNextFire`
resolves the next instant from whichever is populated. No parallel scheduler,
no feature flag.

**What changed.**
- `cron/cron-standard.ts` (NEW) — standard 5-field crontab evaluator
  (`parseCron` / `isValidCron` / `nextCronFire`). Full grammar: `*`, single
  values, ranges, comma lists, and steps; month + weekday names; `0`/`7`
  both Sunday; Vixie day-of-month/day-of-week OR semantics. Wall-clock math is
  DST-correct and reuses `calendar.ts`'s `wallClockToEpoch` / `zonedParts`; a
  spring-forward gap time is skipped to the next valid instant. No `Date.now()`
  inside — the caller passes the reference instant (deterministic + testable).
  Kept SEPARATE from the systemd-`OnCalendar` parser (`calendar.ts`) because the
  two grammars differ in field order, wildcard spelling, and dom/dow combination
  (systemd ANDs; crontab ORs).
- `migrations/0093_reminders_recurrence_spec.sql` (NEW) — `ALTER TABLE reminders
  ADD COLUMN recurrence_spec TEXT` (nullable; forward-only; no CHECK — the
  write-side `isValidCron` gate is authoritative). Snapshot regenerated.
- `reminders/store.ts` — `Reminder.recurrence_spec`; `createRecurring` accepts a
  coarse `recurrence` label OR a `recurrence_spec` cron (exactly-one invariant
  enforced). New exported `isRecurring()` predicate; the claim/advance guards
  (`advanceRecurrence` / `revertRecurrenceAdvance`) now recognise a row as
  recurring when EITHER column is set.
- `reminders/tick.ts` — the two next-fire branches collapse into one
  `computeNextFire(reminder, now, tz)`: cron spec → DST-correct wall-clock
  instant strictly after now (via `@neutronai/cron`); coarse label → the
  existing fixed-delta (unchanged). New `time_zone` option (default host zone).
  A corrupt cron that can never compute fires once then retires so it can't
  wedge the tick loop.
- `cores/free/reminders/src/backend.ts` + `package.json` manifest —
  `reminders_create` accepts an optional `recurrence_spec` (validated via
  `isValidCron`; mutually exclusive with `recurrence`). `snooze` / `update`
  preserve a cron reminder's cadence (no silent degrade to one-shot). Existing
  coarse-label + one-shot callers unchanged (back-compat).

**Tests.** `cron/cron-standard.test.ts` (grammar, next-fire across daily /
hourly / weekday / monthly / annual / quarterly, Vixie OR, DST spring-forward +
fall-back + gap-skip); `reminders/tick.test.ts` (cron advances to the next
wall-clock occurrence, rolls to tomorrow when past, poison-cron retires);
`reminders/store.test.ts` (column round-trip + exactly-one invariant);
`cores/free/reminders/__tests__/tools.test.ts` (cron create, invalid-cron
reject, both-cadences reject, snooze/update cadence preservation). Full suite +
root `tsc` + leak-gate green.

## 2026-07-01 — Light/dark theme toggle for the web chat UI

**Why.** The web chat (`landing/chat-react`) shipped dark-only. The owner asked for a
light/dark toggle: default to the OS setting, allow an explicit override, persist
the choice, and make LIGHT mode an iMessage-on-iPhone look.

**Framing — a user preference, NOT a feature flag.** ONE stylesheet, themed via
CSS variables. No `NEUTRON_*` env, no `?client=`-style branch, no dual code path.
The whole UI reskins by flipping a single `data-theme` attribute on the document
root.

**What changed.**
- `landing/chat-react/theme.ts` (NEW) — the pure, DOM-free source of truth for
  resolution + persistence. `ThemePreference = 'light' | 'dark' | 'system'`;
  `resolveTheme(pref, systemPrefersLight)` (explicit override wins; `system` /
  unrecognized follows `prefers-color-scheme`); `read/writeStoredPreference`
  (localStorage key `neutron-theme`, safe when storage throws);
  `cyclePreference` (system → light → dark); `applyResolvedTheme` (writes
  `data-theme`). Default preference is `system`.
- `landing/chat-react/useTheme.ts` (NEW) — the React binding: initializes from
  storage, resolves against the live system signal, writes `data-theme` on the
  root, persists on change, and subscribes to `prefers-color-scheme` ONLY while
  the preference is `system`.
- `landing/chat-react/ThemeToggle.tsx` (NEW) — the top-right control. A single
  pill button that cycles the preference; the glyph shows the RESOLVED theme
  (☀/☾) with an "Auto" marker while following the OS.
- `landing/chat-react/ProjectShell.tsx` — wraps the tab bar + toggle in a new
  `.car-topbar` flex row so the toggle is pinned top-right of the content pane
  (owns the whole UI's theme, so it lives at the shell root).
- `landing/chat-react.html` — (1) the `<style>` block is now FULLY
  variable-driven: the dark `:root` set gained semantic vars for every
  previously-hardcoded color (hover/active tints, code bg, banners, import
  status, overlays, on-accent text, error/warn/info/success), and a new
  `:root[data-theme="light"]` set overrides them with the iMessage light palette
  (`#ffffff` surface, `#007aff` user bubble, `#e9e9eb` agent bubble, `#1c1c1e`
  text, iOS separators) — audited so there are NO dark-only leftovers; (2) a
  pre-paint inline `<script>` reads `neutron-theme` + `prefers-color-scheme` and
  sets `data-theme` (+ the `theme-color` meta) BEFORE the stylesheet paints, so
  a light user never sees a dark flash; (3) `.car-topbar` + `.car-theme-toggle`
  styles.
- `landing/chat-react/__tests__/theme.test.ts` (NEW) — the theme-resolution unit
  test (system vs. explicit override vs. persisted; storage fallbacks; cycle
  order). `theme-toggle.test.tsx` (NEW) — happy-dom wiring test: the toggle
  mounts, reflects the initial preference, and clicking it flips `data-theme` +
  persists to localStorage; a persisted override wins over the OS on mount.

**Verification.** `bunx tsc -p landing/chat-react/tsconfig.json` clean; full
`landing/chat-react/__tests__` suite green (193 + 16 new); the browser bundle
(`bun build landing/chat-react/main.tsx`) builds with the theme code wired in;
`scripts/ci/leak-gate.sh` SILENT; visual check of both themes off the real
stylesheet (light = iMessage, dark unchanged, toggle top-right, no leftovers).

## 2026-07-01 — Auto-navigate to the personal-URL claim page at onboarding-end (Managed overlay)

**Why.** The Managed personal-URL claim flow (control-plane `GET/POST /claim` →
rename → 302 to the owner's personal chat URL; neutron-managed personal-URL claim
flow, merged + deployed) serves the claim page but nothing sent the owner there
when onboarding finished. This is the paired Open-side trigger: when onboarding
completes, send the browser to the configured claim URL.

**Framing — Managed-overlay CONFIG, not a feature flag.** ONE code path
(redirect-if-URL-present). On a Managed install the env
`NEUTRON_POST_ONBOARDING_CLAIM_URL` points at the control-plane `/claim`, so the
client redirects there; on Open self-host the env is absent, the client sees
`undefined`, and the redirect no-ops (onboarding completes normally). No on/off
boolean, no dual path.

**What changed (NO flags, NO dual paths).**
- `channels/adapters/app-ws/envelope.ts` — new outbound frame
  `AppWsOutboundOnboardingCompleted` (`type: 'onboarding_completed'`, payload-free
  signal) added to the `AppWsOutbound` union. The redirect *target* is NOT on the
  frame — it lives in the client bootstrap config (a Managed-overlay concern).
- `gateway/wiring/build-onboarding-finalize.ts` — new optional dep
  `emitOnboardingCompleted?(user_id)`, called at the terminal `completed`
  transition (step 5b, right after `emitProjectsChanged`, before the closing
  message so a slow opening compose can't delay the redirect). The finalizer's
  idempotency gate guarantees it fires **exactly once** per owner.
- `open/composer.ts` — (1) `fanOnboardingCompleted(user_id)` fans the frame to the
  base topic AND every live per-project topic (same topology as
  `fanProjectsChanged`) and is wired into `buildOnboardingFinalize`; (2)
  `claimBootstrapScript()` injects `window.__neutron_post_onboarding_claim_url`
  into the served `/chat` React shell **only when** the env is set (`<`-escaped),
  alongside the existing projects/onboarding bootstrap scripts; (3) **reconnect
  recovery** — `on_session_open`'s steady-state branch replays the
  `onboarding_completed` frame to the connecting topic for an already-completed
  owner when the claim URL is configured. Without this, a finalize that fires
  with no live socket (e.g. a background import-completion watcher finalizes
  while the tab is closed) would drop the only signal and the reconnect — seeing
  an already-`completed` row — would never re-emit it, losing the redirect
  (Codex P2). Gated on the env so it is a strict no-op on Open self-host; the
  client latch keeps it at-most-once and it stops once the owner claims (they
  move to a host without the env).
- `landing/chat-react/config.ts` — `BootstrapConfig.postOnboardingClaimUrl` +
  `WindowLike.__neutron_post_onboarding_claim_url`; `resolveBootstrapConfig` reads
  the injected global (non-empty string only; empty ⇒ treated as absent).
- `landing/chat-react/controller.ts` — new options `postOnboardingClaimUrl` +
  injectable `navigate` (defaults to `window.location.assign`). On the
  `onboarding_completed` frame, IF a claim URL is configured it navigates there
  (once — a `claimRedirected` latch guards a re-sent frame); else no-op.
- `landing/chat-react/main.tsx` — passes `config.postOnboardingClaimUrl` through
  (spread-only when present, so Open self-host stays undefined).

**Tests / evidence.**
- `landing/chat-react/__tests__/controller.test.ts` — redirect fires to the
  configured URL on `onboarding_completed` (Managed); no-op + session stays open
  when unset (Open self-host); at-most-once on a re-sent frame.
- `landing/chat-react/__tests__/config.test.ts` — `postOnboardingClaimUrl`
  undefined by default, read when injected, empty treated as absent.
- `gateway/wiring/__tests__/build-onboarding-finalize.test.ts` —
  `emitOnboardingCompleted` fires once at the terminal transition and is NOT
  re-emitted on an idempotent re-finalize.
- `open/__tests__/open-claim-redirect-bootstrap.test.ts` — the served `/chat`
  shell injects the claim script when the env is set and injects NOTHING when
  unset (no-regression), driven through the composed graph `fetch`.
- `open/__tests__/open-claim-redirect-reconnect.test.ts` — a live `/ws/app/chat`
  connect for a completed owner replays `onboarding_completed` when the claim URL
  is configured, and emits NOTHING when unset (Codex-P2 recovery).
- `tsc` clean (root + `landing/chat-react`); leak-gate SILENT.

## 2026-07-01 — DROP the agent-NAME step in onboarding (personality-only → SOUL.md)

**Why.** Neutron Open is an agent ORCHESTRATOR, not a named personal agent. The owner:
*"we can remove the idea of selecting a name … in neutron open lets drop the name
entirely, just ask about personality to setup SOUL.md."* Onboarding used to force
a "name your assistant" step (step-5 preamble ask + a hard-required `agent_name`
field + a name-suggestion button block) that gated finalize.

**What changed (Path-1 live-session; NO flags, NO dual paths).**
- `onboarding/interview/required-fields-audit.ts` — `agent_name` removed from
  `RequiredField` / `PRIORITY` / `isFilled`. Now **4** required fields
  (`user_first_name`, `primary_projects` ≥3, `non_work_interests` ≥1,
  `agent_personality`); `next_to_collect` goes null — and finalize fires — once
  personality settles. `agent_name` is KEPT on the `RequiredFieldsState` shape
  (the legacy engine + its `llm-router` still amend it) but is never audited.
- `onboarding/interview/onboarding-preamble.ts` — deleted the step-5 "a name for
  you" ask + custom-name-acceptance copy; added an explicit "Do NOT ask them to
  name you" instruction. `buildOnboardingStepGuardFragment` lost its `needsName`
  half: personality is the ONLY button-driven required step; the guard returns
  null once it settles.
- `onboarding/interview/button-backed-answer.ts` — the deterministic capture now
  settles only `agent_personality` (name branch + name-only helpers removed).
- `onboarding/interview/post-turn-extractor.ts` — no longer solicits (LLM prompt)
  or persists `agent_name`.
- `open/composer.ts` — stopped building + wiring the `agentNameSuggester` into
  onboarding. **`agent-name-suggester.ts` MODULE stays in the tree** (Managed
  repurposes it later); the legacy engine's `agent_name_chosen` phase is untouched.

**Personality → SOUL.md verified intact.** `onboarding/persona-gen/soul.ts`
already renders SOUL.md from personality alone — `composeOpenerSentence` falls
back to "You are a personal agent." when no `agent_name` is present — so dropping
the name does not affect SOUL.md generation.

**Tests / evidence.** Updated `required-fields-audit.test.ts` (4-field contract +
explicit "missing agent_name never gates finalize"), `button-backed-answer.test.ts`
(personality-only; a name-suggestion block settles nothing), `onboarding-preamble.test.ts`
(guard never emits a NAME step; preamble never asks a name), `post-turn-extractor.test.ts`
(extractor never persists `agent_name`). Full `onboarding/` suite green
(1602 pass / 0 fail), `open/` suite green (125 pass / 0 fail), root `tsc --noEmit`
clean, leak-gate SILENT.

## 2026-06-30 — Create Project rail refresh reaches a project-scoped socket (not just General)

**Bug.** #132's "Create Project" fan emitted its `projects_changed` app-ws frame
only to the user-scoped General topic `app:<user>`. The served web client opens
ONE socket scoped to the project it is viewing (`app:<user>:<project>`), so
creating a project **from inside a project** never refreshed the left rail until
a page reload. Onboarding was unaffected because it runs on the General topic.

**Fix.** `open/composer.ts` adds `fanProjectsChanged(user_id, frame)` — fans the
rail-refresh frame to the base topic AND every live per-project topic for the
user (enumerated via `appWsRegistry.topics()` with the `app:<user>:` prefix).
Both `emitProjectsChangedNow` (the create-project HTTP endpoint + the
`create_project` agent tool, via the shared `createProjectAndRefresh`) and
`emitProjectsChangedIfChanged` (onboarding) route through it. Each web socket is
on exactly one topic so there is no double-delivery; the frame carries the full
`readProjectRows()` list (`deleted_at IS NULL`) so it always includes the new
project. No flags.

**Tests.** `open/__tests__/open-projects-changed-wiring.test.ts` adds an e2e test
that opens both a project-scoped socket and a General socket, drives the real
`POST /api/app/projects`, and asserts the new project reaches both live.
Confirmed red before the fix, green after; leak-gate silent; `tsc` clean.
## 2026-06-30 — Onboarding live-path: deterministic name/personality capture (no double-ask) + single closing

**P1 — two live-path bugs from the owner's deployed-onboarding test.** Both fixed inside
Path-1 (no flags, live-session locked, honoring #129; no regression of the passing
gates — archetype buttons #139, custom-name accept #136, per-project openings
#136/#138/#139, bubble/tab/markdown #137/#141).

**BUG 1 — agent name (and personality) asked TWICE on a TAP.** Root cause:
`agent_name`/`agent_personality` were persisted ONLY by the fire-and-forget
post-turn LLM extractor (`post-turn-extractor.ts` — literally "agent_name — LLM
only"). So a TAPPED (or typed) choice left `phase_state` unset until that slow,
sometimes-timing-out extractor caught up, while the per-turn required-step guard
(`onboarding-preamble.ts:buildOnboardingStepGuardFragment` via
`required-fields-audit.ts`) re-injected the "STILL OPEN - NAME/PERSONALITY"
hard-require from the STALE pre-turn `phase_state` every turn — so the live agent
dutifully re-asked. **Fix:** a new PURE decider `button-backed-answer.ts:`
`captureButtonBackedRequiredField` (prior-question + phase_state + answer →
which field to settle), driven by a new `LiveAgentOnboardingSeam.captureRequiredAnswer`
seam that the live runner (`build-live-agent-turn.ts`) calls + AWAITS at
turn-START — BEFORE the step-guard grounding reads `phase_state`. It persists
`agent_name`/`agent_personality` deterministically at choice-time, so the audit
recomputes with the answer already settled and the step is never re-asked. It is
conservative: only fires off the prior agent question's DURABLE persisted options
(`ButtonStore.latestPromptByTopic` — live replies strip the `[[OPTIONS]]` block
out of `body` into `options_json`, so the body alone would never match; Codex r1
P1), anchors the personality step on the DEFINED archetype names actually
rendered (so an early import yes/no can't be mis-captured), declines escape hatches
("Something else"/"I'll choose my own"), and lets the LLM extractor stay the
fallback for free-text answers it declines. Typed custom names still settle.

**BUG 2 — duplicate closing message.** The live agent emitted its own wrap-up
("We're set, what first?") AND finalize emitted the deterministic
`ONBOARDING_CLOSING_MESSAGE` (`build-onboarding-finalize.ts`). **Fix:** when
`captureRequiredAnswer` settles the LAST required field it fires finalize
(idempotent, `finalizeImportOnboardingIfReady`) and returns `finalized: true`, and
the runner SUPPRESSES its own wrap-up turn (returns early, no substrate dispatch,
no `agent_message`) — so the single deterministic finalize closing (which already
names the LEFT RAIL) is the ONE closing. Defense-in-depth: the preamble now tells
the agent NOT to write its own closing (the system sends it) and forbids the exact
duplicate phrases. Nice-to-have: preamble asks the agent to avoid em dashes.

**Tests.** New `onboarding/interview/__tests__/button-backed-answer.test.ts` (15:
tap/typed name + personality settle without the extractor; escape hatch / bare
confirm / no-options-block / early yes/no / both-settled all decline); new
`gateway/wiring/__tests__/build-live-agent-turn-capture.test.ts` (5:
capture runs BEFORE the guard grounding; `finalized:true` suppresses dispatch +
`agent_message`; `finalized:false` runs normally; seed turn never captures;
settling answer still persisted as the user bubble); `onboarding-preamble.test.ts`
updated (agent told not to self-close + em-dash guidance). Full
`onboarding/interview` + `gateway/wiring` + chat-bridge live-agent
suites green (1373 pass / 0 fail). tsc clean; leak-gate SILENT.

**Touched:** `onboarding/interview/button-backed-answer.ts` (new pure decider),
`onboarding/interview/onboarding-preamble.ts` (export archetype names + no-self-
close/em-dash guidance), `gateway/wiring/build-live-agent-turn.ts`
(`captureRequiredAnswer` seam + turn-start call + wrap-up suppression),
`open/composer.ts` (seam impl: deterministic persist + finalize-on-complete).

## 2026-06-30 — Onboarding reliability: per-project opening recovery + empty-project loader + deterministic archetype step + larger cold budget

**P0 — four reliability gaps from a full fresh-install verify of #136+#138.** All
fixed inside Path-1 (no flags, live-session locked, honoring #129; no regression
of #136 custom-name/closing, #137 per-project-chat/Plan/markdown/tabs, #138
General-only onboarding + raised-timeout + welcome-reload-recovery).

**Issue 1 — per-project OPENING never landed (DB-confirmed 0 rows).** Finalize's
`emitProjectOpenings` logic was correct and unit-tested, yet the live box showed 6
projects with ZERO `app:<user>:<project>` `button_prompts` rows: the opening was a
fire-once side effect of finalize that can race the project-tab socket, be
swallowed, or be delayed under cold-turn load, and nothing regenerated it on entry
(reload recovered only the General welcome). **Fix:** made the opening a property
of ENTERING a materialized project. `open/composer.ts` `on_session_open` now, on
every steady-state connect to a materialized PROJECT topic with no message yet,
regenerates + persists the SAME deterministic opening
(`build-onboarding-handoff.ts:buildDeterministicProjectOpening` over the
materialized `STATUS.md`/`README.md`) via the idempotent `onboardingMsgHolder.emit`
(`dedupe_key: onboarding_opening:<project_id>`) — collapses onto finalize's row if
that already landed, never double-posts. Doubles as reload recovery for a
stuck/missing project opening (Issue 4b).

**Issue 2 — empty project chat showed a PERMANENT "Setting things up…" loader.**
`chat-react/ChatApp.tsx` gated the loader on the page-global
`config.onboardingActive` ALONE, so opening an empty project tab while onboarding
(or just after) painted the infinite onboarding loader forever. **Fix:** gate on
`config.onboardingActive && vm.projectId === null` — onboarding is General-only, so
a project topic resolves to the usable "Send a message to begin." empty state,
never the loader.

**Issue 3 — personality/archetype step was non-deterministic (skipped).** The
archetype + name steps lived only as soft preamble prose, and the preamble also
says "you do NOT need to collect these in order" — a fresh-install run showed ZERO
option buttons. **Fix:** new `onboarding-preamble.ts:buildOnboardingStepGuardFragment`
audits the durable `phase_state` and, while `agent_personality`/`agent_name` are
unset, HARD-REQUIRES the named-archetype / name `[[OPTIONS]]` block (never settle by
free text alone, never finalize without it). Injected EVERY onboarding turn via the
`LiveAgentOnboardingSeam.onboardingContext` seam (joined with the import-analysis
grounding), so the agent cannot drift past the personality step without rendering
the buttons — reliable, not LLM-whim, still inside Path-1.

**Issue 4 — cold turn still hard-erred + reload didn't recover project openings.**
(a) `COLD_TURN_TIMEOUT_MS` raised 360s → 600s (`build-live-agent-turn.ts`): #138's
360s still hard-failed a real onboarding turn at ~5.5min under load; 10 min leaves
comfortable headroom. (b) Reload recovery for project openings is the Issue-1
`on_session_open` regeneration above.

**Tests.** `onboarding-preamble.test.ts` (+4: step guard fires while unset, name
step after personality, null once both settled, both-missing); `chat-react`
`component.test.tsx` (+2: empty project topic shows no loader / General still does);
new `open/__tests__/open-project-opening-recovery.test.ts` (+2 integration: a
project-topic connect seeds the STATUS.md opening; no seed when the topic already
has a message); existing cold-turn budget test updated 360s → 600s. tsc clean
(root + chat-react leaf); leak-gate SILENT.

**Touched:** `open/composer.ts` (opening-recovery helper + `on_session_open`
steady-state branch + `onboardingContext` step-guard wiring),
`onboarding/interview/onboarding-preamble.ts` (step-guard fragment),
`landing/chat-react/ChatApp.tsx` (loader gate),
`gateway/wiring/build-live-agent-turn.ts` (600s budget).

## 2026-06-30 — REPL/live-agent model is ALWAYS the latest (never a hardcoded stale id)

**P0 onboarding hang fix.** A fresh Open box spawned the live-agent / onboarding
REPL with `--model claude-opus-4-7` (the hardcoded `BEST_MODEL` default in
`runtime/models.ts`). Once `opus-4-7` stopped serving, the model call hung → the
turn produced ZERO tokens → the persistent-REPL 180s per-turn timeout fired →
the user got the failure bubble / an indefinite "Setting things up…" loader.
Repro: a clean instance on the default hung 180s + failed; pinned to
`claude-opus-4-8` it delivered the welcome in ~32s.

**Root cause.** `runtime/models.ts` already exposes a dynamic accessor
`getBestModel()` (the model-update watchdog flips its override via
`setBestModelOverride` when a newer top-tier model ships), but the gateway-level
spawn/dispatch sites read the **frozen `BEST_MODEL` constant** instead — so the
watchdog's adopted id never reached new/cold spawns, and the stale literal rotted
into a hang the moment the pinned model was retired.

**Fix (no flags, no dual paths).**
- **Seed bump:** `BEST_MODEL` default `claude-opus-4-7` → `claude-opus-4-8` (the
  fresh-install, pre-first-watchdog-tick seed) + a doc note that this is a SEED,
  not the live value. Added the matching `claude-opus-4-8` row to
  `runtime/model-pricing.ts` (same Opus $5/$25 rates) so
  `resolvePricingFor(getBestModel())` doesn't throw at import-build.
- **Dynamic resolution at every live spawn/dispatch site**, resolved as late as
  feasible (per-turn / per-call, never captured when a runner is built once at
  boot): `open/composer.ts` `prewarmSubstrate` (the warm-pool spawn that heats
  the onboarding REPL — THE confirmed-bug site), `build-live-agent-turn.ts`
  (resolved inside the per-turn body), `build-llm-router.ts`,
  `build-project-opening-message.ts`, `build-project-doc-composer.ts`,
  `build-phase-spec-resolver.ts` (`buildAnthropicLlmCall` model now optional →
  `getBestModel()` per-call), `build-agent-watcher-llm-call.ts`,
  `gateway/cores/mount-open-cores.ts` (one-shot Core LLM + email model), the
  onboarding suggesters (`agent-name-suggester.ts`,
  `personality-character-suggester.ts`) + `post-turn-extractor.ts`,
  `onboarding/synthesis/synthesis-session.ts`,
  `onboarding/history-import/substrate-callers.ts` + `job-runner.ts`,
  `scribe/extract.ts`, `reflection/detector.ts`. `agent-dispatch/service.ts`
  `default_model` now accepts a `string | (() => string)` thunk, and the Open
  composer passes the `getBestModel` accessor so each dispatch resolves live.
  Trident keeps the dynamic `--model opus` CLI alias (already always-latest);
  reminders/research keep their intentional `FAST_MODEL`/`SONNET_MODEL` picks.
- After this change there are **no remaining runtime references to the frozen
  `BEST_MODEL` constant** outside `runtime/models.ts` (the seed) and
  `runtime/model-pricing.ts` (doc text) — verified by grep.

**Tests.** New `build-live-agent-turn-model-resolution.test.ts`: a runner built
WITHOUT an explicit model spawns `getBestModel()`; a `setBestModelOverride` flip
AFTER the runner is built reaches the NEXT turn on the SAME runner (proves
per-turn, not per-build, resolution); an explicit `input.model` still wins. New
`prewarmSubstrate` model-resolution test (in `onboarding-warm-conversational`):
the pre-warm spawn uses `getBestModel()` and tracks a watchdog flip. Updated the
`models.ts` default assertion (4.7→4.8), the watchdog-wiring oldModel/no-downgrade
assertions (assert against `BEST_MODEL` not a literal), and the import
substrate-caller default assertions. tsc clean (root + trident); leak-gate
SILENT; models/substrate/onboarding/cores/realmode-composer suites green.

**Codex cross-model review follow-up.** Making the import default dynamic meant
that, after the watchdog adopts a brand-new top-tier id with no pricing row yet,
`resolvePricingFor(getBestModel())` (eager, at `buildPass{1,2}SubstrateCaller`
construction) would throw and break onboarding/imports. Fixed by splitting the
resolver: an EXPLICIT operator `model_preference`/`fallback_model_preference`
keeps the strict loud-fail (typo protection), while the DYNAMIC always-latest
default degrades to a $0 estimate (`dollars_billed` is telemetry-only) with a
one-time warn — the import runs on the latest model regardless. Regression test
added (`buildPass1/Pass2SubstrateCaller` construct + run on an unpriced
watchdog-adopted model, billing $0).

**Codex review round 2 — per-call resolution.** The import callers + onboarding
suggesters + post-turn-extractor are constructed ONCE at gateway/composer boot,
so a builder-scope `getBestModel()` capture would pin the boot model and miss a
later watchdog flip. Moved the dynamic-default model (+ its pricing, for the
import callers) resolution INSIDE each returned closure (per-call), so a
post-boot adoption reaches the next import / suggestion / extraction. Explicit
operator model picks still resolve + price ONCE at build (loud-fail on typo).
Test added: a `setBestModelOverride` flip between two calls on the SAME import
caller reaches the second dispatch.

**Codex review round 3 — env-pin keeps strict pricing.** `getBestModel()` returns
`runtimeBestModel ?? BEST_MODEL`, so an operator's `NEUTRON_BEST_MODEL` pin
(surfaced as `BEST_MODEL`) was being silently billed at $0 when unpriced —
regressing the typo loud-fail. Now ONLY a watchdog-adopted override (model !==
`BEST_MODEL`) degrades; the env/default base keeps the strict `resolvePricingFor`
loud-fail.

**Codex review round 4 — model attribution / metadata (P3).** Two
non-dispatch sites that should NOT track the live accessor: (a)
`onboarding/history-import/job-runner.ts` stamps `synthesizer_model` for a
legacy/pre-S21 row that ALREADY completed — reverted to the stable `BEST_MODEL`
(attribution, not selection; a watchdog flip mustn't mislabel old results). (b)
The free-email `/email` chat-command filter's reported `model` was captured at
mount while `emailLlm` dispatches `getBestModel()` per call — the filter's
`model` option now accepts a thunk resolved per-call in `match`, so the reported
model stays aligned with the dispatch.

**Codex review round 5 — Email Core backend metadata (P3).** Same boot-capture
in the Email-Managed Core MCP-tool path: `buildTools` stamped a boot-time model
onto `email_triage` / `email_summarize` brief metadata while `llm` dispatched
`getBestModel()` per call. Threaded a `string | (() => string)` thunk through
`emailModel` (`mount-open-cores` → `boot-helpers` factory → `buildTools`),
resolved PER-CALL inside each tool handler, so the stamped model tracks a
watchdog flip. (Email Core is OAuth-gated / inert in default Open, but kept
consistent with the dispatch.)

NOTE: `open/__tests__/open-projects-changed-wiring.test.ts` (one live-refresh
timing test) fails on unmodified `origin/main` too — a pre-existing flake, not a
regression from this change.
## 2026-06-30 — Web-client rework: per-project chat + rail/tab layout + Plan rename + remove Tasks + markdown (P0)

The linchpin fix for the onboarding→project UX. Five linked changes, all in the
web client + tabs registry + the app-ws topic-binding seam. No feature flags.

**(1) Real per-project chat.** The `/ws/app/chat` surface previously bound EVERY
connection to the per-user topic `app:<user>` and treated `project_id` as a
cosmetic tag, so all projects shared one transcript and clicking a project showed
the same chat. Now a `platform=web` socket carrying a `project_id` binds the
PER-PROJECT topic `app:<user>:<project>` (`appWsProjectTopicId`,
`channels/adapters/app-ws/envelope.ts`); General omits `project_id` → bare
`app:<user>`. Persistence + seq + resume + fan-out key on the topic string
(independent transcripts, verified safe — the agent loop scopes off the
`project_id` field, not the topic), so each project has its own history. The
client `controller.setProject` RE-SCOPES: tears the socket down and stands up a
fresh one bound to the new topic, hydrating that topic's transcript from the
shared OPFS store (`main.tsx` `topicForProject`/`wsUrlFor`; `config.ts`). The
`turnTopicId` warm-session key was de-duped so the already-project-scoped web bind
isn't double-suffixed (`open/composer.ts`). **Gated on `platform === 'web'`** —
mobile keeps its single `app:<user>` socket + `project_id`-field model, unchanged.
Topic string is `app:<user>:<project>` (user-scoped, NOT `wow-shell-<id>`) so two
users opening the same project can never share a transcript — mirrors the proven
`landing/server.ts` `web:<user>:<project>` model. The 0→N `projects_changed`
auto-select was DROPPED: a mid-onboarding project appears in the rail but does NOT
yank the chat off General (which would drop still-arriving onboarding messages);
the user enters a project by tapping it. **Known behavior:** reminders/briefs still
fan to the bare `app:<user>` (General inbox) topic, so they surface in General, not
the per-project chats (durable rows always under `app:<user>`).

**(2) Persistent rail + tab layout.** `TopicRail` was nested INSIDE the Chat tab
body, so it vanished on other tabs, and the `TabBar` floated above everything only
in project views. Now `ProjectShell` is the app shell: a persistent `TopicRail`
left column + a content pane with the `TabBar` in BOTH General and project views.
**General** = Chat + Admin (global tabs); **project** = Chat / Plan / Documents
(NO Admin fold-in — the prior bug). `ChatApp` is now just the Chat-tab body
(`ChatSurface` + its bubble contexts); the create-project flow moved to the shell.

**(3) "Work Board" → "Plan"** user-facing label (`tabs/registry.ts`); internal
`work_board_*` tools / `cwb-` CSS / `work_board_changed` frame / DB table keep
their identifiers (no churny rename).

**(4) Tasks tab removed** from the engine (an owner directive). The `tasks`
`BUILTIN_TABS` entry + `TasksTab.tsx` + `tasks-client.ts` + the `ProjectShell`
`target==='tasks'` branch + their tests were deleted; Tasks returns in WAVE 3 as a
Core-contributed webview tab via the existing `CoreTabContribution` path.

**(5) Markdown rendering.** Agent chat bodies (`ChatApp` `TextPart`, via
`useMessagePartText`) and the Documents viewer render sanitized GitHub-flavored
markdown through a shared `Markdown.tsx` (`react-markdown` + `remark-gfm` +
`rehype-sanitize`; links open `target=_blank rel=noopener`). User chat messages
stay plain. The Documents tab gains a Rendered↔Source toggle — Rendered is the
default; Source exposes the raw `<pre>` so comment anchors still map to RAW
character offsets. Deps added to `landing/package.json`; the lazy `Bun.build`
bundle stays ~0.91 MB.

Verification: root + chat-react-leaf + mobile `tsc` clean; chat-react 143 tests,
registry/app-tabs/app-ws-surface 46, app-ws adapter 107, composer/realmode 502 all
green; leak-gate SILENT. Files: `gateway/http/app-ws-surface.ts`,
`channels/adapters/app-ws/{envelope,adapter}.ts`, `open/composer.ts`,
`tabs/registry.ts`, `landing/chat-react/{ProjectShell,ChatApp,DocumentsTab,
controller,config,main,Markdown}.tsx?`, `landing/chat-react.html`,
`landing/package.json`.
## 2026-06-30 — Onboarding live-path: archetypes + option buttons + custom-name + closing + per-project openings

Five Path-1 onboarding content/flow regressions the owner hit live-testing, all wired
INTO the live CC session (no phase-machine revival, no feature flags, one path).

**(1) Defined personality archetypes instead of improvised "flavors."**
`onboarding/interview/onboarding-preamble.ts` told the model to "offer a couple of
concrete flavors" at the personality step → it improvised a different trio every
run. It now injects the DEFINED named-character set
(`STATIC_PERSONALITY_CHARACTER_FALLBACK` from `personality-character-suggester.ts`
— Sherlock Holmes / Marcus Aurelius / Mr. Miyagi / Yoda / Atticus Finch) and tells
the agent to offer THOSE, presented as buttons (item 2).

**(2) Quick-select OPTION BUTTONS on choice steps.** The live onboarding turn
always emitted `options: []`, so the React client — which already renders an
`agent_message`'s `options[]` as tappable buttons and routes a tap back through
`on_button_choice` (`open/composer.ts`) as the next turn's `user_text = option.value`
— never received any. The preamble now instructs the agent to append a
`[[OPTIONS]] … [[/OPTIONS]]` block AFTER its prose question on genuine choice
steps; `build-live-agent-turn.ts:extractAgentOptions` parses the block out of the
collected reply ON ONBOARDING TURNS ONLY, strips it from the rendered body, and
emits the lines as buttons (letter-legend label + display body + a routing `value`
that is the line text itself, deduped + byte-capped to the 37-byte wire budget).
`allow_freeform` stays true (typing always works). Server-side structured-choice
detection — NOT a `--tools` surface change (the warm REPL's allow-list must stay
constant per the reuse guard).

**(3) Reliable custom-name capture.** The preamble now mandates accepting ANY name
The owner gives — typed OR tapped — verbatim, confirming and moving on, and NEVER
re-asking a name already given (the "Ferin got re-asked" regression). Name
suggestions are offered as `[[OPTIONS]]` per #2.

**(6) Closing handoff message.** `build-onboarding-finalize.ts` emitted NO closing
— the interview went silent after the last answer. It now takes an `emitChatMessage`
dep (wired in `open/composer.ts` to the SAME durable-history + live-fan path a
live-agent reply uses: a `button_prompts` row on `app:<user>[:<project>]` that the
topic `chat_history_surface` hydrates + a `buildAppWsSendReply` socket push) and,
AFTER `emitProjectsChanged`, emits a deterministic General closing pointing at the
populated left rail ("open one to find its Plan, Documents, and Chat" — uses "Plan",
not "Work Board"). Emitted from finalize (not just the preamble) so the projects
are guaranteed in the rail when it lands. The closing + each opening carry a stable
per-(topic, kind) `dedupe_key`; the composer keys the durable `button_prompts` row
on it AND suppresses the live re-send when the row already existed, so a
re-finalize from an overlapping recovery path never double-posts (Codex P2).

**(7) Per-project opening message.** Path-1 finalize materialized projects with
rich docs but seeded no opening chat message. `materializeProjects` now returns the
landed projects, and finalize composes each one's opening (summary + ONE next move)
via the SAME deterministic composer the legacy phase-machine handoff used
(`build-onboarding-handoff.ts:buildDeterministicProjectOpening`, reading the
materialized `STATUS.md`/`README.md` with the import signal as fallback), delivering
it into the project's app-ws topic `app:<user>:<project>` — the key the live-agent
reply path and the client's per-project chat read from. SIBLING-PR COORDINATION:
the concurrent web-client PR is making the client read per-project topics; the
opening lands on the project's canonical app-ws topic, reconciled at merge.

Tests: `extractAgentOptions` parsing + onboarding-vs-steady-state emission
(`build-live-agent-turn-options.test.ts`); finalize closing + per-project openings
+ no-seam-still-completes (`build-onboarding-finalize.test.ts`); preamble archetypes
/ options protocol / custom-name / rail+Plan wrap-up (`onboarding-preamble.test.ts`).
`tsc` clean; existing live-agent-turn / handoff / chat-bridge / production-composer
suites still green.

## 2026-06-30 — M1 onboarding/UI cleanup batch (3 minor verify-pass fixes)

Three minor, non-architectural polish fixes surfaced during the M1
browser-verification passes. No feature flags, no migration, no new endpoint.

**(a) Import "Reading through…" status bubble floated to the chat bottom.** The
`import_running` `status` prompt ("Reading through your export now: entities,
topics, recurring threads…") was fanned ephemerally via `emitOnboardingPrompt`,
so it carried no chat_log `seq` and `compareForDisplay` (seq-less sorts to the
tail) pinned it BELOW every later real-seq message — it stayed at the bottom even
after the import completed and the analysis + later turns arrived. This is the
same ordering seam #130 fixed for the analysis body. **Fix** (`open/composer.ts`):
new pure, unit-tested `resolveImportRunningStatusDelivery` — the FIRST plain
buttonless status bubble is persisted through the durable adapter (chat_log
`seq` → chronological order), and the engine cron's RE-EMITS
(`import_running_attempt_count > 1`) are suppressed so they don't stack duplicate
durable bubbles (the live `import_progress` banner already shows ongoing
progress). Failure / rate-limit / resume prompts (real buttons) stay ephemeral.

**(b) Locked-in project set could include a project never shown to the user.**
The presentation caps the proposal at `MAX_ANALYSIS_PROJECTS` (7), but Pass-2 /
synthesis only caps via a prompt instruction (NOT enforced in code). A >7
synthesis therefore stamped the FULL list into `phase_state.import_result` AND
merged all N names into `primary_projects`, so the per-turn `onboardingContext`
seam, persona-gen, and finalize all locked in projects 8+ the user never saw and
could not drop. **Fix**: `capProposedProjects` (single source of truth in
`phase-prompts.ts`, used by the presentation too) is applied at the engine STAMP
chokepoint (`advanceFromImportRunningOnComplete` caps both `import_result` and
the `primary_projects` merge), so everything downstream agrees with the displayed
slice. `build-onboarding-finalize.resolveProjects` caps the IMPORT contribution to
the displayed set as a finalize-layer guard but TRUSTS `primary_projects` verbatim
(only displayed names + explicit adds, since the engine merge is capped) — it does
not filter primary against the overflow, which would wrongly drop an explicit add
whose name collides with an unshown overflow proposal (fixed per Codex review).
The GAP1 "no-narrowing" invariant is preserved (finalize = displayed − dropped +
adds).

**(c) Create Project used the native `window.prompt()`.** Replaced the blocking,
unstyleable native dialog (which also blocks E2E/CDP automation) at
`landing/chat-react/ChatApp.tsx` with an INLINE name input in the rail
(`.car-rail-input`), mirroring the mobile `app/app/projects` pattern: Enter
submits, Esc cancels, an empty name shows an inline error, and a failed POST
renders inline (no `window.alert`). Same `POST /api/app/projects` + bearer +
`controller.setProject(newId)` navigate-in flow; CSS in `landing/chat-react.html`.

**Tests.** New unit tests for `resolveImportRunningStatusDelivery`
(`open/__tests__/open-import-analysis-delivery.test.ts`), `capProposedProjects` +
the finalize >7 reconciliation (`gap1-project-no-narrowing.test.ts` +
`build-onboarding-finalize.test.ts`), and the inline create-project flow incl.
Enter/Esc/empty-name (`landing/chat-react/__tests__/component.test.tsx`). tsc
clean; leak-gate SILENT.

## 2026-06-29 — M1 CRITICAL: open-mode history import wouldn't START (#130 regression) — upload right after the name now seeds the row + starts the job

**Symptom.** On a fresh Open install, the reworked onboarding (#130) offers
history import right after the name. The owner uploads their ChatGPT/Claude
export and the server returns `job_id: null`; the client shows "Couldn't start
the import — no import job started." The import never runs (`import_jobs` empty,
`in_flight_imports=0` forever) behind a false success.

**Root cause.** `InterviewEngine.notifyImportUpload`
(`onboarding/interview/engine.ts`) reads the onboarding_state row and short-
circuits with `noop_no_state` when it's absent — **before** the open-mode
import-start gate. The open-mode live-agent onboarding never calls
`engine.start()` (managed mode's row-seeding entry); the row is created
**lazily + asynchronously** by the fire-and-forget post-turn extractor
(`post-turn-extractor.ts`), a multi-second background LLM call that only upserts
once it extracts a field. #130 moved the import offer to right after the name —
**earlier than the background extractor can create the row** — so the upload
races ahead of the row and lands at `state === null`.

**Fix (no flags, tenant-silent).** In `notifyImportUpload`'s `state === null`
branch, when the upload is a SOLICITED open-mode Path-1 upload (the SAME signal
the non-null gate uses: `deploymentMode === 'open'` AND `importAffordanceOffered`,
the exact condition the live-agent seam renders the 📎 affordance under), seed
the onboarding_state row at the `work_interview_gap_fill` conversational marker —
stamping `signup_via` so the import-running cron's channel-context invariant holds
on disk — then start the import via the existing
`startImportAndAdvanceToRunning`. A STRAY upload (affordance not offered, e.g. no
synthesis substrate) and managed mode both still `noop_no_state`. The #130
offer-first / live-progress / ordering / curation-context handoff are untouched.

**Concurrency guard (Codex r1 P2).** Two layers. (1) `notifyImportUpload` is now
serialized per `(project_slug, user_id)` via an in-process promise-chain tail
(mirrors the post-turn extractor's `chains` map). Single-owner Open is one
process, so this fully eliminates the upload-vs-upload race: two truly-
simultaneous fresh-install uploads run one-at-a-time, so the second observes the
first's `import_running` row and takes the `alreadyHasImportJob` guard — no
duplicate job, no downgrade. (2) Before seeding, the no-state branch also re-reads
the row and, if it now exists (e.g. the post-turn extractor — which is NOT under
this tail — created it), re-enters the locked body so all non-null guards apply.
Covered by added tests: sequential double-submit; a get-hooked store simulating
the concurrent window; and two truly-simultaneous `Promise.all` uploads → exactly
one job.

**Test (forbidden-pattern fixed).** The passing acceptance test
`tests/integration/nd2-real-export-path1-import-runs.test.ts` SQL-SEEDED an
onboarding_state row before uploading — manufacturing the precondition the live
flow never creates, so it could never catch this. It now seeds NO row and drives
the real no-state upload (verified end-to-end with the owner's real 3.6MB / 184-convo
Claude export → job started). Added two engine-level repros in
`onboarding/interview/__tests__/path1-solicited-upload-starts-job.test.ts`
(no-state solicited → seeds row + starts; no-state affordance-off / managed →
no-op, no row manufactured). Negative control: reverting the engine fix fails
exactly these no-state tests.
## 2026-06-29 — Create Project affordance (project rail + create-project capability + agent tool)

A skip-import owner had no user-initiated way to create a project (projects only
materialized at onboarding finalize; reaching one otherwise needed the ≥3-project
gap-fill quota). Added a Create Project affordance across all surfaces, all
reusing ONE project-creation code path.

- **Shared primitives (`gateway/wiring/project-create.ts`).** Extracted
  `ensureProjectRow` + `resolveBindTarget` (the `projects` row + cli wow-shell
  `topics` binding — idempotent, duplicate-safe, soft-delete-respecting) out of
  `build-onboarding-finalize.ts` into a shared module, plus `createProjectRow`
  (fast row-only half), `buildScaffoldMaterializer` + `materializeProjectScaffold`
  (on-disk docs + git + GBrain page). The finalizer now IMPORTS these — no second
  path. (Onboarding finalize tests unchanged + green.)
- **HTTP `POST /api/app/projects`** (`gateway/http/app-projects-surface.ts`,
  bearer-gated). `{ name }` → `{ project: { id, label }, created }` (201/200);
  optional `createProject` binding → `501 create_not_configured` where unwired.
- **Open wiring (`open/composer.ts`).** Mounts the whole app-projects surface
  (also gives mobile `fetchProjects` a real backend — previously unmounted in
  Open) + the `create_project` tool, both bound to one `createProjectAndRefresh`
  (row → fire-and-forget materialize → `emitProjectsChangedNow`, an unconditional
  `projects_changed` fan so a skip-import owner's first action refreshes the rail).
- **`create_project` agent tool** (`create-project-tool.ts`, registered in
  `build-core-modules.ts`; `auto` approval, `write:project_data`, non-hidden) —
  agent-native parity; `project_slug`/`speaker_user_id` server-injected.
- **Web rail** (`landing/chat-react/ChatApp.tsx` `TopicRail` + `chat-react.html`):
  `+ Create Project` pinned at the rail bottom (`margin-top:auto`), always visible;
  the rail now always mounts. Click → prompt → POST → `setProject` navigates in.
- **Mobile rail** (`app/app/projects/index.tsx` + `lib/projects.ts` `createProject`
  / `lib/projects-client.ts` `create`): bottom-pinned bar → inline name input →
  POST → `router.push('/projects/<id>')`.
- No migration (the `projects` table already exists, `0038`); Work Board tab is
  automatic per-project. tsc clean (root + chat-react + app); leak-gate SILENT.
  Tests: surface POST (`gateway/__tests__/app-projects-surface.test.ts`), shared
  primitives + tool (`gateway/wiring/__tests__/project-create.test.ts`),
  web rail click (`landing/chat-react/__tests__/component.test.tsx`), mobile client
  (`app/__tests__/projects-client.test.ts`).

## 2026-06-29 — M1: onboarding import flow rework — offered FIRST + live progress + curation handoff + ordering

This is one coherent import-onboarding rework (PR #130). Two further bugs were
folded in after the initial offer-first + progress pass:

**Bug 3 — analysis → curation handoff was BROKEN (the killer).** The import-
analysis result (proposed-projects list) reached the client but was NOT in the
live-agent's conversation context. So when the owner replied to curate ("drop
the Family Home project, keep the rest"), the agent had no record of proposing
anything and answered "this is our first conversation, I haven't proposed any
projects" — the import was visible but un-actionable.

- Root cause: the analysis "wow moment" is delivered OUT OF BAND (ephemeral
  app-ws `agent_message`, never in the warm REPL transcript), and the onboarding
  `systemPreamble` is a static string spliced ONLY on the cold first turn — so a
  warm session post-import had no grounding on what it proposed.
- Fix (1) — context threading: new optional seam method
  `LiveAgentOnboardingSeam.onboardingContext(user_id)` (`build-live-agent-turn.ts`)
  re-injected on EVERY onboarding turn (warm AND cold), mirroring the Work Board
  block. `open/composer.ts` implements it: reads durable `phase_state.import_result`
  + `primary_projects` and calls the new `buildImportAnalysisContextFragment`
  (`onboarding-preamble.ts`) → an `<import_analysis>` block listing the proposed
  projects (with rationale + which were dropped) and telling the agent it already
  presented them + how to handle keep/drop/edit/add.
- Fix (2) — drop propagation: the Path-1 post-turn extractor never implemented the
  `removed_projects` channel that `ExtractedFields` has documented since GAP1
  (2026-06-09) and the legacy engine honors. Ported it: `parseExtractedFields`
  parses `removed_projects`; the extraction prompt asks for explicit drops;
  `buildPhaseStatePatch` subtracts them from the merged `primary_projects` AND
  accumulates them under `phase_state.dropped_projects`. `build-onboarding-finalize.ts`
  `resolveProjects` excludes `dropped_projects` from BOTH union sources (the import
  side re-pulls `proposed_projects`, so the `primary_projects` subtraction alone
  wasn't enough). Mirrors the legacy engine's `(prior ∪ adds) MINUS removals`. So
  a dropped project is never materialized; persona-gen (reads `primary_projects`)
  agrees. The additive no-narrowing rule is intact for non-removal turns.

**Bug 4 — import-delivered messages mis-ordered.** New user messages rendered
ABOVE the import-delivered analysis instead of newest-at-bottom. The successful
`import_analysis_presented` body was fanned via the ephemeral `emitOnboardingPrompt`
(no chat_log `seq`), and chat-core's `compareForDisplay` pins seq-less messages to
the tail — so a later real-seq user message sorted above it (and it vanished on
resume). Fix: that specific buttonless "wow moment" now persists through the
durable app-ws adapter (`open/composer.ts` button-prompt router → `adapter.send`
→ chat_log → monotonic `seq`, replayable). Every OTHER onboarding prompt (failure
/ rate-limit / resume — real buttons) stays ephemeral. Safe from double-render:
`on_session_open` never re-sends the body and the watcher resolves the phase so
the reconnect re-emit won't re-fire it.

Tests added: `onboarding-preamble.test.ts` (context fragment — lists proposed,
marks dropped, case-insensitive); `post-turn-extractor-removed-projects.test.ts`
(parse + subtract + accumulate `dropped_projects`, additive when no removals);
`build-onboarding-finalize.test.ts` (a dropped project is not materialized even
from the import union). tsc clean; leak-gate SILENT; onboarding-interview (957),
realmode-composer (379), app-ws (107), Open import/boot suites all green.

---

## 2026-06-29 — M1: onboarding import offered FIRST + real live import progress

**Problem (two live-test bugs).** The owner hit two issues on a fresh M1 install:
1. The ChatGPT/Claude history import was **not offered early/explicitly**. After
   the #126 fix removed a premature always-on hint, the offer swung too far the
   other way — the agent only mentioned import after probing the user's work, so
   it felt buried. The intent (and the onboarding-experience spec) is: offer the
   import as the EXPLICIT first step right after the name, so the rest of the
   interview is informed by the analysis.
2. There was **no real import-progress indicator**. A large import (~8 min for
   173 conversations) showed only a one-shot "Export received — reading through
   your history now." line and then looked dead for minutes.

**Root cause.**
- Bug 1: Path-1 (Open) onboarding is prompt-driven — the engine runs only the
  import subsystem, so onboarding ordering lives entirely in the `<onboarding>`
  preamble (`onboarding/interview/onboarding-preamble.ts`). The import block sat
  after all five learning goals + was gated "after you have their name AND a
  sense of their work", biasing the model to defer it past the work-interview.
- Bug 2: the engine's `import-running-cron` already emits an `import_progress`
  event every ~5s and `buildRoutedSendImportProgress` already routes `app:<user>`
  topics to a composer holder — but that holder's `.send` was a documented NO-OP
  (`open/composer.ts`), so every progress frame was dropped. The React client
  (`controller.ts`) already consumed `import_progress` and rendered a spinner +
  per-pass line (`ChatApp.tsx` `ImportStatus`); only the server-side app-ws emit
  was missing.

**Fix (no flags, Option A in-chat for Bug 1).**
- `onboarding/interview/onboarding-preamble.ts` — moved the import-offer block to
  between goal #1 (name) and goal #2 (work) and reworded it to an EXPLICIT,
  prominent ask made RIGHT AFTER the name and BEFORE the work questions (mentions
  the drag-and-drop/📎 affordance + that it runs in the background with live
  progress; "only ask this once"). No new phase/modal — a pure preamble
  reposition. The managed-mode phase machine already routes import right after
  name, so it was untouched.
- `channels/adapters/app-ws/envelope.ts` — new `AppWsOutboundImportProgress`
  envelope (`{v,type:'import_progress',job_id,status,pass,pct,chunks_total_known,
  body?,ts}`) added to the `AppWsOutbound` union; mirrors `agent_typing` /
  `work_board_changed` (ephemeral, UI-only, not persisted, never replayed).
- `open/composer.ts` — filled the no-op `appWsImportProgressRouter.send` to fan
  the new frame via `appWsRegistry.send(app:<user>, env)` (best-effort; terminal
  frames clear the client spinner defensively, the analysis body still lands via
  the button-prompt path). Engine, cron, routing, and client render were already
  built.
- Tests: `onboarding/interview/__tests__/onboarding-preamble.test.ts` (pins the
  import offer present + positioned name→import→work, absent when not offered,
  asked once); `channels/adapters/app-ws/__tests__/import-progress.test.ts`
  (envelope is a union member, body optional, fans through `registry.send`).
- Docs: `docs/SYSTEM-OVERVIEW.md` updated (onboarding import-offer-first note +
  app-ws frame `#7 live import progress`).

**Why it's safe.** Additive: a server-only union member (the Expo subset union +
parity test are untouched and still green). The #126 fixes (import RESULT renders,
centered column, no reactions) are unaffected — the analysis body still lands via
the existing path; this only un-drops the intermediate progress frames. tsc clean
(root + chat-react leaf); app-ws (107) + onboarding-interview (912) suites green.

## 2026-06-29 — M1: stale-client-store auto-reset on server reinstall

**Problem.** A fresh Neutron Open server reinstall showed a STALE chat: the web
client's offline local store (`@neutronai/chat-core` OPFS snapshot, origin-scoped
`neutron-chat-core.json`) — and the mobile op-sqlite store (`neutron-chat.db`) —
survive a server uninstall+reinstall behind the same origin/device. The server's
per-topic `seq` counter restarts at 1 on a fresh install, but the client resumed
forward from its OLD high local cursor (`resume after_seq=<high>`), so the
server's `replayAfter` returned nothing and the dead server's transcript
rendered forever. `session_ready.last_seen_seq` already carried the server's
high-water seq but NO client code read it.

**Fix (seq-regression reset detection, no flags).**
- `chat-core/types.ts` — new `parseSessionReadyMaxSeq(frame)`: extracts
  `last_seen_seq` from a `session_ready` frame, `null` when absent/malformed.
- `chat-core/sync-engine.ts` — new `SyncEngine.reconcileServerReset(topic, serverMaxSeq)`:
  when the server's reported seq is a known number **strictly lower** than a
  **non-zero** local cursor, the server regressed (was wiped/reinstalled) →
  `store.clear(topic)` so the following `resume` re-syncs from `after_seq=0`.
  Conservative: no-op when seq is absent (`null`), when server seq ≥ local
  cursor (normal reconnect/cold-open/first-connect), or when the local cursor
  is 0 (nothing cached).
- `chat-core/web-session.ts` + `app/lib/chat-core/mobile-session.ts` — both
  `session_ready` handlers call `reconcileServerReset(frame)` BEFORE
  `resumeAndFlush()`, and emit a UI change on a real reset so the stale messages
  drop immediately (before the replay lands). The detection lives in the SHARED
  `SyncEngine`, so web (OPFS) and mobile (op-sqlite) both benefit.
- `app/lib/ws-envelope.ts` — added `last_seen_seq?` to `AppWsOutboundSessionReady`
  for type parity with the server envelope (`channels/adapters/app-ws/envelope.ts`).

**Server change (Codex P1a).** `gateway/http/app-ws-surface.ts` now ALWAYS sends
`session_ready.last_seen_seq` when a durable log is wired, **including 0**.
Previously it omitted the field on 0, so a freshly reinstalled server whose log
was still empty at connect time (the welcome messages persist AFTER
`session_ready`) sent no signal → the stale client never reset on its first
post-reinstall load. A present `0` is now an affirmative "this server has nothing
for the topic" signal; the field stays ABSENT only when there is no durable log
at all (where `null` → never clear, protecting the only copy). `open/composer.ts`
wires the durable `AppChatStore` chat_log, so Open always reports the real value.

**No-data-loss on reset (Codex P1b + P2).** Added a `Store.clearAckedTranscript(topic)`
primitive (InMemory + OPFS + Sqlite) that drops only the ACKED (server-sequenced)
transcript in a SINGLE atomic store operation, preserving un-acked local sends
(status `queued`/`sent`, no server seq). `reconcileServerReset` calls it instead
of a read-clear-reinsert cycle, so a send that races the reset can't be lost in a
snapshot→clear window (it's either an already-kept non-acked row or arrives
after). The preserved sends are re-driven against the fresh server by the
following resume/flush (idempotent on `client_msg_id`).

**Not changed.** No new local-store namespace keyed on a server instance id (the
frame exposes no per-install id today; the seq-regression heuristic is the
pragmatic detector per the bug note).

**Tests.** `chat-core/__tests__/session-ready.test.ts` (parser edge cases),
`chat-core/__tests__/sync-engine.test.ts` (reconcile: clears on regression;
no-op on ≥, null, cursor-0, un-sequenced optimistic sends),
`chat-core/__tests__/web-session.test.ts` + `app/__tests__/chat-core-mobile-session.test.ts`
(end-to-end: stale transcript cleared + `resume after_seq=0` + fresh replay
renders clean; normal reconnect preserves; absent `last_seen_seq` never wipes).

---

## Hobby projects + one-time agentic per-project kickoff (2026-07-01)

**Problem.** Two gaps in what onboarding produces on a fresh install: (1) the
interview asks about outside-work interests/hobbies but those answers materialized
NOTHING (only work/primary projects became real projects); (2) each materialized
project's opening was a static one-liner ("want me to X?") with no real agentic
work — no drafted doc, no deadline offer.

**PART A — hobbies materialize as projects.** Hobby answers land in
`phase_state.non_work_interests` (`{name, cadence_hint?}`, written by the
post-turn extractor) and `import_result.inferred_interests` (`{name, basis?}`) —
fields `resolveProjects` in `build-onboarding-finalize.ts` never read, so hobbies
reached persona-gen (USER/SOUL.md) but never a `projects` row / on-disk
`Projects/<id>/` repo. Added `collectInterestProjects` as a THIRD union source
(after import-proposed + interview-named work projects), mapping each interest to
`CapturedProject{name, rationale?, is_interest:true}` (rationale carried from an
import interest's `basis`). The existing `seen`/`dropped` dedup makes the superset
safe: a work project of the same name wins the slug dedup; a curation-dropped
hobby is excluded. The materializer is source-agnostic (identical repo + doc set
for hobby and work); `is_interest` only steers the kickoff. Added `is_interest?`
to `CapturedProject` (`onboarding/wow-moment/action-types.ts`).

**PART B — one-time agentic kickoff.** `emitProjectOpenings` now first asks a
`ProjectKickoff` (`gateway/wiring/build-project-kickoff.ts`) for a
richer opening, behind a HARD data-sufficiency gate ("better nothing than a bad
job"). Best-fit action per project:
- `draft-doc` (rich work): compose a real starting plan via the new
  `build-project-kickoff-composer.ts` (same CC-substrate discipline as
  `build-project-doc-composer.ts` — `getBestModel`, AbortController budget,
  throw-on-empty), write it create-if-missing under `Projects/<id>/docs/starting-plan.md`,
  present a tappable `[Starting plan](docs:/<id>/starting-plan.md)` marker, and
  re-index the project page to GBrain recall via `buildProjectPageIndexer`.
- `deadline-offer` (work with a real upcoming `import_result.proposed_tasks`
  deadline related to the project by name/topic, within a 60-day window): name the
  deadline(s) and OFFER a reminder — never auto-created; the live agent's
  `reminders_create` handles an accept.
- `interest-research` (rich hobby): light starting-notes doc, same write+link+index.
- `interest-questions` (thin hobby): deterministic engaging questions (a hobby's
  meaty opening, never a bad artifact).
- `null` (thin work): fall back to the deterministic `buildDeterministicProjectOpening`.

**One-time, no recurring machinery.** The kickoff runs inside finalize's single
per-project opening pass and emits under the SAME `onboarding_opening:<project_id>`
durable dedupe key as the deterministic opening, so it fills the ONE opening slot
and the on-connect recovery (`open/composer.ts:ensureProjectOpeningOnEntry`)
collapses onto it — no double-post. NO cadence / cooldown / on-enter refresh /
setting. Any doc-compose failure degrades to `null` (work) or engaging questions
(hobby), never a half-baked doc. The full wow `ActionRunner`/dispatcher is NOT
reused (it is a batch button-prompt path with a channel adapter + cron the
one-time plain-emit finalize has no surface for); the kickoff reuses its
trigger/gate CONTRACT plus `ProjectDocComposer`, `runtime/doc-links.ts`, and the
project-page indexer. `MaterializedProject` now threads `is_interest` + the
materializer's `MaterializeOutcome` (previously discarded) so the gate can read
`slice_chunk_count`/`summary_written`.

**Wiring.** `open/composer.ts` builds `projectKickoff` from the onboarding
Anthropic client (kickoff composer) + `buildProjectPageIndexer` (GBrain syncHook)
and passes it into `buildOnboardingFinalize` (optional dep; omitted on the LLM-less
path).

**Tests.** `gateway/wiring/__tests__/build-project-kickoff.test.ts`
(gate picks meaty-vs-prompt; draft-doc writes + presents a valid `docs:/` marker +
indexes; create-if-missing never clobbers; deadline offer names only related
upcoming deadlines and is offer-only; overdue/far-future excluded; thin hobby →
questions; rich hobby → research doc; compose failure degrades correctly).
`build-onboarding-finalize.test.ts` (hobby materialization from
`non_work_interests` + `inferred_interests`; hobby/work same-name dedup; dropped
hobby excluded; kickoff body emitted under the single opening dedupe slot with the
deterministic fallback for declined projects).

---

## M1 UX REDESIGN — backend data contracts (PR-1, 2026-07-02)

First redesign PR: the two design-independent backend contracts the redesigned
Work pane + project rail consume. NO feature flag, one code path, NO visual
change (PR-2+ build the UI on top of these).

### A. Per-run inner-step (`step_label`) + a live push that retires the 15 s poll

**Problem.** The outer `code_trident_runs.phase` sits at `forge-init` the WHOLE
inner build, and NOTHING pushed the inner workflow's checkpoint advances — the
web Work Board fell back to a 15 s poll (`WorkBoardTab.tsx`) to notice
building→reviewing→fixing, so a live build "looked frozen".

**`step_label` derivation (`trident/run-progress.ts`).** New exported
`deriveStepLabel(phase, inner_checkpoint)` + a `step_label: RunStepLabel` field on
`RunProgress` (`building|reviewing|fixing|merging|done|failed`). It REUSES the
`inner_checkpoint` the inner workflow already re-stamps at each phase boundary
(`checkpoint()` in `inner-workflow.mjs`); because checkpoints are END-of-phase
markers, each maps to the phase the run is CURRENTLY in — `forge-done`→reviewing,
`argus-request-changes`→fixing, `fix-round-N`→reviewing, `argus-approved`→merging,
terminal phases win. No new DB column (the spec's sanctioned "reuse the existing
RunProgress shape" path). Mirrored client-side in `work-board-client.ts` with a
`stepLabelFromPhase` fallback for a legacy/absent wire value.

**The live fan (`trident/tick.ts`).** New `TridentTransitionHook` +
`on_transition` option on `TridentTickLoop`. The loop re-loads every non-terminal
run each tick and, when a run's progress signature
(`phase|inner_checkpoint|round|pr|last_advanced_at`) differs from what it last saw
(a checkpoint advance, a launch, or a terminal transition), fires `on_transition`.
This is the ONLY place that can fan on the inner workflow's behalf — the workflow
runs detached and can only `sqlite3`-write, never reach the app-ws registry. The
fan is best-effort (own try/catch), signature-deduped (quiet when idle), and drops
a run's signature once terminal (no unbounded map growth). Plumbed
composer→`misc-input.ts` (`on_run_transition`)→`build-core-modules.ts`
(→`on_transition`).

**Composer wiring (`open/composer.ts`).** The `work_board_changed` fan is
extracted to a named `fanWorkBoardChanged(scopeKey)` shared by the store's
`onChange` AND the run-transition hook. `on_run_transition(run)` fans
`fanWorkBoardChanged(run.project_slug)` (a board-bound run's `project_slug` IS its
item's board scope key) + `emitProjectsChangedIfChanged`. `WorkBoardTab.tsx`'s
15 s poll is retained as a FALLBACK only (dropped-frame resilience + the
elapsed/stall clock).

### B. Per-project rail fields (`activity` / `preview` / `preview_from` / `live_runs`)

`readProjectRows` (`open/composer.ts`) — feeding both the `projects_changed` frame
and the page bootstrap — now derives four per-project fields:

- **`activity`** (`idle`/`working`/`attention`) — `working` = a live chat turn
  (tracked at the `agent_typing` start/end seam via `activeChatProjects`) ∪ any
  board item bound to a live non-terminal run ∪ any `inline_active` item;
  `attention` (WINS over working) = any not-done item whose bound run is `failed` ∪
  any live run stalled past the display threshold.
- **`preview` / `preview_from`** — the project's last chat message
  (`app_chat_messages`), markdown-stripped + server-truncated to ~90 chars, plus
  the sender (`user`/`agent`) for a `You: ` prefix.
- **`live_runs`** — count of the project's live bound runs (Work-tab badge / pane
  toggle count).

The precedence + truncation are a PURE, unit-tested module (`open/project-rail.ts`:
`deriveProjectActivity`, `truncatePreview`, `stripMarkdownForPreview`). The chat
turn also fans `projects_changed` at the typing seam (diff-gated). Frame type
extended in `channels/adapters/app-ws/envelope.ts`; client parses the fields in
`controller.ts` into the `ProjectTab` type (`config.ts`), all optional on the wire
for back-compat.

**Tests.** `trident/run-progress.test.ts` (step_label for every checkpoint + the
full building→reviewing→fixing→reviewing→merging→done arc); `trident/tick.test.ts`
(on_transition fires on first-observation + each checkpoint advance + terminal,
never on a no-op; a throwing fan never aborts the tick); `open/project-rail.test.ts`
(activity precedence incl. attention-wins; preview markdown-strip + truncation).
`tsc` clean (root + `trident` + `landing/chat-react` leaf); leak-gate SILENT.

**Cross-model review fixes (Codex, 2 × P2).** (1) *Stalled runs now fan a rail
refresh* — `progressSignature` (`trident/tick.ts`) includes a `stalled` boolean
(off an injectable clock vs `STALLED_WARN_MS`), so the ONE moment a live run ages
past the display-stall threshold flips the signature and fires `on_transition`
(→ rail `attention`); it flips at most once per stall, so no per-tick churn. (2)
*Failed builds stay surfaced as attention* — a failed run is auto-detached from
its item on terminal reconcile, so the bound-item check alone was fleeting;
`readProjectRailExtras` now also reads `TridentRunStore.latestByProjectScope` — if
the scope's most-recent run is `failed` and the project still has a not-done item,
`attention` persists until a fresh run supersedes it. Tests added for both (tick
stall-crossing fan; `store.latestByProjectScope` scoping).

---

## Work-Board project-scope fix — agent tools + trident builds scope to the ACTIVE project (P0)

**Symptom (reproduced on the box 2026-07-02).** Chatting inside a NAMED project
(e.g. "Tabs"), the agent created Work items + kicked trident builds, but BOTH the
`work_board_items` rows AND the `code_trident_runs` rows came out under the
owner/instance slug (the General bucket) instead of the project — so they were
invisible in the project's Work tab and mis-filed onto General. Every agent-started
work item / build from a named project landed on General.

**Trace (the ACTUAL path the builds took).** The two candidate items were AGENT-
created, so the path is the agent-native MCP tool path — NOT the `/code` filter
(which is defined in `gateway/boot-helpers.ts` but **never constructed** in Open —
not a live path) and NOT the HTTP ▶ route (`gateway/http/work-board-surface.ts`,
which already derives `scope = workBoardScopeKey(resolved.project_slug, <URL
project_id>)` correctly). The drop point, step by step:

1. Agent calls `work_board_add` / `work_board_dispatch_build` over the native-MCP
   bridge → the spawned `claude`'s tools-bridge POSTs `/tool-call` to the warm-REPL
   sink (`persistent-repl-substrate.ts`).
2. The sink dispatched `replToolBridge.dispatch({tool_name, args, call_id})` with **no
   active project** — the warm REPL is topic-agnostic (documented Codex r1 [P2]: it
   binds `topic_id:null`), so there was no per-turn project on the call.
3. `McpServer.dispatch` → `currentTopicContextOrSystem(call_id, this.project_slug)`:
   no bound `TopicContext` ⇒ system shape with `project_slug = this.project_slug` (the
   **instance slug**).
4. The `work_board_*` handlers (`work-board/agent-tool.ts`) + the trident build tools
   (`trident/work-board-build-tool.ts`) passed that `ctx.project_slug` straight to the
   store / `dispatchBoardBoundBuild`. Via `workBoardScopeKey(owner_slug, /* empty */)`
   → `owner_slug` = the **General board**. ⇐ **exact drop point.**

**Fix — thread the active project end-to-end.** The warm conversational REPL is keyed
per-project (`poolKeyFor` folds `metering_context.project_id`), so a session serves
exactly one project scope for its lifetime:

- `ReplSession.projectId` is stamped from `options.project_id` at spawn; the
  `/tool-call` sink looks the session up by `session_id` (the tools-bridge already
  POSTs it) and threads `project_id` into `replToolBridge.dispatch({… project_id})`.
- `ReplToolBridge.dispatch` + `McpServer.dispatch` gained an optional `project_id`;
  `currentTopicContextOrSystem` returns it (preferring a bound `TopicContext`'s own
  `project_id` on the `resolveBound` path). New field
  `ToolCallContext.project_id` (the ACTIVE project; NULL = General/system).
- `work_board_*` (`work-board/agent-tool.ts`) and `work_board_dispatch_build` /
  `work_board_start` (`trident/work-board-build-tool.ts`) now resolve their scope via
  `workBoardScopeKey(ctx.project_slug, ctx.project_id)`, threaded to every store call,
  the board `get`/`attachRun`, `resolve_task`, and the created `code_trident_runs` row.
- The per-turn **injected** `<work_board>` block is scoped the same way
  (`build-live-agent-turn.ts` passes `turn.project_id`; composer `workBoardSnapshot`
  wraps `workBoardScopeKey`), so the board the agent re-grounds on == the board its
  writes land on. (`availableServicesSnapshot` already did this; the work board didn't.)

General (no active project / `'general'`) still scope-keys to the owner slug — the
"pre-existing rows map to General" behaviour (`work-board/store.ts:120-153`) is
preserved. One code path, no feature flags.

**Spec-conformance.** SPEC (#179): every project has its own board keyed by scope-key;
agent + build writes scope to the active project. CURRENT (before): agent
`work_board_*` + build-dispatch tools fell back to the instance/General slug. GAP:
active `project_id` not threaded into the agent tools + run creation. THIS PR: threads
it via the per-project session scope so named-project work scopes correctly; injected
board matches. OUT: General's Work *view* (UI tab, see below); redesign geometry.

**General's Work view — deferred (stated per spec).** General IS a first-class board
bucket (`owner_slug`) and the HTTP surface serves it, but the web tab-set builder
(`landing/chat-react/ProjectShell.tsx`, `if (isGeneral)` at ~L325) excludes the Work
tab for General. That file is owned by the parallel redesign PR that turns the desktop
Work tab into a slide-out; adding a General Work tab here would collide with it and be
immediately obsoleted. Deferred to that PR with an actionable note (drop the
`isGeneral` Work exclusion so General gets the same Work surface). No backend blocker —
General's board is already reachable.

**Tests.** `work-board/agent-tool.test.ts` (add/list/update/complete scope to the
active project; General regression guard; cross-scope write is a no-op).
`trident/work-board-build-tool.test.ts` (a build in project "acme" scope-keys the run
`project_slug` + board `get`/`attachRun` + `resolve_task` to acme; General → owner
slug). `mcp/server.test.ts` (dispatch binds bound-context `project_id`; threads the
caller `project_id` with no bound context; null otherwise). `tool-bridge.test.ts` (a
`/tool-call` from a session spawned under project "acme" threads `project_id:'acme'`
into dispatch; an unknown session → null). `tsc` clean (root + `trident`); leak-gate
SILENT.

**Cross-model review fix (Codex, 1 × P2).** *`dispatch_agent` now scopes to the
active project too.* The agent-native `dispatch_agent` tool is also board-bound, but
its `DispatchService` looked the `board_item_id` up (+ `attachRun`/`clearRun`) under
the service's own owner `project_slug` — so after this PR moved `work_board_add` onto
the active project, an agent that created/listed an item in project X and then
`dispatch_agent`'d against it would 404 as `unknown_board_item`. Threaded a
`DispatchRequest.board_scope` (defaults to the owner slug) through
`dispatch → launch → report`; the tool sets it to
`workBoardScopeKey(ctx.project_slug, ctx.project_id)`. Tests: `agent-dispatch/
service.test.ts` (board get/attach/clear all key on the threaded scope; default =
owner slug), `agent-dispatch/surface.test.ts` (the tool builds the req with the
active-project `board_scope`). The dormant `/dispatch` *chat command* is not wired in
Open (like `/code`); it keeps the owner-slug default, unchanged.

## UX Batch-4 (#347/#348/#349/#350) — mobile/web-mobile chat-react polish (2026-07-03)

Four fixes from the owner's live dogfood, all in the responsive web chat-react client
(no feature flags, one code path, both light+dark + desktop preserved).

**#347 — the cold-start "Waking up…" pill duplicated + persisted as a timestamped
bubble.** The pill is a single-slot `systemNotice` rendered as a centered
ephemeral pill *outside* the message list, so duplicates/bubbles came from two
races, now closed on three sides:
1. `landing/chat-react/controller.ts` — a `replyStartedThisTurn` latch (set on the
   first stream token AND on a durable agent reply, reset on each `send()`). Once
   a real reply has started, a LATE cold-start ack frame is DROPPED instead of
   re-arming the pill below the answer.
2. `controller.ts` `computeVm` — durable rows whose body matches `isColdStartAck`
   are filtered out of the bubble list entirely, so a legacy/leaked persisted ack
   can never hydrate as a timestamped/avatar agent bubble (the sync engine
   persists a durable `agent_message` even though `onFrame` also shows it as a
   pill — that double-render was the bug).
3. `gateway/wiring/build-llm-call-substrate.ts` + `build-live-agent-turn.ts`
   — `collectTokensToString` takes an optional `onFirstToken` callback; the live
   turn passes `clearAckTimer` so the delayed cold-start ack is cancelled the
   moment the first reply token streams (not only at turn-settle).
Tests: `controller.test.ts` (late-ack dropped + fresh turn re-opens the pill;
durable ack never a bubble); substrate suite green.

**#350 — mobile tab-bar overhaul.** `landing/chat-react/ProjectShell.tsx` +
`chat-react.html`:
- Mobile (`<1024px`, the complement of the JS `min-width:1024px` desktop gate)
  stacks `.car-topbar` into a column: the workspace title on its own line, the
  tab band on the row below. Desktop keeps the single row.
- The cycling `<ThemeToggle/>` was removed from the top bar on ALL viewports; a
  labeled 3-way `ThemeControl` (System/Light/Dark segmented radiogroup, new export
  in `ThemeToggle.tsx`) now lives in General → Admin → **Appearance**
  (`IntegrationsTab.tsx`).
- Overflowing tabs collapse into a right-aligned "⋯" menu instead of
  `overflow-x: auto` scrolling. New `tab-overflow.tsx`: pure `computeVisibleCount`
  (unit-tested), a `useTabOverflow` measurement hook (hidden mirror row +
  `ResizeObserver`), and an accessible `OverflowMenu` (button `aria-haspopup`/
  `aria-expanded`; `role=menu`/`menuitem`; Esc + outside-click close; focus the
  first item on open, return focus on close; Arrow/Home/End navigation).
Tests: `tab-overflow.test.ts`. Browser-verified at 390×844: title stacked, no
viewport h-scroll (`.car-app { overflow:hidden }` clips the mirror), ⋯ lists the
overflow tabs, theme control flips `data-theme` + persists.

**#348 — mobile Work tab pulses blue while a build runs.** `.car-tab-workpulse`
(new keyframe, `--phase-build-*` tokens, reduced-motion → static tint) is applied
to the `workboard` tab button only when `!isDesktop && summarize(items).running>0`.

**#349 — mobile "job starting" top drawer.** New `work-activity.tsx`:
`useWorkActivity` subscribes once to the active scope's `onWorkBoardChanged`,
seeds silently on the first frame, and announces a RISING running count as
`justStarted`; `JobStartDrawer` (mounted first child of `.car-app`, mobile-only)
slides down (`--ease-out`, reduced-motion → no slide), auto-retracts after ~3s,
and swipe-up / ✕ dismisses. Tests: `work-activity.test.tsx` (itemRunning; seed vs
announce; per-project filter; drawer render/auto-close/✕). Browser-verified visual.

**#375 — K10: public root `SPEC.md` + Ralph governed mode (world-class refactor
window CLOSED).** The refactor window (`docs/plans/2026-07-02-world-class-refactor-plan.md`)
is complete. K10 introduces the public master `SPEC.md` (governance preamble,
Architecture §2.1-2.8, § Phases → Steps, immutable Decisions Log), removes it from
leak-gate `FORBIDDEN_EXACT` (inverting the RT1 tripwire), repoints the 11
`TODO(K10)` comments, and lifts the window's `resolveRalph=false` override so
`detectRalphMode` governs trident builds whose workspace is a checkout of this
tree (NOT arbitrary user-project `/code`, which build in a fresh SPEC-less
`Projects/<slug>/code` workspace). **Window tail shipped this session:** the
perfect-recall lane (RB1 #361 memory-index / RB2 #363 reflection re-splice / RB3
#369 reflect-cron / RB4 #366 temporal-invalidation, RC1-3 Nexus), the naming lane
(N1 #362 OwnerHandle brand, N2/N3 #367 `internal_handle`→`owner_handle`, N4
#370/#372 `project_slug`→`owner_slug` instance-sense, N5 #368 dir-hygiene, N6 #371
ChannelKind data-migration, N7 #364 ghost-refs, N8 #365 codename glossary), plus
F5/F6/F8/O2-O8/S1-3/X5/X6/W2/W3a and Managed M4/M5/M6. **Owner-adjudicated
decisions:** MG-3 = KEEP (OSS-split composer seam, INVARIANTS #96); N3-credential =
DEFERRED (no live renaming owners → the credential-loss incident can't fire;
INVARIANTS #107). Frozen boundaries (`project_slug` in SQL columns / JWT+healthz
wire keys / `ResolvedAuth` types / published Cores SDK / project-sense work-board)
are intentional, documented.

**#377–#392 — post-window audit punch-list + closeout.** A fresh-eyes audit certified
the window production-solid; its punch-list was fixed: **#377** fail-closed owner-bearer
gate on BOTH upload handlers (single-shot + chunked) for wide binds (a hole in the
S1/S2 fail-closed guarantee — unauthenticated ZIP write on `0.0.0.0`); **#378** wired
`readOwnerTimezone` into the nudge cron (ISSUES #40 read side); **#387** a discriminating
sender-registry propagate regression (INVARIANTS #36/#70; the old test was
non-discriminating); **#388** repointed the 15 importers of the one-release `core-sdk`
shim to `@neutronai/cores-sdk/manifest` + deleted the shim package (52→51 tsconfigs);
**#391** docs reconciliation (plan §17 + STATUS ledgers → git ground truth,
window-CLOSED banner, SPEC §2.2 completed, stale SYSTEM-OVERVIEW/INVARIANTS/AGENTS
pointers + dangling §N citations fixed); **#392** owner-timezone WRITE path closing
ISSUES #40 end-to-end — web + mobile detect the IANA zone (`Intl…timeZone`) and thread
it on every app-ws connect (initial + project-switch + reconnect); the server sanitizes
(trim/64-cap/IANA-validate), gates the persist on the OWNER identity (`user_id ===
OWNER_USER_ID` — a shared-project guest cannot rewrite the owner's zone), and writes via
`writeOwnerTimezone` only on change. Deferred (tracked as GitHub issues #379–#389): the
dead-code cleanup (two careful attempts each hit a dead-but-INTENTIONALLY-RETAINED
landmine — `max-oauth-multi-sub` is Managed-consumed, the wow-moment cluster is reserved
for a queued plan — so an aggressive sweep is contraindicated here) + the known
engineering follow-ups (RA2/F8/P6/O5/F6/Core-scheduler) + W3 transcript unification. A
second fresh-eyes certification audit followed this closeout.

## 2026-07-21 — Executor-mode reminders Task 7: bundled generic read-only example rituals (WIRED + SERVED)

Shipped the first two ENGINE ritual defs so a fresh Neutron install has working
read-only ritual examples out of the box — the ritual plumbing (tasks 2-6, merged
`63fe4119`) went live with ZERO registered defs; this closes that gap while staying
UNAPPROVED (task 8 owns the owner's approval act).

- **Templates** — `reminders/rituals/morning-brief.md` + `reminders/rituals/evening-wrap.md`:
  GENERIC, instance-agnostic read-only prompts that Glob `Projects/*/STATUS.md` from
  the instance root, read them (+ any docs they point at), and post a short digest.
  They are the ENGINE default — NOT the owner's the legacy harness ritual content (that is OWNER data
  via import). No `~/legacy`/`gog`/`gh`/`entities`/Telegram/Bash references (static
  half of the ported-prompt silent-no-op guard).
- **`reminders/bundled-rituals.ts`** — `BUNDLED_RITUAL_DEFS` (frozen; exactly
  `morning-brief` + `evening-wrap`, each `scope:'instance'`, `tool_surface:['Read',
  'Glob','Grep']`, `egress:'none'`, `silent:false` — zero intersection with
  `GATED_WRITE_TOOLS`, so the fire-time gate never trips); `BUNDLED_RITUAL_TEMPLATES_DIR`
  + `bundledTemplatePathFor(id)` (module-dir resolved, the `prompt-path.ts` pattern);
  `seedBundledRituals({rituals_dir,log?})` — COPY-IF-ABSENT into `<owner_home>/rituals/`
  (an owner-edited / imported file is NEVER clobbered — from first seed on it is owner
  data), NEVER throws (mkdir + each copy try/catch → log + continue; a failed seed
  surfaces later as a durable `missing_prompt` fire-time skip); `registerBundledRituals(
  registry)` (makes defs KNOWN — does NOT approve them).
- **`open/composer.ts` `ritual_executor_factory`** (was ~:1885) — the closure now
  builds the registry rooted at `<owner_home>/rituals`, `seedBundledRituals(...)`,
  `registerBundledRituals(registry)`, and passes that registry to
  `createRitualExecutor`. So a fresh boot SEEDS + REGISTERS both rituals — WIRED. They
  fire only after the owner's task-8 approval; an unapproved fire lands a durable
  `code_ritual_runs` 'skipped'/'unapproved' row (proven below).
- **Tests** — `reminders/bundled-rituals.test.ts` (11 fast units): def shape incl. the
  no-Bash `GATED_WRITE_TOOLS` pin; template grounding + no-the legacy harness-isms; seed
  copy-if-absent / idempotency / never-clobber; register→2 frozen defs; the
  UNAPPROVED-by-default fire through the REAL `ApprovalManager` (zero approval rows →
  'skipped'/'unapproved', turn called 0×, nothing spawned); the approved spec-shape pin
  (turn once, tools/prompt-bytes/cwd/timeout/model exact). `reminders/bundled-rituals.e2e.test.ts`
  (`NEUTRON_PTY_E2E=1`-gated, mirrors `dev-channel-pty-bind.e2e.test.ts`): each SHIPPED
  template, run with the real ritual base prompt + read-only surface against a planted
  fixture instance, produces output citing fixture markers (RELAY-4471 / CERT-ROTATE-9 /
  HARBOR-812) — the LLM-behaviour half of the silent-no-op guard. Ran green on this box
  (`claude` 2.1.215, both rituals, ~46s).
- Suites: `bun test reminders/` 327 pass / 2 skip (the gated e2e); wiring guards
  (`build-core-modules-ritual-executor.test.ts`, `open-composition-fields-characterization.test.ts`)
  green; `tsc -p reminders` + `tsc -p open` clean; eslint + dependency-cruiser clean.
- OUT OF SCOPE (later RALPH tasks): scheduling/approval UX (task 8), memory-tier work
  (task 9), SYSTEM-OVERVIEW ritual-executor section (task 10), any writing/Bash ritual
  (stays gated on the OS-sandbox sprint).

## 2026-07-22 — Dogfood fix #429 task 3: drop the manual Build/Research picker; server auto-classifies task_type

Removed the web Work Board add-item Build/Research dropdown and moved the build-vs-research
decision to a single server-side auto-classifier applied on create when the caller omits
`task_type`. Web-only UI change — mobile (`app/app/projects/[id]/workboard.tsx`) already sent
`{ title }` only and carries no dropdown, so it needed no change.

- **New `work-board/task-type-classifier.ts`** — the ONE server-side classification module.
  Exports `classifyWorkBoardTaskType({ title, llm: LlmCallFn | null, timeout_ms? })
  → Promise<WorkBoardTaskType>` (TOTAL — never rejects), `keywordTaskTypeFallback(title)`
  (deterministic: research verbs / interrogative openers → `research`, else `build`),
  `CLASSIFY_SYSTEM_PROMPT`, and `DEFAULT_TASK_TYPE_CLASSIFY_TIMEOUT_MS` (2.5s). LLM-primary:
  a one-word FAST_MODEL classify races a timeout; a `null` llm / timeout / junk / both-or-
  neither / reject all degrade to the keyword fallback. No hardcoded model id — `LlmCallFn`
  carries no model, so the composer injects FAST_MODEL. `work-board/package.json` gains
  `@neutronai/contracts` (bottom dep-cruiser band — legal from work-board's services band).
- **`gateway/http/work-board-surface.ts`** — `WorkBoardSurfaceOptions` gains an optional
  `classify_task_type(title) => Promise<WorkBoardTaskType>`. `handleCreate` classifies ONLY
  when the request omits `task_type`, BEFORE the create_card / store.create branch, so both
  the on-disk-spec path and the plain create persist the classified value. An explicit
  `task_type` from any caller short-circuits (never re-classified); a defensive catch falls to
  the store default ('build') if a wired classifier ever throws. Absent seam → today's
  store-default behavior (the #379 back-compat test is unchanged).
- **`open/composer.ts`** — builds `workBoardClassifyLlm` via
  `buildAnthropicLlmCall({ substrate: llmCallSubstrate, model: FAST_MODEL })` (null on an
  LLM-less box → keyword-only) and wires `classify_task_type` into `createWorkBoardSurface`
  unconditionally (it degrades internally).
- **`landing/chat-react/WorkBoardTab.tsx`** — deleted the `<select className="cwb-add-kind">`,
  the `newTaskType` state + reset, the `WorkBoardTaskType` import, and the create's `task_type`
  arg + deps entry. The add-form is now a plain input + Add; a create omits `task_type`. ▶
  startBuild/startResearch routing (reads the item's stored `task_type`) is untouched.
- **Tests** — new `work-board/task-type-classifier.test.ts`; extended
  `gateway/http/work-board-surface.test.ts` (classify-on-omit across both branches, explicit-
  wins, reject→default, create_card path) and `landing/chat-react/__tests__/work-board-tab.test.tsx`
  (no picker in the add-form; create body omits `task_type`). `bun test work-board` 230 pass,
  `bun test gateway/http/work-board-surface` 38 pass, landing tab+client 37 pass; `tsc` clean
  for work-board / open / gateway / landing; eslint + the new depcruise edge clean. NO FEATURE FLAGS.

## 2026-07-22 — Dogfood fix #429 task 7: research_deep now actually researches — SONNET_MODEL default + parse-failure retry + tools_available grounding gate

**Symptom (verified live).** A `research_deep` task died with an empty brief: the dispatched
sub-agent ran ~31s, made ZERO tool calls, and returned non-JSON prose, so `extractJson` threw
'no JSON object found' and the task failed with no recovery. Two root causes: (1) the sub-agent
defaulted to a hardcoded Haiku literal (`sub-agent.ts` `DEFAULT_SUB_AGENT_MODEL`) and `deep()`
passed no `model`, so Haiku was live in production despite a comment claiming FAST_MODEL was
passed explicitly (false); (2) `deep()` was single-attempt — unlike `start()`'s 2-attempt
parse-error-fed-back loop — so one malformed response discarded the whole research budget.

**Three-part fix (NO FEATURE FLAGS).**
- **Model.** `DEFAULT_SUB_AGENT_MODEL` is now `SONNET_MODEL` (env-overridable via
  `NEUTRON_SONNET_MODEL`), imported from `@neutronai/runtime/models.ts`. Deep research needs
  real reasoning + sustained tool-use discipline. The second hardcoded Haiku literal in
  `research-orchestrator.ts`'s error-path run metadata (was `input.tools !== undefined ?
  'unknown' : 'claude-haiku-...'`) now records `DEFAULT_SUB_AGENT_MODEL` — recording Haiku after
  the switch would be a lie. No `claude-*` literal remains anywhere in `cores/free/research/src`.
- **Retry.** `deep()` is now a 2-attempt loop mirroring `start()`. `bumpAttempt` moved inside
  the loop. A parse / schema / zero-tool failure on attempt 0 feeds specific feedback
  (`buildParseRetryFeedback` / `buildSchemaRetryFeedback` / `ZERO_TOOL_FEEDBACK`) into the
  sub-agent's user prompt behind a new `RETRY_FEEDBACK_MARKER` (`[RETRY - PREVIOUS ATTEMPT
  REJECTED]`, appended AFTER the query so canned-dispatcher `includes(query)` matching keeps
  working; system prompt stays keyed on the original query so the engineering-rider heuristic
  is stable) and retries once. The same failure on attempt 1 is terminal ('parse error on
  retry: …' / 'schema error on retry: …' / 'sub-agent made zero tool calls on retry - ungrounded
  brief rejected'). Dispatch-level errors (concurrency / timeout / transport) still fail
  immediately, NOT retried. Claims-insert + sources-cited assertion stay single-shot (explicit
  non-goal). One `research_sub_agent_runs` row is recorded per attempt.
- **Grounding gate + production-safety seam.** New dispatcher-reported `tools_available` flag
  (`RuntimeSubAgentDispatchResult.tools_available?`, surfaced on `ResearchSubAgentResult`). The
  zero-tool grounding gate rejects a brief made with zero tool calls ONLY when the dispatcher
  reported `tools_available === true`. The v1 production dispatcher
  (`buildRuntimeResearchSubAgentDispatcher`) makes a single tool-less Messages-API call and now
  explicitly reports `tools_available: false`, so the gate is INERT in production and cannot
  brick a real deep run. It arms automatically when the real agentic tool loop ships —
  **plan task 10** (tool-call passthrough) is the follow-up that flips it to `true`.

**De-Haiku.** User-visible strings no longer claim Haiku: `chat-commands.ts` (deep-complete +
kickoff messages), `package.json` `research_deep` tool description ('research sub-agent harness
(SONNET_MODEL default)'), and doc headers across `sub-agent-prompt.ts` / `index.ts` /
`manifest.ts` / `substrate-runtime.ts` / `README.md` / `AGENTS.md`. The two remaining Haiku
mentions (`substrate-runtime.ts` `default_model` doc + `backend.ts` synthesis-fallback doc)
describe FAST_MODEL fallbacks that stay true.

**Files.** `cores/free/research/src/sub-agent.ts`, `.../research-orchestrator.ts`,
`.../substrate-runtime.ts`, `.../chat-commands.ts`, `.../sub-agent-prompt.ts`, `.../manifest.ts`,
`cores/free/research/index.ts`, `cores/free/research/package.json`, `README.md`, `AGENTS.md`.
**Tests.** `__tests__/orchestrator.test.ts` gains a deep-path retry+grounding suite (T1
reproduce-then-fix the live incident; T2 both-non-JSON fail; T3 schema-retry; T4 zero-tool retry;
T5 zero-tool both fail; T6 production-shape do-not-brick guard; T7 concurrency metadata records
`DEFAULT_SUB_AGENT_MODEL`; T8 grounded happy-path single dispatch); `__tests__/sub-agent.test.ts`
gains T9 (default === SONNET_MODEL), T10 (retry_feedback threading), T11 (tools_available
passthrough). `bun test cores/free/research` 193 pass / 2 skip; `tsc -p
cores/free/research/tsconfig.json` clean; `gateway` research-core production-composer +
cores-tool-dispatch guards 23 pass; eslint clean.

---

## 2026-07-22 — task 9 — work-board: generic terminal status transitions clear inline_active

**Root cause (verified live in tenant DB).** A work-board item reaching a terminal status
(`done`/`failed`) via the GENERIC `update()`/`complete()` path left `inline_active=1` — the
completion ack reached Telegram but the card stayed in "inline active" state. The specialized
`attachRun()`/`detachRun()` methods already cleared `inline_active=0` as part of their
run-binding transitions, but the generic path only wrote `inline_active` when the caller's patch
explicitly included it; `complete()` is `update({ status:'done' })` with no `inline_active` key.

**Fix (`work-board/store.ts` `update()`).** Added a `terminalTransition` boolean (computed
inside the transaction callback, after the `current === null` guard, so it safely reads
`current.status`). On any REAL status transition to `'done'` or `'failed'`: (a) suppress the
caller's explicit `patch.inline_active` push (avoids a duplicate SET column) and (b) push
`inline_active = 0` unconditionally. Non-terminal transitions and no-status patches preserve
today's behavior byte-identical. No data backfill for already-corrupt rows (out of scope).
`attachRun`/`detachRun` are NOT consolidated — they have legitimately different run-binding
semantics (owner-pinned design).

**Tests (`work-board/store.test.ts`, 4 new reproduce-then-fix tests).** T1 `generic complete()
clears inline_active` (the live bug path — create, set inline_active=true, complete(), assert
status='done' + completed_at not null + inline_active=false both returned AND persisted); T2
`generic update to failed clears inline_active`; T3 `terminal clear wins over explicit
inline_active:true in the same patch`; T4 `non-terminal status transition preserves
inline_active`. All 264 work-board tests pass; `tsc -p work-board` clean; consumer tests (38
gateway/http/work-board-surface + 19 work-board/agent-tool) still pass.

---

## 2026-07-22 — Argus r2 BLOCKER fix — onboarding/interview: patchPhaseState (CAS update-if-present) replaces upsert in live personality suggester

**Root cause (Argus r2 blocker).** `live-personality-suggestions.ts` used
`stateStore.upsert({..., preservePhaseAndTimer:true})` to persist memo picks from the
background personality suggester. While `preservePhaseAndTimer` correctly preserved the live
row's phase and timer when the row existed, it did NOT protect against the race where the row
was admin-reset (deleted) between the background task's re-read and the upsert write: the
absent-row branch of `upsert()` fell into the INSERT path, recreating the row with stale
`phase`/`last_advanced_at` from the stale pre-read snapshot — effectively undoing the admin
reset.

**Fix.** Added `patchPhaseState(owner_slug, user_id, patch)` to the `OnboardingStateStore`
interface (`onboarding/interview/state-store.ts`) with update-if-present / CAS semantics:
always preserves `phase` and `last_advanced_at`; returns **null** and skips the write entirely
when the row is absent (never inserts). Implemented in both `InMemoryOnboardingStateStore`
(atomic in-map update) and `SqliteOnboardingStateStore` (transactional SELECT then conditional
UPDATE, returning null on miss). `live-personality-suggestions.ts` now calls `patchPhaseState`
directly (with the four memo-patch keys), and `LivePersonalityStateStore` now uses
`Pick<OnboardingStateStore, 'get' | 'patchPhaseState'>`. Stale comment about the re-INSERT
fallback replaced with accurate CAS documentation.

**Tests.** Updated `live-personality-suggestions.test.ts` fakeStore to implement
`patchPhaseState` (update-if-present, null on absent row). Converted existing assertions from
tracking `upserts[]` to `patches[]` (patch object now passed directly, no `phase`/`advanced_at`
wrapper). Added new reproduce-then-fix test: "row deleted (admin reset) between re-read and
write → no insert, no throw (CAS skip)" — simulates the race via `setOnGet` (get sees live row)
+ `row=null` (patchPhaseState sees absent row): asserts `patches.length===1` (write attempted)
and `current()===null` (row NOT resurrected). Updated partial-store constructions in
`path1-solicited-upload-starts-job.test.ts` and `build-onboarding-finalize.test.ts` (7 inline
`OnboardingStateStore` objects) to wire `patchPhaseState` through to the real store. 968
onboarding tests + 3761 gateway+onboarding tests pass; `tsc -p onboarding/gateway/open` clean.

## M2 P0 parity — input modalities task 1: attachment→agent threading + PDF documents (2026-07-21)

Scope: `IMPLEMENTATION_PLAN.md` task 1. Attachments (including images) never reached
the agent — `open/wiring/app-ws.ts` read `adapter_metadata.attachments` and dropped
them (its own comment admitted the deeper wiring was a follow-up); `gateway/wiring/
build-live-agent-turn.ts` had zero attachment handling. This builds the threading AND
adds PDF as an accepted chat-upload type. **Images are fixed as a side effect** — they
now reach the agent for the first time.

- **`gateway/http/app-upload-surface.ts`** — `IMAGE_MIME_WHITELIST` → `CHAT_UPLOAD_MIME_WHITELIST`
  (+`application/pdf`; SVG still excluded); `EXT_FROM_MIME` (+`pdf`), `URL_PATH_RE`
  (`…(png|jpg|gif|webp|pdf)`), `mimeFromExt` (+`pdf`). All existing hardening
  (Content-Length pre-check, 10 MiB cap, declared-vs-sniffed cross-check,
  content-addressed storage, per-user GET auth) untouched. NEW exported
  `resolveChatAttachmentLocalPath(owner_home, url)` — pure, syscall-free URL→local-path
  map using the SAME `URL_PATH_RE` (relative OR absolute URL; null for non-matching).
- **`gateway/http/chat-sender-registry.ts`** — `LiveAgentTurnRequest` gains
  `attachments?: ReadonlyArray<string>` (prompt-only; never mutates `user_text`).
- **`gateway/wiring/build-live-agent-turn.ts`** — `BuildLiveAgentTurnInput` gains
  `resolveAttachment?`; new exported `buildAttachmentsFragment(...)` formats a
  `<user_attachments>` block of resolved absolute paths + MIME + a "Read them" line;
  injected on the WARM splice (before the user message) AND the COLD
  `composeFirstTurnPrompt` (before the user message). Unresolvable URL → skipped + warn.
- **`open/wiring/app-ws.ts`** — sanitizes `adapter_metadata.attachments` to non-empty
  strings and passes `attachments` into the `appWsChatTurn({...})` call.
- **`open/composer.ts`** — threads `resolveAttachment: (url) => resolveChatAttachmentLocalPath(owner_home, url)`
  into `buildLiveAgentTurn`.
- **Clients** — web: `uploads.ts` `ACCEPTED_IMAGE_TYPES` → `ACCEPTED_ATTACHMENT_TYPES`
  (+pdf); `ChatApp.tsx` file-input `accept` (+`application/pdf,.pdf`), aria-label
  "Attach file…", `AttachmentImage` non-image → downloadable file chip;
  `message-adapter.ts` routes every attachment through the authed renderer
  (`isImageAttachmentUrl` decides img vs chip). Expo: `app/lib/upload-client.ts`
  `mimeToExt` (+pdf, exported for test).
- **Tests** — `gateway/__tests__/app-upload-surface.test.ts` (PDF accept/spoof/serve+ETag
  + `resolveChatAttachmentLocalPath` units); `gateway/wiring/__tests__/build-live-agent-turn-attachments.test.ts`
  (NEW: cold+warm embed the resolved path, `user_text` unpolluted, unresolvable skipped,
  no-attachments/no-resolver → no block); `gateway/__tests__/m2-chat-upload-attach-production-composer.test.ts`
  (PDF variant threads onto `adapter_metadata.attachments`); web `uploads.test.ts` /
  `message-adapter.test.ts` updated; `app/__tests__/upload-client.test.ts` `mimeToExt` unit.
- Suites: scoped gateway + wiring + open + client tests green; `tsc -p tsconfig.json` clean.
- OUT OF SCOPE (later tasks): voice-note transcription (task 2), `/status` + `/reset`
  chat commands (task 3), office formats beyond PDF, SVG, the import-ZIP path.

### Round-2 hardening (Argus review, 2026-07-21)

- **`landing/chat-react/ChatApp.tsx` — `attachmentBasename` no longer throws on a
  poisoned URL.** It runs during render for every non-image chip; a malformed
  percent-escape (`report%ZZ.pdf`) made `decodeURIComponent` throw `URIError`,
  tripping `ChatErrorBoundary` and blanking the whole chat view — and, since the
  URL persists in history, it recurred on every reload. Now `try/catch` falls back
  to the raw segment. Exported + unit-tested (`__tests__/attachment-basename.test.ts`).
- **`gateway/http/app-upload-surface.ts` — `resolveChatAttachmentLocalPath` hardened.**
  `URL_PATH_RE`'s user_id class matched a dot-only segment (`.` / `..`); now rejected
  outright (`/^\.+$/`) rather than relying on the hex64-filename bound. Added an
  `existsSync` gate so a resolvable-but-missing blob path is never injected into the
  agent prompt. New units cover both.
- **`gateway/wiring/build-live-agent-turn.ts` — Retry re-injects the ORIGINAL
  attachments.** A freeze-timeout Retry (`RETRY_TURN_VALUE`) recovered only
  `lastUserText`, silently dropping the doc/image. New `lastAttachments` map recorded
  alongside `lastUserText`; the recovered turn re-binds `attachments` too. Tests (f)/(g)
  in `build-live-agent-turn-attachments.test.ts` prove the retried prompt re-embeds the
  path (and injects no block when the original had none).

### Round-3 hardening (Argus review round-2, 2026-07-21)

- **BLOCKER — mobile PDFs no longer paint as broken images.** The Expo bubble
  routed EVERY attachment URL through `AuthedAttachmentImage` (a pure RN `<Image>`),
  so a PDF (newly uploadable on mobile in M2) rendered as a broken thumbnail with no
  open affordance — unlike the web file chip. Now `AuthedAttachmentImage` branches on
  `isImageAttachmentUrl(url)`: a non-image renders as `AuthedAttachmentFile`, a
  tappable `📎 <basename>` chip that opens the document (non-authed URLs open
  directly; our bearer-authed `/api/app/upload/…` URLs are fetched WITH the bearer
  then opened — RN-web via an object URL in a new tab, native via a base64 data URL
  handed to `WebBrowser`). Two new plain-TS helpers in `app/lib/attachment-url.ts`
  (`isImageAttachmentUrl`, `attachmentBasename`, both unit-tested, mirroring the web
  client's) drive the branch. This is the mobile analogue of the web file chip; it
  also settles the app side of the "non-image routed as image content-part" semantic
  (the web `message-adapter` note) — the renderer, not the content-part type, decides.
- **`gateway/http/app-upload-surface.ts` — served blobs pin their type.** The GET 200
  now sets `X-Content-Type-Options: nosniff` + `Content-Disposition: inline` so a
  browser never MIME-sniffs a served document into an executable content-type
  (defense-in-depth atop the existing bearer + user-id match; matters now that PDFs
  are served inline). Asserted in the PDF-serve test.
- **`open/wiring/app-ws.ts` — inbound attachment list is deduped + bounded.** New
  exported `sanitizeInboundAttachments(raw)` keeps only non-empty strings, DEDUPS, and
  CAPS at `MAX_INBOUND_ATTACHMENTS` (16) — each survivor drives a downstream
  `existsSync` + `<user_attachments>` prompt line, so a buggy/hostile client can't
  fan out unboundedly. Replaces the inline filter at the receiver; unit-tested.
- **`app/components/ChatSyncSurface.tsx` — native picker mirrors the server whitelist.**
  `DocumentPicker.getDocumentAsync` moved from `type: '*/*'` to the images+PDF+ZIP
  whitelist so the OS picker greys out unsupported files up front instead of letting a
  pick sail through to a raw 415.
- **Real-resolver integration test** (`build-live-agent-turn-attachments-real-resolver.test.ts`):
  seeds a real blob on disk, resolves its URL with the SHIPPED
  `resolveChatAttachmentLocalPath`, and asserts `buildAttachmentsFragment` embeds the
  on-disk path + MIME (and drops a missing blob) — closing the "stub-only resolver"
  coverage gap through the production seam.
- Suites: `app/__tests__/attachment-authed-source.test.ts`, `gateway/__tests__/app-upload-surface.test.ts`,
  `gateway/wiring/__tests__/build-live-agent-turn-attachments-real-resolver.test.ts`,
  `open/__tests__/open-wiring-app-ws.test.ts` green; `tsc` clean (root + `app/`).
- NOT changed (documented-acceptable, single-owner posture): `resolveChatAttachmentLocalPath`
  cross-`user_id` read (one owner; contained by `existsSync` + per-tenant process
  isolation) and the web `message-adapter` routing non-images as `type:'image'` content
  parts (assistant-ui exposes only text|image parts here; the renderer branches on the
  URL, so it is correct in practice).

### CI-green hotfix (PR #428, task 2) — de-pollute process-global react/react-native test mocks

- The canonical `test` job went RED across `a235eea3..141d2c1c` (3 consecutive runs). The
  two new app test files (`app/__tests__/authed-attachment-image-hooks.test.tsx`,
  `app/__tests__/authed-attachment-file-open.test.tsx`) registered process-global NARROW
  `mock.module` payloads for `react` / `react/jsx-runtime` / `react/jsx-dev-runtime` /
  `react-native`. Bun module mocks are process-global and survive across files, so in the
  shared-process CI chunk (`scripts/run-tests.sh`, 75-file chunks) they poisoned later
  files — `SyntaxError: Export named 'useReducer' not found` (docs-mutations-race) and
  `Export named 'Linking' not found` (docs-panes-render), plus `forwardRef is not a
  function` from react-textarea-autosize in the landing suites.
- FIRST ATTEMPT (superset + delegate-to-real react mock) fixed the SyntaxErrors but HUNG
  the CI `test` job (>90 min, never completing). Root cause: a `mock.module('react', …)`
  is process-global in bun and silently replaces `import * as RealReact from 'react'` in
  EVERY later file of the same chunk — including `docs-mutations-race` /
  `diagnostics-pane-render`, which deliberately use REAL react via an injected HookRuntime.
  Even a faithful superset defeats their design and deadlocked chunk 0 (agent-dispatch +
  app files together). Every other test file in the repo AVOIDS mocking react for exactly
  this reason (the "process-global" warnings in `docs-mutations-race.test.ts:52` etc.).
- FINAL FIX (test hygiene only — zero production or assertion changes): ELIMINATE the
  `react` / `react/jsx-runtime` / `react/jsx-dev-runtime` module mocks entirely from both
  files; use REAL react + real jsx. Only `react-native` stays a module mock (bun can't
  parse its Flow source) — kept as a SUPERSET (`Linking` / `useWindowDimensions` /
  `ScrollView` / `TextInput` / `ActivityIndicator` / `Modal`) so it never collides with the
  sibling docs suites' react-native mocks — plus the `expo-*` stubs (so the real expo
  modules never drag unparseable react-native internals into the process).
  `AuthedAttachmentImage` is a hook-free dispatcher, so it runs directly against real react
  (a regression re-adding a hook throws "Invalid hook call" and fails the test loudly).
  `AuthedAttachmentFile` calls `useState`, so `pressChip` installs a minimal hook
  dispatcher on react's current-dispatcher slot
  (`__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H`) around the
  SYNCHRONOUS component call only, then restores it — scoped to this file, no module mock,
  no cross-file pollution.
- Verified locally with gbrain on PATH: the exact CI chunk 0 (7 agent-dispatch + 68 app
  files, the set that hung) now runs 861 pass / 0 fail and EXITS in <1s; both target suites
  green (image 4/0, file 5/0); the 12 branch-changed files in ONE bun process 125/0;
  `bash scripts/ci/typecheck-all.sh` exit 0 (51 tsconfigs).

### Round-2 findings fix (Argus review round-1 on PR #428, 2026-07-22)

- **BLOCKER — native non-authed `data:`/`file:`/`content:` attachments no longer open
  silently-fail.** The file-chip `open()` handler's `bearer === undefined` branch
  (`app/components/AuthedAttachmentImage.tsx`) handed the raw URI straight to
  `WebBrowser.openBrowserAsync` on native — but SFSafariViewController / Chrome Custom
  Tabs reject a non-http(s) INITIAL url, so a `file://`/`content://` (optimistic /
  failed-send local doc bubble — `attachment-url.ts:141-149`) or `data:` URI opened to
  nothing, contradicting the file's own r2-BLOCKER invariant. Fixed with a new
  `openNonAuthedNative(uri, name)` helper: an `http(s)` URL still opens in the in-app
  browser; a `data:` URL is materialized to a cache file (`materializeDataUrlToCache`)
  and a local `file:`/`content:` URL is shared as-is — both routed through
  `Sharing.shareAsync` (the same OS-share path the AUTHED native branch already uses),
  with the rare `!isAvailableAsync()` emulator fallback. Web behavior unchanged (still
  navigates the synchronously-opened tab). Four new regression tests in
  `app/__tests__/authed-attachment-file-open.test.tsx` assert: local `file://` shared
  as-is (never WebBrowser), `data:` materialized-then-shared (never a data: URL to
  WebBrowser), and `http(s)` still opens in WebBrowser.
- **Test hygiene (findings 2 + 3, no production change).** The two attachment test files'
  `react-native` superset mocks now also export `FlatList` / `KeyboardAvoidingView` /
  `TouchableOpacity` (per the sibling-superset convention, so they can never collide with
  a docs-suite RN mock in a shared CI chunk). Removed the vacuous `const useStateCalls = 0;
  expect(...).toBe(0)` always-pass counters from `authed-attachment-image-hooks.test.tsx`;
  the real guard was always the element-TYPE assertions plus the real-react "Invalid hook
  call" throw — the flip test now asserts the exact image/file type sequence across the
  recycle instead of a tautology.
- Verified: both target suites 12/0; the full `app/__tests__/` dir in ONE bun process
  872/0 (the CI-pollution scenario, clean); `tsc --noEmit -p app/tsconfig.json` exit 0.

## M2 P0 parity — input modalities task 3 (partial): `/status` chat command (2026-07-22)

Scope: `IMPLEMENTATION_PLAN.md` task 3, the `/status` half of the narrow Neutron
chat commands (`/status` + `/reset`; NOT the the legacy harness topic-lifecycle vocabulary).
`/reset` is intentionally NOT shipped this iteration — see the mechanism finding
below.

- **`/status` — deterministic instance snapshot.** New `buildStatusChatCommandFilter`
  (`gateway/boot-chat-command-filters.ts`, re-exported through the
  `gateway/boot-helpers.ts` / `composer-contract.ts` barrel) implements the
  `ChatCommandFilter` contract. `/status` (exact-command word boundary — `/statusfoo`
  falls through to the LLM, K8 grammar precedent) replies with a formatted snapshot:
  active project, current model (`getBestModel()`), pending-reminder count, active
  work-board items, active Trident builds. Pure READ — no mutation, no LLM dispatch.
- **Wiring — one command path, both surfaces.** Chained in `open/composer.ts` into the
  SAME `buildChainedChatCommandFilter([...])` the web onboarding chat AND the app-ws
  chat share (appended after the cores chain + skill-forge). The snapshot is an
  injected thunk; because the source stores (projects reader / reminder store /
  work-board / Trident run store) are constructed LATER in the composer closure, the
  reader is threaded through a `late<T>` two-phase holder (`statusSnapshotHolder`) and
  BOUND right after `workBoardStore` exists. Each source read is best-effort (degrades
  to 0 rather than bricking the command). Filter stays store-free → unit-testable.
- **Tests.** `gateway/__tests__/status-command-wiring.test.ts` (9/0): reply TEXT carries
  every snapshot field value (behavior, not a `toHaveBeenCalled` gap-test); `project_id`
  threaded / omitted correctly; leading-whitespace + trailing-arg tolerance; `/statusfoo`
  + `/statuses` fall through and NEVER run the snapshot thunk; chain-composition proof
  that `/status` is reached after earlier filters disclaim (the real composer shape).
- **`/reset` DEFERRED — verified spec/mechanism mismatch.** The plan named
  `respawnSupervisedSession` as the `/reset` actuation for "fresh agent context; durable
  chat history stays". VERIFIED against the code this is WRONG:
  `runtime/adapters/claude-code/persistent/session-respawn.ts:24` — "respawn ALWAYS
  resumes — never a fresh spawn"; `respawnSupervisedSession` (`supervision.ts:59`) →
  `respawnReplSession(..., true)` → `planRespawn` `--resume`s the SAME transcript,
  PRESERVING context. It cannot deliver a context reset. Shipping `/reset` on that
  primitive would be a no-op-that-looks-like-it-works (banned pattern). The correct
  primitive is the `/clear` PTY reset (`CONTEXT_RESET_COMMAND`, `pool.ts:380`, already
  used for the import warm-session per-turn reset) or a fresh (non-resume) respawn; plus
  a credential-identity-agnostic way to target the live session key (the pool key folds
  `cred.id`, unknown to the filter). Re-scoped in `IMPLEMENTATION_PLAN.md` for a
  follow-up iteration on the corrected mechanism.
- Verified: `bunx tsc --noEmit` exit 0; `gateway/__tests__/status-command-wiring.test.ts`
  9/0.

## M2 P0 parity — input modalities task 5: voice notes (audio upload + Whisper ASR) (2026-07-22)

Scope: `IMPLEMENTATION_PLAN.md` task 5. Audio voice notes (MP3/M4A/WAV) upload on
the SAME chat surface as images + PDF, transcribed at upload-complete by a new
OpenAI-compatible Whisper client, with the transcript injected into the dispatched
prompt AND appended to the scribe text (voice → text → gbrain parity). NO FEATURE
FLAGS — transcription is gated only by `OPENAI_API_KEY` presence (credential config).

- **Whisper client.** New `gateway/transcription/openai-transcription.ts` —
  `createOpenAiTranscriptionClient` POSTs multipart `{base}/v1/audio/transcriptions`
  (default base `https://api.openai.com`, model `whisper-1`, injectable `fetch_impl` +
  `timeout_ms`). Typed `TranscribeResult` with an error taxonomy
  (`http_error`/`network_error`/`timeout`/`bad_response`); NEVER throws, no logging
  inside the client, no retries (v1). `audioFilenameFor` maps the canonical MIME to a
  Whisper-recognized filename extension (`voice.mp3`/`voice.m4a`/`voice.wav`).
- **Upload surface.** `gateway/http/app-upload-surface.ts` — widened
  `CHAT_UPLOAD_MIME_WHITELIST` / `EXT_FROM_MIME` / `URL_PATH_RE` ext-group /
  `mimeFromExt` to audio (`.txt` DELIBERATELY excluded from the GET ext-group so the
  transcript sidecar is never servable). New optional `transcribeAudio` seam;
  handleUpload transcribes an audio blob and writes a content-addressed `<hash>.txt`
  sidecar (atomic tmp+rename, idempotent — sidecar-exists ⇒ the API is NOT re-called;
  ASR failure NEVER fails the upload). `resolveChatAttachmentLocalPath` widened to
  return `transcript` for audio (sidecar read; null when absent), field omitted for
  non-audio.
- **Turn injection.** `gateway/wiring/build-live-agent-turn.ts` `buildAttachmentsFragment`
  embeds an audio attachment's transcript inline (capped 4000 chars with a truncation
  marker); keyless/failed ASR → the graceful "transcription unavailable — set
  OPENAI_API_KEY" note. Splice sites + `turn.user_text` untouched.
- **Scribe threading.** `open/wiring/app-ws.ts` — new `attachmentTranscript` deps seam;
  the receiver appends resolved transcripts to the `scribeOnUserTurn` text only
  (`user_text` stays unmutated). Composer wires it over `resolveChatAttachmentLocalPath`;
  `open/composer.ts` builds the `transcribeAudio` seam from `OPENAI_API_KEY` (keyless ⇒
  no seam, audio still uploads without a transcript).
- **Clients.** Web accept attr + `ACCEPTED_ATTACHMENT_TYPES` (+ alias forms) + 🎵 chip
  (`message-adapter.ts` `isAudioAttachmentUrl`); native Expo picker mime array +
  `mimeToExt` audio cases + 🎵 chip (`attachment-url.ts` predicate).
- Verified: `bunx tsc --noEmit` exit 0. Tests:
  `gateway/transcription/__tests__/openai-transcription.test.ts` 7/0;
  `gateway/__tests__/app-upload-surface.test.ts` 30/0 (incl. artifact-on-disk sidecar +
  idempotency call-count + keyless-no-sidecar + `.txt`-unreachable);
  `gateway/wiring/__tests__/build-live-agent-turn-attachments.test.ts` 11/0;
  `open/__tests__/open-wiring-app-ws.test.ts` 20/0 (scribe transcript threading);
  `app/__tests__/upload-client.test.ts` 12/0;
  `landing/chat-react/__tests__/message-adapter.test.ts` 12/0.

## 2026-07-31 — mobile: a project switch can no longer end in an unbounded wait

Third pass on the owner's "spinner in the chat area, rail still tappable, and the
project I tapped never appears on the server's session log". The two previous
passes both landed in the chat-session layer and neither moved the symptom.

**NOT the root cause, and now ruled out with evidence.** A new device-harness test
mounts the REAL chain a rail tap travels — `app/projects/[id]/_layout.tsx` →
`<Slot/>` → `index.tsx` → `chat.tsx` → `ChatSyncSurface` — over a routing stub, and
every tapped project reaches the wire on unmodified `main`. So the settings gate
opens, the redirect fires and the socket is attempted; the shell is not the
blocker. Separately: the tenant's project ids are all `[a-z0-9-]`, so nothing is
being rejected on id grounds, and a missing last-tab key resolves `null` rather
than hanging. The device-only cause is still UNIDENTIFIED.

**What DID change — every unbounded wait on that path is now bounded, and a
failure is now visible instead of being an indefinite spinner.**

- **`app/lib/projects-client.ts`** — `REQUEST_TIMEOUT_MS` (15 s) + an
  `AbortController` on every request. `fetch` has no device-side timeout, and the
  shell blocks its whole content pane on `getSettings`, so a request that never
  answered was a permanent spinner with no error, no retry and nothing on the wire.
  A hang is now a `timeout` rejection.
- **`app/lib/project-shell-content.ts`** — new `unavailable` kind. The production
  settings store SYNTHESISES defaults rather than 404ing
  (`gateway/http/app-projects-surface.ts` `buildDefaultSettings`), so the shell's
  failure branch was effectively unreachable and every stall was terminal. A
  transport/auth failure is now `unavailable`; only a server-stated absence
  (`not_found`) is `not_found`.
- **`app/app/projects/[id]/_layout.tsx`** — renders that state as a
  "Couldn't load this project" pane with a **Try again** that re-runs the scope's
  fetch in place. It no longer tells the owner a project they are looking at in the
  rail is missing when the truth is the connection.
- **`app/app/projects/[id]/index.tsx`** — the default-tab redirect ALWAYS
  navigates. The last-tab read is raced against `LAST_TAB_READ_TIMEOUT_MS`
  (1.2 s; `try/catch` cannot save you from a promise that never settles), and a
  scope that resolves from neither the path nor the param falls through to General
  instead of leaving its own spinner up forever.
- **`index.tsx` + `chat.tsx`** — resolve the scope from
  `projectIdFromPathname(usePathname())` first, param second: the same precedence
  the shell already adopted after the route param was observed going stale on
  device. The shell and the screens inside it can no longer disagree about which
  project they are rendering.

**Test surface.** `app/__tests__/support/stubs/expo-router.tsx` grows an opt-in
routing mode (path + route table + `<Slot/>`) and a `paramsBlind` fault; inert by
default so no existing harness file changes behaviour.
`app/__tests__/project-switch-reaches-the-wire.test.tsx` (7/0) asserts a SOCKET per
tapped project, not that a spinner stopped. Six mutations, each proven applied by
file hash, each failing its paired test.

## 2026-08-01 — memory: an auto-merged page can be un-merged

The 6h reflect pass clusters near-duplicate entity pages, folds the losers into a
survivor, and **hard-unlinked** each loser (`runtime/entity-writer.ts:deleteEntity`
→ `fs.unlink`). Jaccard similarity is a heuristic, so that removal could be wrong
and there was no way back: no copy, no record, and — because the pass's report is
a return value nobody reads (`open/wiring/memory.ts` discards it) — not even a log
line saying a page had gone. `entities/.quarantine/` had been designed and dropped.

**`scribe/reflect/merge-archive.ts` (new).** A merged-away loser is copied
BYTE-EXACT to `<ownerDataDir>/memory-archive/<kind-dir>/<slug>.<stamp>.md` and the
merge recorded in `memory-archive/merges.jsonl` (when, which page, which survivor
absorbed it) **before** the unlink. `memory-archive/` is a sibling of `entities/`,
outside every enumeration path, so an archived copy is inert until restored.
Content-idempotent (a re-archived loser reuses its existing copy), and
`pruneMergeArchive` enforces a **90-day** horizon each pass so the safety net stays
bounded. A `README.md` with plain-English restore instructions is dropped into the
folder on first use.

**`scribe/reflect/reflect-pass.ts`.** `mergeCluster` archives before deleting, and
**a failed archive BLOCKS the delete** — the loser is retained, not counted as
merged, and a later pass retries. New `report.archived`; a successful merge now
logs the removed page, the survivor, the archive path and the restore command.

**`neutron memory-restore`** (`scribe/reflect/memory-restore-cli.ts`, dispatched
from `bin/neutron`) lists what was merged away and puts a page back byte-for-byte.
It refuses to overwrite a live page without `--force`.

**Test surface.** `scribe/__tests__/reflect-merge-archive.test.ts` (12/0) drives
REAL merges over real on-disk pages and then **recovers the loser, asserting the
restored bytes equal the pre-merge bytes** — including the case where the loser was
the better page. Mutation: reverting `mergeCluster` to a hard delete turns 10 of
the 12 red.

No schema change, no feature flag. Gateway/scribe code — reaches a box on deploy.

## 2026-08-03 — push: a device registration that fails is no longer invisible

`device_push_tokens` was found holding **zero rows** on a live instance, so every
proactive surface — rituals, the morning brief, nudges, the lapsed-credential
notice — reached the app and nothing reached the phone. It was caught by checking
the first ritual fire, not by a report, and the reason is structural: nothing on
the registration path logged anything. `gateway/http/app-devices-surface.ts` had
no logger, `gateway/push/store.ts` has none, and `app/lib/push.ts` is documented
as never throwing — it turns every failure into a typed result the login screen
`console.warn`ed and dropped. So "the app never called register" and "the app
called and was refused" produced byte-identical evidence: none.

**Server (`gateway/http/app-devices-surface.ts`).** EVERY request now emits
exactly one `@neutronai/logger` line whatever the outcome — `device_registered`
(with `first_registration`, derived from `registered_at === updated_at`, so a new
phone is distinguishable from the same phone signing in again),
`device_register_rejected`, `device_request_unauthorized` (the expired-bearer
case that used to look like silence), `device_request_rejected`,
`device_unregistered`, `device_unregister_rejected`. A store failure during
register no longer throws out of the handler: it logs `device_register_failed`
and answers **500 `register_failed`**. **The token is never logged** — lines carry
`token_fp`, the first 12 hex chars of its SHA-256, which correlates a register
with the unregister or the Expo prune that later removes it and is useless to
anyone else.

**Client (`app/lib/push-observability.ts`, new).** `enablePushForUser` records
every outcome into the existing diagnostics ring buffer and, for an ACTIONABLE
failure, captures a report — a fifth `ReportReason`, `push_registration_failed`,
because this failure is not an error anything caught. `unsupported_platform` (the
web build) is recorded but not escalated, or opening the app in a browser would
bury the real failures. Login calls this before `setUser`, so `DiagnosticsSync`
flushes the queued report on the same launch. No token is recorded — a success
carries the platform and the token's LENGTH.

**Test surface.** `gateway/__tests__/app-devices-surface.test.ts` (25/0) drives
the real surface with the REAL logger behind a capturing sink and asserts on
rendered lines, including one test that fires every path and proves the raw token
appears in none of them; logging the token instead of the fingerprint turns 3
red. `app/__tests__/push-observability.test.ts` (8/0) asserts a failure is
recorded AND filed, a benign skip is recorded and NOT filed, and the token never
reaches a report.

**Residual, stated not fixed.** Registration is **login-only**.
`enablePushForUser` has exactly two call sites, both in `app/app/login.tsx`
(`:228`, `:352`), and nothing re-registers on foreground — so an OS token
rotation, a reinstall or an Expo invalidation ends push until the next sign-in.
`app/lib/devices-client.ts` claimed otherwise in a comment ("and again on app
foreground when the Expo token rotates"); the comment is corrected to describe
what the code does. Self-healing re-registration is a separate change.

No schema change, no feature flag. Gateway + app code.

## Wall-clock timing assertions in tests — triaged, mostly removed (ISSUES #438)

**What changed.** A sweep of every test assertion that compares REAL elapsed wall
time against a threshold. These red when the machine is loaded, which is exactly
when CI is busiest, and a gate that reddens for a reason unrelated to the change
under review is a gate people learn to merge past. 16 live assertions were found
across 10 files (the swept grep also matches a comment in
`gateway/comments/__tests__/anchor-walker.test.ts:1230`, which documents the
earlier removal this change generalises).

**The rule applied, in order.** (1) If a deterministic assertion already covered
the same contract, the timing bound was DELETED. (2) Otherwise, if the contract
could be restated as an ordering or a discriminant, it was CONVERTED. (3) Only
where neither applied was a bound KEPT, and then with a comment naming the
regression it catches and a measured margin. Nothing was bulk-widened; exactly
one number in the tree changed, and it changed to zero numbers by deletion.

**Outcome: 9 deleted, 4 converted, 3 kept.** The conversions are the interesting
half. `onboarding/synthesis/__tests__/synthesis-session.test.ts` now asserts
WHICH wedge detector fired by reading the distinct failure messages off the
injectable `logFailure` sink, instead of inferring it from a stopwatch — strictly
stronger, because the old bound would also have passed on the wrong detector
firing early. `open/__tests__/open-app-ws-durable-chatlog.test.ts` samples the
agent-reply frame count at the instant the HTTP response lands, so
"returned before the turn finished" is an ordering that load cannot reorder
rather than a 500 ms budget. `open/__tests__/onboarding-warm-conversational.test.ts`
sets the pre-warm cap an hour out so the pre-warm is the only thing that can
resolve the gate, making the test's own completion the proof.

**Two premises corrected while doing it.** The health-probe test in
`runtime/adapters/claude-code/persistent/__tests__/repl-supervision.test.ts`
described a server that "never resolves", but `Bun.serve` defaults to a 10 s
request idle timeout — so it DID answer, and with the probe deadline stripped the
test still passed in 12.2 s. It now sets `idleTimeout: 0`, which is what makes
the deadline's absence observable at all. And the bound in
`tests/integration/profile-pic-pipeline.test.ts` allowed 60 s while the test runs
under CI's 15 s per-test timeout — it could never have failed.

**The three kept bounds, and why.** Two in
`runtime/adapters/claude-code/persistent/__tests__/persistent-repl-substrate.test.ts`
are LOWER bounds that are the only thing distinguishing the inactivity watchdog
from the absolute ceiling — both deliberately emit the same error
(`pool.ts:605`) — and load moves a lower bound away from its threshold. The
`app/__tests__/transcript-warmer.test.ts` bound is the only guard separating a
gate-driven abandon from the 6 s open deadline, and measured 8 ms against a
3000 ms budget under 2x CPU oversubscription. The
`onboarding/profile-pic/__tests__/storage.test.ts` bound discriminates a
synchronous return from a 5 s fallback wait and measured 0-1 ms against 100 ms
under the same load.

**Every deletion was mutation-tested**: the guarding behaviour was broken in the
real source and the surviving assertions were shown to still red. Tests only —
no source file changed, no schema change, no feature flag.

## 2026-08-04 — one OpenAI key serves every OpenAI-backed feature (ISSUES #496)

The owner pasted an OpenAI key in Settings to turn on semantic search, then
found voice transcription still reporting `openai_key_missing`. That was not a
defect: `gateway/transcription/openai-key-store.ts` reserved its own credential
name, `openai_transcription`, and the docblock beneath it argued the separation
was deliberate — a generic OpenAI credential would be read by whatever else
wanted an OpenAI key, so pasting a key for one purpose would silently switch on
another.

**That reasoning is now retired** (SPEC § Decisions Log 2026-08-04). It protects
a user from a metered feature they did not choose to enable, and Neutron is
single-owner: he pastes his own key and knows what he pays for. Making him paste
the same secret twice to get voice notes working reads as a bug, not a
safeguard.

**What shipped — a resolution ORDER, not a branch.** `OpenAiKeyStore.resolve()`
tries, in order: the dedicated `openai_transcription` credential → the SHARED
general OpenAI credential → `OPENAI_API_KEY` from the environment. First
non-empty answer wins. One key works everywhere by default; a dedicated key
still scopes transcription spend for anyone who wants that, because it outranks
the shared one. No flag, no mode, no second code path.

**The fallback crosses a store boundary, which is the whole difficulty.** The
general key is NOT a `project_credentials` row and has no `service` name. It
lives in `ApiKeyStore` over `SecretsStore` (tables `api_keys` + `secrets`),
keyed `provider='openai', label='onboarding'` — secrets label `openai:onboarding`
(`auth/api-key-store.ts:101`, `gateway/cores/integrations.ts:145-146`), written
by the onboarding optional-key offer and by Settings → Integrations, read by
`gateway/wiring/resolve-onboarding-openai-key.ts`. A naive "also read service
`openai`" fix would have compiled, passed a careless test, and done nothing:
`project_credentials` rows with a hand-typed `openai` service are inert — no
production reader consults them. So the composer injects
`resolveOnboardingOpenAiKey` as a REQUIRED lazy thunk (the same thunk the GBrain
embedder wiring already uses, lazy for the same reason: the composer runs once
at boot but the key is pasted later, over the running server). Required rather
than optional so a construction site cannot silently omit it — which the
typechecker immediately proved by flagging the two test sites that had.

`resolve()` and `status()` became async and walk the SAME order, deliberately:
if they drift, Settings reports "no key" while voice notes transcribe. A new
`shared` source label reports the provenance rather than hiding it, and DELETE
returns 409 `key_from_shared_credential` pointing at Integrations rather than a
200 that reads as "deleted" over a box that still transcribes.

**Tests + mutation results.** New `gateway/transcription/__tests__/openai-key-store.test.ts`
(16 tests over a service-AWARE fake store — the sibling surface fake answers to
any name, which cannot distinguish a correct lookup from a wrong one) plus five
end-to-end cases on the HTTP surface. Four mutations, each red: removing the
fallback reds "shared is used" (3 tests); inverting the precedence reds
"dedicated wins"; dropping the shared step from `status()` alone reds the
status/resolve agreement suite (4 tests); dropping the blank-key guard reds the
fall-through and missing-key tests (4 tests). The `openai_key_missing` path is
covered directly and is unchanged.

## 2026-08-04 — a turn can no longer end on a promise it never keeps (ISSUES #492)

`runtime/adapters/claude-code/persistent/hooks/enforce-reply.ts` already blocked a
`<channel>` turn that ended without calling `reply()`. It did not catch the other
half of the same failure: a turn that ends on a PROMISE of work — "re-running
now", "I'll fix and report back", "one sec". Because a channel turn is
asynchronous, nothing re-invokes an idle session, so the owner sits in silence
until they ask for a status. The session looks broken while being perfectly
healthy. That gate now exists, ported from the upstream harness.

**What actually ported was the false-positive handling, not the regex.** The
extra logic upstream is almost entirely scar tissue, and a version carrying only
the pattern would fire on innocent prose, get in the way, and be switched off —
strictly worse than no gate. Three mitigations came across and each is pinned by
its own test: double-quoted spans are stripped before matching, so a reply that
QUOTES the banned phrasings (explaining the gate, citing what not to say) is read
as meta-discussion rather than a live promise; a negative lookbehind rejects the
verb-as-noun case, so "the fix", "a check", "your build" do not trip an
alternation whose modal may sit 50 characters away; and only the reply the owner
actually receives is evaluated, so a past-tense report of completed work sails
through.

**Two findings corrected the port rather than following it.** First, the
delivered-reply rule is INVERTED against upstream. Upstream streams a turn as
several replies and evaluates the LAST, because that is the message the owner is
left staring at. This runtime delivers exactly one: `reply` has no
streaming/append parameter (`dev-channel-impl.ts:129-137`) and the substrate
settles the turn on the FIRST correlated reply — pushing the completion, closing
the channel, marking it settled (`repl-session.ts:280-290`) — after which every
later reply is rejected (`repl-session.ts:269`). Porting "last reply" literally
would have read a follow-up the substrate already threw away and cleared a turn
that really did strand the owner: a false NEGATIVE hiding the exact bug. The
rationale ports; the index does not.

Second, the escape hatches are this tree's real seams, established from the code
rather than assumed from upstream's names. There is exactly ONE: `reminders_create`
(`cores/free/reminders/src/tools.ts:104`) is auto-approved
(`gateway/cores/install-bundled.ts:1098`), picked up by a 30 s tick
(`reminders/tick.ts:162`), and dispatched onto the SAME warm pooled session
(`reminders/dispatcher.ts:139-145` → `open/composer.ts:2433-2434` → `pool.ts:490`
→ `spawn.ts:884`) — a genuine re-entry that can even re-arm itself.
`dispatch_agent` looks like a continuation mechanism and is NOT one: it runs on a
separate ephemeral substrate and its completion reporter here is a bare log line
(`open/composer.ts:999-1004`), so nothing reaches the owner and nothing re-enters
the session. Accepting it would have waved through the precise stranding the gate
exists to catch, so it is pinned as a BLOCK. `rituals_*` are approval-gated onto a
different substrate; cron, idle-nudge and morning-brief are server-side timers
with no tool surface at all.

A known limit, recorded rather than papered over: because the substrate settles
the turn on the delivered reply, a block fires AFTER that reply has already
reached the owner. The gate therefore forces the promised work to actually happen
in-turn and pushes the agent toward arming a real follow-up, but it cannot
retroactively deliver a result on a turn whose channel is already closed. The
durable fix for the delivery half is to not send the promise in the first place,
which is what the block reason instructs.

**Tests + mutation results.** `runtime/adapters/claude-code/persistent/__tests__/enforce-reply.test.ts`
grows from 17 to 27 tests. Seven mutations, each red: disabling the promise check
reds 3; adding a past-tense form to the pattern reds the completed-work regression
arm; dropping the quote-strip reds the meta-discussion arm; dropping the lookbehind
reds the verb-as-noun arm; flipping delivered-reply from first to last reds the
delivery-semantics arm; dropping the reminder hatch reds the escape-hatch arm; and
short-circuiting `assistantCalledReply` reds 8, confirming the pre-existing
no-reply gate is untouched. No feature flag — the gate ships on as default
behaviour.
## Mid-turn message injection (#516)

The web composer keeps Send enabled while the agent is typing. A second message
for the same topic bypasses the completed-turn chain and is posted immediately to
the persistent REPL dev-channel as additional context for the active turn. It
reuses the active turn id without advancing fallback reply-correlation state, so
the running turn's eventual reply remains correlated normally. If no active turn
exists at the injection instant, the message falls back to the existing ordered
turn path instead of being dropped.

Mutation-named tests pin all three boundaries: the gateway test fails if the
second send is queued until completion, the persistent-REPL test asserts the
additional `/message` reached the wire before the first reply, and the React test
fails if the composer is disabled while streaming or IME composition Enter is
submitted. General chat uses the same `general` route key for registration and
lookup. A successful dev-channel delivery stays successful if the turn settles
while its response is returning, preventing a duplicate queued turn; failed
delivery leaves Retry text and attachment state untouched. Injection is offered
only while exactly one turn is active: a queued turn, Retry, seed, reconnect, or
button-prompt answer always follows the normal ordered path. Injected history is
stamped with the inbound observation time so a racing agent reply cannot render
before it; attachment-only sends persist their inbound reference while resolved
local paths remain confined to the REPL payload. Active-turn routes include the
non-secret credential identity and refuse ambiguous credential-rotation matches.
Typing refcounts have a fail-safe beyond the turn's forty-five-minute absolute
ceiling that clears a lost `end`, fans the matching ephemeral end frame, and
refreshes the rail working state instead of wedging that topic until restart.
The composer clears the
submitted text before awaiting the send, then restores it only when delivery
fails (ahead of any newer draft text). An in-flight send claim prevents two
Enter presses from reusing the same staged attachment URLs before the first
upload/send clears them.

## 2026-08-09 — the typing refcount's guard is now killable by a test

PR #145's last open finding was exact: *"Typing-refcount suppression guard and
46-minute fail-safe have zero killing test coverage, and depth can leak
permanently."* Both halves were true, and neither was reachable — the logic was a
closure inside `wireAppWs` keyed on a real `setTimeout(…, 46 * 60_000)`. No test
waits 46 minutes, and a test that reaches into a closure is not testing the
production path.

The decision logic moved to `open/wiring/typing-refcount.ts`, pure apart from an
INJECTED scheduler; `open/wiring/app-ws.ts` is the only caller and passes the real
one. `open/__tests__/typing-refcount.test.ts` fires the captured timer, so the
46-minute path runs under test with only the caller changed.

Behaviour is unchanged and now pinned: the outermost `start` and the final `end`
are the only visible edges (an inner pair emits nothing, so a fast second turn
cannot clear the first turn's dots); a stray `end` never drives depth negative; the
window is re-armed on every transition that leaves the count positive; a
cancelled-but-still-running timer cannot clear an entry a newer start re-armed; and
a lost `end` expires instead of suppressing every future typing start until
restart. Mutants killed: removing the fail-safe fails 3, making every transition
emit fails 2.


## 2026-08-09 — `codegen_cancel`'s terminator is a required argument, and the composition path is covered

The review's remaining blocker on the tool-initiated cancel was that the
production observer composition had no coverage — "both the composer bind and the
mountOpenCores path".

The reason that mattered was a DEFAULT PARAMETER. `routeCodegenCancel` took
`terminator: TridentTerminator = buildTridentTerminator({ store: trident })` — a
terminator with no observer and no `onTransition`. If either hop broke, a cancel
still flipped the phase and still returned `cancelled: true`, while the Work Board
never reconciled, the skill-forge hook never ran, and no `projects_changed` reached
the rail. No unit test could catch it, because each builds its own terminator; only
the production composition could, and that was the untested part.

The default is GONE. The parameter is required, so a missing thread is a typecheck
failure — which it immediately was, on nine call sites. The one caller that
legitimately has no observers to run (`boot-cores-factories.ts`, when no composer
threaded one) now fabricates it EXPLICITLY via `codegenCancelTerminator` and logs
`codegen_cancel_terminator_unwired`, the same precedent as the neighbouring
`codegen_orchestrator_not_wired`. Verified firing, with a control.

`open/__tests__/codegen-cancel-composition.test.ts` covers the pass-through
behaviourally — a cancel through the MOUNTED backend must reach the terminator the
caller supplied, and deleting the `mountOpenCores` forward reds it — plus three
source-scoped assertions for the composer's bind, labelled weaker with the reason
(the bind is inside the composer's closure; reaching it behaviourally needs the
whole composition AND the Code-Gen Core installed).

Also fixed: the codegen holder's unbound-deref error read "board terminator is not
bound" — the SIBLING holder's name — which would send a reader to the wrong bind.

Also on this branch: `TridentRunReferenceAmbiguousError` no longer escapes the
Code-Gen tool contract. `resolveReference` throws it when a short prefix matches
more than one run; the MCP guard maps the Core's own error types to structured tool
failures and lets anything else out as a raw internal error, so an ambiguous prefix
produced a stack-shaped failure instead of "pass more of the id". It is translated
at the router boundary to `CodegenInputError` on `task_id`. An existing test had
pinned the LEAKED message (`'reference is ambiguous'`) — updated to the contract
error, with its real guarantee (an ambiguous prefix must not select by recency)
left exactly as it was. Mutant: removing the translation reds three tests.

# Trident child-crash reaping (#514)

## 2026-08-09 — Trident child-crash reaping (#514)

The persistent REPL watchdog now commits a retryable, edge-latched durable-work callback before replacing any dead or alive-but-wedged child. Each spawn receives a unique generation token that is persisted in the REPL registry, returned with launcher completion, and stored on its detached Trident run. The store records that generation's crash before marking only matching live rows `crashed`; a racing launcher completion cannot persist `running`, while a later child reusing the same warm pool slot has a different token and is unaffected. Tombstones older than seven days are pruned on crash writes. A gateway-restart tick can use the registry's persisted generation with the substrate-level callback even before the exact pool entry is rebuilt. The next `trident/tick.ts` sweep performs the normal terminal failure and Work Board reconciliation, so the board indicator clears within one tick interval. Transient store failures retry on the next watchdog tick before respawn, rather than losing the crash edge.

## 2026-08-09 — a crash before the launch save no longer fires a build every tick

A reviewer reproduced this live on the branch, with their own probe: make the
firer record its crash tombstone BEFORE it returns `{ status: 'fired',
launcher_session_key }` — the window `trident/store.test.ts` already covers — then
tick. `fires=3` after three ticks, `phase='forge-init'`,
`subagent_status='crashed'`, `subagent_run_id=null`. Three real detached builds,
with no ceiling: one more every tick, forever, burning credentials and able to open
duplicate PRs.

The chain: `saveIfActive` is vetoed by the tombstone, so the dispatch id the firer
returned is never written and `subagent_run_id` stays NULL. Harvest, the
terminal-status guard, the hang watchdog and orphan recovery were ALL gated on
`subagent_run_id !== null`, so nothing observed the `crashed` status — and control
reached `if (run.subagent_run_id === null) return launch(run)`, which is
unconditional.

The fix is one widened gate: `subagent_status === 'crashed'` also opens the
harvest/terminal block, because a crashed launcher is a dead run whether or not we
ever learned its subagent id. Harvest still runs FIRST inside it, so a workflow that
wrote its terminal result and only then lost its launcher still harvests instead of
being reaped — a fix that reaped those would have traded an infinite loop for
silently discarded results.

`trident/crash-before-launch-save.test.ts` pins it. The guarantee is that the loop
is BOUNDED, not instant: the tombstone lands during tick 1's fire and the phase is
classified at the top of a tick, so the reap happens on tick 2. The test says so
rather than asserting something the fix does not claim. Mutant: reverting the gate
reds two of four.

## 2026-08-09 — General's documents became reachable, on both surfaces

The owner reported one symptom (a General work card whose plan link did nothing,
and no documents in General) that was **four independent gaps**: the web never
injected a `documents` tab for General; `ProjectShell` deliberately suppressed the
doc link there *because* of that missing tab; `docs-client.ts` interpolated the
scope id into nine URLs raw, so General (`''`) would have requested
`/api/app/projects//docs/…`; and on mobile nothing ever passed `WorkBoardRow`'s
long-declared `onOpenDoc`, leaving the ▸ chip inert on every phone.

Fixing any ONE changes nothing observable — the shape worth remembering. None was
a mistake when written; the web guard in particular encoded a fact about another
module's tab set with no mechanical link back to it, so changing that tab set
could not fail there.

`landing/chat-react/general-scope.ts` is new — the one place General changes
spelling on the web, mirroring `app/lib/general-scope.ts`. The work-board client's
private normaliser now delegates to it instead of keeping a second copy, since
having one client with the rule and one without is exactly why one surface worked
and the other 400'd. Routing deliberately keeps two ids: the board client is
scope-addressed (General ⇒ `''`), the route is rail-addressed (⇒ `~general`), and
a push built from the scope yields the dead `/projects//docs`.

Detail: `docs/as-built/2026-08-09-general-docs-reachable.md`.

## 2026-08-09 — which model runs which phase became configuration

`trident/phase-models.ts` defines a stable owner-facing phase vocabulary (decomposition ·
build · build-mechanical · rubric review · adversarial review · synthesis/arbitration ·
bookkeeping) with per-phase default tier + effort and strict validation; validated
overrides thread to the workflow as `phaseModels` and its router applies them over its own
table. Every default is unchanged and the key is OMITTED when nothing is configured, so an
untouched instance produces byte-identical args.

The settings keys are deliberately NOT the agent labels — several labels are dynamic
(`forge:fix-round-3`, `head-probe-round-2`), so exposing them would reshape the settings
surface whenever the workflow's internals changed.

The coverage test found a real defect on its first run: **`head-probe-round-N` had escaped
the routing table** and was resolving to the fallback — the most expensive tier at high
effort — for a step that runs one `git` command and reports a sha. A missing entry and a
deliberate entry are indistinguishable when the fallback is silent, which is the argument
for the test rather than just the fix.

Also removed a FALSE docblock from `gateway/wiring/resolve-llm-credentials.ts`, which
asserted the ambient pool had "NO FAILOVER" as a KNOWN LIMITATION. The single
credential-less entry is the mechanism, not a defect; rotation swaps the credential file
underneath the child. Retracted in place, with the generalisable lesson kept.

Detail: `docs/as-built/2026-08-09-per-phase-model-config.md`.

## 2026-08-09 — a spoken word is findable in chat search

A voice note was transcribed at upload, written durably beside the audio, and delivered
to memory — and **search could not see any of it**, because the index mirrors the
message `body` and a voice note's body is the attachment placeholder.

The transcript now rides back on the UPLOAD RESPONSE. A user's own message is never
persisted server-side, so the client owns it, and the response is the only point at
which the client can learn the transcript without a new frame. `transcript` is a field
of its own rather than appended to `body`: the body is what renders, and appending would
change how every existing voice note displays. Both search paths were updated through
one shared `searchableText`, since two independent searches over one model is how a
field gets indexed on one platform and not the other.

Two details each of which would have produced a search that passes its tests and is
useless in the hand: `snippet(tbl, -1, …)` (FTS5's "column with the most matches" —
pinned at `body` a voice hit renders an unhighlighted placeholder), and reading the
sidecar on the IDEMPOTENT re-upload path (which deliberately skips the ASR seam, so the
same audio would be searchable once and then silently not).

The FTS DDL was split out of the schema array so column migrations run before the
triggers that name the new column — otherwise a fresh install works and every upgrade
fails. Rebuild is detected from `sqlite_master` DDL, not by probing a query.

Detail: `docs/as-built/2026-08-09-voice-transcript-searchable.md`.

## 2026-08-09 — a voice note's words survive the device (correcting the same day's fix)

The earlier half (#158) shipped on a FALSE belief: that a user's own messages are not
persisted server-side. They are — `app_chat_messages` holds user rows, and `replayAfter`
is how a fresh or reconnecting device rebuilds its history. So the fix worked only on the
phone that performed the upload; a reinstall brought voice notes back with their audio and
none of their words.

Migration 0117 adds a nullable `transcript` column; the store persists it, the replay
envelope carries it, and the client merges it without ever regressing a known value to
null. The SERVER resolves it from its own sidecar rather than accepting it from the
client — the text is already ours, and trusting the client would let any client write into
a field that is indexed and read by the agent. Deliberately not `meta_json`, whose
contract says it is never populated for user messages.

Four mutants; the first pass caught only ONE. The three that survived were: the column
never written, the server never resolving it, and the composer never wiring the seam —
that last being the repeat defect shape SPEC names, with every other test green while the
feature was dead.

Also lands two arbiter design docs (multi-substrate build agent; model usage dashboard),
both awaiting owner decisions rather than implementation.

Detail: `docs/as-built/2026-08-09-voice-transcript-survives-device.md`.

## 2026-08-09 — the per-phase model config gets a producer

The vocabulary, the workflow argument and the router were all built and correct, and
**nothing ever supplied a value** — the orchestrator never passed one and no surface
wrote one, so every run used the defaults regardless of configuration and nothing could
go red. Found by an independent design review hours after the config landed.

Migration 0118 adds `trident_phase_models` to `instance_metadata` (the documented home
for instance-level settings); read/write helpers; a per-launch `resolve_phase_models`
resolver threaded orchestrator → composition → composer; and
`GET`/`PUT /api/app/trident/phase-models` registered across all four required places.

The write fails WHOLE on any invalid entry while the read degrades quietly — the
asymmetry is deliberate: at the settings boundary the owner can be told, deeper in
nobody is listening. `PUT` replaces rather than merges so clearing a pin is an omission,
but an absent `overrides` key is a 400 rather than an accidental wipe.

Three mutants, one per link, each caught by exactly one test. The UI is still missing —
this is the producer, not the pane.

Detail: `docs/as-built/2026-08-09-phase-model-producer.md`.

## 2026-08-09 — Codex and Kimi are connectable from a phone

The gateway's Codex surface is app-scoped (`/api/app/codex-auth`) and the WEB client has
used it since it was built. **Mobile had no client and no screen**, so an owner with only
a phone could not connect the cross-model reviewer at all — the reference deployment
works only because provisioning wrote the credential to disk directly.

Adds a **Model providers** section to mobile Integrations (above Shared credentials, so
the free-text form reads as the escape hatch): Codex status + paste `auth.json` +
disconnect via a new `app/lib/codex-credential-client.ts`, and a named Kimi K3 row.

The Kimi row writes through the SAME global-credential store the free-text form uses and
DERIVES its status from that list — a named row with its own storage path would mean a
key entered here behaved differently from one entered there. The service id is a
repeated literal (the app bundle carries no workspace deps), which makes that string
load-bearing: a mismatch stores the key where nothing reads it and the reviewer stays
silent, so the test asserts it.

12 tests that PRESS the real controls; four mutants each caught, including "the Connect
button is rendered but inert" — the failure a source check cannot see.

Detail: `docs/as-built/2026-08-09-mobile-model-providers.md`.

## 2026-08-09 — the Kimi key comes from the store, and only the store

Owner-directed: the env var *"was a temporary hack, not a production-grade decision."*
`resolveKimiApiKey` read `KIMI_API_KEY` first and fell back to the store, which made the
environment a second resolution path — the same settings screen behaving differently on
two boxes, failing in the direction nobody checks (paste a key, see it saved, every
review keeps using the shell's).

The env argument is gone from the signature. `ensureKimiKeyExported` still writes the
resolved key into the CHILD's env — that indirection keeps the key out of prompt text and
stays. The variable is now purely an output, never an input. Two behaviours flipped: a
pre-set env value is now OVERWRITTEN, and clearing the key in settings CLEARS the export
(without which a stale key survives and the reviewer runs on a credential the owner
believes they removed).

The live key was migrated into the store BEFORE shipping — the box had it only in the unit
env and `project_credentials` was empty, so store-only would have silenced K3. Migration
printed only lengths and outcomes, never the value.

Lesson from that migration: it failed twice with an opaque "failed to open SQLite" that
looked like permissions or locking; the cause was `{ create: false }`, an option
production never passes. A probe that does not use the production call shape fails in a
way that sends you debugging the wrong system.

Detail: `docs/as-built/2026-08-09-kimi-store-only.md`.

## 2026-08-09 — the build-phase models are settable from a phone

Completes the per-phase model/effort chain: vocabulary → store + resolver + endpoint →
**a surface a human can use**. Chat header ☰ → Settings → Code generation, one row per
phase with model and effort chips.

The phase list is SERVER-SUPPLIED (a phase added to the engine appears without an app
release, and neither client keeps its own copy of a list they must agree on). Choosing a
value equal to the default CLEARS the override rather than pinning it — otherwise the
owner freezes a phase against a future default change they never intended. A rejected
save KEEPS the local edits and shows the server's message verbatim, since the server
rejects the whole set and names every fault. Nothing auto-saves.

Reachability is part of the feature: a registered route nothing pushes and a push at an
unregistered route fail INDEPENDENTLY, so the nav row and the Stack registration each got
their own assertion in the #385 guard.

12 press-the-control tests + 2 guard tests; three mutants each caught, including "the
effort chips are rendered but inert".

DEFERRED AND NAMED: the web half (`SettingsTab.tsx`) — same endpoint, no new server work,
but genuinely not done.

Detail: `docs/as-built/2026-08-09-codegen-settings-mobile.md`.

## 2026-08-09 — the build-phase models are settable on the web too

Closes the half #163 named as deferred: a Code generation section in the web Settings tab
over the same endpoint, mirroring the three decisions (server-supplied phase list;
choosing the default CLEARS the override; a rejected save KEEPS the edits and shows the
server message verbatim).

The interesting part is a PARITY test. `effectiveRow`/`applyRowEdit` now exist twice
because each client bundle is free of the other's workspace — correct, and also the risk,
since those two functions encode product DECISIONS. A divergence is the failure nobody
reports: each surface stays self-consistent and the owner just gets a different answer
depending on the device. The copies are executed side by side over ten edit shapes and
seven display shapes.

WHERE it lives was not the first attempt: it began in `landing/` importing the mobile
client relatively, the lint rule caught it, and the workspace specifier then failed to
resolve — because `landing` does not depend on `@neutronai/app` and MUST NOT, that
independence being why the helpers are duplicated. `gateway` declares both, and already
hosts `doc-links-parity` for the same reason.

Four mutants each caught, two of which SURVIVED the first pass (the web component's error
behaviour was untested — found by mutation, not by reading). Also fixed a CSS token that
would have shipped an invisible chip border: `--hairline` is not a token here, `--border`
is, and it is defined for both themes.

Detail: `docs/as-built/2026-08-09-codegen-settings-web.md`.

## 2026-08-09 — a review panel cannot see a red build, so now something else does

Four reviewers read the DIFF and none runs the tests, so a change that type-errors or reds
a shard could be unanimously APPROVED and merged. The reference deployment never showed
this because a GitHub setting blocks it there — which is the problem: the discipline lived
in repository CONFIGURATION, so every self-hoster and every local-merge run had nothing.

DETERMINISTIC, NEVER INTERPRETED: the agent reports `gh pr checks --json` output verbatim
and every judgement happens in JS. ONE GATE, PEERS AS DATA: red → code blockers that force
REQUEST_CHANGES so the fix loop re-Forges; pending/unreadable → a deferred peer on the
EXISTING list, so the loop exits infra-only rather than editing code to fix a timer;
green/none → nothing. `none` is distinct from `green` (a repo with no CI has nothing to
wait for), and local mode short-circuits before spending an agent.

THE HOLE IT NEARLY SHIPPED WITH: `enforceCrossModelGate` returns the synthesis untouched
when there are no deferred peers, so attaching CI findings without setting the verdict
would have APPROVED a red build carrying a "CI FAILING" finding. Red now forces the
verdict. A second near-miss: an unreadable exit-0 reply first classified as `none` — the
unsafe direction; my own test caught it, not my reading.

22 tests against the REAL functions extracted from the .mjs. FIVE MUTANTS, all fail-open,
each caught. The new agent label was caught by #157's coverage test and routed to the
cheap tier — leaving it to the fallback is how head-probe sat on the most expensive tier
for months.

Detail: `docs/as-built/2026-08-09-trident-ci-gate.md`.

## 2026-08-09 — the usage readings are remembered, and turned into a pace

The monitor has always probed the active credential every 60s, cached ONE reading, and
aged it out at five minutes — so the product measured utilisation continuously and
remembered nothing. "Which pool can take this build?" is a question about a TREND, which
is why the dashboard needed a migration before a chart.

Migration 0119 + `persistence/usage-samples-store.ts` + a fail-soft `onSample` hook wired
beside the existing `onStanding` observer. Prune rides on the same call (a cleanup job
that can fall out of step with its writer grows forever or deletes something in use).
PACE = fraction consumed ÷ fraction of window elapsed, computed at read time and never
stored.

TWO THINGS THE TESTS FOUND THAT READING DID NOT. The exhaustion projection divided by
pace TWICE — plausible-looking and wrong; now derived, and pinned by a hand-checkable
case (5h window, half elapsed, 75% used → pace 1.5 → 50 minutes). And an `at < reset_at`
guard turned out to be MATHEMATICALLY UNREACHABLE: pace > 1 implies the projection is
always earlier than the reset. Removed with the proof written down — a dead branch dressed
as safety cannot be tested, so it reads as protection never exercised.

`account_label` exists and is always NULL today: rotation happens outside this process, so
the instance cannot name the account. An inferred name shown as a measurement would be
worse than none.

Six mutants; five caught immediately and the sixth exposed the dead branch. The wiring
tests had to move from `persistence/` to `open/__tests__/` — `open` depends on
`persistence`, never the reverse, and the lint refusal was the architecture talking.

Detail: `docs/as-built/2026-08-09-usage-sample-series.md`.

## 2026-08-09 — Usage dashboard: the endpoint and the web card

`GET /api/app/usage/dashboard` + the Model usage card in web Settings. The endpoint
went into the EXISTING usage surface rather than a new one: same owner gate, same
subject, and a second near-identical surface is how one stops being wired. The cost
of that is a prefix hazard — the meter's path is a strict prefix of the dashboard's —
pinned in both directions.

What the card refuses to say is the substance. An unreachable route draws no bar
(a 0% bar invents a measurement); a null pace renders as an em dash, never `0.0×`;
a null projection OMITS its row, because null is the common good case and a
permanent dash trains the eye to hunt for an absent warning; and a null account
label reads "active credential" and never guesses.

The wiring test now checks the READ half separately from the write half — the write
assertion had passed for a whole PR during which nothing read the series.

Detail: `docs/as-built/2026-08-09-usage-dashboard-card.md`.

## 2026-08-09 — The chat agent can search the web

`LIVE_AGENT_TOOL_NAMES` had never contained `WebSearch` or `WebFetch`, and that array
is the only thing that decides. Reported via a ritual, but it was never ritual-specific:
ordinary chat could not look anything up either. A missing built-in produces no error,
only an agent that says it has no such tool, which is why nothing upstream noticed.

The worse half: a ritual declaring a web tool must be approved for `egress: 'web'`
through a separate grant reading "may reach the public internet". That grant was given
for `kaizen` over a capability the code could not exercise. An approval prompt that
overstates what it grants spends the credibility the whole gate rests on.

Guarded by a new test asserting every bundled ritual's declared built-ins are a subset
of the live surface — the join between two green suites whose union was broken, the same
shape as the push-kind drift.

Detail: `docs/as-built/2026-08-09-live-agent-web-tools.md`.

## 2026-08-09 — Model usage on the phone

☰ → Settings → Model usage. Same two windows, same pace, same refusals as the web card.
Both wiring points present (nav row + Stack.Screen — they fail independently) and the
screen test presses real controls.

A first draft re-declared `usageBand`/`clampFraction` on the phone with a bundle-
independence justification that `app/components/UsageMeter.tsx:20` disproves — it already
imports both from `@neutronai/contracts`. Both now come from the contract and the parity
test asserts neither client exports its own. The formatters stay twinned, correctly:
production code in `app/lib` never imports `landing`.

Every refusal mutation-tested separately, including one attempt that was NOT faithful and
proved nothing until rewritten.

Detail: `docs/as-built/2026-08-09-mobile-usage-card.md`.

## 2026-08-10 — the builder gets the spec doc's BODY, not its YAML frontmatter

`WorkBoardSpecDocService.resolveTaskForItem` returned `doc.content.trim()` — the whole
document. `buildSpecDocMarkdown` prepends a frontmatter block (`type` / `title` /
`created`), so **the builder's first instruction was YAML metadata** rather than the scope.

Observed live on two separate email-core runs, whose dispatch branches came out
`trident/type-plan-title-p1-email-pipeline-s`. The slug is derived from the task text, so
the leak was visible in the BRANCH NAME while the real damage — a builder opening its
brief on `type: plan` — was invisible.

`stripFrontmatter` is exported and deliberately narrow:

* the fence must **open on line 1** (leading blank lines tolerated). A `---` further down
  is a horizontal rule, and this repo's plan docs use those constantly — treating one as a
  closing fence would silently truncate the brief from the top, strictly worse than
  leaving the header on.
* the fence is a line that is **exactly** `---` after trimming, not one that merely starts
  with it.
* an **unclosed** opener is returned untouched; guessing where it ends would discard content.
* a doc that is **only** frontmatter strips to empty, and `resolveTaskForItem` already
  treats empty as "no usable spec" and falls back to the card title — so it degrades to
  the title rather than dispatching a blank brief.

### The tests were worthless on the first pass, and the mutation run is what caught it

Seven cases passed, and **both mutants survived**:

* **Reverting `resolveTaskForItem` to raw content passed all seven** — every case tested
  the pure helper and none called the function actually being fixed. **The fix's own call
  site had zero coverage.** Now covered by a real round-trip: create a card with a spec,
  read the task back, assert no `type: plan` and no `created:` reach it, and assert it does
  not merely begin past the header by accident.
* **The "mid-document `---` is a rule, not a fence" case had ONE `---`** — so a mutant that
  scans for a fence *anywhere* still finds no closer and returns the input unchanged. The
  fixture could not distinguish the correct rule from the broken one. It has two rules now.

Each mutant now dies on a **different** test.

📌 **A test that passes against the mutant is not weak coverage, it is ZERO coverage, and
it looks identical to the real thing in a green run.** Second occurrence today. The
mutation step is the only thing that separates them.
## 2026-08-10 — a terminal trident transition retracts a stale "still running" claim

Observed live: the owner cancelled a running email-core build and the row settled at
`phase='stopped'` with **`subagent_status='running'`**. The child was already dead — the
column was asserting something false.

> ⚠️ **"The child was already dead" is WRONG too, and is kept only as the record of what
> was believed.** Cancelling does NOT kill the detached workflow (#177): it keeps running
> and keeps checkpointing. This incident held by TIMING — the workflow happened not to
> checkpoint again before the row was read — not by construction, which is exactly why the
> fix needs the durability half in `trident/checkpoint.sh`. What is true of EVERY cancel is
> narrower: the column is wrong about the RUN (nothing will advance it again), not
> necessarily about the process. Corrected in round 3 below; marked here because the
> ⚠️ block that follows scopes only the paragraph after it, and a reader who stops at the
> opening would carry away two false claims rather than one.

`subagent_status` is documented (migration 0077) as the CURRENTLY in-flight subagent, and
gates key on it: #143's fix widened the harvest/terminal block on
`subagent_status === 'crashed'`, and the hang-watchdog and orphan-recovery read it too. A
terminal row reading `running` is precisely the stale field those readers can act on, so
this is not tidiness.

> ⚠️ **That paragraph is WRONG and is kept only as the record of what was believed.** All
> three named readers are unreachable on a terminal row — `step()` no-ops on
> `isTerminalPhase` before the harvest gate or orphan recovery run, and the hang watchdog
> keys on `last_advanced_at`. The reader that is actually load-bearing is `update()`'s crash
> veto. Corrected in "Two corrections to the round-1 text" ~110 lines below; the correction
> is repeated here because a reader who stops after the opening rationale would otherwise
> carry away the false one.

`TridentRunStore.terminalTransition` now clears it **in the same atomic UPDATE** that
writes the terminal phase:

```sql
-- as of round 2 the set is IN ('running', 'pending') — see the round-2 note below
subagent_status = CASE WHEN subagent_status = 'running' THEN NULL ELSE subagent_status END
```

**Only `'running'` is cleared, and that restriction is the load-bearing half.** Nulling
unconditionally would erase a `'crashed'` marker whenever anything terminated an
already-crashed run as `'failed'` — deleting the signal #143 added a gate for, while
looking like a cleanup. `completed`/`failed`/`crashed` are OUTCOMES worth keeping;
`running` is the only value that is a live CLAIM, so it is the only one a terminal
transition has business touching.

`NULL` rather than a new `'cancelled'` enum value because the column carries a CHECK
constraint (`migrations/0077_code_trident_runs.sql:107-108`) that SQLite cannot alter
without a table rebuild — heavier than the defect warrants — and `null` already means
"nothing in flight" here (`trident/orchestrator.ts` writes it on the no-subagent paths).
The reason for the stop survives in `failure_reason`, so nothing is lost.

**Verification:** 6 cases in `trident/store.test.ts` against a REAL migrated DB, each with
a non-empty precondition asserting the row actually carried the status first. Two mutants
killing DIFFERENT tests — dropping the retraction reds the cancel case; nulling
unconditionally reds the `crashed` AND `completed` cases — so both halves of the CASE are
proven necessary. A loser transition (second terminate on an already-terminal row) is
covered too: it must not clear a status on its way past.

📌 **The first draft of these tests went in the wrong file.** `trident/terminate.test.ts`
uses a FAKE store, so a SQL-level fix is invisible there — the tests would have passed
without exercising the change at all. Test the SQL where the SQL lives.

**Review pass (3-lane panel) added two cases and corrected one claim above.**

The blast-radius question resolved clean: the only production path into
`terminalTransition` is `terminate.ts:143`, its four callers read `.phase`/`.failure_reason`
only, and no reader of `subagent_status` exists outside
`trident/{orchestrator,state-machine,store,inner-loop-sim}.ts`. The tick loop is a separate
terminal writer (`saveIfActive`), so the hang watchdog and orphan recovery — which set the
column explicitly in their outcome — are untouched.

Two gaps the original 6 cases left:

1. **The SHORT `params` branch was unpinned.** Omitting `failure_reason` makes `params` one
   element shorter, and the board X-cancel (`work-board-surface.ts:531`) and `/code stop`
   (`code-command.ts:281`) BOTH terminate without a reason — two of the four callers take
   the branch no test covered. It binds correctly, but nothing held it there. Now pinned
   column-by-column, killed by a mutant that pushes the parameter unconditionally.

2. **The stated reason the `'running'`-only restriction is load-bearing is not the real
   one.** The comment credits #143's harvest gate, but `step()` no-ops on an already-terminal
   phase (`orchestrator.ts:680-683`), so that gate is unreachable once the row is terminal.
   The path where preserving `'crashed'` actually bites is `update()` — the ONE writer with
   no `phase NOT IN (terminal)` guard, whose `subagent_status IS NOT 'crashed'` veto
   (`store.ts:447-449`) is all that latches a crash on a terminal row. Nulling
   unconditionally would lift that veto. The restriction is right; the justification was
   aimed at the wrong mechanism, so a future "simplify to NULL" could have cleared the
   cited-but-unreachable gate and still broken the real one.

Both `'running'`-clearing guards elsewhere are also gated on `phase NOT IN (terminal)`
(`store.ts:411`, `:638`), so clearing the claim at terminal time makes no guard unreachable:
`crashRunningByLauncher` could never sweep a terminal row regardless.

📌 **A placeholder/parameter arity mismatch is LOUD, not silent** — sqlite throws, and the
mutant that introduced one reddened eleven tests. The dangerous shape is a same-count
REORDER, which is why the new case asserts each column separately instead of just the status.

**Round 2 — the retraction was not DURABLE. `trident/checkpoint.sh` now refuses a terminal row.**

The panel's blocker: the retraction held by TIMING, not by construction. Cancelling a build
writes the terminal phase but does not kill the detached inner workflow — nothing in the
cancel path reaps the child. That workflow keeps going, and every per-phase checkpoint pushes
`subagent_status running` (`trident/inner-workflow.mjs:567`) through `trident/checkpoint.sh`,
whose UPDATE was `WHERE id='<run-id>'` with no phase predicate. So the sequence `/code stop`
mid-Build → row goes terminal with the claim retracted → next inner checkpoint → the claim is
back, on a terminal row, with `branch` and `last_advanced_at` re-stamped. The exact state this
work exists to remove, recreated by the only writer that had no terminal guard.

The fix is the matching predicate, so the terminal chokepoint and the out-of-band writer agree:

```sql
UPDATE code_trident_runs SET <fields> WHERE id='<run-id>'
  AND phase NOT IN ('done', 'failed', 'stopped')
```

Nothing useful is dropped, because `step()` returns early on `isTerminalPhase`
(`trident/orchestrator.ts:679-683`): no reader ever consults a value a post-terminal
checkpoint would have written, `inner_result` included — a terminal row is never harvested. A
skipped write stays exit-0 (the checkpoint step must never fail a build) but now reports on
stderr, because a silently-dropped checkpoint is exactly the kind of absence that costs hours;
`changes()` is read in the same sqlite3 invocation and `tail -1` drops the busy_timeout
PRAGMA's own echo.

**Two corrections to the round-1 text above.**

1. The docblock in `trident/store.ts` still justified the retraction via #143's harvest gate,
   the hang watchdog and orphan recovery — all three unreachable on a terminal row (`step()`
   no-ops first; the watchdog keys on `last_advanced_at`). Round 1 corrected that in this log
   and left the comment saying it. Now the comment names what is actually load-bearing: the
   CRASH VETO on the two write paths (`store.ts` `update()` and `saveIfActive()`), plus the
   human read of a finished row, which is where the false claim was spotted in the first place.
   Rule 3a shape — a confidently specific wrong rationale is worse than none, because the next
   reader trusts it.
2. The loser-transition test could not prove what it claimed. It set the already-terminal row
   to `'crashed'`, which the CASE preserves anyway, so the assertion passed whether the loser
   wrote nothing or wrote the preserving CASE. It now puts back `'running'` — the one value the
   CASE *would* clear — and asserts row state before `won`, so a leaked write cannot hide
   behind the `won` assertion. Killed by the mutant that drops the terminal predicate.

`'pending'` is cleared too now. No production path writes it (the orchestrator writes only
running/completed/failed/crashed/null), but it is in the type and in migration 0077's CHECK,
and it ASSERTS a child just as `'running'` does. The split that matters is claim vs outcome,
not one enum value.

**Verification:** 613 trident tests green. Five new cases in `trident/checkpoint-sh.test.ts`
against a real throwaway sqlite db — a per-phase checkpoint against `stopped`/`failed`/`done`
writes nothing and re-stamps nothing, the terminal-result write is refused too, a non-terminal
phase is unaffected (the guard is not a blanket refusal). Mutant: deleting the predicate reds
four of them. That suite needed a `phase` column added to its fixture table, which is its own
small lesson — a hand-rolled fixture schema silently omits the column your new guard reads.

📌 **A SQL-level guard on the read side is only half a fix when an unreaped process still holds
a pen.** The question that found this was not "is the write correct?" but "who else can write
this row after it is terminal, and what stops them?" — and the answer was a shell script three
directories away that no one had thought of as part of the state machine.

**Round 3 — the freeze was too WIDE, and two of its tests could not fail.**

Round 2's guard was `AND phase NOT IN (terminal)` on the whole UPDATE, which threw away the
orphan's `branch`/`pr`/`inner_checkpoint`/`inner_result` along with its liveness claim — and the
comment asserting "nothing useful is dropped" was false in exactly the case this work is about.
The cancel does not kill the workflow, so it can push a branch and open a PR **after** the
cancel; those columns are the only trail from the run row to that PR, and `run-progress.ts:188`
surfaces `pr` to the board. On a first launch this script is the ONLY writer of either — the
launch persist carries `branch`/`pr` forward but cannot invent them (a fresh run's `branch` is
null and `detectExistingPr` probes a branch that does not exist yet). Blanket-refusing them left
an untraceable orphan PR.

The freeze is now SCOPED to the two liveness columns, and nothing else:

```sql
subagent_status  = CASE WHEN phase IN ('done','failed','stopped') THEN subagent_status ELSE '<new>' END
last_advanced_at = CASE WHEN phase IN ('done','failed','stopped') THEN last_advanced_at ELSE '<now>' END
```

`subagent_status` is the claim; `last_advanced_at` is the hang watchdog's heartbeat. Everything
else lands: inert on a terminal row (`step()` no-ops, so nothing resumes from a checkpoint or
harvests a result) but readable, which is the point. A cancelled row carrying a stale parseable
`inner_result` is an ANTICIPATED state rather than one this change introduces —
`isTridentHarvestTerminal` keys on the durable `harvested_at` marker that `terminalTransition`
never sets, explicitly so such a row emits no handoff (RC2, `orchestrator.ts:220-235`). The `inner_result_file` path nests both
guards — terminal freeze outermost, then the original readfile column-consistency CASE. Because
the freeze now lives in the SET expressions rather than the WHERE clause, a terminal row still
matches and `changes()` still reports 1, so the stderr report re-reads the phase in the same
sqlite3 invocation and distinguishes *frozen* from *run not found*.

The un-reaped workflow itself is now filed as **rjunee/neutron#177** and cited from both halves
of the fix — this PR makes the record honest, it does not stop the orphan.

**Two blockers in the round-2 TESTS — both were assertions that could not fail.**

1. **`checkpoint-sh.test.ts` seeded `phase='Build'` / `'Review'`** — values migration 0077's
   `CHECK` rejects. The terminal guard was therefore never once exercised against a legal ACTIVE
   phase: a mutant guard that froze only `('Build','Review')` passed the entire suite while
   freezing every phase production can actually hold. The throwaway fixture table now carries
   0077's real `phase` CHECK (so an illegal seed throws — pinned by its own case), the terminal
   cases iterate `TERMINAL_PHASES`, and the "not a blanket refusal" control iterates **all five**
   active phases.
2. **The `subagent_status` matrix omitted `'failed'`** — the fifth and last value the CHECK
   admits. A mutant clearing `IN ('running','pending','failed')` survived the whole suite while
   erasing the subagent-level outcome of every failed build. Covered now; the matrix is complete
   against the CHECK.

Three mutants killed on the scoped freeze: removing it (4 red), applying it to every phase (7
red), extending it to `branch`/`inner_checkpoint`/`inner_verdict` — i.e. regressing to round 2's
blanket refusal (4 red).

Two smaller corrections. The store docblock credited `saveIfActive()`'s crash veto as
load-bearing alongside `update()`'s; it is not — `saveIfActive` also carries
`phase NOT IN (terminal)`, so on a terminal row it cannot land whatever the column says, and only
`update()` (the ONE writer with no phase predicate) actually latches a crash there. And the
short-params test's rationale claimed a shifted parameter "would be silent": a timestamp bound to
`phase` is rejected loudly by the CHECK — `failure_reason` is the column that shape would quietly
hit, which is why the case pins each column separately.

The terminal-set literal in `checkpoint.sh` is a fourth copy of `TERMINAL_PHASES`, so
`inner-workflow.test.ts` — which already asserts that script's SQL as text — now pins the literal
against the constant and asserts it appears exactly once.

📌 **A test can be green because the code is right, or because the fixture made the wrong answer
unreachable.** Both blockers here were the second kind, and both were invisible in review until
someone compared the fixture's values against the production CHECK constraint. When a guard keys
on an enum, the fixture must carry that enum's constraint — otherwise the test is asserting over
a value space production never has.

**Round 3 — the docblock's OPENING claim was false, and the fixture was still laxer than
production in two more columns.**

1. **"The child is dead" contradicted the same docblock's own DURABILITY paragraph.** The
   comment above `terminalTransition` opened by asserting that after a cancel the child
   process is dead, while its DURABILITY paragraph — twelve lines below — correctly stated
   that cancelling does NOT kill the detached workflow, which keeps checkpointing
   (#177). Both cannot be true. The observed incident held by TIMING, not by
   construction: the workflow happened not to checkpoint again before the row was read.
   The opening now claims only what is actually true of every cancel — the column is wrong
   about the RUN (nothing will advance it again), and explicitly NOT that the process is
   gone. The same false sentence was corrected in the PR description.

   The round-2 correction of the *reader* rationale (crash veto, not #143's harvest gate)
   was already in the code at this round's start; only the opening sentence was outstanding.

2. **`last_advanced_at` was declared nullable and seeded NULL — a state production cannot
   hold** (`migrations/0077_code_trident_runs.sql:118` is `TEXT NOT NULL`, re-stamped on
   every transition). The fixture also seeded `subagent_status='pending'` in every single
   case, never NULL — even though NULL is exactly what `terminalTransition` itself leaves
   on a cancelled row, so it is the value the very next checkpoint after a cancel sees.
   The throwaway table now carries the NOT NULL and the `subagent_status` CHECK, seeds a
   real timestamp, and seeds the claim BOTH ways.

Two mutants that the laxer fixture let live, each **executed** rather than reasoned about:

| mutant (one extra AND-clause on the OLD value in `frozen()`) | old fixture | new fixture |
| --- | --- | --- |
| (a) freeze `subagent_status` only when it was `'pending'` | survives, 23 pass / 0 fail | dies, **3** red at `expect(r.subagent_status).toBeNull()` |
| (b) freeze `last_advanced_at` only when it was NULL | survives, 23 pass / 0 fail | dies, 8 red at `expect(r.last_advanced_at).toBe(SEEDED_HEARTBEAT)` |

(a) would have written `'running'` straight back onto a row a cancel had just cleared —
re-creating the exact reported bug through the one writer with no terminal guard. (b) is
the sharper one: its condition can NEVER hold in production, so the mutant refreshes the
heartbeat of every real finished run — and under a NULL-seeded fixture the condition always
held, so the suite stayed green while the guard did nothing.

📌 **The two failure shapes in this PR are the same shape at different altitudes.** A
fixture laxer than production puts the wrong answer out of the test's reach; a comment that
justifies a design via a path that cannot execute puts the wrong reason out of the reader's
reach. Both survive review by looking like the finished article — a green suite, and prose
that reads as design documentation. The control that catches the first is running the mutant
against BOTH fixtures and showing it survives one; the control that catches the second is
grepping for the code that enters the mode the comment describes.

**Round 4 — the mutation EVIDENCE was itself a claim, and one of the two guards has no
reachable failure on this platform.** Both findings are about the same thing: prose that
asserts coverage it does not have.

1. **A comment claimed a test killed a mutant that in fact passes it.** The terminal-result
   case in `trident/checkpoint-sh.test.ts` was annotated "the value mutant (a) would let
   through here". It would not: that case passes only `inner_result_file` + `inner_verdict`,
   so its `subagent_status` comes from the freeze arm built INLINE in
   `trident/checkpoint.sh` (the `inner_result_file` branch), which is a second,
   hand-written copy of the terminal predicate and does not route through `frozen()` at
   all. Executed: mutant (a) takes **3** tests red and this is not one of them.

   Re-measuring it also caught a stale number in the round-3 table above: it recorded
   mutant (a) as "4 red", and the count on that same commit is **3** (the three terminal
   phases of the already-retracted case). Corrected in place, and in the PR description.
   The number was wrong when it was written, not made wrong by a later edit — the suite
   count is unchanged at 27 either side of this round.

   The second copy does need its own mutants, so the comment now names the ones this case
   actually kills, both executed:

   | mutant on the INLINE readfile freeze arm | result |
   | --- | --- |
   | (c) drop the `WHEN phase IN (terminal) THEN subagent_status` arm | dies, 2 red |
   | (c2) narrow it with `AND subagent_status = 'pending'` | dies, **1** red — ONLY the already-NULL case |

   (c2) is the one that justifies the case existing: its sibling seeds `'pending'`, which
   the narrowed arm still freezes, so the sibling stays green and a row whose claim a
   cancel had ALREADY retracted is the only thing that catches it.

2. **A guard was pinned by a test that could not fail, so the test was deleted.** The
   stderr diagnostics parse sqlite3's list-mode `N|state` line, and the invocation now
   carries `-init /dev/null -list -separator '|'` so a host rc file cannot mute them. A
   fixture pointing `HOME` at a hostile `.sqliterc` was written, and then removed after
   the negative control: measured on sqlite3 3.43.2 (Apple), an rc file changes the format
   when passed as `-init <file>` (`'c;s\n0;active\n'`) but is NOT picked up from a `HOME`
   override — so the fixture passed **identically with the pins removed**. Covering it for
   real would mean writing into a developer's actual home directory. The pins stay as
   environment hardening for builds that do read an rc; both files now say so, including
   that no test covers it.

Doc-accuracy fixes in the same pass: the "`update()` is the ONE writer with no terminal
predicate" claim was false — `save()` has neither the predicate nor the crash veto, and is
inert only because it has ZERO production callers (production commits go through
`saveIfActive`, `trident/tick.ts:263`); the claim now says "the only writer REACHABLE on a
terminal row that both lacks the predicate and carries the veto" and names why each of the
other two is excluded. `trident/store.test.ts` had also kept the superseded rationale
attributing the load-bearing veto to `saveIfActive()`, contradicting the same branch's
docblock two files over. And the opening line of this entry — "the child was already dead"
— carries its own ⚠️ retraction above, because the existing marker scoped only the
paragraph after it.

📌 **Mutation evidence decays into folklore the moment it is written down next to the wrong
test.** "Kills mutant (a)" is checkable prose that nobody rechecks, and the failure mode is
specific: a guard that exists in TWO independently-built copies gets one copy's evidence
pasted onto the other's test, and the untested copy is then defended by a citation. The
control is mechanical — run the named mutant and read WHICH tests go red, not how many.

## 2026-08-09 — Naming the account behind a usage reading

The `account_label` column has been null on every row since it was created. This reads an
optional `.credentials.meta.json` sidecar beside the credential, written by whatever swaps
it, and uses the label ONLY when its fingerprint matches the token actually resolved.

A missing label is harmless — it renders "active credential". A STALE one is not: it would
attach the previous account's name to the current account's reading and send the owner to
move quota away from an account that was never under load. Mismatch degrades to null.

Token and label come from ONE `resolveActiveCredential` call, so a swap landing between two
calls cannot pair one account's reading with another's name.

The instructive mutant: dropping the fingerprint check fails immediately, but making the
MONITOR persist a null label while the resolver stayed correct passed everything — "resolved
but never carried", one layer along from "built but never wired". Now covered.

Nothing writes a sidecar yet, so every label is still null and behaviour is unchanged.

Detail: `docs/as-built/2026-08-09-credential-account-label.md`.

## 2026-08-10 — the credential fingerprint is scrypt (CodeQL `js/insufficient-password-hash`)

`credentialFingerprint` hashed the live OAuth token with a bare SHA-256; CodeQL flagged it
and, being a required check on Open's `main`, blocked the PR. The finding is right in form
— a bare digest of a credential is one dictionary from reversible — and while it is not
exploitable here (long random tokens, 0600 sidecar beside the credentials file), that
rests on three facts a later change could remove. Now `scryptSync` at `N=4096, r=8, p=1`,
output shape unchanged at 12 hex. The salt is fixed because two processes must derive the
same value sharing only the token; it buys domain separation and nothing more, and says so.

The header's prose description of the algorithm was deleted: a cross-process contract
spelled out in prose drifts silently, and a writer trusting the stale line would produce a
digest the reader rejects with no symptom but missing labels. Writers import the function.

Detail: `docs/as-built/2026-08-09-credential-account-label.md`.

## 2026-08-10 — the sidecar contract drifted in the DOCS, which are its only interface

The scrypt change corrected the algorithm in `open/credential-label.ts` and left both
writer-facing docs stating a recipe the reader silently rejects: the as-built detail file's
§ The sidecar still printed `sha256(token)`, and
`docs/plans/2026-08-09-model-usage-dashboard.md` Tier 1 still described a bare
`{"label": "acct-2"}` with no fingerprint at all.

Half of this contract runs in ANOTHER PROCESS and has nothing but the docs, so a stale
sentence there is a defect in the feature, not a typo. Proven by following each documented
recipe literally against the real reader: sha256 slice → null, bare label → null,
`credentialFingerprint` → `"acct-2"`. The symptom of getting it wrong is that labels never
appear, which is indistinguishable from the ordinary unlabelled case — so nobody would have
found it from the outside.

Both docs now point at the function instead of restating an algorithm, and a test pins the
CONTRACT statements — the fenced JSON block and the Tier-1 bullet — rather than the prose,
because the as-built file legitimately discusses SHA-256 and scrypt in its history section
and a guard tripping on that would be a false positive on the document it protects. Each
stale form was restored as a mutant and killed the test.

📌 **The 📌 note recording a lesson is not exempt from the lesson.** This drifted a second
time inside the very change that wrote "a cross-process contract described in prose will
drift", and it survived in the MORE load-bearing of the two places: a rotator author reads
the sidecar doc, not the module header. Fixing the code and leaving the doc is not half a
fix — where the only consumer is an external writer, the doc IS the interface.

Detail: `docs/as-built/2026-08-09-credential-account-label.md`.

## 2026-08-10 — the label reached the monitor and stopped there: the PRODUCTION sink was unpinned

Review round on the account-label reader. Three defects, none of them in the refusal itself
— that part holds: deleting the fingerprint check fails
`REFUSES a label whose fingerprint describes a different token` immediately.

**The surviving mutant was one layer past the one the feature was proud of catching.** The
commit message records that "the MONITOR persists a null label" passed the whole suite and
is now killed. It is. But the tests that prove the label is *carried* supply their OWN
`onSample`, so they pin the monitor and say nothing about the sink that actually runs.
Rewriting `open/composer.ts` to name columns one at a time —
`record({ pool, ts, session, weekly })` instead of `record({ pool, ...reading })` — dropped
`account_label` on every production row and passed **36/36** tests across all three of the
feature's files. Repo-wide: only `open/__tests__/usage-sample-persistence.test.ts` covers
that wiring at all. Its composer guard asserted `usageSamplesStore.record(` was *present*,
never that the reading rode along whole. Now it asserts the spread, and the mutant dies.

📌 **A test that supplies its own seam proves the layer above the seam, not the seam.** Both
mutants here are the same "resolved but never carried" shape; killing it at the monitor made
the next copy of it downstream *look* covered, because the assertion that died was about a
sink the test wrote itself.

**`slice(at, -1)` is not a failure, it is a silent widening.** The doc-drift guard added to
stop the sidecar contract rotting a third time scoped itself with
`doc.slice(at, doc.indexOf(to, …))` and checked only that the START was found. Renaming the
plan's Tier-2 heading made the terminator unfindable, `indexOf` returned -1, and the
"Tier 1 bullet" grew from **982 to 11328 characters** — the rest of the document — with all
three assertions still green. Verified both ways: the mutant passes 15/15 against the
original helper and fails against the guarded one. Same pattern fixed at both composer-block
slice sites.

**The scrypt cost docblock described a system that does not exist.** It claimed N=4096 stayed
"invisible on the tick" and that ~100 ms was what the *default* N would have cost. Measured
under bun: **~73 ms steady-state, ~280 ms on the first call, synchronous, on the event
loop**; the default N=16384 is ~534 ms, and N=1024 is the setting that would cost the "few
milliseconds" the comment implied. What actually bounds the cost is placement, not size —
the fingerprint is computed only after a sidecar is found and parsed, so no box pays it
today. Left at N=4096 deliberately rather than changing a security parameter inside a review
round; the comment now carries the real numbers so whoever ships the writer decides with
them. Behaviour unchanged: comments and tests only.

Detail: `docs/as-built/2026-08-09-credential-account-label.md`.

## 2026-08-11 — the account-label reader's REAL path had no positive test (review round 2)

Every positive test for the sidecar injected its own reader. That left the two things which
can only ever be wrong in production asserted by nothing: WHERE the sidecar is looked for,
and whether the default reader is wired to look there at all. The one test that used the
default reader pointed at a directory that does not exist and expected null — an assertion a
completely wrong path satisfies exactly as well as a correct one.

Two tests now write real files into a temp dir and pass no deps: one proves a good sidecar is
found and used, one proves a STALE sidecar is refused *through the same wiring that accepts
the good one*. The refusal is the whole value of the feature, and until now it was only ever
proven against a stub.

Mutants run, not asserted: renaming the sidecar basename (dies), looking for it inside the
credentials path instead of beside it (dies), and replacing the fingerprint comparison with a
check that only rejects an empty string — the refusal replaced by a guess — which now dies at
BOTH layers instead of only against the injected reader.

**The 0600 sidecar permission was a security argument that asked nothing of anyone.** The case
for scrypt over a bare digest cites a mode-0600 sidecar as one of three facts making a weak
digest unexploitable, while the writer-facing contract required no permission at all. The
reader cannot check the mode, and refusing a loose one would drop the label silently — the one
failure mode this feature is arranged to avoid — so the requirement now lives in the contract
where a writer reads it, and a doc guard asserts it stays there. Mutant: softening the
requirement to prose fails the guard.

**The label limit was 64 with no test at 64.** A 200-character rejection is satisfied by any
off-by-one version of the check. Boundary covered; the `>` → `>=` mutant now dies.

**Three current-state docs claimed the feature was impossible.** `docs/as-built/…-usage-sample-series.md`
said the column is "always null today" and the instance "genuinely cannot name the account";
both dashboard clients' docblocks said nothing on the box can name it. All true before this
branch and false after it — the aspirational-docblock hazard in reverse. The dated entries keep
their text with a superseded note (they are a log, not current state); the live docblocks now
say null means *nothing named it, or the name on disk described a different token*, which is
what the code does.

Behaviour unchanged in this round: tests, comments and docs only.

Detail: `docs/as-built/2026-08-09-credential-account-label.md`.

Landed via PR #170 — trident verdict APPROVE at round 2. The panel was THREE lanes
(adversarial + rubric + an independent codex lane). The kimi lane was ABSENT BY DESIGN, not
failed, so this is not a four-lane APPROVE and should not be read as one.
