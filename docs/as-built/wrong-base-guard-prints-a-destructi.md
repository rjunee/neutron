## 2026-09-01 — The wrong-base refusal keeps refusing; its remedy now rests on evidence

The launch-time wrong-base guard was right to refuse a branch that was never cut from
origin/<base>, and it still does — same refusal, same terminal failure, no fire. What changed is
the sentence that followed it. That sentence used to end with an unconditional force-delete of the
branch, composed from nothing: no worktree, no holder, no publication. Measured on 2026-08-31, it
pointed at a branch checked out in a LIVE locked worktree whose tip was already on origin — advice
that would have destroyed another lane's uncommitted work, and that git would have refused to
execute anyway because the branch was checked out elsewhere. It misdirected whichever way it was
read.

`trident/wrong-base-remedy.ts` now resolves three facts before composing anything: which worktree,
if any, holds the branch (`git worktree list --porcelain -z`, the NUL-delimited form, because a
worktree path may legally contain a newline and splits its own record in the other one — and
keeping the lock reason the reaper discards); whether the pid named in that lock is alive, dead, or unprovable (a per-pid probe
through the process filesystem — never a signal, never a name match); and whether origin already
carries the local tip. From those it emits one of four refusals, each naming its evidence: held by
a LIVE holder (stand down, worktree path and pid named, no delete offered); held by a DEAD holder
(unlock, then remove the stale worktree, and only then reconsider the branch); unheld with origin
ALREADY CARRYING every local commit — either the identical sha or an origin tip that descends from
it, both of which mean dropping the local ref loses nothing, so the delete is printed with both
shas as the reason it is safe; and unheld with commits origin does not carry (salvage first — a
per-run `trident-salvage/<run-id>` tag, which git creates only if that name is free so it cannot
overwrite an earlier receipt, then a push if the reading lane has push rights — never delete).
The salvage receipt is named WITHOUT its `refs/tags/` prefix on purpose: `delivery.ts` treats that
qualified token appearing in a failure_reason as proof a snapshot EXISTS and renders "Recovery
snapshot: <ref>." for it, so spelling it here would advertise a snapshot this module never took.

A fifth shape has its own arm: the holder is the repo's OWN shared checkout, which is what a run
that crashed between `merge.ts` checking the shared checkout onto the run branch and restoring the
base leaves behind. There is no other lane to wait for, so "stand down until that worktree releases
it" would name a release nobody can perform; the message says whose checkout it is and points at
`git switch -- <base>` once no merge is in flight — behind the preflight that shows what the switch
would take with it (see round 6).

The delete it prints is `git branch -D`, deliberately, and never a low-level ref delete. This
message is composed at refusal time and read minutes to hours later, so a lane may take the branch
in between; `branch -D` re-checks holders AS IT RUNS and refuses with "cannot delete branch ...
used by worktree at ...", while `update-ref -d` deletes the ref regardless and leaves that lane on
a dangling HEAD — the incident above, reintroduced by its own remedy. The message names that
refusal as a stand-down signal rather than something to route around.

The same gap in time is why the delete is BOUND to the sha its evidence was gathered from. Holder
re-checking says nothing about a commit pushed onto an unheld branch after composition: measured,
an unconditional `branch -D` dropped such a tip and left it in no reflog. What is printed is
`test "$(git … rev-parse --verify refs/heads/<branch>)" = <tip> && git … branch -D -- <branch>`,
and a real-git test runs the printed string on both sides of that race: refused after the ref has
moved, and (positive control) deleting when the ref is still where the evidence found it. What that
chain does NOT give is a branch that moved in the gap between the test and the delete: `&&` is
compare-THEN-delete, not compare-and-swap, and a commit landing in that one-command window is
deleted with the branch. No git command both compare-and-swaps a ref and refuses a checked-out
branch, so the window is not closable here — the printed message NAMES it and names what bounds it
(one command wide, and `branch -D` still refuses a branch a lane has taken). An earlier draft of
this document claimed the opposite, that "a branch that moved survives the remedy"; the code's own
comment called that claim false, and a document asserting a safety property the code disclaims is
the defect this whole card exists to remove.

The DEAD arm no longer advertises a safety property `git worktree remove` does not have. Non-force
remove refuses tracked modifications and untracked non-ignored files, and DELETES ignored
local-only files (build output, .env, logs) without a word — measured against real git in the
suite. So the message discloses that and prints the preflight that shows them,
`git -C <worktree> status --porcelain --ignored`, before the unlock/remove pair — literally before,
in printed order, since round 6.

Three reads that used to look like answers are now UNKNOWN. The worktree listing is read
`--porcelain -z`, because a worktree path may legally contain a newline and the blank-line record
separator lets such a path split its own record — the branch would read as unheld and the safe
delete would be printed for a branch a live lane is standing on. Both /proc probes carry a
self-probe control: a directory that exists but is not procfs answers ENOENT for every pid, which
would have read every live lane as DEAD and every tree as clear, so this process's own entry must
be visible before either probe will answer at all — and the occupancy probe never cites its own
pid as the holder. A pid whose /proc entry exists but cannot be READ (EACCES under hidepid, or
another uid) makes occupancy UNKNOWN rather than clear — silently skipping it was how a tree with
an occupant in it answered "clear" and lifted the DEAD arm's veto onto `worktree remove`; only
ENOENT proves a pid stands nowhere. Conversely, occupancy no longer claims a pid standing in a
NESTED checkout is standing in the parent (on this box worktrees live inside the repo), because
naming an unrelated lane's pid as the holder is false evidence in the module whose subject is true
evidence. A `merge-base --is-ancestor` that exits anything other than 0 or 1 is an error, not a
proof of divergence, and a fetch that fails with no stderr at all reports its exit code rather than
the empty "()" this module was built to stop printing.

Every other shape is UNKNOWN and prints no destructive command at all: enumeration failed, the
lock names no pid, the liveness probe could not conclude, or origin could not be read. UNKNOWN
does not authorise an irreversible act. The guard REPORTS: it terminates no process, unlocks no
worktree, removes nothing, and cannot throw into the launch path that calls it.

### Round 5 — the veto that was not vetoing, and two premises that go stale

The occupancy veto was inert in the layout this repo actually runs. The composer hands the probe
every OTHER checkout git knows about so a pid standing in a nested lane worktree is not counted as
standing in the parent — but on this box lane worktrees live at `<repo>/.claude/worktrees/<wt>`,
which makes the shared checkout an ANCESTOR of the tree being probed. The exclusion matched every
pid inside the held tree against the repo first, skipped it, and answered `clear` for an occupied
tree, which is precisely the answer that lifts the DEAD arm's veto and reaches `worktree unlock` /
`worktree remove`. Only a checkout STRICTLY INSIDE the probed tree can take a pid away from it now;
a path that contains the tree says nothing about it. Two tests pin it: the probe with an ancestor
in its list still names the occupant, and a compose-level case runs the REAL probe through the
composer's own derivation on the real `<repo>/.claude/worktrees/wf_a` layout — every other
compose-level case injects the probe, so none of them could have caught a derivation that hands
the probe a path swallowing the worktree.

An EMPTY successful worktree listing is now UNKNOWN. Real git always lists the repo's own checkout
first, so zero records means the enumeration told us nothing — reading that silence as "nobody
holds the branch" walks into the publication comparison and can end at `branch -D`. The
orchestrator's positive control used to rest on exactly that impossible listing and now spells a
real one.

The safe delete re-establishes BOTH of its perishable premises at the moment it runs. The evidence
that origin carries the local tip is as stale as the local ref: a force-push after composition
leaves the commits published nowhere, and a chain that only re-checks the local ref deletes them
anyway. What is printed is now fetch, then a compare against the evidenced sha, then an ancestry
check against the refreshed tracking ref, then a create-only `trident-salvage/<run-id>` tag on the
evidenced commit, then `branch -D -- <branch>` — chained on `&&`, with a real-git test that
force-pushes origin after composition and observes the printed string refuse.

