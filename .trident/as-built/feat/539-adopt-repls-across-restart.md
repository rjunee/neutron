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
options* — **and says outright that the restatement is NOT equivalent to the owner's
sentence** (round twenty-two: narrower as a claim about boot-time mechanism, equivalent
as a claim about what the owner experiences, with the window between restart and first use
as the observable difference) — and names the residual plainly: a row whose substrate this process never
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

### Round thirteen: two causes, one signal, and the wrong one winning

**Neither cause was wrong; their interaction was.** `abandonInFlightPasses` skipped a
pass that was already abandoned. So when the evidence timer fired first and the gateway
shut down second, the cause stayed `evidence-bound` — and when the held attach finally
returned, the pass took `unwind` and **closed the pane**, in the middle of a shutdown
whose contract three hundred lines above says an unfinished pass is left alone. Two
guards, each correct alone, composing into the one outcome both exist to prevent.

**The ruling and its reasoning, kept with the code.** `unwind` closes because the child is
verified as ours on our transcript, so leaving it is how a COLD SPAWN becomes a second
owner. That argument does not hold during a shutdown: no cold spawn is coming, this
process is going away, the row still names the pane, and the next boot visits that row and
adopts-or-closes it on FRESH evidence. Leaving the pane is recoverable at the next boot;
closing it destroys the conversation the whole feature exists to keep. The same asymmetry
as the survival decision, arrived at from the other side. So `shutdown` outranks
`evidence-bound`, and the upgrade is **one-way**: `abandonInFlightPasses` upgrades rather
than skipping, and the timer's early return refuses to downgrade.

**Both halves are now asserted rather than left to ordering.** The reverse direction was
already safe by accident of where the early return sat; it is load-bearing now, so there
is a case for it (shutdown first, timer second) and M53 reds when the return is removed.
Without that case the one-way property would have been half-tested, which is what the gate
asked me to check rather than assume.

**The signal records both facts, because they are two findings.** `boundExpired` is set
unconditionally by the timer and is independent of the operative `cause`, and the reason
text says which one decided: *"the evidence bound expired AND the gateway then shut down …
the SHUTDOWN is the operative cause"*. A reader looking at a pane that outlived its
evidence window and was left alive anyway needs the ordering to understand it.

**And the early return got an observable.** It used to `return` silently, which made the
shutdown-first case impossible to write without a sleep — the test hung on a log line that
branch never emitted. It now logs that the bound expired against an already-abandoned
pass and that the bound does not take the disposition back. That is genuine diagnostic
value, and it is also the only handle the case has: **a branch with no observable cannot
be tested except by guessing, which is the same defect as the sleeps, one level down.**

**The control matters here more than usual.** Both ordering cases assert the pane survives,
and a bound that had simply stopped working would satisfy both. A third case runs the
evidence timeout with no shutdown at all and requires `closed-unadoptable` with the pane
closed, so the bound is still proved to do its job.

### Round fourteen: the claim rested on a lock it never confirmed

**Round eight's finding, standing untouched in the other half of the module.**
`claimRowOrUnwind` does its cross-process compare-and-set through `withRegistry` and
publishes when it returns true. `withRegistry` passed no `onOutcome` to `withFlockSync`,
and `withFlockSync` deliberately runs its callback unguarded when FFI is missing or
`flock` returns nonzero — both indistinguishable from success to a caller that does not
ask. **A compare-and-set is only a compare-and-set while the lock holds.** Unguarded, two
incarnations read the same row, both find it matching, and both publish an attached owner:
two owners of one live transcript, the single outcome this module exists to prevent.

This is the **fifth instance of the branch's named habit** and the one with the worst
consequence. The shutdown decision was given this treatment in round eight; the claim is
its neighbour and inherited nothing. The pattern is not "a value computed and dropped"
this time but its parent: **a property established for one caller and not carried to the
caller beside it.** `withRegistryRead` grew an `onOutcome` passthrough in round eight and
`withRegistry` — the same file, twenty lines down — did not.

**What each site does with a lock it did not get.** The claim **releases**: it gives back
the pool entry, the child mirror, the sink registration and the watchers, and leaves the
pane and the row exactly as they are. It does not close, and the reason is not timidity —
`undecided` already maps to `{ ok: false }` in the spawn gate, so no cold spawn follows
and no second owner can arise from the refusal, while closing would destroy a live REPL
another incarnation may have legitimately claimed. We verified the child is ours; we did
not establish that we are still its rightful owner, and **an unestablished claim licenses
neither act**. The reason text names the lock and is deliberately distinct from the
row-moved one: "someone else owns this row" is a finding, "I could not find out who owns
it" is the absence of one.

The clear **refuses**. Without the lock the compare-and-clear is not atomic, and the row
it would erase may be one another incarnation has just written for a LIVE pane — which
strands it, and that is the unrecoverable direction. A stale row pointing at a pane we did
close is the recoverable one: the next boot probes the handle, gets a positive absence,
and clears it then. The coordinator asked to be told if refusing left something worse; it
does not, and the reason it does not is that the close's own outcome is unaffected — the
pane really is closed, which is what licenses a resume.

**And the mapping that would have swallowed the new answer was a ternary.**
`clearPaneHandleIfUnchanged(...) === 'row-moved' ? {row-moved} : {closed}` lumped every
other outcome — including a refused write — into "closed and tidy". It is now an
exhaustive `switch` in `closeOutcomeOfClear`, so a future `ClearOutcome` fails the
typecheck rather than defaulting into permission. That is the type-level remedy this
branch keeps reaching for, applied one function further out.

**And round twenty-three showed the limit of that remedy, so this note does not stand
alone.** The exhaustive switch did its job — when `lock-unacquired` was added it could not
be silently defaulted, and the compiler made me name it. It could not make me name it
*correctly*: I put it in the same `case` list as `cleared` and `absent`, and the reasoning
that is sound for a read that happened was inherited by a refusal that says the opposite.
**An exhaustive switch guarantees every case is considered, never that each was answered
right — and a `case` list is exactly where two different facts get the same answer while
looking fully enumerated.**

**Every case forces the REAL failure.** `setFlockImplForTests(() => 1)` fakes the flock
syscall and nothing else: `withFlockSync`, `withRegistry` and
`clearPaneHandleIfUnchanged` are all the real ones, so the cases distinguish "claimed
under the lock" from "claimed". Two controls, each with a stated second job — the adoption
control proves the claim path is reachable on this runner (so the refusals cannot be
passing because FFI is unavailable), and the clear control proves the clear still happens
when the lock is granted (so the refusal case cannot be passing because the clear stopped
working). The clear fixture's row deliberately MATCHES, so the refusal is the only thing
that can stop the write — checked rather than assumed, because a non-matching fixture
would make the mutation unobservable, which is the M41/M48/M51 shape this branch has now
hit three times.

### Round fifteen: the habit inside the fix for the habit, and the audit that should have caught it

**The claim wrote the row on an unacquired lock, then logged that it had left it alone.**
The pid repair sat inside the mutate callback and `withRegistry` saves whatever that
callback returns, so the `!acquired` check — placed *after* the call — was a check placed
after the write. The clear, forty lines down, already did this correctly: it tests
`acquired` INSIDE the callback and returns without mutating, which works because
`onOutcome` fires before `fn`. **The claim beside it inherited nothing** — which is the
sentence round fourteen wrote about `withRegistryRead` and `withRegistry`, now true of the
fix for that. The callback's result is also no longer a boolean: `ClaimResult` is
`'ours' | 'row-moved' | 'lock-unacquired'`, so the refusal cannot be confused with a
comparison failure and the outer branch reads a fact rather than reconstructing one.

**And the test could not have seen it**, because the fixture's row pid already matched the
pane's, so the repair branch was unreachable. Fourth time this branch has been bitten by a
fixture that cannot reach the code the mutation changes, and the first time it hid a real
write rather than an absent assertion. The case now uses a stale pid (`pid: 1`), asserts
that premise before acting, and compares the row field-for-field afterwards — with a
lock-granted control proving the repair still happens, so the refusal cannot be passing
because the repair stopped working.

**The exception branch closed a pane whose ownership was equally unestablished.** A thrown
lockfile open, a read error, an EACCES: none of them say the pane is ours to end, and all
of them called `unwind`, which closes. It now releases, with a third reason — "the registry
could NOT BE READ OR WRITTEN" — distinct from both "someone else owns this row" and "I
could not get the lock", and the case asserts it matches none of the other two. The case
makes the throw happen the way production would (the lock path is a directory) rather than
by injecting one.

### The guard-coverage audit, because finding the sibling one round late does not scale

Five consecutive rounds found the same shape: a property established at one site and not
carried to its neighbour. The instrument that generalises is not more care; it is a list.
For each guard this branch adds, every call site of the thing it guards, and why each one
is or is not covered. **Checkable by someone who did not write it**, which is the point.

