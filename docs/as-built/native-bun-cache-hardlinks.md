## 2026-09-25 — Native scratch installs share Bun cache inodes

Addresses #1327. Linux sandbox bind mounts can put the default Bun cache and
writable scratch on different mounts despite identical device numbers. A real
hardlink probe returned `EXDEV`; Bun 1.3.13 then copied approximately 1.2 GiB
per dependency installation. Root preinstall scripts ran after materialization,
and the symlink backend broke a real React peer dependency import.

Normative scope is `docs/spec-items/native-bun-cache-hardlinks.md:22`: "Prepare
a private, UID-owned Bun cache under the native temporary directory", and
`:24`: "hardlinks only; never fall back to copying or expose a partially seeded
cache." The boundary at `:30` is "worktrees on the same writable scratch mount";
`:31` excludes free-space reservation and cleanup. Production delivery is at
`runtime/adapters/codex-cli/persistent/project-control-broker-transport.ts:22`;
the hardlink and identity check are at `native-bun-cache.ts:70`.

The measurements below were recorded by the original implementation session.
The unfinished task-owned worktree was resumed on 2026-09-26 with its staged
and unstaged changes preserved. A fresh run independently reproduced all 16
focused tests (34 assertions), and the real native smoke reproduced two direct
installs sharing the cache's inode, working React peers, valid TypeScript,
TS2322 for invalid TypeScript, and usable installed dependencies after fixture
cache removal. Isolated mutation copies independently failed when environment
delivery was removed, when hardlink seeding was replaced with copying, when
the private-directory mode check was removed, and when every cache was refused.
A fresh worktree dependency install using the existing scratch cache installed
2,503 packages in 758 ms. Historical measurements are not substituted for
current full-suite or review results.

Current independent review reproduced focused and consuming native proof and
found a smoke-fixture cleanup gap before its original `try/finally`. Setup now
shares the cleanup boundary: an actual sandbox provider-bind refusal leaves
zero new fixture/cache directories, and the host consuming smoke still passes.
Root, runtime and Trident TypeScript checks passed; the spec-index tests passed
38 cases. The as-built guard and commit-message leak scan passed. A scan of the
seven authored paths plus the license passed; a whole local tree scan reported
452 findings, so it is not claimed as a whole-tree purity pass.

`native-bun-cache.ts` prepares a UID-owned 0700 scratch cache before the native
app-server is spawned. Existing package files are hardlinked, never copied;
device/inode checks verify the result. Atomic publication and a private readiness
record prevent adoption of incomplete, aliased, foreign or permissive caches.
Concurrent creators adopt one complete result. Bun's absolute internal version
aliases are canonically resolved and relocated into the new cache; escaping,
dangling and cyclic aliases refuse. Executable
file modes are preserved without chmod of shared inodes. `project-control-broker-transport.ts`
passes the prepared directory through `BUN_INSTALL_CACHE_DIR` while preserving
the other supplied environment values.

Sixteen focused tests passed, including actual cross-filesystem refusal,
concurrent publication, valid adoption, untrusted-path refusals, source
retirement and the production transport's child environment. Four semantic
mutations failed as expected and were restored: removing environment delivery,
replacing hardlink with copy, rejecting every valid cache, and disabling the
private-directory mode check. The restored suite passed. Independent review
caught a lexical-containment gap involving a symlink followed by `..`; three
new traversal/dangling/cyclic regressions failed before the canonical-resolution
fix and passed after it. Re-review found no remaining merge blockers.

The consuming smoke launched the real native app-server against a localhost
fake provider and a disposable credential-free home. Two direct native shell
commands each ran `bun install --frozen-lockfile --ignore-scripts`, rendered a
React element through ReactDOM, accepted valid TypeScript and rejected an invalid
assignment with TS2322. Both installs and their cache had identical device/inode
identity. Removing only the generated fixture cache left both installed runtime
and compiler checks passing. This was a four-package fixture, not a full suite
or a live owner.

