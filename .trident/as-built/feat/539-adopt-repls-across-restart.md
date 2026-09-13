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

### Round seven: a vector flattened, a decision unordered, and a scanner reading a name

**The argv was flattened and reparsed, which defeated the gate it fed.**
`classifyPaneForAdoption` joined the host's argv with `join(' ')` and handed the string
to `cmdlineMatchesSession`, which re-split it on whitespace. Flatten-then-reparse is
lossy and the loss landed exactly on rule (1). POSIX lets a process choose its own
argv[0], so `['claude --resume', '<uuid>', '--dangerously-load-…', 'server:<chan>']`
reparses with `tokens[0] === 'claude'` — passing a basename gate whose entire purpose is
to establish that argv[0] IS a claude binary — while the real argv[0] is
`'claude --resume'`, which is not a binary at all. Both things this classifier licenses,
attach and close, are destructive when pointed at a stranger's pane.

The structured vector was already in hand: the very next line read `inspection.argv[0]`
directly for its error message. `argvMatchesSession` now matches element-wise, and
`cmdlineMatchesSession` is a thin wrapper that tokenises for the one caller that
genuinely only has a string (the `ps` kill path), so that path's behaviour is unchanged.
An element carrying whitespace is refused outright and reaches `unverifiable` — not
`leave-not-ours`, which would be a positive claim about a process we cannot read — so a
vector we cannot trust routes to the pid identity probe and neither adopts nor closes.

**The shutdown decision was ordered against a concurrent writer by nothing.** The
survival gate read the row with `getRecord`, which takes no lock, and then acted on what
it read. The registry is shared across processes by design — that is why every writer
takes a flock — so: A writes (H1,G1), A snapshots (H1,G1), B writes (H2,G2), A leaves H1
alive because its snapshot said so. The only durable row then names H2 and nothing will
ever look for H1 again: the 2026-06-11 orphan in its herdr-shaped form. `withRegistryRead`
(new, in `repl-registry.ts`) takes the same flock every writer takes and does NOT save;
`claimShutdownSurvival` decides inside it. B's write now lands strictly before the
compare (we see H2 and kill) or strictly after it (B held the lock, so B is a writer that
read (H1,G1) and chose to replace it — and every such writer goes through the adoption
pass, which closes or adopts the pane it displaces first).

**This is the fourth instance of the branch's named habit, in its other form.** The first
three were a classifier's answer computed and dropped. This one is the same mistake one
step earlier: the answer was *correct* and the evidence under it was stale, because the
read that produced it was not ordered against anyone. `clearPaneHandleIfUnchanged` and
`claimRowOrUnwind` both already refuse to act on a row that has moved. The shutdown
boundary was simply never given the treatment, and it is the boundary where the cost is a
process nobody can reap rather than a refused spawn.

**What the lock does not buy, said plainly.** No lock binds a writer that arrives after
this process has exited. The residual in `gateway-shutdown-survival.ts`'s header — a LOST
registry strands the pane it named — is unchanged, and is still the price of the feature.

**The CodeQL alert is a false positive at the sink, and here is the path.** Alert #69,
`js/insecure-randomness`, high, against `boot-adoption.ts:1300`. `Math.random` appears in
no file this branch touches; the result is a dataflow, and the SARIF for analysis
1767833024 gives it in full:

    credential-pool.ts:244  Math.floor(Math.random() * available.length)   ← source
      → idx → available[idx] → candidate → pick   (the `'random'` load-balancing arm)
      → build-import-substrate.ts:300 / build-llm-call-substrate.ts:177  cred
      → cred.id → opts.credential_identity
      → adapters/claude-code/index.ts:471 → :549  poolKeyFor(p)
      → pool.ts:294-298  [instance, user, project, credential_identity].join(SEP)
      → boot-adoption.ts:1300  sessionKey                                  ← sink

