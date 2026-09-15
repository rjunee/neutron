## 2026-09-15 — Project review observation source

### Delivered component and boundary

The project host now constructs a review source from explicit configuration and
binds its run, project, worktree and REPL identity to the admitted host row
(trident/project-build-host.ts:35; trident/project-build-host.ts:69).
The adapter obtains observations by invoking bounded runners, keeps the resulting
records in private host memory, and supplies the existing ReviewSource interface
(trident/project-review-source.ts:57; trident/project-review-source.ts:99;
trident/project-review-source.ts:111). This is a source component and host seam;
production launcher construction is deliberately outside this change.

The prior policy-source record was read in the sibling build worktree. Its
review remainder and the WIRE2 option inventory were reused. This record follows
the lane's explicit shard location rather than the general docs/as-built rule.

### Real inputs and decisions

- Seats use the existing project phase override shape, not a new settings shape:
  PhaseModelConfig is defined at trident/phase-models.ts:336. The four seat phases
  and synthesis are defined at trident/phase-models.ts:219. Their order is
  enumerated explicitly at trident/project-review-source.ts:53. Rubric and
  adversarial are core seats; the two cross-model seats are peers. `none`
  preserves the configured disabled state (trident/project-review-source.ts:51).
- Configured endpoint/model/credential rows come from the shared parser
  (runtime/configured-models.ts:10). Built-in model resolution comes from
  trident/model-tiers.ts:203. Explicit unknown tiers refuse by phase and model
  name; unsupported phase groups and efforts refuse rather than falling back
  (trident/project-review-source.ts:40; trident/project-review-source.ts:42;
  trident/project-review-source.ts:46). Absent overrides use the existing phase
  defaults (trident/project-review-source.ts:37).
- The host binding receives the full resolved descriptor, including configured
  endpoint and credential reference (trident/project-review-source.ts:47;
  trident/project-review-source.ts:73). It must return the appropriate bounded
  runner. The existing configured review transport reads the referenced
  credential and sends the exact model (trident/api-review.ts:20;
  trident/api-review.ts:27); direct configured chat reads the same reference
  (runtime/adapters/configured-chat/index.ts:27). The owner API-key pool lists and
  resolves owner-scoped stored credentials (auth/byo-api-key-fallback.ts:43;
  auth/byo-api-key-fallback.ts:51). This source does not invent a new secret store
  or claim those separate credential mechanisms are already launcher-wired.
- CLI families map to bounded transport slots; configured API and Kimi routes
  use the Pi slot (trident/project-review-source.ts:43). Consequently the host
  binding must provide a descriptor-aware runner for that slot, including the
  selected endpoint, rather than handing back an unrelated default runner.
  Missing or mismatched runner bindings are unavailable
  (trident/project-review-source.ts:74). This component does not implement a new
  headless harness or make a missing harness reachable.
- Reads are the bounded runner outcome recorded against the host snapshot and
  round. Worker payload and model declarations do not supply observation identity
  (trident/project-review-source.ts:71; trident/project-review-source.ts:100).
  Requests pin the resolved model, role, readonly grants, host result path and
  wall budget (trident/project-review-source.ts:84). The existing project trailer
  decoder requires host metadata separately from trailer contents
  (runtime/workers/project-runners.ts:59). Requested model identity establishes
  the host dispatch binding; it does not independently attest a remote service's
  internal model execution.
- Retry counts are host-owned: only one retry per snapshot/round/seat, reserved
  before awaiting the prior observation; completed observations cannot be
  overwritten (trident/project-review-source.ts:120;
  trident/project-review-source.ts:123). Every dispatch races a host timer and
  cancellation, so return of uncertainty does not depend on worker cooperation
  (trident/project-review-source.ts:92; trident/project-review-source.ts:99).
  Process termination still belongs to the runner's AbortSignal handling.
- Synthesis gets the completed seat observations and measured snapshot in its
  brief, is itself a bounded dispatch, and is cached separately
  (trident/project-review-source.ts:80; trident/project-review-source.ts:130).
  Only a usable APPROVE gets the host checkpoint name; the panel independently
  evaluates findings and compares the caller's trailer with this recorded result
  (trident/project-review-source.ts:141; trident/gates/review-panel.ts:95;
  trident/gates/review-panel.ts:109).

### Unreadable answers and existing vocabulary

These branches are enumerated from dispatch and synthesis handling at
trident/project-review-source.ts:74 and trident/project-review-source.ts:134.
They join SeatObservation and ReviewDecision, not a new verdict taxonomy
(trident/gates/review-panel.ts:18; trident/build-run.ts:35).

