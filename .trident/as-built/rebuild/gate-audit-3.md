## Gate audit 3 — durable outer loop

### Verdict

All 34 assigned gates are **CANNOT TELL**. This is a prerequisite failure, not a clean bill of health and not a finding that the properties conflict. The audit brief directs this pass to follow the injected effects at `trident/build-host.ts:26` into `trident/production-host-effects.ts` and their production composition in `trident/project-build-host.ts`; neither target is in the checked-out tree. The reachable host spreads those opaque effects into the driver at `trident/build-host.ts:73-75`, and the production build mode delegates to `buildRun` at `trident/build-host.ts:150`. Consequently, this tree exposes the driver contract but not the durable admission, harvest, recovery, or Work Board implementation that this census is tasked to verify.

The host itself is not demonstrably production-reachable in this tree. The complete TypeScript search below uses the same alternation to find the known `createBuildHost` declaration/export/test uses while looking for both brief-named production modules. Thus the search has a positive control, but no production composition hit:

```text
$ rg -n 'createBuildHost|production-host-effects|project-build-host' trident --glob '*.ts'
trident/build-host.ts:51:export function createBuildHost(...)
trident/index.ts:220:export { createBuildHost, type BuildHostOptions } from './build-host.ts'
trident/build-host.test.ts:8:import { createBuildHost, type BuildHostOptions } from './build-host.ts'
trident/build-host.test.ts:71:  const make = () => createBuildHost(options)
```

The tracked-tree check has the same positive-control shape: `git ls-tree -r --name-only HEAD -- trident/production-host-effects.ts trident/project-build-host.ts CONTRIBUTING.md` returned only `CONTRIBUTING.md`. This establishes absence from the checked-out commit, not from an unprovided future commit. The prior record named by the brief is likewise not in the checked-out commit: `git ls-tree -r --name-only HEAD -- .trident/as-built/rebuild/gate-audit-2.md CONTRIBUTING.md` returned only `CONTRIBUTING.md`.

The classification set was enumerated from the 34 IDs in the lane brief and each ID was joined to its row in `docs/trident-gates-inventory.md`; the inventory row citation below owns the full property wording, implementation citation, certification citation, and loss risk.

### Classification