The source picks WHICH already-provisioned credential serves a request; what propagates
is that credential's **id**, not its secret. The sink is the `sessionKey` parameter of
`startBootAdoption`, and it is a sink only because its name matches the query's
key-material heuristic. It is not a security context: the value is an in-process Map key
and a registry row key — never transmitted, never compared against attacker input, never
used as a key, nonce, salt or secret. Nothing in `boot-adoption.ts` derives anything
cryptographic from it; the reply-sink credential is `HMAC(root token, childGeneration)`
and `childGeneration` is `randomUUID()` (`spawn.ts:122`), a CSPRNG. Dismissed as a false
positive with that path named, rather than left to age out — a required security check
that fails once and passes later with nobody having read the path is the silent-success
shape this branch spent its rounds removing.

### Round eight: taking the lock introduced a way to fail, and the failure was permissive

Two findings, one defect in two places: the lock path can fail, and on failure the
survival decision did not fail closed.

**The read can THROW, and the throw went somewhere worse than nowhere.**
`withRegistryRead` was called bare. `openSync` on the lockfile raises on ENXIO, ELOOP, a
missing parent and EACCES, and `registry-lock.ts` throws outright when the path is not a
regular file. That exception lands in teardown's own `catch { /* ignore */ }`, which
skips `session.child.kill()`, the sink unregister and `unlinkSessionConfigs` — the child
left alive by an exception nobody ever sees. **This was a regression round seven
introduced**, not a pre-existing hazard: the `getRecord` path it replaced goes through
`loadRegistry`, which answers `{}` on every read failure and never throws, and took no
lock, so shutdown had no throwing site at all. Adding the lock added one.

**And the lock may not have been HELD, which is not the same as taking it.**
`withFlockSync` runs its callback unguarded in two states — FFI missing, and `flock`
returning nonzero — because for a generic helper running unguarded beats skipping the
operation, and both look exactly like success to a caller that does not ask. Its
`onOutcome` parameter exists for a caller whose correctness argument rests on the lock,
and this is that caller; `withRegistryRead` was discarding it. So on lock failure the
stale-row race was still live while the header claimed the flock ruled it out.

**Both are now `kill`, and the asymmetry is the argument rather than caution.** The child
is ours and we hold its handle, so killing it carries none of the recycled-identifier
risk this module family exists to guard: the cost is one respawn at the next boot. The
cost of a wrong `survive` is a process nothing will ever look for again, writing a second
stream into a transcript another owner holds. When one outcome is recoverable and the
other is not, the tie does not go to the permissive branch. `survive` now requires BOTH a
confirmed acquisition and a completed read.

**The reasons are three different sentences, because they are three different facts.**
"no persisted row names pane X" is a finding about the registry's content; "the registry
could NOT BE READ" is the absence of any finding; "the registry LOCK WAS NOT ACQUIRED" is
a finding about the instrument. Both new cases assert the text does NOT match the
row-mismatch sentence, so unknown cannot quietly reuse false's words.

**What the cases had to do that a unit assertion could not.** The throw case is also
driven through the real `shutdownAllPersistentRepls`, because the bug was that the
exception never reached a verdict — asserting the verdict alone would pass against the
broken code. And the lock case overrides the flock SYSCALL via `setFlockImplForTests`,
leaving the real `withFlockSync` and the real `withRegistryRead` in the path, on a row
that matches: without the override the identical call returns `survive`, which the
positive control runs. That is what separates "decided under the lock" from "decided",
and a mocked reader could not have shown it.

**A note on the positive control's second job.** It proves the survive branch is
REACHABLE in this environment. If FFI or `flock` were unavailable on the runner, every
fail-closed case above would pass for a reason having nothing to do with the code under
test — the vacuity the M41 lesson is about, arriving from the other side.

**Out of scope, and filed: #672.** The `ps`-derived string callers
(`boot-adoption.ts`, `orphan-adoption.ts`, `supervision.ts`) still flatten and reparse,
so requirement (a) in this module's header is stronger than `ps` can establish. The
docblock on `argvMatchesSession` already says the whitespace rule is vacuous for the
string form, so nothing written here overclaims — but the residual is real and belongs to
that issue, not this PR.