TWO residual windows, and the second one was previously CLAIMED AWAY. This document used to say
each link "stops the delete when its premise has rotted", and that the only thing `&&` cannot close
is the ref moving between the compare and the delete. That is false for the ORIGIN premise: the
ancestry link reads `refs/remotes/origin/<branch>`, a tracking ref refreshed only by the chain's
OWN first command, so a force-push landing between that fetch and the delete is seen by no link
that follows — the compare passes, the ancestry passes against a stale ref, and commits that are by
then published nowhere are deleted. A real-git test now runs the printed chain LINK BY LINK with
the force-push landing after its fetch, and observes exactly that. Neither window is closable here
(no git command both compare-and-swaps a ref and refuses a checked-out branch, and nothing makes a
local ref delete conditional on a remote), so both are DISCLOSED in the printed message — and the
origin one is also ANSWERED rather than merely named: the chain snapshots the evidenced commit into
the salvage namespace immediately before deleting, so a race it cannot prevent leaves the work
reachable by a receipt instead of by nothing. The tag is create-only, so an existing receipt of the
same name stops the chain short of the delete, and the message says so. `branch -D`'s holder
re-check remains the property worth keeping for the local side.

Two things the refusal says are now things somebody will actually do. `worktree-reaper.ts` skips
LOCKED worktrees by design, so "do not re-dispatch until that worktree releases it" named, for a
holder only TREATED as live (unreadable /proc, a lock naming no pid), a release nothing in this
system will ever perform. Those arms now print a read-only settle instead — status of the tree and
the lock as git reports it — and say why: nothing releases a locked worktree automatically. The
arm that proves the holder ALIVE keeps the wait, because that lane does release its own tree. And
`delivery.ts` classifies the refusal as its own `branch-held` class: it used to fall through every
keyword branch to the fallback, which drops any reason over 200 characters and answers "Reply to
retry the build" — the exact opposite of the refusal being delivered.

Finally the scrubber knows more than one vendor. It redacted GitHub token prefixes only, so a
`glpat-…` in fetch stderr was persisted verbatim into the refusal; it now redacts by SHAPE
(prefixed credentials keep their prefix, which names which credential leaked, and unprefixed
high-entropy tokens go entirely), while 40-hex object names stay readable because a sha is the
evidence this module exists to name and is not a secret.

### Round 6 — the remaining premises nobody had established

Four printed claims still rested on properties this guard had not measured, and one printed
procedure had its steps in an order that opened the hazard it was warning about.

The SHARED-CHECKOUT arm said the guard "did not measure whether that checkout is clean, and it does
not need to — checkout REFUSES rather than overwriting a modified file". The clause is true and the
conclusion is not. Reproduced on git 2.43: a file gitignored and untracked on the wrong-base branch
but TRACKED on the base is replaced with the base's content, exit 0, no refusal and no output. That
is the same ignored-file blind spot the DEAD arm already discloses for `worktree remove`, and it is
the "advice trusted for a property nobody established" class the whole card is about. The arm now
prints `git -C <repo> status --porcelain --ignored` FIRST, says exactly what the switch refuses and
what it silently replaces, and only then prints `git -C <repo> switch -- <base>`.

The DEAD arm's procedure printed unlock, then remove, then "run BOTH preflights immediately before
the remove". Neither preflight needs the lock off, and the unlock has a cost of its own:
`worktree-reaper.ts:221-227` sweeps `wf_*` trees that are NOT locked, and its dirt check
deliberately excludes ignored files, so between an operator's unlock and their preflight a
background sweep can remove the tree and everything ignored in it. The preflights are printed
first now, the unlock/remove pair follows, and the exposure the unlock opens is named — but only
for a tree the reaper would actually sweep. That same `wf_*` test gates the UNLOCKED
treat-as-live arm's "this may clear without you": a hand-made unlocked worktree is never swept, so
it is told, correctly, that nothing releases it on its own.

The TOTAL evidence budget is enforced by the composer rather than delegated. `TOTAL_BUDGET_MS`
(30s) bounds one whole composition because the unheld path runs up to five host commands in
sequence on the launch tick. The clamp used to floor each per-call budget at 1ms and spawn anyway,
which made "an exhausted budget degrades to UNKNOWN" a property of the RUNNER — true for the
shipped `spawnCapture`, which kills the child at whatever timeout it is handed, and false for any
injected `run_host` that ignores `timeoutMs`, under which the composition ran to a successful
answer and reached `branch -D` on a budget that was already gone. A spent budget now returns the
killed-child shape WITHOUT spawning, so every existing UNKNOWN path answers, and the evidence says
the budget was spent rather than blaming a watchdog that never ran. A test drives it with a host
that ignores its timeout entirely.

Three smaller things the messages claimed and had not established. The LIVE arm said "another lane
owns this branch": the args carry the refusing run's id but not its own worktree path, and this
card's own second measured instance (run ef81d378, PR #497) was held by this card's OWN relocked
tree — so it now names a live holder and says whose lane it is was not established. The
`branch-held` delivery said "the single write it makes is refreshing this branch's own origin
tracking ref": the fetch has no `--no-write-fetch-head`, so it rewrites FETCH_HEAD and writes
whatever objects it downloads too, and a delivery that undercounts its own writes is the
overclaiming this refusal exists to stop. And the printed pushes spell `refs/heads/<branch>`, the
same argument that put `--` in the printed delete applied to the one command `--` does not fully
disambiguate: `git check-ref-format refs/heads/--mirror` exits 0, so a legal branch name rendered
`git push origin --mirror` in text a reader is told to RUN.

The scrubber's passes are ordered by what they COST, and its input bound sits between them. The
token rules are `\b`-anchored and quadratic in the length of ONE token — measured with these exact
regexes, 8k costs 87ms, 64k costs 5.1s, and 1MB does not finish — and it runs synchronously while
composing, outside the evidence budget, so they only ever see the last 2000 characters. The URL
rules are LINEAR and run BEFORE that slice, which is a fix rather than a rearrangement: slicing
first cut the `https://` off a long credentialed URL, so neither URL rule matched what remained,
punctuation in the password defeated the `\b` token rules, and the TAIL OF THE CREDENTIAL was
written into a persisted, re-read refusal. The claim that replaced — "anything a credential could
hide in is still whole inside the last 2000 characters" — is false for any credential longer than
the bound. The linear passes are still bounded, by a 64k scan cap. The output bound MARKS its
truncation: the result is interpolated as a verbatim-looking quotation, and a lock reason over the
bound silently lost its head — the `claude agent wf_x (pid N` prefix a reader needs to tell an
original owner from a recycled pid.

Attacker-shaped evidence cannot draw a line of the guard's own message. A forged lock reason, a
hostile remote's fetch stderr and a worktree PATH are all interpolated into a one-sentence refusal
that an agent reads as the guard's voice, and three shapes turn that into forgery: line breaks and
other control characters (C0, DEL, U+2028/9 and the bidi overrides, folded to one space); the
double quote, which CLOSES the `its lock reads "…"` quotation early so everything after it reads
as the guard's own prose (folded to an apostrophe); and the destructive commands this class of
message forbids, which a path or a lock reason could otherwise spell verbatim inside a live-holder
refusal whose whole contract is that `branch -D` appears nowhere in it. Paths go through that fold
in the PROSE and through `sh()` in the COMMANDS — and `sh()` now ANSI-C-quotes a control character
rather than carrying it through single quotes, because `'a<newline>b'` is a correct quoting that
still puts a literal newline into text an agent executes.

