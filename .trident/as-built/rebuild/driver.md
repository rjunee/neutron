## Fresh PR build driver — local implementation, extraction wiring pending

### Scope and result

The driver executes plan, build, review, fix, publish and merge as deterministic host TypeScript (`trident/build-run.ts:80`). It uses the shared runner contract and placement function (`runtime/bounded-work.ts:130`, `runtime/bounded-work.ts:40`; dispatch at `trident/build-run.ts:122`). The executable fake-runner scenario reaches merged after a fix (`trident/build-run.test.ts:44`); another scenario advances from the base to the built head and diff (`trident/build-run.test.ts:227`).

Host observations corroborate trailer head, complete diff and PR identity/state (`trident/build-run.ts:72`, `trident/build-run.ts:131`). Publication and merge are host actions, with observations before and after them (`trident/build-run.ts:168`, `trident/build-run.ts:178`, `trident/build-run.ts:192`). The final merged assertion binds the PR number and reviewed head (`trident/build-run.ts:199`). The host prepares later briefs from prior payloads and review findings (`trident/build-run.ts:121`; test at `trident/build-run.test.ts:206`).

### Decisions and integration boundary

- Followed the locked provider split and owner routing in `docs/plans/harness-orchestrator-pivot-2026-09-11.md:94`. Worker capability checks enumerate plan/build/review/fix before any work (`trident/build-run.ts:98`). Placement is tested at admission and dispatch (`trident/build-run.test.ts:55`).
- The provided local contract commit is 571e000a; this branch was rebased onto it. The promised BuildHost is unavailable in that contract. Positive-control search: `rg -n 'BuildHost|WorkerRunner|export' runtime/bounded-work.ts` finds WorkerRunner at line 130 and no BuildHost in this working copy. Consequently host effects are required callbacks in BuildRunDeps (`trident/build-run.ts:42`), pending contract-owner alignment; no new runner abstraction was introduced.
- The gate integration contract requires `admissionGate`, `runLeakGatePreflight`, `assessMergeDiff`, `reviewGate`, `publishGate` and `mergeGate` (`trident/build-run.ts:45`). Existing module outcome types are imported at `trident/build-run.ts:8`: leak statuses come from `trident/leak-preflight.ts:147`, diff policy from `trident/merge.ts:182`. Future extraction path assumptions were recorded in the lane progress log as build-gates.ts, review-gates.ts and publish-gates.ts. Those future modules are **not imported or implemented here**. Their real exports must be aligned before production wiring. This is a known deviation from the requested stub imports, avoiding invented module declarations that would falsely certify an integration.
- Required reviewGate responsibilities are panel provenance, cross-model seats, severity and arbiter rules; publishGate covers mutation proof/readiness; mergeGate covers CI, drift and pinned eligibility (`trident/build-run.ts:49`). The merge action must atomically enforce the supplied reviewed head (`trident/build-run.ts:195`). Tests supply fake gate callbacks (`trident/build-run.test.ts:28`); they prove ordering/refusal propagation, **not preservation of the extracted gates or atomicity of a real merge**.
- Repeated canonical finding identities stop at round three; the hard ceiling stops at five (`trident/build-run.ts:156`; test at `trident/build-run.test.ts:146`). The callback must provide stable finding/class identities, not display prose. A stop returns to the orchestrator for arbitration, without calling another model from the host loop.
- A leak fixer that changes the reviewed revision stops publication rather than silently reusing stale review (`trident/build-run.ts:173`; test at `trident/build-run.test.ts:177`). Re-admission after such a stop is outside this fresh-only slice.

### Outcome vocabulary and continuous enforcement

The driver joins the runtime's completed/blocked/refused/failed/unknown vocabulary (`runtime/bounded-work.ts:97`) with a public BuildRunOutcome union (`trident/build-run.ts:59`). Runtime unknown returns the same nonterminal category with step identity, while blocked has the literal orchestrator recipient (`trident/build-run.ts:83`, `trident/build-run.ts:125`). Runner refusal becomes an orchestrator block, explicit runner failure becomes failed, and host exceptions preserve uncertainty because a write may already have happened (`trident/build-run.ts:127`, `trident/build-run.ts:203`). The driver contains the consumer switch; a production caller must retain unknown and must not reap/re-fire its worker. No production caller is wired by this lane.