The full repository installation was then exercised in the normal native
sandbox using the prepared scratch cache. Host-side seeding took 3.075 seconds;
`bun install --frozen-lockfile --ignore-scripts` installed 2,503 packages in
923 ms. The workspace dependency verifier passed. A census of all 65,993 regular
files under the resulting dependency tree found every device/inode in the
prepared cache: zero unshared files and zero copied dependency bytes. Available
space was 10.60 GB before seeding, 10.55 GB after seeding, and 10.49 GB after
installation. Other host activity makes these free-space observations unsuitable
as an exact attribution of allocation, but the inode census directly establishes
sharing. The worktree retained its own workspace links and dependency tree.

Standard root, runtime and Trident TypeScript checks passed against that local
installation. Twenty-two focused cache/bootstrap/placement tests passed on the
host, including the real Unix-listener case that the sandbox correctly refused.
The generated spec index checks passed. The authored-diff leak scan was clean;
the whole local tree scan reported existing denylist matches and the untracked
worktree gitdir pointer, so it is not reported as a whole-tree pass. A temporary
attempt to resolve full TypeScript checks through another checkout's dependencies
failed on package-resolution artifacts and is not counted as validation.
The full consuming native end-to-end file passed at revision
`84bf812235a3ff0f6d03fcc66f6f3c53025926db`: 331 tests, zero failures and
3,986 assertions in 475.23 seconds. This receipt is distinct from the full
repository shared-host suite, which was pending alongside remote CI and
publication at that point; the local full-suite gate was not waived. Integration of current
main preserved all four authored native cache implementation/test files byte
for byte. Post-integration focused cache and generated-index checks passed
54 tests with 424 assertions.

On 2026-09-26, `bash scripts/check-shared-host.sh` completed with exit zero at
revision `27bd615237917899c5f07908c9f67e37e0b1e516`, tree
`ec993a82144e2b8be58f9def073015b0435ec188`, with a clean worktree and its own
verified dependency installation. All 51 TypeScript configurations passed.
The coverage audit executed all 1,697 discovered files across 18 lanes with
zero failed lanes; lane summaries total 25,865 passing tests, 23 skips,
zero failures and 117,597 assertions. The retained log's SHA-256 is
`3b7c907e245b3e43a3461f99fcdf7fe4a52e1710d644c62e870b4045390be5ca`.
This is local full-suite evidence for that measured identity. The later
receipt-only commit changes this record, not the tested source or dependency
inputs; remote CI and publication still require their own exact-head evidence.

Exact-head CI subsequently refused the smoke's bare console diagnostic. The
fixture now emits its success through the approved logger. During revalidation,
one native command's aggregate output omitted the peer-test summary even though
the command exited zero. The fixture now records environment, peer-test output
and invalid-TypeScript output separately inside each generated worktree, and
checks both commands' actual receipts alongside their exit status. This avoids
depending on retained tool-output text without removing any consuming control.
The revised real native smoke passed with matching cache/install inodes, runtime
peers, compiler siblings and usable dependencies after isolated cache removal.
Focused cache checks passed 16 tests with 34 assertions; root and Trident
TypeScript checks and the full local CI lint script passed. The prior full-suite
receipt remains evidence for revision `27bd615237917899c5f07908c9f67e37e0b1e516`;
this fixture source change requires fresh canonical validation and remote CI.

Coverage is deliberately bounded: new Linux native app-server launches and
ordinary installs into scratch on the same writable mount. Explicit
cache/backend/environment configuration and separately mounted workspaces can
bypass it. Warm native owners retain their launch environment; an Open restart
that adopts a surviving helper does not apply this change to that helper.
A removed cache does not invalidate existing installed hardlinks, but a warm
installer that recreates the directory without the readiness record requires
reconciliation before later host adoption. No free-space reservation,
workflow-lifetime ownership, cleanup policy, deployment or live rollout is
claimed by this change.
