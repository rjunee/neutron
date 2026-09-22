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
   `git commit "$@"`; it runs the commit as a child and, on success and ONLY when the ref
   moved (so `--dry-run` and a no-op commit never rewrite an older commit), rewrites the
   commit it created without the trailer. Since round 15 it acts on the REF it committed on
   and the OBJECT it created, never on whatever HEAD names afterwards. Before the commit it
   captures the ref (`git symbolic-ref -q HEAD`, or the literal `HEAD` when detached) and
   the parent the new commit must have (the probed HEAD, or for an `--amend` that commit's
   own first parent). After the commit it re-reads that ref, reads the commit back as the
   raw OBJECT (`git cat-file commit`, headers up to the first empty line, then the message)
   and requires its first parent to be the expected one: any other first parent is another
   writer's commit, refused with exit 76 and nothing rewritten or withdrawn. It removes
   every line beginning `Claude-Session:` (a bash-3.2 bracket pattern, ASCII
   case-insensitive, compared under the C locale so every byte is a byte) and BUILDS the
   stripped commit with `git commit-tree` from the object's own tree, parents, author,
   committer (raw `<epoch> <tz>` dates through the environment, so no committer-date bump)
   and encoding, signed if and only if the object carries a `gpgsig` header (the key from
   the argv scan, else the configured default). No hook of any kind runs on the rebuild and
   no index is read, so a pathspec commit keeps its tree and a `prepare-commit-msg` hook
   cannot put the trailer back. The stored message is byte-exact: the first commit's message
   minus the removed line and, when that line was a paragraph of its own (the way the CLI
   reminder makes the agent write it), the one empty line that separated that paragraph; a
   missing final newline stays missing and no cleanup pass runs a second time. The
   candidate is verified as an OBJECT before any ref names it -- read back raw, the same
   filter must remove nothing and the tree and parents must equal the first commit's (exit
   73 otherwise) -- and then published by compare-and-swap:
   `git update-ref <ref> <candidate> <the exact commit read>`. A lost swap (exit 74) rewrites
   nothing and names all three objects. Every withdrawal is the same compare-and-swap against
   the captured ref (`git update-ref <ref> <probed HEAD> <the commit being withdrawn>`, index
   and worktree kept), never a blind reset, so a commit another writer landed on top is
   refused rather than reset away, the refusal is reported as the commit remaining, and a
   branch switch after the commit cannot redirect a withdrawal onto another branch. A ref
   that cannot be re-read after the commit (exit 69 failed / 70 named nothing) is refused
   WITHOUT any rewrite, because there is no value to compare against; stderr then names the
   ref and says the commit is on it and carries the trailer if the message had one. A header
   commit-tree cannot carry (`mergetag`) is refused with exit 75; a message that is empty
   without the trailer is refused as git would (exit 1) unless `--allow-empty-message` was
   given. So exit 0 is reached only with no trailer in a provenance-checked commit, or after
   the swap moved the captured ref from that exact commit to a candidate verified clean; no
   path ever moves a ref it cannot measure. The refusal exits 64-67 are byte-for-byte
   unchanged. `trident/commit-with-resolved-head-realgit.test.ts` runs the real script
   against real git: the trailer arrives the way the CLI makes the agent write it (its own
   `-m` paragraph), and the commit that lands is one commit with the fixture's parent, the
   same author, no `Claude-Session`, and `Co-Authored-By` byte-identical; a trailer that is
   not the last paragraph is still the only line removed; a message without the trailer is
   committed once and never rewritten (reflog has no strip entry); a failed commit
   propagates git's exit code and rewrites nothing.

3. **The advisory half.** The Forge brief in `trident/inner-workflow.mjs` (`guardedCommit`)
   tells the model not to write the trailer and to keep `Co-Authored-By`, pinned in
   `trident/inner-workflow.test.ts`. The wrapper is the enforcement; the sentence only spares
   a rewrite.

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

### Review findings on round 14 (`c80d4b92`, all seats APPROVE, the independent reviewer REQUEST_CHANGES with one major; the run stopped on a host progress-gate tie), and how each was closed