Failure causes reuse `built-head-unverified` and `workflow-threw` from the existing terminal vocabulary (`trident/terminal-cause.ts:131`, `trident/terminal-cause.ts:144`). Its parser defaults an unrecognized value to null (`trident/terminal-cause.ts:177`); this driver introduces no terminal-cause literals. Admission introduces typed unsupported reasons within BuildRunOutcome (`trident/build-run.ts:62`, `trident/build-run.ts:92`), not review verdicts.

The measurement invariant is maintained at each worker completion and each publication boundary by host reads, without requiring the worker to remain responsive (`trident/build-run.ts:131`, `trident/build-run.ts:178`, `trident/build-run.ts:192`). A host read that cannot establish state returns unknown. There is no liveness monitor in this slice; worker supervision belongs to the surrounding runtime contract.

### Verification

- `bun test trident/build-run.test.ts`: 58 passed, zero failed; only the assigned test file was run.
- `bunx tsc --noEmit -p trident/tsconfig.json`: passed on restored source.
- `bash scripts/ci/lint.sh`: passed.
- Repository typecheck status is recorded below after its final completion. No unrelated source or dependency files were changed to hide diagnostics.
- Mutation runs used one source mutation at a time, printed the actual landing line and a unified diff, then ran the same behavioral file. Every listed mutation caused an assertion failure; none was credited for a parse failure. Every restoration passed all 58 tests. The temporary mutation transcript is retained outside the repository for local review.

### Mutation table

Rows enumerate the executed mutations, not a claim of exhaustive branch coverage. Each source line is in `trident/build-run.ts`. The named red test belongs to `trident/build-run.test.ts`: trailer family at :70, runner outcomes :88, admission :105, gates :127, review outcomes :137, ceilings :146, unreadable measurements :156, review drift :163, leaks :169, publication :182, action acknowledgements :187, and gate drift :198.