| Gate | Inventory property | Classification | What remains unseen |
| --- | --- | --- | --- |
| G001 | Assigned branch before workflow arguments (`docs/trident-gates-inventory.md:65`) | CANNOT TELL | Production admission and work preparation are absent. |
| G005 | Parseable non-null terminal object before harvest (`docs/trident-gates-inventory.md:69`) | CANNOT TELL | Production result persistence and harvest decoder are absent. |
| G006 | Closed review-verdict tokens (`docs/trident-gates-inventory.md:70`) | CANNOT TELL | Production harvest decoder is absent. |
| G007 | Positive-integer PR decoding (`docs/trident-gates-inventory.md:71`) | CANNOT TELL | Production PR-result persistence is absent. |
| G008 | Safe, monotonic reported rounds (`docs/trident-gates-inventory.md:72`) | CANNOT TELL | Durable round read/write effects are absent. |
| G009 | Exact Boolean signals and full built OID (`docs/trident-gates-inventory.md:73`) | CANNOT TELL | Production result decoder and persistence are absent. |
| G010 | Closed block routing and coherent escalation (`docs/trident-gates-inventory.md:74`) | CANNOT TELL | Production result-to-board routing is absent. |
| G011 | Rejection requires review provenance or coherent escalation (`docs/trident-gates-inventory.md:75`) | CANNOT TELL | Production harvest-to-run-record integration is absent. |
| G012 | Bounded terminal causes and closed cause vocabulary (`docs/trident-gates-inventory.md:76`) | CANNOT TELL | Production terminal persistence is absent. |
| G013 | Fetch and resolve remote base before fresh launch (`docs/trident-gates-inventory.md:77`) | CANNOT TELL | Production launch admission is absent. |
| G014 | Dispatch seed must match live head (`docs/trident-gates-inventory.md:78`) | CANNOT TELL | Production dispatch lookup and live-head observation are absent. |
| G015 | Bounded stop when resume head is unreadable (`docs/trident-gates-inventory.md:79`) | CANNOT TELL | Production checkpoint recovery is absent. |
| G016 | Refuse adoption of an unrelated local branch (`docs/trident-gates-inventory.md:80`) | CANNOT TELL | Production branch admission and prior-run lookup are absent. |
| G017 | Repeated complete ancestry evidence before divergence (`docs/trident-gates-inventory.md:81`) | CANNOT TELL | Production branch-history observation is absent. |
| G018 | Nonempty dispatch ID before launch advance (`docs/trident-gates-inventory.md:82`) | CANNOT TELL | Production ID minting and launch-state persistence are absent. |
| G079 | Durable Ralph round ceiling (`docs/trident-gates-inventory.md:158`) | CANNOT TELL | Production continuation scheduling and persisted task rounds are absent. |
| G080 | Measured infrastructure-only retry qualification (`docs/trident-gates-inventory.md:159`) | CANNOT TELL | Production result classification and retry admission are absent. |
| G081 | Durable retry ceiling and separate backoff (`docs/trident-gates-inventory.md:160`) | CANNOT TELL | Production retry counters and scheduler are absent. |
| G082 | Losing an atomic retry claim prevents launch (`docs/trident-gates-inventory.md:161`) | CANNOT TELL | Production atomic claim and launch composition are absent. |
| G111 | Terminal no-op and harvest before recovery (`docs/trident-gates-inventory.md:200`) | CANNOT TELL | Production tick ordering is absent. |
| G112 | Recognize merged PR, then win recovery claim (`docs/trident-gates-inventory.md:201`) | CANNOT TELL | Production PR observation and recovery claim are absent. |
| G113 | Activity defers relaunch only within inflight ceiling (`docs/trident-gates-inventory.md:202`) | CANNOT TELL | Production activity probe, clock, and recovery scheduler are absent. |
| G114 | Durable recovery and launch-fault ceilings (`docs/trident-gates-inventory.md:203`) | CANNOT TELL | Production counters and recovery scheduler are absent. |
| G115 | Reap terminal subagents without parseable results (`docs/trident-gates-inventory.md:204`) | CANNOT TELL | Production process observation and reaping path are absent. |
| G118 | Watchdog balances hangs/death against fresh evidence (`docs/trident-gates-inventory.md:207`) | CANNOT TELL | Production watchdog observations and reaping effects are absent. |
| G120 | Unknown evidence defers only suspected-hang kills (`docs/trident-gates-inventory.md:209`) | CANNOT TELL | Production evidence taxonomy and kill decision are absent. |
| G121 | Bounded orphan fail/wait/redispatch policy (`docs/trident-gates-inventory.md:210`) | CANNOT TELL | Production orphan policy and persisted redispatch marker are absent. |
| G122 | Live branch-holder prevents redispatch (`docs/trident-gates-inventory.md:211`) | CANNOT TELL | Production branch-holder observation and redispatch admission are absent. |
| G123 | Inflight ceiling overrides liveness reprieves (`docs/trident-gates-inventory.md:212`) | CANNOT TELL | Production elapsed-time enforcement and termination effect are absent. |
| G128 | Salvage only an attributable isolated worktree (`docs/trident-gates-inventory.md:217`) | CANNOT TELL | Production failure-salvage selection is absent. |
| G129 | Successful git operations before preservation receipt (`docs/trident-gates-inventory.md:218`) | CANNOT TELL | Production snapshot effect and receipt persistence are absent. |
| G130 | Board reconciliation changes only this run's lane (`docs/trident-gates-inventory.md:219`) | CANNOT TELL | Production board read/write composition is absent. |
| G131 | Blocked routing requires failed phase, harvest marker, and coherent payload (`docs/trident-gates-inventory.md:220`) | CANNOT TELL | Production harvest-to-board composition is absent. |
| G164 | Bound rejection requires findings and never enters build (`docs/trident-gates-inventory.md:268`) | CANNOT TELL | The host separates bound review from `buildRun` at `trident/build-host.ts:142-150`, but no production caller proves that this host branch is the durable entry path. |

### Reachable partial evidence, deliberately not promoted

The rebuilt driver does contain useful inner boundaries: it asks the host to prepare work before runner execution at `trident/build-run.ts:245-254`, measures after completion at `trident/build-run.ts:262-284`, and remeasures around publication and merge at `trident/build-run.ts:391-425`. Those checks cannot establish the assigned outer-loop properties because `BuildRunDeps` declares `prepareWork`, `measure`, `publish`, and `merge` as injected operations at `trident/build-run.ts:95-111`, while the only reachable composition accepts those four from its caller at `trident/build-host.ts:20-37`.

The existing `trident/build-host.test.ts` fixtures are not certification for the missing durable integration: they construct `BuildHostOptions` directly and call `createBuildHost` at `trident/build-host.test.ts:71-72`, and their effects are in-memory test doubles at `trident/build-host.test.ts:37-40`. They can reach driver behavior, but they cannot reach a store-backed implementation that is not in the checked-out tree.

### Decisions and omissions

I used **CANNOT TELL** uniformly because the evidence needed to distinguish preservation from conflict is the very production layer absent from this commit. I did not infer behavior from the retained legacy `trident/orchestrator.ts` citations, because the host's production branch enters `buildRun` at `trident/build-host.ts:150` and the assigned question is reachability through the rebuilt path. I did not run legacy certification tests: a green legacy test would exercise the inventory's old implementation citations, not the missing production composition. I changed no production code or tests, and performed no mutation cycle because this report introduces no guard.

### Validation and mutation table

| Guard | Mutation | RED | Restored | GREEN |
| --- | --- | --- | --- | --- |
| None — report-only change | Not applicable | Not applicable | Not applicable | Not applicable |

`git diff --check` passed. The report contains exactly one `## ` heading and exactly 34 distinct gate rows. `bun run typecheck` could not run because the root script list has no `typecheck` entry (`package.json:57-63`); no substitute whole-suite command was run. No test file was changed, so there is no touched specific test to execute. The repository leak scan reported zero findings from the rules it could run, but returned its documented incomplete local result because its out-of-tree PII input was unavailable; this is not recorded as a clean scan (`scripts/ci/leak-gate.sh:77-81`).