A worktree listing that is not the NUL-delimited form, or that is not WHOLE, is UNKNOWN.
`parseHolders` splits on NUL only, so a newline-delimited answer parses as ONE branchless record —
non-empty, so the empty-listing guard passes it — and the branch then reads as UNHELD, which is
the walk to `branch -D` on a tree a lane is standing in. The absence of a NUL is decisive about the
FORM; the absence of the record terminator is decisive about TRUNCATION, and both are needed: a
stream cut mid-record still carries the NULs of every complete record before the cut, so a holder
whose `branch` attribute fell past the cut parsed with branch:null and was missed. Every complete
`-z` listing ends `\0\0` (measured on git 2.43).

A REBASE holds a branch without appearing to. `git worktree list --porcelain` reports a worktree
mid-rebase as DETACHED — no `branch` attribute at all — so the branch reads as unheld and the
composer walked to the publication comparison and its delete. The delete fails closed (git refuses
a branch a rebase holds), but the sentence in front of it asserted "found no worktree holding the
branch", which is false, and this module exists because a remedy resting on a fact nobody
established is worse than no remedy. Detached entries are now resolved through the worktree's own
`.git` file to its administrative directory and its `rebase-merge`/`rebase-apply` head-name — read
rather than guessed from the basename — and a detached tree whose rebase state cannot be READ is
UNKNOWN rather than unheld. Falsified against real git, including that git really does omit the
attribute.

A ZOMBIE holder is a fourth liveness answer. A defunct process still owns its pid, so every
existence-based probe answered ALIVE — and the ALIVE arm is the only one with no by-hand settle,
because a live lane releases its own tree when it finishes. A zombie finishes nothing, so that arm
waited forever on a release nobody would perform; it is not DEAD either (the pid is taken, and the
tree may still hold the exited process's children), so it authorises nothing destructive. The
probe reads the state field of `/proc/<pid>/stat` after the last `)`, since `comm` may contain
spaces and parentheses.

The evidence budget is enforced on commands already IN FLIGHT. Pricing each command at spawn time
left the guarantee with the runner for every command that WAS started — the same
dependency's-goodwill argument the module rejects, one step further in — so each call is now raced
against what remains of the total. The loser is abandoned, never killed: this module signals
nothing.

The `branch-held` delivery is discriminated by the composer's WHOLE PREFIX, anchored at position
0, and it names the writes of the ARM THAT FIRED. An unanchored `includes()` over a free-form
failure reason matched the phrase wherever it appeared, and `orchestrator.ts` interpolates raw
workflow error text into failure reasons — so an error that merely echoed a previous refusal was
delivered as a launch refusal and a real launch failure lost its retry advice. And the fetch
sentence was attached to every branch-held delivery although the HELD arms make no network call at
all, reporting a write that never happened in the one message whose subject is not claiming things
nobody established. Which arm fired is read from the evidence sentence the composer places
immediately after that prefix, so a quoted lock reason further along cannot forge it.

The publication fetch pins `GIT_TERMINAL_PROMPT=0` beside its `LC_ALL`/`LANGUAGE=C`, for the
reason every other network git call in this repo sets it (`trident/codex-build.sh`,
`worktree-cleanup.sh`): it is the only child here that touches a remote, it runs on the launch
tick, and a remote that asks for credentials would otherwise block on a terminal nobody is
watching until the watchdog kills it — spending the whole evidence budget to reach the same
UNKNOWN a refusal reaches immediately.

One disclosed limit is now stated at its true strength rather than softened. The occupancy probe
vetoes 'clear' if ANY /proc entry on the box is unreadable, and that veto is global rather than
per-tree: measured on this host as an ordinary uid, ~360 of ~445 entries are unreadable (281 of
them root-owned). So off euid 0 the DEAD arm is not "close to unreachable", it is deterministically
unreachable, and every dead holder degrades to the treat-as-live UNKNOWN stand-down. It is not
fixable without giving up the veto — a process whose cwd cannot be read may be standing in the
tree, and 'clear' is the answer that reaches `worktree remove` — so the degradation stays, in the
safe direction, and the code comment now says exactly that instead of understating a certainty.

A REBASE was not the only operation git hides the branch behind. `git bisect` detaches HEAD the
same way and records the branch it left in `BISECT_START`, so a tree mid-bisect held the branch
while the guard reported that nobody did — the unheld arm's false evidence sentence in front of a
delete git itself then refuses ("cannot delete branch 'feat' used by worktree at ...", measured on
git 2.43 in a scratch repo, together with the `detached`-and-no-`branch`-attribute listing). The
detached-worktree probe now reads both states, names WHICH one it found, and gives the remedy that
works in the tree it found: `git bisect reset`, never `rebase --abort`, which exits 1 there. A
`BISECT_START` holding a 40-hex object name is a bisect begun from an already-detached HEAD and
holds no branch, so it is not reported as one. Both arms are covered by real-git tests.

That arm also stopped asserting a lock it never established. It called the stand-down composer
without a release kind, so the default fired — "nothing releases a LOCKED worktree automatically
(the reaper skips locked trees)" — over trees git reports UNLOCKED, including the reapable `wf_*`
shape `worktree-reaper.ts:221-227` does sweep. The release kind is now derived once, from the
reaper's own filter, and every treat-as-live arm reads it from there.

The evidence scrubber neutralises the delete VERBS, not one spelling of them. It replaced the
literal `-D`/`-d` only, so a forged lock reason carrying `branch --delete --force`,
`update-ref --delete`, `push origin :branch` or `worktree remove --force` rendered verbatim inside
the live-holder refusal whose whole contract is that no such instruction appears in it — the same
irreversible acts in git's long spelling. Every rule stays linear (at most one bounded token of
lookahead), because this composes on the launch tick. The guard's OWN remedies are prose, never
evidence, so the DEAD arm still prints a runnable `worktree remove`; a positive control pins that.

The `branch-held` classifier's anchor no longer rests on a premise git does not share. It spelled
the name fields `\S+` on the ground that "branch and base names cannot contain spaces". What git
forbids is the ASCII space; `git check-ref-format --branch` accepts U+00A0, and JavaScript's `\s`
includes it — so a legal branch name carrying Unicode whitespace missed the anchor and fell
through to the classifiers that key on substrings like `stalled`, where it was answered with
"Reply to retry the build", the one advice this class exists to forbid. The fields now exclude
exactly what git excludes, which keeps the property the anchor was bought for (a negative control
pins that a name containing a real space is still not this refusal).

Two more sentences stopped saying more than was measured. The write disclosure treated the
rebase/bisect-holder arm as an unheld one — its evidence opens "found no worktree with <branch>
CHECKED OUT" — and reported a fetch that arm returns before making, the exact overcounting the
conditional exists to prevent; the discriminator is now the fetching arms' whole opening phrase.
And the reassurance itself dropped "— the guard only READ state", which contradicted the very next
sentence on the fetching arm (a fetch writes a tracking ref, FETCH_HEAD and objects): what is owed
unconditionally is that nothing destructive moved, and whether the arm only read is now said by
the per-arm sentence that knows. The `branch-held` summary likewise stopped re-asserting "another
lane's commits", an attribution the composer beneath it deliberately retracted.

The OUTER guard now reads `merge-base --is-ancestor` the way the inner one already did. That probe
answers with three exits — 0 yes, 1 no, anything else an error (128 on a corrupt or missing object,
a watchdog kill, a spawn that failed) — and `orchestrator.ts` consulted only `.ok`, so a probe that
established NOTHING flowed into the same composed refusal as git's meaningful "no" and asserted, in
the guard's own voice, that the branch "already carries N commit(s) not on origin/<base> — it was
not cut from origin/<base>". That is positive divergence evidence derived from a non-answer, in the
one message class this change exists to make evidence-honest, and the composer's own publication
probe had already been fixed for exactly it. Both outer probes — containment in the base, and
descent from this run's PRIOR base, the one that decides whether the branch is this run's own crash
leftover rather than somebody else's work — now distinguish the three answers. UNKNOWN still
refuses (fail-closed: the build is not started) but refuses as what it is, spending no evidence
budget on a composer it never reaches and naming no destructive act, per invariant 122.