### Round nine: a pass in the gap, and a word in the criterion

**Shutdown could see a reconciliation pass in neither of the places it looks.** A pass
between `host.attach` and its publish is not a `pool` entry yet, so the drain cannot find
it, and nothing waited for it. It would publish into a pool already torn down — having
reinstalled `childByKey`, the sink and the watchers on the way — and `resetBootAdoption`
would meanwhile free its key, so a later boot in this process could start a SECOND pass
against the same unchanged row and attach the same pane. Two owners of one transcript,
produced by the reset whose job was to make the next boot safe.

The shutdown now waits for the in-flight passes, bounded at
`SHUTDOWN_ADOPTION_GRACE_MS`. A pass that settles inside the grace publishes and gets a
real `claimShutdownSurvival` decision — better than being invisible to it. One that does
not is marked abandoned, and `AbandonSignal` carries the CAUSE rather than a second flag
being invented: `evidence-bound` still closes the pane, `shutdown` leaves it exactly as
it is, because the row names it and the next boot reconciles it. Closing there would
destroy the REPL the feature exists to preserve, at the one moment nobody is watching.
The abandonment is checked at the attach AND at the publish: the attach window is the one
a second pass can race, and a publish-only check leaves it open. `resetBootAdoption` now
keeps in-flight entries and drops only settled ones — the retained entry is already
abandoned, so it resolves `undecided`, refuses the spawn, and frees its own key when it
ends.

**The placement the ruling asked for reordered something else, and it is reported rather
than worked around.** Awaiting BEFORE the pool partition broke three #518 cases. The
cause is not the await's contents: a bare `await Promise.resolve()` in that position
reproduces it exactly, measured. Draining `pool` is the only part of
`shutdownAllPersistentRepls` that is synchronous with its caller, and any yield in front
of it lets a queued child-exit handler run first and empty the entry the walk was about
to report. So the drain was factored into a function and called TWICE: the first keeps
its synchronous position, the passes are awaited after it, and the second drain takes
exactly the sessions those passes published. The property the await exists for is
unchanged — a pass that settles inside the grace still lands in `pool` and still gets a
real survival decision — and the coordinator was told what moved and why.

**And the word "every" in the criterion.** The owner's verbatim criterion says *every
project REPL*; production starts a pass only for the key whose substrate has been
constructed. The mechanism is right and the text was not. One registry holds a row per
pool key; a pool key folds instance, user, PROJECT and credential; a pass runs with the
options of the substrate that started it. Reconciling another row under those options
would put a REPL in the pool scoped to the wrong project, with every tool call attributed
there and its child authorised on a credential belonging to another key — so enumeration
with the wrong options is a WORSE defect than deferral, and worse in the direction this
item exists to protect. The spec item now states the per-key design, restates the
criterion as *every project REPL whose substrate this gateway constructs is reconciled
before that substrate's first turn, and no row is ever reconciled under another row's
options*, and names the residual plainly: a row whose substrate this process never
constructs keeps its pane, keeps its row, and is reconciled by the next construction. A
new Decisions Log entry records the narrowing; the 2026-09-12 entry is untouched and the
owner's quote is unchanged.

**The boundary is now enforced instead of described.** It had lived only in a source
comment. Two cases put two rows from different projects in one registry and assert the
pass inspects one pane, attaches one pane, authorises one session id, and leaves the
other row byte-intact.

**M48 did not red on its first run, and the FIXTURE was at fault — the second time this
branch has been caught by that shape.** The mutation makes the pass reconcile whichever
row it finds first; with A's row written first, "whichever it finds" IS A, so the
mutation was a no-op and the cases passed against broken code. The fixture now writes
B's row first, which makes the wrong answer wrong by construction, and M48 reds. This is
the M41 lesson one level up: a mutation has to be able to change the observed behaviour
of the fixture the case actually runs.

### Round ten: a residual that named its own gap as coverage, and a handshake instead of a sleep

