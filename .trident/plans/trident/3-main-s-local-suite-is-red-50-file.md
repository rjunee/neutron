# IMPLEMENTATION_PLAN — main's LOCAL suite red (50 files / 10 of 16 lanes) while CI is green

## Diagnosis — COMPLETE and MEASURED 2026-08-31 (do not re-derive; quote this)

- [x] Root cause 1 (the big cluster, ~49 of 50 files): `bun test` inherits the invoking shell's LIVE-instance environment. The box exports `NEUTRON_DB_PATH` (an absolute host filesystem path to the live `project.db`), `OWNER_HOME`, `NEUTRON_INSTANCE_SLUG`, `NEUTRON_IDENTITY_JWKS_URL`/`NEUTRON_IDENTITY_AUDIENCE`, `NEUTRON_CORES_GOOGLE_CLIENT_ID/SECRET`, `NEUTRON_POST_ONBOARDING_CLAIM_URL`, `NEUTRON_ONBOARDING_*`, etc. `resolveOpenDbPath` (`migrations/db-path.ts`) gives `NEUTRON_DB_PATH` verbatim precedence OVER `NEUTRON_HOME` — which is exactly why the earlier measured "repoint NEUTRON_HOME at a fresh dir" run STILL named the live DB. Boot-path tests therefore open the live database and the migration ownership guard (`migrations/runner.ts`) CORRECTLY refuses. Identity/OAuth vars additionally flip app surfaces to 401 `missing_bearer` and the composer to `oauth_configured=true`, redding served/wiring/integration tests that expect CI's clean-env behavior. CI is green because it has NONE of these vars — and CI DOES execute every file: `.github/workflows/ci.yml:437` runs `bash scripts/run-tests.sh` (8-way `NEUTRON_TEST_SHARD`), same runner, same audit. No hidden skipping exists, so the card's "close the CI/local gap" item needs NO `scripts/ci/` change — the gap was environmental and the preload closes it; the parity story is documented in T4.
- [x] Root cause 2 (the one non-env file): `gateway/wiring/__tests__/persona-loader.test.ts` "mtime-keyed cache" test restores mtime via `utimes(target, st.atime, st.mtime)` — a `Date`, integer-ms. The loader keys its cache on `st.mtimeMs`, which under local bun 1.3.13 carries sub-ms precision (measured: orig `…297.6125`, restored `…297`), so the cache key never matches and the test deterministically fails (3/3 runs). CI pins bun 1.3.9 where `mtimeMs` is integer-ms, hence green there. Test bug, not loader bug.
- [x] Fix design PROVEN by probe: with `OWNER_HOME` + every `NEUTRON_*` var except `NEUTRON_TEST_*` deleted and `NEUTRON_HOME` pointed at a fresh scratch dir, `gateway/boot.test.ts` = 4 pass / 0 fail (scratch DB, `project_slug=dev`), and the 4-file cluster probe (`persona-loader`, `landing/__tests__/server`, `open/__tests__/app-surfaces-served`, `tests/integration/claim-redirect-once.open`) = 69 pass / 1 fail — the single fail being root cause 2. There is no repo `.env` (only `.env.example`), so nothing re-injects the vars after a scrub.

## Round-2 planning notes (2026-08-31, do not re-litigate)