The evidence scrubber also learned that git's short options COMBINE. The rule required a word
boundary immediately after the `D`/`d`, which `branch -Dr`, `branch -fd` and `branch -dr` — all real
deletes on git 2.43 — do not have, so each rendered verbatim inside the live-holder refusal, and
`-Dr` put the literal `branch -D` back into the arm whose pinned contract is that the string appears
nowhere in it. The option is matched as a cluster carrying a `d`/`D` anywhere in it, with one
optional preceding option token (`branch -f -d`), and the rule stays linear — 200k of adversarial
input costs 2ms. Positive controls pin that `-a`, `-vv`, `-l` and `-m` are still quoted readably.

The composer→classifier seam is now enforced by the seam itself. `delivery.ts` recognises this
refusal by a frozen copy of the composer's prefix and picks its write attribution from frozen copies
of each arm's opening, and every test on both sides used hand-written reason strings — so the two
halves were pinned only to each other's transcription and a wording change could reroute the
classifier with both suites green. A table now runs the REAL composer over all twelve reachable arms
and feeds its ACTUAL output through `interpretFailure`, asserting the class, the arm-appropriate
write attribution, and that no arm reaches the retry advice this class forbids.

Two write disclosures stopped being wrong by omission. The fetch also APPENDS the tracking ref's
reflog (`.git/logs/refs/remotes/origin/<b>`, reproduced in a scratch repo), so "the tracking ref,
FETCH_HEAD and the objects, and nothing else" was an undercount — the defect that sentence exists to
avoid. And the catch-all "remedy resolution threw" arm fell through to "refused before it could
establish the holder, which is upstream of the one write it can make": the composer's outer catch
wraps the composition AFTER the fetch too, so that sentence asserted a fetch had not happened in
cases where one already had. Which side of the fetch it threw on is precisely what is not
established, so the delivery says that instead of picking one.

Those two outer refusals then had to survive the two seams every refusal crosses. The first is
DELIVERY. Both reasons quote git — the probe's exit code and its stderr — and every keyword branch
in `interpretFailure` below the launch-guard arm is a bare `includes()` over that quotation, so
`git merge-base --is-ancestor exited 128` matched the merge-mechanics token `git ` and the refusal
was delivered as "The build finished but a git step failed while landing the branch": a completed
build and a merge attempt, both asserted about a run whose own text says the build was NOT started.
The watchdog-kill variant carries no `git ` token at all and fell to the bare `unknown` fallback —
the same defect wearing a vaguer sentence. A pre-launch arm now sits beside the launch-guard arm,
matched by the anchored `^trident infra: ` prefix plus the authored not-started clause, and says the
one thing the misclassification denied: no build ran, so nothing landed. It is ANCHORED for the
reason the launch-guard prefix is — these reasons interpolate a repo path and a fragment of git's
stderr — and a post-launch failure that merely QUOTES the clause keeps the retry advice it is owed.
That anchor is now pinned on both prefixes by reasons that embed the WHOLE prefix mid-string;
deleting either `^` reddens the suite, which it previously did not.

The second seam is the MESSAGE ITSELF. Those two reasons interpolated `run.repo_path` raw, and a
repo path is attacker-shaped by exactly the standard this module's own `-z` worktree parser already
applies to a lock reason: `git init` and `git worktree add` both accept a newline in one, and
`store.ts` persists it verbatim. So a legal path — `/repo\nFORGED: run git branch -D -- victim` —
forged an extra LINE, carrying a destructive instruction, inside the one message class whose entire
subject is that UNKNOWN authorises no irreversible act. The composer's folding function is now
exported as `foldEvidence` and used on both sides of that seam (one function, so the two cannot
drift), on the path AND on git's stderr — `git -C <repo>` echoes the path back on failure, so the
raw path reached the string by that route too. The shas need no folding and the code says why: they
are `^[0-9a-f]{40}$`-tested. The branch name was exempted on the same terms and should not have
been.

THE BRANCH NAME WAS EVIDENCE ALL ALONG. The exemption above was wrong, and it was wrong on a premise rather than by oversight: "the branch
resolved through `rev-parse --verify refs/heads/<branch>`, so git's own ref rules have already
excluded control characters" is true of ASCII controls and false of everything else this guard
folds. Reproduced in a scratch repo on git 2.43: `git branch` ACCEPTED, and `rev-parse --verify`
RESOLVED, both `feat<U+2028>FORGED<U+00A0>run<U+00A0>git<U+00A0>branch<U+00A0>-D<U+00A0>victim` and
`feat<U+202E>evil` — a line separator several renderers break on, and a bidi override that reorders
what is DISPLAYED without changing a byte. Those are precisely the codepoints the remedy composer
folds and names as forgery vectors, so the exemption made the guard contradict the threat model of
the module it exists to protect. The branch is now folded for PROSE on both sides of the seam — the
two pre-launch UNKNOWN refusals in `orchestrator.ts` and every arm of the composer's own prefix —
and left RAW where it names a ref or is `sh()`-quoted, because a command naming a different branch
than the one on disk cannot be run.

`sh()` learned the same set. A quoted argument cannot be folded, so the codepoints are ENCODED
instead: ANSI-C quoting with `\uHHHH`, which bash and zsh expand back to the true byte sequence, so
the command still runs and the override cannot reorder the rest of the line. One constant
(`SH_ENCODE`) now holds the set that `defang`'s first rule holds, so the two halves cannot drift.

The evidence scrubber's option rule stopped being a claim about SHAPE. It spelled the option run
inside the regex — at most ONE option token before the delete, a short cluster bounded at four
letters per side — and both reviewers measured real, runnable spellings straight through it:
`branch -v -q -D feat`, `branch -Dvvvvv feat`, `branch -vvvvvD feat`, `push -f origin :feat`,
`push --force origin :feat`, `push origin -d feat` and `push -d origin feat` (`-d` is a real `push`
delete per `git push -h`; only `--delete` and `--mirror` were neutralised there). The verb's
arguments are now read as a bounded window of whitespace-delimited TOKENS and each token tested on
its own, so option order, count and clustering stop mattering instead of each spelling being
patched. The docblock's "every option ORDER collapses to one replacement" was stronger than the
code; it is now true of the code. Still linear — four tokens of window, no nesting, both-end-anchored
option tests, 2ms at 200k of adversarial input — and the positive controls pin that `-v -q --list`,
`-vvvvv`, `push --force` and `push origin HEAD:refs/heads/<b>` stay quoted readably.

The rule remains GIT-VERB-SCOPED, and the docblock now says so rather than implying coverage it does
not have: `rm -rf <path>` and `git reflog expire --expire=now --all && git gc --prune=now` in forged
evidence render verbatim. What the arms' contracts forbid is the guard appearing to instruct a REF
DELETE, and arranging any of this needs local `git worktree lock --reason` write access.

`git bisect reset` stopped being prescribed as bookkeeping. The rebase/bisect arm printed it with no
caveat — "returns the branch to that worktree" — while the DEAD-holder arm in the same module
discloses the identical data-loss class for `worktree remove` and the shared-checkout arm prints a
preflight for it. Reproduced on git 2.43: mid-bisect, `git status --porcelain --ignored` showed
`!! local.env` holding local-only content; `git bisect reset` exited 0, restored the starting branch
and silently replaced that file with the branch's tracked copy. Both spellings now disclose that the
operation is a CHECKOUT, name the `--ignored` read this arm already prints as the preflight, and say
the file is moved aside BEFORE the reset or abort — after it there is nothing left to move.