**The sentence written to be honest about the residual was the sentence hiding it.** The
spec item said an unreconciled row's pane was "not lost and not leaked … the pre-existing
`#105` orphan path in the watchdog still covers it if it turns out to be wedged." It does
not, and it cannot: on `respawn-and-alert` that path resolves the OWNING substrate's
options by pool key, and a key with no registered options is pushed as
**`unregistered-skip`** and skipped (`supervision.ts`, the `keyOptions === undefined`
branch) — deliberately, so it is not actuated under the tick's own identity.
`keyOptions === undefined` is *exactly* the condition of the row being described. So the
residual paragraph claimed as coverage the one path that declines to cover, and it hid
the gap behind the same premise the narrowing rests on. Both documents now say the same
true thing and name the skip so the claim is checkable against code rather than memory:
such a pane keeps running, keeps its row, and **is not reconciled and not reaped by
anything** until its substrate is next constructed. SPEC.md §2.3's unqualified "the next
gateway re-adopts it" is qualified in the same terms.

**The race cases guessed that they were inside the window.** Every one did
`await Bun.sleep(20)` and then assumed the pass had reached `holdInspect`/`holdAttach`;
the fake handed back only a release callback, so nothing established the boundary. The
holds now return `{ entered, release }`, `entered` resolves at the top of the held method,
and every case awaits it. The sleeps are deleted, not shortened. The two that remain are
the evidence-bound cases, where a sleep IS the subject (a bound elapsing) rather than a
guess about position, and the handshake now precedes them so the wait is spent inside the
attach.

**The mutation the gate asked for does not red, and the reason is worth more than the
mutation.** Resolving `entered` at construction time — turning the handshake back into a
sleep — leaves every case passing, because the ordering these cases rely on is guaranteed
by two OTHER mechanisms: the hold is installed before the pass starts, so the pass cannot
proceed past that boundary whatever the timing; and for the shutdown cases
`settleBootAdoptionsForShutdown` awaits the in-flight pass, which gives it time to reach
the attach regardless. The sleep was never load-bearing — which means it was never doing
the job it appeared to do either. The handshake is still the right instrument (it states
the boundary instead of estimating it, and it removes a dependency on an accidental
property of the grace), but it is recorded here as a clarity fix rather than as a fix with
a red-turning mutation behind it, because claiming the latter would be the same
overstatement this round is about.

**What DID make the claim checkable was a different defect, found while looking.** All
three shutdown-abandonment sites returned *identical* reason text. Identical text means no
test can tell which branch ran, so a case named for the attach-side check passes when the
pre-attach check fired — the false/unknown collapse this tree keeps paying for, in a
string. The reason now carries the point it was taken at (`before the attach` / `with the
attach in flight` / `at the row claim`), the case asserts the specific one, and **M46
(grace forced to zero) now reds through that assertion** rather than through a count.

**And the invariant that was only in a PR conversation is now in the code.** The first
`drainPool()` call cannot be preceded by any `await`; a bare `await Promise.resolve()`
breaks it, and the comment names the three `poison-eviction-live-work-guard.test.ts` cases
that go red when it is. An invariant discovered by measurement and recorded only in review
is an invariant that gets re-broken by the next person who sees two drains of one map and
simplifies them into one.

### Round eleven: the same false claim in three places, and only one of them was fixed

The correction in round ten was right and it was applied to one of the three places the
claim lived. The other two — the *"What happens to a row nothing constructs"* bullet in
this branch's own new SPEC.md log entry, and the `passes` docblock in `boot-adoption.ts`
— still said the watchdog's `#105` orphan path covered a pane whose substrate this
process never constructed. Both false for exactly the reason established in the code:
`supervisedBySessionKey` is populated by a substrate's own `registerSupervisedSubstrate`
call, and on `respawn-and-alert` a key with no entry answers `unregistered-skip` and is
skipped. "No registered options" and "this process never constructed that substrate" are
the same condition, so the watchdog declines precisely the rows those sentences were
about.

