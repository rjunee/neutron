## 2026-09-15 — Additive production host foundation (partial)

### Scope and completion boundary

This is a partial delivery for HOSTFX, using the task brief's explicit permission
for a complete, tested subset. It is not ready for launcher cutover. The task also
explicitly requires this shard location and additive delivery; those instructions
override the general shard-location and immediate-replacement rules for this lane.

The production factory supplies measurement, preparation, publication and PR merge
adapters at `trident/production-host-effects.ts:203`. The project factory assembles
those effects and existing gates at `trident/project-build-host.ts:59`. Its inputs
are an initialized durable run, resolved project substrate bindings, role requests,
and policy-specific sources (`trident/project-build-host.ts:26`).

Outstanding work before cutover:

- Atomic local merge: the effect explicitly returns `unknown` at
  `trident/production-host-effects.ts:172`.
- Remote **base** enforcement remains non-atomic. HOSTFX2 now explicitly records
  this limitation before every PR merge attempt
  (`trident/production-host-effects.ts:175`), and refuses if the risk evidence
  cannot be persisted (`trident/production-host-effects.ts:189`). The installed
  CLI exposes a head precondition only; this delivery does not establish whether
  a different platform API could enforce the base. See the evidence and bounded
  validation in `host-effects-2.md`. No atomic-base guarantee is claimed.
- Resume/Ralph mode persistence and reconciliation of pending workers. The driver
  requires its mode host for these calls (`trident/build-run.ts:168`); this
  composition supplies the four effects listed at
  `trident/production-host-effects.ts:203` and does not add that mode host.
- Full lifecycle persistence, checkpoint transitions, and terminal-result harvest
  integration. This subset writes PR identity (`trident/production-host-effects.ts:161`)
  and preparation stage evidence (`trident/production-host-effects.ts:216`). Those
  writes are not a terminal-result protocol.
- Caller-side initialization and resolving actual project adapter bindings remain
  composition responsibilities. The factory requires matching initialized row
  identity and a launch base (`trident/project-build-host.ts:40`), and selects from
  supplied project bindings (`trident/project-build-host.ts:16`).

The existing launcher cutover, driver changes, and old-path deletion were
intentionally deferred as requested. No product target or spec decision is changed
by this partial implementation.

### What changed and why

- Every measurement reloads run identity and refuses terminal rows
  (`trident/production-host-effects.ts:39`). It resolves the branch, checks the
  worktree head, reads a pinned three-dot diff from git's output file, observes PR
  identity, then rereads branch and persisted pins
  (`trident/production-host-effects.ts:86`). File-backed diff reads preserve full
  content and trailing newlines (`trident/production-host-effects.ts:74`);
  `spawnCapture` trims stdout (`trident/git-mode.ts:1223`), so stdout is not the
  diff transport.
- PR publication remeasures the snapshot, runs the kept readiness gate, observes
  an explicit remote lease, pushes the reviewed OID, witnesses that OID remotely,
  creates or observes the PR, then persists the witnessed number
  (`trident/production-host-effects.ts:136`). Unknown command outcomes do not
  become successful writes.
- CI observation reads a project-specified workflow at the measured commit
  (`trident/production-host-effects.ts:101`). Only `success` maps to success;
  skipped and neutral conclusions are conservative failures
  (`trident/production-host-effects.ts:114`).
- Admission reads prior ownership pins from the real store
  (`trident/production-host-effects.ts:118`). Preparation verifies request identity,
  brief integrity, its context reference, and the current snapshot before writing
  the context and recording a stage (`trident/production-host-effects.ts:205`).
- Project runner selection uses `placementFor` against the project's REPL provider
  (`trident/project-build-host.ts:19`). It selects the live in-REPL binding for the
  same provider and the named headless binding for another provider. It retains
  only a runner whose declared provider matches the map key
  (`trident/project-build-host.ts:21`). The existing host names missing providers
  at admission (`trident/build-host.ts:39`).