The two pre-launch UNKNOWN refusals stopped claiming they wrote nothing. "No branch, worktree,
commit or file was changed or deleted" is true and is the reassurance actually owed, but on a fresh
PR build the same path has already run `git fetch --no-tags origin <base>`, which force-updates that
tracking ref, appends its reflog, rewrites FETCH_HEAD and writes whatever objects it downloaded —
the exact set `delivery.ts` names for the composer's own fetch while calling an undercount "the
overclaiming this refusal exists to stop". The sentence is now conditional on whether the fetch ran,
because OVERcounting is the same defect in the other direction, and a run resuming from a pinned
base is pinned by a positive control that no fetch is named.

Two disclosures were added rather than fixed, because they are boundaries and not defects. A
worktree PATH containing the banned literal still reaches the treat-as-live settle commands inside
`sh()` quoting — that is inert (a single-quoted argument to a read-only command) and it is what
keeps the settle runnable, and a test now pins that every surviving occurrence sits inside quotes,
with a positive control that the helper can see the safe arm's own unquoted delete. And the
DEAD-holder arm remains deterministically UNREACHABLE in production at non-root euid: hundreds of
`/proc/<pid>/cwd` links are unreadable to this uid, the occupancy probe's veto is global rather than
per-tree, so operators always get the treat-as-live UNKNOWN text and only the injected-probe fixtures
reach the unlock/remove arm. The degradation is in the safe direction (UNKNOWN authorises nothing,
invariant 122) and the code states it precisely — but the card's requirement 2 is, in production,
FIXTURE-ONLY behaviour, and that belongs here and not only in a code comment.

One reachable behaviour change is worth naming plainly: an ERRORING ancestry probe now fails the run
terminally BEFORE the own-crash-leftover rescue that previously let it launch. Previously any
non-zero exit fell through to the prior-base descent check, and a successful descent launched; now
UNKNOWN returns first. Fail-closed, retryable (`delivery.ts` classes it `infra`), and consistent
with invariant 122 — but it is a real change in when a run launches, not only in what a message says.

The round after that one shipped its commit MESSAGE over the PRE-round CODE. A replay reverted the
whole change: for `wrong-base-remedy.ts`, `wrong-base-remedy.test.ts`, `orchestrator.ts` and
`orchestrator.test.ts` the published tree was byte-identical to the commit BEFORE the round, nine
tests were gone, and the real work sat in a commit reachable from no ref — while the message on the
published head asserted the token-window defang, the branch-name folding, the bisect disclosure and
the fetch write-accounting as done. That is precisely the defect class this card exists to remove: a
message claiming a property its tree does not have. It was repaired by recovering the dropped commit
VERBATIM (`git diff <pre-round> <dropped>`, which applied clean) rather than by re-deriving it, so
what the message claims and what the tree contains are the same artifact again.

WRITE ATTRIBUTION IS SCOPED TO THE LAYER THAT MADE THE WRITE. The delivery's held arms said the
guard "made no network call at all" — true of the guard, and read by an owner as true of the
refusal. It is not: a fresh PR launch fetches origin's BASE ref before the composer is ever called,
which moves origin's base pointer and rewrites git's own bookkeeping. The per-arm sentence now says
"the guard itself", and one shared sentence attributes the launcher's base refresh to the launcher.
It is deliberately NOT enumerated there: `delivery.ts` reads a reason STRING and cannot know whether
that arm ran, and naming a write that may not have happened is exactly the overcounting the per-arm
conditional exists to prevent — the launch path counts its own writes, exactly, at its own site.

Both enumerations also stopped closing themselves with "and nothing else", which a config falsifies:
`fetch.writeCommitGraph` writes `.git/objects/info/commit-graphs/*` and `gc.auto` can fire
maintenance, neither of them in the four items named. They are bounded by the CLASS instead —
everything a one-ref fetch can touch lives under `.git` — and the reassurance itself now scopes
"file" to the TREE, so it no longer says no file changed one clause before naming FETCH_HEAD, which
is a file, as one of the writes.

Two smaller honesty items. A lock reason whose digits are not canonical decimal (`pid 0000123`)
probed 123 and printed `0000123`, so the arm named a pid it had not measured; it now names both
whenever they disagree, with the ordinary-decimal case — every lock this repo's own writer takes —
rendering exactly as before. And `TOTAL_BUDGET_MS`'s docblock now states what it prices: SPAWNED
commands. `probeTreeOccupancy` reads /proc synchronously without passing through the budgeted
runner, and is bounded by different facts (a kernel pseudo-filesystem, one shallow pass, every
failing read swallowed rather than retried) — a budget that reads as covering everything while
pricing only the spawns is the same overclaiming in miniature.

### A NAME FIELD IS FOLDED AS A NAME, NOT AS FREE PROSE

The fold that was supposed to close the forged-line hole reopened it one layer down. `foldEvidence`
replaces every forgery codepoint — the C0 controls, U+2028/U+2029, the bidi overrides — with an
ASCII SPACE. That is right for a path or a fragment of git's stderr, which are free prose. It is
wrong for the two NAME fields the refusal quotes, because the ASCII space is the one character
git's ref rules forbid, and it is exactly what `delivery.ts` anchors its wrong-base classifier on:
`WRONG_BASE_PREFIX` spells the branch and base fields `[^ \n]+` on that ground. Measured on git
2.43: `check-ref-format --branch` exits 0 for a name holding U+2028 and 128 for one holding a
space. So a git-legal branch name folded to a name with a space in it, the anchor missed, and the
refusal fell through to the substring classifiers that answer "Reply to retry the build" — the one
advice this class exists to forbid, restored by nothing more than somebody's choice of name.

`foldRefName` folds a name to ONE TOKEN instead: every whitespace and every forgery codepoint
becomes `?`, a character git's ref rules also forbid, BEFORE `foldEvidence` runs. That is also what
neutralises a payload inside a name — `branch -D -- victim` arrives as `branch?-D?--?victim`, which
is not a command anybody can run and not a string any classifier reads — and it removes the way
`defang` could put a space back by rewriting a verb it recognised. The branch and the base both go
through it, in the composer and in the launcher's own pre-launch refusals; paths and stderr keep
`foldEvidence`, which is still the right fold for prose. The seam is pinned where it broke: the
composer's real output, over four git-legal hostile names, through the real `interpretFailure`.

Three of `unknownHolder`'s six call sites passed the RAW branch where the parameter's own docblock
required the folded one — the enumeration-failed arm, the not-NUL-listing arm and the outer catch.
The arms with the least evidence were carrying the most dangerous text: a legal name rendered its
own line break and a verbatim `branch -D -- victim` inside refusals contracted to authorise
nothing. All six now pass the folded name, and the rule is written where the parameter is declared,
because the type system cannot tell two strings apart.

### THE BASE FETCH NOW WRITES THE REF ITS OWN REFUSAL SAYS IT WROTE

The launcher fetched its base with `git fetch --no-tags origin <base>` and then rev-parsed
`refs/remotes/origin/<base>` for the sha it pins the build to. Reproduced on git 2.43 in a scratch
clone: with a narrowed `remote.origin.fetch`, that shorthand exits 0, moves FETCH_HEAD, and leaves
the tracking ref exactly where it was. The build would then have been cut from a STALE base — the
one thing the surrounding retry exists to prevent — while the UNKNOWN refusal downstream stated as
fact that the fetch had written that ref. Naming the destination (`+refs/heads/<base>:refs/remotes/
origin/<base>`) makes both true; `wrong-base-remedy.ts` already fetches its own branch that way,
for this reason. The refusal quotes the argv that actually ran, refspec included.

### THE OPTION RUN IS NOT FOUR TOKENS LONG EITHER