**This is the branch's named habit appearing at the moment of correcting it** — a rule
reasoned about carefully for one instance and inherited unexamined by its neighbours. The
lesson is procedural and is written down because it generalises: **when you fix a claim,
grep the claim rather than re-reading the file you were looking at.** `grep -rn 'still
covers'` finds all three in one command, and a second grep for a string known to be
present proves the search itself works before its emptiness is trusted.

**The SPEC.md entry was edited in place rather than superseded, on the coordinator's
ruling, and the reasoning is worth keeping.** The log's immutability protects entries
that are already history: once a decision is on `main` a later reader may have acted on
it, and rewriting it erases what they read. That entry is not on `main` — it is an
unmerged line in this diff — and shipping a false sentence plus a third entry correcting
it in the same merge serves nobody. Everything already on `main` stayed untouched, as it
has all branch.

**And the #546 finding in that round's gate was a stale-base artifact, correctly
overruled.** #673 merged while round ten was in flight, so a review of this diff against
current `main` presented #673's work — ticking #546's acceptance list, promoting its
as-built, closing the item — as this branch's deletions. Both diffs were honest and their
union was not. The fix was the rebase; performing the gate's suggested action (restoring
the completed spec item) would have reverted a merged lane's work. Recorded because the
shape recurs: **a per-diff review cannot see a merge that landed under it**, and the
remedy is always to move the base, never to re-apply what the base already has.

### Round twelve: a rule I argued for, an enumeration that was wrong, and a test that proved two things at once

**The blanket whitespace refusal broke a legitimate spaced path, permanently.** Round
seven added it and justified it with an enumeration of what `buildReplArgv` emits — "a
binary path, bare flags, a uuid and `server:<channel>`". The enumeration was wrong.
`build-repl-argv.ts` also pushes `--mcp-config`, `--settings`,
`--append-system-prompt-file` and `--add-dir`, each carrying a caller-supplied filesystem
PATH, and `spawn.ts` supplies the project `cwd` as `--add-dir` while the binary itself
comes from `options.claude_bin` / `CLAUDE_BIN`. A self-hoster with a project at
`/srv/My Project`, or claude installed under a spaced path, produces a perfectly ordinary
argv containing a space — and the gate then answered `unverifiable` about its own live,
correct child. Not once: **every boot**, because nothing about the situation ever changes.
That is a list claiming a completeness it did not have, which is already on this branch's
list of named shapes; it got in anyway, and it got past a reviewer who found the argument
convincing.

**It was also unnecessary, which is why it is removed rather than narrowed.** The attack
it was added for is a flattened argv whose `tokens[0]` reads as `claude` while the real
`argv[0]` is `'claude --resume'`. `basenameOf` splits on `/` and nothing else, so
`basenameOf('claude --resume')` is `'claude --resume'` — not `'claude'` — while
`basenameOf('/opt/my dir/claude')` is `'claude'`. The basename separates the smuggled case
from the legitimate one; the space never did. The whitespace rule was the STRING form's
constraint promoted to a place it does not belong.

**The acceptance case asks the real builder.** A hand-written array would encode the same
wrong mental model of what the builder emits — which is exactly how the rule got in — so
the case calls `buildReplArgv` with a spaced `claudeBin`, a spaced `--add-dir` and spaced
config paths, asserts the premise (`argv.some(el => /\s/.test(el))`) and then asserts the
match.

**And the original smuggling case was proving two things at once.** Its vector fails
`argv0IsClaude` AND the `--resume` adjacency — the flag was fused into argv[0], so it is
not an element either — which meant a mutation to either rule left the case green, and
the first attempt at the `argv0IsClaude` mutation duly did not red. A second vector was
added that satisfies **every other rule** (real adjacent `--resume <uuid>`, real channel
flag and value, asserted as premises) so that only the basename stands between it and an
`adopt`. Both mutations now red: restoring the blanket refusal reds the spaced-path case,
and taking argv[0]'s first whitespace-delimited word reds the isolating one. Together they
are the claim — legitimate whitespace is fine, smuggled whitespace is not, and the
basename is what tells them apart.