| Guard | Call sites of what it guards | Covered? — with the test, or the issue |
|---|---|---|
| **Lock outcome consumed** (`onOutcome`) | `withFlockSync`'s three production callers: `sink-coordinates.ts:755`, `repl-registry.ts:712` (`withRegistryRead`), `repl-registry.ts:758` (`withRegistry`). | **All three.** `sink-coordinates` consumed it before this branch — the precedent I should have followed. Both registry helpers forward it. Tests: `gateway-shutdown-survival.test.ts` "a REAL flock that does not grant the lock is a kill…", `boot-adoption.test.ts` "REFUSES to publish when the lock was not acquired…". |
| — its registry consumers | `withRegistryRead`: `claimShutdownSurvival`. `withRegistry`: the row claim (`boot-adoption.ts:1064`), the handle clear (`:1224`), `spawn.ts:600` + `:1180`, `repl-registry.ts:777/795/808`, `supervision.ts:239`. | **The three whose correctness rests on atomicity**, each with a named case above plus "REFUSES to clear the handle on a non-atomic write…". `spawn.ts` and the `repl-registry` helpers are merges and unsets with last-writer-wins semantics that predate this branch and never compare-then-write. **`supervision.ts:239` is different and I did check rather than assume:** it reads `respawn_in_flight_at`, tests the TTL, and writes the stamp under the same flock, returning `go` only when it claimed — a genuine CAS, and its own comment states the requirement ("two rapid force requests … can't both spawn the same sessionKey — exactly ONE spawn"). It does **not** consume `onOutcome`, so it has the same exposure this branch just fixed twice. Pre-existing on `main`, deliberately not widened into here, and **filed as #675** — unlike #674 it does not fail in the conservative direction. |
| **Row CAS on (handle, generation)** | Every site where this branch writes or erases a row it decided about: the claim, the clear. | **Both.** Tests: "an adoption whose row is replaced mid-attach GIVES THE CHILD BACK", "a CLOSE whose row moves before the write reports undecided, not a close", each with an uncontended positive control. |
| **Abandonment cause** (`signal`) | The three points past which a pass must not act: pre-attach, post-attach, publish. | **All three**, each with its own reason string so a case cannot claim one and exercise another. Tests: "a pass still attaching when shutdown lands publishes NOTHING…", "TIMER FIRST, THEN SHUTDOWN…", "SHUTDOWN FIRST, THEN TIMER…", control "with no shutdown at all, the bound still CLOSES". |
| **Element-wise argv match** | `argvMatchesSession`: `classifyPaneForAdoption` (host vector), `cmdlineMatchesSession` (string form). `cmdlineMatchesSession`: `boot-adoption.ts:721`, `orphan-adoption.ts:489`/`:574`, `supervision.ts:140`. | **The vector caller.** Tests: "REFUSES an argv[0] that only looks like a claude once the vector is flattened", "REFUSES a smuggled argv[0] even when every OTHER rule is satisfied", "ACCEPTS a real builder argv whose paths contain spaces". The four string callers are `ps`-derived and cannot be handed a vector — **not covered, filed as #672**, and the docblock says the rule is vacuous for that form rather than implying coverage. |
| **Protocol gate** (`verifyHerdrProtocol`) | Every `HerdrHost` method that opens a connection: `spawn`/`attach` (shared `open`, `:239`), `inspectHandle` (`:795`), `closeHandle` (`:851`). | **All of them.** Tests: `herdr-adoption.test.ts` protocol-gate cases for inspect and close; M15/M16 red when either gate is removed. |
| **Absence is instrument-relative** (`scanTranscriptOwners` → `none`) | Its one consumer: the pid-fallback's handle clear at `boot-adoption.ts:788`, which is also what licenses the cold spawn at `spawn.ts:927`. | **Covered.** Tests: `orphan-adoption.test.ts` "answers UNKNOWN for a live owner whose spaced binary path the listing renders ambiguously", "a bystander holding the transcript open is UNKNOWN, not none", "a strict match still OUTRANKS an ambiguous one", control "a genuinely empty machine is still a positive absence"; and through the consumer, `boot-adoption.test.ts` "REFUSES rather than clears when a process merely MENTIONS the session id". M59 reds the unit, M60 reds the consumer. |
| **Absence is read-relative** (`readRegistryState`) | Every production reader of `loadRegistry`/`getRecord`. **Migrated (they decide on absence):** `reconcileOwnRepl` (licenses a cold spawn), `rowStillNames` (licenses a close). **Not migrated, and why:** `boot-adoption.ts:1255/1385/1398` are read-BACKS after a write, used only for log text; `supervision.ts:468/602/957/1080/1144` and `:302` iterate the registry for rows to act on, so `{}` means "no work this tick" and the tick retries — the conservative direction; `supervision.ts:116` yields no pid, so the orphan gate never kills an unverified one; `gateway-shutdown-kill.ts` writes no marker, a missed record rather than a destructive act; `pool.ts:181` falls back to the best model, cosmetic; `gateway/diagnostics/instance-sources.ts:112` is display. **One does decide and is filed as #676:** `spawn.ts:722` `resolveResumeDirective` returns `undefined` on absence, which means a FRESH session instead of a `--resume` — so under corruption it silently starts a new conversation rather than resuming the old one. Reached only through paths that do not go through the adoption gate (which now refuses on `unreadable`), so this branch narrows it without closing it — see the absence-decision sweep below for the full three-input classification. | **Covered** for the two migrated consumers: `boot-adoption.test.ts` "ENOENT … still PERMITS the spawn", "MALFORMED JSON refuses the spawn", "A NON-ENOENT READ FAILURE refuses the spawn too", "the CLOSE proceeds when the registry is genuinely gone", "but REFUSES to close when the registry is malformed", "and REFUSES to close on a non-ENOENT read failure". M64 and M65 red both directions. |
| **Shutdown survival gate** | The three kill sites in `shutdownAllPersistentRepls`: the pooled walk (`pool.ts:1177`), the late-arriving spawn (`:1228`), the ephemeral sweep (`:1254`). | **One of three, and the other two for different reasons.** The pooled walk is covered — `gateway-shutdown-survival.test.ts` "LEAVES a findable herdr-hosted child alive…" with its kill-direction counterparts. The ephemeral sweep is **correctly** uncovered: never pooled, never in a row, so the gate would answer `kill` regardless. The late-arriving spawn is **not covered and is a real gap — filed as #674**, a known residual of the survival feature rather than a defect introduced here: it can end a herdr-hosted child whose row names its pane. |

**On #674's difficulty, corrected, because a wrong reason recorded is how the next person
mis-scopes the work.** I first called it a phase-ordering change. It is not: that kill is
already detached and unordered (`fireAndForget(p.then(...))`), so consulting the survival
decision inside the `.then` reorders nothing. The real difficulty is that the callback
runs **late** — after `resetBootAdoption()` and after the supervision maps are cleared —
and `claimShutdownSurvival` takes the flock. A registry read under a lock, against a
half-torn-down process, is hard for its own reasons.

**And why it is a separate PR rather than another round here:** it fails in the
**conservative direction**. The cost is over-killing a REPL that was mid-spawn when a
deploy landed — one `--resume`. Nothing becomes a second owner of a transcript and nothing
is orphaned, which is what separates it from every other finding on this branch.

The audit is the deliverable, not the table's current contents: the next guard this branch
or its successors add should extend it, and a row that says "not covered, and here is why"
is worth more than one that says "covered" without the enumeration behind it.

### Round seventeen: a positive absence drawn from an instrument that could not see

**The dangerous mirror of the spaced-path finding, not a repeat of it.**
`scanTranscriptOwners` filtered a flattened `ps` listing with `cmdlineMatchesSession`. For
a supported spaced binary path — `/opt/my tools/claude --resume <uuid>` — tokenisation
gives `tokens[0]` = `/opt/my`, basename `my`, so the strict matcher refuses and the live
owner is **invisible**. The scan answered `none`; the caller read that as "this transcript
has no owner", cleared the durable handle, and licensed a cold `claude --resume` onto a
transcript that already had one. **Two owners, reached by an absence claim rather than a
presence one.**

Round twelve's finding was the same input class failing SAFE — a spaced path was refused
adoption. This one fails DANGEROUS, and that asymmetry is why it belonged here and not in
#672: #663 is the branch that newly turns this scan into an *authorization to spawn*, so
#663 owes the authorization's soundness. Third defect on this branch traceable to a path
with a space in it, and the first that can destroy a conversation.

**`none` is a claim about the instrument as much as about the machine.** The comment above
the call site already said it — *"Only a scan that RAN and found nobody is a positive
absence"* — and then applied it to one failure mode (the listing failing) while missing the
other (the matcher being blind to a shape the listing rendered lossily). The type already
had room: `unknown` existed and was reachable only from a failed listing.

