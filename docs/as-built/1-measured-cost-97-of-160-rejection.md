## 2026-08-31 — a run that never reviewed is no longer recorded as a rejection, and a built-but-unreviewed commit is routed to review, not rebuilt

The 30-day measurement (224 runs to 2026-08-31): 97 of 160 recorded `REQUEST_CHANGES` rows
carried NO findings — `REQUEST_CHANGES` was the default stamped when a run ended any other
way — and 33 of those had already reached `forge-done`: the build succeeded, was recorded as
rejected, and the next dispatch rebuilt the same card from scratch. 215 of 224 rows sat at
round 1 while their own checkpoints named fix-round-2..7.

What shipped, in dependency order:

**BOTH write sites refuse a rejection they cannot justify.** In-process (landed with migration
`0138`): a terminal `REQUEST_CHANGES` with NULL/`[]`/unparseable findings throws
`TridentEmptyFindingsRejectionError` from `update`/`save`/`saveIfActive` (`trident/store.ts`) —
a programming error, not a valid row. Out-of-process (this change): the LIVE inner workflow
never goes through the store, it invokes `trident/checkpoint.sh` — which accepted
`inner_verdict REQUEST_CHANGES` as a plain settable and left the findings column NULL, so the
precondition only one of two writers honoured was not a precondition at all. That script now
decides the verdict inside the SAME atomic UPDATE, from a SQL spelling of
`parseCheckpointFindings` (`json_valid` / `json_type` / `json_array_length`) over the effective
findings — this invocation's if it brought any, otherwise the row's. Empty is REFUSED and
`REVIEW_NOT_RUN` recorded instead; refused, not FAILED, because the run really did end and
losing the rest of the write (branch, checkpoint, result) would trade one bad column for a
blind row. TWO WAYS ROUND IT WERE CLOSED IN ROUND 8, both found by Argus. The findings file was
pulled in with `CAST(readfile(<path>) AS TEXT)`, and `readfile()` is a FUNCTION SQLite
re-evaluates at every mention — five of them in that CASE — so a file swapped mid-statement
decided the verdict from different bytes than the ones stored, persisting the exact
`REQUEST_CHANGES` + `[]` row at iteration 132 of a 300-write probe; the script now reads each
`*_file` field ONCE, in bash, and emits its bytes as a single SQL literal every mention shares.
And the precondition was on the INVOCATION rather than on the ROW, so recording a real
rejection and then writing findings ALONE that emptied the set reached the forbidden shape in
two legal steps; a findings-only write now DEMOTES a stored `REQUEST_CHANGES` the same way a
verdict write is refused — same test, same `REVIEW_NOT_RUN`, and an `APPROVE` or null-verdict
row is left untouched. THAT DEMOTION IS RIGHT FOR A LIVE ROW AND WRONG FOR A TERMINAL ONE,
because of who writes on each: `artifactCheckpointCommand` opens EVERY phase checkpoint with
`printf '%s' '[]' > <tmp>`, and cancelling a build does not kill the workflow building it
(rjunee/neutron#177), so one of those orphan writes lands on a row that already recorded a real
rejection and rewrites the reviewer's decision to `REVIEW_NOT_RUN` with their words deleted —
manufacturing, out of a settled rejection, the built-never-reviewed row that gets re-dispatched.
On a TERMINAL row an emptying write is therefore refused on BOTH columns at once, under one
expression evaluated inside the same atomic UPDATE. The guard arms on the row's CLAIM
(`inner_verdict = 'REQUEST_CHANGES'` — so the 97 legacy findings-free rows this card measured
are protected as history wrote them) OR on stored findings that really parse (Argus r16: a
terminal `REVIEW_NOT_RUN` row's findings are what `recordedTerminalVerdict` promises are "still
PRESERVED" and what `builtButNeverReviewedSeed` carries into the next round, so blanking them
handed that round a review with nothing in it), and it covers the verdict-carrying invocation
as well as the findings-only one: `inner_verdict REQUEST_CHANGES` beside `[]` is the same
emptying write with a verdict stapled on, asking for the one verdict this script refuses to
write findings-free. AND THE VERDICT STAPLED ON NO LONGER EXEMPTS THE WRITE (Argus r20, reproduced independently by
two reviewers). The arming asked two questions — does this write bring findings, AND is its
verdict absent or `REQUEST_CHANGES` — so the identical emptying write with any OTHER verdict
walked past it: `REVIEW_NOT_RUN` + `[]` demoted a settled rejection and blanked its findings,
and `APPROVE` + `[]` recorded the OPPOSITE of the review that had happened, on no evidence at
all. Both contradicted the invariant this paragraph states. The guard now asks ONE question of
every shape — does this write BRING findings? — and freezing costs nothing real, because no
production path emits a verdict beside a findings file: `writeTerminalResult` attaches one only
on its `REQUEST_CHANGES` branch, and `artifactCheckpointCommand` never sends a verdict. A LIVE
row still demotes; ADDING real findings to a terminal row is still allowed — only erasure is
refused; a real `APPROVE` (which carries no findings file, the only shape production emits) still
lands. The CLEARING write does NOT — it brings no review at all, and it is frozen on the same
terms (see "AND THE CLEARING WRITE IS AN ERASURE TOO" below). The BOUND-REVIEW executor (`trident/orchestrator.ts`) obeys the rule for
a sharper reason than symmetry: its verdict comes from the panel's `inner_result` JSON while its
findings come from the panel's `inner_checkpoint_findings` COLUMN (`trident/review-run.ts`), the
two can disagree, and `saveIfActive`'s throw is swallowed by `tick.ts` as `advance_failed` — so
the run never went terminal and the whole bound review re-ran on every tick, forever.
`recordedTerminalVerdict` is deliberately not reused there: it also demands
`hasArgusProvenance`, which a `bound-review-complete:*` checkpoint has none of, so it would
demote genuine rejections that DO carry findings. `writeTerminalResult` now carries the rejection's own findings into that same
invocation, so the honest path states its reasons on the row the count reads.
`REVIEW_NOT_RUN` is the distinct terminal for "no reviewer ever spoke": mapped at source by
`writeTerminalResult` (`trident/inner-workflow.mjs`) and at every orchestrator fabrication site
by `recordedTerminalVerdict` (`trident/orchestrator.ts`). Deliberately NOT defaulted to
APPROVE — that would merge unreviewed code, far worse than the waste being fixed. Positive
control pinned at both sites: a genuine review with real findings still records
`REQUEST_CHANGES` carrying them.

**Built work is salvaged, not rebuilt** (this change): `trident/run-disposition.ts` is the
shared pure classifier — died-before-build / built-never-reviewed / reviewed-rejected,
computed from existing `code_trident_runs` columns alone (no new column, no backfill, no
historical row rewritten; the old rows are the measurement evidence). At the dispatch
chokepoint (`trident/board-dispatch.ts`), a card whose latest terminal run classifies
built-never-reviewed creates its new row PRE-SEEDED with the prior run's checkpoint evidence;
the existing `classifyResume` machinery then routes to review. SIX preconditions, because
seeding ADOPTS a prior run's commit — its checkpoint, head, findings and base pin — and only
these make that safe: the prior
row was not `stopped` (an explicit operator discard — see below), the
prior row's FULL TASK TEXT is this card's (the slug is truncated at 35 chars, so two cards can
collide on it and share a branch), THE CARD'S OWN `linked_run_id` NAMES THAT RUN (task text is
only a proxy — two distinct cards can carry byte-identical text, and the second would adopt the
first's unreviewed commit under the wrong title; an absent, null or whitespace-only link is a
REFUSAL to seed, i.e. fail-closed to the byte-identical fresh dispatch), that row carries a
40-hex `base_sha`, the branch tip resolves to EXACTLY the recorded head *through the ref the
launch will read*, and the checkpoint is one the workflow really will review — a bare
`forge-done` in RALPH mode is not, since `resumeOnUnchangedHead` rebuilds it
('ralph-progress-unknown').

