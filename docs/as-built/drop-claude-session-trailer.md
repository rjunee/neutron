## 2026-09-19 — Loop-authored commits no longer carry the Claude-Session trailer

### What was wrong

Every commit the loop authored ended with a `Claude-Session: https://claude.ai/code/session_...`
trailer beside the `Co-Authored-By` line. No human-authored commit carries one, and this is a
public repository, so the loop was attaching a session URL to every commit it would ever
author (issue #1133). It is not a spec violation and not a leak: the purity gate passes on
such commits and the trailer names no host, user, path or private repository. It is a
publicly visible difference between machine- and human-authored history that nobody decided
on.

### Where the trailer comes from (measured on `274c5b3e`, not remembered)

Positive control first. `git log --all --grep='^Claude-Session:'` returns three commits
(`0fc6cb83`, the squash of #1131 onto main, and its two branch commits `51e5b16f` and
`d9e415d9`), each ending in the trailer next to a `Co-Authored-By: Claude Opus 5` line. So
the pattern does match real trailers in this history. The anchor matters: the unanchored
form `--grep='Claude-Session'` returns five, because it also matches the SUBJECTS of this
fix's own earlier-round commits (`e0bf4fc2`, `2cf05aa6`: "... the Claude-Session trailer
(#1133)"), which carry no trailer. On the base this change lands on,
`git log -60 --format=%B 274c5b3e | grep -c '^Claude-Session:'` returns 1: the #1131 squash
`0fc6cb83`, whose message GitHub derived from the single loop-authored branch commit. No
human-authored commit in that window carries the trailer.

The same string over the repository source — `git grep -l -I 'Claude-Session' 274c5b3e`
excluding `docs/AS_BUILT.md` and `docs/as-built/` — returns zero files, and `Co-Authored-By`
returns zero outside `docs/`. No file in this repo composes either trailer. The host-composed
commit messages are fixed text or carried text (`trident/leak-preflight.ts:438`,
`trident/build-workspace.ts:118`, `trident/replay.ts:566` which forwards the model's original
message plus a replay note, and the `gateway/git/*` backup and doc-version messages) and add no
trailer. The squash merge (`trident/merge.ts:2127`, `trident/production-host-effects.ts:439`)
runs `gh pr merge --squash` with no `--body`, so GitHub derives the squash message from the
branch's single commit: a branch commit that carries the trailer puts it on main (that is
`0fc6cb83`), and a branch commit that does not yields a clean squash. Nothing on the merge
path needs to change.

The emitter is Claude Code itself. The installed CLI (`claude --version` = 2.1.277) injects
an attribution system-reminder into the session ("End git commit messages with:
Co-Authored-By: ... Claude-Session: https://claude.ai/code/session_...") and the model obeys
it. In the installed binary `grep -c sessionUrl` = 26 and `grep -c 'Claude-Session'` = 6, and
the settings-schema text for `attribution.sessionUrl` is present verbatim:

> Whether to append the claude.ai session link to commits and PRs created from web or Remote
> Control sessions (default: true). Set to false to omit the Claude-Session trailer and
> PR-body link.

with the merge code `if(e.attribution?.sessionUrl===!1)s.attribution={...s.attribution,sessionUrl:!1}`
reading the merged settings, whose source list includes the `--settings` file every spawn
passes. `attribution.commit` is a separate field, so the default `Co-Authored-By` line is
untouched by this setting. Re-measured in round 9 on the installed 2.1.278 (`claude --version`;
real path `/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`): `grep -a -c
sessionUrl` = 26, `grep -a -c 'Claude-Session'` = 6, and the guard text
`attribution?.sessionUrl===!1` is present (2 occurrences). The version moved; the key did not.

### The single seam, and why there are two mechanisms

Every Claude Code process the loop spawns goes through the persistent pool's `spawn.ts`,
whose one call to `buildSettings(...)` (`runtime/adapters/claude-code/persistent/spawn.ts:278`,
the sole production caller) writes the per-session `--settings` JSON. That is the one place
that reaches every commit the loop authors at the source. But it is a switch the CLI honours,
not one this repository can prove from the outside: a CLI upgrade that renamed the key, or a
session whose settings file did not reach the composer, would bring the trailer back with no
test in this repo going red. So the guarantee is enforced a second time, model-independently,
at the one deterministic place every Forge commit passes through: the commit wrapper.

### What was built

1. **The source-side switch.** `runtime/adapters/claude-code/persistent/build-settings.ts`
   writes `attribution: { sessionUrl: false }` into every settings file it produces,
   unconditionally (the disposable trident build REPLs are exactly the sessions that commit,
   so it is not gated on any option). `attribution.commit`, `attribution.pr` and
   `includeCoAuthoredBy` are deliberately left unset so `Co-Authored-By` is exactly what the
   CLI composes today. `__tests__/build-settings.test.ts` pins the exact object, that the
   sibling keys are undefined, and that the block is present on every variant (the top-level
   key set is now `['hooks', 'attribution']`). Accepted side effect, which the card did not
   ask about: the CLI ties the commit trailer and the PR-body session link to this one
   boolean ("Set to false to omit the Claude-Session trailer and PR-body link"), so PR
   descriptions the loop opens will no longer carry the `https://claude.ai/code/session_...`
   link either. That is consistent with #1133's intent (a public repository should not
   carry session URLs on machine-authored history), and the alternative of a wrapper-only
   fix would not have covered inline orchestrator commits, which is where the three
   trailer-bearing commits on main (`51e5b16f`, `d9e415d9`, `0fc6cb83`) came from.

2. **The wrapper strip.** `trident/commit-with-resolved-head.sh` no longer `exec`s
   `git commit "$@"`; it runs the commit as a child and, on success and ONLY when HEAD moved
   (so `--dry-run` and a no-op commit never amend an older commit), reads the new commit
   back as the raw OBJECT (`git cat-file commit`, headers up to the first empty line, then
   the message), removes every line beginning `Claude-Session:` (a bash-3.2 bracket pattern,
   ASCII case-insensitive, compared under the C locale so every byte is a byte) and amends
   the commit in place with
   `--amend --only --no-verify --cleanup=verbatim -F <file>` (author, parent, tree and
   `Co-Authored-By` untouched; `--only` is what keeps the TREE untouched, see the review
   findings below). The stored message is byte-exact: the first commit's message minus the
   removed line and, when that line was a paragraph of its own (the way the CLI reminder
   makes the agent write it), the one empty line that separated that paragraph; a missing
   final newline stays missing and no cleanup pass runs a second time. The post-condition
   is then MEASURED: the commit now on the branch is read back as the raw object and run
   through the same filter, and a trailer still there (a `prepare-commit-msg` hook, which
   `--no-verify` does not skip, can put it back on the amend) withdraws the commit with
   exit 73. If either read-back or the amend fails the wrapper fails closed too: it withdraws
   the commit it just made and exits with git's code. Every withdrawal is a compare-and-swap
   (`git update-ref HEAD <probed HEAD> <the commit being withdrawn>`, index and worktree
   kept), never a blind reset, so a commit another writer landed on top is refused rather
   than reset away and the refusal is reported as the commit remaining. A HEAD that cannot
   be re-read -- after the commit (exit 69 failed / 70 named nothing) or after the amend
   (71 / 72) -- is refused WITHOUT any rewrite, because there is no value to compare
   against; stderr then says the commit is on the branch and may carry the trailer. So a
   trailer-bearing commit is never left on the branch by a path that can measure the
   branch, and no path ever moves a branch it cannot measure. The refusal exits 64-67 are
   byte-for-byte unchanged. `trident/commit-with-resolved-head-realgit.test.ts`
   runs the real script against real git: the trailer arrives the way the CLI makes the agent
   write it (its own `-m` paragraph), and the commit that lands is one commit with the
   fixture's parent, the same author, no `Claude-Session`, and `Co-Authored-By` byte-identical;
   a trailer that is not the last paragraph is still the only line removed; a message without
   the trailer is committed once and never amended (reflog has no `commit (amend)`); a failed
   commit propagates git's exit code and amends nothing.

3. **The advisory half.** The Forge brief in `trident/inner-workflow.mjs` (`guardedCommit`)
   tells the model not to write the trailer and to keep `Co-Authored-By`, pinned in
   `trident/inner-workflow.test.ts`. The wrapper is the enforcement; the sentence only spares
   an amend.

### Review findings on the previous round, and how each was closed

The round that added the wrapper strip (PR #1152 head `e0bf4fc2`) came back REQUEST_CHANGES
with three findings.

- **MAJOR — the amend hid the real head.** The strip ran `git commit -q --amend`, so the
  wrapper's only stdout was git's first `[branch abbrev] subject` line, which names the
  PRE-strip commit (still in the object store via the reflog, no longer on the branch). A
  Forge that copied commitSha from that line would trip the head-claim gates (local mode
  `forge:build reported commit X but refs/heads/<branch> resolves to Y`; pr mode
  `trident/publication.ts` `resolvedClaim !== resolvedHead`). Closed: the amend runs without
  `-q`, so git prints the second summary line naming the commit that is on the branch, and
  the wrapper then prints one explicit line —
  `commit-with-resolved-head: Claude-Session trailer stripped; HEAD is now <full new sha> (...)`.
  Round 9 reworded the parenthetical: it claimed "the summary line above named the pre-strip
  commit", which is false when the agent's commit ran `-q` (then the only `[branch sha]` line
  came from the amend and already names the post-strip commit); it now states only what is
  always true (the pre-strip commit was amended away; any summary line naming it is stale).
  The Forge brief now also says: after the wrapper returns, read commitSha with
  `git rev-parse HEAD`, never from a `[branch sha]` summary line. The first #1133 real-git
  test asserts the wrapper's stdout contains `HEAD is now` and the full `git rev-parse HEAD`;
  `inner-workflow.test.ts` pins the brief sentence.
- **MINOR — the amend did not inherit the first commit's flags.** With `--no-verify` on argv
  and a refusing pre-commit hook (an unlinked managed hook exits 68), the first commit landed,
  the amend re-ran the hook and failed, the wrapper exited non-zero and the trailer STAYED.
  Same asymmetry for `-S`/`--gpg-sign`. Closed: the amend runs `--no-verify` unconditionally
  (the same hooks vetted the same tree seconds earlier; the amend changes only the message)
  and forwards `-S`, `-S<key>`, `--gpg-sign`, `--gpg-sign=<key>`, `--no-gpg-sign` and
  `--allow-empty` found in the original argv (the scan stops at a bare `--`). Covered by a
  real-git test with a `core.hooksPath` dir whose `pre-commit` exits 1: the in-test positive
  control first shows that without `--no-verify` the hook refuses and HEAD does not move;
  then with `--no-verify` the commit lands stripped, `Co-Authored-By` intact, exit 0, and
  stdout names the final HEAD. Removing `--no-verify` from the amend turns exactly that test
  red (12 pass / 1 fail); restoring it returns 13 / 0.
- **NIT — the strip drops ANY line beginning `Claude-Session:`, not only a trailer-block
  line.** Deliberately left as is: the string is machine-composed, no prose line legitimately
  starts with it, and a trailer-block parser is code the card does not ask for.

### Review findings on this round's first head (`1244b2b6`), and how each was closed

The head above went out for review and came back REQUEST_CHANGES from every seat (two Opus
seats, the Codex seat, and the synthesis). Each finding was reproduced against the real
script in a scratch repo before anything was changed.

- **MAJOR — the strip amend re-committed the whole index.** `git commit --amend` without
  paths snapshots the CURRENT index, so a pathspec commit (`-m ... -- a.txt` with `b.txt`
  also staged) landed `a.txt` alone on the first commit and then the amend folded `b.txt`
  in: exit 0, `git show --stat HEAD` listing both files, `git diff --cached` empty. That
  contradicted this record's own "tree untouched" and no test could see it, because every
  #1133 test staged exactly one file. Closed: the amend runs `--only` (git: "If used
  together with --amend, then no paths need to be specified, which can be used to amend
  the last commit without committing changes that have already been staged"). Real-git
  test: two staged files, an in-test positive control with plain `git commit -- change.txt`
  captures the tree a pathspec commit is supposed to produce, then the wrapper's commit
  must have exactly that tree (`git rev-parse HEAD^{tree}`), name only `change.txt` in its
  stat, and leave `second.txt` staged. Removing `--only` turns exactly that test red
  (18 pass / 1 fail); this is the nominated mutation.
- **MAJOR — an amend failure left the trailer-bearing commit at HEAD.** The wrapper commits
  WITH the trailer and only then amends it out; when the amend failed for any reason other
  than the hook case `--no-verify` closed, it printed an error and exited non-zero with
  HEAD advanced to exactly the commit the guard promises can never reach the branch. In pr
  mode the outer loop publishes the branch head, so a later successful commit on top would
  have carried it to the PR. Closed: on amend failure the wrapper runs
  `git reset --soft "$head_oid"` (the HEAD the probe found before the commit; since round
  14 a compare-and-swap `git update-ref HEAD "$head_oid" <sha>`, see the round-13 findings),
  which withdraws the commit while keeping the index and worktree exactly as the first
  commit left them, so Forge can retry; the withdrawn commit survives only in the reflog. Stderr
  now says `commit refused: ... the commit <sha> was withdrawn, HEAD is back at <sha> and
  the index still holds the staged changes`; if the reset itself fails, stderr says so and
  names the sha that is on the branch WITH the trailer. Two real-git tests: (a) a message
  that is ONLY the trailer strips to nothing and git refuses the amend — exit 1, HEAD back
  at the fixture parent, `change.txt` still staged; (b) a git shim that is real for every
  call except `--amend`, which it refuses with 128 (standing in for a signing or ref-lock
  failure) — exit 128, HEAD back at the parent, index intact, no `Claude-Session` anywhere
  in `git log <branch>`. Replacing the reset with `true` turns exactly those two red
  (17 pass / 2 fail).
- **NIT — a message that is only the trailer landed with the trailer and exited 1.** The
  degenerate case of the major above; closed by the same fail-closed reset. And because the
  amend must repeat the flags of the commit it rewrites, `--allow-empty-message` is now
  forwarded too: with it on the agent's argv, the only-trailer message lands as the
  empty-bodied commit git already accepted, rather than being withdrawn (real-git test).
- **NIT — an explicit `--cleanup=<mode>` was not forwarded; the amend always applied
  `whitespace`.** Closed at the time by forwarding `--cleanup=*`; superseded in round 10
  (below) by an amend that runs no cleanup at all. The real-git test stands, positive
  control first: under the default cleanup a paragraph `trailing   ` loses its spaces on
  the first commit; with `--cleanup=verbatim` on the agent's commit the amended body still
  contains `trailing   \n`.
- **NIT (previous synthesis) — the flag scan could not tell an option's VALUE from an
  option.** A `-m` paragraph beginning with `-S` was forwarded to the amend as `-S<keyid>`,
  gpg failed, and (before fail-closed) the trailer stayed. Closed: the scan skips the value
  of every git-commit option that takes one as the next argv element (`-m`, `-F`, `-C`,
  `-c`, `-t`, `--message`, `--file`, `--author`, `--date`, `--template`, `--fixup`,
  `--squash`, `--reuse-message`, `--reedit-message`, `--trailer`, `--pathspec-from-file`).
  Real-git test: `-m '-Signed by hand'` lands as prose, exit 0. Deleting the skip list turns
  exactly that test red with `gpg failed to sign the data` (18 pass / 1 fail).

### Review findings on round 9 (`bb653667`, APPROVE with nits), and how each was closed

The round-9 head was APPROVED; the recorded findings ask that the message rewrite be
byte-exact except for the line it removes, with the read side on raw object bytes and a
byte-safe filter, and that the G135 inventory row state what is always true of the gate in
the terms of the code it cites. Each was reproduced against the real script before the
change.

- **The read side was porcelain.** `git log -1 --format=%B` is shaped by config the wrapper
  does not control: with `i18n.logOutputEncoding=ISO-8859-1` it hands back a re-encoded body
  (one latin1 byte per accented letter where the object holds two UTF-8 bytes), which the
  old wrapper would then have stored back as the amended message. Closed: the message is
  read as the raw commit object, `git cat-file commit <new head>`, split at the first empty
  line (a multi-line `gpgsig` header continues with a leading space, never an empty line).
  Real-git test with the positive control first: under that config `%B` really does differ
  from the stored bytes; after the wrapper the stored bytes are exactly the first commit's
  message minus the trailer line.
- **The filter was not byte-safe.** `grep -v` in the UTF-8 locale every REPL runs under
  drops a line that is not valid UTF-8 and prints `binary file matches` in its place: on
  this host, a body `caf\xe9 body` (a latin1 e-acute, stored raw under
  `i18n.commitEncoding=ISO-8859-1`) vanished from the filtered message. Closed: the filter
  is a bash function (`read -r` with an empty IFS, `printf '%s'`), so every byte but the
  newline is carried as it is and a final line without a newline is written back without
  one; the bytes travel through files, never `$(...)`, which would drop the trailing
  newline. Real-git test with the positive control first (this host's grep loses the line
  and reports `binary`); after the wrapper the stored message holds the raw byte and the
  object still carries its `encoding ISO-8859-1` header. The function also sets `LC_ALL=C`;
  that is defence in depth (a byte comparison regardless of the REPL's locale), NOT the
  mechanism the test proves -- no test discriminates it, and the record says so since
  round 11.
- **The amend ran a cleanup of its own.** `--cleanup=whitespace` on the amend trimmed every
  line's trailing spaces and overrode a config-level `commit.cleanup` the agent never
  overrode on argv (the reviewer's second nit: `commit.cleanup=verbatim`, `trailing   ` kept
  by the first commit, trimmed by the amend). Closed: the amend runs `--cleanup=verbatim`
  and `--cleanup` is no longer forwarded (the first commit already applied whatever mode
  argv or config asked for; the amend stores the filtered bytes as they are). The empty
  line that a trailer-only paragraph leaves behind is removed by the filter itself, not by
  a cleanup pass, so the rewrite is deterministic and the only bytes that change are the
  trailer line and, when it stood alone, the one empty line that separated it. Real-git
  test: with `commit.cleanup=verbatim` in config the trailing spaces survive the amend, and
  a `-F` file whose last line has no newline is stored without one.
- **The match was case-sensitive** (the reviewer's first nit; git trailer tokens are not).
  Closed in round 10 with the bash-4 lowercasing expansion; replaced in round 11 (below) by
  a bracket pattern (`[Cc][Ll][Aa][Uu][Dd][Ee]-[Ss][Ee][Ss][Ss][Ii][Oo][Nn]:*`) that runs on
  bash 3.2, folds ASCII only, and touches no non-ASCII byte. Real-git test.
- **The G135 row described the old amend.** Closed: the row now states the invariant in the
  terms of the code it cites (raw object read, byte filter, verbatim amend, fail-closed
  withdrawal). Round 10 claimed its anchors were checked; the four it added pointed at the
  blank line above each test (`:411`, `:434`, `:462`, `:472` for tests starting at 412, 435,
  463 and 473). Round 11 re-measured every anchor at the final tree, last, and cites the
  line each test or script statement starts on.

### Review findings on round 10 (`c62bfd69`), and how each was closed

The round-10 head went out for review and the synthesis came back REQUEST_CHANGES (one
major, four minor, two nits), plus two nits from the review role's own result. Each was
reproduced or measured against the real script before the change.

- **MAJOR -- `case "${lines[i],,}" in` is a bash-4.0 expansion.** On the bash 3.2 of stock
  macOS (the repository installs on Darwin; the sibling trident scripts keep to 3.2 on
  purpose) it is a fatal `bad substitution` AFTER `git commit "$@"` landed and BEFORE the
  fail-closed withdrawal -- on every wrapped commit. It was the only bash-4 construct in the
  script (grep for `,,`, `^^`, `@Q`, `mapfile`, `readarray`, `declare -A`, `[[ -v`, `&>`,
  `;;&`, `|&` finds that line and its comment, nothing else). Closed: the arm is the bracket
  pattern above (ASCII case-insensitive, byte-wise under `LC_ALL=C`, bash 3.2). bash 3.2 is
  not installed on CI or on this host, so the guard is static: a test reads the script and
  asserts the regex `\$\{[^}]*(,,|\^\^|@[A-Za-z])\}|\bmapfile\b|\breadarray\b|declare -A|\[\[ -v `
  finds nothing, with an in-test positive control that the same regex matches the round-10
  line. Re-introducing `${lines[i],,}` turns exactly that test red (28 pass / 1 fail); the
  case-insensitivity real-git test stays the behavioural guard.
- **MINOR -- the `cat-file` failure path ran `git reset --soft` unchecked and always printed
  "was withdrawn".** Closed: the path mirrors the amend path's `reset_exit` branch; a reset
  that fails is reported as "could not be withdrawn ... is on the branch and may carry the
  trailer", exit code the cat-file one. Two real-git shim tests: single fault (`cat-file`
  exits 3: wrapper exits 3, "was withdrawn", HEAD at the parent, `change.txt` still staged,
  no `Claude-Session` on the branch) and double fault (`cat-file` 3 AND `reset` 9: wrapper
  exits 3, "could not be withdrawn" and "may carry the trailer", never "was withdrawn", and
  the commit really is still on the branch with the trailer -- the truth the message
  states). Forcing `reset_exit=0` on that path turns exactly the double-fault test red.
- **MINOR -- four G135 anchors pointed at blank lines** (`:411`, `:434`, `:462`, `:472`;
  the tests start one line later). Closed as described in the round-9 section: every
  anchor re-measured last, at the final tree.
- **MINOR -- G135 kept the retracted rationale** "because the summary line git printed
  first names the pre-strip commit" (false when the agent's commit ran `-q`). Closed: the
  row now says what is always true -- the pre-strip commit was amended away and any
  `[branch sha]` summary line naming it is stale.
- **MINOR -- `reset --soft` cannot restore what the first commit consumed.** A merge,
  cherry-pick or revert in progress (MERGE_HEAD, MERGE_MSG, CHERRY_PICK_HEAD, REVERT_HEAD)
  is concluded by the commit and gone after the withdrawal, so "index kept, Forge can retry"
  is not equivalent after a merge in progress. Decision: NAME THE LOSS rather than snapshot
  and restore `.git` sequencer state. The wrapper's contract is the trailer; the trident
  conflict resolver has the outer publisher commit merge trees, not the Forge REPL; and
  restoring sequencer files is more bash surface than the card asks for. Both withdrawal
  lines on stderr, the G135 row and this record say it. Real-git test: `git merge
  --no-commit --no-ff side` (positive control: MERGE_HEAD resolves), then the wrapper with
  the trailer paragraph and the amend-refusing shim -- exit 128, HEAD at the parent, MERGE_HEAD
  no longer resolves, the merged tree still staged, stderr contains "is not restored" and
  "MERGE_HEAD". Dropping the sentence turns exactly that test red.
- **NIT -- combined short options escaped the value-skip scan.** `-am '-Signed ...'` forwarded
  the message as a `-S<keyid>` and the commit was withdrawn. Closed: one more `case` arm
  after the `-S` arm, `-[!-]*[mFCct])`, which skips the next argv element when the cluster's
  LAST letter takes a value -- and only when every letter before it is a boolean short flag
  (`-*[!apqvnseioz]*` is left alone), so an attached value such as `-Ffile.txt` or `-Cabc`
  does not swallow the flag after it. Two real-git tests: `-am` with a `-S`-leading paragraph
  lands as prose, exit 0; and `-F<file>` attached followed by `--allow-empty` (nothing
  staged) lands, because `--allow-empty` still reached the amend. Removing the arm reds the
  first; removing the inner guard reds the second.
- **NIT -- `LC_ALL=C` was credited as the mechanism the byte-safety test proves.** No test
  discriminates it. Closed by wording: the line stays as defence in depth (a Turkish-locale
  REPL, locale collation), and the header comment, the round-9 section above and this
  sentence say that no test discriminates it.
- **Review role's nits -- the anchor off-by-one (same as above) and the header comment's
  "leaves no doubled or trailing blank line".** Under verbatim cleanup a doubled blank line
  the first commit stored is kept, so the claim overreached. Closed: the comment now states
  the byte-exact contract -- the filter removes only the one separator of a trailer-only
  paragraph; any other blank line the first commit stored is kept as it is.

### Review findings on round 11 (`9e9ad881`), and how each was closed

- **NIT -- a signing letter inside a short-flag cluster (`-aS`, `-sS`) was not forwarded to
  the strip amend.** The forward arm matched `-S`, `-S<key>` and the long forms only as whole
  argv elements; git reads `-aS` as `-a -S`, so the first commit was signed and the
  `--amend --only` re-store was not (unless `commit.gpgsign` is set). Forge never signs, so
  nothing on the branch was affected, but the scan's stated contract ("repeat the flags of
  the commit it rewrites") was one cluster short. Closed: one more `case` arm before the
  `-am`-style value-skip arm, `-[!-]*S*)`, which forwards `-S<everything after the first S>`
  when every letter before that `S` is a boolean short flag (`-*[!apqvnseioz]*` on the
  prefix forwards nothing, so `-mS` stays `-m S` -- the S is that option's attached value,
  exactly as git reads it). `-aS` forwards `-S`; `-sSkey` forwards `-Skey`; `-asS` forwards
  `-S`. Two real-git tests with a stand-in `gpg.program` (it prints git's expected
  `[GNUPG:] SIG_CREATED` status line, a fake armour block, and logs the key id it was handed):
  `-aS` after a `-a -S` positive control -- both land with exactly one `gpgsig` header on the
  commit that is on the branch and two signing calls with `user.signingkey` in the log; and
  `-sSARGVKEY` -- one `gpgsig` header, `Signed-off-by` kept, both signing calls with
  `ARGVKEY` (not the configured key), then `-mS` -- message `S`, no `gpgsig`, an empty log.
  Replacing the arm's forward with `*) ;;` reds exactly those two tests (29 pass / 2 fail)
  while `trident/inner-workflow.test.ts` stays green (153 pass); restoring it returns 31 / 0.
- **NIT -- `attribution.sessionUrl: false` also drops the PR-body session link, which the
  card did not ask about.** Not a code change; the review asked for the owner's one-line
  awareness, which the "What was built" section above already carries: the CLI ties the
  commit trailer and the PR-body `https://claude.ai/code/session_...` footer to the one
  boolean (schema text: "Set to false to omit the Claude-Session trailer and PR-body link";
  `attribution?.sessionUrl===!1` in the installed 2.1.278 binary returns null from the
  session-attribution composer), so PR descriptions the loop opens will no longer carry the
  link either. Kept as is: it is the same session URL on the same public machine-authored
  history that #1133 objects to, and the boolean is the only CLI switch for the trailer.

### Review findings on round 12 (`2d60f0c2`, REQUEST_CHANGES twice: run d582beae, syntheses review-3V5Xiy and review-ZEAIoK), and how each was closed

- **MAJOR -- the post-commit HEAD re-probe (`:119` at `2d60f0c2`) failed OPEN.**
  `new_head=$(git rev-parse --verify HEAD 2>/dev/null)` discarded the exit status (the
  `$(...)` capture drops it, `2>/dev/null` drops the reason), and the guard on the next line,
  `[ -n "$new_head" ] && [ "$new_head" != "$head_oid" ]`, read an EMPTY answer as "HEAD did
  not move" -- the `--dry-run`/no-op case. A re-probe that failed therefore skipped the strip
  and the wrapper exited 0 (no `set -e`; the last command was a false `if`) with the
  trailer-bearing commit on the branch. That contradicted the script's own "Fail CLOSED"
  comments, the G135 row ("an amend (or read-back) that fails withdraws the trailer-bearing
  commit") and this record. Closed: the re-probe is now checked on both its status and its
  output and fails CLOSED exactly like the cat-file read-back one step later -- `reset --soft`
  to the probed HEAD (a no-op on the branch when this invocation created no commit; the index
  is kept either way), the withdrawal checked and the truth reported when the reset fails
  ("the commit this invocation created, if any, is on the branch and may carry the trailer"),
  with an exit code of this path's own: 69 when `rev-parse` exited non-zero (its stderr is
  quoted in the refusal), 70 when it exited 0 and named no object. The "if any" wording is
  deliberate: a `--dry-run` invocation reaches this line having created no commit. The codes
  are pinned in the tests, the same split the pre-commit probe draws with 65/66 (an unpinned
  code split was silently collapsible once before). Tested with a counting shim
  (`shimmedGitFailingNthRevParse`): real git except that the Nth `rev-parse` it sees runs an
  arm first, with a count file as the positive control. The wrapper's first `rev-parse` is
  the pre-commit probe and its second the post-commit re-probe, so N=2 faults exactly the
  re-probe after the commit has really landed; the pass-through control measures the count
  at 3 (git runs its own subcommands from `GIT_EXEC_PATH`, so no internal `rev-parse` ever
  reaches a PATH shim) and the trailer stripped. Three tests then cover the arm: second
  `rev-parse` exits 5 -> status 69, `could not be re-read`, `exited 5`, `was withdrawn`, HEAD
  back at the parent, `change.txt` still staged, branch log free of the trailer, count file
  `2`, and no `HEAD does not resolve` (the probe's 65 message never fired); second `rev-parse`
  exits 0 with no output -> status 70, `named no object`, withdrawn, count `2`; double fault
  (`rev-parse` exit 5 and `reset` exit 9) -> status 69, `could not be withdrawn`, `may carry
  the trailer`, never `was withdrawn`, and HEAD really is one commit past the parent with the
  trailer on it. Mutation: see the next section (guard 32 / 3 mutated, 35 / 0 restored).
- **The G135 enforcement anchors `:186` and `:199` pointed at comments** (the amend is
  `:200` at `2d60f0c2`, the amend-path reset `:213`), and the row carried no pin for the
  round-12 tests. Closed: every `commit-with-resolved-head.sh:` anchor was re-measured with
  `grep -n` at the final tree and verified with `sed -n` to land on a command line -- the
  strip function `:19`, the checked re-probe `:130`, its reset `:139`, the cat-file read
  `:156`, its reset `:161`, the strip call `:170`, the amend `:230`, the amend-path reset
  `:243` -- and the row now pins the round-12 tests (`realgit.test.ts:662`, `:690`) and the
  four re-probe tests (`:754`, `:767`, `:786`, `:801`). The prose names the third fail-closed
  path and its codes.
- **The round-11 section title claimed "APPROVE with nits"** and this record omitted the
  finding above. Closed: retitled without a verdict claim; the Re-landed paragraph for round
  12 no longer says "APPROVE"; this section records the round-12 verdict.

### Review findings on round 13 (`d8754625`, APPROVE from the synthesis and both Opus seats, REQUEST_CHANGES from the Codex seat), and how each was closed

Round 14 closes the two carried findings and the nits. Each was reproduced against the
round-13 script in a scratch repo (`GIT_CONFIG_GLOBAL=/dev/null`) before the change.

- **The fail-closed `reset --soft` was blind (Codex, major; synthesis, minor).** On a
  failed re-probe the wrapper ran `git reset -q --soft "$head_oid"` with no evidence that
  HEAD still named the commit it had just made. Measured: a shim that lands one more commit
  ("concurrent advance by another writer") before failing the second `rev-parse` left the
  round-13 wrapper exiting 69 with "was withdrawn" and `git log` showing ONLY the base --
  the reset withdrew two commits, the other writer's included. And with HEAD turned into a
  dangling symref after the agent's commit, the reset SUCCEEDED by creating the missing
  branch at the probed oid while the real branch kept the trailer commit, and the wrapper
  said "was withdrawn". The same unchecked reset sat on the cat-file path (`:161` at
  `d8754625`) and the amend path (`:243`), where the commit to withdraw IS known. Closed:
  one `withdraw_commit <sha>` function runs
  `git update-ref -m "commit-with-resolved-head: withdraw <sha> (Claude-Session check)" HEAD "$head_oid" <sha>`
  -- git's compare-and-swap; with a concurrent commit on top it refuses with
  `cannot lock ref 'HEAD': is at <concurrent> but expected <sha>` (exit 128) and rewrites
  nothing, and on a dangling symref it refuses with `unable to resolve reference`. The
  cat-file and amend paths use it and report a refusal as "could not be withdrawn ...
  nothing was rewritten ... is on the branch and may carry the trailer" / "WITH the
  trailer". The re-probe path, where there is no known value to compare against, no longer
  mutates at all: exit 69/70, stderr "nothing was rewritten and the branch was NOT reset,
  because without a readable HEAD there is no value to compare against and a blind reset
  could discard a commit this invocation did not make; the commit this invocation created,
  if any, is on the branch and may carry the trailer (HEAD was <probed> before the commit)
  -- inspect the branch before retrying". The index is untouched by `update-ref` exactly as
  it was by `reset --soft`, so "Forge can retry from the staged change" still holds, and the
  sequencer-state sentence is unchanged (the first commit consumed MERGE_HEAD either way).
  Real-git tests: the two re-probe tests now assert the commit REMAINS (HEAD^ is the parent,
  the log carries the trailer, never "was withdrawn"); a concurrent-writer arm on the
  second `rev-parse` leaves `[concurrent, feat: subject, base]` on the branch; the dangling
  symref arm leaves `refs/heads/orphan` non-existent and the branch at the trailer commit;
  a concurrent-writer arm before a refused `cat-file` and before a refused `--amend` each
  exits with git's code, says "could not be withdrawn" and "nothing was rewritten", and
  keeps all three commits. By-hand check: putting `git reset -q --soft "$head_oid"` back
  into `withdraw_commit` reds exactly those two CAS tests plus the cat-file double fault
  (38 pass / 3 fail); restored 41 / 0.
- **The strip never verified its post-condition (Opus seat B, minor; synthesis, minor).**
  `--no-verify` bypasses `pre-commit` and `commit-msg` only; a `prepare-commit-msg` hook
  still runs on the amend. Measured on the round-13 script with a hook that appends the
  trailer to `$1`: exit 0, the stored message ends in `Claude-Session: ...`, and stdout
  said "HEAD is now <sha> (pre-strip commit <the same sha> was amended away" -- the hook
  restored the original bytes and the amend stored the identical object. No such hook
  exists in this repository or on any trident worktree, so it could not fire today; the
  contract was hook-dependent rather than model-independent. Closed: after the amend the
  wrapper re-reads HEAD (checked: 71 failed / 72 named nothing, no rewrite, "its message was
  not verified, so it may carry the trailer"), reads the commit back as the raw object
  (a failed read-back withdraws by compare-and-swap against the head just read and exits
  git's code, as on the pre-amend path) and runs `strip_session_trailer` over it: a line
  removed means the trailer is still there, and the commit is withdrawn by compare-and-swap
  with exit 73 ("the Claude-Session trailer is STILL on the amended commit <sha> (a
  prepare-commit-msg hook, which --no-verify does not skip, can put it back); the commit
  was withdrawn"). The success line is printed only after that read-back, so its two shas
  differ by construction (an amend that stored the same object stored the same message,
  trailer included, and was withdrawn). Real-git test with the positive control first: a
  plain `git commit --amend --only --no-verify -F <clean file>` under that hook stores the
  trailer; then the wrapper exits 73, "STILL on the amended commit", HEAD back at the
  parent, `change.txt` still staged, no `Claude-Session` in the branch log, and no "trailer
  stripped" on stdout. Two more: the third `rev-parse` failing -> 71, no rewrite, the
  (in fact stripped) commit left in place and "was not verified"; the second `cat-file`
  failing -> exit 4, withdrawn, HEAD at the parent. This is the nominated mutation (below).
  The "third `rev-parse` left unchecked on purpose" entry under Not done is withdrawn: it
  argued from "a successful amend means the trailer is gone", which is the inference this
  finding refutes.
- **NIT -- the `-n "$new_head"` half of the strip guard was dead** after the round-13
  check. Closed: the guard is `[ "$new_head" != "$head_oid" ]` alone.
- **NIT -- the `forward` arm of the amend-flag scan was dead** (`value_of` was only ever
  `skip` or empty). Closed: the sentinel is a boolean `skip_value`; the comment says no
  option's value is ever forwarded and why.
- **NIT -- the real-git tests inherited the operator's global git config.** Closed: the
  file sets `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1` on `process.env`
  once, which every spawn in the file (the fixture's git, the wrapper, the shims) inherits.
- **NIT -- the Re-landed section opened with "round eight"; item 2 of What was built
  described two fail-closed paths and "git's code".** Both rewritten above and below.
- **The G135 anchors were re-measured** at the round-14 tree: `withdraw_commit` `:129`,
  its `update-ref` `:130`, the checked re-probe `:151`, the cat-file read `:166`, its
  withdrawal `:172`, the strip call `:181`, the amend `:242`, the amend-path withdrawal
  `:256`, the post-amend re-read check `:277`, its read-back `:289`, the post-condition
  `:301`, its withdrawal `:302`; tests at `realgit.test.ts:776`, `:789`, `:813`, `:834`,
  `:849`, `:868`, `:885`, `:921`, `:949`, `:968`.

### Mutation, proven by hand before nomination

`grep -c '\[Cc\]\[Ll\]\[Aa\]\[Uu\]\[Dd\]\[Ee\]-\[Ss\]\[Ee\]\[Ss\]\[Ss\]\[Ii\]\[Oo\]\[Nn\]:\*) drop\[i\]=1; removed=1 ;;'
trident/commit-with-resolved-head.sh` = 1. Replacing that case arm with
`[Cc][Ll][Aa][Uu][Dd][Ee]-[Ss][Ee][Ss][Ss][Ii][Oo][Nn]:*) drop[i]=0 ;;` (the trailer is
matched and kept) turns 16 of the 29 tests in `commit-with-resolved-head-realgit.test.ts`
red (every strip test, including three added this round) while
`runtime/adapters/claude-code/persistent/__tests__/build-settings.test.ts`, which never runs
the wrapper, stays green (15 pass); restoring the arm returns the guard to 29 / 0. That was
round 10's nomination.

Round 14 nominates the measured post-condition (the round-13 section above).
`grep -cF 'if strip_session_trailer <"$raw_after" >/dev/null; then'
trident/commit-with-resolved-head.sh` = 1. Replacing that line with `if false; then`
restores the round-13 behaviour exactly: the read-back runs but its answer is never acted
on, so a `prepare-commit-msg` hook that puts the trailer back on the amend leaves the
wrapper exiting 0 with "trailer stripped" on stdout and the trailer on the branch.
Measured: guard `commit-with-resolved-head-realgit.test.ts` 40 pass / 1 fail mutated
(exactly the prepare-commit-msg test at `:921`: it sees exit 0 instead of 73 and the
trailer in the branch log) and 41 / 0 restored; control `trident/inner-workflow.test.ts`
153 / 0 either way.

The earlier nominations still hold and are kept as by-hand checks:

Round 13 nominated the checked re-probe arm (the round-12 section above):
`if [ "$reprobe_exit" -ne 0 ] || [ -z "$new_head" ]; then` replaced by `if false; then`.
At the round-14 tree that line occurs once at `:151` (the post-amend re-read at `:277`
checks `$after_exit`/`$stripped_head`, a different line) and the mutation reds the two
re-probe tests and the two concurrent-writer/dangling-symref tests on that path (they see
exit 0 and "trailer stripped" instead of 69/70 and "was NOT reset").

Round 12 nominated the clustered-`-S` forward (the round-11 section above:
`*) amend_flags+=("-S${arg#*S}") ;;` replaced by `*) ;;`, guard
`commit-with-resolved-head-realgit.test.ts` 29 / 2 mutated and 31 / 0 restored, control
`trident/inner-workflow.test.ts` 153 / 0 either way).


`grep -c 'git commit --amend --only --no-verify' trident/commit-with-resolved-head.sh` = 1.
`sed -i 's/git commit --amend --only --no-verify/git commit --amend --no-verify/'` on that
file (the amend re-snapshots the index again) turns the pathspec test in
`commit-with-resolved-head-realgit.test.ts` red while the build-settings control stays
green; restoring the line returns the guard to green. (The round-8 pattern mutation on
`-e '^Claude-Session:'` no longer applies: that grep is gone.)

### Not changed, deliberately

- `attribution.commit`, `attribution.pr`, `includeCoAuthoredBy`: untouched, so
  `Co-Authored-By` is unchanged (acceptance).
- The `CLAUDE_CODE_SUPPRESS_SESSION_ATTRIBUTION` environment variable: an undocumented second
  knob for the same switch. The wrapper strip is the second mechanism because it is provable
  from this repository; a second CLI knob is not.
- The body-wide `Claude-Session:` line match (the nit above): still any line beginning
  with the token, not only a trailer-block line.
- Refusing BEFORE the first commit when the message would strip to nothing: the message is
  only known after git has composed it (`-m`, `-F`, `-C`, the editor), so the wrapper lets
  the commit land and withdraws it instead, which is the same fail-closed path every other
  amend failure takes.
- A hex check on the re-probe and post-amend re-read answers: not added. Those answers are
  only ever compared with the probed HEAD or handed back to git as the expected value of a
  compare-and-swap, which git validates itself; they are never used as a sha by the wrapper.
  (Round 13 also left the post-amend `rev-parse` unchecked, arguing that a successful amend
  means the trailer is gone; round 14 withdrew that entry -- see the round-13 findings.)
- Snapshotting and restoring the sequencer state a withdrawn commit consumed: still not
  done; the loss is named on stderr (unchanged from round 10).
- `docs/AS_BUILT.md` and every existing shard: frozen; this record is a new shard.

### Effect after merge

The settings switch takes effect on the next REPL spawn from a deployed tree that carries
it; warm REPLs keep their old `--settings` file until they respawn. The wrapper strip takes
effect on the next Forge commit from a checkout that carries it, whatever the REPL's settings
say. The commit that landed round 8 was itself authored through the wrapper with a
deliberate `Claude-Session: https://claude.ai/code/session_01PROOF` paragraph on its argv,
and carries none; every later round's commit, this one included, was authored through the
wrapper without such a paragraph and carries none. Merged is not shipped.

### Re-landed

Rounds 1-8 were on base `274c5b3e` (origin/main at #1162); round 8 is the one this
paragraph narrates. Every earlier round built correctly and died on a host defect. Round 1 (PR #1152 head `d7717e6c`) died at
review on a missing suite exit code read as a failure (#1154). Round 2 (`2cf05aa6`) went 12/12
green but the host refused "Fresh build already has a PR" for the branch it had itself
published. Round 3 (`b56d449f`) went green and its mutation nomination used bare filenames
where the contract wants runner-prefixed argv. Round 4 (`cb7b0d6f`) was published, went green
and was APPROVED by both Claude seats, then the host refused its own receipt because GitHub's
PR projection still showed the pre-push head (#1157). Round 5 was stopped because the Codex
review seat resolved to the headless build runner (#1158). Round 6 (settings-only shape,
APPROVED by the Claude seats) died on "Review seat synthesis: host dispatch or observation
failed". Round 7 (`e0bf4fc2`, the first round with the wrapper strip, CI 12/12 green) died on
"Review worker trailer differs from recorded synthesis" with the REQUEST_CHANGES findings
closed above. This round carries `e0bf4fc2` forward verbatim (`git cherry-pick --no-commit`,
merge-tree clean, main touched none of the seven files since its base), closes the three
findings, and restores this record, which round 7 dropped. Its first head `1244b2b6` was
reviewed and came back REQUEST_CHANGES; the fix commit on top closes those findings (the
section above) without touching the settings switch or the Forge brief.

Round 9 was on base `a1be24e0` (origin/main at #1169) and replayed `2a4cbb5a` by cherry-pick
(merge-tree clean against main). Round 8 (`2a4cbb5a`, CI 12/12 green) was APPROVED with one
nit (the `-q` wording above, closed in round 9) and then died because the host's own
`scripts/run-tests.sh` refused to run in that worktree (`node_modules/.bun` absent, exit 3;
fixed by #1168); the run after it died because the build wrote `result.pr` as a bare number
instead of the snapshot object. Neither was a defect in the change. Round 9 (`bb653667`) was
APPROVED with the byte-exactness findings closed in round 10 (the section above), which
touches only the wrapper, its real-git tests, the G135 row and this record.

Round 11 is on the same base `a1be24e0`. The relaunch created the local branch from main
carrying nothing; the card's finished work sat on origin as PR #1152 head `c62bfd69`
(`a1be24e0` + 4 commits, CI 12/12 green, a fast-forward), so this round re-lands it with
`git merge --ff-only` -- no cherry-pick, no conflict -- and adds one commit that closes the
round-10 findings above. The previous run built round 10 and was stopped by the host's
review-progress gate after the round-10 panel returned REQUEST_CHANGES a second time
("Review requires orchestrator arbitration: no-progress"); the change had not been approved
as a whole, so those findings are what this round closes. It touches only the wrapper, its
real-git tests, the G135 row and this record.

Round 12 is the fix commit on top of round 11 (`9e9ad881`, with the two nits closed in the
section above): the clustered-`-S` forward arm, its two real-git tests, the G135 row and
this record. The settings switch, the Forge brief and the strip filter are untouched.

Round 13 is the fix commit on top of round 12 (`2d60f0c2`, REQUEST_CHANGES on the one
finding above), on the same base `a1be24e0`: the worktree was fast-forwarded to the
published head (no cherry-pick, no conflict) and one commit closes the finding. It touches
only the wrapper, its real-git tests, the G135 row and this record.

Round 14 is the fix commit on top of round 13 (`d8754625`, APPROVE from the synthesis and
both Opus seats with the two findings carried as minor, REQUEST_CHANGES from the Codex
seat), on the same base `a1be24e0`, in the same worktree with no fast-forward needed. It
replaces every blind withdrawal with a compare-and-swap, refuses without rewriting where
there is nothing to compare against, measures the strip's post-condition, and closes the
nits. It touches only the wrapper, its real-git tests, the G135 row and this record.