**The handshake, in the file the last round did not touch.** `adopted-repl-serves-a-turn.ts`
still had `hold()` returning a bare release and a 150ms sleep standing in for "the
adoption is blocked inside `attach`". It now has the same `{ entered, release }` shape and
no sleep. Found by grepping the PATTERN rather than re-reading the file that was handed
over — the same procedural lesson round eleven recorded for the "still covers" claim,
applied one round later to a different pattern. A grep across the suites now shows every
hold seam returning a handshake.

### Mutation table

Each row reverts one guard and names the file that goes red. Every mutation is applied
and reverted mechanically, with the tree verified clean afterwards.

**The count is the table's own length, and it did not use to be.** An earlier revision
of this paragraph said "All 24" twice while the table already listed 25 — a number
written once and then never re-derived, in the one section whose whole purpose is
auditability. The last full harness run covered **every live row in one pass — M1–M36 less the
superseded M31: 35/35 reddened their target** — with the worktree verified clean
afterwards. M37–M41 were added in round seven, M42–M44 in round eight, M45–M48 in round nine, M49 in round ten and M50–M51 in round twelve, each verified
individually as it was written and listed with the count it reddens. M44 was checked for
vacuity rather than assumed: the fixture row MATCHES, so the survive branch it forces is
genuinely reachable — a fixture whose row already mismatched would have made the mutation
unobservable and the case worthless, which is the M41 shape one level up.

**M41 did not red on its first writing, and the test was the thing at fault.** The
no-write case compared the registry file's bytes before and after — against a fixture
that was already pretty-printed, which is exactly what `saveRegistry` emits. A stray save
reproduced it byte-for-byte and the case passed. The fixture is now written COMPACTLY, so
the formatting is the witness, and the mutation reds. A byte comparison is only as strong
as the bytes being distinguishable.

**M31 stopped applying, and the harness said so rather than passing.** The write it
mutated was replaced by `claimRowOrUnwind`, so its patch matched nothing — reported as
`PATCH DID NOT APPLY` and counted against the run, which is the behaviour a mutation
harness needs: a patch that silently no-ops is a row that claims coverage it is not
providing. M35 and M36 are its successors and both redden.

**M33 was NOT CAUGHT on its first full run, and that is worth recording.** The close
path's moved-row window had no case at all: every existing row-moved case drove the
`gone` branch, so the guard on the CLOSE branch was untested while looking covered by
neighbours. It took a new seam in the fake — a hook that runs inside `closeHandle`, so
the world can move at the one moment the pass is committed to an act and has not yet
written its conclusion — and the case now reddens both M33 and M34. A harness that
reports a mutation as uncaught is doing its job; the value is in running it after every
change rather than once. Re-derive the
count from the rows below rather than trusting this sentence.

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
| M26 | the adopt path never releases the child's output gate | `adopted-repl-serves-a-turn.test.ts` (2) |
| M27 | the adopt path attaches a DIFFERENT pane | `adopted-repl-serves-a-turn.test.ts` (2) |
| M28 | a dead recorded pid alone clears the handle | `boot-adoption.test.ts` (2) |
| M29 | no identity re-check immediately before the close | `boot-adoption.test.ts` (2) |
| M30 | the handle clear does not compare the row it decided about | `boot-adoption.test.ts` (1) |
| M31 | ~~the adopted-pid write does not compare it either~~ — **superseded by M35/M36**: that write now lives inside the row claim, so this patch no longer applies to any code | superseded |
| M32 | the `row-moved` verdict is computed and discarded | `adoption-refuses…` (1) |
| M33 | the close path ignores a moved row | `boot-adoption.test.ts` (1) |
| M34 | the close path never REPORTS a moved row | `boot-adoption.test.ts` (1) |
| M35 | a failed row claim publishes the adoption anyway | `boot-adoption.test.ts` (1) |
| M36 | the row claim does not compare handle and generation | `boot-adoption.test.ts` (1) |
| M37 | the classifier flattens the argv and reparses it again | `pane-adoption-verdict.test.ts` (2) |
| M38 | the whitespace refusal is removed from the matcher | `pane-adoption-verdict.test.ts` (1) |
| M39 | the argv matcher refuses every vector (**over-strict**) | `pane-adoption-verdict.test.ts` (7) |
| M40 | the survival decision reads an UNLOCKED snapshot again | `gateway-shutdown-survival.test.ts` (2) |
| M41 | `withRegistryRead` writes the registry back | `gateway-shutdown-survival.test.ts` (1) |
| M42 | the registry read is called bare again, with no catch | `gateway-shutdown-survival.test.ts` (2) |
| M43 | the lock outcome is never asked for (`acquired` forced true) | `gateway-shutdown-survival.test.ts` (1) |
| M44 | both failure branches return `survive` (**over-permissive**) | `gateway-shutdown-survival.test.ts` (3) |
| M45 | the attach-side shutdown check is dropped (publish-only) | `boot-adoption.test.ts` (2) |
| M46 | the shutdown grace is zero, so the await never waits | `boot-adoption.test.ts` (1) |
| M47 | `resetBootAdoption` clears in-flight passes again | `boot-adoption.test.ts` (1) |
| M48 | the pass reconciles whichever row it finds first | `boot-adoption.test.ts` (1) |
| M49 | `entered` resolves at construction, not in the held method | **did NOT red — see round ten; the ordering is guaranteed elsewhere and this is recorded rather than claimed** |
| M50 | the blanket whitespace refusal is restored | `pane-adoption-verdict.test.ts` (2) |
| M51 | `argv0IsClaude` compares argv[0]'s first whitespace-delimited word | `pane-adoption-verdict.test.ts` (1) |

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