| Guard / source line | Mutation | Red test | Restored |
| --- | --- | --- | --- |
| trust trailer — :75 | `true` | lying head trailer is caught before review — RED | 58 GREEN |
| trust PR trailer — :76 | `true` | lying pr trailer is caught before review — RED | 58 GREEN |
| runner unknown becomes failure — :125 | `case 'unknown': return { stop: failed(outcome.detail) }` | runner unknown retains its meaning and stops downstream work — RED | 58 GREEN |
| worker blocked routing — :83 | `recipient: 'owner' as 'orchestrator' })` | runner blocked retains its meaning and stops downstream work — RED | 58 GREEN |
| mode admission — :92 | `if (input.mode === 'pr')` | fresh to merged with a fix, host gates and fake runners — RED | 58 GREEN |
| resume admission — :96 | `if (input.start === 'fresh')` | fresh to merged with a fix, host gates and fake runners — RED | 58 GREEN |
| future capability admission — :101 | `if (support.ok === false && false)` | admission refuses resume and unavailable future fix capability — RED | 58 GREEN |
| existing PR admission — :110 | `if (snapshot.pr !== null && false)` | existing PR refuses fresh admission — RED | 58 GREEN |
| gate blocked routing — :87 | `if (gate.kind === 'blocked') return null` | admissionGate blocked cannot reach merge — RED | 58 GREEN |
| gate unknown routing — :88 | `if (gate.kind === 'unknown') return null` | admissionGate unknown cannot reach merge — RED | 58 GREEN |
| initial measurement unknown — :108 | `if (initial.kind === 'unknown') return failed(initial.detail)` | unreadable host measurement 1 preserves uncertainty — RED | 58 GREEN |
| worker measurement unknown — :132 | `if (observation.kind === 'unknown') return { stop: failed(observation.detail) }` | unreadable host measurement 3 preserves uncertainty — RED | 58 GREEN |
| review subject — :136 | `if (role === 'review' && false &&` | review cannot change its subject even with a matching trailer — RED | 58 GREEN |
| review blocked — :153 | `if (decision.kind === 'blocked') return failed(decision.on)` | review blocked cannot publish — RED | 58 GREEN |
| review unknown — :154 | `if (decision.kind === 'unknown') return failed(decision.detail)` | review unknown cannot publish — RED | 58 GREEN |
| repeat ceiling — :156 | `round >= 4 && decision.findings` | round three repeats stop; five rounds stop even with distinct findings — RED | 58 GREEN |
| absolute ceiling — :156 | `round >= 6 \|\|` | round three repeats stop; five rounds stop even with distinct findings — RED | 58 GREEN |
| leak status — :169 | `if (false && leak.status !== 'clean' && leak.status !== 'fixed')` | leak incomplete cannot publish — RED | 58 GREEN |
| post leak revision — :173 | `if (false)` | leak fixer moving the head requires new review — RED | 58 GREEN |
| diff gate — :175 | `if (!diff.allow && false)` | oversized diff stops publication — RED | 58 GREEN |
| publish gate result — :177 | `if (publishGate && false) return publishGate` | publishGate unknown cannot reach merge — RED | 58 GREEN |
| merge gate result — :191 | `if (mergeGate && false) return mergeGate` | mergeGate unknown cannot reach merge — RED | 58 GREEN |
| pre publish drift — :180 | `if (false)` | publishGate revision drift is detected before write — RED | 58 GREEN |
| pre merge drift — :194 | `if (false)` | mergeGate revision drift is detected before write — RED | 58 GREEN |
| published PR — :187 | `if (false)` | publish acknowledgement without measured effect is blocked — RED | 58 GREEN |
| merged PR — :199 | `if (false)` | merge acknowledgement without measured effect is blocked — RED | 58 GREEN |
| publishObservation unknown — :171 | `publishObservation unknown returns failed` | unreadable host measurement 5 preserves uncertainty — RED | 58 GREEN |
| beforePublish unknown — :179 | `beforePublish unknown returns failed` | unreadable host measurement 6 preserves uncertainty — RED | 58 GREEN |
| published unknown — :185 | `published unknown returns failed` | unreadable host measurement 7 preserves uncertainty — RED | 58 GREEN |
| beforeMerge unknown — :193 | `beforeMerge unknown returns failed` | unreadable host measurement 8 preserves uncertainty — RED | 58 GREEN |
| merged unknown — :198 | `merged unknown returns failed` | unreadable host measurement 9 preserves uncertainty — RED | 58 GREEN |

### Deliberately outside this change

No Ralph, waves, mid-loop resume or bound-PR review-only execution: admission refuses those modes (`trident/build-run.ts:92`). No real process, pane, network, live PR, deployment or production caller was exercised. No gate extraction, runtime contract modification, legacy-loop removal or orchestrator wiring was attempted outside the two-file territory. Accordingly this commit is the independently tested driver slice, not a claim that the production execution layer has already been replaced. The lane-specific delivery instruction selects this shard path instead of the general docs/as-built location. No product decision changed.

### Repository check limitations

The repository matrix finished all 51 configurations and failed on untouched diagnostics: implicit app `@types` resolution (app config at `app/tsconfig.json:1`), the whisper mock at `gateway/transcription/__tests__/whisper-install.test.ts:186`, the process event callback at `logger/__tests__/fire-and-forget.test.ts:301`, and the crc32 import at `onboarding/history-import/__tests__/zip-writer.ts:10`. The matrix also sampled a temporary capability mutation at `trident/build-run.ts:101` because it overlapped the mutation runs. That temporary diagnostic is not a final-source failure: after all mutations were restored, the separate Trident project typecheck exited zero. The full matrix is not claimed green. Lint and the final 58-test focused run are green.