The independent reviewer's adversarial real-git fixture (`/tmp/review-c80-adversarial.mjs`,
ten modes) was re-run by the orchestrator against `c80d4b92` and again by this round before
any change, with the same answers: `reprobe-fault` exit 69 and the trailer on `main`;
`concurrent-before-reread` exit 73 with `concurrentLost: true` (the other writer's commit AND
the wrapper's own stripped commit both withdrawn); `hook-clean-followup` and
`ambiguous-reflog` exit 0 with the trailer on `main` (the wrapper's amended commit, now the
parent of the hook's follow-up, still carried it); `switched-before-withdraw` exit 8 with
`refs/heads/other` rolled back and `main` still carrying the trailer; `hook-readd` 73 and
restored; `ordinary`, `detached`, `no-reflog` 0 and clean; `cherry-dry` 69 with
`CHERRY_PICK_HEAD` kept. The five findings are one defect: the wrapper acted on "whatever
HEAD names now" instead of the ref it committed on and the object it created. Round 15
closes them with one provenance model rather than one at a time. The git 2.43 primitives
it rests on were probed in a scratch repo first: `git commit-tree -F <file>` stores the
message bytes verbatim (a missing final newline stays missing); an EMPTY `-F` file makes
`commit-tree` read its message from STDIN (it blocked on the terminal in the probe -- the
plan's "an empty -F is accepted, rc 0" holds only with stdin closed, so the wrapper runs it
`</dev/null`); `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE` accept the raw `<epoch> <tz>` form
from the object header byte-for-byte (`author A <a@a> 1700000000 +0130` round-trips);
`git -c i18n.commitEncoding=ISO-8859-1 commit-tree` writes `encoding ISO-8859-1`;
`commit-tree` ignores `commit.gpgsign` (rc 0, zero `gpgsig` headers with
`commit.gpgsign=true` and `gpg.program=/bin/false`) but honours `-S` (one header with the
fake gpg) and `--no-gpg-sign` (zero); `git update-ref <ref> <new> <expected>` refuses a lost
compare-and-swap with rc 128 `cannot lock ref '<ref>': is at <X> but expected <Y>`;
`git symbolic-ref -q HEAD` exits 1 with no output when detached, and `git update-ref HEAD
<new> <old>` then moves the detached HEAD itself and leaves every branch alone.

The model, in the order the wrapper runs it:

1. **Provenance captured BEFORE the commit.** `target_ref` = `git symbolic-ref -q HEAD`
   (`refs/heads/<x>`) or the literal `HEAD` when detached (exit 77 when neither: the
   symref query failed with something other than "detached", or the commit to amend could
   not be read). `expected_parent` = the probed HEAD, or, only when argv before `--`
   carries `--amend`, the first `parent` header of that commit (empty for a root amend).
   Every later read and every ref update names `$target_ref`, never HEAD.
2. **Re-probe on THAT ref**, still the wrapper's second `rev-parse`, so the counting shims
   keep their meaning. Failed / empty stays fail-closed with exit 69 / 70 and NO rewrite (a
   compare-and-swap needs an expected value the wrapper does not have; the blind reset is
   what round 14 removed); stderr names `$target_ref` and says the commit this invocation
   created is on it and carries the trailer if the message had one -- no "may". Unchanged
   ref (`--dry-run`, no-op) exits 0 as before.
3. **Provenance CHECK.** The commit is read back raw (first `cat-file`; a failure withdraws
   by CAS on `$target_ref` as before) and its first `parent` must equal `expected_parent`.
   A mismatch means another writer moved the ref after the commit: exit 76, nothing
   rewritten (amending would replace their message), nothing withdrawn (that would discard
   their work), both objects named.
4. **The rewrite is BUILT, not amended.** From the raw object: tree, every parent in
   order, the author and committer lines (name, email, `<epoch> <tz>` handed to
   `commit-tree` through `GIT_AUTHOR_*` / `GIT_COMMITTER_*`, so the candidate's ident
   lines are byte-identical -- the committer date is no longer bumped the way `--amend`
   bumped it), the optional `encoding` header (forwarded as `-c i18n.commitEncoding=`),
   and whether a `gpgsig` / `gpgsig-sha256` header is present. Any OTHER header
   (`mergetag`, or one the wrapper does not know) is refused fail-closed: withdraw by CAS,
   exit 75 naming the header. `candidate = git commit-tree <tree> -p <parent>... -F
   <stripped message> [-S<key>|-S] </dev/null`, signed iff the ORIGINAL object carries a
   signature (measured, not inferred from argv or config -- `commit-tree` ignores
   `commit.gpgsign`, so a config-signed first commit would otherwise come out unsigned);
   the key id comes from the existing argv scan (`-S<key>`, `--gpg-sign=<key>`, the
   clustered `-aS<key>` / `-sSkey` arms, value-taking options skipped exactly as before) or
   a bare `-S` for the default key. The `--allow-empty` forwarding arm is gone
   (`commit-tree` takes the object's own tree); `--allow-empty-message` is still noted,
   because a message that is empty without the trailer is refused as git would have
   refused it (exit 1, withdrawn) unless the agent gave that flag -- the plan had dropped
   this arm too, on the probe that `commit-tree` accepts an empty message, but a commit git
   would not have made is not one the wrapper should make on its behalf. The
   `git commit --amend --only --no-verify --cleanup=verbatim` line is DELETED: no hook of
   any kind runs on the rewrite, so a `prepare-commit-msg` hook cannot put the trailer back
   and a `post-commit` hook cannot land a follow-up on top of a trailer commit (finding 2
   closed at the root, not by detection). A failed `commit-tree` withdraws by CAS and exits
   its code.
5. **Post-condition measured on the OBJECT before it is referenced.** The candidate is
   read back raw (second `cat-file`); the same filter must remove nothing and its tree and
   parent lines must equal the first commit's. Otherwise the trailer commit is withdrawn
   by CAS and the wrapper exits 73 (or `cat-file`'s code); the candidate is never
   referenced, so no ref ever names a trailer-bearing object the wrapper built.
6. **Publish by compare-and-swap.** `git update-ref -m "commit-with-resolved-head: strip
   Claude-Session (rewrite <new_head>)" "$target_ref" "$candidate" "$new_head"`. A lost
   swap exits 74, rewrites nothing, and names the three objects (the candidate, built and
   referenced by nothing; the wrapper's own commit, still reachable with the trailer; what
   the ref names now). Every withdrawal keeps its CAS but on `$target_ref` ("`<ref>` is
   back at `<probed>`"), never HEAD. Exit 0 is reached ONLY with no trailer in a
   provenance-checked commit, or after this CAS moved `$target_ref` from the exact object
   the provenance check read to a candidate verified clean. Exit codes 71 / 72 retire with
   the post-amend re-read (there is nothing to re-read: the CAS is the post-condition on
   the ref); 73, 74, 75, 76, 77 are the refusal codes above; 64-67, 69, 70 unchanged. On
   the success path the wrapper makes exactly two `rev-parse` calls, two `cat-file` calls
   and one `update-ref` (an `--amend` adds one `cat-file` before the commit).

Each finding, before and after, measured with the fixture per mode (`REVIEW_MODE=<mode>`;
`/tmp` was not edited):

- **Finding 0 -- the 69/70 refusal left a trailer-bearing commit on the branch and said
  "may carry".** `reprobe-fault`: exit 69 before and after; the trailer is on `main` in
  both. This is the one residual the model keeps on purpose: with no readable value there
  is nothing to compare against, and the alternative -- a blind reset -- is the round-13
  defect. What changed is the sentence: stderr now names the ref and states, without
  "may", that the commit is on it and carries the trailer if the message had one. The
  acceptance line holds through this path only with a publish-side scan, named under Not
  changed as the remaining task.
- **Finding 1 -- a concurrent commit landing before the third `rev-parse` was mistaken for
  the wrapper's own amend and withdrawn.** `concurrent-before-reread`: exit 73 with
  `concurrentLost: true` before; exit 0 and clean after -- there is no third `rev-parse`
  for the fixture's arm to fire on. The same race at the wrapper's other two seams is
  pinned by real-git tests: a foreign commit landed before the re-probe is refused by its
  parent (exit 76, `[concurrent, feat: subject, base]` all kept, the wrapper's own commit
  still carrying the trailer and stderr saying so); a foreign commit landed inside the
  first `cat-file` loses the publish swap (exit 74, both commits kept, the candidate a real
  object that `for-each-ref --points-at` finds nothing for, stderr naming all three), with
  the same shim and no arm as the positive control (exit 0, clean).
- **Finding 2 -- a `prepare-commit-msg` hook re-added the trailer on the amend and a
  `post-commit` hook appended a clean commit; exit 0 with the trailer in the ancestor.**
  `hook-clean-followup` and `ambiguous-reflog`: exit 0 with the trailer on `main` before;
  exit 0 with NO trailer reachable after (the post-commit hook fires once, on the agent's
  commit; its count file reads 1). `hook-readd`: 73 and withdrawn before; 0 and clean
  after (the fixture's own assertion `status!==73` throws there -- it encodes the round-14
  model; the new outcome is the stronger one). Real-git tests: the round-14
  prepare-commit-msg test now asserts exit 0 and a clean branch (its plain-git positive
  control stays); a follow-up hook on the SECOND firing never fires; a follow-up hook on
  the FIRST firing (the agent's own commit) is refused by provenance with exit 76 -- the
  trailer the hook restored IS reachable, and the wrapper says so instead of exiting 0.
- **Finding 3 -- a branch switch at the same observed head made the withdrawal roll back
  the WRONG branch.** `switched-before-withdraw`: exit 8, `refs/heads/other` rolled back
  and `main` with the trailer before; exit 8, `main` at `before` and `other` left where
  the switch put it (at the trailer commit, which is not the wrapper's ref) after. Real-git
  test with the fixture's arm inside the first `cat-file`. The dangling-symref test is
  rewritten the same way: HEAD re-pointed at a missing branch after the commit no longer
  refuses (69) but strips the CAPTURED branch, exit 0, `refs/heads/orphan` still absent.
  The residual the plan names is kept and NOT claimed closed: `git commit` returns no oid,
  so a SIBLING commit another writer landed from the same parent inside the gap is
  indistinguishable from the wrapper's own; because the rewrite is content-preserving, the
  worst case is that such a sibling loses a `Claude-Session:` line of its own.
- **Finding 4 (major) -- the `git commit --amend` itself was the one remaining rewrite
  with no expected-value check.** Closed by steps 4-6: the amend is deleted, the candidate
  is built from `$new_head`'s own headers and published only by a CAS whose expected value
  is the exact object the provenance check read. The lost-swap test above is the mutation.
- **Rewritten and added tests**, all real git: the counting-shim control now counts two
  `rev-parse` calls; the 69/70 wording tests expect "is on refs/heads/<branch> and carries
  the trailer if the message had one" and reject "may carry"; the amend-refusing shims
  (`--amend` in argv) became `commit-tree`-refusing shims (single fault, merge in progress,
  concurrent writer); the 71/72 tests retire, the second-`cat-file` test asserts the
  withdrawal AND that the named candidate is a real object referenced by nothing; new:
  candidate carrying the trailer (shimmed `commit-tree` appends it -> 73, withdrawn,
  candidate unreferenced), config-signed first commit (`commit.gpgsign=true` -> one
  `gpgsig` header on the rebuilt commit, the fake gpg called twice with the configured key;
  in-test positive control that a plain `commit-tree` under that config stores none),
  author/committer lines byte-for-byte (`1700000000 +0130` / `1700000001 -0500` survive),
  `--amend` through the wrapper (expected parent is the amended commit's parent; the
  amended-away commit is referenced by nothing), a merge in progress concluded through the
  wrapper (both parents kept), a `mergetag` header (written with `hash-object --literally`
  by a shim on `commit` -> 75, withdrawn), and a detached HEAD (rewritten in place, the
  branch untouched). 52 tests, all green; `npx tsc --noEmit -p trident/tsconfig.json` 0
  errors.
- **The G135 anchors were re-measured** at the round-15 tree: the filter `:19`, the ref
  capture `:108`, the expected parent `:125`, `withdraw_commit` `:176` and its `update-ref`
  `:177`, `parse_commit_object` `:188`, the re-probe `:244` and its check `:246`, the first
  `cat-file` `:264`, the provenance check `:291`, the strip call `:296`, the header refusal
  `:297`, `commit-tree` `:392`, the candidate read-back `:422`, the post-condition `:438`
  and `:440`, the publish CAS `:457`; tests at `realgit.test.ts:776`, `:791`, `:816`,
  `:837`, `:852`, `:871`, `:888`, `:918`, `:943`, `:976`, `:998`, `:1036`, `:1081`,
  `:1098`, `:1116`, `:1139`, `:1163`, `:1185`, `:1202`, `:1225`, `:1254`.

### Round 16: finding 0 closed at the publisher (`trident/gates/release-readiness.ts`, G166)

**The residual, re-measured at `92b73ae7` before anything was written.**
`REVIEW_MODE=reprobe-fault node /tmp/review-c80-adversarial.mjs trident/commit-with-resolved-head.sh`
-> `exit: 69`, `mainAtBefore: false`, `branchMessages: "subject\n\nClaude-Session: fixture"`. The
wrapper refuses truthfully ("refs/heads/main could not be re-read after the commit ... the ref
was NOT reset") and the trailer-bearing commit stays on the branch. The wrapper cannot close
this from inside git-that-cannot-read-its-own-ref: with the re-probe unreadable there is no
expected value for a compare-and-swap, a blind reset is the round-13 defect that round 14
removed, and a retry would fit the fixture's once-only fault and prove nothing about a fault
that persists. The card's acceptance is "no loop-authored commit carries the trailer" -- a
property of the PUBLISHED history -- so the closure is at the one place a Forge commit
becomes public.

**Where that place is (grep, not memory).** Positive control:
`grep -rn "Claude-Session" trident/gates trident/production-host-effects.ts trident/build-host.ts`
= 0 hits before this round; `grep -rln "Claude-Session" --include=*.ts --include=*.mjs
--include=*.sh . | grep -v node_modules | grep -v .test.` = the wrapper (the filter),
`trident/inner-workflow.mjs` (the Forge brief), `build-settings.ts` (the settings switch) --
no scan existed. `publicationReadiness` (`trident/gates/release-readiness.ts`) is called by
BOTH publishers -- `trident/production-host-effects.ts:369 publishChecked`, which then runs
`git push --force-with-lease`, and `trident/build-host.ts:226 publishGate` -- with
`launchBase` = the pinned launch base sha (`current.base_sha` / `options.leak.base_sha`,
already required to be a full OID at `production-host-effects.ts:222`). It measured local
head == reviewed head, remote lease readability and first-push ancestry, and read no commit
message.

**What was built.** In `release-readiness.ts`:

1. `const sessionTrailerLine = /^claude-session:/i` (`:22`), with NO `u` flag on purpose: in
   non-unicode mode ECMAScript's Canonicalize never folds a code unit >= 128 onto an ASCII
   one, so this is the wrapper's ASCII-only `[Cc][Ll]...[Nn]:` bracket pattern in JS, and it
   is line-anchored the same way.
2. `sessionTrailerCarriers(run, repo, launchBase, head)`: `fullOid.test(launchBase)` else
   `unknown('Publication launch base is not a full OID')` before any git call; then
   `git rev-list --end-of-options <launchBase>..<head>` through `gitRangeArgv` (`:35`; the
   two-dot range is what the head adds on top of the base) -- `!ok` ->
   `unknown('Publication commit range could not be listed')`, any listed line that is not a
   full OID -> `unknown('Publication commit range listing is malformed')`; then, per sha in
   rev-list order, `git cat-file commit <sha>` -- the RAW object, the bytes the wrapper
   strips, never `git log` porcelain -- `!ok` -> `unknown('Publication commit <sha> could not
   be read')`, no `\n\n` separator -> `unknown('Publication commit <sha> has no message')`
   (round 17 below: an empty message is now measured clean instead), and any message line
   matching `sessionTrailerLine` makes the sha a carrier.
3. In `publicationReadiness`, after the first-push ancestry block and immediately before
   `return { kind: 'allow' }` (`:84`), unconditionally -- a re-publication with the remote
   branch present is scanned the same as a first push: `unknown` is returned as is; carriers
   -> `blocked('Publication branch carries a Claude-Session trailer on N commit(s) above the
   launch base: <sha>, <sha>')`, the shas named so a fix round knows what to rewrite. Every
   existing refusal keeps its order and text; the `try`/`unknownCause` wrapper still encloses
   the whole body.

The host runner (`spawnCapture`) decodes stdout as UTF-8 and trims it; a non-UTF-8 message
body decodes with U+FFFD, and the line structure and the ASCII token survive that (no test
discriminates it). The trim also removes the trailing newline of the raw object, which is
why the separator is searched for rather than the object parsed by fixed offsets.

**Closure demonstrated on the fixture's own residue.** The repository the `reprobe-fault`
run above left behind (`/tmp/review-c80-HVAPrd`, `main` = `c3d426a1` carrying
`Claude-Session: fixture` over base `cf8a8a3c`) was given a bare origin and handed to
`publicationReadiness(run, repo, 'main', 'cf8a8a3c...', { head: c3d426a1 })`:
`{"kind":"blocked","on":"Publication branch carries a Claude-Session trailer on 1 commit(s)
above the launch base: c3d426a14372042e6e52a1f64cdc0e7454317f1c"}`. The commit the wrapper
could not withdraw does not reach origin.

**Repository positive control.** `git log --all --format=%H --grep='^Claude-Session:'` =
`0fc6cb83`, `51e5b16f`, `d9e415d9`; `git cat-file commit 0fc6cb83 | sed '1,/^$/d' | grep -ci
'^claude-session:'` = 1, and `0fc6cb83` is an ancestor of `a1be24e0`, below this PR's base.
Over this PR's own range, `for s in $(git rev-list a1be24e0..HEAD); do git cat-file commit $s
| sed '1,/^$/d' | grep -il '^claude-session:' && echo $s; done` prints nothing (9 commits at
`92b73ae7`, 10 with this round's), so G166 allows #1152's own publication.

**Tests** -- NEW `trident/gates/release-readiness.test.ts`, real git through a
`Bun.spawnSync` run host (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, as
`gates/fix-lineage.test.ts` does), each scratch repo with a base commit whose sha is the
launch base, a bare `origin` (so `ls-remote` answers and the gate reaches the scan), and
branch `change`; temp dirs removed in `finally`:

- (a) `:64` POSITIVE CONTROL: one clean commit with only `Co-Authored-By` -> `allow`.
- (b) `:72` one commit with a `Claude-Session:` paragraph -> exactly `blocked` with the
  `on` text naming that sha; `refs/heads/change` unchanged (the gate only reads).
- (c) `:81` `claude-session: lower` and `CLAUDE-SESSION: upper` -> blocked; `see
  Claude-Session: notes mid-line` -> allow (line-anchored).
- (d) `:95` carrier, clean, carrier -> blocked naming `<newest>, <oldest>` (rev-list order),
  the clean sha absent.
- (e) `:107` the trailer on a commit BELOW the launch base, one clean commit above ->
  allow (range-bounded: history already on main is not this publication's).
- (f) `:126` with the remote branch present (so the first-push ancestry arm is skipped and
  the scan is the only measurement of the base): launchBase `'b'.repeat(40)` -> unknown
  'Publication commit range could not be listed'; launchBase `'short'` -> unknown
  'Publication launch base is not a full OID' and, by a counting run host, no `rev-list`
  or `cat-file` argv was issued.
- (g) `:142` a run host that fails every `cat-file` -> unknown naming the sha; branch
  untouched.
- (h) `:154` carrier pushed to origin first (`ls-remote` names it) -> still blocked: the
  scan is unconditional, not inside the first-push arm.
- (i) `:164` a fake run host with no git: `rev-list` -> `'c'*40`, `cat-file` -> a raw
  object whose message is `subject\n\nClaude-Session: fake` -> blocked naming `'c'*40`;
  `rev-list` -> `not-a-sha` -> unknown 'Publication commit range listing is malformed'.

9 tests, all green (1.2s). `trident/build-host.test.ts` fake `run_host` (`:77-98`) gained
one arm, `rev-list` -> ok with empty stdout, before its `Unexpected command` throw: the
fake repo has no commits to scan, so every existing expectation in "publication readiness
measures local head, remote state and first-push ancestry" and the `publishGate` tests
holds unchanged (54 / 0, the baseline count). `trident/production-host-effects.test.ts`
publishes real commits ("Build fixture", no trailer) through the real gate and needed no
change.

**Mutation, proven by hand before nomination.**
`grep -c 'const sessionTrailerLine = /^claude-session:/i' trident/gates/release-readiness.ts`
= 1. Replacing it with `const sessionTrailerLine = /^(?!)/` (a pattern that matches nothing:
the scan runs, reads every commit, and never blocks) turns the guard
`bun test trident/gates/release-readiness.test.ts` to 4 pass / 5 fail -- exactly (b), (c),
(d), (h) and (i), each seeing `allow` where it expected `blocked` -- while the control
`bun test trident/gates/fix-lineage.test.ts` (never imports release-readiness) stays 6 / 0;
restored, the guard is 9 / 0. The pattern IS the acceptance: with it dead, every
trailer-bearing branch publishes with `allow`.

**Inventory.** `docs/trident-gates-inventory.md` gains row G166 (keep-in-place; production
anchors `release-readiness.ts:22`, `:35`, `:84`; test anchors
`release-readiness.test.ts:64`, `:72`, `:107`, `:154`; Silent: a trailer-bearing commit is
pushed to the public repository), indexed under "Publication and replay"; the summary
literals move 165 -> 166 entries and 155 -> 156 Silent (the awk enumeration in that
paragraph prints `166 3 156 10`); `trident/gates-inventory-citations.test.ts:10`
`toHaveLength(165)` -> `166` (1 / 0).

### Round 17: the third publisher scans too (`trident/publication.ts` `publishBuiltCommit`), and the two halves agree on an empty message

The round-16 head (`aae49bb8`) came back REQUEST_CHANGES from the independent reviewer
with one major, one minor and one nit. Each was reproduced against the real code before
anything was changed.

**MAJOR -- a third push site with no scan, and it is the path a refused wrapper commit
takes.** Round 16 said `publicationReadiness` is "called by BOTH publishers". Enumerating
push sites instead of publishers -- `grep -n "'push'" trident/*.ts` excluding tests -- gives
three origin-facing lease pushes (CORRECTED in round 18, below: that grep did not recurse
into `trident/gates/`, and there are four): `production-host-effects.ts` `publishChecked` (gated),
`build-host.ts` `publishGate` (gated), and `trident/publication.ts` `publishBuiltCommit`,
which had no scan at all (`grep -n 'release-readiness\|publicationReadiness\|claude-session'
trident/publication.ts` = 0 before this round). `publishBuiltCommit` is live on two
orchestrator paths: the `publish_requested` handoff (`orchestrator.ts:2379`) and
`reconcile_stranded` (`orchestrator.ts:1583`), which fires for every pr-mode run whose phase
becomes `failed` with commits above the base and records "branch <b> pushed to origin as PR
#N, unreviewed". That is exactly the trajectory of the defect G166 was added for: the
wrapper refuses (exit 69/70/74/76) and leaves the trailer commit on the branch; the build
fails or `publishChecked` blocks on G166; the run is recorded `failed`; `reconcile_stranded`
pushes the very commit the gate refused, as an unreviewed PR. And the replay
(`replay.ts:552-556`) re-commits the ORIGINAL message plus a replay note first, so the
trailer rides onto the replayed head. Reproduced with real git (the test file below, before
the fix): a branch whose one commit carries `Claude-Session:` was pushed to the bare origin
and `gh pr create` was issued.

Closed by ONE scan shared by every push site. `release-readiness.ts` now exports
`sessionTrailerReadiness(run, repo, launchBase, head): Promise<GateResult>` (`:63`), the
carrier scan folded into the gate result (`blocked` naming every carrier, `unknown` for a
range or object that could not be measured); `publicationReadiness` returns it verbatim at
the point where it used to inline the same three branches (`:104`, behaviour and text
unchanged, 11 / 0 in its own file). `publishBuiltCommit` calls it (`publication.ts:259`)
after the replay and the purity preflight -- so it measures the head that will be pushed,
`headToPublish`, not the pre-replay one -- and before the lease push, and THROWS on anything
but `allow`: `outer publisher refused to push branch <b>: <the gate's own text> -- nothing
was pushed; the branch stays local for inspection`. It is unconditional (the
already-at-head no-op path is after it, so a remote already at this head is scanned the
same as a first push, as the checked gate does) and fails closed (a range that cannot be
measured throws the same way as a carrier). In `reconcile_stranded` the throw lands in its
`catch`, which records the reason in the step note as `stranded build salvage failed:
<reason>` and leaves the run at "stranded work recorded without a publish" -- its ordinary
no-push outcome, not a publish. On the `publish_requested` path it is a publish failure
like any other, with the carrier shas in the reason.

The window is the review diff's own. `rebased.baseSha` (the observed base tip the head now
sits on) when the replay observed one; otherwise `resolvedDiffBase(run)` -- the same
left-hand side the review diff below is taken against (the launch pin, else the qualified
base ref) -- resolved to the commit it names by a new `commitOf` (`publication.ts:72`:
a 40/64-hex operand as given, else `git rev-parse --verify --quiet <ref>^{commit}`, '' when
it names none, so the scan refuses it as "not a full OID"). This is a superset of the
reviewer's proposed `rebased.baseSha || run.base_sha`: identical whenever a pin exists, and
still measurable for an unpinned legacy row where a hard `run.base_sha ?? ''` would have
refused every such publish as unmeasurable (measured: `orchestrator.test.ts` "a null base
pin skips the first-publish cut assertion" went red under the first cut for exactly that
reason, and is green under this one, 312 / 0).

**MINOR -- G166 refused a legitimately empty-message commit.** `spawnCapture` trims stdout,
so a commit made with `--allow-empty-message` (headers, `\n\n`, nothing) arrives with no
separator, and round 16 returned `unknown('Publication commit <sha> has no message')` --
a fail-closed refusal with a false detail, on a commit shape the wrapper in the same PR
deliberately preserves (`--allow-empty-message` honoured; "an empty commit with the trailer
in its -F file is rebuilt empty"). Closed at `release-readiness.ts:50`: a missing separator
after the trim IS an empty message (`const message = separator < 0 ? '' : ...`), which no
line of can carry the trailer, so it is measured clean. Every header line is `name value`
or a space-continued `gpgsig` line, so the first `\n\n` is always the header/message
boundary and never inside the headers; the `unknown` for an unreadable object is unchanged.

**NIT -- the Forge brief and its test said the wrapper "amends".** Since round 15 it rebuilds
with `commit-tree` and swaps the ref. `inner-workflow.mjs` `forgePushStep` now ends "...
because the wrapper may replace the commit it just created with a rebuilt one (the same
tree, parents and author, the trailer removed) and swap the branch onto it"; the
instruction itself (read commitSha with `git rev-parse HEAD`, never from a `[branch sha]`
line) is unchanged. `inner-workflow.test.ts` pins `rebuilt one` present and `may amend`
absent (153 / 0 in that file).

**Tests.** NEW `trident/publication-session-trailer-realgit.test.ts` runs the real
`publishBuiltCommit` against real git: a bare origin holding `main`, a full clone on
`trident/card-trailer` with one branch commit whose `-m` paragraphs are the fixture's
(the trailer as its own paragraph beside `Co-Authored-By`, the way the CLI reminder makes
the agent write it), `spawnCapture` for every command except `gh` (answered ok locally;
the PR probe reports 7 after `gh pr create`), the purity preflight stood down
(`skipped-no-gate`) so the scan is the only thing between the replay and the push:

- (a) `:127` POSITIVE CONTROL: only `Co-Authored-By` -> `{ pr: 7, head, push: 'pushed' }`,
  origin holds the head, `gh pr create` issued, and the `cat-file` of the branch commit
  precedes the `--force-with-lease` push in the recorded argv.
- (b) `:142` the trailer on the branch head -> throws naming the branch, the G166 text with
  the sha, and "nothing was pushed"; origin never saw the branch (`ls-remote` ''), no `push`
  and no `gh` argv, local branch and worktree untouched.
- (c) `:162` `main` moves after the cut so the publisher REPLAYS the branch: the replayed
  head (parent = the moved tip, message carrying the trailer through `replay.ts`) is the
  sha the refusal names; origin unchanged. This is the "replay carries the trailer" half of
  the finding, closed by scanning `headToPublish`.
- (d) `:188` a host that fails every `cat-file commit` -> throws `Publication commit <sha>
  could not be read`; nothing pushed.
- (e) `:206` origin loses `main` after the clone (the bare repo's HEAD is moved off it
  first, then `push --delete`), the run has no pin: `resolvedDiffBase` = `refs/heads/main`
  is resolved and the carrier is refused; `resolvedDiffBase` = a ref naming no commit ->
  `Publication launch base is not a full OID`, nothing pushed either way.

`trident/gates/release-readiness.test.ts` gains (j) `:183` an `--allow-empty-message`
commit (its raw object verified to contain no `\n\n` after the trim) -> `allow`, and an
empty commit beside a carrier still names the carrier; (k) `:202` `sessionTrailerReadiness`
directly: `allow` / `blocked` naming the carrier / the window is the caller's (measured to
the clean head, the later carrier is out of range) / '' base -> `unknown` 'not a full OID' /
a failing `cat-file` -> `unknown` naming the sha.

**Inventory.** The G166 row now states the guarantee for every push site (checked
publishers through `publicationReadiness`; the salvage push through the same exported scan
after the replay and before its lease push, failing closed on an unmeasurable range; an
empty message measured clean); production anchors `release-readiness.ts:22`, `:31`, `:63`,
`:104`, `publication.ts:259`; test anchors add `release-readiness.test.ts:183`, `:202` and
the five tests of the new file. Row count unchanged (166; the awk enumeration still prints
`166 3 156 10`; citations 1 / 0).

**Mutation, proven by hand before nomination (round 17).**
`grep -c 'sessionTrailerReadiness(opts.run_host, run.repo_path, trailerBase, headToPublish)'
trident/publication.ts` = 1. Replacing `trailerBase, headToPublish)` with `headToPublish,
headToPublish)` makes the salvage scan measure the empty range `head..head`: it runs, reads
nothing, and allows every branch. Measured: guard
`bun test trident/publication-session-trailer-realgit.test.ts` 0 pass / 5 fail mutated --
(b), (c), (d) and (e) see a push and a PR where they expected a refusal, and the positive
control (a) fails on its own assertion that the branch commit was read before the push --
and 5 / 0 restored; control `bun test trident/gates/release-readiness.test.ts` 11 / 0
either way (it never imports `publication.ts`). The window IS the guarantee on this path:
with it collapsed, the very commit G166 refused is pushed as an unreviewed PR.

### Round 18: the FOURTH push site scans too (`trident/gates/build-claim.ts` `checkBuildClaim`, G100), the salvage push names the object, and the wrapper runs one argv scan

The round-17 head (`6818b39a`) came back REQUEST_CHANGES from the independent reviewer
with one major, one minor and one nit. Each was reproduced against the real code before
anything was changed.

**MAJOR -- a fourth origin-facing push with no scan: G100's preservation push.** Round 17
enumerated push sites with `grep -n "'push'" trident/*.ts`, which does not recurse, so it
never saw `trident/gates/build-claim.ts:32`. The card's own criterion is a grep WITH a
positive control, not memory, so the enumeration was redone recursively:
`grep -rn "'push'" trident --include=*.ts | grep -v '\.test\.'` at this head lists
`production-host-effects.ts:377` (the checked publisher, gated), `publication.ts:304`
(the salvage publisher, gated since round 17), `gates/build-claim.ts:50` (THIS finding),
`merge.ts:1686` (the local-mode merge, which pushes the merge commit to `main` -- commits
already published through G166 -- not a build branch), `merge.ts:2147` (`push origin
--delete <branch>` after a merge: a delete, nothing published) and
`wrong-base-remedy.ts:536` (a token index in a command scrubber, not a push). The positive
control is that the grep names the three sites the previous rounds gated. So there are
FOUR origin-facing pushes of a build branch, and `checkBuildClaim` was the one with no
scan: `grep -rn 'sessionTrailerReadiness\|publicationReadiness' trident --include=*.ts |
grep -v '\.test\.'` before this round = `build-host.ts:226`, `production-host-effects.ts:369`,
`publication.ts:259` and nothing under `gates/build-claim.ts`.

Why it matters: G100 fires when a build or fix worker's claimed head resolves to a commit
other than the measured head (`build-run.ts:418-424` -> `deps.checkBuildClaim`), and it
pushes the measured head to origin BEFORE refusing, so the work is preserved. That is
exactly the state the wrapper's exit 76 leaves: its stderr tells Forge "the commit this
invocation created is reachable from $new_head", Forge reports its own sha, the host
measures the later one, and G100 preserves the branch -- with the wrapper's trailer commit
reachable from it -- onto the public remote. Reproduced with real git before the fix
(`trident/gates/build-claim-realgit.test.ts`, the carrier test): branch `trident/card` =
base <- own(`subject`, `Claude-Session: ...`) <- foreign(`foreign on top`);
`checkBuildClaim(host, repo, 'trident/card', own.slice(0, 7), { head: foreign })` returned
`blocked 'Build claim ... branch preserved on origin'` and origin's `refs/heads/trident/card`
held `foreign` with `own` (`cat-file commit` containing `\nClaude-Session:`) reachable.

Closed in the round-17 shape: `checkBuildClaim` takes the run's launch base as a new
parameter (`checkBuildClaim(run, repo, branch, launchBase, claim, snapshot, runId)`;
`build-host.ts:143` threads `options.leak.base_sha`, the same pin `publishGate` hands
`publicationReadiness` two lines below) and calls
`sessionTrailerReadiness(run, repo, launchBase, snapshot.head)` (`build-claim.ts:45`)
after the lease observation and IMMEDIATELY before the push. On anything but `allow` it
does NOT push and returns `blocked` with the gate's own text appended:
`Build claim <c> resolves to <r> but measured head is <h>; branch NOT preserved on origin:
<Publication branch carries a Claude-Session trailer on N commit(s) above the launch base:
<shas> | the unknown detail>`. `blocked`, not `unknown`, on an unmeasurable range: the
claim conflict is a MEASURED fact whichever way the scan goes, so the run's outcome
(`failed`, `built-head-unverified`) is the same; only the side effect -- the push -- is
withheld, and the reason is in the text. The successful path is byte-identical to before
(`...; branch preserved on origin`), and a remote already holding the measured head still
needs neither scan nor push (there is no push to guard).

**Tests.** NEW `trident/gates/build-claim-realgit.test.ts` runs the real gate against real
git and a bare origin, `spawnCapture` for every command with the argv recorded: (a) `:90`
POSITIVE CONTROL, a claim conflict on clean history -> `blocked '...; branch preserved on
origin'`, origin holds `foreign`, the push argv is exactly
`push --force-with-lease=refs/heads/trident/card: origin <foreign>:refs/heads/trident/card`,
and the `cat-file` of BOTH branch commits precedes it; (b) `:108` the carrier -> `blocked
'...; branch NOT preserved on origin: ...1 commit(s) above the launch base: <own>'`, no
`push` argv at all, origin `ls-remote` empty, local branch untouched; (c) `:124` a launch
base naming no object -> `blocked '... NOT preserved on origin: Publication commit range
could not be listed'`, nothing pushed. `trident/gates/build-claim.test.ts` (fake host)
threads the base through every existing call, pins the new call order (`check-ref-format`,
`rev-parse`, `ls-remote`, `rev-list`, `cat-file`, `push`, `ls-remote`) and the rev-list argv
(`--end-of-options <base>..<head>`), and adds `:79` a carrier -> the exact blocked text and
no push; `:91` '' / failing rev-list / failing cat-file -> the exact blocked text naming
each detail and no push; `:106` a remote already at the head -> no rev-list and no push.
`trident/build-host.test.ts` `:811` runs the COMPOSED host against real git with a
trailer-bearing built commit and `leak.base_sha` = the base: the deps' `checkBuildClaim`
refuses `NOT preserved` and origin has no `refs/heads/change`; the existing composed G100
test sets `leak.base_sha` to its real base (the fixture default `'b' * 40` names no
object, which the scan now refuses) and pins the `preserved on origin` text.

**MINOR -- the salvage push sent the REF, the scan measured the OBJECT.** `publication.ts`
scanned `headToPublish` but pushed `refs/heads/<branch>:refs/heads/<branch>`, so a writer
moving the local branch between the scan and the push published an unscanned commit and
the witness (`remoteHead !== headToPublish`) threw only after it was on origin. Closed: the
refspec is `${headToPublish}:refs/heads/${branch}` (`publication.ts:307`), the shape the
checked publisher and G100 already use; the scanned object is the pushed object by
construction. Pinned in `publication-session-trailer-realgit.test.ts` (a) (the recorded
push argv is exactly `push --force-with-lease=refs/heads/<b>: origin <tip>:refs/heads/<b>`),
`orchestrator.test.ts` "pr mode publishes and re-fires review" (the fake-host argv now
carries `<head>:refs/heads/feat-x`), and `publish-rebase-realgit.test.ts` `leasePush`, the
replica of this push, which now takes the head and pushes it (its lease-refusal test
still refuses: the lease, not the refspec, is what a third-party advance trips).

**NIT -- the wrapper's `--amend` detection read option values as options.** The signing
scan skipped the value of `-m`, `-F`, `--author`, ... (round 10); the `--amend` loop did
not, so `-m '--amend'` set `amending=1`, derived the expected parent as HEAD's parent, saw
HEAD as the new commit's first parent, and refused a legitimate commit with exit 76 and the
trailer left on the ref. Closed by ONE scan: `scan_commit_argv` (`:131`), run once before
the commit (`:169`), decides `amending`, `sign_flag` and `allow_empty_message` by the same
value-skipping and cluster rules; the second loop inside the strip block is gone and the
rebuild reads the three variables. Real-git test `:1269`: positive control first (the same
paragraph delivered BARE is an amend of the root commit -- one word in `rev-list
--parents`), then `-m '--amend' -m <trailer> -m <co-author>` lands as an ordinary commit
whose first parent is the fixture parent, message `--amend\n\n<Co-Authored-By>`, exit 0.
Restoring the old loop after the scan (`for arg in "$@"; do [ "$arg" = --amend ] &&
amending=1; done`) reds exactly that test (52 / 1); restored 53 / 0.

**Inventory.** G166 now names all four push sites, the object-not-ref refspec, and the
recursive grep with its exclusions; production anchors add `publication.ts:307`,
`gates/build-claim.ts:45-46`; test anchors add the three new real-git tests, the two
fake-host tests and the composed-host test. G135 gains the one-scan sentence and
`commit-with-resolved-head.sh:131`; its wrapper code anchors are re-numbered for the moved
scan (`:125` -> `:170`, `:176` -> `:221`, ...) and the new test is cited. Row count unchanged
(166; citations 1 / 0).

**Mutation, proven by hand before nomination (round 18).**
`grep -c 'const trailers = await sessionTrailerReadiness(run, repo, launchBase, snapshot.head)'
trident/gates/build-claim.ts` = 1. Replacing that line with
`const trailers: GateResult = { kind: 'allow' }` is the pre-round-18 gate: the scan never
runs and every claim conflict is preserved. Measured: guard
`bun test trident/gates/build-claim-realgit.test.ts` 0 pass / 3 fail mutated -- the carrier
test sees a push and origin at `foreign`, the unmeasurable-range test sees a push, and the
positive control fails on its own assertion that both commits were read before the push --
and 3 / 0 restored; control `bun test trident/gates/release-readiness.test.ts` 11 / 0
either way (it never imports `build-claim.ts`). The fake-host `build-claim.test.ts` also
goes 6 / 3 under the mutation, which is why it is not the control.

### Mutation, proven by hand before nomination

`grep -c '\[Cc\]\[Ll\]\[Aa\]\[Uu\]\[Dd\]\[Ee\]-\[Ss\]\[Ee\]\[Ss\]\[Ss\]\[Ii\]\[Oo\]\[Nn\]:\*) drop\[i\]=1; removed=1 ;;'
trident/commit-with-resolved-head.sh` = 1. Replacing that case arm with
`[Cc][Ll][Aa][Uu][Dd][Ee]-[Ss][Ee][Ss][Ss][Ii][Oo][Nn]:*) drop[i]=0 ;;` (the trailer is
matched and kept) turns 16 of the 29 tests in `commit-with-resolved-head-realgit.test.ts`
red (every strip test, including three added this round) while
`runtime/adapters/claude-code/persistent/__tests__/build-settings.test.ts`, which never runs
the wrapper, stays green (15 pass); restoring the arm returns the guard to 29 / 0. That was
round 10's nomination.

Round 15 nominates the publish compare-and-swap's expected value (step 6 of the round-14
section above). `grep -c 'git update-ref -m "commit-with-resolved-head: strip Claude-Session
(rewrite $new_head)" "$target_ref" "$candidate" "$new_head"' trident/commit-with-resolved-head.sh`
= 1. Dropping the trailing `"$new_head"` argument (`sed 's|"$target_ref" "$candidate"
"$new_head" 2>|"$target_ref" "$candidate" 2>|'`) makes the swap blind: the ref is moved
to the candidate whatever it names. Measured: guard
`commit-with-resolved-head-realgit.test.ts` 51 pass / 1 fail mutated -- exactly the
lost-swap test ("a commit another writer landed INSIDE the read-back loses the publish
compare-and-swap"), which sees exit 0 and `[feat: subject, base]` with the other writer's
commit gone from the branch -- and 52 / 0 restored; control `trident/inner-workflow.test.ts`
153 / 0 either way. The same-shim positive control inside that test (no arm, exit 0) is
what keeps the shim from being mistaken for the cause.

Round 14 nominated the measured post-condition (the round-13 section above).
`grep -cF 'if strip_session_trailer <"$raw_after" >/dev/null; then'
trident/commit-with-resolved-head.sh` = 1. Replacing that line with `if false; then`
restores the round-13 behaviour exactly: the read-back runs but its answer is never acted
on, so a `prepare-commit-msg` hook that puts the trailer back on the amend leaves the
wrapper exiting 0 with "trailer stripped" on stdout and the trailer on the branch.
Measured at the round-14 tree: guard `commit-with-resolved-head-realgit.test.ts` 40 pass /
1 fail mutated (exactly the prepare-commit-msg test: it saw exit 0 instead of 73 and the
trailer in the branch log) and 41 / 0 restored; control `trident/inner-workflow.test.ts`
153 / 0 either way. At the round-15 tree that anchor line is gone with the amend (the
post-condition is now `if strip_session_trailer <"$raw_after" >/dev/null; then` over the
CANDIDATE object, before any ref names it; the fixture's `REVIEW_MUTATION=bypass` on that
same anchor reds the shimmed-commit-tree test, which sees exit 0 and the trailer on the
branch).

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


Round 8 nominated `--only` on the amend (`git commit --amend --only --no-verify` -> without
`--only`, the pathspec test red). At the round-15 tree the amend is gone: the rebuild
reads no index at all (`commit-tree` takes the object's own tree), and the pathspec test
stands as the guard that it never does. (The round-8 pattern mutation on
`-e '^Claude-Session:'` no longer applies either: that grep is gone.)

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
  rebuild failure takes.
- A hex check on the re-probe answer: not added. It is only ever compared with the probed
  HEAD or handed to git as the expected value of a compare-and-swap, which git validates
  itself; it is never used as a sha by the wrapper. (The `commit-tree` answer IS checked
  for hex, because it becomes the new value of the ref.)
- The same-parent SIBLING residual (round-14 finding 3): `git commit` returns no oid, so a
  commit another writer landed from the same parent inside the gap, replacing this
  invocation's, cannot be told from the wrapper's own. Not claimed closed. The rewrite is
  content-preserving, so the worst case is that such a sibling loses a `Claude-Session:`
  line of its own.
- A commit with a `mergetag` header (a signed-tag merge concluded through the wrapper) is
  refused with exit 75 rather than rebuilt: `commit-tree` cannot carry the header, and a
  rebuild that dropped it would publish a different commit than the one git made. Forge
  never concludes a signed-tag merge.
- An `encoding UTF-8` header, if an object ever carried one, is not reproduced (git itself
  never writes it; `commit-tree` writes `encoding` only for a non-UTF-8 value). The
  post-condition compares tree and parents, not the encoding header.
- `pinnedMergeReadiness` (merge time) does NOT scan: the merge is of commits already
  published through G166, and a PR published by a pre-G166 host is out of scope for this
  card. The CI leak gate's `--messages-only` half is not extended either: it runs after the
  push, when the message is already public, which is the wrong side of the boundary.
- A pre-commit strip of `-m` values in the wrapper: not added. The post-commit strip already
  covers every message source (`-m`, `-F`, `-C`, the editor, hooks), and a second filter over
  argv would have its own edge cases for the guarantee the scan now gives at the boundary
  that matters. One filter, one guarantee, one scan.
- The scan reads only `launchBase..head`: a trailer on a commit below the pinned base is
  main's history, not this publication's, and refusing it would block every branch off a
  main that once carried one (`0fc6cb83` does).
- Snapshotting and restoring the sequencer state a withdrawn commit consumed: still not
  done; the loss is named on stderr (unchanged from round 10).
- `merge.ts:1686` (the local-mode merge push of the merge commit to the base branch) and
  `merge.ts:2147` (`push origin --delete <branch>` after a merge) do NOT scan: the first
  pushes commits already published through G166 to `main`, the second publishes nothing.
  They are in the recursive enumeration above so the next reader does not have to
  re-derive why.
- `unknown` vs `blocked` when G100's scan cannot measure the range: `blocked`, because the
  claim conflict is already measured and the outcome is the same; the withheld push is
  named in the text. An `unknown` here would re-run a refusal that is already certain.
- `docs/AS_BUILT.md` and every existing shard: frozen; this record is a new shard.

### Effect after merge

The settings switch takes effect on the next REPL spawn from a deployed tree that carries
it; warm REPLs keep their old `--settings` file until they respawn. The wrapper strip takes
effect on the next Forge commit from a checkout that carries it, whatever the REPL's settings
say. The commit that landed round 8 was itself authored through the wrapper with a
deliberate `Claude-Session: https://claude.ai/code/session_01PROOF` paragraph on its argv,
and carries none; every later round's commit, this one included, was authored through the
wrapper without such a paragraph and carries none. G166 takes effect on the next
publication from a DEPLOYED tree that carries it: the publisher runs in the host process,
so a merge of this PR changes nothing until that host is redeployed, and a PR published by
a host from before the deploy was never scanned. Merged is not shipped.

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

Round 15 is the fix commit on top of round 14 (`c80d4b92`, all seats APPROVE, the
independent reviewer REQUEST_CHANGES with the one major above; the run was stopped by a
host progress-gate tie, not by the work), on the same base `a1be24e0`: the fresh worktree
was fast-forwarded to the published head (`git merge --ff-only`, no cherry-pick, no
conflict) and one commit replaces the post-commit half of the wrapper with the ref+object
provenance model. It touches only the wrapper, its real-git tests, the G135 row and this
record; the settings switch, the Forge brief, the strip filter and the Co-Authored-By
handling are untouched. The full suite is deferred to this plan's terminal task by the
host's instruction; this round ran the wrapper's own real-git file and the Forge-brief file
(52 + 153, all green) and the trident typecheck.

Round 16 is the terminal task of run `07bd885d`, one commit on top of round 15 (`92b73ae7`,
the task-2 commit of the same run, unpublished at plan time; origin's #1152 head is still
`c80d4b92`), on the same base `a1be24e0`, in the same worktree. It closes finding 0 where
it can be closed -- at the publisher, G166 -- and touches only
`trident/gates/release-readiness.ts`, its new real-git test file, the `rev-list` arm in
`trident/build-host.test.ts`, the G166 row and the two count literals in the inventory,
the 165 -> 166 literal in `trident/gates-inventory-citations.test.ts`, and this record. The
wrapper, its 52 tests, the settings switch, the Forge brief and the Co-Authored-By handling
are untouched. Stage 1 (file-scoped, the branch's six changed test files: the new file,
`build-host.test.ts`, `gates-inventory-citations.test.ts`,
`commit-with-resolved-head-realgit.test.ts`, `inner-workflow.test.ts` and
`build-settings.test.ts`) = 284 pass / 0 fail in 9.2s, with `gates/fix-lineage.test.ts`
6 / 0 as the mutation control; `scripts/ci/typecheck-all.sh` = 50 of 51 tsconfigs pass,
`trident/tsconfig.json` among them, the one FAIL being `app/tsconfig.json` TS2688 ("Cannot
find type definition file for '@types'") from the parent checkout's self-referential
`node_modules/@types` link, environmental and unrelated to this diff; `scripts/ci/lint.sh`
clean (DIFF-BASE 0 found in 187 files -- the new range goes through `gitRangeArgv`). The
host's build brief for this task instructed the full suite DEFERRED ("INTERMEDIATE TASK of
a multi-task plan ... do NOT run the full suite this iteration"), which contradicts the
plan step's "terminal, remainingTasks 0"; the brief is the contract the host verifies, so
the full suite was not run here and the result reports `suiteOutcome: deferred` -- CI on
the published head is the whole-branch run.

Round 17 is the fix commit on top of round 16 (`aae49bb8`, REQUEST_CHANGES from the
independent reviewer with the three findings above), on the same base `a1be24e0`, in the
same worktree. It touches `trident/gates/release-readiness.ts` (the exported scan, the
empty-message case), `trident/publication.ts` (the salvage-path scan and `commitOf`), their
tests (the new `publication-session-trailer-realgit.test.ts`, two cases in
`release-readiness.test.ts`), the Forge brief sentence in `trident/inner-workflow.mjs` and
its pin in `inner-workflow.test.ts`, the G166 row, and this record. The wrapper, its 52
tests, the settings switch and the Co-Authored-By handling are untouched. Stage 1
(file-scoped, the branch's seven changed test files: `build-settings.test.ts`,
`build-host.test.ts`, `commit-with-resolved-head-realgit.test.ts`,
`gates-inventory-citations.test.ts`, `release-readiness.test.ts`, `inner-workflow.test.ts`
and the new file) = 290 pass / 0 fail in 11.4s; beyond the stage-1 budget, the three
fake-host consumers of `publishBuiltCommit` were run because the new throw could have
reached them -- `orchestrator.test.ts` 312 / 0, `production-host-effects.test.ts` and
`publish-rebase-realgit.test.ts` green (424 / 0 across the three); `tsc --noEmit -p
trident/tsconfig.json` exit 0. The full suite stays deferred to the terminal task by the
host's instruction.

Round 19 is on a NEW base. Run `07bd885d` (rounds 15-18) ended `failed` at G063 `FULL SUITE
NOT PROVEN`: the host suite ran 1610 / 1610 files with two reds outside this PR's diff (a
bundle-runtime worktree artefact and `scripts/ci/typecheck-worktree.test.ts`, red on main
too), and the repairs for both were merged and deployed as #1172, #1173, #1174 and #1176 --
origin/main `822488b2`. The round-18 head `bb6065b4` was published as PR #1152 and its
round-3 review was unanimous APPROVE, but no receipt approved the next head. This round's
worktree was created from `822488b2`; it re-lands `bb6065b4` by `git merge --no-ff`
(merge-tree clean, tree `47569824`, no conflict; never a reset, so the deployed G063
repairs stay in the ancestry) and adds one commit on top: the bounded provenance and
raw-graph repair (8 files, +411/-35 against `bb6065b4`, applied as a single `format-patch`;
its own record is `docs/as-built/commit-wrapper-and-raw-publication-integration.md`) and the
G100 reconciliation. The repair: the wrapper refuses WITHOUT withdrawing when the initial
`cat-file` of the observed commit fails (provenance unknown, so the compare-and-swap could
discard a foreign commit; measured at `bb6065b4` as exit 8 with the foreign commit lost),
publishes and withdraws through a prepared `git update-ref --stdin` transaction with
`no-deref` that checks the captured ref is still direct while its lock is held (a branch
switch or symref attachment inside the gap is refused, `refs/heads/other` and `main` left
alone; measured at `bb6065b4` as `refs/heads/other` rewound), and honours `--no-amend` and
`--no-allow-empty-message`; the shared scan walks `launchBase..head` with
`--no-replace-objects --shallow-file /dev/null -c core.commitGraph=false` under
`GIT_GRAFT_FILE=/dev/null` and reads each object with `--no-replace-objects` (measured at
`bb6065b4`: `git replace` of the carrier and a `.git/shallow` boundary both turned the scan
to `allow` while the raw carrier remained). The G100 reconciliation is the owner decision of
2026-09-19: round 18 had `checkBuildClaim` refuse `branch NOT preserved on origin` and push
nothing on a carrier or an unmeasurable range, which superseded the G100 row's preservation
guarantee; now the scan still runs before the push over the same raw objects and its result
is named in the refusal (`; branch preserved on origin; preserved range: Publication branch
carries a Claude-Session trailer on N commit(s) above the launch base: <shas> -- strip
before any PR`, or `; session-trailer scan unmeasured: <detail>`), and the push is never
withheld. The checked publishers and the salvage push stay fail-closed; G139's advisory
leak-preflight semantics are untouched (`trident/publication.ts` preflight code is
byte-identical to main). The three tests that had encoded the veto now assert the push argv,
the scan-before-push order, origin holding the measured head and the carrier named. The
G100, G139 and G166 inventory rows were reworded and every `file:line` anchor in the G100,
G135, G139 and G166 rows was re-measured on this tree. Verification on the final head:
the eight named trident files 470 / 0, `open/__tests__/project-build-e2e.test.ts` 89 / 0,
stage 1 (the branch's 11 cumulative changed test files plus `inner-workflow-gates.test.ts`,
which names a changed module) 770 / 0 across 13 files; both `tsc` projects exit 0; the
eight-mode wrapper fixture and the raw-graph probe as recorded in the repair's own as-built;
five mutations (four under, one over) each red on the tests that guard them and reverted
before the final run. `grep -rn 'NOT preserved on origin' trident` returns nothing, with
`branch preserved on origin` as the positive control; the round's commits carry
`Co-Authored-By` and no `Claude-Session:` line (`git log --format=%B` over the range, both
counts). The full suite is the host's terminal receipt on the published head; this task
reports it deferred as the brief instructs.

### Round 20: the listing argv is plain `git`; `GIT_GRAFT_FILE` rides in the runner's `extraEnv`

Round 19's `env GIT_GRAFT_FILE=/dev/null git …` prefix red 7 tests in the salvage path's two
consumer suites (their host doubles admit only `git`/`gh` and throw otherwise; the throw
escaped `publishBuiltCommit` and the salvage recorded no PR; CI shards 2/4 and 3/4 red on
`bdc7ac05`, green on main). The listing is now the plain `gitRangeArgv` with the graft
override as the typed `extraEnv` third parameter (`RAW_GRAPH_ENV`,
`trident/gates/release-readiness.ts:28`, `:60`) and `advice.graftFileDeprecated=false` in the
raw-graph config so the graft-file hint never reaches a captured stderr. A git-only host
double now guards the contract (`trident/gates/release-readiness.test.ts:84`), the quiet
listing is pinned (`:108`), and the comments and the G166 row say what `publishBuiltCommit`
is: every legacy-loop publication as well as the salvage push. The stale-pin scan-window
constraint (a lane pinned before `0fc6cb83` that merges main is refused naming main's own
carrier) is documented in the row and the gate comment. Details, mutations and measurements
in `docs/as-built/commit-wrapper-and-raw-publication-integration.md` (round 20).

### Round 21: carried onto main `1cddbd9b` by merge; re-verified, nothing red

Run `c6cc0c1f` (rounds 19-20) ended on an infra timeout, not a rejection: independent review
on `668404e8` was APPROVE and CI 12/12 green. Round 21 continues that head on the launch base
`1cddbd9b` (main at #1179, two commits past the deployed `822488b2`) by MERGE, never reset —
`git merge --no-ff --no-commit 668404e8` (merge-base `822488b2`, no conflicts; the merged tree
equals the `merge-tree --write-tree` dry run, `4974c189`), committed through
`trident/commit-with-resolved-head.sh` with `Co-Authored-By` and no `Claude-Session:`
paragraph (`git cat-file -p HEAD | grep -c '^Claude-Session'` = 0; positive control: 20 hits
in the wrapper source). Instructions 2-5 of the repair scope were not redone.

Re-verified on the cumulative head (bun 1.3.13, git 2.43.0, worktree-local install):
`commit-with-resolved-head-realgit`, `gates/release-readiness`, `gates/build-claim` +
`build-claim-realgit`, `publication-session-trailer-realgit`, `build-host`,
`stranded-salvage-realgit`, `inner-workflow`, `orchestrator`, `publish-rebase-realgit`,
`gates-inventory-citations`, `build-settings` — 697/697; `open/__tests__/project-build-e2e`
(changed on main by #1170/#1179, so run on the merged tree, not read from the PR's CI) —
103/103; `tsc -p tsconfig.json` and `tsc -p trident/tsconfig.json` both clean. Under-direction
mutations, each restored before the next: the wrapper strip disabled (`if false; then`) reds 44
of 66 in `commit-with-resolved-head-realgit`; the gate's carrier refusal disabled reds 12 of 19
in `gates/release-readiness` (every "cannot conceal a carrier" case among them); the raw-graph
controls dropped (`rawGraph = []`, `RAW_GRAPH_ENV = {}`) reds 6 of 19, the parent-replacement,
shallow-boundary, graft and missing-raw-parent cases among them. Over-direction: the real
`sessionTrailerReadiness` under `spawnCapture` allows this branch's own publication range
(`1cddbd9b..HEAD`, 16 commits, and `822488b2..HEAD`), and the same runner blocks a scratch
repo's one synthetic carrier, naming its sha; the merge commit itself went through the wrapper
unrewritten (no strip line, HEAD equals the commit summary sha). No fix was needed.

### Round 22: codex finding closed — the empty-message read is measured, not assumed

Round 21's cross-model reviewer raised one major on `trident/gates/release-readiness.ts`
`sessionTrailerCarriers`: a successful `cat-file commit` whose stdout carried no `\n\n`
separator was read as a measured EMPTY message and ALLOWED, so a response truncated mid-header
would have waved an unmeasured carrier through. The premise is refuted for the production path
— `spawnCapture` (`trident/git-mode.ts`) reads the whole stream (`new Response(proc.stdout)
.text()`) and caps nothing — but `run` is an INJECTED `RunHostCommand`, so the fail-closed
property must not rest on the injected runner's behaviour. STATED EXACTLY (narrowed in round 23
after the round-22 review nit; the code is unchanged by that narrowing): both reads go through
the same injected `run`, so a runner that truncated the object AND answered `-s` with the
truncated length would still be believed. What round 22 establishes is the property the cap
class needs — a runner whose SMALL outputs are faithful can no longer conceal a carrier behind
a truncated large one, because the two reads are independent commands of very different output
sizes. It is not a property that survives an arbitrary runner, and neither the docblock
(`trident/gates/release-readiness.ts:86`-`:96`) nor this record claims one.

**The rule.** Every capture is now weighed against the object's OWN size, read separately with
`git --no-replace-objects -C <repo> cat-file -s <sha>` (`rawCommitSize`,
`trident/gates/release-readiness.ts:37`). `--no-replace-objects` on that read too: a
replacement object could otherwise report the substitute's size and make a short read of the
real object look whole. The answer must be a strict decimal (`/^(?:0|[1-9][0-9]*)$/` after
trim) — an exit-0 call with empty or non-numeric stdout is a measurement of nothing, not a
zero. Then `missing = size - Buffer.byteLength(stdout, 'utf8')`, and only a gap the OBJECT'S
OWN TERMINATORS explain is clean (`:124`-`:136`):

- `missing < 0` → `unknown` (a non-UTF-8 body inflated by U+FFFD decoding lands here; the
  loop's own commits are UTF-8 and fail-closed is the answer).
- no `\n\n` at all → allowed as an empty message ONLY when `missing === 2` AND the capture
  still starts with a well-formed `tree` header (`treeHeaderLine`, `:49`; the predicate is
  `:131`). Otherwise `unknown`, naming the sha and the gap.
- `\n\n` present → complete when `missing` is 0 (an untrimming runner delivered every byte) or
  1 (the message's single terminating newline, which git's default cleanup always stores).
  `missing >= 2` → `unknown`. Round 22 justified the 1-byte tolerance with "a one-byte cut of a
  `Claude-Session:` line still leaves a matching line"; that is true of every shape git's
  DEFAULT cleanup stores and NOT universally, so round 23 replaced the justification with a
  check — see the round-23 section below. (Round 30: `missing >= 3` → `unknown`; see there.)

**Measured fixtures (git 2.43.0, bun 1.3.13).** An `--allow-empty-message` commit is a 178-byte
object whose tail is `0a 0a`; every header line ends in a non-whitespace byte, so a trimming
runner strips exactly those two bytes and nothing else — that is the ONLY shape a headers-only
capture may legitimately have. An ordinary `-m` commit is 217 bytes ending in a single `0a`
(trimmed: `missing === 1`). `git commit-tree -F` stores the message verbatim, adding and
stripping nothing (163 / 130 / 149 / 136 bytes for a normal, empty, no-trailing-newline and
trailing-blank message), and the wrapper's `strip_session_trailer` stops at the last kept line,
so a wrapper-rebuilt commit is one of FOUR measured shapes (round 30; this said three). The 4th: a
plain call ending in trailer paragraphs keeps the blank BEFORE them — 196 bytes ending `subj\n\n`,
194 trimmed, `missing === 2` beside a boundary. STATED BOUNDARY (round 30; was "two or more"):
THREE or more trailing whitespace bytes (`--cleanup=verbatim` `printf 'feat: v\n\n\n'`, 188 bytes,
`0a 0a 0a` tail) are `unknown` through a trimming runner — a refusal NAMING the gap, never a pass.

**Regressions** (`trident/gates/release-readiness.test.ts`). A fake host returns a short read
while answering `cat-file -s` with the FULL object's length (real git never truncates, so a
double is the only way to measure this; `-s` is matched BEFORE the generic `cat-file` branch,
`:322`-`:337`): cut mid-header, cut exactly at the header/message boundary (the codex case),
cut one byte past the last header line, and cut inside the message so the trailer line is gone
— all four `unknown`, each naming the sha and the byte gap. `:339`: a capture longer than the
object, and six unmeasurable `-s` answers (failure, empty, `sixteen`, `0x10`, `-1`, `012`), all
`unknown`. `:358`: the check does not over-reject — a whole object and one short by its own
terminating newline are both still SCANNED, and the carrier is still named. `:372`: real git,
both runner shapes — an `--allow-empty-message` commit is ALLOWED through the untrimming double
(`missing === 0`, the raw object ends `\n\n`) and through `productionRun`/`spawnCapture`
(`missing === 2`, the capture contains no `\n\n`), and a carrier beside it is still refused
either way. `trident/gates/build-claim.test.ts` gained the size answer in its fixture and now
pins the `-s` argv (`--no-replace-objects`) and the scan's position before the push.

**Mutations, run and restored (guard `bun test trident/gates/release-readiness.test.ts`;
control `bun test trident/gates/build-claim.test.ts`).** Under-direction: (1) the empty-message
predicate always true (`const emptyMessage = true`) → 3 red, the two boundary-cut cases among
them, control 9/9 green; (2) the separator-present gap widened (`missing > 1` → `missing > 99`)
→ 1 red (cut inside the message); (3) an unmeasurable size assumed complete
(`?? Buffer.byteLength(object.stdout, 'utf8')`) → 2 red. Restored: 25/25 green.
Over-direction: the pre-existing real-git allows (a clean `Co-Authored-By` range `:176`, the
production runner with a shallow view `:128`) and the real-git carrier refusal (`:184`) stay
green unmutated.

**Verification on the cumulative head** (bun 1.3.13, git 2.43.0): `gates/release-readiness`,
`publication-session-trailer-realgit`, `gates/build-claim` + `build-claim-realgit`,
`commit-with-resolved-head-realgit`, `build-host`, `gates-inventory-citations` — 166/166;
`stranded-salvage-realgit`, `inner-workflow`, `orchestrator`, `publish-rebase-realgit`,
`gateway/composition/build-core-modules-trident-stranded-sweep` — 523/523;
`open/__tests__/project-build-e2e` + `build-settings` — 118/118. `tsc --noEmit -p
tsconfig.json` and `tsc --noEmit -p trident/tsconfig.json` both clean. Positive control for the
absence claim: `grep -c 'Claude-Session' trident/gates/release-readiness.ts` still hits the
regex and its docblock, while this round's commit message carries none. The G166 row in
`docs/trident-gates-inventory.md` states the completeness clause and its citations are
refreshed; G100 and G139 are untouched.

### Round 23: the tolerated byte gap is weighed against the token, and the cross-check's reach is stated

Round 22's independent review returned APPROVE with two nits, both on
`trident/gates/release-readiness.ts`. Both are closed here; nothing else changed.

**Nit 1 — a 1-byte gap could drop the colon that makes the trailer line match.** The tolerance
was justified by "a 1-byte cut of a `Claude-Session:` line still leaves a matching line". That
holds for every shape git's DEFAULT cleanup stores, and not for `--cleanup=verbatim`. MEASURED
(git 2.43.0): `printf 'feat: subject\n\nClaude-Session:' > msg && git commit --cleanup=verbatim
-F msg` stores a 144-byte object whose tail is `0a 0a 43 6c 61 75 64 65 2d 53 65 73 73 69 6f 6e
3a` — the colon is the object's LAST byte. A runner one byte short hands back a last line of
`Claude-Session`, which `sessionTrailerLine` (`:22`, anchored `/^claude-session:/i`) does not
match, so an unmeasured carrier was ALLOWED.

**The rule.** Both tolerated gaps — 1 byte with a header/message boundary, 2 bytes without —
now go through `gapCouldCompleteTrailer` (`trident/gates/release-readiness.ts:68`-`:74`, called
at `:172` and `:176`); a gap it flags is `incompleteRead`, `unknown`, naming the sha and the
gap (`: the gap could complete a Claude-Session line`). The missing bytes sit at the very END of
the capture, so the only line a gap can extend is the LAST one, and `sessionTrailerLine` is a
fixed 15-byte literal anchored at a line start. A gap of `missing` bytes can therefore flip a
non-matching last line into a matching one for exactly one shape — the last line is the leading
`15 - missing` bytes of the token, case-folded — because any other byte the gap could hold
either starts a new line (a lone `\n`, which cannot match) or lands on a line that ALREADY
matched, and an already-matching line is counted as a carrier, never allowed. `toLowerCase()`
folds more than the ASCII-only regex does; that is the fail-closed direction (it can only
over-refuse, and every ASCII case-variant the regex would match is still caught). A gap at
least as wide as the token could carry a whole trailer line and is never clean — no caller
tolerates one today, and the branch keeps that true if one ever did.

STATED BOUNDARY (new, and the price of the check): a clean commit whose message's FINAL line is
exactly `Claude-Session` with no colon is reported `unknown` through a trimming runner, because
its 1-byte gap is indistinguishable from the verbatim shape above. That is a publisher refusal
NAMING the byte gap, never a silent pass, on a message one character away from the thing the
gate exists to ban.

**Nit 2 — the docblock over-claimed.** `rawCommitSize` issues its `cat-file -s` through the SAME
injected `run`, so "that property does NOT rest on the injected runner" was wider than what was
measured. The docblock (`:86`-`:96`) and the round-22 record above now state the measured
property instead: a runner whose small outputs are faithful cannot conceal a carrier behind a
truncated large one; a runner that truncated the object and answered `-s` with the truncated
length would still be believed. No code change — the wording was the defect.

**Regressions** (`trident/gates/release-readiness.test.ts`, 25 → 27 tests). `:382` is the guard:
a capture one byte short of an object ending `Claude-Session:` is `unknown` naming the gap; the
same case-folded (`CLAUDE-session`); and the 2-byte headers-only gap over a last line of
`claude-sessio`, which exercises the other call site. `:409` is the real-git control for the
same shape: the `--cleanup=verbatim` commit read through `productionRun`/`spawnCapture` is
measured WHOLE (`missing === 0`, because a message ending in `:` has no trailing whitespace to
trim) and the carrier is NAMED through both runners — the production path was never the hole
and must not become one. The round-22 over-reject test (`:358`) is unchanged and still proves a
1-byte gap over a clean message ALLOWS and over a real carrier BLOCKS.

**Mutation, run and restored.** `trident/gates/release-readiness.ts` `gapCouldCompleteTrailer`,
`if (missing <= 0) return false` → `if (missing >= 0) return false` (the pre-round-23 behaviour
exactly). Guard `bun test trident/gates/release-readiness.test.ts`: 26 pass / 1 fail, the failing
assertion receiving `{"kind": "allow"}` where `{"kind": "unknown"}` is expected — the hole,
demonstrated. Control `bun test trident/gates/build-claim.test.ts`: 9/9 green under the
mutation. Restored: 27/27 green.

**Verification** (bun 1.3.13, git 2.43.0). Stage 1 as instructed; the full suite is DEFERRED to
this plan's terminal task. Positive control for the enumeration claim: `grep -rn
'Claude-Session' trident --include=*.ts` still hits the regex, the docblocks and the fixtures,
and `git cat-file -p HEAD | grep -c '^Claude-Session'` is 0 for this round's commit. The G166
row in `docs/trident-gates-inventory.md` gained the token-check clause and the narrowed
cross-check wording, and its `release-readiness.ts` / `release-readiness.test.ts` citations were
remapped to the shifted lines. G100 and G139 are untouched.

### Round 24: three review findings closed on the publication scan

Round 23's review returned three founded defects that fix round 1 did not reach (the fix brief
carries the INDEPENDENT seat's findings only, so the synthesis majors never arrived). They are
closed here, in the build round, each with its own mutation-proven regression.

#### 1. `publicationReadiness` returned its scan unawaited

`trident/gates/release-readiness.ts` ended `publicationReadiness`'s `try` with a bare
`return sessionTrailerReadiness(run, repo, launchBase, head)`. A promise returned from a `try`
adopts AFTER the block exits, so a rejection escaped the `catch` instead of becoming
`unknownCause('Publication host observation failed', …)`.

Why it mattered rather than being a style point, measured in this tree: this diff introduced the
only rejecting statement in that `try` (the launch base had a synchronous
`return { kind: 'allow' }` there); `sessionTrailerCarriers` calls the injected runner with no
try/catch of its own; a throwing runner is a live contract on this path
(`release-readiness.test.ts` `gitOnlyRun`, and the fake host's `Unexpected command`);
`publishGate` in `trident/build-host.ts` has no try/catch upstream; the sibling call at
`trident/gates/build-claim.ts:65` awaits correctly; and `eslint.config.mjs` carries no
`return-await` or `no-floating-promises` rule, so nothing mechanical held the line.

Fixed to `return await …` (`:293`). Regression at `release-readiness.test.ts:533`: a runner that
answers rev-parse and ls-remote and then THROWS inside the scan must make `publicationReadiness`
RESOLVE to `{ kind: 'unknown' }` carrying both the gate sentence and the thrown message. The
assertion is `.resolves`, so it is red exactly when the promise rejects. Its positive control is
the same fixture without the throw, which still reaches a real `blocked` verdict.

#### 2. `gapCouldCompleteTrailer` was incomplete at a 2-byte gap

Round 23 compared the capture's last line against exactly ONE prefix length:
`lastLine === token.slice(0, 15 - missing)`. That is right at `missing === 1` and wrong at
`missing === 2` — the headers-only `--allow-empty-message` branch — where prefixes of length 13
AND 14 are both completable. A capture ending `claude-session` (14 bytes) was therefore ALLOWED
although the 2-byte gap could hold `:` and one more byte. The round-23 as-built section above
says the gap can flip a last line "for exactly one shape"; that sentence is superseded by this
one, and the G166 inventory row's overstatement of the same claim is corrected.

The check is a prefix RANGE now (`:81`-`:86`):

    const lower = captured.slice(captured.lastIndexOf('\n') + 1).toLowerCase()
    return lower.length + missing >= sessionTrailerToken.length && sessionTrailerToken.startsWith(lower)

Regression at `release-readiness.test.ts:485` covers tails of length 13 and 14 and their
case-folded variants at a 2-byte gap, with four positive controls at the SAME gap that must stay
`allow`: a real `committer` header line, a `parent` header line, a prefix too short for the gap
to finish (`claude-sessi`), and an empty last line. Without those controls the range test could
pass by refusing everything, which would collapse the `--allow-empty-message` tolerance the
round-22 work established.

ORDER CHANGE, and why it is not a weakening. The widened test also flags a last line that
ALREADY IS the token — a measured carrier, not an unmeasured gap. The loop therefore scans a
commit's message for carriers BEFORE the gap check (`:215`, `carriers.push(sha); continue`), so
such a commit stays `blocked` NAMING the sha the operator has to strip rather than being demoted
to `unknown`. Both answers are refusals, so the order cannot turn a refusal into a publish; it
only decides which is reported. Regression at `release-readiness.test.ts:515`.

#### 3. An unvalidated `head` could become git's branch-DELETE refspec

`sessionTrailerCarriers` validated `launchBase` with `fullOid` and never `head`. Two independent
consequences followed from an empty head, both measured here on git 2.43.0:

- `gitRangeArgv` renders `${launchBase}..${head}`, and git reads `<base>..` as `<base>..HEAD`,
  exit 0. The scan measured the CHECKOUT's HEAD instead of the commit about to be published, and
  normally allowed.
- `trident/publication.ts:314` pushes `${headToPublish}:refs/heads/${branch}`. With an empty
  head that is git's branch-DELETE form. Probed in a scratch repo with a bare origin:
  `git push --force-with-lease=refs/heads/change:<observed> origin ':refs/heads/change'` prints
  `- [deleted]         change` and EXITS 0 — the lease is satisfied, so it protects nothing —
  and `git ls-remote --heads origin refs/heads/change` is then empty. The post-push witness at
  `publication.ts:323`-`:326` reads that empty answer into `remoteHead ''`, compares it to
  `headToPublish ''`, finds them equal and does not throw. Origin loses the branch while the run
  records a successful publish: silent on every re-publish of an existing PR, loud only on a
  first push.

Reachable rather than hypothetical: `headToPublish` is `stdout.trim()` of an injected runner's
read at `trident/replay.ts:200`, `trident/replay.ts:595` and `trident/leak-preflight.ts:448`,
each of which checks `.ok` and nothing else — the same class round 22 hardened `rawCommitSize`
against.

ONE GUARD, THREE CALL SITES. `head` is validated with the same `fullOid` test as `launchBase`
(`:134`), returning `unknown` and naming the offending value, bounded to 64 characters because it
is caller input that lands in a persisted refusal string. Because it sits in the scan that EVERY
origin-facing publisher runs before its push, it closes `publicationReadiness`,
`publication.ts` `publishBuiltCommit` (legacy-loop and salvage) and `gates/build-claim.ts` at
once. It does not narrow G100: `checkBuildClaim` validates `snapshot.head` at
`build-claim.ts:31` before passing it, so the guard cannot fire there, and that path already
NAMES an `unknown` scan result while pushing anyway — the preservation push stays unconditional
(`build-claim-realgit.test.ts`).

Regressions. `release-readiness.test.ts:557` at the scan level: `''`, `'abc'`,
`'refs/heads/change'`, a trailing-space sha and an uppercase sha each yield `unknown` naming the
value, and a recording runner sees NO argv at all — no `rev-list`, no `cat-file`, no push — with
an ordinary full-OID head allowed first as the positive control, plus the 64-character bound and
the base-checked-first ordering. `publication-session-trailer-realgit.test.ts:291` at the
publisher level, against real git and a real bare origin: origin holds the branch, origin's
`main` is deleted so the replay takes its no-base early return, and a narrow double answers ONLY
the replay's non-`--verify` branch-head `rev-parse` with `ok` and empty stdout. The publisher
must throw naming `Publication head is not a full OID: ''`, origin must still hold the branch at
the commit it held, and no `push` argv may be issued. `:333` is the standalone measurement of
the delete shape, paired with its own positive control that the identical lease and refspec form
with a real head still publishes.

#### Inventory anchors re-measured

`docs/trident-gates-inventory.md` G100 cited `trident/publication.ts:329`, which is a comment
line; the `if (claimConflict) {` refusal it means is `:336`. G139 cited `:339`, a closing paren;
the `gh pr create` argv it means is `:346`. Both were re-anchored by +50 in an earlier round
where the real delta is +57, and `gates-inventory-citations.test.ts` validates only the TEST
column, so nothing catches a stale SOURCE anchor. Measured with `grep -n 'if (claimConflict) {'`
and `grep -n "'gh', 'pr', 'create'"` against the post-merge file and corrected. The citations
test is deliberately NOT widened to the source column in this card.

Every `trident/gates/release-readiness.ts:N` anchor in the G166 row was remapped by matching each
cited line's TEXT from `bfbe8a27` into the round-24 file rather than by adding an offset:
68→80, 69→81, 98→110, 119→152, 120→153, 127→160, 162→195, 170→203, 172→205, 176→216, 202→240,
244→293, with `:113` (the launch-base guard), `:134` (the head guard) and `:215` (the
carrier-first scan) added. `:22`, `:28`, `:37` and `:49` did not move. The test-column anchors
did not move at all: both test files are pure appends (`git diff -U0` reports `-475,0 +476` and
`-271,0 +272`). `trident/publication.ts` and `trident/gates/build-claim.ts` were not edited this
round, and their other cited anchors were re-read and are correct.

#### Verification

bun 1.3.13, git 2.43.0, in the round-24 worktree on the cumulative head.
`trident/gates/release-readiness.test.ts` 27 → 31 tests, 31/31 green;
`trident/publication-session-trailer-realgit.test.ts` 7 → 9 tests, 9/9 green;
`trident/gates-inventory-citations.test.ts` 1/1 green.

Four mutations, each applied alone to `trident/gates/release-readiness.ts`, run, and restored:

| mutation | result |
| --- | --- |
| `return await sessionTrailerReadiness(…)` → `return sessionTrailerReadiness(…)` | 30 pass / 1 fail — only the throwing-runner regression (`:533`) |
| prefix RANGE → round-23 single-prefix compare | 30 pass / 1 fail — only the 2-byte-gap regression (`:485`) |
| carrier scan moved back AFTER the gap check | 30 pass / 1 fail — only the already-is-the-token regression (`:515`) |
| the `head` `fullOid` guard deleted | 38 pass / 2 fail across both files — the scan-level regression (`:557`) and the realgit branch-DELETE regression (`:291`), the latter receiving `null` for the expected refusal, i.e. the publish "succeeding" |

Restored: 40/40 green across both files. The full suite is DEFERRED to this plan's terminal
task, which runs it over the whole cumulative branch.

#### One more thing the positive controls found

The G166 row tells a reader to enumerate the origin-facing pushes with
`grep -rn "'push'" trident --include=*.ts` excluding tests, and names four files. Run on
2026-09-20 that recipe returns FIVE: `trident/wrong-base-remedy.ts:536`, `tok.indexOf('push')`,
a string scan that redacts a destructive push out of a remedy sentence and issues no argv. The
enumeration of real pushes is unchanged and still correct; the instrument the row hands the next
reader no longer reproduced the number beside it, which is how an enumeration claim rots. The
clause now states the fifth hit and why it is not a push. Present at `bfbe8a27` and on
`origin/main`, so it is pre-existing, not introduced here.

The other absence control passed as stated: `grep -rn 'Claude-Session' trident --include=*.ts
--include=*.sh --include=*.mjs`, filtered to non-test, non-comment lines, hits only the scan's
own refusal strings (`gates/release-readiness.ts:201`, `:246`), the wrapper's strip and refusal
messages (`commit-with-resolved-head.sh`), and the CLI reminder that tells the agent not to write
one (`inner-workflow.mjs:1268`). Positive control for the search shape: the same grep finds 32
hits in `gates/release-readiness.test.ts` and 27 in `commit-with-resolved-head-realgit.test.ts`.

### Round 25: the shard grew a second `## ` heading, which is what red CI was saying

Round 24's CI was RED on `c20c9006` and the failure was one defect wearing three names.
`layering` runs `bun scripts/ci/check-governed-repo-attributes.ts .`; `shard 3/4` runs the same
gate as a subprocess test (`check-governed-repo-attributes (subprocess) > this repo — the
governed tree the gate ships in — passes its own gate`); `test` is their aggregate. The only
`(fail)` line in the 12,927-line log:

```
as-built-write-guard: FAILED — new record 'docs/as-built/drop-claude-session-trailer.md'
must begin with exactly one '## YYYY-MM-DD — title' heading.
```

`scripts/ci/as-built-write-guard.sh:275-291` counts `^## ` lines outside code fences in
`git show ${GUARD_HEAD_SHA}:${path}` and requires exactly one. Rounds 20–23 appended as
`### Round N: …`; round 24 appended `## 2026-09-20 — Round 24: …` at line 1521, a second `## `,
and `docs/as-built/README.md` is explicit that this is refused while `###` and deeper are an
entry's own structure. Fixed by demoting that heading to `### Round 24: three review findings
closed on the publication scan` and its six subsections (`1.`, `2.`, `3.`, `Inventory anchors
re-measured`, `Verification`, `One more thing the positive controls found`) from `###` to
`####`, so round 24 nests under the single entry heading exactly as rounds 20–23 do. No round-24
prose changed. Every future round appends `###`, never `## `.

The guard reads a COMMITTED tree, and outside Actions with neither `GUARD_BASE_SHA` nor
`GUARD_HEAD_SHA` set it exits 0 with "Nothing to guard" — an empty check that reads as a passing
check — so both env vars were set explicitly for every run of it recorded below.

#### The two non-blocking findings, closed

**`missing < 0` is intended fail-closed behaviour, and it is now stated and tested as such.**
The round-24 review asked whether an over-read driving a hard refusal was a decision or a bug.
It is the decision. The host runner decodes the raw object as UTF-8, so each invalid byte
returns as U+FFFD and re-encodes to three: a COMPLETE non-UTF-8 commit captures MORE bytes than
its own `cat-file -s` reports, and `missing` goes negative. Reading that as "complete" would let
a truncating runner hide a carrier behind an inflated short read — the class the cross-check
exists to close — because under lossy decoding a complete non-UTF-8 object and a truncated one
whose U+FFFD inflation has reached `size` are indistinguishable. The outcome is a publisher
refusal naming the sha and the gap, never a rewrite, so G100 origin preservation is untouched,
and the loop's own commits are always UTF-8. The docblock at `gates/release-readiness.ts:94-96`
said the opposite — that a non-UTF-8 body "decodes with U+FFFD, and the line structure and the
ASCII token survive that" — which predates the size cross-check and was wrong about the SCAN
OUTCOME; it now states the boundary above.

The existing over-read test reached that branch only through a fake runner that lied about the
size, which proves the comparison and not that the branch is reachable at all. The new real-git
regression (`gates/release-readiness.test.ts`, `a real non-UTF-8 commit message is REFUSED as an
over-read`) stores the object with `git hash-object -t commit -w`, which is the only way to keep
such a message: measured on git 2.43, `git commit-tree -F` fed a lone `0xE9` warns
("commit message did not conform to UTF-8") and stores `C3 A9` instead, so a fixture built that
way would have tested nothing. The test asserts the inflation it depends on (`captured === size + 2`
for one invalid byte) and carries its positive control in the same body: the identical message
with the character as valid UTF-8 is `{ kind: 'allow' }`.

**`fullOid` now agrees between the two G166-facing modules.** `gates/build-claim.ts:6` carried
`/i` and `gates/release-readiness.ts:11` does not, so the same uppercase sha was a valid head to
the gate and an invalid one to the scan that gate runs. Git only ever emits lowercase object
names, so the stricter form is the measured one; the `/i` is dropped. The new case in
`gates/build-claim.test.ts` asserts an uppercase measured head is `unknown` with NO host call at
all — no rev-parse, no scan, and no preservation push on the strength of a head git never
produced — plus the same strictness on the resolved claim, and a lowercase positive control that
still reaches a real verdict and does call git.

Left alone deliberately: the push-enumeration recipe in the G166 inventory row returning a fifth
non-push hit (`trident/wrong-base-remedy.ts:536`, a string scan issuing no argv) is already
recorded in that row; `gates-inventory-citations.test.ts` is not widened for it in this card.

#### Verification

`bun test trident/gates/release-readiness.test.ts trident/gates/build-claim.test.ts`: 42 pass,
0 fail, 186 expect() calls.

Mutations, both directions, run and reverted, never committed:

| mutation | measured |
| --- | --- |
| `build-claim.ts` `fullOid` `/i` restored | guard `build-claim.test.ts` 9 pass / 1 fail; control `release-readiness.test.ts` 32/0 green; restored 10/10 green |
| `missing < 0` made lenient (`< -1000000`) | `release-readiness.test.ts` 30 pass / 2 fail — the new real-git regression and the existing over-read test; restored 32/0 green |
| a second `## ` heading re-inserted in this shard | `as-built-write-guard.sh` exits 1 with the exactly-one-heading text (recorded below) |

The over-direction is covered in the same runs: an ordinary UTF-8 commit and an ordinary range
still reach `{ kind: 'allow' }`, a lowercase head still reaches a real verdict, and the guard
says OK on the clean head.

#### The guard's own positive controls, both directions

Run against a COMMITTED tree, with both env vars set explicitly so the "Nothing to guard" arm
can never be mistaken for a pass:

```
$ GUARD_BASE_SHA=<origin/main> GUARD_HEAD_SHA=<this round's tree> \
  AS_BUILT_GUARD_ROOT=$PWD bash scripts/ci/as-built-write-guard.sh
as-built-write-guard: OK — frozen history is unchanged and every new shard is well formed.   (exit 0)

$ # the same tree with one extra "## …" line appended to this shard, on a throwaway commit
as-built-write-guard: FAILED — new record 'docs/as-built/drop-claude-session-trailer.md'
must begin with exactly one '## YYYY-MM-DD — title' heading.                                  (exit 1)
```

`bun scripts/ci/check-governed-repo-attributes.ts .` — the command `layering` and the shard-3/4
subprocess test run — exits 0 on the clean tree, reporting the guard OK, the migration ordinal
guard OK (145 migrations, no ordinal claimed twice) and the stale-prose guard OK. The throwaway
commit was discarded and the working tree re-measured to the identical tree object afterwards.

#### Inventory anchors re-mapped

The docblock rewrite in `gates/release-readiness.ts` and the comment added above
`gates/build-claim.ts`'s `fullOid` shift every line below them, so the G100 and G166 citation
columns in `docs/trident-gates-inventory.md` were re-mapped by CONTENT rather than by arithmetic:
each cited line was read out of the `c20c9006` version of its file and located in the new one,
and the remap only applied where the text occurred exactly once. Twenty anchors moved —
`release-readiness.ts` +13 from `:110` down, `build-claim.ts` +6 from `:28` down,
`build-claim.test.ts` +30 from `:99` down — and nothing else in that document changed.
`trident/gates-inventory-citations.test.ts` only proves a citation resolves to a line that
exists, so it would have stayed green over rotted anchors; the content remap is what makes them
right, and the run that found zero unresolvable lines is its own control.

Round 24's prose cites `gates/release-readiness.ts:201` and `:246` for the two refusal strings.
That was true at `c20c9006` and is left as the measurement it was; the same two strings are at
`:214` and `:259` after this round's docblock.

### Round 26: the terminal full suite on the cumulative head, on the host's own terms

Earlier rounds each proved their own change with file-scoped runs. The receipt that decides
whether this branch publishes is a different measurement: after review approval the host itself
runs `bash -lc 'bash scripts/run-tests.sh'` in the build worktree and keeps only the exit code
(`open/wiring/project-build.ts:474`, `trident/build-run.ts:625`). Run `07bd885d` died exactly
there — 1610 of 1610 files executed, two red — and no builder-side claim softens that, because
neither `suiteOutcome` nor `suiteEvidence` reaches the gate. This round runs that same command,
in that same shell, on the head this record is part of.

#### Identity, before any mutation

The assigned worktree was at `96606534` on `trident/dispatch-this-through-trident-drop` with
`git status --porcelain` empty. `origin/main` (`95dca58c`) and the published branch head
(`c20c9006`) are both ancestors of it, and `gh pr view 1152` reports head `c20c9006`, OPEN,
draft. Nothing was merged, reset or pushed this round: the cumulative work was already on the
branch, and the host is the only publisher.

#### The login shell is part of the measurement

`scripts/ci/typecheck-all.sh` calls `bunx`, which lives in a user-local `bin` directory that the
login profile puts on PATH. A non-login shell's PATH does not carry it, and
`scripts/ci/typecheck-worktree.test.ts` then reds with `bunx: command not found` — a property of
the shell, not of the branch. The host's own receipt runs under `bash -lc`, so every test and
typecheck command in this round did too, with `bash -lc 'which bunx'` resolving as the positive
control first. A red that appears only outside the login shell is not a branch defect and was
not chased as one.

#### Stage 1 on the cumulative head

`bun test` over the nine files this card changed behaviour in —
`commit-with-resolved-head-realgit`, `gates/release-readiness`, `gates/build-claim`,
`gates/build-claim-realgit`, `publication-session-trailer-realgit`, `build-host`,
`stranded-salvage-realgit`, `gates-inventory-citations` and `scripts/ci/as-built-write-guard` —
ran 213 tests across 9 files, 0 fail. `open/__tests__/project-build-e2e.test.ts` ran 104, 0 fail.
`tsc --noEmit` on both `tsconfig.json` and `trident/tsconfig.json` printed no line and exited 0.
The two files that redded run `07bd885d`'s host receipt are green here — `typecheck-worktree`
3/3 and `landing/__tests__/chat-react-bundle-production-runtime.test.ts` 1/1 — fixed on main
(`0f7fed96`, `b634cced`) and carried in by this branch's merge of main, not by anything here.

#### Mutations, both directions

Three mutations were applied one at a time, run, and restored, with `git status --porcelain`
empty after each; none was committed.

- `fullOid` in `gates/build-claim.ts` given its `/i` back: `gates/build-claim.test.ts` 9 pass /
  1 fail on `an uppercase measured head is not a full OID here either`, while the control
  `gates/release-readiness.test.ts` stayed 32/32. Restored: 10/10.
- `if (missing < 0)` in `gates/release-readiness.ts` made unreachable: 30 pass / 2 fail — the
  synthetic over-read case AND the real-git non-UTF-8 regression. That pair is what makes the
  fail-closed decision a measurement rather than a comment. Restored: 32/32.
- a second `## ` heading appended to this shard on a THROWAWAY commit, built with
  `git commit-tree` against a scratch index so no ref moved: `as-built-write-guard.sh` exits 1
  with `must begin with exactly one '## YYYY-MM-DD — title' heading`, the exact text that redded
  `layering`, `shard 3/4` and `test` in round 24.

The over-direction control is the restored tree itself: the guard prints
`OK — frozen history is unchanged and every new shard is well formed` and exits 0, and
`bun scripts/ci/check-governed-repo-attributes.ts .` — the command the `layering` job and the
shard-3/4 subprocess test both run — exits 0. This shard still holds exactly one `## ` heading.

#### Absence controls

`git cat-file commit` on each commit this branch authored (`e8728bb2`, `96606534`, and this
record's own) matches `^Claude-Session` zero times and `^Co-Authored-By` exactly once. The
`e9de8355` merge commit carries neither, which is what a merge the agent wrote no message for
looks like. The grep that enumerates the sites — `grep -rn 'Claude-Session' trident
--include=*.ts --include=*.sh --include=*.mjs` — returns 27 non-test lines in exactly four
files: `gates/release-readiness.ts`, `gates/build-claim.ts`, `commit-with-resolved-head.sh` and
`inner-workflow.mjs`. Every one is a strip, a refusal string, a docblock, or the instruction
telling the agent not to write the trailer; none composes one. Its shape control is the same
grep over the test files, which returns 73 lines — so an empty result would have meant the grep
had stopped working, not that the trailer was gone.

#### The full suite

`bash -lc 'bash scripts/run-tests.sh'` was then run on the head this record is committed at.
Its receipt — files discovered against files executed, per-lane pass and fail counts, wall time
and the log — is reported with the build result, because the only number that decides anything
is the one measured on the exact revision the host will publish. A suite result from an earlier
head approves nothing.

### Round 27: the capture is authenticated against its own object ID, and a throwing scan no longer costs the preservation push

Round 26 earned everything the loop can earn on `ce601b78` — 12/12 CI check-runs SUCCESS, review
round 1 APPROVE from all four seats including the cross-model one, and a host full-suite receipt of
1629/1629 green — and then ended `failed` at `Pinned PR merge was not confirmed`, because
`gh pr merge --squash --match-head-commit` was aimed at a DRAFT PR on a deployed revision that had
no ready-for-review path. #1185 closed that gap. This round re-lands the work on the new base and
adds the two repairs that base's review left open.

#### The base, measured before anything was touched

The assigned branch was at `b8411957` (#1186, "retain bounded worktree creation diagnostics"), and
`origin/main` was the SAME sha — so the launch base named in the card, `62d1a874` (#1185), is an
ANCESTOR of the branch and merging it again would have been a no-op. `origin/trident/…-drop` and
`gh pr view 1152 --json headRefOid` both read `ce601b78`, matching the expected head exactly, so
nothing newer was on origin and the merge was authorised. `git merge-tree --write-tree` pre-measured
the merge clean (tree `eb90f7f6`, exit 0, no conflict lines), and `git merge --no-ff` then produced
exactly that tree. The PR's stripping wrapper arrives WITH that merge — at `b8411957` the file is
still main's pre-#1133 `exec git commit "$@"` — so every commit of this round was made afterwards
and through the merged wrapper.

#### Why the already-verified candidate was taken as a delta, not merged

The candidate `fix/pr1152-guard-repairs` (`b342758d`) was inspected rather than trusted. Its content
is right — `ce601b78` is its ancestor, its delta is 8 files/+383/−193, and applying it to the merge
reproduced the predicted tree `741b8c63` byte for byte. But all THREE of its commits carry zero
`^Co-Authored-By` lines, read from the raw objects. Merging them verbatim would have put three
loop-authored non-merge commits without `Co-Authored-By` into `origin/main..HEAD`, which is the
other half of this card's acceptance. The delta was therefore committed once, through the wrapper,
with the trailer the acceptance requires. Nothing is lost by that choice: the tree is identical, and
the candidate branch was left untouched.

#### Repair 1 — G100 preserves even when the advisory scan THROWS

`sessionTrailerReadiness` was called from `checkBuildClaim` with no `try`/`catch`. `run` is an
injected host runner, so a host that throws mid-scan — the shape `makeLazyCredentialedHostRunner`
produces when its environment loader fails — escaped the gate as a rejected promise, and the
preservation push below it never ran. That loses public origin history in exactly the case G100
exists to protect. The fix contains ONLY the advisory scan: the exception becomes
`unknownCause('Session-trailer host observation failed', …)`, it is NAMED in the refusal as
`; session-trailer scan unmeasured: …`, and the push happens anyway. Claim resolution, the lease and
the push receipt are untouched and still fail closed — `build-claim-scan-failure.test.ts`'s
"scan exception containment does not authorize subsequent publication" proves the containment does
not leak into `publicationReadiness`, which still answers `unknown` for the same host.

#### Repair 2 — the capture must reconstruct the listed object ID

The round-22/23 cross-check weighed the raw read against the object's own `cat-file -s` size, and
round 23/24 added `gapCouldCompleteTrailer`, a prefix-range heuristic over the tolerated byte gap.
Size and prefix cannot tell an authentic capture from an equal-length substitution, a lost colon, or
lossy UTF-8 decoding. `restoredCommitMatches` now builds Git's own object identity —
`commit <byteLength>\0<bytes>`, hashed with SHA-1, or SHA-256 when the listed id is 64 characters —
and requires it to equal the sha the range listing named. Any proposed separator-LF reconstruction
that does not reproduce the exact OID is `unknown`, never `allow`. This REPLACES the gap machinery
rather than regressing it: a truncated or byte-substituted capture cannot hash to the claimed OID,
so authentication strictly subsumes the heuristic. Authentic empty and one-byte-trimmed captures
still allow, and that allow path is exercised by its own test.

#### The vacuous assertion, closed

`release-readiness.test.ts` asserted `seen.filter(…'cat-file'…).every(call => call.env === undefined)`.
`.every()` over a FILTERED array is true on an empty filter, so a scan that stopped issuing
`cat-file` at all would still have read green. The count is now pinned first —
`expect(objectReads).toHaveLength(4)`, one `cat-file commit` and one `cat-file -s` for each of the
two ranged commits — exactly as the sibling `toHaveLength(1)` pins the listings.

#### Mutations, each applied alone, run, and restored

Every mutation below was applied to a clean tree, run, then reverted with `git checkout --`, with
`git status --porcelain` confirmed empty afterwards. None was committed.

- UNDER, G100: delete the `try`/`catch` so `sessionTrailerReadiness` is called bare —
  `trident/gates/build-claim-scan-failure.test.ts` goes 2 pass / 4 fail. Restored: 6/6 green.
- UNDER, G166: `restoredCommitMatches` returns `true` unconditionally — the SIX
  "#1133 G166 authenticated capture" tests (sha1 and sha256 × equal-byte-length truncated carrier,
  lost colon, headers-only cut) go red, 32 pass / 6 fail. Its CONTROL,
  `build-claim-scan-failure.test.ts`, stays 6/6 GREEN under the same mutation. Restored: 38/38 green.
- OVER, G166: `restoredCommitMatches` returns `false` unconditionally — 8 pass / 30 fail, and the
  reds INCLUDE "genuine clean and empty one-byte-trimmed captures allow" for both hash widths,
  which is the proof that the allow path is exercised and the guard does not over-reject.
- TRAILER REGRESSION (this card's own acceptance): disable the wrapper's strip by making its
  `[Cc][Ll]…[Nn]:` case pattern unmatchable — `commit-with-resolved-head-realgit.test.ts` plus
  `publication-session-trailer-realgit.test.ts` go 31 pass / 44 fail. Restored: 75/75 green.
- POSITIVE CONTROL for the pinned count: point the new filter at a token no argv carries, so the
  filtered array is empty — exactly ONE test reds, and it reds AT `toHaveLength(4)`
  ("Expected length: 4, Received length: 0"), which is the assertion `.every()` alone would have
  passed vacuously.

#### The G166 push enumeration, re-measured rather than recited

`grep -rn "'push'" trident --include=*.ts` excluding tests returns SEVEN lines across FIVE non-test
files on this head. The inventory row had claimed "four origin-facing pushes" and named five of the
seven — omitting `trident/merge.ts:2147` (`git push origin --delete <branch>`, which IS origin-facing
and DOES name a build branch) and `trident/publication.ts:318`. That row now enumerates all seven and
says what each is: three publish objects on a build branch and all three scan first
(`production-host-effects.ts:390`, `publication.ts:311`, `gates/build-claim.ts:74`); `:318` is the
same push's failure-reason string; `merge.ts:1686` pushes the merge commit onto the configured base branch of the local repository under `receive.denyCurrentBranch=updateInstead` (not an origin push, no build-branch object); `merge.ts:2147` is a delete refspec
and transfers no object; `wrong-base-remedy.ts:536` is a string scan issuing no argv. No scanning was
added to the delete or the local-mode merge — the correction is a documentation-accuracy one, and it
is the third overstatement that row has shipped, which is why it now states the measured count. The
grep's positive control is that it hits `publication.ts` and `merge.ts` at all; an empty result would
have meant the recipe had stopped working.

#### Absence controls, and what was run

Read from the raw objects, every non-merge commit in `origin/main..HEAD` matches `^Claude-Session:`
zero times and `^Co-Authored-By` exactly once; the merge commit carries neither, which is what a
merge the agent wrote no message for looks like. Stage 1 ran 962 tests across 18 files with 0
failures — the nine gate/wrapper/publication suites, `open/__tests__/project-build-e2e.test.ts`,
`trident/inner-workflow.test.ts`, `trident/orchestrator.test.ts`,
`trident/production-host-effects.test.ts`, `trident/stranded-salvage-realgit.test.ts`,
`scripts/ci/as-built-write-guard.test.ts`, the persistent build-settings suite, and the two files
that once redded a host receipt (`scripts/ci/typecheck-worktree.test.ts`,
`landing/__tests__/chat-react-bundle-production-runtime.test.ts`). Both typecheck projects —
`tsc --noEmit -p tsconfig.json` and `-p trident/tsconfig.json` — emit zero lines. The full suite is
the HOST's receipt on the exact revision it will publish; a suite result from an earlier head
approves nothing.

### Round 28: the G166 row's anchors are re-read rather than recited, and the local-mode merge push is described from its argv

This round changed documentation only: the G166 row of `docs/trident-gates-inventory.md` (line 270)
and two lines of this shard. No production behaviour moved. Both directions of the G100 containment
were mutated and observed on this head, because a receipt from an earlier head approves nothing.

#### How the round started: a salvage tag, not a branch

Round 27 built three good commits and then died on a dispatch-budget timeout — the dispatch line was
never consumed by the REPL while the orchestrator seat was mid-verification. Worktree cleanup deleted
the local branch ref with the worktree, so the work survived only at the tag
`salvage/pr1152-round27-f6be45cc` = `f6be45ccd6ea83b14e6b59d1eb306142290cb574`. The branch was
re-pointed at that tag by pure fast-forward (`git merge --ff-only`); `b8411957` (the launch base,
#1186) and `ce601b78` (PR #1152's published head) are both ancestors of the tag, so nothing was
re-merged and nothing was rebuilt. Round 28 then died the same way with an untouched worktree.

#### The 34 stale anchors, and why nothing was red

`trident/gates-inventory-citations.test.ts` parses the TEST column and bounds-checks the cited line
NUMBER without reading the line it points at. A whole-file anchor shift therefore reads as a passing
check — an empty check reads as a passing check. The test was left exactly as it is; widening it is a
separate decision, and a green run of it is necessary but not sufficient evidence for this row.

Each anchor was re-read with `sed -n '<N>p' <file>` before being written, and the mapping was used as
a cross-check rather than a licence to blind-edit:

- `trident/gates/release-readiness.ts:22` → `:23`. `:22` is the closing `*/` of the file docblock;
  `:23` is `const sessionTrailerLine = /^claude-session:/i`, the regex the row is describing.
- `trident/gates/release-readiness.test.ts` — 27 anchors, each shifted `+7` onto its own `test(`
  declaration (`109→116 129→136 141→148 165→172 177→184 185→192 194→201 208→215 220→227 239→246
  255→262 267→274 309→316 330→337 341→348 360→367 377→384 397→404 428→435 446→453 464→471 488→495
  533→540 565→572 596→603 629→636 658→665`). `:85` was already correct and was kept. The corrected
  set was then checked for equality against the file's own declarations:
  `grep -n '^\s*test(' trident/gates/release-readiness.test.ts | cut -d: -f1` returns exactly 28
  lines — `85 116 136 148 172 184 192 201 215 227 246 262 274 316 337 348 367 384 404 435 453 471
  495 540 572 603 636 665` — and the row's 28 anchors for that file now equal it.
- `trident/gates/build-claim.ts:63 → :65` (the `sessionTrailerReadiness` call; `:63` is only the
  `let trailers: GateResult` declaration), `:64 → :71` (the blocked-text assignment; `:64` is
  `try {`), `:72 → :79` (the final `branch preserved on origin` refusal; `:72` is the `unknown`
  branch). `:34`, `:67` and `:74` were re-read and are correct, so they were left alone — `:74` is
  the force-with-lease preservation push the row names.
- `leak-preflight.ts:452 → :448`. `:448` is `const newHead = revparse.stdout.trim()`, which is what
  the row's `stdout.trim()` clause is about; `:452` is now the `update-ref` argv.
- `trident/gates/build-claim.test.ts:129 → :134` (the carrier test's declaration; `:129` is an
  `expect` inside the preceding test) and `:147 → :150` (the unmeasured-range test's declaration;
  `:147` is only a push assertion). `:33` was re-read and kept.

Post-checks: `git diff --stat` showed one changed line in `docs/trident-gates-inventory.md`,
`grep -c '^| G'` still returns 166, and `bun test trident/gates-inventory-citations.test.ts` is
1 pass / 0 fail / 1476 expects.

#### `merge.ts:1686`, read from the argv instead of from memory

`trident/merge.ts:1684-1688` is `checked('push', '--porcelain',
'--receive-pack=git -c receive.denyCurrentBranch=updateInstead receive-pack',
'--force-with-lease=refs/heads/<base>:<baseOid>', repo, '<commit>:refs/heads/<base>')`. The remote is
the LOCAL `repo` path, not `origin`, and the refspec names the merge commit and the configured base
branch. "Pushes `main`" was wrong on both counts. The G166 row and this shard now say: it pushes the
merge commit onto the configured base branch of the local repository under
`receive.denyCurrentBranch=updateInstead`; it is not an origin push and publishes no build-branch
object. This supersedes the Round 18 (`:937`) and Round 27 (`:1978`) phrasing; the Round 18 line is
left in place as the historical record of what was believed then, and the Round 26 line already read
"to the base branch" and was not churned.

#### OVER-G100 and UNDER-G100, both run on this head

Round 27 ran the UNDER direction only, so a mutation that made the healthy path WITHHOLD the
preservation push would not have been caught by this branch's own evidence.

OVER-G100: inserting `if (trailers.kind === 'allow') return unknown('OVER-G100 mutation: healthy
scan withheld the preservation push')` immediately after the scan's `try`/`catch` and before the
`blocked` branch turns `trident/gates/build-claim-scan-failure.test.ts` to 4 pass / 2 fail. The
required red is `G100 real origin preserves the measured object with healthy trailer scan`, and it
fails at the bare-origin assertion on `:71` —
`expect(await git(w.origin, 'rev-parse', '--verify', 'refs/heads/change')).toBe(w.head)` — which
throws `fatal: Needed a single revision` because the branch was never preserved at all. The
same-mutation green control is the sibling `…with rev-list trailer scan`: a throwing scan is
`unknown`, not `allow`, so the push still happens. The companion red, named and not chased, is
`G100 real origin stays untouched without a measured claim conflict`, failing at `:103` — its own
positive control, which expects a measured conflict to be preserved.

UNDER-G100: removing the `try`/`catch` so the scan call is bare turns the same file to 2 pass /
4 fail — the three fault variants (`rev-list`, `cat-file`, `size`) and
`G100 scan exception containment does not authorize subsequent publication` all go red, while the
healthy case stays green. That is the containment the round-27 repair bought, measured in the
direction that proves it is load-bearing.

Each mutation was applied alone, observed, and restored with `git checkout --
trident/gates/build-claim.ts` followed by `git diff --quiet HEAD -- trident/gates/build-claim.ts`;
the file re-runs 6 pass / 0 fail / 59 expects after each restore, and the working tree carried only
the two documentation edits into the commit.

#### Receipts on the restored head

The sixteen listed files ran in two batches: 157 pass / 0 fail / 3320 expects across the eight
gate, wrapper and publication suites, and 792 pass / 1 fail / 4252 expects across the other eight.

The single red is environmental and pre-existing, not this branch's:
`scripts/ci/typecheck-worktree.test.ts` → `typecheck-all — real linked worktrees > a fresh worktree
installs locally and typechecks`, failing on `scripts/ci/typecheck-all.sh: line 71: bunx: command not
found`. `bunx` is absent from this host's PATH (`command -v bunx` is empty; `bun` is at
`/usr/local/bin/bun`). Both files involved are byte-identical to the launch base — `git rev-parse
b8411957:<path>` and `HEAD:<path>` return the same blob for `scripts/ci/typecheck-worktree.test.ts`
(`7b973d4f`) and `scripts/ci/typecheck-all.sh` (`917c0f45`) — and the targeted baseline confirms it:
run in a detached worktree at `b8411957` the same file is 0 pass / 3 fail, strictly worse than the
2 pass / 1 fail measured here. That worktree was removed after the measurement.

`npx tsc --noEmit -p tsconfig.json` and `-p trident/tsconfig.json` each emit zero lines and exit 0.
This worktree's `node_modules/@neutronai` holds 18 symlinks and every one resolves inside this
worktree (`for p in node_modules/@neutronai/*; do readlink -f $p; done | grep -vc <worktree>` prints
0), so the typecheck measures this tree and not main's checkout.

`as-built-write-guard.sh` exits 0 — "frozen history is unchanged and every new shard is well formed"
— when given BOTH `GUARD_BASE_SHA=b8411957…` and `GUARD_HEAD_SHA`; with the base alone it refuses to
skip rather than passing vacuously, which is the right shape for a guard.
`bun scripts/ci/check-governed-repo-attributes.ts` exits 0.

Provenance, read from raw objects with replacement objects disabled: all 23 non-merge commits in
`b8411957..HEAD` match `^Claude-Session:` zero times and `^Co-Authored-By` exactly once. The table
was printed per commit; zero rows deviate.

#### The emitting sites, enumerated with a shape control

`git grep -n -i 'claude-session' HEAD -- ':!*.test.ts' ':!docs/**' ':!*.md'` returns 25 lines across
FIVE files, not four: `trident/commit-with-resolved-head.sh` (20 lines — the strip itself),
`trident/gates/release-readiness.ts` (`:23` the regex, `:184` the refusal text),
`trident/gates/build-claim.ts:58` (a comment), `trident/inner-workflow.mjs:1268` (the `guardedCommit`
instruction) and `runtime/adapters/claude-code/persistent/build-settings.ts:174` — the comment above
`settings['attribution'] = { sessionUrl: false }`, which is the actual mechanism that stops the
trailer being emitted. None of the 25 composes a commit message. The positive control — the same
recipe for `Co-Authored-By` — hits `trident/inner-workflow.mjs:1268`, so the recipe is working; an
empty result would have meant the recipe was broken, not that nothing emits.

PR #1152 was read and not touched: title `Drop the Claude-Session trailer from loop-authored commits
(#1133)`, `isDraft: true`, `OPEN`, head `ce601b78`. Publication, ready-for-review and merge belong to
the host.

#### Round 28 terminal receipt — re-proved on the committed head `96baa204`

The sections above were measured on the working tree that BECAME `96baa204`. This receipt is the
run-owned re-proof on that commit itself: nothing here is inherited from round 27's receipt or from
the pre-commit measurement, the working tree was clean (`git status --short` empty) before the first
mutation, and no production file changed this round.

**OVER-G100, on `96baa204`.** Inserting
`if (trailers.kind === 'allow') return unknown('OVER-G100 mutation: healthy scan withheld the
preservation push')` between the scan's `try`/`catch` and the `blocked` branch of
`trident/gates/build-claim.ts` turns `trident/gates/build-claim-scan-failure.test.ts` to
**4 pass / 2 fail / 51 expects**. The required red is `G100 real origin preserves the measured object
with healthy trailer scan`, failing at the bare-origin assertion on `:71` —
`expect(await git(w.origin, 'rev-parse', '--verify', 'refs/heads/change')).toBe(w.head)` — which
raises `fatal: Needed a single revision` because nothing was preserved. The same-mutation green
control is the sibling `… with rev-list trailer scan`. The companion red, named and not chased, is
`G100 real origin stays untouched without a measured claim conflict`, whose own positive control at
`:103` reads `unknown` where it expects `blocked`.

**UNDER-G100, on `96baa204`.** Removing the `try`/`catch` so the scan call is bare turns the same
file to **2 pass / 4 fail / 30 expects** — the `rev-list`, `cat-file` and `size` fault variants plus
`G100 scan exception containment does not authorize subsequent publication` all go red, while the
healthy case and `… stays untouched …` stay green.

Each mutation was applied alone and restored with `git checkout -- trident/gates/build-claim.ts`
followed by `git diff --quiet HEAD -- trident/gates/build-claim.ts`; after each restore the file
re-runs **6 pass / 0 fail / 59 expects**. Both directions are now this branch's own evidence.

**The sixteen listed files, in two batches of eight.** 157 pass / 0 fail / 3320 expects (32.9s) and
792 pass / 1 fail / 4252 expects (140.1s). The one red is `scripts/ci/typecheck-worktree.test.ts` →
`typecheck-all — real linked worktrees > a fresh worktree installs locally and typechecks`, on
`scripts/ci/typecheck-all.sh: line 71: bunx: command not found`; `command -v bunx` is empty on this
host while `bun` is at `/usr/local/bin/bun`, and both files are byte-identical to the launch base.

**Typecheck.** `npx tsc --noEmit -p tsconfig.json` and `-p trident/tsconfig.json` each emit zero
lines and exit 0. All 18 `node_modules/@neutronai/*` symlinks resolve inside this worktree
(`readlink -f` of each, counted against `$PWD`, gives 0 outside), so the typecheck measured this
tree rather than main's checkout.

**Guards.** `GUARD_BASE_SHA=b8411957… GUARD_HEAD_SHA=$(git rev-parse HEAD) bash
scripts/ci/as-built-write-guard.sh` exits 0 ("frozen history is unchanged and every new shard is
well formed") both before and after this commit; `bun scripts/ci/check-governed-repo-attributes.ts`
exits 0. `grep -c '^## '` on this shard stays **1**.

**Provenance, from raw objects.** For every sha in `git rev-list --no-merges b8411957..HEAD`,
`git --no-replace-objects cat-file commit <sha>` matches `^Claude-Session:` **zero** times and
`^Co-Authored-By` **exactly once**. 24 rows before this commit, 25 with it; zero rows deviate.

**Emitting sites, with the shape control.**
`git grep -n -i 'claude-session' HEAD -- ':!*.test.ts' ':!docs/**' ':!*.md'` returns 25 lines across
five files — `trident/commit-with-resolved-head.sh` (20, the strip itself),
`trident/gates/release-readiness.ts` (`:23`, `:184`), `trident/gates/build-claim.ts:58`,
`trident/inner-workflow.mjs:1268` and
`runtime/adapters/claude-code/persistent/build-settings.ts:174`. None composes a commit message. The
positive control — the same recipe for `Co-Authored-By` — hits `trident/inner-workflow.mjs:1268`, so
an empty result would have meant a broken recipe, not an absent emitter.

**The full suite.** `bash scripts/run-tests.sh` ran to completion in **1789s**, exit 1:
1630 test files (bun-discovered: 1630) across **18 lanes** — 15 general chunks of ≤100, a 22-file
PGLite lane, a 42-file device lane and a 162-file real-HTTP lane. Aggregate:
`run-tests: FAIL — 4/18 lane(s) contained failing tests`, `failed: 4 (12 14 PGLite-lane
device-lane)`. Four distinct tests are red:

1. chunk 12 — `scripts/ci/typecheck-worktree.test.ts`, the `bunx: command not found` case above.
2. chunk 14 — `trident/project-driver-recovery-mutation.test.ts` →
   `project-driver recovery guard mutations fail in both directions, with a green control`. It
   asserts that a nested `bun test` transcript CONTAINS `(pass) project-driver gateway recovery > …`;
   bun 1.3.13 prints only `(fail)` lines, so the nested run returned `16 pass / 0 fail` with no
   `(pass)` line at all. A reporter-format expectation, not a guard defect.
3. PGLite lane, all three attempts identically — `tests/integration/github-credential-wired.open.test.ts`
   → `full-suite runner excludes ambient credentials from every lane and failed assertion output`,
   failing at `:193` on
   `expect(output.includes('intentional assertion failure still reaches the host')).toBe(true)`. The
   same reporter-format change: the nested runner's failed-assertion text is no longer echoed in the
   shape the assertion expects. The lane's two retries are the runner's own WASM-flake retry policy
   (ISSUES #79/#327), not three different failures.
4. device lane — `app/__tests__/repl-model-control.test.tsx` →
   `conversation REPL model on phone > does not let a background model read roll back an acknowledged
   switch`, at `:100` `expect(completeGet).not.toBeNull()` after a 5.1s real-timer wait. Run on its
   own it PASSES, so it is a lane-contention/timing artifact.

**All four are classified `failed-preexisting`, and the classification is measured, not argued.**
Each failing test file, and every driver it executes (`scripts/run-tests.sh`,
`scripts/ci/typecheck-all.sh`), is byte-identical to `b8411957` — `git rev-parse b8411957:<path>` and
`git rev-parse HEAD:<path>` return the same blob. None of the 24 files this branch changes is
imported or executed by any of the four. And the direct comparison: the same command
(`bun test <the four files> --timeout=15000 --max-concurrency=16`) measures **23 pass / 5 fail** at
HEAD and **23 pass / 5 fail** at the base — the identical five names — where the base was measured by
checking the launch-base tree into this same worktree (`git checkout b8411957 -- .`, `node_modules`
untouched so the environment is held constant) and restoring it with `git checkout HEAD -- .`, after
which `git status --short` was empty and `HEAD` was still `96baa204`. The two extra reds in that
standalone pairing come from the credential file's lane environment, and they too are identical on
both sides. No red on this branch is new.

PR #1152 was read and not touched: `Drop the Claude-Session trailer from loop-authored commits
(#1133)`, `isDraft: true`, `OPEN`, head `ce601b78`. Publication, ready-for-review and merge belong to
the host.

One thing this round measured about the wrapper itself, recorded because a later reader will see the
amend in the reflog and wonder: invoked from a shell rather than from the CLI's own commit path, the
wrapper strips nothing (there is no `Claude-Session:` line to strip, which is the point) but it also
does not SUPPLY `Co-Authored-By` — that trailer is the CLI's, not the wrapper's. The first attempt at
this commit therefore landed with `Claude-Session: 0` and `Co-Authored-By: 0`, which is the same
provenance shape the abandoned `fix/pr1152-guard-repairs` commits carry and the reason they were
never merged. It was corrected in place with `commit-with-resolved-head.sh … --amend`, passing the
trailer as its own `-m` paragraph, and the published head carries `Claude-Session: 0` /
`Co-Authored-By: 1` like the other 24. The provenance check is what caught it; reading the wrapper's
exit code alone would not have.

### Round 29: the anchor sweep is widened from the chartered rows to every row the branch shifted

Round 28 re-anchored the rows it was chartered on (G100, G135, G139, G166) and stopped there. The
review round that followed named the gap precisely: *an edit that shifts a cited file must re-anchor
every row citing it, not only the rows the round was chartered on.* Nine more inventory rows
(G083, G084, G085, G086, G098, G099, G101, G102, G103) cite `trident/publication.ts`, and this
branch moved every statement they name.

MEASURED, NOT RECITED. The branch's own diff against the launch base `b8411957` is the instrument:
for each file it touches, `difflib.SequenceMatcher` over `git show b8411957:<path>` versus the head
copy yields an exact old-line → new-line map across the unchanged blocks, and every rewritten
citation satisfies `head[new] == base[old]` byte-for-byte. That assertion is what ran; a citation
whose old line fell INSIDE a changed region would have been reported instead of guessed, and none
did. The sweep covers only the shift this branch introduced — it does not re-adjudicate whether a
given anchor named the right statement at the launch base, which is a separate, pre-existing
question this card did not open.

**112 citations across 53 rows**, in four files:

- `trident/publication.ts` — 18 citations, 9 rows. Four insertions (after old lines 10, 68, 220 and
  247) put 57 net lines above most of the file: G083 `:86 → :98`, `:94 → :106`; G084 `:118 → :130`,
  `:119 → :131`; G085 `:134 → :146`; G086 `:141 → :153`, `:146 → :158`; G098 `:250 → :307`,
  `:255 → :312`; G099 `:267 → :324`; G101 `:291 → :348`, `:294 → :351`; G102 `:415 → :472`,
  `:555 → :612`, `:579 → :636`; G103 `:490 → :547`, `:514 → :571`, `:542 → :599`.
- `trident/orchestrator.test.ts` — 64 citations, 36 rows, all `+1` from the single line inserted
  after old line 764.
- `trident/inner-workflow.test.ts` — 18 citations, 10 rows, all `+16` from the 16 lines inserted
  after old line 762.
- `trident/publish-rebase-realgit.test.ts` — 12 citations, 5 rows, all `+1` from the line added
  after old line 89.

The rows round 28 DID re-anchor were re-read rather than assumed: G100, G135, G139 and G166 still
resolve to the statements they name on this head, so they were left alone.

IN-SOURCE ANCHORS, AND EVERY COPY OF THE SAME CLAIM. Two prose anchors inside
`trident/gates/release-readiness.ts` named lines that had moved:

- `sessionTrailerCarriers` (`:94`) cited `leak-preflight.ts:452` for the `stdout.trim()` clause;
  `:448` is `const newHead = revparse.stdout.trim()` and `:452` is now the `update-ref` argv. The
  G166 inventory row already carried `:448` after round 28, so the file and the row disagreed.
- `publicationReadiness` (`:228`) cited `gates/build-claim.ts:57` as the sibling that awaits
  correctly; round 27's try/catch moved that call to `:65`, and `:57` is now
  `if (before !== snapshot.head) {`.

The same two claims appear verbatim in three other places this branch ships, and all three were
corrected with it: `trident/publication-session-trailer-realgit.test.ts:286` (`:452 → :448`) and
this shard's own round-24 and round-27 narrative at `:1597` (`:452 → :448`) and `:1540`
(`:57 → :65`). The round-28 entry above legitimately names BOTH numbers — it is the record of the
correction — and was left as written. Every edit in this paragraph is a same-width in-place digit
change, so no file shifted and no new anchor went stale.

NAMED AND NOT CORRECTED, so the next round does not read silence as absence: `pinnedMergeReadiness`
carries `build-run.ts:195` in its docblock and `merge.ts:203–238` at `:264`; neither file is touched
by this branch, the drift predates the launch base, and the intended statement for `build-run.ts:195`
is not recoverable by reading — `--match-head-commit` lives in `merge.ts`, not `build-run.ts`. The
`docs/as-built/commit-wrapper-and-raw-publication-integration.md:59` pair
(`build-claim.ts:57`, `:66`) is stale for the same round-27 shift but states a different claim, and
guessing its two intended lines is not re-reading. Both belong to a follow-up card, not to this one.

Validation on this head: `bun test` over `gates-inventory-citations`, `gates/release-readiness`,
`gates/build-claim`, `gates/build-claim-scan-failure` (55 pass / 0 fail / 1774 expects);
`publication-session-trailer-realgit`, `gates/build-claim-realgit`, `scripts/ci/as-built-write-guard`,
`build-host` (84 pass / 0 fail); `inner-workflow`, `publish-rebase-realgit`,
`commit-with-resolved-head-realgit`, `scripts/ci/typecheck-worktree` (245 pass / 1 fail). The one
red is `typecheck-all — real linked worktrees > a fresh worktree installs locally and typechecks`,
failing on `scripts/ci/typecheck-all.sh: line 71: bunx: command not found`; `bunx` is absent from
this sandbox's PATH and neither `scripts/ci/typecheck-all.sh` nor `app/tsconfig.json` appears in
this branch's diff, so it is an environment gap, not a regression from this round. Both
`npx tsc --noEmit -p tsconfig.json` and `-p trident/tsconfig.json` print zero lines; this worktree's
`node_modules/@neutronai` is a symlink farm into the main checkout, so that typecheck resolves the
main tree's package sources, and this round's only TypeScript edits are two comment lines.

### Round 30: G166 accepts the commit the wrapper itself produces, and the bound is pinned from both sides

Round 29's review panel found the first BEHAVIOURAL defect since round 26: the G166 scan refused a
commit that `trident/commit-with-resolved-head.sh` produces from a plain call. Every earlier round-29
finding was citation accuracy; this one is not.

#### T1 — the separator arm refused before it could authenticate

REPRODUCED FIRST, on real git with the wrapper from `4d3c68a8`. `bash commit-with-resolved-head.sh
change -m subj -m 'Claude-Session: a' -m 'Claude-Session: b'` exits 0 and leaves a raw object
ending `subj\n\n` (196 bytes in a scratch repo; `od -c` tail `s u b j \n \n`). `strip_session_trailer`
(`trident/commit-with-resolved-head.sh:19`) drops the blank AFTER a wholly-dropped paragraph, else
the one BEFORE it when the paragraph is the tail; with two trailing trailer paragraphs both drops
land on the blank between them, so the blank before the first survives as the last kept line. The
trimming production runner (`spawnCapture`) loses both LFs: a two-byte gap WITH the header/message
boundary present. `trident/gates/release-readiness.ts:148` read `missing > 1` and returned
`unknown` before `restoredCommitMatches` on `:149` could authenticate the two proposed LFs, and
`publication.ts` turns that `unknown` into a refusal on all three origin-facing publishers.

The regressions were appended to `trident/gates/release-readiness.test.ts` at EOF (so none of the
28 existing `test(` anchors moved) and run RED on the unmodified `4d3c68a8` source: 5 fail / 41 pass.
The wrapper reproduction's red line, verbatim from the sha1 run:
`"detail": "Publication commit c3544c43133a187362d83e2e3459c1cddacc6712 was read incompletely (218 of 220 bytes)"`
(the fixture identity is longer than the scratch repo's, hence 220 rather than 196; the gap is the
same 2). The sha256 variant red at `266 of 268 bytes`.

THE FIX is one comparison: `:148` `missing > 1` → `missing > 2`, so a separator-present gap of up to
two bytes reaches the OID authenticator and is decided by it. The comment at `:133`-`:137` was
rewritten in place with the same line count, so `release-readiness.ts` is still 283 lines and every
`release-readiness.ts:NNN` citation in the inventory, this shard and the sibling test files still
resolves to the statement it named. The wrapper was deliberately NOT changed: the commit it produces
is well formed, a wrapper change would not help a `--cleanup=verbatim` or third-party commit already
in a publication window, and the gate must accept every OID-authenticated shape regardless. The
surviving trailing blank is cosmetic and is follow-up material, not a defect.

Six tests, anchors `:698`, `:725`, `:754`, `:759`, `:764`, `:774` (added to the G166 inventory row,
whose `release-readiness.test.ts` anchors again equal the file's own 34 `test(` lines):

- `:698` (sha1 and sha256) — the real wrapper call above: exit 0, raw object ends `\n\nsubj\n\n`
  with no `Claude-Session`, `cat-file -s` minus the `productionRun` capture is exactly 2, the
  capture still contains `\n\n`; `sessionTrailerReadiness` and `publicationReadiness` both `allow`
  through `productionRun`, and through the untrimming double.
- `:725` (sha1 and sha256) — real git, `--cleanup=verbatim` `feat: v\n\n\n`: a 3-byte gap through
  `productionRun` stays `unknown` with the plain gap detail; the untrimming double allows.
- `:754` — fake host, clean object ending `subject\n\n` captured two short: `allow`.
- `:759` — fake host, CARRIER ending `Claude-Session: fake\n\n` captured two short: `blocked`,
  naming its OID. The relaxation never demotes a carrier.
- `:764` — fake host, a two-byte gap whose lost bytes are `>\n`, not LFs: `unknown` with
  `captured bytes and proposed terminators do not match the commit OID` — the relaxed bound reaches
  the authenticator and the authenticator refuses. A genuinely truncated read stays `unknown`.
- `:774` — fake host, a three-LF gap: `unknown` with the plain gap detail, WITH a positive control
  that the same bytes plus three LFs DO reproduce the OID, so the refusal is the bound declining to
  reconstruct, not an authentication that happened to fail.

MUTATIONS, each applied alone, run, and restored (guard `bun test
trident/gates/release-readiness.test.ts`, control `bun test trident/gates/build-claim.test.ts`):

- UNDER, `missing > 2` → `missing > 1` (the pre-fix code): guard 5 fail / 41 pass — `:698` sha1 and
  sha256, `:754`, `:759` (reads `unknown` instead of `blocked`) and `:764` (the plain gap detail
  instead of the OID-mismatch detail, i.e. the authenticator was never consulted). `:725` and
  `:774` stay green, as they must. Control 10 pass / 0 fail.
- OVER, `missing > 2` → `missing > 3`: guard 3 fail / 43 pass — `:725` sha1 and sha256 (the verbatim
  three-LF commit authenticates and is ALLOWED) and `:774`. So the bound is pinned at three, not
  merely loosened. Control 10 pass / 0 fail.
- Restored: guard 46 pass / 0 fail, 213 expects.

DOCUMENTS CORRECTED WITH IT, in place and line-neutral so no citation of this shard moved: the
round-22 rule list now records the new `missing >= 3` boundary, and the round-23 "measured fixtures"
paragraph, which asserted a wrapper-rebuilt commit is "always one of the three measured shapes" and
that only "two or more" trailing whitespace bytes are refused, now names the fourth shape and the
three-or-more boundary. The G166 inventory row's enforcement text said a boundary capture "permits
direct bytes or one proposed LF"; it now says up to two, and that three or more are unknown without
reconstruction. `grep -rn "one missing LF\|one proposed LF\|missing > 1" trident docs` now hits
only this shard: the round-22 mutation record (`:1435`, a historical `missing > 1` → `missing > 99`
run) and this entry's own quotations of the old code. No source file and no inventory row states
the old bound; the same search for `missing > 2` finds `release-readiness.ts:148` (positive control).

#### T2 — the inventory's prose positive control cited a blank line

`docs/trident-gates-inventory.md:35` names `enforceCrossModelGate` in
`trident/inner-workflow.test.ts:979` as the positive control for NO TEST adjudication. At the base
`f542a488` that line is `expect(SRC).toContain('function enforceCrossModelGate(')`; on this branch
the 16 lines inserted after old `:762` left `:979` BLANK and moved the statement to `:995`
(byte-equal to base `:979`). The round-29 sweep missed it because its instrument matched only
`| Gnnn |` rows. Re-anchored `:979` → `:995`.

THE WHOLE-FILE SCAN, run-owned: every `(trident|scripts|open|docs)/…:(\d+)` on every line of the
inventory (prose, table rows, headers alike; `pre-#845` refs excluded), each read at its revision
with `git show` and classified ok / blank / past-EOF / missing file, keyed by gate id or, for prose,
by the line's own text (a line-number key misreports the one prose line the branch's new row shifts
from `:292` to `:293`). Base: 578 citations, 38 broken. Head before T2: 719 citations, 38 broken,
ONE key with more broken than the base — the `:35` prose line. After T2: 719 citations, 37 broken,
ZERO keys with more broken than the base. (G139 shows fewer broken on head only by accident — see
T3.)

THE REGRESSION: a second test in `trident/gates-inventory-citations.test.ts` locates the sentence by
pattern, asserts exactly one match, and asserts the cited `inner-workflow.test.ts` line contains
`enforceCrossModelGate`. The first test reads only the TEST column of table rows and checks only
existence and EOF, which is why nothing was red. Mutation, `:995` → `:979` on inventory `:35`: 1 fail /
1 pass (the new test). Control `bun test ./trident/gates/build-claim.test.ts`: 10 pass / 0 fail.
Restored: 2 pass / 0 fail.
