## 2026-09-14 — branches write their own as-built shard

### What changed

Branches now add `docs/as-built/<slug>.md` directly in the PR that earns the record. The frozen monolith and every merged shard remain immutable; `scripts/ci/as-built-write-guard.sh` permits a new well-formed shard and refuses writes to either kind of history.

The staging directory, publisher, scratch-worktree promotion, tick catch-up, staging-floor guard, and their queue-specific tests were deleted. Trident needs no post-merge as-built step when it publishes again: its build author writes the same shard as a human author, so the record is reviewed and becomes durable with the code rather than depending on a second process.

### Evidence

`scripts/ci/as-built-write-guard.sh:136` computes one name-status diff over the frozen monolith and shard directory; `scripts/ci/as-built-write-guard.sh:237` refuses non-additions under `docs/as-built/`; and `scripts/ci/as-built-write-guard.sh:248` validates added shard paths and headings. `trident/orchestrator.ts:5338` now proceeds from successful merge cleanup directly to the done result. The gateway constructs the tick loop without a publisher callback at `gateway/composition/build-core-modules.ts:828`.

The concurrency property was exercised at `scripts/ci/as-built-write-guard.test.ts:200` with two real branches cut from one base, each adding a different shard, followed by real merges of both at `scripts/ci/as-built-write-guard.test.ts:220` and an assertion that both files exist with no unresolved path at `scripts/ci/as-built-write-guard.test.ts:223`.

Executable references were enumerated with `rg` over every TypeScript and shell file for the deleted publisher, promotion, catch-up, floor guard, and staging-path names. The result was empty; the same command's positive control found the surviving direct path at `scripts/ci/as-built-write-guard.sh:8` and merge cleanup at `trident/orchestrator.ts:5339`. Tracked staging-directory paths were enumerated with `git ls-files`; all five results are deletions in this change, while the positive control enumerated `.trident/plans/`.

### Decisions

The old one-writer rule contained two independent properties. Serial post-merge publication died because separate shard paths have no shared insertion offset. Immutability survives: `docs/process/work-tracking.md:131` defines the frozen monolith and merged shards as history, maintained continuously by the CI write guard at `scripts/ci/as-built-write-guard.sh:221` and `scripts/ci/as-built-write-guard.sh:237` without relying on the author or publisher to cooperate.

The one-top-level-entry shape also survives the move because it makes each shard independently readable; it moved into the direct-write guard. Filename collision suffixing, landing-time ordering, malformed-queue retention, non-fast-forward publication, and staging floors died with the queue because none describes a direct shard.

The existing guard outcome vocabulary remains unchanged: `scripts/ci/as-built-write-guard.sh:31` names exit 0 as allowed, exit 1 as a known policy violation, and exit 2 as an indeterminate check. A malformed new shard and an edit to existing history join exit 1 at `scripts/ci/as-built-write-guard.sh:237` and `scripts/ci/as-built-write-guard.sh:267`.

### Mutation table

| Guard | Mutation | Red result | Restored result |
|---|---|---|---|
| Frozen monolith | Disabled the path predicate at `scripts/ci/as-built-write-guard.sh` | Guard suite failed because monolith edits and renames passed | Guard suite green |
| Existing shard immutability | Inverted the `status != A` condition | Guard suite failed because additions were refused and an existing edit passed | Guard suite green |
| New shard shape | Replaced the heading predicate with `false` | Guard suite failed because malformed prose passed | Guard suite green |

### Deliberately not done

Historical as-built records and completed plans still describe the machinery that existed when those changes shipped; they were not rewritten. The frozen `docs/AS_BUILT.md` was not touched. No compatibility flag or alternate publisher path remains.