**The discriminator inverts the substring test's usual weakness.** This module's header is
right that "the cmdline contains the uuid" is far too weak to license a KILL or an ADOPT —
a `tail -f …/<uuid>.jsonl` satisfies it. That same weakness is exactly what makes it strong
enough to refuse a claim of ABSENCE: if the uuid is on that command line at all, the scan
cannot honestly say the transcript is unowned. A strict match still outranks an ambiguous
one, because `owners` is the strongest statement available and both refuse the spawn.

**An existing test asserted the behaviour this ruling makes wrong, and it was rewritten
rather than deleted.** "ignores a process that merely MENTIONS the session id" expected
`handle-cleared` for a `tail -f` bystander. That was right about the bystander and wrong
about what the instrument can establish: since the scan cannot distinguish "bystander"
from "owner I could not parse", it must not claim absence for either. The case now asserts
`undecided`, the reason, and — the assertion that carries it — that the handle **survives**.
The bystander costs a refusal, which is the direction to be wrong in: a refused clear is
retried next turn, a second owner corrupts a conversation.

**The rows are built by the real builder and joined the way `ps` renders them**, with the
premise asserted (`cmdlineMatchesSession` really does fail on that row) so the case cannot
decay into the ordinary-owner case if the matcher ever learns to parse it. The positive
control — an empty machine, and a busy machine with nothing of ours on it — is the one
that matters most here: without it, answering `unknown` for everything would satisfy the
finding and the feature would never clear a handle again.

### Round eighteen: the refusals were writing the file, and the close was licensed by half the evidence

**Two rounds of fail-closed work did not yet do what it said.** `withRegistry` called
`saveRegistry` unconditionally after the callback, and `skipSave` came only from the
corrupt-load path — the mutate callback had no way to ask for one. So both refusal sites,
returning the registry unchanged because they had not got the lock, still **wrote the
file**, from a snapshot loaded before the callback ran. A concurrent incarnation's newer
row is dropped: **a lost update performed by the code that refuses to act because it did
not get the lock**. The callback can now return `skipSave: true`, and both sites do.

**And the tests could not have seen it, for two separate reasons.** They compared parsed
fields of OUR row, which match our snapshot by construction — so a byte-identical rewrite
is invisible, and another writer's row disappearing is invisible. The first is now caught
by writing the fixture in a compact, non-`saveRegistry` formatting and comparing **bytes**:
the formatting is the witness, which is the M41 lesson applied where it finally matters.

**The second could not be constructed at the level it was asked for, and that is reported
rather than papered over.** The lost update needs a writer to land BETWEEN the snapshot
and the save, and `withRegistry` loads and saves inside one synchronous flock section — so
a pass-level case cannot get between them and would have passed either way, which is
exactly the vacuity this branch keeps catching. It is constructed where it can be: a
direct `withRegistry` case whose own callback plays the concurrent writer, which IS that
window. It reds under M61; the pass-level version would not have.

**The close was licensed by the process alone.** `closeAndClear` re-checked process
identity, closed, and only then ran the row CAS. A newer incarnation of OURS on a reused
pane id classifies as `close-foreign-owner` — it is a claude on this transcript that is not
our child — so the identity gate authorised ending the very thing that replaced us, and
the CAS reported `row-moved` after the pane was already gone. The row is now read under
the lock immediately before the close.

**The first version of that fix was too strong, and the over-strict mutation is what says
so.** Refusing whenever the row had changed broke the act this path exists for: if the row
names a DIFFERENT pane, nothing names the one we are holding, so it is an unreferenced
live claude on this transcript and closing it is the orphan-and-second-owner prevention
the module is for. The rule is narrower — refuse only when the row names **this** pane
under another generation (someone re-claimed it), or when the row could not be read at all
(the same "unestablished evidence licenses no destructive act" rule the `unavailable`
branch above it already follows). M63 mutates it back to the over-strict form and reds two
cases; both directions are pinned.

**What the pre-close check achieves, said at both its own site and in the spec item.** It
does NOT eliminate the window — a row can still move between the read and the close. It
narrows that window from the whole close (three awaits, any of which a spawn can complete
inside) to the gap between two adjacent statements with no I/O between them, and it changes
what LICENSES the act: the row is now required as well as the process. Closing the window
properly needs a durable "closing" marker written under the lock before the close, which
trades this residual for another — a crash between marker and close leaves a row marked
closing over a live pane. My view, offered rather than punted: the narrowing is the right
trade here, because the remaining window contains no I/O and the marker's own residual is
harder to reason about than the one it removes. It is written as a narrowing in both
places, not as an elimination.

**The lock-vs-clear test had to be rebuilt for an honest reason.** Since the pre-close gate
now reads the row under the lock too, forcing the flock to fail for the whole pass refuses
the CLOSE and the case never reaches the clear — it would silently have become a different
test. The flock is now failed inside `onClose`, which runs between the two.

### An instrument note: a red check that is not about the code, and how to tell

`Analyze (javascript-typescript)` failed on `7c4ec676`. It was not a finding, and the way
to establish that is worth keeping, because **"CodeQL failed" reads identically whether a
query found something or an upload dropped a file.**

The discriminator is **whether an analysis was recorded for the ref**:

- `GET /code-scanning/analyses?ref=refs/pull/<n>/merge` — an alert-bearing failure has one;
  an upload failure has none.
- `GET /code-scanning/alerts?ref=…&state=open` — empty here.
- The job log corroborates rather than decides: every query interpreted, `CodeQL scanned
  2730 out of 2730 TypeScript files`, SARIF exported, `Uploading results`, and then nothing
  before the step failed.

Every open alert in the repo at that moment was pre-existing on `main`, in files this
branch does not touch (`js/redos` in `cores/sdk/manifest.ts`, `js/polynomial-redos` in
three `tasks/`/`scribe/` files). The right response was to change nothing — not the code,
and not the alert state. This is the same family as the branch's other instrument findings
— a scan that cannot see a shape, a branch with no observable, a byte comparison whose
bytes are indistinguishable — and it belongs with them: **before treating a red as a
finding, establish that the instrument ran.**

### Round nineteen: the oldest defect on this branch, underneath every guard above it