THE REF MATTERS AS MUCH AS THE OID. `resolveResumeLiveHead` reads `ls-remote --heads origin` in
pr mode, and Forge is told not to push in pr mode — so a run that died at `forge-done` there
has its commit only locally, `classifyResume` answers `head-branch-absent`, and it rebuilds. A
seed proved against the LOCAL ref would pay the seed's whole cost (an adopted commit, no base
re-pin) for none of its saving, so the proof is taken against origin in pr mode and the local
ref in local mode. The pr-mode salvage that does pay is `outer-published:*`, whose commit the
outer loop already pushed. The base pin is likewise REQUIRED rather than carried-if-present: a
seeded row is never re-pinned, so a null-base seed would leave the publish-time "not cut from
origin/<base>" refusal permanently inert for it and every re-seed chained off it. The seed does
NOT carry `pr`, which would short-circuit `detectExistingPr` onto a possibly-closed PR. That
pr-mode read is CREDENTIALED (the same runner the adjacent landed probe takes): uncredentialed
it exits non-zero against a private origin, collapses to `''`, and the whole salvage silently
does not happen — failing closed, so nothing looks wrong while nothing works.

AND HERE IS THE FRACTION THAT COVERS, STATED RATHER THAN IMPLIED (Argus r18, major). Re-measured
over the same 30-day window this entry's counts come from: of the 33 findings-free
`REQUEST_CHANGES` rows sitting at `forge-done`, **33 are `pr` mode and 0 are `local`**. A pr-mode
run at `forge-done` has handed off to the outer publisher and died BEFORE it published — that is
what makes its checkpoint `forge-done` rather than `outer-published:*` — so its commit exists
only on the LOCAL ref, the origin probe answers `absent`, and the seed correctly declines. What
the seed therefore covers TODAY is `outer-published:*` in pr mode (the commit the outer already
pushed) and every salvageable checkpoint in local mode; the 33 measured rows are NOT among them.
That is not a defect in the seed — proving them against the local ref would seed a row that
`classifyResume` then rebuilds anyway, because `resolveResumeLiveHead` reads the SAME origin ref
a process later — it is the honest scope of what shipped. Closing that last gap means making a
pr-mode `forge-done` resume publish-then-review off its local commit, which is a change to the
resume classifier rather than to the seed, and it is deliberately NOT in this card.

AND THE SEED DOMAIN IS ENFORCED WHERE THE COLUMN IS WRITTEN (Argus r23, major). Which checkpoint
names may seed a resume was decided only inside `builtButNeverReviewedSeed`, while
`TridentRunStore.create` persisted any `inner_checkpoint` string handed to it — the "check only in
the caller" shape this card explicitly forbids, one caller away from a row born at `argus-approved`
that resumes as `{ mode: 'approved' }` and writes a terminal APPROVE having reviewed nothing.
`create` now throws `TridentUnresumableSeedError` for any seed the shared
`reviewCapableCheckpoint` (`trident/run-disposition.ts`, now exported for exactly this) declines,
on the trimmed value every reader compares. The live loop is untouched: `update` still records
`building` / `reviewing` / `argus-approved` and every other name the state machine reaches — those
say where a row IS, not what a fresh row promises to resume.

AND THE CREDENTIAL IS WIRED, WHICH IT WAS NOT (Argus r16 blocker). The runner was built ONLY
from `secretsStore` + `owner_handle`, and NO production caller passes those: `/code`
(`trident/code-command.ts`), the agent-native tool (`trident/work-board-build-tool.ts`), the
app's ▶ button and the hold sweep (both `open/composer.ts`) all inject `resolveMergeMode`
instead, because the composition root owns the token. Only the test supplied the credential
deps, so every real dispatch probed on bare `spawnCapture` and this salvage — the card's
headline saving — was inert against a private origin: built, never reviewed, silently rebuilt.
`BoardBoundBuildDeps.hostRunner` is the seam that was missing, and the composer hands the SAME
`tridentHostRunner` object behind `landedProbe` to all four sites. Because it fails closed, the
only symptom was work being rebuilt, so the pin is structural as well as behavioural: the
boot-wiring test RUNS the wired runner and reads back the planted token, and asserts that every
site taking `landedProbe` takes `hostRunner` with it.

THAT SECOND ASSERTION IS PER OBJECT LITERAL, BECAUSE A COUNT COULD NOT SEE THE DIFFERENCE (Argus
r20 blocker, with a working mutant). It compared how many times each spelling appeared anywhere
in `composer.ts`, which cannot say WHICH object carries the property: deleting
`hostRunner: tridentHostRunner` from the app's ▶ dispatch site and re-spelling it in a decoy
`void { hostRunner: tridentHostRunner }` beside the runner's definition kept both counts equal
and the test green, with production unwired. The compiler does not object either — the field is
OPTIONAL on `BoardBoundBuildDeps`, precisely so a caller may keep the uncredentialed default —
so nothing else was watching. The test now finds each object literal that carries the landed
probe as a DIRECT property and asks whether THAT literal carries the host runner as a direct
property too; a sibling object elsewhere in the file is not an answer. The reviewer's mutant is
applied to the real source inside the test and asserted RED, next to an assertion that the OLD
counting equality still holds under it — the guard carries its own falsification, since this
exact seam has now shipped inert twice.