### Round three: three findings from the gate, and the fixture that could not fail

**The acceptance test could not prove the thing it was named for.** Its dev-channel was
an independent server that answered `/message` by POSTing a reply to the sink on its own
authority, and the attached child's `write`/`writeKey` were no-ops — so "the same REPL
served the turn" was a sentence produced by a mock with NO link to the child the
adoption attached. Breaking the attach→turn connection entirely left the test green;
only the spawn counter tied them together. That is the shape this tree keeps paying for:
asserting an outcome the broken fixture also produces, here on the headline criterion.

The surviving child is now ONE object. Its bridge answers nothing until a gateway has
attached to the pane and released the output gate — the wiring the adoption path
performs — and every reply names the pane it was taken over through and the pid it runs
as. M26 (never release the gate) and M27 (attach a different pane) both redden it; under
the old fixture neither would have.

**A dead recorded pid is not proof the pane is empty.** `dead` and `not-ours` used to
clear the handle and permit a resume, on the argument that the pid and the handle are
written by one spawn and go stale together. Sound for a pane nothing else touched, and
wrong for the case this item's own spec item raises: a pane relaunched under a NEW pid
(herdr's native restore does exactly that) leaves the recorded pid genuinely dead while
a live process owns the transcript. The `resume_agents_on_restore = false` set on this
box closes the common route in practice — but **a guard that depends on a setting in
another program's file is not a guard**. The question is now asked of the TRANSCRIPT
rather than of one remembered pid: `scanTranscriptOwners` filters every live process
through the same exact-shape matcher, and only a scan that RAN and found nobody is a
positive absence. What the instrument can see was measured, not assumed: `ps -eo
pid=,command=` piped emits the live REPLs' 603-character argv whole (longest line in a
full listing: 1,368), so a `--resume <uuid>` cannot fall off the end unseen.

**A destructive time-of-check/time-of-use gap.** Between the inspection that decided and
the `closeHandle` that acted there was a `/health` round trip at minimum, and up to the
45-second evidence bound — a window in which the pane can exit and its id be reissued,
so a close could destroy a stranger's pane against this module's own rule. Identity is
re-established immediately before the close, and only a pane that is still a claude on
this row's transcript may be closed; a changed identity is `undecided` and a pane that
vanished in the window is treated as closed, because that post-condition already holds.
A check is not a lock and the record does not claim one: what is removed is the wide,
predictable window, not the instant between the reply and the call. The fake host grew a
scripted inspection queue for this — a fixture that cannot change cannot test that two
reads agree.