- Each role receives a new immutable brief containing the host-context reference
  (`trident/project-build-host.ts:47`). Existing destinations are refused by `wx`;
  the source brief is not edited. Policy and effect command runners, base, branch,
  and run identity are assembled from the same production configuration
  (`trident/project-build-host.ts:62`).

### Outcome vocabulary and maintained properties

The effects reuse `Measurement`, `GateResult`, and `CiRunObservation`, rather than
adding a new verdict family. The driver turns `blocked` and `unknown` into stopping
outcomes (`trident/build-run.ts:149`). Because effect callbacks return `void`, their
adapter throws on a non-allow result (`trident/production-host-effects.ts:199`);
the driver's catch preserves that as `unknown`, including uncertainty after an
external write (`trident/build-run.ts:397`). This deliberately loses the
blocked/unknown distinction at the void seam instead of falsely reporting success.

CI's existing classifier maps unreadable to `cannot-read`, absent to `no-run`, a
wrong OID to `wrong-head`, and non-success completion to `red`
(`trident/ci-readiness.ts:22`). The existing host permits only `green`
(`trident/build-host.ts:125`). The new preparation stage is ordinary durable event
metadata through `TridentRunStore.recordStageEvent` (`trident/store.ts:1042`), not a
checkpoint or liveness claim; the heartbeat query selects its two named heartbeat
stages explicitly (`trident/store.ts:1087`). Terminal refusal uses the existing
phase taxonomy (`trident/state-machine.ts:48`).

Host remeasurement and the remote push lease maintain the implemented revision
checks independently of worker cooperation. The driver remeasures after a worker
and corroborates its trailer (`trident/build-run.ts:252`). The local and remote
base limitations above are explicit; no continuous atomic-base guarantee is
claimed by this subset.

### Foundation validation (historical)

The validation and mutation line numbers below describe the foundation commit.
HOSTFX2 validation and current evidence are in `host-effects-2.md`.

- `bun test trident/build-host.test.ts trident/gates/ trident/production-host-effects.test.ts trident/project-build-host.test.ts`: **102 pass, 0 fail**, nine files, 470 assertions, after restoring every mutation.
- `bunx tsc --noEmit`: **PASS**.
- `bunx tsc --noEmit -p trident/tsconfig.json`: **PASS**.
- `bash scripts/ci/lint.sh`: **PASS**, including all repository lint guards.
- `bash scripts/ci/leak-gate.sh --tree .`: **INCOMPLETE (exit 3)**. Zero findings in the rules that ran; `pii-denylist` and `pii-denylist-msg` could not run. This is not a clean leak-gate verdict.
- `git diff --cached --check`: **PASS**. Staged scope enumerated with `git diff --cached --name-status`: exactly the two new source files, their two test files, and this shard, all additions.

The test files were enumerated by that explicit command; no whole-suite sweep ran.
All 44 counted mutants individually passed the Trident typecheck before testing.
The final restored run above includes every named mutation test.

Scope search controls: `rg -n 'modes|effects' trident/project-build-host.ts`
finds the effects import at line 6 and binding at line 66, with no mode binding.
`rg -n -- 'match-head-commit|match-base-commit|inner_result|recordStageEvent' trident/production-host-effects.ts`
finds the head option at line 176 and stage write at line 200, with no base option
or terminal-result writer. These are content searches of the added source files,
not claims about a fetched remote tree.

### Mutation evidence

44 targeted mutations were enumerated explicitly below. Every counted mutation
passed `bunx tsc --noEmit -p trident/tsconfig.json` and produced a runtime test
failure. The mutated line was printed before each run. Each source was restored
after its case; GREEN refers to the final restored bounded run listed above.

For typed observations, permissive mutations return `known` or completed CI
success; for `void` preparation they return normally. Gate-result mutations
return `allow`. These are executable wrong answers, not syntax errors.

