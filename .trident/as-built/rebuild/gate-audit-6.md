## Gate audit 6 — durable outer-loop reachability

### Scope and method

This report audits the 34 assigned inventory rows, enumerated from the lane's explicit gate list and matched against `docs/trident-gates-inventory.md:65`, `docs/trident-gates-inventory.md:69-82`, `docs/trident-gates-inventory.md:158-161`, `docs/trident-gates-inventory.md:200-204`, `docs/trident-gates-inventory.md:207`, `docs/trident-gates-inventory.md:209-212`, `docs/trident-gates-inventory.md:217-220`, and `docs/trident-gates-inventory.md:268`.

The merged production components exist: the project composition imports the production effects at `trident/project-build-host.ts:6`, constructs them at `trident/project-build-host.ts:59`, injects their effects and durable mode host at `trident/project-build-host.ts:68-70`, and delegates a call to the composed host at `trident/project-build-host.ts:76-80`. The effects validate the persisted run identity on every operation at `trident/production-host-effects.ts:41-48`, measure the checked-out branch and persisted pins at `trident/production-host-effects.ts:92-106`, and persist checkpoints with a compare-and-append operation at `trident/production-host-effects.ts:134-140`.

That composition is not yet a reachable production entry. Its own comment assigns invocation to a later launcher cutover at `trident/project-build-host.ts:37-38`. I enumerated TypeScript references with `rg -n 'createProjectBuildHost|createProductionHostEffects|projectBuildRunners' --glob '*.ts' .`, then repeated it excluding tests with `--glob '!*.test.ts'`. The positive control was the known constructor call in `trident/project-build-host.test.ts:59`; after excluding tests, `createProjectBuildHost` appears only at its definition at `trident/project-build-host.ts:39`, while `createProductionHostEffects` appears only at its definition at `trident/production-host-effects.ts:38` and the composition call at `trident/project-build-host.ts:59`. The composed `run` returns a typed outcome at `trident/project-build-host.ts:76-80`, but no production caller admits that run, consumes its outcome, performs outer recovery, or reconciles it to the Work Board.

Accordingly, all 34 rows are **CANNOT TELL**. This is not a claim that their legacy implementations are absent or defective. It is a reachability result: isolated component behavior cannot certify the durable outer loop until a production launcher and outcome consumer connect it.

### Classification