AND THE SITE SET IS DERIVED FROM THE CHOKEPOINT'S OWN SHAPE, NOT FROM THE PROPERTY UNDER TEST
(Argus r21 blocker, reproduced). Anchoring the per-literal scan on `landedProbe` still let the
mutant choose what got checked: delete BOTH properties from the ▶ dispatch site and re-spell the
PAIR in a decoy `void { … }` beside the definitions, and every count stays equal AND every
anchored literal is validly paired — the unwired site simply no longer carries the anchor the
scan looks for, so it is not looked at. An anchor-driven scan can only ever check the sites that
still carry the anchor, which is the one thing the mutant removes. The test now enumerates the
dispatch-deps literals by the fields `dispatchBoardBoundBuild` REQUIRES — a direct `store:` and a
direct `repo_path:`, which no mutant can drop without failing to compile, and which a decoy
object does not have — pins that there are exactly FOUR of them (`/code`'s `resolve_context`, the
app's ▶ `boardStartBuild`, the hold sweep's `makeDispatchDeps`, and the agent-native
`trident_build_dispatch`), and requires each to carry the probe AND the runner as direct
properties of itself. Both reviewers' mutants are applied to the real source and asserted RED,
and the whole-site one is asserted INVISIBLE to the anchored scan beside it, so the reason the
weaker scan was replaced cannot quietly stop being true.

AND THE PRESENCE OF THE LINE IS NOT THE VALUE OF THE PROPERTY (Argus r22 blocker, codex's
executed mutant — the one that DELETES NOTHING). `...{ hostRunner: undefined }` spliced in after
the wired property leaves the spelling exactly where it is: every count equal, every literal
"paired", and the site nevertheless binding `hostRunner` to `undefined` and falling back to the
uncredentialed reader. A plain duplicate key is the same override without the spread. A site is
now wired only when the LAST thing anywhere in that literal that so much as NAMES the property is
the wired property line itself — last-mention-wins, which is what JS itself does. It cannot catch
a legitimate site: each half is named exactly once at all four, including the hold sweep's, which
does carry conditional spreads and mentions neither half in them. Both override forms are applied
to the real source and asserted RED, beside an assertion that the counting AND the per-literal
scans are blind to them.

AND A `return` IS ONLY A HAND-OFF IF IT IS THE RIGHT FUNCTION'S (Argus r29 blocker, re-executed
by synthesis). The hand-off gate above closed the wrapper hole from the outside — a literal wrapped
in `Object.assign(…, { hostRunner: undefined })` is not what the chokepoint receives — but it
accepted ANY `return` statement as a hand-off, so the same wrapper worked from the inside: put the
wired literal in an inner function and hand back `Object.assign(inner(), { hostRunner: undefined })`
and the literal is still "returned", every count stays equal, every site stays paired, bound and
legible, tsc stays silent because the field is optional — and `/code` builds with an undefined
credential. A `return` only reaches the chokepoint when the FUNCTION it belongs to is itself the
value handed over, so the gate now asks whose return it is: the enclosing function must be the
`resolve_context` property value. The inner-function mutant is applied to the REAL `open/composer.ts`
in-test, and it reds the file under the old rule.

AND A NAME IS NOT A VALUE (Argus r8 blocker, codex's executed mutant, reproduced here). Every rule
above reads a SPELLING and asks where that literal goes — but JavaScript resolves an identifier by
its BINDING, not by its spelling. Declaring `const tridentHostRunner = async () => ({ ok: false, … })`
inside `boardStartBuild`, one line above the `dispatchBoardBoundBuild(` call, shadows the
credentialed runner for that closure alone: the wired property line is untouched, so every count is
equal, the pair is paired, the literal is legible, the runner is still the last mention on its own
wired line and the literal is still a direct argument of the chokepoint BY NAME — and the ▶ site
hands over an uncredentialed stub, with `tsc --noEmit` silent because shadowing is legal and the
optional field is structurally satisfied. The behavioural half of the gate proves ONE value
credentialed by RUNNING it (`tbd.host_runner` exports the planted token); what it could not say is
that the other three sites name the same value. So the scan now asks the only question that closes
that gap, off TypeScript's own parse: at each site's position, how many declarations of
`tridentHostRunner` and `tridentLandedProbe` are IN SCOPE? Exactly one — the composer-level `const`
the behavioural probe ran — means the site's reference IS that value; two means the reference is
undecidable to this scan, and an undecidable reference is reported UNWIRED, on the same rule as
legibility. It is scope resolution rather than a name count on purpose: a count would red on any
unrelated local of the same name anywhere in a 7,000-line file, and a positive control in the test
pins that a same-named local covering no dispatch site leaves every site wired. The mutant is
applied to the real `open/composer.ts` in-test and asserted RED, beside assertions that every
earlier rule is blind to it. The same round also stops the `resolve_context` hand-off anchor being
taken on trust: renaming that property is asserted to red the gate, so the name-anchoring is proven
fail-closed rather than merely described as such.

AND A `var` IS NOT ITS BLOCK'S (Argus r9 blocker, codex's executed mutant). The scope rule above
asked how many declarations COVER a dispatch site, and it read every variable declaration as
belonging to its nearest BLOCK — but `var` is function-scoped and HOISTS. So
`if (true) { var tridentHostRunner = <stub> }`, written in an executed sibling block one line above
the `dispatchBoardBoundBuild(` call, binds the stub for that whole closure at runtime while the
block it is written in closes long before the site: the covering count stayed 1, the site read
unshadowed, and the ▶ site handed the chokepoint an uncredentialed runner with the gate green and
`tsc --noEmit` silent, because a `var` shadow is as legal as a `const` one. A declaration now gets
the scope JAVASCRIPT gives it — `let`/`const` and their destructured bindings stop at the nearest
block, while a `var`, and deliberately also a `function` declaration whose sloppy-mode hoisting has
the same shape, skips every block and takes the nearest function or module body. Widening is the
safe direction: a scope that is too wide can only report a site AMBIGUOUS, and an ambiguous site is
reported UNWIRED. The mutant is applied to the real `open/composer.ts` in-test and asserted RED,
with a positive control that a `var` in a block of a function covering no dispatch site leaves every
site wired — so this is a scope rule and not a name count.

