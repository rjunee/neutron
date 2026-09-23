## 2026-09-19 — Integrate commit-ref safety and raw publication history checks

The locked design says the project REPL “runs the build”
(`docs/plans/harness-orchestrator-pivot-2026-09-11.md:87`). The consuming
specification keeps every existing gate and requires unattended dispatch to
MERGED (`docs/spec-items/the-orchestrator-owns-the-build-loop.md:56`, `:64`).
This local candidate preserves bounded G135/G166 checks; it does not establish
that full product outcome or claim publication, deployment or merge readiness.

The exact integration base is `bb6065b4d8562760e483b8b8eb3129d6dfec33a6`,
the published PR #1152 head (round 18). Round 19 re-lands that head by MERGE onto
the deployed launch base `822488b2a9d5006dea46ef736055094dbe383115` (origin/main
at #1176; `git merge --no-ff`, merge-tree clean, no conflict) so the G063 host
repairs (#1172, #1173, #1174, #1176) stay in the ancestry, and applies the
bounded repair delta on top: 8 files, +411/-35 against `bb6065b4`, taken as one
`format-patch` and nothing else from the candidate checkout.
The wrapper repair comes from `f979c3771a31eff384768887a0714a00cc65afac`, and
the raw-graph repair from `a5bf9dbb29f1836a52f418390e28746c97994fdc`.
Only the two concurrent-local-ref regression cases are taken from
`3b7aed8ecf9a03655ce7d098c86836dc20efbef7`: the base already pins the salvage
push to the scanned object (`trident/publication.ts:307`). Its production
publication implementation is unchanged.

The wrapper conflicts were resolved by retaining the base's single
`scan_commit_argv` function, including its existing literal-message regression,
and incorporating the repair's negated-option handling, provenance refusal and
ref transactions (`trident/commit-with-resolved-head.sh:131`, `:228`, `:355`).
An initial object-read failure now refuses without withdrawing an object whose
provenance is unknown. This supersedes the initial-read withdrawal description
in the immutable earlier record (`docs/as-built/drop-claude-session-trailer.md:551`).
Later failures can still withdraw a proven commit. Publication and withdrawal
prepare a no-dereference transaction and check the captured ref's type while its
lock is held; a concurrent attachment is preserved rather than followed or
silently detached (`trident/commit-with-resolved-head.sh:248`, `:268`, `:501`).

The shared publication scan disables replacement objects on both the graph walk
and object reads, ignores shallow boundaries and legacy grafts, and disables the
commit-graph cache (`trident/gates/release-readiness.ts:39`, `:47`). Missing raw
history returns unknown. The G100 fake-host test now identifies command tokens
instead of fixed argument positions and explicitly asserts the raw Git argv;
its preservation assertions remain (`trident/gates/build-claim.test.ts:25`).
The two salvage races advance to clean and trailer-bearing commits immediately
before push and read the receiver's raw object to verify that the scanned commit
alone was published (`trident/publication-session-trailer-realgit.test.ts:148`).

The G100 conflict, and the decision. Round 18's `checkBuildClaim` returned
`branch NOT preserved on origin` and pushed nothing when the G166 scan found a
carrier or could not measure the range. That contradicted the G100 row, which
promises preservation on origin before the refusal
(`docs/trident-gates-inventory.md:184`), and the candidate left it "an owner
decision". The owner decided on 2026-09-19: G100 is not superseded, and G139's
advisory leak-preflight semantics are not touched by G166 either. So on the
preservation path the scan still runs BEFORE the push, over the same raw
objects the push publishes, and its result is NAMED in the refusal -- `; branch
preserved on origin; preserved range: Publication branch carries a
Claude-Session trailer on N commit(s) above the launch base: <shas> -- strip
before any PR`, or `; branch preserved on origin; session-trailer scan
unmeasured: <detail>` -- but it never withholds the push
(`trident/gates/build-claim.ts:57`, `:66`). The refusal already stands (no PR,
no review); what the scan adds is the fact the next round needs. The checked
publishers and the salvage push stay fail-closed exactly as before
(`trident/gates/release-readiness.ts:110`, `trident/publication.ts:259`): those
are PR-bound pushes, and G100's is the one push whose job is to preserve a
refused build. The three tests that encoded the superseding policy were flipped
to assert the push argv IS issued, that the scan's `cat-file` precedes it, that
origin HOLDS the measured head, and that the refusal names the carrier
(`trident/gates/build-claim.test.ts:81`, `:98`;
`trident/gates/build-claim-realgit.test.ts:114`, `:137`;
`trident/build-host.test.ts:811`). The G166 inventory row was reworded to say so
and to state that this scan is a raw-object check of the loop's own commits, not
the leak preflight. The leak preflight code (`trident/publication.ts:212-231`)
is byte-identical to main.

Validation on the round-19 tree (all measured here, not carried over):

- Named suites on the final tree: `commit-with-resolved-head-realgit`,
  `gates/release-readiness`, `gates/build-claim`, `gates/build-claim-realgit`,
  `publication-session-trailer-realgit`, `build-host`,
  `gates-inventory-citations`, `orchestrator` = 470 pass / 0 fail across 8
  files; explicit consuming `open/__tests__/project-build-e2e.test.ts` = 89 / 0;
  stage 1 over the branch's cumulative changed test files plus the
  basename-naming tests = 770 / 0 across 13 files.
- `tsc --noEmit -p tsconfig.json` and `tsc --noEmit -p trident/tsconfig.json`
  both exit 0; `bash -n` on the wrapper and `git diff --check` clean.
- The wrapper fixture (eight modes, re-pointed at this tree, the under/over CAS
  mutation anchored on the `update %s %s %s` transaction line): ordinary 0 with
  no trailer; `concurrent-readfail` 8 with the foreign commit still reachable
  and nothing withdrawn; `detached-switch-readfail` 8 with `refs/heads/other`
  left at the trailer commit and `main` unchanged; `message-amend` 0 with the
  message `--amend`; `lostcas` 74; `under-cas` (no expected old value) 0 with
  the foreign commit LOST, proving the compare-and-swap matters; `over-cas`
  (wrong expected value) 74 on an ordinary strip; `clean-over-control` 0.
- The raw-graph probe: baseline blocked naming the carrier; after `git replace`
  of the carrier still blocked and the raw carrier still present; after a
  `.git/shallow` boundary at the head still blocked and the raw head's parent
  still the carrier.
- Mutations, each reverted before the final run. Under: restoring the
  `NOT preserved` early return turns the three preservation tests red (3 fail /
  64 pass across the three files) while `gates/release-readiness.test.ts` stays
  17 / 0 as the control; making `sessionTrailerLine` never match turns 16
  carrier tests red across the four scan files (the card's "re-adding the
  trailer turns the test red" at every publisher); disabling
  `strip_session_trailer` turns 44 wrapper tests red; dropping
  `--no-replace-objects` from the object read turns exactly the `message
  replacement` raw-graph test red. Over: forcing the locked ref-type check
  unconditional turns 41 wrapper tests red, the `semantic under/over controls`
  test among them (`trident/commit-with-resolved-head-realgit.test.ts:1406`);
  an ordinary clean commit through the wrapper exits 0 and a clean ordinary
  range publishes `allow` on the restored tree.
- Positive controls: `grep -rn 'NOT preserved on origin' trident` returns
  nothing on this tree while `grep -rn 'branch preserved on origin' trident`
  finds the production line; `git log --format=%B <launch base>..HEAD` has 0
  lines beginning `Claude-Session:` and a positive count of `Co-Authored-By`.

Same-parent sibling ambiguity in wrapper provenance remains
(`trident/commit-with-resolved-head.sh:370`). The first-publication ancestry
check can still refuse a complete clean history when a local shallow view hides
the launch base, although the shared raw scan allows it
(`trident/gates/release-readiness.ts:98`). The full suite is the host's
terminal receipt on the published head; no acceptance checkbox is closed by
these local measurements.

### Round 20: the raw-graph listing is a plain `git` argv; the graft override rides in `extraEnv`

Round 19's review (two Opus seats REQUEST_CHANGES, Codex APPROVE with no findings,
synthesis REQUEST_CHANGES) measured one blocker on head `bdc7ac05`: the range
listing was issued as `['env', 'GIT_GRAFT_FILE=/dev/null', ...git argv]`. Every
host double on the salvage path admits only `cmd[0] === 'git'` / `'gh'` and throws
on anything else (`trident/stranded-salvage-realgit.test.ts:250`,
`gateway/composition/build-core-modules-trident-stranded-sweep.test.ts:100`);
`sessionTrailerCarriers` has no try/catch, so the throw escaped `publishBuiltCommit`
into `reconcile_stranded`, which recorded no PR. CI run 35469281142 on that head was
red on shards 2/4 and 3/4 with exactly those 7 tests; both suites are green on
`origin/main`. Round 19's validation list never ran either consumer, and the
comment it reasoned from called `publishBuiltCommit` "the salvage push" alone.

The repair (this round, 5 files):

- `trident/gates/release-readiness.ts:58-60`: the listing is `gitRangeArgv(...)`
  unchanged, a plain `git` argv; `GIT_GRAFT_FILE=/dev/null` travels as the runner's
  typed third parameter (`EnvCapableHostRunner` `extraEnv`, `trident/git-mode.ts`),
  exported as `RAW_GRAPH_ENV` (`:28`). `spawnCapture`, `makeCredentialedHostRunner`
  and its per-command variant all merge `extraEnv` over the inherited environment,
  so production behaviour is unchanged; a double that drops the third parameter
  simply leaves `$GIT_DIR/info/grafts` in force for that test and never throws.
  `-c advice.graftFileDeprecated=false` joins the raw-graph config so git's 8-line
  graft-file hint (printed whenever the named graft file exists; `/dev/null` does)
  stays out of every captured stderr. Measured on git 2.43.0: the env-carried
  override lists the grafted-away carrier (2 commits, not 1) with 0 stderr lines;
  without the advice switch the same listing prints the 8-line hint.
- `trident/gates/release-readiness.test.ts:84` — the regression for the blocker: a
  `gitOnlyRun` double with the salvage suites' exact contract (throws on a non-`git`
  argv) answers the whole checked-publisher path and the shared scan; the listing's
  argv is pinned, its `extraEnv` is pinned to `{ GIT_GRAFT_FILE: '/dev/null' }`, the
  `cat-file` reads carry no env, and the positive control proves the same double
  rejects the round-19 prefixed argv. `:108` pins an empty stderr on the listing,
  with the un-switched argv printing the hint as its positive control.
  `productionRun` (`:69`) now forwards `extraEnv` the way the credentialed runner
  does; without that the graft case (`:140`) goes red.
- `trident/gates/build-claim.test.ts:24`: the fake host records `extraEnv`; the argv
  pin at `calls[3]` is the plain `git` listing with the advice switch, `envs[3]` is
  the graft override, and every recorded call starts with `git`.
- `trident/publication.ts:233` and `trident/gates/release-readiness.ts:81`, `:139`:
  `publishBuiltCommit` is described as what it is — the `publish_requested`
  publisher after every legacy-loop build and fix round
  (`trident/orchestrator.ts:2379`) AND `reconcile_stranded`'s salvage push
  (`:1583`) — so the fail-closed scan is documented as gating every legacy-loop
  publication, which is the blast radius #1133 asks for.
- The G166 inventory row states the argv/`extraEnv` contract, names the two
  consumer suites, and documents the scan-window constraint both seats raised: the
  checked publishers scan from the dispatch-time launch pin, `origin/main` carries
  one carrier (`0fc6cb83`, #1131's squash, 2026-09-16), so a lane pinned before it
  that merges main is refused naming a sha it cannot strip. That is the review
  diff's own window, it closes as pins move past that commit, and the salvage path
  scans from the observed base tip; the row and the gate comment say a refusal
  naming an ancestor of `origin/<base>` is a stale-pin window, not a wrapper
  failure. Excluding base-branch commits on the checked path would need the base
  branch name plumbed into `publicationReadiness`; not done this round. The
  per-commit `cat-file` spawn (nit) is kept: the runner caps stdout, and one
  object per call keeps a capped read from truncating a batch mid-object.
  Every `file:line` anchor in the G100 and G166 rows was re-measured on this tree
  (the round-19 anchors above refer to the round-19 tree).

Validation on the round-20 tree, all measured here:

- Stage 1 (the branch's 11 cumulative changed test files; (b) and (c) both exceed
  the 40-file cap and were dropped whole): 664 pass / 0 fail across 11 files. The
  two consumer suites plus `open/__tests__/project-build-e2e.test.ts`,
  `scripts/ci/as-built-write-guard.test.ts` and `trident/inner-workflow-gates.test.ts`:
  146 / 0 across 5 files (`stranded-salvage-realgit` 20 / 0, the sweep 1 / 0).
- `tsc --noEmit -p tsconfig.json` and `tsc --noEmit -p trident/tsconfig.json` both
  exit 0; `git diff --check` clean; `scripts/ci/as-built-write-guard.sh` OK on the
  working tree against the launch base.
- Mutations, each reverted before the final run. Under: restoring the round-19
  `env` prefix turns the new git-only test red and reproduces the 6
  `stranded-salvage-realgit` reds while `publication-session-trailer-realgit`
  (whose host forwards everything but `gh` to `spawnCapture`) stays green as the
  control; dropping `RAW_GRAPH_ENV` from the listing turns the `graft` raw-graph
  case and the git-only test red; dropping the advice switch turns the
  quiet-stderr test red. Over: the clean-range positive control, the
  shallow-view clean range and the ordinary Co-Authored-By commit all publish
  `allow` on the restored tree.
- Positive controls: `grep -rn "'env', 'GIT_GRAFT_FILE" trident gateway open
  --include=*.ts` excluding tests returns nothing, and the same grep over tests
  finds the literal in the regression's positive control; `git log --format=%B
  <launch base>..HEAD` has 0 lines beginning `Claude-Session:` and 14
  `Co-Authored-By` lines before this round's commit.

The full suite is the host's terminal receipt on the published head; this round
reports it deferred as the brief instructs.