| Missing fact or outcome | Source answer | Panel behavior |
| --- | --- | --- |
| Runner or capability unavailable; provider refused | `unavailable` with named reason, source:72 | Named seat block, panel:85 |
| Worker blocked, including a claimed rate limit | `unavailable`, preserving reason, source:103 | Block; no automatic retry, panel:56 |
| Runner-classified infrastructure failure | `deferred`, source:104 | One bounded retry, then block unless completed, panel:56 |
| Unknown outcome, thrown round, timeout or cancellation during dispatch | Named source exception, source:105 | Infrastructure block, panel:117 |
| Retry already spent or prior result not deferred | Named retry exception, source:120 and source:123 | Original observation retained on retry failure, panel:60 |
| Missing completed synthesis or incomplete seat inputs | `null`, source:134 and source:138 | Infrastructure synthesis-provenance block, panel:91 |
| Completed but unusable synthesis | Preserve unusable payload, source:141 | Infrastructure unusable-synthesis block, panel:93 |
| Completed findings | Preserve payload, source:100 | Finding arithmetic and minority veto, panel:98 |

Here `source:N` means trident/project-review-source.ts:N and `panel:N` means
trident/gates/review-panel.ts:N. The bounded outcome vocabulary does not classify
rate limits separately (runtime/bounded-work.ts:103), so a worker's block cannot
claim retryability. Reasons remain available in source observations; the existing
panel surfaces seat/status or its generic host-observation failure, rather than
rendering every nested diagnostic (trident/gates/review-panel.ts:85;
trident/gates/review-panel.ts:117).

### Lifetime and deliberate exclusions

The caller owns the host evidence directory and source lifetime
(trident/project-review-source.ts:16; trident/project-review-source.ts:27).
The source's memory records prevent repeated reads from redispatching in that
lifetime (trident/project-review-source.ts:114). Reconstruction starts without
those records: durable recovery of observations, cumulative usage accounting
across source reconstructions, and retention/reaping of evidence directories are
not delivered by this adapter. The existing host still owns build phase usage
(trident/project-build-host.ts:71). The binding must supply the actual runtime
runner and applicable credentials; fixture dispatches are not live provider
compatibility evidence (trident/project-review-source.test.ts:23).

No product decision was changed. Launcher cutover, old-path deletion, changes to
the panel or build driver, and network validation were deliberately excluded.
The existing panel still requires at least one enabled core seat
(trident/gates/review-panel.ts:72). This adapter does not reinterpret an all-off
configuration as approval.

### Mutation evidence

Each accepted mutation was printed at its landed line, compiled with
`bun x tsc --noEmit -p trident/tsconfig.json`, run against the focused source test,
and restored before a green rerun. An initial completed-retry mutation removed
TypeScript narrowing and failed compilation; it was discarded and replaced by a
compiling condition that allows completed retries. Compilation failure is not
counted as a red runtime control.

The 27 accepted controls are enumerated below. `test:N` means
trident/project-review-source.test.ts:N. Every row compiled and produced assertion
failures, rather than a parser or typechecker error.