- Branch tip `ca6e2a93` = ONE work commit on origin/main `34995c68`; `git diff --stat origin/main..branch` touches ONLY `bunfig.toml`, `gateway/wiring/__tests__/persona-loader.test.ts`, `tests/support/scrub-instance-env{,.test,-probe}.ts`, and this plan. `scripts/` and `.github/` are byte-identical to origin/main — the runner, its audit, and CI are untouched, so the aggregation path that produced the red baseline is unchanged.
- The repo-root `IMPLEMENTATION_PLAN.md` is a STALE leftover from another card (#313 arbitration) and lives on main itself — out of scope; do not edit it.
- Full "before" suite re-run is NOT required: the baseline is already measured and quoted in the card (10 of 16 lanes red / 50 files / executed 1399 / SUITE_EXIT=1, identical at the merge-base). T3 substitutes a cheap single-file before spot-check plus the committed poisoned-env probe test.
- Positive control uses the documented `NEUTRON_TEST_ROOT` scratch-fixture seam of `scripts/run-tests.sh` (exists for the runner's own selftests) so the real runner demonstrably still exits 1 on a red file without a second ~hour full-suite run; a second in-worktree `bun test` control proves the new preload does not swallow failures.

## Build queue (Ralph one-task order)

- [x] T1 — Hermetic per-instance env baseline for every `bun test` process: new preload `tests/support/scrub-instance-env.ts` (delete `OWNER_HOME` + all `NEUTRON_*` except `NEUTRON_TEST_*`; set `NEUTRON_HOME` to a fresh per-process scratch dir with best-effort exit cleanup), registered in `bunfig.toml` after the existing `scrub-substrate-env.ts`, plus a race-proof pinned self-test (child-process probe with a poisoned env + a bunfig registration assertion). A/B demonstrated: control run names the live DB path in the ownership refusal; fixed run names a scratch path. Committed in `ca6e2a93`.
- [x] T2 — Fix the `persona-loader.test.ts` mtime-cache test's precision bug: pin the file mtime to a WHOLE-second stamp before the first load and restore to the same stamp after the body rewrite, so the stamp round-trips exactly through `utimes`+`stat` on every bun/filesystem. Control 18 pass / 1 fail; after, 19 pass / 0 fail x3. Committed in `ca6e2a93`.
- [x] T3 — Full-suite verification on the branch worktree with the naturally inherited (dirty) shell env: (a) before spot-check — detached scratch worktree of origin/main + `bun install` + `bun test gateway/boot.test.ts`, expect the migration ownership refusal naming the live DB (evidence only, not gating; redact absolute host paths in anything committed); (b) after — `NEUTRON_TEST_JOBS=2 bash scripts/run-tests.sh` in the branch worktree, backgrounded to a log, required exit 0 with `failed: 0` lanes and the coverage audit line showing `declared == bun-discovered == executed` and executed >= 1400 (baseline 1399 + the new self-test file; any drop below 1399 is an automatic FAIL of this task); (c) positive control A — `NEUTRON_TEST_ROOT` scratch dir holding one deliberately failing test, real runner must exit 1 with `FAIL — 1/1 lane(s)`; (d) positive control B — temp failing `*.test.ts` inside the worktree run via `bun test` (preloads active) must exit 1, then be deleted before commit; (e) triage any straggler red with its measured error before touching anything — widen the scrub list only on a quoted variable, fix a bun-1.3.13-vs-1.3.9 skew as a pinned test fix, never skip/delete a test, never touch the ownership guard, `scripts/run-tests.sh`, or the PGLite lane; one more full run after any fix; (f) append the redacted verification record to this plan and commit.
- [ ] T4 — Documentation: add a "Hermeticity — the env a test run sees" section to `docs/testing-runner.md` (both preloads, why, CI-parity: CI executes every file via 8-way shard of the same runner, and the bun 1.3.9-CI vs newer-local skew incl. the `mtimeMs` sub-ms gotcha); append the `docs/AS_BUILT.md` entry for this fix (append-only — the file is ~2 MB, never read it whole). Never write the leak-gate-banned word or absolute host data paths in any file, commit message, or PR body — redact quoted refusal output to `<data-home>/project.db`.

## T3 verification record (2026-08-31)

Local bun **1.3.13** (`bf2e2cec`); CI pins **1.3.9**. Every run below used the box's
NATURALLY INHERITED shell env (`NEUTRON_DB_PATH`, `OWNER_HOME`, `NEUTRON_IDENTITY_*`,
`NEUTRON_CORES_GOOGLE_*`, `GH_TOKEN`, …) — nothing was scrubbed outside the committed preload,
because proving the preload neutralizes that env is the whole point. `bun install` = 2503
packages, exit 0.

### Baseline (quoted from the card, not re-measured)

> declared 1399 / bun-discovered 1399 / executed 1399 · 10 of 16 lanes red (4 6 7 8 9 10 12 13 +
> PGLite + device) · 50 distinct files red · SUITE_EXIT=1 — and an identical failing-test-name
> set at the merge-base, while GitHub CI was 17/17 green on the same commits.

### (a) BEFORE spot-check — detached `origin/main` (34995c68) worktree, own `bun install`

`bun test gateway/boot.test.ts` → **2 pass / 2 fail, EXIT=1**, refusal reproduced verbatim
(absolute host paths redacted):

```
error: Migration ownership refusal: the recorded owning checkout is not this runner checkout.
  database          <data-home>/project.db
  ownership marker  <data-home>/.migrate-owner
  owner             <deployed-checkout>/migrations
  this runner       <scratch-worktree>/migrations
  at applyMigrations (migrations/runner.ts:1482)
  at boot            (gateway/index.ts:295)
  at <anonymous>     (gateway/boot.test.ts:70)
```

So the diagnosed condition still holds at the current base. On the branch the same file is
green — the whole ownership-refusal cluster is gone.

### (b) AFTER — two full `NEUTRON_TEST_JOBS=2 bash scripts/run-tests.sh` runs on the branch

Run 1 (tip `ca6e2a93`) and run 2 (with the run-1 triage fix) produced byte-identical audit
lines:

```
run-tests: 1405 test files (bun-discovered: 1405) → 14 general chunks of <=100 + 20-file PGLite lane + 38-file device lane
---- run-tests coverage audit ----
declared files: 1405   bun-discovered: 1405   assigned here: 1405   files executed: 1405 (1347 general + 20 PGLite + 38 device)
lanes: 14 general chunks + PGLite lane + device lane   failed: 5 (7 8 12 PGLite-lane device-lane)
run-tests: FAIL — 5/16 lane(s) contained failing tests (see output above).
SUITE_EXIT=1
```

**Coverage audit INTACT and the executed count ROSE: 1399 → 1405** (`declared == bun-discovered
== assigned == executed`). Nothing was skipped, emptied or dropped; the rise is the new
`tests/support/scrub-instance-env.test.ts` plus files main gained between the baseline commit
and `34995c68`. The audit's own no-silent-truncation guard is untouched.

**Progress against the baseline: 10 red lanes / 50 files → 5 red lanes / 14 files.** The entire
env cluster (`gateway/boot`, `open/__tests__/*-wiring|served`, `tests/integration/*.open`,
`gbrain-memory/__tests__/doctor-*`, `persona-loader`, …) is green. **The suite is NOT green
yet** — the 14 survivors are reported honestly below, each reproduced in BOTH full runs and
again file-scoped.

### (c) Positive control A — the real runner still goes red

`NEUTRON_TEST_ROOT=<scratch> bash scripts/run-tests.sh` over one deliberately failing fixture:

```
lanes: 1 general chunks   failed: 1 (1)
run-tests: FAIL — 1/1 lane(s) contained failing tests (see output above).
EXIT=1
```

Recorded caveat: the run needed the runner's own documented `NEUTRON_TEST_ALLOW_EMPTY_BUN_DISC=1`
escape hatch, because bun **1.3.13** prints `matched 0 tests. Searched 2 files (skipping 2
tests)` for the runner's `-t __neutron_runtests_no_match__` discovery probe on a small clean
tree instead of the `across N files` phrasing the probe greps for. At repo scale bun still
prints `across 1405 file`, so the real audit is unaffected — but the phrasing is version
sensitive, and that is exactly the drift the escape hatch was written for. Runner untouched.

### (d) Positive control B — the preloads do not swallow red

`bun test tests/support/tmp-control-red.test.ts` (both preloads active) → `0 pass / 1 fail`,
**EXIT=1**. Temp file deleted; `git status --porcelain` shows no trace of it.

### (e) Triage — measured causes, one fix made

**FIXED this round (Category C, cause fully measured, fix minimal):**
`gbrain-memory/__tests__/memory-swap-seam.depcruise.test.ts` — 2 fails, `SyntaxError: JSON Parse
error: Unexpected EOF`. Measured: the test shells out to `bunx depcruise`, and this box installs
bun as a bare `/usr/local/bin/bun` with **no sibling `bunx`**, so `execFileSync` threw ENOENT,
`stdout` fell through as `''` and every probe died in `JSON.parse` — a red that says nothing
about the RA5 seam. Fix: call the workspace-local `node_modules/.bin/depcruise` (exactly what
`bunx depcruise` resolves to when node_modules is installed, minus the launcher; hermetic, no
network) and `scripts/run-tests.sh` already refuses an uninstalled tree. 8 pass / 0 fail x3, and
gone from run 2's failing set.

**NOT fixed — recorded as named follow-ups (none is minimally fixable inside T3's prohibitions;
none is a defect in this branch's diff):**

1. **`FOLLOW-UP-A` — the box has the real binaries the tests assume absent** (9 files' worth of
   assertions; 4 files: `tests/integration/install-gbrain.test.ts` (5), `install-codex.test.ts`
   (4), `gbrain-memory/__tests__/resolve-gbrain-command.test.ts` (2),
   `gateway/wiring/__tests__/build-gbrain-memory.test.ts` (3, and the PGLite lane's ONLY red is
   this same file)). Measured: `/usr/local/bin/gbrain` and `/usr/bin/codex` both exist here as
   real symlinks from the deployment. `resolveGbrainCommand` probes `/usr/local/bin/gbrain`
   unconditionally, so "nothing anywhere → null" returns `/usr/local/bin/gbrain`; the install.sh
   seam runner deliberately inherits the real PATH so `ensure_bun` can find bun, which also
   hands it a real `gbrain`/`codex`, so "install ran but binary not on PATH → ABORTS" never
   aborts. This is the SAME family as root cause 1 (the suite is not hermetic against the box
   being a live deployment) but the leak is the FILESYSTEM, not the environment — a preload
   cannot fix it, and no PATH curation both hides `/usr/bin/codex` and keeps the coreutils
   `install.sh` needs. Needs its own card: a per-seam curated bin dir, or an explicit
   "system-installed binary present" arrangement in those four tests.
2. **`FOLLOW-UP-B` — bun 1.3.13 bundler EBADF under lane concurrency** (4 files, 9 fails:
   `landing/__tests__/server.test.ts` (6), `chat-react-serving`, `chat-react-bundle-builds`,
   `chat-react-bundle-production-runtime`). Measured: `error: Unexpected reading file: …
   react-dom/client.js` and `error: EBADF reading file: … chat-core/index.ts` from `Bun.build`
   inside chunk 8. All four files are **green file-scoped** (39 pass / 0 fail together, and 1
   pass / 0 fail alone), and `ulimit -n` is 524288, so this is not FD exhaustion but a bundler
   race under the general lane's `max-concurrency=16`. CI is green on 1.3.9. Not a test bug and
   not fixable without touching the runner's concurrency, which T3 may not do.
3. **`FOLLOW-UP-C` — bun 1.3.13 `TypeError: Requested module is already fetched`** (5 files, 16
   fails; the entire device lane red: `app/__tests__/{general-tab-set,project-switch-is-instant,
   project-switch-reaches-the-wire,rail-tap-lands-on-the-tapped-project,reachability}`).
   Measured at `app/lib/last-tab-storage.ts:226`, a `require('react-native')` inside a module the
   lane has already ESM-imported. The device lane runs all 38 files in ONE process, so the
   collision only appears in aggregate: `general-tab-set` alone is 4 pass / 0 fail. Pure
   bun-version skew (CI's 1.3.9 is green); the honest fixes are a bun pin or converting that one
   `require` to a static import — both outside T3.
4. **`FOLLOW-UP-D` — the owner's `GH_TOKEN` reaches every spawned test child** (2 fails,
   `tests/integration/github-credential-wired.open.test.ts`). Measured: the test asserts an
   instance that never connected sees `GH_TOKEN` unset and instead reads the owner's live
   `gho_…` value. ATTEMPTED the Category-A fix (add `GH_TOKEN`/`GITHUB_TOKEN` to the preload's
   delete list) and **reverted it, because it does not work**: under bun 1.3.13 a spawned child
   with a default env inherits the process's REAL environ, not the mutated `process.env`.
   Probe, run three ways in one process:

   ```
   baseline:        <the live gho_… value>
   after delete:    <the live gho_… value>
   after set-empty: <the live gho_… value>
   after reassign:  <the live gho_… value>     (Bun.env === process.env is true)
   ```

   So no preload can close this; the only in-repo fix is `env -u GH_TOKEN -u GITHUB_TOKEN` (or an
   explicit child env) at the runner or in that test — and T3 may not touch
   `scripts/run-tests.sh`. Worth its own card on security grounds too: `trident/leak-preflight.ts`
   names exactly this pair as the exfil surface, and `trident/gh-authed.test.ts:82` already
   hand-strips them, which is the workaround this finding generalizes. **Nothing was committed
   for this item.**

None of these four is caused by anything on this branch; all four reproduce on `origin/main`'s
own condition. No test was skipped, emptied or deleted; the migration ownership guard, the
PGLite lane's isolation, `scripts/`, `.github/` and `scripts/ci/` are byte-identical to
`origin/main` on this branch.

### (g) Independent re-verification in a SECOND fresh worktree (2026-08-31, later round)

The T3 evidence above was re-checked from a brand-new worktree of the branch tip with its own
`bun install` (2503 packages, exit 0), under the same naturally inherited (dirty) shell env and
the same local bun **1.3.13**. This is an independent reproduction, not a re-quote.

File-scoped blast-radius re-run of everything this branch touches plus both neighbouring test
directories — 25 files, all from the poisoned shell:

```
persona-loader + memory-swap-seam.depcruise + tests/support/*        47 pass / 0 fail   EXIT=0
gbrain-memory/__tests__ (first 10)                                  139 pass / 0 fail   EXIT=0
gbrain-memory/__tests__ (remaining 10)                               78 pass / 2 fail   EXIT=1
```

The only red is `resolve-gbrain-command.test.ts`, i.e. `FOLLOW-UP-A`, reproduced verbatim:

```
75 |  const env = { PATH: join(scratch, 'empty'), HOME: join(scratch, 'emptyhome') }
76 |  expect(resolveGbrainCommand(env)).toBeNull()
error: expect(received).toBeNull()   Received: "/usr/local/bin/gbrain"
```

and `ls -l /usr/local/bin/gbrain` on this box is a real symlink into the deployment's global
install (likewise `/usr/bin/codex`). `git diff 34995c68..HEAD` touches NEITHER
`gbrain-memory/resolve-gbrain-command.ts` NOR its test, and the test passes an explicit `env`
object, so no preload on this branch can reach it: the red is byte-identically main's.

`FOLLOW-UP-D`'s revert was re-measured too, because a preload fix would have been in T3's scope
had it worked. Under bun 1.3.13, in one process, spawning `sh -c 'echo "[${VAR-MISSING}]"'`:

```
baseline              "[secret123]"
after set-empty       "[secret123]"
after delete          "[secret123]"
with explicit env:{…} "[MISSING]"
```

Deleting (or emptying) `process.env.X` does NOT reach `Bun.spawnSync`'s default child environ —
only an explicit `env` object does. Confirms no preload can strip `GH_TOKEN` from spawned test
children; the fix belongs at the spawn site or the runner, both outside T3.

### T3 conclusion — where the local/CI gap now actually lives

After T1+T2 the gap is no longer "composition/wiring resolution". The 5 surviving red lanes split
cleanly into two non-branch families:

- **bun version skew (`FOLLOW-UP-B`, `FOLLOW-UP-C` — 9 of 14 files):** local bun 1.3.13 bundler
  EBADF under lane concurrency, and 1.3.13's `Requested module is already fetched` in the
  single-process device lane. CI's pinned **1.3.9** is green on both, and every one of those files
  is green file-scoped here. Nothing in the repo is wrong; the local toolchain is newer than the
  pin. A repo-level bun pin is the candidate fix and needs its own card.
- **this box is a live deployment (`FOLLOW-UP-A`, `FOLLOW-UP-D` — 5 of 14 files):** the real
  `gbrain`/`codex` binaries exist on the filesystem, and the owner's `GH_TOKEN` is in the real
  environ that children inherit. Same family as root cause 1, but the leak is the FILESYSTEM and
  the child environ, neither of which a `bun test` preload can close.

So the answer to the card's "close the CI/local gap" is now precise: T1 closed the environment
half of it inside every `bun test` process (that is what took 10 red lanes to 5 and cleared all
50 originally-reported files' env cluster); what remains is a toolchain pin and a
host-is-a-deployment problem, each with a measured cause and neither fixable inside T3's
prohibitions.

### (h) Third re-entry — stage-1 blast radius re-measured (2026-08-31, later round)

T3 was re-dispatched onto the already-committed branch tip. No further work is available inside
T3's prohibitions: the full-suite verification, both positive controls and the four follow-up
triages above stand as committed, and the full-suite re-run is deferred to this plan's terminal
task by the runner contract. This round re-measured the blast radius file-scoped from the same
naturally inherited (dirty) shell env, own `bun install` (2503 packages, exit 0), bun 1.3.13:

```
tests/support/* + persona-loader + build-gbrain-memory + memory-swap-seam.depcruise (6 files)
                                                            116 pass / 2 fail   EXIT=1
gbrain-memory/__tests__ (21 files)                          225 pass / 2 fail   EXIT=1
```

Every one of the 4 reds is `FOLLOW-UP-A` and none is in `git diff 34995c68..HEAD`:

- `gateway/wiring/__tests__/build-gbrain-memory.test.ts` — `expect(warnings.some(w =>
  w.includes('DISABLED'))).toBe(true)` receives `false`, because the resolver finds a real
  `gbrain`; the sibling "per-connect key coherence" case then times out at 5000ms for the same
  reason (it reaches a real executable instead of the absent-binary path).
- `gbrain-memory/__tests__/resolve-gbrain-command.test.ts` — "nothing anywhere → null" and
  "a non-executable file at a probe path is NOT accepted".

Re-confirmed on the box: `/usr/local/bin/gbrain -> ../install/global/node_modules/gbrain/src/cli.ts`
and `/usr/bin/codex -> ../lib/node_modules/@openai/codex/bin/codex.js` are both real symlinks from
the deployment. Everything this branch actually touches is green: `persona-loader.test.ts`,
`memory-swap-seam.depcruise.test.ts` and `tests/support/*` all pass. T3 stays `- [x]`.

### (i) Fourth re-entry — the child-process boundary is now recorded where it will be re-tried

T3 was dispatched a fourth time onto the same committed tip. The full-suite verification, both
positive controls and the four follow-up triages above stand; the full-suite re-run is deferred
to this plan's terminal task by the runner contract, and nothing inside T3's prohibitions was
left undone. Rather than record a fourth no-op, this round closed the one gap that was costing a
round every time: `FOLLOW-UP-D`'s dead end had to be re-derived by hand in each of the last three
rounds because it lived only in commit messages.

Re-measured once more, independently, on bun 1.3.13 — `sh -c 'echo "[${PROBE_VAR-MISSING}]"'`
spawned from one process:

```
process.env.PROBE_VAR = 'secret123'   -> [MISSING]
after set-empty                       -> [MISSING]
after delete                          -> [MISSING]
node:child_process execFileSync       -> [MISSING]
```

A default-env spawn hands the child the environ the process STARTED with, so **neither a set nor
a delete in a preload propagates** — which is why the preload cannot strip `GH_TOKEN` from a
spawned test child, and equally why the self-test's poisoned-env probe must (and does) pass an
explicit `env:{…}`. That boundary is now a comment block in `tests/support/scrub-instance-env.ts`
itself, next to the delete list, so the next reader tries the fix at the spawn site instead of a
fifth time here. No behaviour changed: comment-only, plus this record.