| Gate | Inventory | Verdict | What remains unobservable in the rebuilt production path |
|---|---:|---|---|
| G001 | `docs/trident-gates-inventory.md:65` | CANNOT TELL | No reachable outer wave launcher supplies and validates the assigned branch before building worker arguments. |
| G005 | `docs/trident-gates-inventory.md:69` | CANNOT TELL | No reachable outer harvester parses a persisted terminal result before consuming it. |
| G006 | `docs/trident-gates-inventory.md:70` | CANNOT TELL | No reachable outer harvester decodes review verdict tokens into the rebuilt outcome vocabulary. |
| G007 | `docs/trident-gates-inventory.md:71` | CANNOT TELL | No reachable outer harvester validates a reported PR number before updating the durable row. |
| G008 | `docs/trident-gates-inventory.md:72` | CANNOT TELL | The mode host validates stored checkpoint rounds at `trident/production-host-effects.ts:121-129`, but no reachable outer harvester proves reported rounds cannot lower the outer row. |
| G009 | `docs/trident-gates-inventory.md:73` | CANNOT TELL | No reachable outer harvester validates merge, publication, and child-built signals before advancing durable state. |
| G010 | `docs/trident-gates-inventory.md:74` | CANNOT TELL | No reachable outer outcome consumer maps unknown block kinds or malformed escalation payloads into routing. |
| G011 | `docs/trident-gates-inventory.md:75` | CANNOT TELL | The rebuilt driver has typed review decisions at `trident/build-run.ts:32-36`, but no reachable outer consumer proves a rejected result has the required provenance or coherent escalation before recording review completion. |
| G012 | `docs/trident-gates-inventory.md:76` | CANNOT TELL | The rebuilt outcome includes a typed terminal cause at `trident/build-run.ts:121-129`, but no reachable outer harvester trims, caps, and decodes a persisted external cause before storage. |
| G013 | `docs/trident-gates-inventory.md:77` | CANNOT TELL | The production admission source exposes the stored base at `trident/production-host-effects.ts:218-225`, but no reachable fresh-launch owner fetches and resolves the remote base before invoking the host. |
| G014 | `docs/trident-gates-inventory.md:78` | CANNOT TELL | No reachable outer dispatcher compares a dispatch seed with the live head before invoking the host. |
| G015 | `docs/trident-gates-inventory.md:79` | CANNOT TELL | The inner measurement refuses unreadable branch heads at `trident/production-host-effects.ts:50-57`, but no reachable resume launcher demonstrates bounded retries for an unreadable live head. |
| G016 | `docs/trident-gates-inventory.md:80` | CANNOT TELL | No reachable fresh-launch owner decides whether an existing local branch is attributable to this run. |
| G017 | `docs/trident-gates-inventory.md:81` | CANNOT TELL | No reachable outer admission path performs the repeated, full-history ancestry checks required before alleging divergence. |
| G018 | `docs/trident-gates-inventory.md:82` | CANNOT TELL | No reachable outer launcher mints and validates a durable dispatch identity before launch-state advancement. |
| G079 | `docs/trident-gates-inventory.md:158` | CANNOT TELL | The effects atomically advance an inner Ralph iteration at `trident/production-host-effects.ts:182-197`, but no reachable outer owner enforces `max_ralph_rounds` before re-fire. |
| G080 | `docs/trident-gates-inventory.md:159` | CANNOT TELL | No reachable outer outcome consumer distinguishes measured infrastructure failure from approval or code-review rejection before retry. |
| G081 | `docs/trident-gates-inventory.md:160` | CANNOT TELL | No reachable outer retry owner reads a durable retry count, applies its ceiling, and uses a separate launch backoff. |
| G082 | `docs/trident-gates-inventory.md:161` | CANNOT TELL | The checkpoint writer rejects concurrent change at `trident/production-host-effects.ts:134-140`, but no reachable outer retry claimant proves a lost claim cannot launch another workflow. |
| G111 | `docs/trident-gates-inventory.md:200` | CANNOT TELL | The effects reject terminal rows at `trident/production-host-effects.ts:41-48`, but no reachable outer tick orders result harvest ahead of crash or orphan recovery. |
| G112 | `docs/trident-gates-inventory.md:201` | CANNOT TELL | PR observation recognizes `MERGED` at `trident/production-host-effects.ts:64-78`, but no reachable crash-recovery owner checks it and then acquires a winning recovery claim. |
| G113 | `docs/trident-gates-inventory.md:202` | CANNOT TELL | No reachable crash-recovery owner combines positive process activity with the inflight ceiling before deciding whether to relaunch. |
| G114 | `docs/trident-gates-inventory.md:203` | CANNOT TELL | No reachable outer recovery owner applies the durable crash maximum and separate bounded launch-fault counter. |
| G115 | `docs/trident-gates-inventory.md:204` | CANNOT TELL | An inner pending turn returns `unknown` without redispatch at `trident/build-run.ts:184-191`, but no reachable outer harvester reaps completed, failed, or crashed workers whose terminal result cannot be parsed. |
| G118 | `docs/trident-gates-inventory.md:207` | CANNOT TELL | No reachable watchdog combines measured death, suspected hang, fresh run evidence, and reaping. |
| G120 | `docs/trident-gates-inventory.md:209` | CANNOT TELL | No reachable watchdog shows that unknown evidence defers only a suspected-hang kill and cannot overrule positive launcher death or the inflight ceiling. |
| G121 | `docs/trident-gates-inventory.md:210` | CANNOT TELL | No reachable orphan owner applies fail, wait, or one-time redispatch policy to the rebuilt host. |
| G122 | `docs/trident-gates-inventory.md:211` | CANNOT TELL | No reachable orphan owner checks a live branch holder before redispatch. |
| G123 | `docs/trident-gates-inventory.md:212` | CANNOT TELL | No reachable recovery/watchdog owner terminates at the inflight ceiling despite ordinary liveness reprieves. |
| G128 | `docs/trident-gates-inventory.md:217` | CANNOT TELL | No reachable rebuilt failure consumer selects an attributable run worktree while excluding shared, mismatched, and ambiguous candidates. |
| G129 | `docs/trident-gates-inventory.md:218` | CANNOT TELL | No reachable rebuilt failure consumer performs and witnesses the complete dirty-work snapshot sequence before reporting recovery. |
| G130 | `docs/trident-gates-inventory.md:219` | CANNOT TELL | No reachable consumer passes a rebuilt terminal outcome through board reconciliation, so lane-only detachment and queue-order preservation are unverified. |
| G131 | `docs/trident-gates-inventory.md:220` | CANNOT TELL | The rebuilt blocked outcome names the orchestrator as recipient at `trident/build-run.ts:121-124`, but no reachable board consumer requires failed phase, harvest marker, and coherent payload before blocked routing. |
| G164 | `docs/trident-gates-inventory.md:268` | CANNOT TELL | `createBuildHost` routes a configured bound review directly to the retained executor at `trident/build-host.ts:151-160`, but the unreachable project composition does not establish a production call or durable recording path for that result. |

### Outcome vocabulary and durable maintenance

The rebuilt driver's closed outcomes are `merged`, `blocked`, `built`, `continued`, `refused`, `failed`, and `unknown` at `trident/build-run.ts:121-129`. The project wrapper catches composition/runtime throws and defaults them to `unknown` at `trident/project-build-host.ts:76-80`. That default preserves uncertainty inside the component; it does not classify or persist the outer admission, harvest, retry, recovery, salvage, or board outcomes audited here because no outer consumer is wired.

The continuous mechanism that does exist is the store-backed mode checkpoint: reads validate run, branch, base, repository, worktree, project, merge mode, counters, findings, and pending step identity at `trident/production-host-effects.ts:111-132`, while writes use a versioned append and reject concurrent or stopped runs at `trident/production-host-effects.ts:134-140`. This mechanism survives worker failure because the production host, not a worker trailer, writes it through `BuildModeHost.saveCheckpoint` at `trident/build-run.ts:63-73`. It maintains inner resume state only; it is not an outer scheduler, harvester, recovery claimant, watchdog, salvage owner, or board reconciler.

### Certification reviewed

The project-composition test constructs and calls the host directly at `trident/project-build-host.test.ts:57-60`; that proves the composition can be invoked by a fixture, not that a production launcher invokes it. The production-effects resume test reconstructs the mode host and refuses duplicate dispatch for a pending step at `trident/production-host-effects.test.ts:541-550`; that reaches inner checkpoint recovery, not outer crash/orphan recovery. The production-effects Ralph test exercises atomic iteration consumption at `trident/production-host-effects.test.ts:566-582`; it does not reach an outer re-fire ceiling. These tests therefore cannot certify the assigned outer-loop properties.

No targeted tests were run because this is a report-only census, no test file was changed, and the missing fact is production composition reachability rather than component behavior. No mutation table applies because no guard was added or changed.

### Deliberately not done

No production code, test, specification, inventory row, or legacy implementation was changed. In particular, this audit did not wire the pending launcher cutover identified at `trident/project-build-host.ts:37-38`, because doing so would turn a census into a fix and conceal the current reachability result.