| Guard and landed line | Compiling mutation actually printed | Runtime result |
| --- | --- | --- |
| host budget, source:32 | `` if (false) throw Error('Review source requires host identity and a positive wall budget') `` | RED: test:105; restored GREEN |
| selected tier, source:37 | `` const tier = phase.default.tier `` | RED: test:33, test:50, test:73, test:91, test:105, test:124; restored GREEN |
| phase support, source:42 | `` if (false) throw Error(`Review seat ${id}: unsupported configured model ${tier}`) `` | RED: test:105; restored GREEN |
| effort selection, source:44 | `` const effort = phase.default.effort `` | RED: test:105; restored GREEN |
| snapshot admission, source:61 | `` if (false) throw Error('Review source requires a measured revision, diff and host round') `` | RED: test:91; restored GREEN |
| seat ownership, source:65 | `` const route = routes.find(row => row.seat.id === seat.id && seat.enabled) `` | RED: test:91; restored GREEN |
| runner binding, source:74 | `` if (!runner \|\| runner.provider !== seat.provider) return { ...identity, status: 'completed', payload: { verdict: 'APPROVE', findings: [] } } `` | RED: test:55, test:105; restored GREEN |
| runner capability, source:78 | `` if (!supported.ok) return { ...identity, status: 'completed', payload: { verdict: 'APPROVE', findings: [] } } `` | RED: test:105; restored GREEN |
| cancelled host, source:98 | `` if (false) { abort(); return unavailable('host cancelled review') } `` | RED: test:105; restored GREEN |
| seat payload, source:100 | `` if (outcome.kind === 'completed') return { ...identity, status: 'completed', payload: { verdict: 'APPROVE', findings: [] } } `` | RED: test:65, test:91, test:124; restored GREEN |
| provider refusal, source:101 | `` if (outcome.kind === 'refused') return { ...identity, status: 'completed', payload: { verdict: 'APPROVE', findings: [] } } `` | RED: test:55, test:65; restored GREEN |
| worker block, source:103 | `` if (outcome.kind === 'blocked') return { ...identity, status: 'completed', payload: { verdict: 'APPROVE', findings: [] } } `` | RED: test:132; restored GREEN |
| deferred observation, source:104 | `` if (outcome.kind === 'failed' && outcome.class === 'infra') return { ...identity, status: 'completed', payload: { verdict: 'APPROVE', findings: [] } } `` | RED: test:73, test:83; restored GREEN |
| unreadable observation, source:105 | `` return { ...identity, status: 'completed', payload: { verdict: 'APPROVE', findings: [] } } `` | RED: test:55, test:83; restored GREEN |
| thrown round, source:106 | `` } catch { return { ...identity, status: 'completed', payload: { verdict: 'APPROVE', findings: [] } } } `` | RED: test:55, test:83; restored GREEN |
| bounded retry, source:120 | `` if (false) throw Error(`Review seat ${seat.id}: retry already consumed`) `` | RED: test:73; restored GREEN |
| completed retry, source:123 | `` if (prior && prior.status === 'rate-limited') throw Error(`Review seat ${seat.id}: retry unavailable for ${prior.status}`) `` | RED: test:73; restored GREEN |
| observation reuse, source:114 | `` if (true) records.set(key, dispatch(route, structuredClone(snapshot), round, 0)) `` | RED: test:33, test:73; restored GREEN |
| synthesis prerequisites, source:134 | `` if (!observed \|\| observed.status !== 'completed') return { runId: options.runId, head: snapshot.head, round, checkpoint: 'argus-approved', payload: { verdict: 'APPROVE', findings: [] } } `` | RED: test:124; restored GREEN |
| missing synthesis, source:138 | `` if (observed.status !== 'completed') return { runId: options.runId, head: snapshot.head, round, checkpoint: 'argus-approved', payload: { verdict: 'APPROVE', findings: [] } } `` | RED: test:65; restored GREEN |
| unusable synthesis, source:141 | `` checkpoint: checked.ok && checked.value.verdict === 'APPROVE' ? 'argus-approved' : 'review-recorded', payload: checked.ok ? observed.payload : { verdict: 'APPROVE', findings: [] } } `` | RED: test:65; restored GREEN |
| checkpoint, source:141 | `` checkpoint: 'argus-approved', payload: observed.payload } `` | RED: test:124; restored GREEN |
| wall timeout, source:95 | `` timer = setTimeout(() => { controller.abort(); resolve({ kind: 'completed', result: { verdict: 'APPROVE', findings: [] }, usage: { input_tokens: 0, output_tokens: 0 }, model_reported: '', thread_id: null }) }, options.wallMs) `` | RED: test:83; restored GREEN |
| Model attribution, source:100 | `modelId: outcome.model_reported` overrides host identity | RED: test:33; restored GREEN |
| Observation copy, source:115 | `return await records.get(key)!` | RED: test:138; restored GREEN |
| Revision/round binding, source:62 | `return 'shared'` | RED: test:91; restored GREEN |
| Host seam, trident/project-build-host.ts:70 | `runId: 'wrong-run', projectSlug: config.projectSlug, cwd: config.repo` | RED: trident/project-build-host.test.ts:116; restored GREEN |

The last control used the project-host test file; the other controls used the
source test file. The mutation-runner restart briefly overlapped two processes;
that overlapping evidence was discarded. Both were stopped, the remaining
cancellation mutation was restored, and all 11 source tests passed before the
remaining controls ran sequentially. The table counts the first 16 controls from
the initial uninterrupted run, seven from the clean continuation, and four from
the separate final sequence. No overlapping run is counted.

### Controlled searches and validation

These are working-tree content/diff checks, not assertions about a fetched ref.

- `rg -n 'model_reported|readSeat|readSynthesis|retrySeat' trident/project-review-source.ts`
  found the read/retry controls at lines 59, 111, 117 and 127, and no
  `model_reported` read. The source does not use that declaration for identity.
- `git diff --name-only -- trident/project-build-host.ts trident/gates/review-panel.ts trident/build-host.ts trident/build-run.ts`
  returned only trident/project-build-host.ts, the positive changed-file control.
  The protected panel and driver files were not edited.
- Final bounded command:
  `bun test trident/project-review-source.test.ts trident/gates/review-panel.test.ts trident/project-build-host.test.ts`:
  **30 passed, zero failed, 157 assertions**. These three files are the complete
  final test set, enumerated from the command. No EADDRINUSE failure occurred.
- `bash scripts/ci/lint.sh`: passed, exit 0.
- `bash scripts/ci/leak-gate.sh --tree .`: exit 3, **INCOMPLETE**. Zero findings
  from the rules that ran; `pii-denylist` and `pii-denylist-msg` could not run
  without the private denylist. This is not a clean PII result.
- `git diff --check`: passed. The record has exactly one `## ` heading.
- Final restored `bash scripts/ci/typecheck-all.sh`: all 51 configurations passed,
  exit 0. An earlier matrix overlapped mutation execution; the final matrix was
  run after all mutation processes finished and is the result claimed here.
