## 2026-09-14 — tracked-file absence names its ref

### What changed

The repository-wide evidence rule now distinguishes a content search from a
tracked-file existence question. It requires the latter to name a fetched ref,
shows `git ls-tree` with a known-present path as its control, and explains why a
working-tree hit cannot validate the ref claim (`AGENTS.md:67-76`).

The reusable probe now exposes `trackedFilesAtRef`, whose required `ref` argument
is passed directly to `git ls-tree` (`trident/as-built-union-attribute.ts:386-403`).
It throws when git cannot inspect that ref (`trident/as-built-union-attribute.ts:404-406`).
The distinct `workingTreeFiles` predicate answers only what exists on disk
(`trident/as-built-union-attribute.ts:409-412`). The existing clone-floor path
now hands its resolved treeish to the ref predicate and uses the working-tree
predicate only when it has already established that the input is not a repository
top level (`trident/as-built-union-attribute.ts:349-376`).

The acceptance criteria are recorded in
`docs/spec-items/absence-is-a-question-about-the-ref.md:25-39`. The real-git
fixtures independently pin ref-only, working-tree-only, and unreadable-ref cases
(`trident/as-built-union-attribute.test.ts:783-813`).

### Decisions

The ref is a required value rather than an implicit `HEAD` default. That makes
the authority visible at every direct call. The older clone-oriented wrapper
keeps its index handling for an unborn `HEAD`; that is explicitly an index
question and remains separate from the named-ref probe
(`trident/as-built-union-attribute.ts:350-363`).

Probe failure joins the module's existing exception vocabulary: the clone-floor
wrapper catches it and rethrows its established fail-closed committed-tree error
(`trident/as-built-union-attribute.ts:364-373`). A direct caller that does not
classify it gets the ordinary uncaught-error nonzero outcome; it can no longer
receive an empty success by default.

Tracked rule copies were enumerated with `rg` for the distinctive rule phrases.
The live general rule occurs at `AGENTS.md:67-76`. The remaining similar sentence
at `docs/spec-items/resolve-the-review-diff-base.md:585-593` stays because it is
explicitly about a content scan whose executable `runControls()` finds known
content, not tracked-file existence.

### Mutation table

| Guard | Mutation and landed line | Red | Restored green |
|---|---|---|---|
| ref reports present | inverted `tracked.has` at `trident/as-built-union-attribute.ts:403` | targeted ref-only test: 1 failed | targeted test: 1 passed |
| ref reports absent while disk reports present | inverted `tracked.has` at `trident/as-built-union-attribute.ts:403` | targeted working-tree-only test: 1 failed | targeted test: 1 passed |
| unreadable ref differs from empty result | replaced the throw with `return []` at `trident/as-built-union-attribute.ts:405` | targeted unreadable-ref test: 1 failed | restored focused suite: 108 passed |

Each mutation line was printed and the production diff was shown before its red
run. After restoration, `bun test trident/as-built-union-attribute.test.ts
scripts/__tests__/spec-items-index.test.ts` passed 108 tests. The typecheck matrix
passed all 51 projects. The repository lint gates passed.

### Deliberately not changed

`SPEC.md` is unchanged because this refines evidence collection and does not
change a product decision. The unborn-repository index path remains supported:
there is no ref to name before the first commit, and the existing test pins that
separate state (`trident/as-built-union-attribute.test.ts:692-697`). Historical
as-built records were not rewritten.

## Review-lane addition — the same conflation in the sibling that READS the file

The build lane fixed the predicate that answers *whether* a path is tracked. The
enumeration the task asked for turns up one more site in the same file, asking the
same question of the same treeish, and still collapsing the two answers:
`collectTrackedAttributesFiles` ran `git show <treeish>:<path>` and turned ANY
nonzero exit into `content = null`, commented "not committed — it reaches no
clone" (`trident/as-built-union-attribute.ts`, pre-change). `git show` exits
nonzero for a path that is not in the tree AND for a tree it could not read at all
— a missing blob, a poisoned object directory, a git that would not run. "It is
not there" and "I could not look" shared a branch, and the failure was spelled as
the finding, in the same file whose sibling `clonedTreeContains` had already been
hardened against exactly that (its `catch` is the fail-closed one).

The consequence is the same one that hardening exists to prevent: a governed repo
whose `.gitattributes` could not be read reports as a repo with no rule, and the
gate that consumes it (`scripts/ci/check-governed-repo-attributes.ts:198`) draws
its conclusion from an absence that was never established.

Fix: `clonedTreeContains` answers the EXISTENCE question first — against the same
source, failing closed when it cannot read it — and only a path it established as
present is then read. A failure to read THAT throws, because the path is tracked.
Untracked paths are never `git show`n at all, so the common case changes nothing.

Regression case: a repo whose committed `.gitattributes` BLOB is removed while the
TREE object is left intact, so `ls-tree` still lists the path and `show` cannot
produce its bytes. It carries two controls — a read of the same repo BEFORE the
removal (so the case cannot pass on a repo that never had the file) and a repo
with no `.gitattributes` at all, which must still answer `[]` quietly, so "throws
on everything" does not satisfy it.

Enumeration method: `grep -rn existsSync scripts/ci/*.ts trident/*.ts`, reading
each hit for the question it answers. Every other hit is a genuine working-tree or
build-artifact question — `node_modules`, an expo bundle, a temp dir, a binary on
PATH — not a tracked-file claim. `grep -rln 'Evidence, not assertion' --include=AGENTS.md`
finds the rule in exactly one file here (the root); the sibling sentence at
`docs/spec-items/resolve-the-review-diff-base.md:590` is about a CONTENT scan,
which the new wording preserves unchanged, so it is correct as written.

### Review-lane mutation table

| Guard | Mutation and landed line | Red | Restored |
|---|---|---|---|
| the REF answers, not the working tree | `trackedFilesAtRef` swapped for `workingTreeFiles` at `as-built-union-attribute.ts:372` | 4 failed, incl. both "IGNORES an untracked/STAGED …" cases | 71 passed |
| ref membership | `tracked.has` inverted at `:420` | 17 failed | 71 passed |
| unreadable ref is not an empty answer | `throw` replaced by `return []` at `:421` | 1 failed | 71 passed |
| unreadable tracked file is not an absent one | `throw` replaced by `continue` at `:311` | 1 failed | 71 passed |