AND AN ESCAPE IS NOT A SPELLING (Argus r9 blocker, codex's executed mutant). Legibility rejected a
COMPUTED key (`...{ ['host' + 'Runner']: undefined }`) by looking for a `[` in key position, but a
string-literal key needs no `[` and no concatenation: `...{ '\u0068ostRunner': undefined },` spliced
in after the wired property is `hostRunner` to the engine and is not the token `hostRunner` to any
text scan, so the computed-key rule did not fire, the spread's payload was an inline literal, and
last-mention-wins had no later mention to find — the site read wired while production took the
uncredentialed fallback. Chasing escape spellings loses the same way chasing `'host' + 'Runner'`
does, so the rule is asked of TypeScript's own parse tree instead: every property NAME in the
literal, at any depth, must be a plain IDENTIFIER, and a name this scan cannot read literally is a
name it cannot compare. All four production sites spell every key as an identifier, pinned as a
positive control before any mutant runs; the escaped-key mutant is applied to the real
`open/composer.ts` in-test and asserted RED, beside an assertion that it carries no computed key, so
the earlier rule cannot be what catches it.

AND THE WORD IS NOT THE WIRE (Argus r29, major, mutant executed). The caller enumeration in
`trident/__tests__/codex-seat-probe.test.ts` asserted `toContain('hostRunner')` per caller file,
which survives DELETING `/code`'s forwarding spread: the word is still spelled by the optional
field's own declaration and by the docblock above it, and an optional field means the compiler does
not close the gap either. The rule now reads BINDINGS — `hostRunner:` followed by a value, on a line
that is not a comment — and executes that exact deletion in-test, asserting the guard goes red.
AND A COMMENT IS WHATEVER THE COMPILER SAYS IT IS (Argus r9, major): "not a comment" was a line
PREFIX rule, so a forwarding line sitting between a lone `/*` and a lone `*/` was gone from the
build and still read here as a binding — the same delete-nothing-comment-it-out mutant the composer
wiring gate was fixed for. The comment ranges now come from TypeScript's own parse of the caller
file and are blanked in place, and the commented-out mutant is executed in-test against the real
`trident/code-command.ts` beside a positive control that the unmutated file still reads as bound.

AND A LINE IS NOT A CALL SITE (Argus r1 VETO, codex's executed mutant). Both rules above still
asked their question of LINES: any executable line anywhere in the caller file spelling
`hostRunner: <value>` counted as the wire. So the wire could be moved off the dispatch entirely —
delete `/code`'s forwarding spread and park `void { hostRunner: ctx.hostRunner }` one line above
`const deps` — and the guard stayed green while `dispatchBoardBoundBuild` received deps with no
credential and `tsc --noEmit` said nothing, the field being optional. A decoy is unbeatable by any
rule that reads text near a call rather than the call's own argument, so the question is now asked
of the DEPS OBJECT THE CHOKEPOINT RECEIVES: for every `dispatchBoardBoundBuild(` call in the file,
its second argument is resolved off TypeScript's parse tree — an inline literal, a `const` whose
initializer is a literal, or a value whose declared type (or whose factory's declared RETURN type,
which is how `dispatch-holds.ts` spells it) REQUIRES `hostRunner` with no `?`, where the compiler
and not this scan is the guarantee — and that object, at any depth including the conditional
spreads, must bind the property to something other than `undefined`. EVERY call in the file must
bind it, and a file with no dispatch call binds nothing, so an empty extraction fails rather than
reading as a pass. Reading the parse tree also answers the comment question by construction: a
commented-out forwarding line is not in the tree at all, so the strip above is gone rather than
repaired. Three mutants run in-test against the real `trident/code-command.ts` — delete the spread,
comment it out, and the decoy — with the retired line-wise rule spelled beside the decoy and
asserted to read it as WIRED, which is the measurement of what was broken.

AND A CITATION BY LINE NUMBER IS UNGUARDABLE (Argus r29, major). `docs/INVARIANTS.md` #118 — the
invariant this card writes — carried nine `path:LINE` anchors and every one had drifted
(`store.ts:677` pointed at a `// COLS order` comment rather than at `latestTerminalBySlug`). They
are replaced by citations by NAME, the way #124/#125/#126/#130 already do it, and
`trident/invariants-citations.test.ts` keeps it that way: every file #118 names must exist, no line
anchor may return, and a positive control proves both rules catch what they are for. The same round
resolved the contradiction this file and #118 shared — both said "a clearing write still lands"
while both also record it frozen, below.

AND THE CLEARING WRITE IS AN ERASURE TOO (Argus r21). `checkpoint.sh` froze the findings column
and the `REQUEST_CHANGES`/`REVIEW_NOT_RUN`/any-other-verdict writes against a settled terminal
row, but `inner_verdict ''` — the CLEARING write — NULLed the verdict unconditionally while the
findings column kept the reviewer's words, leaving one atomic write's two guarded columns
disagreeing about whether a review happened, which this script's own docblock says cannot occur.
`terminalRunDisposition` reads that row as died-before-build, i.e. as a card to rebuild from
scratch. It is now frozen on exactly the terms its `REVIEW_NOT_RUN` sibling is: only a TERMINAL,
already-settled row, and only when the write brings no findings of its own. No production path
emits it, which is the point of putting the rule at the WRITE SITE rather than in a caller — the
shape is closed before something reaches for it. A live row, a terminal row that never claimed a
rejection, and a clear carrying real findings all clear to NULL exactly as before.

AND A TRIMMED PATH IS NOT THE PATH (Argus r21, latent). The reorder's file listing is `trim()`ed
per line, so a tracked name with a leading or trailing space — printed bare, since `core.quotePath`
only quotes non-ASCII/control bytes — became a `:(literal)` pathspec that matches nothing: no
hunks, exit 0, the file silently absent from what the reviewers read. A line the trim ALTERED now
stands the reorder down to the single unrestricted command, exactly as a C-quoted path does. No
such path is tracked today; the artifact's completeness must not depend on that staying true.

ALL FOUR OF THOSE R21 FIXES WERE LOST ONCE AND ARE RESTORED HERE (Argus r22 blocker, confirmed by
two reviewers). A rebase replay published a head whose commit MESSAGE described this work while
its tree did not contain it: 266 deletions against its own pre-rebase commit, taking the erasure
guard, the site-derived wiring scan, the padded-path stand-down — and the tests that pinned all
three, which is why every suite stayed green over the regression. The lesson is recorded, not just
the code: a replayed commit is verified by DIFFING IT AGAINST THE COMMIT IT REPLAYS, because a
suite cannot fail over a test that was deleted with the code it guarded.

THE NUL CLAUSE IS THE THIRD COPY OF ONE PREDICATE, NOT TWO (Argus r22, nit). The canonical
counting statements carry `INSTR(…, CHAR(0)) = 0` — SQLite's JSON functions stop at an embedded
NUL while `JSON.parse` reads on and throws — and `checkpoint.sh`'s `findings_case` did not, while
`settled_rejection` applies that CASE to the STORED column. A historical row holding such a value
was therefore "a settled rejection" to the shell and "legacy" to the count: one predicate with two
answers. Bash strips NULs on ingest, so no write from that script can create the shape; the clause
is parity over rows that already exist, and it is pinned textually in all three copies.

TWO COMMENTS THAT STATED FALSE BEHAVIOUR ARE RETRACTED, MEASURED (Argus r22, nits). `store.ts`
told readers to keep question marks out of a SQL comment because the driver counts them as bind
parameters — bun:sqlite binds three values through a statement whose comment holds two. And
`orchestrator.ts` said a group producing no hunks writes no file, which would make its `existsSync`
load-bearing — `git diff --output=` creates the file regardless (0 bytes, git 2.43.0), so that
check is a stand-down for a git that behaves otherwise. Both are harmless in effect and were
corrected rather than left as rules a reader would obey for a reason that is not true. The same
round retracts the last surviving copy of the SQLite BOM-divergence claim, in `inner-loop.test.ts`:
over a value whose stored bytes begin EF BB BF, BOTH engines answer `json_valid = 0`; the reported
disagreement came from BINDING the marked text, which strips the mark before SQLite sees it.

ONE CARD PER SHAPE IN THE NON-QUALIFYING TABLE (Argus r22, codex, with an equal-timestamp repro).
The four-shape table in `board-dispatch.test.ts` reused a single task, so every iteration's
demoted prior stayed inside the same `latestTerminalBySlug` window — and that read orders by
`started_at DESC, id DESC`, which on same-second rows tie-breaks on a RANDOM id. The row actually
consulted could be an earlier iteration's leftover, also non-qualifying, and all three assertions
would stay green without the shape under test ever being looked at. Each shape now owns its slug,
as the link-boundary table already did, and the table closes with a positive control: the one
qualifying prior, through the same helpers, DOES seed and DOES pay for exactly one branch-tip read.

THE PUBLISHED REVIEW DIFF LEADS WITH THE FILES NO REVIEWER HAS SEEN. Measured on this card
(Argus r16, three reviewers): a 6,692-line artifact read by a cross-model reviewer that stops at
`ARGUS_DIFF_LINE_LIMIT` (3,000) and reports `CODEX_REVIEW_DIFF_TRUNCATED`. Default git order is
alphabetical, which on a fix round systematically buries the round's own write sites under the
docs and tests of the rounds already reviewed — all six write-site files of that round began
after line 3,400, so the new work had no cross-model coverage at all. `reviewed_head` (migration
0124) is the pin of what a reviewer HAS seen, so `publishBuiltCommit` splits `base..head` into
the `reviewed_head..head` files and the rest and concatenates one `git diff` per group in that
order — git sorts within a single invocation whatever order the pathspecs arrive in, so the
split is the only way to say this. The artifact's CONTENT is unchanged: still the whole
`base..head` change, because a reviewer must be able to read all of it. `--no-renames` on the
split path is load-bearing — with rename detection on, `--name-only` reports only a rename's
destination, so a later group restricted to the listed paths would silently DROP the source
path's deletion. No pin, an unreadable probe, an all-new or all-old file list, or a list long
enough to strain argv all fall back to the single unordered command that shipped before. Each
surviving path is passed with `:(literal)` magic (Argus r20, nit, scratch-repo repro): a bare
pathspec is glob-matched as well as literal-matched, so a changed path containing `[`, `*` or
`?` — this repo tracks 13, e.g. `app/app/projects/[id]/backups.tsx` — also matches whatever
siblings its brackets happen to describe, and a file pulled into both groups renders twice. A
rename does render differently across the two paths — `delete + add` on the split path, a
`rename` header on the fallback — because only the split path passes `--no-renames`; the
artifact is byte-comparable between them only for a rename-free change, and the reorder's
contract is that the whole change is PRESENT and reordered, not that the two renderings are
byte-identical.

AND THE PIN IS ACTUALLY WRITTEN, WHICH TWICE IT WAS NOT (Argus r17 and r18 blockers). The
reorder reads its pin at one seat, `publishBuiltCommit`, and the read was wrong twice over.
First it keyed on the `reviewed_head` COLUMN alone — settable only at `store.create`, never by
`update()`, and supplied by no production caller — so the split was live in tests and inert in
the loop. The r17 fix made the seat ALSO read `reviewedHead` out of `inner_result` (the OID
`reviewedHeadOid` gives the merge pin), but that only moved the hole: the two
`publishRequested: true` handoffs in `inner-workflow.mjs` are the only results that ever reach
this seat, and neither EMITTED the field — so `seenPin` stayed `''` and every real publish took
the unordered fallback, this branch's own artifacts included. The fix-round handoff now carries
`reviewedHead`, and only it: on a fix round the value is the head the previous panel judged
(the resume sets it from the recorded resume head and nothing overwrites it before the
handoff), whereas at round-1 `forge-done` no reviewer has seen anything and naming a head as
reviewed there would be the same lie `mergedTerminalResult` refuses — an empty pin is the
correct input for a first review, since every file in it is unseen. The pin is safe to carry on
a `REQUEST_CHANGES` result because that verdict never reaches the merge branch and the outer
nulls `inner_result` the instant it has published. The regression pin runs the REAL
`inner-workflow.mjs` source to a pr-mode fix-round handoff and pushes the emitted result
through the REAL `reviewedHeadOid`, so a future round cannot restore the inert state by
fabricating a row shape production never writes.

AND WHAT THAT ACTUALLY COVERS, MEASURED (Argus r20, major). The pin is emitted on the FIX-ROUND
handoff only, and 215 of the 224 runs in this card's 30-day window never left round 1 — so on
the dominant publish path (`forge-done`, round 1) `seenPin` is empty and the artifact is plain
byte-sorted, this card's own published diffs included. That is the CORRECT input there, not a
gap: at a first review no file has been seen, so there is no never-reviewed group to lead with.
But it means the reorder changes nothing for most publishes, and the saving it delivers is
confined to fix rounds — which is where the truncation actually bites, since that is when a
round's own write sites get buried under the docs and tests of the rounds already reviewed. The
ordering is a fix-round remedy; a first review is truncated exactly as it was before.

AND THE PROOF IS RE-VERIFIED WHERE IT IS CONSUMED, because it is taken a process earlier:
`launch()` already reads the live head, and if that head is a 40-hex OTHER than the recorded
one it drops the entire seed — checkpoint, head, findings, base pin — and continues as the
byte-identical fresh dispatch: base re-pinned, and no carried pin left for the leftover-branch
guard's `ownCrashLeftover` exemption to read, so that guard now refuses what it always would
have refused on a fresh launch. DROPPED ONLY BY A MOVED TIP — an `'absent'` branch and an
unreadable read are not evidence of another lane's work and leave the seed standing, to be
answered by `classifyResume`'s own rebuild. A row that has
already fired (`workflow_run_id !== null`) is never treated as seeded: its branch legitimately
advances past its own last checkpoint. Any failed precondition dispatches byte-identically to
before, leftover-branch guard intact. A prior `REQUEST_CHANGES` row never seeds, findings or
not.

AND THE SEED NO LONGER STRIPS THE LOCAL-BRANCH OWNERSHIP CHECK AT ALL (Argus r3 blocker). That
refusal — "branch X already carries N commit(s) not on origin/<base> … refusing to build on
another lane's work" — used to be gated on `inner_checkpoint === null`, so ANY seeded row
skipped it. But the seed's proof is about the ref `resolveResumeLiveHead` reads, which in pr
mode is the REMOTE, and the refusal is about the LOCAL branch Forge re-enters: an `'absent'`
remote (or an unreadable one, or even a MATCHING one) says nothing whatsoever about the local
ref. The check now runs for every row that has not fired (`freshLaunch || seeded_resume`), and
refuses nothing that was previously fine because it already exempts a tip contained in the
pinned base and, via `ownCrashLeftover`, a tip DESCENDED from this row's own `base_sha` — which
is exactly the shape a legitimate salvage seed (the pin travels with the head) and a
crash-recovered run both have. The seed-DROP half stays narrow — only a 40-hex mismatch drops
it — deliberately: `beginCrashRecovery` and `beginInfraRetry` null `workflow_run_id`, so
"seeded" is also true for a recovered run whose branch legitimately advanced, and widening the
drop would discard the very built work this card exists to preserve.

AND A `stopped` PRIOR NEVER SEEDS, which is the one place the seed departs from the taxonomy on
purpose. `stopped` has exactly two writers — `/code stop` and the board's X-cancel/delete, both
through `trident/terminate.ts` — so it is always an operator saying "discard this", never a
crash, a reap or a budget death. Such a row still CLASSIFIES `built-never-reviewed` (the offline
count is about what happened), but adopting its commit would re-enter work the owner explicitly
threw away. Salvage is for work nobody decided to discard.

**Readers follow the recorded verdict** (`trident/delivery.ts` `interpretFailure`, both Work
Board clients): a never-reviewed run can no longer be narrated as "the reviewer still had
blocking findings", and the board fills the reasonless blank with "Review never ran — the work
was not rejected."

**`round` tells the truth at both write seams**: `trident/checkpoint.sh` gains
`round_for_checkpoint()` (bash mirror of `checkpointRound`, cross-language equivalence
pinned) folded into the same atomic UPDATE as `round=MAX(round, N)`; the orchestrator folds
the workflow-reported round into every terminal shape; a salvage-seeded row is born at its
seed checkpoint's round. The neighbouring `phase_for_checkpoint()` mirror lost its
three-digit ceiling in round 8: it enumerated one-, two- and three-digit globs, so
`fix-round-1000` left `phase` untouched there while `phaseForCheckpoint`'s `/^fix-round-\d+$/`
answered `argus` — a boundary the equivalence corpus could not see because it stopped at round
10. The digit run is unbounded on both sides now; `round_for_checkpoint`'s nine-digit bound
stays where it belongs, on the parser that does arithmetic.

**The canonical trustworthy counts** — the point of the taxonomy is that a future measurement
is a query, not an argument. `terminalRunDisposition` (`trident/run-disposition.ts`) is
authoritative; the SQL below is its offline twin over `code_trident_runs`, and the agreement
is EXECUTED rather than asserted — `trident/as-built-disposition-sql.test.ts` extracts these
statements from this file, runs them against a corpus that includes the shapes a loose query
gets wrong (`fix-round-1x`, `outer-published:not-an-oid:1:2`, an uppercase OID), and requires
row-for-row agreement with the classifier.

```sql
-- REAL rejections — a rejection that STATES A REASON. Post-0138 both write sites refuse
-- any other shape — TridentEmptyFindingsRejectionError in trident/store.ts, and the CASE
-- in trident/checkpoint.sh that records REVIEW_NOT_RUN instead — so every new
-- REQUEST_CHANGES row qualifies. The findings clause is what keeps the 97 findings-free HISTORICAL rows out,
-- instead of re-reporting the untrustworthy 160 this card exists to replace.
-- THE TEST IS `parseCheckpointFindings`, NOT A STRING COMPARISON, and the difference is
-- the whole trustworthiness claim: that parser accepts only a non-empty JSON ARRAY, so
-- '{}', 'null', '[ ]' and a truncated '{' are all EMPTY to the code — while a
-- TRIM(...) NOT IN ('','[]') predicate counts every one of them as a real rejection.
-- json_type/json_array_length are nested under json_valid because they raise on
-- malformed text, and json_array_length answers 0 for a valid non-array.
-- A LEADING BYTE-ORDER MARK IS NOT FINDINGS, spelled out here for the same reason
-- `parseCheckpointFindings` spells it out: that parser answers [] for it explicitly
-- (JSON.parse throws), and this query must give the SAME answer BY CONSTRUCTION
-- rather than by version. Measured on both engines this project runs, over a value
-- whose STORED BYTES begin EF BB BF: json_valid answers 0 on the sqlite3 CLI 3.45.1
-- AND on bun:sqlite 3.51.2, so today the clause is redundant and costs one SUBSTR.
-- (The reported 3.51.2 disagreement came from BINDING the BOM'd text as a
-- PARAMETER — bun's driver strips the mark before SQLite sees it, so the stored
-- value carried no BOM at all and was honestly valid. The corpus row in
-- as-built-disposition-sql.test.ts therefore inserts those bytes as a SQL literal.)
-- Redundant is the point: an engine upgrade that started tolerating the mark would
-- otherwise score as a real rejection bytes that both write sites read as empty.
-- AN EMBEDDED NUL IS NOT FINDINGS EITHER, and it is guarded here for the same
-- reason the split query below guards its checkpoint shapes (Argus r18, which found
-- the hardening applied to one statement and not to these two). SQLite's JSON
-- functions stop at a NUL byte, so a stored `[{...}]` + NUL + garbage answers
-- json_valid = 1 and json_array_length > 0 and scored as a REAL rejection, while
-- `parseCheckpointFindings` hands the whole value to JSON.parse, which throws on the
-- trailing bytes and returns []. INSTR is the one function here that sees past the
-- NUL, so it is what restores the row-for-row equivalence. Neither write site can
-- produce the shape. The point is that the count answers the same thing the parser
-- does whatever put the bytes there.
-- AND MALFORMED UTF-8 IS NOT FINDINGS EITHER, the unguarded sibling of the two shapes
-- above (Argus r3, blocker, reproduced). SQLite's JSON parser accepts any byte >= 0x20
-- inside a string literal, so a stored `[{"t":"<0x80>"}]` answers json_valid = 1 and
-- json_array_length = 1 and scored as a REAL rejection -- while the driver every reader
-- of this column goes through (bun:sqlite) returns the EMPTY STRING for a value whose
-- bytes are not well-formed UTF-8, so `parseCheckpointFindings` is handed "" and answers
-- []. SQL said real rejection, and the classifier said no review happened.
-- The NOT EXISTS below closes it with the one question SQLite can answer about bytes:
-- it splits text into characters with its OWN UTF-8 reader, and re-encoding each of
-- those characters -- CHAR(UNICODE(ch)) -- reproduces the original bytes IF AND ONLY IF
-- they were well formed. An orphan continuation byte reads back as U+0080..U+00BF and
-- re-encodes to TWO bytes, and an overlong, a surrogate, a truncated or an out-of-range
-- sequence reads back as U+FFFD and re-encodes to EF BF BD. U+FFFE and U+FFFF are the
-- only false positives -- well-formed UTF-8 that SQLite's reader ALSO folds to U+FFFD --
-- so they are excluded by hand rather than left to drop findings the parser reads
-- perfectly well. Measured over 32 byte shapes on BOTH engines this project runs
-- (sqlite3 CLI 3.45.1 and bun:sqlite 3.51.2) the clause agrees row for row with
-- `new TextDecoder('utf-8', { fatal: true })`, which is exactly the boundary bun's
-- driver enforces. The corpus rows that execute it are inserted as SQL LITERALS,
-- because a bound parameter cannot carry bytes a JS string cannot hold.
-- THE GLOB IN FRONT OF THE SCAN IS A COST GATE, NOT A SECOND OPINION. Every character
-- being TAB, LF, CR or printable ASCII is sufficient for well-formed UTF-8 all by
-- itself, so the walk is skipped for a value that is entirely ASCII.
-- THE GATE MISSES OFTEN, and the sentence that used to stand here -- "which is every
-- findings payload this system has ever written, JSON.stringify escaping the rest" --
-- was simply FALSE (Argus r4, restated r5): JSON.stringify emits raw non-ASCII bytes,
-- and LLM-authored findings carry em dashes and curly quotes as a matter of course, so
-- a large share of real rejections pay the walk. It matters because SQLite SUBSTR on
-- TEXT is O(offset): the walk is quadratic, and measured on this box a 200 KB payload
-- costs 30 s with the gate removed and 3 ms with it, and a non-ASCII payload costs 0.73 s
-- at 16 K characters, 3.0 s at 32 K and 12.4 s at 64 K. The live corpus maxes near
-- 14 KB, measured at 123 ms.
-- THESE TWO STATEMENTS ARE DELIBERATELY UNBOUNDED, and that is the ONE place they part
-- company with checkpoint.sh's third copy of the predicate. They are ANALYSIS queries
-- over rows that already exist -- they answer a count, at a keyboard, and paying the
-- walk is the right trade for an answer that is always the parser's. checkpoint.sh runs
-- the same predicate on the WRITE path, where the cost lands on the run being recorded,
-- so it decides the literal an invocation brings in one linear pass in bash and keeps a
-- 16,384-character ceiling (`utf8_scan_max`) over the one operand bash cannot see: the
-- OLD row's stored column. Above that ceiling checkpoint.sh does not walk at all and
-- answers fail-closed per question. So "the three copies answer alike" holds for every
-- value all three walk, and NOT above the ceiling, where checkpoint.sh can answer "not
-- well-formed" about a value these statements would call well formed.
-- NAMED FOLLOW-UP, not closed here (Argus r5): the live residue of that divergence is a
-- bare `inner_verdict REQUEST_CHANGES` write whose evidence is the row's own stored
-- findings and whose findings run past the ceiling -- it is recorded REVIEW_NOT_RUN,
-- which discards a genuine rejection and leaves the row eligible for the
-- built-never-reviewed seed. It cannot merge anything and no production caller writes
-- that shape today (writeTerminalResult always attaches the findings file it just
-- wrote), so it is a follow-up rather than a defect of this change. Closing it means a
-- linear well-formedness test SQLite can run over a BLOB, or reading the stored column
-- into bash under a guard that the UPDATE still sees the same bytes.
SELECT COUNT(*) AS n FROM code_trident_runs
 WHERE phase IN ('done','failed','stopped')
   AND inner_verdict = 'REQUEST_CHANGES'
   AND CASE WHEN json_valid(inner_checkpoint_findings)
                 AND SUBSTR(inner_checkpoint_findings, 1, 1) <> CHAR(65279)
                 AND INSTR(inner_checkpoint_findings, CHAR(0)) = 0
                 AND (inner_checkpoint_findings NOT GLOB
                        ('*[^' || CHAR(9) || CHAR(10) || CHAR(13) || ' -~]*')
                      OR NOT EXISTS (
                           WITH RECURSIVE c(i) AS (
                             SELECT 1 UNION ALL
                             SELECT i + 1 FROM c WHERE i < LENGTH(inner_checkpoint_findings))
                           SELECT 1 FROM (SELECT CAST(SUBSTR(inner_checkpoint_findings, i, 1) AS BLOB) AS b
                                            FROM c)
                            WHERE b <> CAST(CHAR(UNICODE(CAST(b AS TEXT))) AS BLOB)
                              AND b NOT IN (x'EFBFBE', x'EFBFBF')))
              THEN json_type(inner_checkpoint_findings) = 'array'
                   AND json_array_length(inner_checkpoint_findings) > 0
              ELSE 0 END;

-- The legacy shape, still countable because those rows are the measurement evidence and
-- were not rewritten. Both KNOWN write sites now refuse to add to it -- the store's
-- guard throws (update/save/saveIfActive, patch-wins so a non-null '[]' cannot
-- clear the stored evidence and land beside the verdict either. create() needs no
-- guard because it hardcodes inner_verdict NULL -- naming it here invited a reader
-- to assume a check that is not there), and checkpoint.sh's
-- CASE records REVIEW_NOT_RUN. That is a claim about those two writers, NOT a database
-- constraint: raw SQL against this table is still raw SQL, so read a RISE in this number
-- as a new write path rather than as history moving.
-- The exact complement of the count above, over the same rows — BOM, NUL and
-- malformed-UTF-8 clauses included, because "exact complement" is a property of these two statements, not a
-- hope: a hardening added to one of them and not the other would double-count or
-- drop the rows it disagrees about.
SELECT COUNT(*) AS n FROM code_trident_runs
 WHERE phase IN ('done','failed','stopped')
   AND inner_verdict = 'REQUEST_CHANGES'
   AND NOT CASE WHEN json_valid(inner_checkpoint_findings)
                     AND SUBSTR(inner_checkpoint_findings, 1, 1) <> CHAR(65279)
                     AND INSTR(inner_checkpoint_findings, CHAR(0)) = 0
                     AND (inner_checkpoint_findings NOT GLOB
                            ('*[^' || CHAR(9) || CHAR(10) || CHAR(13) || ' -~]*')
                          OR NOT EXISTS (
                               WITH RECURSIVE c(i) AS (
                                 SELECT 1 UNION ALL
                                 SELECT i + 1 FROM c WHERE i < LENGTH(inner_checkpoint_findings))
                               SELECT 1 FROM (SELECT CAST(SUBSTR(inner_checkpoint_findings, i, 1) AS BLOB) AS b
                                                FROM c)
                                WHERE b <> CAST(CHAR(UNICODE(CAST(b AS TEXT))) AS BLOB)
                                  AND b NOT IN (x'EFBFBE', x'EFBFBF')))
                  THEN json_type(inner_checkpoint_findings) = 'array'
                       AND json_array_length(inner_checkpoint_findings) > 0
                  ELSE 0 END;

-- Never-reviewed terminals (REVIEW_NOT_RUN, plus the legacy pre-0138 null shape), split by
-- what they reached — built-never-reviewed is the salvageable set. PER ROW, not
-- pre-aggregated, because that is the form that can be checked against
-- `terminalRunDisposition` one row at a time: two opposite misclassifications cancel in a
-- bucket total and a comparison of totals would call that agreement. For the count, wrap
-- it: SELECT disposition, COUNT(*) AS n FROM (<this query>) GROUP BY 1. The shape tests are
-- strict because the obvious loose ones are WRONG: 'fix-round-[0-9]*' also matches
-- 'fix-round-1x', and 'outer-published:*' matches a name carrying no 40-hex OID at all —
-- neither of which the classifier calls salvageable. The ROUND BOUNDS (LENGTH(ck) <= 19,
-- and at most nine digits after the tail's colon) are the same nine-digit domain
-- `checkpointRound` and its bash mirror parse, so all three copies answer "not one of these
-- shapes" outside it rather than two of them disagreeing. The explicit TRIM set is not
-- decoration either: SQLite's one-argument TRIM strips SPACES ONLY, while the classifier
-- trims the six ASCII whitespace characters — space, tab, LF, VT, FF, CR — which is exactly
-- this set and exactly what the bash mirror names, which spells the six out rather than
-- saying [[:space:]] (that class is locale-dependent and matched U+2003 under glibc's
-- UTF-8 locales, so the mirror answered a round where these two copies answer none). (The classifier
-- deliberately does NOT use JS .trim() for this: it would also eat NBSP and the Unicode
-- separators, which no dialect here can express, so the equivalence would be bounded by the
-- corpus instead of total.)
--
-- AN EMBEDDED NUL BYTE ENDS THE STRING FOR SQLITE BUT NOT FOR THE CLASSIFIER, which is why
-- the INSTR NUL test below guards every shape rather than decorating one of them. Measured:
-- for CAST(x'6669782d726f756e642d33006a756e6b' AS TEXT) — 'fix-round-3', NUL, 'junk' —
-- LENGTH() answers 11 and the GLOBs see only the prefix, so the row passed the fix-round
-- shape and its round bound and was counted salvageable, while the classifier's anchored
-- ^fix-round-\d+$ rejects the whole value. INSTR is the one function here that DOES see past
-- the NUL (it answers 12 on that value, 0 on a clean one), so it is what restores the
-- row-for-row equivalence instead of a LENGTH comparison that has already been truncated.
SELECT id, CASE
         WHEN INSTR(ck, CHAR(0)) = 0
           AND (ck = 'forge-done'
             OR (ck GLOB 'fix-round-[0-9]*' AND ck NOT GLOB 'fix-round-*[^0-9]*'
                 AND LENGTH(ck) <= 19)
             OR (ck GLOB 'outer-published:*'
                 AND SUBSTR(ck, 17, 40) NOT GLOB '*[^0-9a-f]*'
                 AND SUBSTR(ck, 57, 1) = ':'
                 AND tail GLOB '[0-9]*:[0-9]*'
                 AND tail NOT GLOB '*[^0-9:]*'
                 AND LENGTH(tail) - LENGTH(REPLACE(tail, ':', '')) = 1
                 AND LENGTH(tail) - INSTR(tail, ':') <= 9))
         THEN 'built-never-reviewed'
         ELSE 'died-before-build'
       END AS disposition
  FROM (SELECT id, ck,
               -- ONE TRAILING ':deviated', stripped the way the classifier's anchored
               -- `(?::deviated)?$` reads it. REPLACE() removed EVERY occurrence, so
               -- '…:1:2:deviated:deviated' collapsed to a shape the classifier rejects.
               -- GLOB, NOT LIKE, and that is not style: SQLite's LIKE is ASCII
               -- case-INSENSITIVE, so '…:1:2:DEVIATED' was stripped here and counted
               -- salvageable while the classifier's lowercase regex rejects the name.
               CASE WHEN SUBSTR(ck, 58) GLOB '*:deviated'
                      THEN SUBSTR(SUBSTR(ck, 58), 1, LENGTH(SUBSTR(ck, 58)) - 9)
                      ELSE SUBSTR(ck, 58) END AS tail
          FROM (SELECT id,
                       TRIM(COALESCE(inner_checkpoint, ''),
                            ' ' || CHAR(9) || CHAR(10) || CHAR(11) || CHAR(12) || CHAR(13)) AS ck
                  FROM code_trident_runs
                 WHERE phase IN ('done','failed','stopped')
                   AND (inner_verdict = 'REVIEW_NOT_RUN' OR inner_verdict IS NULL)));
```

Both `REQUEST_CHANGES` queries live inside ONE disposition: `terminalRunDisposition` calls a
findings-free rejection `reviewed-rejected` too, on purpose — a recorded rejection, however
badly recorded, must never seed a resume. The split above is a report about those rows, not a
second classification of them. `died-before-build` likewise means "no build this dispatch may
resume": `ralph-task-built` sits there with a commit on disk because the workflow rebuilds
that shape by design.

Invariant recorded as `docs/INVARIANTS.md` #118. Nothing here changes what a reviewer
decides, relaxes a merge gate, or rewrites a historical row.