**`loadRegistry` answers `{}` for three different facts** — a genuinely absent file
(ENOENT, the steady-state cold boot), a non-ENOENT read failure, and malformed JSON. It
knows the difference internally and told nobody. The mutation path already compensated
(`loadRegistryForMutation` returns `skipSave` for exactly the read-failure case, because a
write over a registry you could not read is a write over someone's data); the READ path had
no such compensation, and by round eighteen two decisions rested on it:

- **a corrupt registry authorised a cold spawn.** `reconcileOwnRepl` read `undefined` and
  answered `no-handle`, which `adoptionPermitsSpawn` lists under *"positive absence …
  nothing owns the transcript"*. A live pane, a valid row, the file then corrupted, and
  the next turn started a second `claude` on that transcript without inspecting the pane.
- **and it licensed closing a live pane.** `rowStillNames` caught a *throw*, but
  `loadRegistry` does not throw on a corrupt file — it returns `{}` — so the row came back
  `undefined` and the function answered `not-named`, the PROCEED branch. "Nothing names
  this pane" is true of a registry that was READ.

That is **false and unknown sharing a branch**, this tree's own named defect, sitting at
the bottom of the stack where every guard above it reads through. Both consequences are
ones this feature exists to prevent, and both were reached through a helper nobody
suspected because it never fails loudly.

**`readRegistryState` reports the distinction** — `loaded` / `absent` / `unreadable`, the
last carrying its reason — and **only the two deciding consumers were migrated**.
`loadRegistry`'s contract is deliberately unchanged: it has many callers, and a wholesale
migration is a far larger diff than this branch should carry at round nineteen. A caller
that only asks "give me what is there" is correct with `{}`; a caller that DECIDES on
absence is not.

**The boundary that must not move, tested before anything else: ENOENT stays a true
absence.** A cold boot has no registry file. If a missing file began refusing spawns,
nothing would start. `absent` is permission, `unreadable` is refusal, and M65 mutates that
pair the system-breaking way round and reds the two ENOENT cases.

**`getRecord`'s normalisation became a shared function rather than being re-implemented.**
The migrated read needed the same record `getRecord` returns, and copying four lines of
model-normalisation into a second place is how two readers of one file quietly start
disagreeing. `normaliseRecord` is now exported and `getRecord` is one line over it.

**Six cases, three input shapes against each of the two consumers**, with the reason
asserted to distinguish them: ENOENT (spawn permitted / close proceeds, unchanged),
malformed JSON (both refuse), and a non-ENOENT read failure produced the way production
would — the registry path is a directory, so `readFileSync` fails EISDIR rather than
ENOENT.

### An instrument note on my own monitor, since this branch collects them

The CI watcher exited on `2dca13ff` reporting "ALL CHECKS SETTLED — 1 of 4 not green". It
was wrong, and in the familiar direction: it breaks when every check it can see is
non-pending, and at that moment GitHub had registered only the four CodeQL checks — the
`ci` workflow was still **queued** and contributed nothing to the list. An empty or partial
list satisfied "all settled" exactly as a complete one would.

Same shape as the findings this branch has spent nineteen rounds on: **absence of evidence
read as evidence**. The fix is the same as everywhere else — require a positive statement
(the `ci` run reaching `completed`) rather than the absence of a pending one.

### Round twenty: the same collapse one granularity down, and the sweep that should have found it

**A dropped ROW reads as `loaded`.** `parseRegistryContents` discards individual
schema-invalid rows and still reports success — correct for a whole-file read, and it
reproduced round nineteen's collapse one level down. A well-formed file whose target row
carries `has_session: "true"` parses, the row is discarded, and the key simply is not
there: `absent` again, from a row that was **unreadable**. Both migrated consumers read it
as a positive absence — one licensing a cold spawn, the other licensing a close. One line
of JSON, and a live pane's durable record vanishes from every decision that matters while
the read reports success.

`readRegistryState` now returns `droppedKeys`, and both consumers ask the only question
that concerns them: **was MY key dropped?** A drop on somebody else's key says nothing
about mine, and refusing on it would turn any corruption anywhere into a gateway that
serves nothing — M67 mutates it to that over-strict form and reds the two other-key cases,
which is the direction most easily missed.

**A test fixture caught me encoding my own model again.** The first version hand-wrote the
"valid" row beside the invalid one, omitted `reuse`, and the case failed with
`closed-unadoptable` for a reason that had nothing to do with dropped rows. The valid row
is now read from disk — the same lesson as building argv with the real builder, which this
branch has now learned three times in three different shapes.

### The absence-decision sweep: every site that branches on a row being missing

The guard/call-site audit above is organised by GUARD, and that framing is what let four
findings through one at a time — the defect is not in a guard, it is in a **decision
shape**. So this sweep asks the other question, of every production site that reads the
registry and branches on a row not being there, with the three inputs as columns. The grep
is `getRecord\(|loadRegistry\(|readRegistryState\(|registry\[` over `runtime/`,
`gateway/`, `trident/`, `scripts/`, with a **positive control**: it must find the two sites
already migrated (`boot-adoption.ts:560` and `:1027`), and it does.

| Site | Row genuinely absent | Row dropped as invalid | File unreadable / unparseable | Verdict |
|---|---|---|---|---|
| `reconcileOwnRepl` (`boot-adoption.ts:560`) | `no-handle` → spawn permitted | `undecided` → refused | `undecided` → refused | **All three correct.** Tests: the six r19 cases + the two r20 target-drop cases. M64/M65/M66/M67 pin all four boundaries. |
| `rowStillNames` (`:1027`) | `not-named` → close proceeds | `unreadable` → refused | `unreadable` → refused | **All three correct**, same cases. |
| `claimShutdownSurvival` (`gateway-shutdown-survival.ts:207`) | kill | kill | kill | **Correct, and for the right reason** — not a collapse. Survival requires POSITIVE evidence that a row names this pane; every failure to produce that evidence is a kill by design, and the cost is one `--resume` on our own child. Recorded because "all three answers agree" is exactly what a collapse looks like from outside, and here the agreement is the rule rather than an accident. |
| `planRespawn` (`session-respawn.ts:96`) | `session-not-found` → refuses | refuses | refuses | **Correct.** A respawn it cannot plan does not happen and the tick retries; refusing on all three is the conservative direction. |
| `runWedgeWatchdogTick` (`supervision.ts:481`) | `record` undefined → probe with no record | same | same | **Correct, via a downstream gate.** A missing record can reach `respawn-and-alert`, but the respawn itself goes through `planRespawn`, which refuses. **The protection is not where a reader would look**, so anyone changing `planRespawn`'s `session-not-found` branch needs to know this tick depends on that refusal — relaxing it there would let a wedge watchdog act on a row it never read. |
| cwd-drift check (`supervision.ts:618`) | `continue` — nothing to compare | same | same | **Correct.** No canonical cwd means no comparison, not a failed comparison. |
| registry sweeps (`supervision.ts:468/602/957/1080/1144`, `:302`) | no rows → no work this tick | same | same | **Correct.** "No work this tick, and the tick retries" is a right answer to all three. |
| orphan identity (`supervision.ts:116`) | no pid → never kills | same | same | **Correct** — the gate's whole rule is that it never touches an unverified pid. |
| shutdown-kill markers (`gateway-shutdown-kill.ts:471/745/826/828`) | no marker written | same | same | **Correct** — a missed record, not a destructive act. |
| read-backs (`boot-adoption.ts:1270/1400/1413`) | log text only | same | same | **Not decisions.** |
| replay model (`pool.ts:181`) | falls back to the best model | same | same | **Cosmetic.** |
| diagnostics (`gateway/diagnostics/instance-sources.ts:112`) | empty list displayed | same | same | **Display, not a decision.** |
| **`resolveResumeDirective` (`spawn.ts:722`)** | `undefined` → fresh session | `undefined` → fresh session | `undefined` → fresh session | **COLLAPSES — filed as #676.** All three produce a FRESH session instead of a `--resume`: no second owner and no lost transcript file, but the user's conversation continuity is gone with nothing surfaced. The only genuine collapse the sweep found beyond the two already fixed, and it is silent, which is why it needs an issue rather than a table note. |

One genuine collapse, one already-known, and eleven sites that are fine — and the eleven
are written down because **"all three inputs get the same answer" is what a collapse looks
like from outside**, and the only way to tell them apart is to say why the answer is the
same.

### The mutation table was carrying a dead row, and that is the artefact whose job is to be checkable

**M38 is superseded and now says so.** It records that REMOVING the whitespace refusal
reddens a test; M50 records that RESTORING it reddens tests. Both cannot be true of the
same code, and round twelve is why: it deleted `argvElementCarriesWhitespace` outright.
A counted-but-dead mutation inflates the table's evidence with a check nobody can run —
the same defect as a stale count in a criterion body, in the one artefact whose entire job
is to be checkable.

**The class was swept, not just the instance.** Every mutation subject was checked for
existence in the tree, with `primeLatches` (M1/M2's subject) as the positive control that
the search works. `argvElementCarriesWhitespace` is the only absent one, so M38 is the
only dead row. The live count is therefore **M1–M91 less M31, M38, M80 and M91 = 87**.

### Round twenty-one: the sibling pattern, found inside the comment about the sibling pattern

**`clearPaneHandleIfUnchanged`'s early returns wrote without the lock.** `prev ===
undefined` returned `'absent'` and a row mismatch returned `'row-moved'`, both **above**
the `!acquired` check and neither with `skipSave` — so on a failed flock both wrote the
snapshot loaded before the callback ran. The lost update round eighteen fixed, surviving
in the two branches that returned early.

**And the hoist changes the answer, which is the honest part.** Those readings came from an
unguarded snapshot: without the lock we do not know the row is absent or moved, only that
we read something we had no right to trust. Both now answer `lock-unacquired` — the
truthful answer and the fail-closed one — rather than being preserved by checking
`acquired` on the write alone.

**The comment was the finding.** Round fifteen's note at the claim said *"The clear below
got this right; the claim beside it did not inherit it."* True of the clear's FINAL branch
and false of its early returns — a false claim about the code three lines above the correct
implementation, naming the file's other half as the exemplar while that half was the
defect. **Sixth instance of the sibling pattern, found inside the comment about the sibling
pattern.** The comment now says what is true: both sites check acquisition first, and the
clear's early returns were the last place the rule had not reached.

**Both test cases passed against the defect on the first writing, for two different
reasons, and both are worth recording because neither is about this fix.**

1. The absent case used an **empty** registry — and `JSON.stringify({}, null, 2)` is
   byte-identical to `JSON.stringify({})`. The very rewrite being hunted was invisible to
   the instrument chosen to see it. It now holds another incarnation's row, which is also
   what the lost update would destroy.
2. Both cases drove the **close** path — and since round eighteen the pre-close gate reads
   the row under the lock, so with the flock failing it refuses the CLOSE and the clear is
   never reached. The cases were green because nothing ran. They now drive the
   **pid-fallback** path (`handle-cleared`), which reaches the clear with no gate in front
   of it.

The second is a general hazard worth naming: **a fix that fails closed earlier in a path
can make a later guard's test unreachable without making the test fail.** The earlier
refusal is correct, the later test still passes, and the coverage is gone silently. I found
it by mutating rather than by reading, and the mechanism was confirmed with a standalone
probe — a direct `withRegistry` call on a compact file, showing a no-`skipSave` return does
rewrite it — so the conclusion "the clear is never reached" rests on a measurement rather
than on my reading of the control flow.

### Round twenty-two: two documents claiming more than the code gives

No code changed, so mutation is not the instrument here; the check is that three artefacts
say the same thing about the same two boundaries.

**"Without weakening what it asks for" was false, and it was mine to fix.** The spec item
introduced the restated criterion as equivalent to the owner's. As quantified statements
they are not: *every project REPL* and *every project REPL whose substrate this gateway
constructs* are different sets, and the same file documents the gap two sections down.
Asserting equivalence while documenting the difference is the overclaim shape this branch
has now corrected seven times, and the correction is not to soften the restatement but to
stop claiming the two sentences are one. The item now separates three statements: narrower
as a claim about **boot-time mechanism**; equivalent as a claim about **what the owner
experiences**, because reconciliation precedes that substrate's first turn so no turn is
ever served by a fresh process where a survivor existed; and the observable difference is
the **window between restart and first use**, cross-referenced to the residual so a reader
meets the gap where they meet the claim.

That last part is the reason this matters beyond tidiness: if the owner reads this item and
decides the boot-time reading is what he meant, that is his call to make against a document
that told him the truth — not one to pre-empt by pretending the difference does not exist.

**The Decisions Log claimed a guarantee the code does not give.** *"left running when — and
only when — a persisted registry row names its exact pane and its exact generation"*: the
**only when** half is true and is the safety half; the **when** half is not, because a spawn
still settling at shutdown is killed on resolution whatever row it wrote (#674). A filed
issue does not make a present-tense claim accurate — the standard applied to me at round
sixteen, now applied to a line I wrote. The entry is unmerged, so it is fixed in place:
"ONLY when", with the converse explicitly disclaimed and #674 named.

**The sweep found a third site the citation did not name.** `SPEC.md` §2.3's body carried
the per-substrate boundary but not the late-settling kill — accurate as far as it went,
since it only ever stated the "only when" direction, but a reader of the architecture
section would not have learned the exception exists. It now carries both. Three artefacts
drifting apart on one claim is exactly how the "still covers" defect happened, so the check
is now explicit: **both boundaries appear in all three documents**, verified by grep with a
positive control on the line just edited.

### Round twenty-three: the verdict was right and both consumers threw it away

`clearPaneHandleIfUnchanged` answers `lock-unacquired` when the compare-and-set could not
be established. Both consumers discarded it:

- `clearHandleThenVerdict` branched only on `row-moved` and let everything else return the
  caller's spawn-permitting finding;
- `closeOutcomeOfClear` put `lock-unacquired` and `error` in the same `case` as `cleared`
  and `absent`, returning `closed`.

Both are spawn-permitting, so the interleaving is real: A establishes H1 gone and closes
it; B replaces the row with a live H2/G2; A fails to acquire the clear's lock **and
therefore cannot see B at all**; A reports `handle-cleared` and a cold spawn starts a third
owner. A path that had already decided it did not know enough to act, licensing the act.

**The comment was the defect, not merely the code.** It argued that "a registry that could
not be written is a stale handle the NEXT boot re-inspects — not a live owner", which is
exactly right for `absent`: we read the row and found nothing. Without the lock we did not
read it, which is the whole reason `lock-unacquired` exists. **The sound reasoning was
inherited by the wrong outcome because the two shared a `case` list** — the eighth instance
of this branch's sibling pattern, and the first where the vector was a comment's scope
rather than a missing call.

`lock-unacquired` and `error` now answer `undecided` with `ROW_UNESTABLISHED_REASON`,
distinct from `ROW_MOVED_REASON` because "the row moved" and "I could not establish what
the row says" are different facts. The close path gets a new `CloseOutcome` kind,
`closed-row-unestablished`: the close really did happen and the code does not pretend
otherwise, but the row's state is unknown so it licenses nothing. `cleared` and `absent`
are untouched — those are reads that happened.

**Why the existing cases could not see it, which is the transferable part.** The failed-lock
cases asserted the registry file's **bytes** were unchanged, and stopped there. Bytes were
the right instrument for the WRITE and say nothing about the VERDICT the pass then reports.
A correct assertion, measuring the wrong half of the behaviour, for five rounds. Those
cases now assert `adoptionPermitsSpawn(...).ok === false` as well, and there is a new case
that constructs the interleaving itself — B's live H2/G2 arriving unseen — and asserts no
spawn is licensed and B's row is untouched.

**A third test on this branch pinned a claim the code should not make**, and like the
bystander case in round seventeen it was inverted rather than deleted, with the reasoning
written into the case: it required `closed-foreign-owner` — a spawn-permitting outcome —
after a lock failure, on precisely the argument the comment made.

### Round twenty-four: the same race with the window moved, and a latch whose clearing is the dangerous half

Round nine closed *"a pass already running when shutdown starts"*. This is the other
window: `settleBootAdoptionsForShutdown` snapshots the live passes and returns immediately
when that snapshot is empty, and nothing stopped a request constructing a substrate a
moment later and starting a pass that blocks in `attach` — never marked, never abandoned,
publishing into a pool already torn down. `resetBootAdoption` preserving a still-running
pass, correct for the passes it was written for, is what lets this one survive to publish.

**A latch, set before the settle takes its snapshot**, and a pass begun after it is born
`shutdown`-abandoned rather than refused outright: the caller still gets a well-formed
`undecided` with the existing reason, and the spawn gate refuses it exactly as it refuses
every other abandoned pass. One disposition for "this gateway is going away", not a second
one every consumer would have to learn. The latch is read and the pass registered in the
same synchronous step, or the race would simply move one level down.

**The clearing semantics are the dangerous half, and the suite proved it before the
mutation did.** Production never clears: a real restart is a fresh process, shutdown is
one-way within this one, and clearing would re-open the window. The only clear is
`resetBootAdoptionForTests`. The moment the latch existed,
`adopted-repl-serves-a-turn.test.ts` went red — it calls `shutdownAllPersistentRepls` in
`afterEach`, so every case after the first inherited a latched module. That file is now the
reason the clear exists, and it says so.

**Then it failed again for a reason the file could not fix by itself.** Passing alone and
failing in the full run: bun runs many test FILES in one process, so a suite that shuts a
gateway down latches adoption off for whatever file runs next. Clearing after each case
protects a file from itself; clearing **before** each case also protects it from every
other file. All four adoption suites now clear in `beforeEach`, and the failure mode is
worth naming because it is green-looking: the first case passes and the rest adopt nothing.

**Two fixture defects found on the way, both the same shape as ones this branch has already
paid for.** Key B initially had no row, so the pass answered `no-handle` before reaching
any abandonment checkpoint — the case proved nothing about the latch. Then B was given a
copy of A's row, so `postReply` read A's sink registration and answered 200: the case could
not tell the two sessions apart, which is the one thing it exists to do. B is now a
genuinely distinct session — own key, session id, generation, channel and pane.

**On the reachability hazard from round twenty-one — it fired, and the check is why I know.**
The latch is a new early refusal, so the round-nine mutations were re-run against it. M45
and M46 still red. **M47 stopped redding**: its case drove `resetBootAdoption` through a
full `shutdownAllPersistentRepls`, and a pass begun after that is now born abandoned — so
it was refused whatever the reset did with the dedup entry, and the case passed for a
reason that had nothing to do with the property it is named for. Exactly the shape round
twenty-one named, caught by re-running old mutations against a new guard rather than by
reading.

The case now calls `resetBootAdoption` **directly**, with no shutdown, which isolates the
retention. And its assertions had to move too: with no shutdown the pass legitimately
ADOPTS, so "both outcomes are `undecided`" was pinning the shutdown rather than the
retention. The property is now asserted where it actually lives — **`host.attached` has
length one** — because the second caller receives the first pass's outcome under either
implementation, which is precisely what makes an outcome assertion unable to tell them
apart. M47 reds again, and now for the reason it claims.

**The rule this leaves behind:** when a guard is added early in a path, re-run the
mutations of every guard downstream of it. A mutation that stops redding is not noise; it
is the new guard having eaten the old one's coverage.

### Round twenty-five: the pane was handed over and the wrapper was not

The survival branch returned without killing **or detaching** the `PtyChild`. That child
owns a poll loop still wired to this session's detectors and actuation queue, and the
branch deliberately kept its sink registration on the reasoning that *"this process is
going away"*. The parenthetical was doing all the work — in a module whose own sibling
(`gateway/index.ts`) names "tests, in-process restarts, overlapping boots" as supported.
When the process does not go away: the next adoption attaches a SECOND wrapper while the
retired one keeps scanning the same pane and can fire a detector actuation into it. **The
stale-screen keystroke hazard this feature documents, arriving from a gateway already told
to stop** — and this one is the PR's own creation, not something inherited, which is why it
was not deferrable the way #674 is.

`PtyChild.detach?()` is the non-destructive counterpart of `kill`: stop reading, stop
delivering, send nothing, and **never close**.

**That sentence was ahead of the code when round twenty-five wrote it, and round
twenty-six made it true.** `detached` was consulted only by the poll loop's stop
predicates. `send` — which `write`, `writeKey` and `writeKeys` all route through —
checked only `exited`, at queue time and again at execution time, and so did `submitLine`;
and `detach` deliberately never sets `exited`. So the detach blinded the wrapper and
**left its keyboard connected**, including for a call already queued whose execution lands
after the detach — the exact window the execution-time re-check exists for. The
observation path was closed and the actuation path, which is the half with teeth, was not. The survival branch calls it, stops the
watchers, and unregisters the sink — because a retired wrapper that stays registered can
receive a reply meant for the incarnation that replaced it. The comment's false
parenthetical is corrected in the same edit.

**The assumption the whole design rests on is measured, not read.** "Stopping the loop is
*issue no more requests*, not *tear down a session*" is exactly the claim whose failure
turns a safe detach into a pane kill, so it is asserted against the real client and the
fake server: after `detach`, at most one already-in-flight read completes, **no `close` /
`kill` / `destroy` method is ever called**, and the server still reports the pane `live`.
With a `kill` control beside it, so "detach is safe" cannot be passing because both are
inert.

**Three mutations refused to red for three different wrong reasons, and each was a defect
in my method rather than in the code.**

1. `settleExit('closed-by-us')` inside detach — that marks the child exited but **issues no
   request**, so it was not the mutation I described. The real one calls `pane.close` the
   way `kill` does.
2. That corrected mutation *still* did not red, because my patch matched the **first**
   occurrence of `clearTimeout(gateTimer)` in the file — inside `settleExit`, three hundred
   lines above `detach`. The mutation was applied to code the test never reaches. **A
   mutation patch that matches the wrong site is indistinguishable from a guard that works**,
   and the only way I found it was checking the line number the patch landed on.
3. The delivery-gate mutation did not red because, with the loop stopped, there is nothing
   left to deliver: the gate covers only the read **already in flight** when detach lands.
   That window needs `holdMethod('pane.read')` to construct, and the case that does it now
   exists. My first attempt at it compared a read count against a screen count and hung —
   my bug, in the test, found by running it.

**Downstream re-check, third time the rule has earned its place.** Detach is a new act
inside the survival branch, so the round-nine and round-twenty-four mutations were re-run
through it: M45 (3), M46 (2), M47 (1) and M72 (1) all still red. No coverage was eaten this
time — but the check is what makes that a statement rather than an assumption.

### Round twenty-six: the detach stopped the eyes and not the hands

**`detach()` stopped observation, not actuation.** `detached` was read in exactly two
places, both poll-loop stop predicates. `send` checked only `exited` — at queue time and
again at execution time — and `write`, `writeKey` and `writeKeys` all route through it;
`submitLine` likewise. Since `detach` deliberately never sets `exited`, a retired wrapper
could no longer *look* at the pane and could still *type* into it, including a call queued
before the detach whose execution lands after it. The contract claimed the stronger
property, and so did the as-built — **both are corrected in this push**, the claim in the
same change as the code.

`detached` now sits beside `exited` at all four sites, reported through the channel that
already exists rather than a new one: `send`'s `onNotDelivered` fires `skipped`, which is
what clears the interrupt latch, so a caller that latched before calling still hears that
nothing was sent. `submitLine` throws, with its own sentence — "after DETACH" is a
different fact from "after exit": there the pane is gone, here the pane is alive and
belongs to somebody else.

**And `release()` left an attached wrapper attached.** `HerdrHost.open` starts the poll
loop before returning the child, so a pass abandoned mid-shutdown *after* a completed
attach left a live wrapper on the pane and the next gateway attached a second one — the
duplicate-wrapper hazard, reached through the deliberately non-destructive path. Both
release variants now `detach?.()` the child they hand back.

**Two mutations did not red, for opposite reasons, and only one was a defect.**

- **M80** (drop `detached` from `send`'s QUEUE-time check) does not red, and should not:
  the execution-time check subsumes it. The two overlap by design — the queue-time check
  avoids enqueuing work at all — so removing one leaves the other. Recorded as subsumed
  rather than counted, because a mutation that cannot red is not evidence.
- **M81** (drop the `detach()` from `release`) did not red because **my assertion was
  vacuous**: I asserted `keysSent` stayed empty, and by that point the pass has already
  torn down the detector wiring, so no keystroke would have been sent either way. The fake
  child now records `screensDelivered`, which is a surface that still moves at that point,
  and M81 reds. Fifth fixture-vacuity on this branch, and the same shape every time: an
  assertion that both implementations satisfy.

**Downstream re-check, fourth outing.** `release` gained a new act, which puts it in front
of the round-nine and round-twenty-four cases. M45 (3), M46 (2), M47 (1) and M72 (1) all
still red. Nothing eaten — and saying so is only worth anything because the check was run.

### Round twenty-seven: a persisted string became a filesystem path, and the exit path deletes

**The chain.** `isMinimalRecord` accepted any string as `channelName`;
`replSessionConfigPaths` builds `join(tmpdir(), 'neutron-repl-' + channelName)` with no
containment check; adoption feeds it the **persisted** value; and the child-exit path
UNLINKS what those paths point at. A row carrying `x/../../../some/dir` therefore deletes
`session-mcp.json` / `session-settings.json` / `session-tools.json` under that directory —
bounded to three filenames, which is the only thing keeping it from being worse.

**Newly reachable through this branch, which is why it was not deferrable.** Before
adoption, the channel name was always one `spawn.ts` had generated in-process moments
earlier. Adoption is the first caller that takes it from disk, where it can be corrupted,
hand-edited, or written by anything else running as this user. The threat model is a local
write to the registry — and it converts "the registry is garbage" into "files outside the
temp directory get deleted", which is a much worse failure than the one it starts from.

**Two layers, because they answer different questions** — and round twenty-eight found a
third question neither of them answers; see below. The LEXICAL containment check lives in
`replSessionConfigPaths`, so that property holds for **every caller including ones that do
not exist yet** and cannot be bypassed by a new one. The shape check lives at the registry
boundary — `^neutron-[0-9a-f]{32}$`, checked against what `spawn.ts` actually emits
(`randomBytes(16).toString('hex')`) rather than against a guess — so a bad value is visible
early and specific. **Neither alone.**

**And the two rounds compose.** A row failing the shape check is dropped, and since round
twenty a dropped TARGET row surfaces as `unreadable` rather than reading as absence — so
the malformed row becomes a REFUSAL instead of a deletion.

**My first test expectations were wrong, and correcting them is the clearest statement of
why both layers exist.** I listed `x/y`, `../evil` and `/etc` as escapes. They are not:
`join` keeps all three under the temp directory, so the containment check correctly permits
them. Containment asks *"could this delete something outside the temp dir"*; the shape
check asks *"could this row have been produced by this system at all"*. Only the second
rejects those three, and the case now says so rather than quietly dropping them.

**The schema tightening had a blast radius worth reporting: 67 new failures** across
thirteen test files, every one a fixture using a channel name production could never emit
(`'chan-1'`, `'c'`, `'persisted-channel'`). The same "fixture encodes my model rather than
reality" shape this branch has now hit six times — and this time the model was *the
registry schema itself*. The fixtures were rewritten to conforming names derived
deterministically per distinct literal, so rows that needed to differ still differ, and two
`trident/` files were reverted because their `channelName` is a `buildReplArgv` input
rather than a registry row — churn in another lane's file for no gain. Verified against the
baseline: 2 failures before the change, the same 2 after (`buildGBrainMemory`, unrelated).

**The module header contradicted the design it introduces**, saying `beginBootAdoption`
"runs once per registry path" while the cache is nested by registry path AND session key —
the exact ambiguity six rounds went into removing, reintroduced at the top of the file a
reader meets first. Corrected, with the reason, and grepped for siblings with a positive
control; the one other hit (`gateway-shutdown-survival.ts`, "once per registry loss") is
about registry LOSS, not adoption scope, and is correct as written.

### Round twenty-eight: the containment check was lexical and the filesystem is not

`replSessionConfigPaths` resolves textually and checks the prefix. It never consults the
filesystem, so `/tmp/neutron-repl-<32hex>` passes every lexical test **while being a
symlink** to somewhere else — and child-exit cleanup then follows it through `unlinkSync`.
The `..` cases covered `..` well and none of them could have seen this.

**The fix is not `realpath` in the builder.** That function is a pure path builder called
at SPAWN time, before the directory exists: a `realpath` there throws on a legitimate first
spawn. So the lexical check stays where it is and **stops claiming more than lexical**, and
the filesystem check goes to the destructive site where the directory exists and the
question is answerable. Three layers, three questions — the registry's shape check asks
whether the row could have come from this system at all, the builder asks whether the
string can escape, cleanup asks **where the directory really is**.

`realpathSync` on the DIRECTORY, then the same beneath-`tmpdir()` test: the same shape as
`registry-lock.ts`'s `O_NOFOLLOW` + `fstat` — ask where the thing LANDED, not what the name
pointed at when you looked.

**The TOCTOU window is not closed, and the comment says so.** Between `realpathSync` and
`unlinkSync` the directory could be swapped. Closing it needs an `openat`-style
handle-relative unlink Node does not expose. What this removes is the durable case — a
symlink already in place when cleanup runs — leaving the racing case, which needs an
attacker timing a swap into microseconds in a directory they must already be able to write.

**Refusing is not free and is logged as the leak it is.** A refused path is a credential
file we meant to delete and did not, so the residual is a RETAINED plaintext credential
file rather than a deleted stranger's file. The right direction, with a cost, said out loud
rather than swallowed by the existing best-effort catch.

**My first symlink fixture failed, and the reason is a trap worth recording.** I put the
"outside" victim in `mkdtempSync(join(tmpdir(), …))` — and on this box the worktree itself
lives under `/tmp`, so a "scratch" directory is INSIDE `tmpdir()` and the containment check
correctly allowed the delete. **A fixture meant to be outside a boundary has to be outside
it on the machine the test runs on**, which is not a property you can read off the code.
The victim now lives under `homedir()`.

### What a schema tightened at the parse boundary costs

The shape check has now demonstrated its blast radius twice: 67 fixtures in round
twenty-seven, and a 68th found by a CI shard rather than by me —
`open/__tests__/open-wiring-substrates.test.ts` seeding `channelName: 'dead-channel'`, in a
directory my `runtime/` + `gateway/` run never touched.

**The lesson is about the sweep's scope, not the rewrite.** A schema tightened at the parse
boundary invalidates every fixture that ever hand-wrote that field, **repo-wide, and the
compiler cannot see any of them** — they are string literals in valid TypeScript. So the
enumeration has to be a grep over the whole tree, not a walk of the directories under
change. Re-run repo-wide with a positive control, there are five non-conforming literals
left and **four of them are correct as they stand**: `trident/leak-fixer.test.ts`,
`trident/conflict-resolver.test.ts` and `build-repl-argv.test.ts` pass `channelName` to
`buildReplArgv`, which is a command-line builder and not a registry row, and
`launcher-liveness-probe.test.ts` now builds a conforming name per row from its index. Each
`trident/` hit is named and classified rather than the directory being skipped wholesale —
the judgement is per file.

### Round twenty-nine: two survivors of a corrected design, one of them three lines from its own correction

No code changed. Two comments still said the evidence clock bounds the wait — the module
header (*"the pass is bounded so the wait is too"*) and the timer (*"it bounds the WAIT
rather than the work … while the gate stops blocking"*). The timer only mutates `signal`;
every caller awaits `gated`, which settles when the pass settles.

**The sharp part is the timer's own block.** Its two sentences contradicted each other
three lines apart on the same variable: one said the budget bounds the wait and the gate
stops blocking, the next said *"it does not interrupt anything and it does not release the
gate"*. The false one was a survivor of the design this branch corrected, and it sat ABOVE
the correction — so a reader met it first. Both are gone, and the replacement says why
releasing early is the defect: a cold `--resume` while the old child is still alive.

**The grep found no third instance, and the await sites are why I checked.** `spawn.ts`,
`supervision.ts` and `adapters/claude-code/index.ts` all await the gate, and all three
describe it accurately ("after the pass has settled this resolves instantly"). The one
place that states what DOES bound the wait — the composition of per-step deadlines: the
herdr client's 10 s RPC refusal, the 5 s pid wait, the 2 s `/health` probe — was already
correct, in `BOOT_ADOPTION_BUDGET_MS`'s own docblock, which is what made the two survivors
visible as contradictions rather than as the design.

**Consistency check, with counts.** `boot-adoption.ts`: 7 true statements, 0 live false
ones (the single grep hit is the corrective prose quoting the old claim, the same shape as
the "still covers" quotations). The spec item makes no budget claim at all and its one wait
statement — *"a turn that arrives while the pass is in flight WAITS; it does not
cold-resume past it"* — is true. The as-built's only hit is a mutation name (M26, "never
release the gate"), which is accurate. Three artefacts, no disagreement.

### Two instrument notes from round twenty-eight, because both outlive this feature

**A fixture meant to be outside a boundary has to be outside it on the machine the test
runs on.** My symlink victim was `mkdtempSync(join(tmpdir(), …))`, and the worktree here
lives under `/tmp` — so the "outside" directory was inside `tmpdir()` and the containment
check correctly permitted the delete. Nothing in the code shows that; only the environment
does. Same family as the `JSON.stringify({}, null, 2)` fixture whose bytes could not
distinguish a rewrite: **an instrument that is sound and aimed slightly off the claim.**

**To decide whether a local failure is yours, run the same selection against the base and
compare the sets.** Shard 4 failed locally after round twenty-seven with `wireSubstrates`
AND a family of `install.sh` tests. Running the same shard against the pre-change tree
showed both failing there too; after the fix only `install.sh` remained. That differential
is what classified the `install.sh` family as environment rather than regression — without
it I would have been guessing, and the guess "these look unrelated" is exactly how a real
failure gets waved through.

### Round thirty: the guarded and unguarded lines were adjacent

`pool.delete(sessionKey)` was unconditional in all three cleanup paths while the same
functions identity-guarded `childByKey` and the sink — in `unwind` the guarded and
unguarded lines sit next to each other. So pass A pauses, something publishes a newer
session under the same key, A finds the row moved and unwinds, and **B's** pool entry is
evicted: B's child alive, its row naming it, and the map every turn resolves through no
longer holding it.

**Tenth instance of the sibling pattern, and the first where the neighbours are lines
rather than files.** Nine were a rule applied at one site and not another; this is a rule
applied to two of three structures **inside one function**.

`deleteOwnPoolEntry` copies `child-exit-wiring.ts`'s pattern **including the rejection
arm** — a pooled promise that rejected owns no child, so deleting it is right and dropping
that arm would wedge a rejected entry under the key forever.

**It is synchronous via `Bun.peek`, and that is a deliberate departure from the model.**
`child-exit-wiring` awaits the pooled promise; two of the three cleanup paths are
synchronous by contract (`release` is called from `claimRowOrUnwind`'s `publish`, typed
`() => RowAdoptionOutcome`), so awaiting there would ripple through the claim's signature.
`Bun.peek` is the same synchronous-mirror read `pool.ts`'s shutdown partition already uses
on this map, and using ONE form at all three sites is the point — a mixed approach would be
this branch's own pattern again, two sites guarded one way and the third another.

**Writing the positive control taught me what the "ours" arm is for.** Driving it through
the pass is impossible today: `adoptRow` publishes only after the claim succeeds, and no
cleanup follows a successful claim — so **none of the three paths ever runs with its own
session in the pool**, which means the unconditional delete they used to perform could ONLY
ever have evicted somebody else's entry. The arm is kept anyway, because the guard's
contract is "delete iff ours" rather than "never delete", and a guard whose safe branch is
unreachable today is one bug-fix away from being reachable tomorrow. All four arms are
pinned at the unit level, which is the only place they are observable.

### The per-structure table, scoped to every path that stops owning a session

Round thirty's version of this table was scoped to *"the three cleanup paths"* — the three
in `boot-adoption.ts`. It found `liveHandle`, which is the column earning its place, and it
could not find the fourth site because the boundary was drawn around one file. **The right
unit is every path that stops owning a session WITHOUT the child exiting** — four of them
across two files, and five the next time someone adds one.

| Structure | `unwind` (boot-adoption) | `release` / `releaseWithReason` | `pool.ts` survival branch |
|---|---|---|---|
| sink registration | released — `unregisterIf` (identity-guarded) | released — `unregisterIf` | released — `unregisterIf` |
| `childByKey` | released, guarded on `=== attached` | released, guarded | **n/a** — the shutdown walk has already drained the map before this branch runs |
| `pool` | released via `deleteOwnPoolEntry` (identity-guarded, r30) | released via `deleteOwnPoolEntry` | **n/a** — drained by the partition above |
| `sizeWatchdog` / `deadTurnWatcher` | stopped | stopped | stopped |
| the attached `PtyChild` | **closed** via `closeAndClear` — this is the destructive path | `detach?.()` — non-destructive hand-over | `detach?.()` |
| **live-process handle** | **deliberately retained** — this path CLOSES the pane, so the child exits and `child-exit-wiring`'s handler unregisters. See M91 below for what that cell actually means. | released (r30) | **released (r31)** — was the one site still missing it |

**What "deliberately retained" means, measured rather than assumed.** M91 adds a redundant
`unregister()` to `unwind` and **nothing reds** — the handle is identity-scoped, so a second
call is a harmless no-op. So the cell is *"not needed here"* rather than *"must not be done
here"*: the exit handler covers it, and an extra call would be noise rather than a bug.
Writing that distinction down is the point of the cell — a reader who only saw "retained"
might add one thinking it was missing, or remove the survival branch's thinking it was
symmetric.

**Why the survival branch's release is not redundant**, which is the other half and is
pinned by a case: that path leaves the pane running and detaches the wrapper, so `exited`
never settles and **nothing else will ever unregister it**. The case asserts the surviving
path clears its record with no exit at all, and that the killing path does not clear its own
— the division of labour, in both directions.

**My first version of that control asserted the opposite and failed, correctly.** I expected
a killing teardown to clear the record too; it does not, by design, because it ends the child
and the exit handler does the unregistering. The case is now written as the division it
actually is.

### Shard 3 on `96c38e3c`: a wall-clock flake, classified by differential — filed as #677

`trident/__tests__/cross-model-dispatch.test.ts` — "the detached wrapper outlives the
Bash-call bound that used to kill it". Nothing to do with `PtyChild.detach`; "detached"
there means a detached process. Round twenty-nine was documentation only, which is what made
it worth checking rather than assuming.

Classified with the method from round twenty-eight, and the strongest evidence is the one
that needs no timing at all: **`git diff --name-only origin/main HEAD` lists no `trident/`
file**, and the test plus the code it exercises are byte-identical to main's. A logical
break from this branch is therefore impossible; only contention could differ.

So contention was measured rather than dismissed — the coordinator's hypothesis was that
this branch's corrupt-registry cases write `.corrupt-<ts>-<pid>-<n>` sidecars in the same
shard as a 451 ms timing bound. `PLAN_ONLY` confirms shard 3 does hold both
`repl-registry.test.ts` and this case, so the hypothesis was live. **Shard 3 in full then
passed 3/3 on this head**, with those neighbours present, and the file alone passes 62/62
at this head and at its predecessor, 5/5 on repeat.

What remains is the case's own margin: it backgrounds a `sleep 0.25` and then
`await Bun.sleep(400)` — **150 ms of headroom on a shared runner**. That is a flake
generator regardless of who trips it, and it is **filed as #677** — with the suggested fix
being to wait on the marker file rather than the clock, which removes the margin instead of
widening it. What is NOT on the
table is relaxing the bound of a test this branch did not write, to get this branch green.

Stated precisely, because the boundary matters: I measured 3/3 locally on this head with the
full shard, and identity of the code with main. I did not measure the failure rate on CI,
which is where it happened and where my box cannot stand in.

### Mutation table

Each row reverts one guard and names the file that goes red. Every mutation is applied
and reverted mechanically, with the tree verified clean afterwards.

**The count is the table's own length, and it did not use to be.** An earlier revision
of this paragraph said "All 24" twice while the table already listed 25 — a number
written once and then never re-derived, in the one section whose whole purpose is
auditability. The last full harness run covered **every live row in one pass — M1–M36 less the
superseded M31: 35/35 reddened their target** — with the worktree verified clean
afterwards. M37–M41 were added in round seven, M42–M44 in round eight, M45–M48 in round nine, M49 in round ten, M50–M51 in round twelve, M52–M53 in round thirteen, M54–M56 in round fourteen, M57–M58 in round fifteen, M59–M60 in round seventeen, M61–M63 in round eighteen, M64–M65 in round nineteen, M66–M67 in round twenty, M68–M69 in round twenty-one, M70–M71 in round twenty-three, M72–M74 in round twenty-four, M75–M78 in round twenty-five, M79–M81 in round twenty-six, M82–M84 in round twenty-seven, M85–M86 in round twenty-eight, M87–M89 in round thirty and M90–M91 in round thirty-one, each verified
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
| M38 | ~~the whitespace refusal is removed from the matcher~~ — **superseded by M50**: round twelve DELETED `argvElementCarriesWhitespace` outright (whitespace in a structured argv is legitimate), so this patch applies to no code. M50 mutates the opposite way — restoring the refusal — and is the live check on the same behaviour | superseded |
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
| M52 | `abandonInFlightPasses` skips an already-abandoned pass again | `boot-adoption.test.ts` (1) |
| M53 | the evidence timer overwrites a `shutdown` cause | `boot-adoption.test.ts` (1) |
| M54 | the row claim does not consume the lock outcome | `boot-adoption.test.ts` (1) |
| M55 | the clear writes anyway on an unacquired lock | `boot-adoption.test.ts` (1) |
| M56 | the unacquired-lock branch CLOSES instead of releasing | `boot-adoption.test.ts` (1) |
| M57 | the pid write is unconditional again (guard outside the callback) | `boot-adoption.test.ts` (1) |
| M58 | a claim that throws closes the pane again | `boot-adoption.test.ts` (1) |
| M59 | the scan reports `none` whenever nothing strictly matched | `orphan-adoption.test.ts` + `boot-adoption.test.ts` (3) |
| M60 | the consumer clears the handle on an `unknown` scan | `orphan-adoption.test.ts` + `boot-adoption.test.ts` (2) |
| M61 | `withRegistry` ignores the caller's `skipSave` | `boot-adoption.test.ts` (2) |
| M62 | the pre-close gate does not consult the row | `boot-adoption.test.ts` (1) |
| M63 | the pre-close gate refuses on ANY row change (**over-strict**) | `boot-adoption.test.ts` (2) |
| M64 | `unreadable` folds back into `absent` | `boot-adoption.test.ts` (4) |
| M65 | `absent` is treated as `unreadable` (**system-breaking direction**) | `boot-adoption.test.ts` (2) |
| M66 | a dropped TARGET row reads as `absent` again | `boot-adoption.test.ts` (2) |
| M67 | ANY dropped row refuses, not just this key's (**over-strict**) | `boot-adoption.test.ts` (2) |
| M68 | the clear's ABSENT early return goes back above the acquisition check | `boot-adoption.test.ts` (1) |
| M69 | the clear's MOVED early return goes back above the acquisition check | `boot-adoption.test.ts` (1) |
| M70 | `lock-unacquired` maps back into the spawn-permitting case | `boot-adoption.test.ts` (4) |
| M71 | `absent` refuses too, so a cold boot never spawns (**system-breaking**) | `boot-adoption.test.ts` (5) |
| M72 | the shutdown latch is never set | `boot-adoption.test.ts` (1) |
| M73 | the latch is never cleared — a silent kill switch (**system-breaking**) | `boot-adoption.test.ts` (7) |
| M74 | the latch is set AFTER the settle snapshot instead of before | `boot-adoption.test.ts` (1) |
| M75 | the survival branch skips the detach | `boot-adoption.test.ts` + `gateway-shutdown-survival.test.ts` (2) |
| M76 | detach CLOSES the pane, as `kill` does (**silent REPL killer**) | `herdr-adoption.test.ts` (1) |
| M77 | the survival branch skips the sink unregister | `gateway-shutdown-survival.test.ts` (1) |
| M78 | detach stops the loop but keeps delivering an in-flight read | `herdr-adoption.test.ts` (1) |
| M79 | `detached` dropped from `send`'s EXECUTION-time check | `herdr-adoption.test.ts` (1) |
| M80 | ~~`detached` dropped from `send`'s QUEUE-time check~~ — **subsumed**: the execution-time check catches it, so this patch cannot red. The two overlap by design | subsumed |
| M81 | `release` does not detach the attached child | `boot-adoption.test.ts` (1) |
| M82 | the containment check is removed from `replSessionConfigPaths` | `session-config-containment.test.ts` (4) |
| M83 | the registry accepts any string as `channelName` again | `session-config-containment.test.ts` (8) |
| M84 | the pattern rejects a legitimate generated name (**over-strict — stops cleaning up credential files**) | `session-config-containment.test.ts` (2) |
| M85 | the filesystem check is removed from cleanup | `session-config-containment.test.ts` (1) |
| M86 | cleanup refuses real directories too (**over-strict — retains every credential file**) | `session-config-containment.test.ts` (1) |
| M87 | the unconditional `pool.delete` is restored | `boot-adoption.test.ts` (1) |
| M88 | the identity comparison is inverted, so nothing is ever deleted | `boot-adoption.test.ts` (1) |
| M89 | the rejected-promise arm is dropped | `boot-adoption.test.ts` (1) |
| M90 | the survival branch does not unregister the live-process handle | `gateway-shutdown-survival.test.ts` (1) |
| M91 | ~~`unwind` unregisters the live handle too~~ — **probe, not a guard**: nothing reds, because the handle is identity-scoped and a second `unregister()` is a no-op. Recorded because that is what makes the retained cell "not needed" rather than "must not" | no-op by design |

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