The first attempt to remove the project launch-pin guard did not typecheck
because it also removed null narrowing at `trident/project-build-host.ts:63`.
It is excluded. The counted replacement fabricates a full launch pin and compiles.
The missing-base fixture restores a valid source brief first
(`trident/project-build-host.test.ts:87`), so another refusal cannot mask the
construction guard. No assertion was loosened.

| Guard and location | Mutated line | Named test that failed | Restored result |
| --- | --- | --- | --- |
| row identity — `trident/production-host-effects.ts:42` | ``\|\| current.worktree !== worktree) {`` | measurement refuses moved head and changed durable identity | RED → GREEN |
| terminal row — `trident/production-host-effects.ts:45` | ``if (isTerminalPhase(current.phase)) return current`` | terminal run cannot be measured or dispatch a new turn | RED → GREEN |
| head observation — `trident/production-host-effects.ts:50` | ``if (!result.ok \|\| result.timed_out \|\| !oid.test(result.stdout.trim())) return result.stdout.trim()`` | measurement rejects failed commands even when they contain usable output | RED → GREEN |
| Local run unexpectedly has a persisted PR — `trident/production-host-effects.ts:55` | ``if (current.pr !== null) return null`` | measurement refuses changing store pins, ambiguous PRs, and a local persisted PR | RED → GREEN |
| PR observation is unreadable — `trident/production-host-effects.ts:62` | ``if (!result.ok \|\| result.timed_out) return null`` | measurement refuses unreadable list | RED → GREEN |
| PR observation is ambiguous or malformed — `trident/production-host-effects.ts:65` | ``if (!Array.isArray(candidates) \|\| candidates.length > 1) return null`` | measurement refuses changing store pins, ambiguous PRs, and a local persisted PR | RED → GREEN |
| PR identity or revision is malformed or mismatched — `trident/production-host-effects.ts:71` | ``\|\| (current.pr !== null && current.pr !== pr.number)) return null`` | measurement refuses malformed PR, different checkout, and timeout with output | RED → GREEN |
| diff observation — `trident/production-host-effects.ts:82` | ``if (!result.ok \|\| result.timed_out) return await readFile(output, 'utf8')`` | measurement rejects failed commands even when they contain usable output | RED → GREEN |
| Pinned launch base is missing — `trident/production-host-effects.ts:89` | ``if (!current.base_sha \|\| !oid.test(current.base_sha)) return { kind: 'known', value: { head: 'a'.repeat(40), diff: '', pr: null } }`` | measurement reads complete committed diff and re-reads persisted pins | RED → GREEN |
| Worktree head does not match the build branch — `trident/production-host-effects.ts:92` | ``if (!checkedOut.ok \|\| checkedOut.timed_out \|\| checkedOut.stdout.trim() !== tip) return { kind: 'known', value: { head: 'a'.repeat(40), diff: '', pr: null } }`` | measurement refuses malformed PR, different checkout, and timeout with output | RED → GREEN |
| Build branch moved during measurement — `trident/production-host-effects.ts:95` | ``if (await head() !== tip) return { kind: 'known', value: { head: 'a'.repeat(40), diff: '', pr: null } }`` | measurement refuses moved head and changed durable identity | RED → GREEN |
| Persisted pins changed during measurement — `trident/production-host-effects.ts:97` | ``if (after.base_sha !== current.base_sha \|\| after.pr !== current.pr \|\| after.merge_mode !== current.merge_mode) return { kind: 'known', value: { head: 'a'.repeat(40), diff: '', pr: null } }`` | measurement refuses changing store pins, ambiguous PRs, and a local persisted PR | RED → GREEN |
| CI workflow or full head is missing — `trident/production-host-effects.ts:104` | ``if (!options.ciWorkflow \|\| !oid.test(snapshot.head)) return { kind: 'completed', headSha: snapshot.head, conclusion: 'success' }`` | CI refuses absent workflow even with a successful response | RED → GREEN |
| CI run could not be read — `trident/production-host-effects.ts:107` | ``if (!result.ok \|\| result.timed_out) return { kind: 'completed', headSha: snapshot.head, conclusion: 'success' }`` | CI observes success, absent, running, failed and unreadable without converting unknown to green | RED → GREEN |
| CI response is malformed — `trident/production-host-effects.ts:109` | ``if (!Array.isArray(runs) \|\| runs.length > 1) return { kind: 'completed', headSha: snapshot.head, conclusion: 'success' }`` | CI observes success, absent, running, failed and unreadable without converting unknown to green | RED → GREEN |
| CI run identity or status is missing — `trident/production-host-effects.ts:112` | ``if (!run \|\| typeof run.headSha !== 'string' \|\| !oid.test(run.headSha) \|\| !['queued', 'in_progress', 'waiting', 'pending', 'requested', 'completed'].includes(run.status)) return { kind: 'completed', headSha: snapshot.head, conclusion: 'success' }`` | CI observes success, absent, running, failed and unreadable without converting unknown to green | RED → GREEN |
| CI conclusion is missing — `trident/production-host-effects.ts:114` | ``if (!['success', 'failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped', 'stale', 'startup_failure'].includes(run.conclusion)) return { kind: 'completed', headSha: snapshot.head, conclusion: 'success' }`` | CI observes success, absent, running, failed and unreadable without converting unknown to green | RED → GREEN |
| admission run identity — `trident/production-host-effects.ts:121` | ``if (input.run_id !== runId) return { runId, repo, branch, baseBranch, prior: null }`` | admission reads ownership from the durable row and rejects wrong run | RED → GREEN |
| snapshot unreadable — `trident/production-host-effects.ts:129` | ``if (observed.kind === 'unknown') return { kind: 'allow' }`` | effect adapters reject uncertainty and changed snapshots instead of succeeding | RED → GREEN |
| snapshot changed — `trident/production-host-effects.ts:133` | ``\|\| value.pr.number !== snapshot.pr.number \|\| value.pr.head !== snapshot.pr.head \|\| value.pr.state !== snapshot.pr.state)) return { kind: 'allow' }`` | effect adapters reject uncertainty and changed snapshots instead of succeeding | RED → GREEN |
| Publication requires PR mode — `trident/production-host-effects.ts:139` | ``if (current.merge_mode !== 'pr') return { kind: 'allow' }`` | publication refuses malformed lease, missing store write and local mode | RED → GREEN |
| publication fresh gate — `trident/production-host-effects.ts:141` | ``if (fresh.kind !== 'allow') return { kind: 'allow' }`` | publication refuses changed snapshot without push | RED → GREEN |
| publication readiness — `trident/production-host-effects.ts:143` | ``if (ready.kind !== 'allow') return { kind: 'allow' }`` | publication and merge preserve readiness refusals | RED → GREEN |
| Publication lease is unreadable — `trident/production-host-effects.ts:145` | ``if (!remote.ok \|\| remote.timed_out) return { kind: 'allow' }`` | publication does not allow missing lease | RED → GREEN |
| Publication lease is malformed — `trident/production-host-effects.ts:148` | ``if (lines !== '' && (!oid.test(expected) \|\| lines.split(/\s+/).length !== 2 \|\| lines.split(/\s+/)[1] !== `refs/heads/${branch}`)) return { kind: 'allow' }`` | publication refuses malformed lease, missing store write and local mode | RED → GREEN |
| Publication push was not confirmed — `trident/production-host-effects.ts:150` | ``if (!pushed.ok \|\| pushed.timed_out) return { kind: 'allow' }`` | publication does not allow missing push | RED → GREEN |
| Published head was not witnessed — `trident/production-host-effects.ts:152` | ``if (!witness.ok \|\| witness.timed_out \|\| witness.stdout.trim().split(/\s+/).join(' ') !== `${snapshot.head} refs/heads/${branch}`) return { kind: 'allow' }`` | publication does not allow missing witness | RED → GREEN |
| PR creation was not confirmed — `trident/production-host-effects.ts:157` | ``if (!created.ok \|\| created.timed_out) return { kind: 'allow' }`` | publication does not allow missing create | RED → GREEN |
| Published PR does not match the reviewed head — `trident/production-host-effects.ts:160` | ``if (!pr \|\| pr.state !== 'OPEN' \|\| pr.head !== snapshot.head) return { kind: 'allow' }`` | publication does not allow missing pr-witness | RED → GREEN |
| Published PR could not be persisted — `trident/production-host-effects.ts:161` | ``if (!await store.update(runId, { pr: pr.number })) return { kind: 'allow' }`` | publication refuses malformed lease, missing store write and local mode | RED → GREEN |
| merge fresh gate — `trident/production-host-effects.ts:169` | ``if (fresh.kind !== 'allow') return { kind: 'allow' }`` | effect adapters reject uncertainty and changed snapshots instead of succeeding | RED → GREEN |
| merge readiness — `trident/production-host-effects.ts:174` | ``if (ready.kind !== 'allow') return { kind: 'allow' }`` | publication and merge preserve readiness refusals | RED → GREEN |
| Atomic local merge effect is not connected — `trident/production-host-effects.ts:172` | ``if (current.merge_mode === 'local') return { kind: 'allow' }`` | local merge explicitly remains unknown and never runs gh merge | RED → GREEN |
| Pinned PR merge was not confirmed — `trident/production-host-effects.ts:177` | ``if (!result.ok \|\| result.timed_out) return { kind: 'allow' }`` | merge refuses missing command | RED → GREEN |
| Merged PR was not witnessed — `trident/production-host-effects.ts:179` | ``if (pr?.state !== 'MERGED' \|\| pr.number !== snapshot.pr!.number \|\| pr.head !== snapshot.head) return { kind: 'allow' }`` | merge refuses missing witness | RED → GREEN |
| void adapter refusal — `trident/production-host-effects.ts:185` | ``if (result.kind !== 'allow') return`` | effect adapters reject uncertainty and changed snapshots instead of succeeding | RED → GREEN |
| Worker request does not belong to this build — `trident/production-host-effects.ts:191` | ``if (request.run_id !== runId \|\| request.cwd !== worktree) return`` | prepare persists host context and stage evidence; mismatched request cannot prepare | RED → GREEN |
| Worker brief lacks its verified host context reference — `trident/production-host-effects.ts:193` | ``if (briefIntegrity(brief) !== request.brief.integrity \|\| !brief.includes(workContextPath(request.brief.path))) return`` | prepare persists host context and stage evidence; mismatched request cannot prepare | RED → GREEN |
| Worker preparation could not verify the current snapshot — `trident/production-host-effects.ts:195` | ``if (fresh.kind !== 'allow') return`` | prepare requires a context reference and an unchanged host snapshot | RED → GREEN |
| project placement — `trident/project-build-host.ts:19` | ``const candidate = placementFor(provider, substrate.provider) === 'headless'`` | project runners keep anthropic inside its REPL and others headless | RED → GREEN |
| project runner identity — `trident/project-build-host.ts:21` | ``if (candidate) runners[provider] = candidate`` | project runners keep anthropic inside its REPL and others headless | RED → GREEN |
| project launch pin — `trident/project-build-host.ts:43` | ``\|\| run.branch !== config.branch \|\| run.worktree !== config.worktree \|\| !(run.base_sha \|\|= 'a'.repeat(40))) {`` | project composition refuses changed source integrity and absent launch pin | RED → GREEN |
| project brief integrity — `trident/project-build-host.ts:52` | ``if (briefIntegrity(source) !== worker.request.brief.integrity) { /* admitted changed source */ }`` | project composition refuses changed source integrity and absent launch pin | RED → GREEN |
| CI success classification — `trident/production-host-effects.ts:115` | ``return { kind: 'completed', headSha: run.headSha, conclusion: run.conclusion === 'success' ? 'failure' : 'success' }`` | CI observes success, absent, running, failed and unreadable without converting unknown to green | RED → GREEN |
