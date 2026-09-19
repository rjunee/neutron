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
   the message), removes every line beginning `Claude-Session:` (ASCII case-insensitive,
   compared under the C locale so every byte is a byte) and amends the commit in place with
   `--amend --only --no-verify --cleanup=verbatim -F <file>` (author, parent, tree and
   `Co-Authored-By` untouched; `--only` is what keeps the TREE untouched, see the review
   findings below). The stored message is byte-exact: the first commit's message minus the
   removed line and, when that line was a paragraph of its own (the way the CLI reminder
   makes the agent write it), the one empty line that separated that paragraph; a missing
   final newline stays missing and no cleanup pass runs a second time. If the read-back or
   the amend fails for any reason the wrapper fails closed: it withdraws the commit it just
   made (`git reset --soft` to the HEAD the probe found, index and worktree kept) and exits
   with git's code, so a trailer-bearing commit is never left on the branch. The refusal
   exits 64-67 are byte-for-byte unchanged. `trident/commit-with-resolved-head-realgit.test.ts`
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
  `git reset --soft "$head_oid"` (the HEAD the probe found before the commit), which
  withdraws the commit while keeping the index and worktree exactly as the first commit
  left them, so Forge can retry; the withdrawn commit survives only in the reflog. Stderr
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
  is a bash function running under `LC_ALL=C` (`read -r` with an empty IFS, `printf '%s'`),
  so every comparison is a byte comparison and a final line without a newline is written
  back without one; the bytes travel through files, never `$(...)`, which would drop the
  trailing newline. Real-git test with the positive control first (this host's grep loses
  the line and reports `binary`); after the wrapper the stored message holds the raw byte
  and the object still carries its `encoding ISO-8859-1` header.
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
  Closed: `${line,,}` under the C locale folds ASCII only, so `claude-session:` is removed
  and no non-ASCII byte is touched. Real-git test.
- **The G135 row described the old amend.** Closed: the row now states the invariant in the
  terms of the code it cites (raw object read, byte filter, verbatim amend, fail-closed
  withdrawal) and its anchors point at the current lines of the script and the tests,
  including the four added this round; two test anchors that had drifted by one line
  (`:60`, `:72` for tests starting at 59 and 71) are corrected.

### Mutation, proven by hand before nomination

`grep -c 'claude-session:\*) drop\[i\]=1; removed=1 ;;' trident/commit-with-resolved-head.sh`
= 1. Replacing that case arm with `claude-session:*) drop[i]=0 ;;` (the trailer is matched
and kept) turns 13 of the 23 tests in `commit-with-resolved-head-realgit.test.ts` red
(every strip test, including the four added this round) while
`runtime/adapters/claude-code/persistent/__tests__/build-settings.test.ts`, which never runs
the wrapper, stays green (15 pass); restoring the arm returns the guard to 23 / 0. This is
the nominated mutation.

The earlier nominations still hold and are kept as by-hand checks:


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
- `docs/AS_BUILT.md` and every existing shard: frozen; this record is a new shard.

### Effect after merge

The settings switch takes effect on the next REPL spawn from a deployed tree that carries
it; warm REPLs keep their old `--settings` file until they respawn. The wrapper strip takes
effect on the next Forge commit from a checkout that carries it, whatever the REPL's settings
say. The commit that lands this change was itself authored through the wrapper with a
deliberate `Claude-Session: https://claude.ai/code/session_01PROOF` paragraph on its argv,
and carries none. Merged is not shipped.

### Re-landed

This is round eight of the same card, on base `274c5b3e` (origin/main at #1162). Every earlier
round built correctly and died on a host defect. Round 1 (PR #1152 head `d7717e6c`) died at
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

Round 9 is on base `a1be24e0` (origin/main at #1169) and replays `2a4cbb5a` by cherry-pick
(merge-tree clean against main). Round 8 (`2a4cbb5a`, CI 12/12 green) was APPROVED with one
nit (the `-q` wording above, closed in round 9) and then died because the host's own
`scripts/run-tests.sh` refused to run in that worktree (`node_modules/.bun` absent, exit 3;
fixed by #1168); the run after it died because the build wrote `result.pr` as a bare number
instead of the snapshot object. Neither was a defect in the change. Round 9 (`bb653667`) was
APPROVED with the byte-exactness findings closed in round 10 (the section above), which
touches only the wrapper, its real-git tests, the G135 row and this record.