`defang`'s window read at most four tokens after a git verb, so an option run longer than that put
the delete out of range: `git branch --verbose --quiet --color --no-column --delete --force
victim2` — a real delete on git 2.43 — rendered VERBATIM out of a forged lock reason into the
live-holder arm, whose pinned contract is that it carries no such instruction. Git's own grammar is
options-then-ref, so the window is now that: an unbounded run of leading `-`-prefixed tokens (which
cannot swallow the prose after the command) plus four tokens after it. Still linear, still one test
per token, and the benign controls still render unchanged.

### STILL DISCLOSED, STILL NOT FIXED HERE

The DEAD-holder arm remains reachable in production only when the occupancy probe can conclude:
`probeTreeOccupancy`'s unknown-veto fires first and answers "occupancy is UNKNOWN — treat it as
live". That is the fail-safe direction and it is disclosed at the arm, so it is left alone
deliberately; reversing the order would let an unreadable process table authorise a removal.

### THE FOLD NOW SITS ABOVE THE FIRST REFUSAL, NOT ABOVE THE THIRD

The same seam as the round above, one function earlier. `repoProse` was declared INSIDE the
ancestry block, so the two refusals composed BEFORE it — the base fetch failing, and its tip not
resolving — interpolated `repo_path` raw and passed git's stderr through `redactPushError` alone.
That function redacts credentials and bounds the length; it folds neither a newline nor a delete
command, and it was never meant to. Both messages are persisted, re-read, and routed by
`delivery.ts` through the identical `trident infra: … the build was NOT started` classifier as the
ancestry ones, so a legal repo path (`git init` and `git worktree add` both accept a newline in
one; store.ts persists it verbatim) or a hostile fetch stderr could forge a line carrying
`git branch -D -- victim` inside the class of message whose entire subject is that UNKNOWN
authorises nothing. Reviewers reproduced it from both sources independently.

`repoProse` and a shared `gitDetail` (redact first, then fold) are now declared above every path
in the launcher that can refuse, and the ancestry arms use the same two bindings rather than their
own copies — one fold on both sides of the seam, because two would drift, which is exactly how
this arrived a round late. Both boundaries are now pinned by a test that makes the path AND the
stderr hostile at once and asserts the composed reason is one line, carries no `branch -D`, shows
`<command removed>`, still quotes the readable path and git's own words, and still reaches
delivery as a launch that never happened.

### ONE WORD CHARACTER DEFEATED THE DEFANG ANCHOR

`defang` matched its verbs behind `\b`, which requires a NON-word character in front of them — so
one word character was enough to make the whole rewrite miss. `foldEvidence('Xbranch -D victim')`
returned it unchanged, and a lock reason spelled that way put the literal `branch -D` back into
the live-holder arm whose pinned contract is that the string appears nowhere in it: the contract
was falsifiable from outside the module, with the same local write access every other forgery here
needs. The anchor is dropped rather than widened, because there is no benign spelling to protect —
a verb is only rewritten when a DELETE OPTION is found in the bounded window after it, so prose
that merely contains the letters (`rebranching a vantage tag`) renders unchanged, and over-folding
quoted evidence is the safe direction. The cost of the trade is one substring in a position nobody
can run; the alternative was a runnable-looking one in a message that promises none.

The `invariant 122` citations now name their section. The numbered rules live INSIDE §12 of
`docs/INVARIANTS.md`, whose headings run 1-13, so a reader looking for a top-level "122" concludes
the citation dangles. It does not — "UNKNOWN never authorises an irreversible action" is at
`docs/INVARIANTS.md:916`; the card's "121" is the off-by-one, and the citations say §12 so either
number can be resolved.

The rewrite rule is no longer a regex, and that closes a CI blocker and a real bypass at once. CodeQL
raised a HIGH-severity `js/polynomial-redos` alert on `defang`'s window
`(branch|update-ref|tag)((?:\s+-\S+)*(?:\s+\S+){0,4})` — the head went UNSTABLE and stayed
unmergeable. A reviewer measured the runtime as linear, so the alert is a false positive about speed
and a true statement about SHAPE, and this module composes on the launch tick over attacker-shaped
evidence, which is exactly where a shape like that does not belong. The rule became a token scan: one
split on whitespace, one right-to-left pass recording the nearest delete option at or after each
index, one left-to-right pass rewriting. No nested quantifier survives it, and the short-cluster test
gave up `^-[A-Za-z]*[Dd][A-Za-z]*$` (two `*` over the same class either side of one letter, quadratic
on a long letter run that fails the anchor) for a `startsWith` plus one unambiguous `^[A-Za-z]+$`.
Measured through `foldEvidence` and its new 64k input cap, over 1M characters of each adversarial
shape — bare verbs, verb-plus-option pairs, 200-character clusters, one unbroken 1M-character token —
the worst was 8.1ms. The stale "200k, 2ms" figure belonged to a superseded regex and is gone.