### Round four: the lock was atomic with respect to the row, not to the decision

`clearPaneHandle` re-read the row inside `withRegistry` — correctly — and then stripped
`pane_handle` from whatever row now occupied that key:

1. gateway A reads `(H1, G1)` and starts inspecting `H1`;
2. gateway B completes a spawn and writes `(H2, G2)`;
3. A's inspection answers `gone`, which is true of `H1` and irrelevant to `H2`;
4. A strips `H2`.

B's live child is then unfindable — no durable handle, so the next boot cannot adopt it
and the shutdown gate kills it. **The continuity this item exists to provide, destroyed
by its own cleanup path**, and silently, because clearing a handle looks like tidying
up. The lock made the write atomic with respect to the ROW; the DECISION came from a
snapshot taken before a chain of awaits, and nothing compared the two.

Every write this pass makes is now a COMPARE-AND-SET on the pair it decided about — the
handle AND the generation, because a respawn can reuse a pane id the server reissued and
a handle alone cannot tell those apart. A row that moved is left exactly as it is and
said out loud. That covers the four exposures: the `gone` clear, the post-close clear,
the pid-fallback clear, and the adopted-pid update.

The race is CONSTRUCTED in the test rather than argued: the fixture's `inspectHandle`
is held open, the row is replaced inside that window, and the assertion is that the
newer row is intact — handle, generation and pid. Without the hold there is no window
and the case proves nothing, which is the third time on this branch that a fixture
unable to produce the input under test would have made a guard look tested.

### The habit this branch has, named because it happened twice

**A classifier's answer computed and then ignored — and both times the ignored value
was the one added LAST, after the call sites had already been written to call a `void`
function.**

1. `beginBootAdoption`'s outcome. The pass distinguished "the other owner is gone" from
   "I could not establish that", and `getOrSpawnSession` awaited it for its ORDERING and
   dropped the verdict — so `undecided` was followed by a cold `--resume`.
2. The compare-and-clear's `row-moved`. It correctly refused to strip a row another
   incarnation had replaced, and every call site then returned `handle-cleared` /
   `closed-by-pid` regardless — verdicts that LICENSE A SPAWN on a transcript whose live
   owner had just been written into that row. **The data corruption was fixed and the
   two-owner outcome it existed to prevent was not**, which is the more expensive half
   to lose because the fix looks like it worked.

The second one also had a test that asserted the row was preserved and *expected* the
unsafe verdict — so the case pinned the half that already worked.

3. **The pid write's own `wrote` boolean, in the round that named the habit.** It
   compared the row correctly and reached a LOG: an adoption whose row had been
   replaced mid-attach left its child live in the pool and answered `adopted` while the
   durable row named another incarnation's child. Two live owners on one transcript —
   the invariant the item exists to hold — produced by the fix for instance 2, in the
   same file, while the paragraph above it was being written.

   **And the argument for leaving it did not survive contact with the branch's own
   code.** I had disclosed it as out of scope because two gateways sharing an instance
   home is outside the design — but the compare-and-clear six hundred lines up exists
   *because* they can race on this registry, and `repl-registry.ts` designs its
   mutations for cross-process concurrency by construction. The same race cannot be a
   blocker in one place and out of scope in the other. A disclosure is not a decision.

What changed is the shape, not the vigilance, and it had to change twice.
`clearHandleThenVerdict` returns the CALLER'S VERDICT rather than a status, so a caller
that fails to use it fails to return anything and the typecheck refuses it.
`claimRowOrUnwind` goes further because its failure branch has WORK to do as well as a
verdict to report: it owns both outcomes — the publish and the unwind are passed in, so
there is no path where the answer is computed and ignored AND no path where the failure
branch forgets to give the child back. Where a status is genuinely needed (`CloseOutcome`)
it grew a `row-moved` member that the one mapping function must handle. A `void`
function with an interesting return value is an invitation, and this module had two.

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
