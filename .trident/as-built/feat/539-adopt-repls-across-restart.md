## 2026-09-12 — a gateway restart keeps its project REPLs: the pane survives, the next gateway takes it back

Step 2c of the herdr cutover (GitHub issue #539), on top of #538's herdr host and
#537's durable sink coordinates. Spec item:
`docs/spec-items/a-gateway-restart-keeps-the-project-repls.md`.

**The durability boundary, first, because the weaker and stronger claims are one word
apart.** A REPL is now a pane of the **herdr server**. A **gateway** restart therefore
does not end it — that is what this change recovers. A **herdr server** restart DOES
end it, because panes are its children, and nothing here changes that; what survives
one of those is the transcript, via the pre-existing `--resume`. No sentence in this
record, the spec item or the code says "survives a restart" without naming which
process restarted.

### What was actually missing, verified before building on it

- `orphan-adoption.ts:49-53` was adopt-or-**kill** and only ever killed: verdicts
  `killed | not-ours | dead | no-pid`, no adopt arm, no caller that could consume one.
- `gateway/index.ts` kills the warm pool from the SIGTERM handler, deliberately: under
  the old `KillMode=process` units every descendant reparented to init on each restart
  and accumulated — 632 orphans, ~19 GB, 2026-06-11.
- A survivor could not have been used even if found. Authorization runs credential →
  session (`pool-state.ts`, `ReplSink.handle`), the credential is
  `HMAC(root token, childGeneration)` (`sink-coordinates.ts`), and a restarted sink has
  registered nothing — so the survivor's `/reply` is 401. `durable-reply-sink-coordinates.md`
  asserts that refusal as a criterion; this change is what makes it stop being true.
- Every detector latch is in-memory (`repl-session.ts`, `OutputScanner`), so a
  re-adopted pane's first screen would read as a rising edge for whatever was already
  on it.

### What was built

**A durable handle, and the survival fact it carries.** `PtyChild.paneHandle` is the
identifier a LATER process can reach a child by — the pane id under herdr, ABSENT under
`bun-terminal-host.ts`, whose children die with the gateway. Its presence is exactly
the question the shutdown path and the boot pass both ask, so it is one field and one
fact. `ReplRegistryRecord.pane_handle` persists it, and the spawn RE-STATES it rather
than merging: a row that inherited a handle from a differently-hosted predecessor would
send the next boot to a pane id that names nothing — or, after a herdr server restarted
its pane numbering, somebody else's pane.

**An adoption surface on the host.** `AdoptableHost` (inspect / attach / close) is
separate from `PtyHost` because the capability is genuinely absent from the in-process
backend rather than unimplemented there, and `hostSupportsAdoption` is what the code
consults before declining to kill anything. `HerdrHost.spawn` and `HerdrHost.attach`
share one `open()` body, so a re-attached child is wired identically to a spawned one —
same poll loop, same actuation queue, same exit settlement — by construction rather than
by review. The one place they differ is the cleanup obligation: a failed SPAWN closes
the pane it created (otherwise it manufactures an orphan on an error path), and a failed
ATTACH closes nothing, because that pane is somebody's live conversation and destroying
it to tidy up our own wiring failure is the worst outcome available.

**The adopt verdict.** `classifyPaneForAdoption` is pure and consumes only what a host
can honestly report. Adoption needs TWO positive argv matches: the session id as the
value of `--resume`/`--session-id` (which says WHICH TRANSCRIPT the process is on) and
`--dangerously-load-development-channels server:<this row's channel>` (which says WHICH
SPAWN it came from). The second is what separates our child from a `claude` somebody
else started on our transcript — and the shape that produces one is not hypothetical:
herdr's own native agent restore relaunches a claude pane as exactly
`["claude", "--resume", <id>]` (`src/agent_resume.rs`, `plan()`, read in the 0.9.0
source tree available on this box; the installed server is 0.8.2, so no line numbers are
cited as if they were the running binary's). That relaunch carries none of our flags, so
it can never answer a turn — and it is on our transcript. It gets `close-foreign-owner`.

**The boot pass** (`boot-adoption.ts`) runs PER SESSION KEY, not per registry, and that
is a correctness requirement rather than a granularity preference: a pool key folds the
instance, user, project and credential, so two rows in one registry belong to substrates
with different options, and rebuilding one row's session from another's would scope a
REPL to the wrong project. Each substrate reconciles its own key with its own options.

The consequence, named rather than left to be discovered: a row whose substrate this
process has not constructed is NOT reconciled, so its pane keeps running until a turn
for that key arrives (which is when a substrate for it is built, and which is exactly
when it matters). That is safe because the watchdog's own liveness probe reads a
healthy survivor as healthy and takes no action, and a wedged one goes through the
pre-existing `#105` pid-identity orphan kill before its respawn.

Every `adopted` verdict is a conjunction of three probes that could have come back
negative, through two independent authorities: herdr says the pane is live; the pane's
foreground argv matches twice over; and the dev-channel at the row's recorded port
answers `/health` **with this row's session id** (`httpHealth`'s `expectedSessionId`,
which exists because a recycled port can serve a different REPL). Nothing is derived
from the row alone — a row is a claim, and this pass exists because claims go stale.

`child_generation` is restored from the row, because the child's credential derives
from it; the incarnation is minted fresh by the `ReplSession` constructor, so a turn id
from before the restart is unmatchable against one after it. `channelPort` is restored
(which is also what resolves `session.ready`, awaited by every turn and otherwise
resolved only by a `/channel-ready` POST that went to a gateway that no longer exists),
and the spawn-time reuse properties come back from a new `reuse` field — without them
all three warm-reuse guards compare unequal and the first turn EVICTS the REPL that was
just adopted, which is a feature that works right up until something uses it.

**A verified-ours pane is adopted or CLOSED, never left.** That rule is what keeps the
2026-06-11 incident from returning in new clothes. Where the host could not speak for a
pane, the pid identity check decides (`adoptOrKillOrphan`, the module's older half);
where neither authority can establish ownership, nothing is closed and the row is
reported `undecided` — an unverified pane may be the owner's own work under a pane id
herdr reissued.

**The gate is the trigger.** `getOrSpawnSession` calls `beginBootAdoption` rather than
awaiting a pass somebody else remembered to start, so a new call path into the pool
cannot silently outrun reconciliation. The boot wiring also starts it before the
watchdog is armed (which is the ordering the issue asks for), and the watchdog tick and
the boot drain await it too. It is idempotent per key, and a no-op where there is no
registry or no handle — every test, every unsupervised substrate.

**The shutdown kill is narrowed, not removed** (`gateway-shutdown-survival.ts`). A child
may be left running ONLY when a persisted row names its exact pane AND its exact
generation. Anything else — the in-process host's children, ephemeral one-shots,
quarantined children, a pane no row names — is killed exactly as before. The survivor
also keeps its config files: `unlinkSessionConfigs` would delete the live child's
`--mcp-config` and `--settings` out from under it.

### The trap, and what actually holds the line

An adopted pane has no ring and no latches, so the first scan would see a stale
tool-approval prompt as an absent→present edge and answer it `1`+Enter — an action taken
on the owner's session, not a failed feature. The fix uses the edge semantics the
scanner already has: `OutputScanner.primeLatches` raises the latch for every signature
present on the adopted screen without firing any of them and without stamping the
debounce floor. Those signatures can then only fire after falling and rising again —
i.e. after the stale prompt goes away and a NEW one appears, which is output this
gateway can claim to have caused.

The first screen deliberately **falls through** to the scan instead of returning early.
The fall-through is provably inert (a scan fires only on a rising edge; everything
present in that screen was just latched; both read the same ring), and an early return
would have been a second guard masking which mechanism holds the line. With one
mechanism, the mutation that removes it reddens the test.

### Mutation table

Each row reverts one guard and names the file that goes red. **All 24 were re-run
against the FINAL head** (not against the state each was written at), applied and
reverted mechanically, with the tree verified clean afterwards: 24/24 reddened their
target.

| # | Mutation | Reddens |
|---|---|---|
| M1 | `primeLatches` call removed from the adopt path | `adopted-pane-latches.test.ts` (2) |
| M2 | `primeLatches` sets `latched = false` | `adopted-pane-latches.test.ts` (2) |
| M3 | shutdown verdict ignores a missing handle | `gateway-shutdown-survival.test.ts` (1) |
| M4 | shutdown verdict ignores a generation mismatch | `gateway-shutdown-survival.test.ts` (1) |
| M5 | adoption skips the `/health` probe | `boot-adoption.test.ts` (1) |
| M6 | classifier drops the dev-channel check | `pane-adoption-verdict.test.ts` + `boot-adoption.test.ts` (4) |
| M7 | adoption mints a fresh generation instead of restoring it | `boot-adoption.test.ts` (3) |
| M8 | adoption drops the reuse properties | `boot-adoption.test.ts` (1) |
| M9 | `getOrSpawnSession` does not await the gate | `adopted-repl-serves-a-turn.test.ts` (2) |
| M10 | `pane_handle` merged forward instead of re-stated | `pane-handle-persistence.test.ts` (2) |
| M11 | a survivor's config files are unlinked | `gateway-shutdown-survival.test.ts` (1) |
| M12 | a failed attach keeps its sink registration | `boot-adoption.test.ts` (1) |
| M13 | classifier refuses everything (**over-strict**) | 15 failures across three files |
| M14 | shutdown verdict never survives (**over-strict**) | `gateway-shutdown-survival.test.ts` (2) |
| M15 | the protocol gate removed from `inspectHandle` | `herdr-adoption.test.ts` (1) |
| M16 | the protocol gate removed from `closeHandle` | `herdr-adoption.test.ts` (1) |
| M17 | the PRE-attach stale-evidence check removed | `boot-adoption.test.ts` (1) |
| M18 | the POST-attach stale-evidence check removed | `boot-adoption.test.ts` (1) |
| M19 | `getOrSpawnSession` ignores the adoption verdict again | `adoption-refuses-a-second-owner.test.ts` (5) |
| M20 | the host switch returns `no-handle` instead of the pid fallback | `adoption-refuses…` + `boot-adoption` (3) |
| M21 | `undecided` permits a spawn | `adoption-refuses-a-second-owner.test.ts` (5) |
| M22 | an `undecided` pass is cached | `adoption-refuses-a-second-owner.test.ts` (1) |
| M23 | the pid fallback kills a healthy REPL after a host blip | `boot-adoption.test.ts` (1) |
| M24 | the host switch never terminates a verified survivor | `boot-adoption.test.ts` (1) |
| M25 | the refusal is not stamped with its error class | `classify-spawn-error.test.ts` (1) |

M13 and M14 are the direction a "safe" implementation fails in: a guard that refuses
everything passes every refusal case and delivers nothing.

### One correction this record has to carry, because I wrote the wrong sentence first

The evidence clock (`BOOT_ADOPTION_BUDGET_MS`) was first documented as "the bound on
the gate a turn can wait behind", and it is not: every caller awaits the pass to
completion, deliberately, because a gate that released early would let a cold
`--resume` start while the old child was still alive — the two-owner outcome this
module exists to prevent, and strictly worse than a slow first turn. The wait is
bounded only by the composition of the per-step deadlines (10 s per RPC, 5 s pid wait,
2 s health probe), and that is the accepted cost.

What the clock actually bounds is **the age of the evidence an adoption rests on**. An
adopt verdict is a conjunction of observations, and past this long they have stopped
describing now — so a pass that slow takes the act that needs no fresh evidence and
CLOSES the pane. Both of its branches (before the attach, and after it) are now driven
by tests, because until they were, the mechanism was unreachable in the suite: a first
attempt at the test called the pass directly, which supplies an unarmed clock and would
have passed whatever the code did. M17/M18 are the proof that it is reachable.

### The two findings a cross-model gate caught, and what they cost

Both were the same shape: the taxonomy was right and nothing read it.

**1 — an `undecided` verdict still permitted a cold spawn.** The pass refuses to claim
what it cannot establish, and `getOrSpawnSession` awaited it purely for the ORDERING and
threw the verdict away. So a pane we could not inspect, or one whose close we KNEW had
failed, was followed by a fresh `claude --resume` on the same transcript — two owners,
produced by the module built to prevent them. `adoptionPermitsSpawn` is now the single
place that decides, its switch is exhaustive so a new outcome kind cannot default into
permission, and a refusal fails the turn loudly and retryably rather than starting a
second process. An `undecided` pass is deliberately NOT cached, so the next turn
re-probes instead of inheriting one bad moment forever.

**2 — switching to a non-adoptable host left the pane alive and then spawned over it.**
The old branch logged the hazard accurately ("that pane may genuinely still be running
under a herdr server this process is not talking to") and returned `no-handle`, which
means "nothing survived, spawning is safe". The log was true and the verdict was not.
It now falls back to the process table — the one authority still available — and refuses
where that too is inconclusive. This matters more than it looks: #540 keeps the
in-process host selectable, so the first operator to flip that setting with live REPLs
was the person who would have hit it.

**And fixing them surfaced a hazard of the fix itself.** The pid fallback's first
version killed anything it verified as ours — which, on the `unavailable` path, means
killing a HEALTHY REPL because herdr failed to answer one socket call. A transport blip
says nothing about the REPL behind it, and destroying it is precisely the loss this
feature exists to prevent, at the moment the system is already unwell. Terminating is
now licensed only where the pane can never be adopted again (the host switch);
everywhere else the fallback is an IDENTITY probe with no side effect
(`identifyOrphanPid`, split out of `adoptOrKillOrphan` so the two share one matcher),
and a verified-alive survivor yields `undecided`: the pane stays, the turn refuses, the
next turn adopts it.

**A FOURTH, which the refusal itself created.** A turn error the producer does not
stamp arrives at the composer with no code, and `mapStatusForPoolCooldown(null, true)`
turns any unstamped RETRYABLE error into a 429-shaped pool cooldown — so the refusal
would have cooled the selected credential for a minute, and parked it for an hour after
five. A reconciliation problem laundered into "this credential is rate-limited": exactly
the class `classify-spawn-error.ts`'s own header warns about, committed by the change
that cites it. It is stamped `repl_unreconciled` now (a registered
`SubstrateErrorClass`, retryable), which the composer routes to `cooldownStatus = null`
along with every other non-credential class.

**The fix surfaced a third, smaller one.** Leaning on `adoptOrKillOrphan` for a SPAWN
decision exposed a false/unknown collapse in its own verdict set: `not-ours` was
returned both for "the kernel showed us a command line and it is somebody else's" and
for "the command line could not be read at all". Identical for the KILL decision it was
written for — neither licenses a SIGTERM — and opposite for this one, where the first
says our child is gone and the second says nothing. `unreadable` is now its own verdict;
the kill path treats it exactly as before.

### The protocol gate covers the adoption surface, not just the spawn

`inspectHandle` and `closeHandle` verify the server's protocol on the same handle they
then use. Every answer they read is read with "measured on protocol 20" semantics, and
these two decide whether a live `claude` is adopted, closed or left alone — the most
consequential reading this client does, and the one place (the close) where being wrong
destroys a process. The failure shapes differ deliberately: an unverifiable server makes
`inspectHandle` answer `unavailable` (decline and fall back to the process table, never
`gone`, which would license a cold spawn over a live REPL), while `closeHandle` rejects,
and the caller's rule for a rejected close is that nothing was closed — which is true.

### Measured against the live server, not read off a document

herdr 0.8.2, protocol 20, on this box, 2026-09-12:

- `pane.process_info` reports a pane's real foreground argv vector, and `pane.get`
  reports its `label` (added to the narrow wire types as nullable, and deliberately NOT
  gated on: identity comes from the argv).
- The deployed REPL children's own `/proc/<pid>/cmdline` carries `claude --resume <uuid>
  --dangerously-load-development-channels server:<channel> …` — argv[0] is `claude`
  (`/usr/bin/claude` is an ELF binary), so the matcher's exact-shape requirements hold
  in production.
- **The rehearsal that matters.** Process A spawned a REPL-shaped pane through the real
  `HerdrHost` and exited WITHOUT closing it; its child stayed alive. Process B, given
  only the pane id, ran `inspectHandle` → `classifyPaneForAdoption` → `attach`, received
  the screen process A had left, drove a line into the pane through `submitLine` and saw
  the child answer it, then `closeHandle`d it and got a typed `gone` back. The same live
  inspection classified as `leave-not-ours` against a different session id and
  `close-foreign-owner` against a different channel — all three verdicts exercised
  against the real server.
- One limitation the rehearsal surfaced: a fake `claude` that is a `#!/usr/bin/env bash`
  script reports argv[0] `bash`, which `argv0IsClaude` rejects. That is correct — the
  gate must require our exact launch shape — and it does not apply to production, where
  the binary is ELF. It is recorded because it will surprise the next person who writes
  a shell-script stand-in.

### herdr's own resume is off, and why the config is not the mechanism

`[session] resume_agents_on_restore = false` is set in this box's herdr config (backed
up first; `herdr config check` reports ok, `server reload-config` applied it with no
diagnostics). herdr's default is TRUE, and its restore is lazy and gated on an attached
client (it runs off client-view geometry changes —
`src/server/headless/client_views.rs`, `finish_shell_tab_geometry_change` /
`start_pending_agent_resumes`, in the 0.9.0 source tree), and it learns session ids only
from a hook `herdr integration install` would add, which is absent here.

But **configuration is not a mechanism**: a rule living in a file nobody re-reads is
advice. What makes the collision safe is the `close-foreign-owner` arm — a `claude` on
our transcript that is not our child gets closed before anything resumes that
transcript. The config makes it rare; the arm makes it safe.

### What now protects against the 2026-06-11 orphan incident

The kill that was removed for herdr-hosted children was the only thing ending them: a
pane is not in the gateway's cgroup, so `KillMode=control-group` never covered it. What
replaces it is auditable in three parts.

1. A child may survive ONLY if a persisted row names its pane and its generation, so
   the handle is never lost — it is written before the process is left alive.
2. The next boot VISITS that row and either re-adopts the pane or closes it. There is no
   branch that leaves a verified pane running, so a survivor is a handle we hold rather
   than a process we forgot.
3. Everything that cannot be re-found still dies at shutdown, unchanged.

**The residual, stated rather than hidden.** If the registry file is lost between a
shutdown and the next boot, the pane it named becomes unreferenced and nothing reaps it
automatically. It is still a labelled, visible pane rather than an invisible reparented
process, and the loss is bounded at one pane per session key per registry-loss event.
A sweep over `pane.list` that reports unclaimed `neutron-repl` panes is the obvious next
step and is deliberately NOT taken here: one herdr server can host several Neutron
instances, and a sweep that cannot tell another instance's pane from a leaked one must
not be allowed to close either. (Two such unclaimed panes from an earlier lane's live
tests were observed on this box while building, which is the residual in the flesh.)

### Refactors this required, and why each is a de-duplication rather than a new path

- `child-exit-wiring.ts` — the death teardown, lifted from `spawn.ts` verbatim. A child
  now arrives by two routes and must leave by one; two copies would drift, and the copy
  that lags is the one that leaks.
- `repl-detectors.ts` — the detector set, lifted verbatim. An adopted REPL with no
  detectors is worse than one never adopted: a live `claude` that sits forever behind
  the first prompt it renders while the gateway calls it healthy.
- `session-config-paths.ts` — the per-session config paths, derived from the channel
  name the row carries, so an adopted session can still unlink files that hold its
  credential in plaintext.

### Sequencing note

Built on `feat/538-herdr-host` (PR #641), which is still open; this PR targets that
branch. `#642` (merged as `3633ff62`) restructured `shutdownAllPersistentRepls` into
mark → kill → confirm → deliver phases on main. The survival gate here is a single
decision function with ONE call site inside the teardown, placed BEFORE any marking, so
the rebase onto that shape is a relocation rather than a rewrite: a child that is not
killed must not be recorded as killed.