The same change retires the last BOUNDED WINDOW, which is the finding that mattered more than the
alert. `git branch w x y z -D victim` DELETES victim on git 2.43 — git permutes its argv, so
"options, then the ref" is git's documentation and not git's behaviour — and four positionals in
front of the option put the delete outside the window, so the forged lock reason rendered VERBATIM
inside the ALIVE arm whose pinned contract is that `branch -D` appears nowhere in it. That is the
third window to fall to "add one more token", and there is no count that closes a class whose next
member is the same string with one more word in it. The window is now the REST OF THE EVIDENCE: a
delete verb is rewritten whenever a delete option appears anywhere after it. That over-folds, and
over-folding EVIDENCE is the safe direction — the guard's own remedies are its own prose and never
pass through the fold, which two positive controls pin (the DEAD arm's `worktree remove` and the safe
arm's `branch -D` both survive), while a benign `git branch --contains abc1234 --sort=committerdate`
still quotes readably.

The NAME field could spell the banned literal without any evidence at all. `foldRefName` folds
whitespace and forgery codepoints, and a name has neither: the git-legal `-D-victim` renders through
the prefix every arm carries as `branch -D-victim already carries…`, so `msg.includes('branch -D')`
was TRUE in the arm sworn to contain no such string. `defang` cannot reach it either — a folded name
has no whitespace left to make a verb-plus-option shape out of. A leading dash is therefore MARKED
with the `?` this function already folds to, prepended rather than substituted so the name still
reads in full for a reader who has to look it up.

`git worktree remove` does not check occupancy at all, and the DEAD arm now says so. The arm already
disclosed that its clearance was SAMPLED at composition time and printed the /proc re-check, but it
left a reader free to assume git would catch a lane that entered afterwards. Reproduced here on git
2.43: a non-force `worktree remove` exited 0 while a process held the tree as its cwd, and
`/proc/<pid>/cwd` then read `<worktree> (deleted)`. What git refuses on is DIRT — tracked
modifications and untracked non-ignored files — so the occupancy re-check is the reader's own job and
the sentence now says that rather than implying it.

The DEAD arm's production reachability is now in the ACCEPTANCE CLAIM, not only in this file. The
plan's opening said the as-built ships all four arms; the honest version states the precondition,
because two reviewers measured it independently: `probeTreeOccupancy` answers UNKNOWN if ANY
`/proc/<pid>/cwd` on the box is unreadable, so off euid 0 every dead lock pid degrades to the
treat-as-live UNKNOWN arm and only injected fixtures reach unlock/remove. Three arms fire in
production at non-root euid, four where /proc is fully readable. The degradation stays — an
unreadable entry may be a process standing in the tree, and 'clear' is the answer that would print
`worktree remove` — and the arm it degrades to names the dead pid, says why occupancy could not be
established, prints the read that settles it, and authorises nothing (invariant 122, `docs/INVARIANTS.md`
§12).

Finally, the fetch write-safety prose is scoped to what the fetch ITSELF writes. "never the tree" and
"nothing outside .git" were absolutes about a command that runs local code when the repo configures
it to: a `reference-transaction` hook fires inside the very ref update those sentences describe. A
hook is arbitrary local code, so the sentences now measure git's own writes and say that a configured
hook is outside what they can bound. The reassurance actually owed — nothing this path does on its
own touches the tree — is unchanged.


The write attribution stopped crediting a fetch that never landed. `delivery.ts` picks its per-arm
write sentence from a frozen copy of each arm's OPENING, and three of the composer's unheld arms are
reached precisely BECAUSE the fetch produced no readable `origin/<branch>` — no reachable `origin`,
"could not read origin/<b> (…)", and "origin has no <b> at all" — yet all three open with the same
"found no worktree holding the branch" phrase as the arm whose fetch succeeded. The prefix test
therefore credited them with a refreshed tracking ref, a reflog append, a rewritten FETCH_HEAD and
downloaded objects that a fetch exiting 128 never made. Reproduced in a scratch repo: with no
`origin` configured, `git fetch --no-tags origin +refs/heads/<b>:refs/remotes/origin/<b>` exits 128
and `rev-parse --verify refs/remotes/origin/<b>` still fails afterwards. Overcounting writes is the
same defect as undercounting them, in the message whose subject is not claiming things nobody
established — so those three arms now get their own attribution: the fetch was ATTEMPTED, it did not
yield a readable origin ref and may have failed before writing anything, so what it wrote is UNKNOWN,
and the ceiling is the unchanged one (only a fetch of this single ref is possible at all, and
everything such a fetch can touch lives under `.git`). One arm rather than three, because "the fetch
wrote nothing" would itself be unestablished: the "could not read" arm also covers a fetch that
SUCCEEDED and whose tracking ref then failed to resolve. The seam is pinned end to end — the REAL
composer's output for each of the three arms, through the REAL classifier — with a positive control
on the arm whose fetch did land, so an implementation that answers this by making every unheld arm
say UNKNOWN fails.

Two token spellings the defang scan did not recognise now fold. `--delete` was matched as an exact
string, but git expands unambiguous prefixes — `git branch --del victim` really deletes on git 2.43 —
so `--del`/`--dele` rendered verbatim inside the ALIVE arm contracted to print no delete, and that
one is RUNNABLE; every prefix of `--delete` at least three characters long is now a delete option,
along with `update-ref --stdin`, which deletes by reading `delete <ref>` lines and carries no delete
letters at all. And the short cluster required its WHOLE body to be letters, so one trailing
punctuation character (`-D.`) fell through and put the literal `branch -D` back into that same arm;
only the LEADING letter run is the cluster now, which folds it while keeping the single-quantifier
shape CodeQL's polynomial-redos rule reads. Both are pinned by table cases through the real composer,
with positive controls: `--contains`, `--dry-run` and the guard's own safe `branch -D` remedy all
still render.


The write-safety sentence every arm OPENS with is attributed, and the hook that falsifies an
absolute is named once. Scoping the launcher's own sentence answered the `reference-transaction`
threat in exactly one place and left two siblings behind: `No branch, worktree, commit or file in
the tree was changed or deleted.`, composed unconditionally into all of them, and the failed-fetch
and threw arms' `nothing else can have been written either way`. A hook is arbitrary local code
that fires inside the very ref update the fetch makes — reproduced on the exact fetch form this
path uses: the fetch exits 0 and the hook's two files appear in the working-tree root — so all
three were absolutes about a path this message cannot bound, in the module whose whole contract is
that this message class never overclaims. Each is now attributed to what was actually measured
(`… by git itself on this path`, `git makes no other write on this path either way`), and the
caveat itself is stated ONCE, after the enumeration, covering every write sentence in the message
rather than one of them. Pinned across every arm the composer can emit, including that the message
carries the caveat exactly once and that neither retired absolute reappears anywhere.

The successful fetch's enumeration became per-item conditional, because a no-op fetch makes no ref
transaction. `that refreshes the origin tracking ref (appending to that ref's reflog)` guaranteed
two writes that a fetch finding origin unchanged does not make: repeating the identical fetch
against an unchanged remote leaves `git reflog show refs/remotes/origin/<b>` at one line — no
update, no append. So in the no-op case the sentence asserted the very writes it exists to count
honestly, which is the overcounting defect the failed-fetch arm was written to stop, one arm
along. The refresh, the reflog append and the downloaded objects are hedged on origin having moved
the ref; FETCH_HEAD stays unconditional, because this fetch does not pass `--no-write-fetch-head`.
The same correction lands on the launch path's own `noWrites` sentence in `orchestrator.ts`, which
enumerated the identical set for the base fetch. The guarding test asserted only the substring
`reflog`, which is what let the overclaim survive a review round; it now pins the hedge and the
one item that is not hedged.

The tail is per arm, because "re-dispatch once the branch is free" was appended to all of them.
On the arms where NO worktree holds the branch that clause is wrong twice over: the branch is
already free, so it reads as "re-dispatch now" — the one action this delivery class must not
suggest — and it quietly contradicts the composed remedy beneath it, which is a verified delete
(published) or a salvage (unpublished) that must happen BEFORE any re-dispatch. There are three
answers rather than two, and the third is this card's own subject: an UNKNOWN holder is not an
unheld branch, so it may not borrow either tail — telling its reader no worktree holds the branch
would assert exactly the fact that arm exists to say it could not measure. Held keeps the wait,
unheld says the step comes first and re-dispatch only after it, and unknown authorises nothing
until the holder is established. The arm openings the two halves of the seam read are now named
constants used by both the write attribution and the tail, so they cannot drift apart.

The pid the lock names is bounded, and the truncation is marked. It was the one attacker-shaped
field in the refusal with no limit: the lock reason around it is scrubbed to 200 characters and
the worktree path to 300, while the digits were interpolated raw at six sites, so a forged lock
reason spelling `pid` followed by 200,000 nines composed a ~200KB refusal that is persisted and
re-read. The rendered field is cut at 32 digits — far above Linux's seven-digit PID_MAX_LIMIT, and
above the oversized-but-plausible shape the raw rendering exists to keep readable — and it says
how many digits it dropped, the way `scrub` marks its own truncation, because a number a reader
can see was cut beats one silently reshaped. The parse and the "probed as" comparison still run on
the raw digits, so the arm still names the pid it actually measured.

### A SHALLOW CHECKOUT NO LONGER PROVES DIVERGENCE, AND THE BASE FETCH STAYS IN ONE .git

`merge-base --is-ancestor` exit 1 was read as a definitive "no" on the launch path, with no depth
check anywhere before it. Past a shallow boundary the parent commits are simply absent, so git
exits 1 for a commit that IS an ancestor — reproduced on git 2.43 with a depth-1 clone and a true
parent — and the refusal then printed "already carries N commit(s) not on origin/<base> — it was
not cut from origin/<base>", the exact false positive this card exists to remove, about another
lane's work, with a delete beside it. This checkout really can arrive shallow: `healShallowCheckout`
in the same file documents the shape arriving in production and runs only on the REPLAY path, never
before this guard. Exit 1 is now downgraded to UNKNOWN unless the checkout is PROVEN complete, by
the same `rev-parse --is-shallow-repository` probe `healShallowCheckout` uses. Exit 0 stays
definitive: truncation can hide an ancestry link, never invent one. The probe is lazy, so the
ordinary shape — a branch already contained in the base — never pays for it. An unreadable
depth is itself UNKNOWN, which is fail-closed and authorises nothing, and the two answers are told
apart in the message rather than sharing one sentence: the shallow arm names the boundary and the
`fetch --unshallow` read that settles it, the unreadable arm says the depth could not be read.

The exit-1 read and the depth read are separate `git` invocations, so the pair must be made to
describe ONE history. A "no" therefore rests on an exit 1 observed after completeness was proven:
the ancestry probe is re-run, and only a second exit 1 answers "no" — a re-run that exits 0 (the
unshallow landed the missing parents between the reads) answers "yes", any other exit is UNKNOWN,
and the detail line quotes the read the verdict rests on. That re-read was originally justified by
"deepening is one-way — nothing re-truncates a checkout in place", which is FALSE: `git fetch
--depth=1` truncates a complete checkout, reproduced on git 2.43, where
`--is-shallow-repository` flips false → true and a genuine ancestor starts exiting 1 again. Under
the old memoised probe, one depth read taken while the checkout was complete authorised every later
exit 1, including reads taken after such a truncation, and the pair published as proven divergence
on a correctly based branch. So the depth probe is no longer memoised, and the confirming read is
BRACKETED: depth is read once before it and once after it, and "no" requires the checkout to have
measured complete on both sides of the read the verdict rests on. A truncation landing across that
read makes the closing probe answer "yes" (or fail) and the verdict degrades to UNKNOWN. This is a
narrowing, not a lock — a truncate AND a re-deepen both completing inside the bracket would still
be missed — but the shape observed in this repo, a single depth-limited fetch that LEAVES the
checkout shallow, is caught. Both directions are pinned by tests through the real launcher: the
shallow → complete transition (stale exit 1, then a finding read, and the build fires) and the
complete → shallow one (exit 1 at both reads, a checkout that truncated in between → UNKNOWN, no
`branch -D`), with exit 1 at both reads of a checkout complete on both sides as the positive
control that the wrong-base refusal still fires.

The launch base fetch and the composer's own publication fetch both carry
`--no-recurse-submodules`. Without it, `git fetch` recurses whenever `fetch.recurseSubmodules` says
so — the config default is `on-demand`, and a repo may set `true` outright — and a recursed fetch
writes inside the SUBMODULE's git dir, demonstrated on a populated old-form submodule as a move of
`<repo>/sub/.git/refs/remotes/origin/main`. That is git's OWN write, so the hook caveat above does
not cover it, and it falsified the boundary two messages assert: the launch refusal's `noWrites`
and `delivery.ts`'s `LAUNCH_PATH_FETCH`, both of which say the writes live under `.git`. Neither
path reads a submodule and both name their one refspec explicitly, so the flag costs nothing and
makes the enumerated boundary a measurement again. The fetch the safe arm PRINTS for the reader to
run carries it too, for the same reason: that line runs in someone else's repo.

`LAUNCH_PATH_FETCH` is conditional in its own words. It is concatenated unconditionally while only
`wrongBaseWrites` is arm-aware, so it also rides on the local-merge and already-pinned launches,
where the launcher's `freshBuild && merge_mode === 'pr'` gate means no fetch ran at all. The old
wording was generic rather than false, but a reader on those paths read it as a fetch that
happened. It now says WHEN it applies and names the case that made no such write. Conditioning the
concatenation instead would require this module to know which launch path ran, which is exactly
what its own docblock says it cannot.

The `sh()`-quoting disclosure names every arm that prints a command, not the two treat-as-live
helpers it used to list. Reviewers reproduced the banned literal inside the DEAD arm's release
procedure (through `sh(wt)`) and inside the unpublished-salvage chain (through `sh(repo)` and the
run id in the tag name) — arms the prose did not mention, which made a disclosure read as an
enumeration. Every occurrence is still a POSIX-quoted ARGUMENT rather than a runnable delete, and
the ALIVE arm's contract — no printed command at all, so no quoted argument to carry it — is
unchanged. Both halves are now pinned: five holder arms and the salvage arm with hostile fields,
asserting the quoted form is present and that removing exactly those quoted arguments leaves no
`branch -D` behind. The parity-splitting helper the earlier pin used cannot do this job, because
these arms' own prose contains apostrophes.
The depth-blind refusal now carries its remedy all the way to the reader. Everything the ancestry
guard measures is written into the persisted `failure_reason`, and the persisted reason is never
rendered: `composeTerminalDelivery` emits `interpretFailure`'s `summary` and `input_needed` and
drops the reason entirely. Both depth arms match the anchored pre-launch prefix and carry the
not-started clause, so both were flattened to the generic infra summary plus "Reply to retry the
build" — and that advice is known in advance to fail here, because nothing on the launch path
deepens the checkout (`healShallowCheckout` runs only on the replay path), so the retry re-runs the
same probe over the same truncated history and lands on the same refusal. A refusal whose only
actionable remedy is unreachable by the person told to act is the defect this card exists to
remove, one layer further out than where it was first found.

`interpretFailure` therefore reads one authored clause — `is a proven "not an ancestor" only in a
COMPLETE history`, written by `orchestrator.ts`'s `probeDetail` at its two depth arms and nowhere
else — and reads it ONLY INSIDE the pre-launch arm, which is anchored at position 0 by a prefix no
interpolated field can produce. So a post-launch failure that merely quotes a depth refusal keeps
the advice its own class is owed. The summary names which of the two shapes was measured — the
checkout is shallow, or its depth could not be read — rather than letting either borrow the other's
measurement, and the `input_needed` puts `git fetch --unshallow origin` FIRST and says in words
that retrying without it stops in the same place. The class, the summary's "I did not start this
build" opening and the refusal itself are unchanged; only the advice moves. A false positive on
that `includes()` can only add one additive, reversible fetch to a refusal that did not need it,
which is why an `includes()` is enough: no arm of this branch authorises an irreversible act.

Three seams are pinned rather than one. `terminal-failure-reason.test.ts` drives all four
depth-blind reasons (both probes crossed with both depth shapes) through `interpretFailure`,
asserts the step and the absence of every destructive literal, tells the two shapes apart, and
carries three positive controls — a bad object, a killed watchdog and a failed base fetch, all
pre-launch refusals a deepen cannot touch, each of which must keep the plain retry — plus the
quoted-clause control that the arm stays anchored. `orchestrator.test.ts` closes the loop end to
end: the REAL composed reason from the real launcher goes through the REAL
`composeTerminalDelivery`, and the proven-complete run beside it is the control that must NOT
inherit an unshallow step it has no use for. Without that last assertion the fix could be satisfied
by a message nobody ever renders, which is the exact failure being corrected.

Four smaller holes closed in the same pass, each one a claim the code did not quite support.
`defang`'s fold class covered the control range and the bidi OVERRIDES and stopped there, so a
single zero-width codepoint between `branch` and `-D` split the token, defeated the delete-verb
rule, and rendered a visually intact `git branch -D victim` inside the ALIVE arm while the pinned
`includes('branch -D')` assertion passed the whole time — the string the test looked for was not
the string on the screen. U+180E, U+200B-U+200F, U+2060 and U+FEFF join the class; they occupy no
column, so folding each to a space cannot hide anything a reader could otherwise see, and it puts
the forged token back in front of the command folder that exists to catch it. `isDeleteOption`
recognises the `--delete=<value>` spelling of every prefix it already knew: nothing escaped through
it, because git does not run that form, but the docblock claims to recognise the delete options and
a reader checking that claim found a token it did not. `ahead_count` is bounded as well as shaped —
`/^\d+$/` admitted a 50,000-digit count that composed a 50,587-character refusal, which denies the
reader the evidence just as surely as forging a line would — and over the cap it becomes `?`, the
stand-in the caller already emits for a count it could not read. And `deps.proc_root` reaches the
DEFAULT liveness probe as well as the occupancy probe: it is declared as the process root for the
default probes, and wiring it into one of the two left the liveness half of every fixture-root test
reading the host's real `/proc`, so each compose-level case had to inject `probe_pid` as well —
which is precisely the substitution the fixture root exists to avoid. A fixture that flips DEAD to
ALIVE with no `probe_pid` injected at all is what proves the answer came from the fixture.
