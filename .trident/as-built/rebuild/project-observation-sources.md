## 2026-09-15 — Project review observation sources

### Change and acquisition

The composition now supplies the three certified observation interfaces at
`trident/project-build-host.ts:99`. It creates one production CI acquisition
object and shares it with production effects and review adapters
(`trident/project-build-host.ts:80`). The suite configuration enters through
`ProjectBuildHostOptions.policy.reviewSuite` (`trident/project-build-host.ts:36`).

| Source | Acquisition and classification | Failure answer |
| --- | --- | --- |
| Readiness | Existing `ProductionCiSource.required` and `.readiness` (`trident/production-host-effects.ts:37`), called at `trident/project-observation-sources.ts:33`. Each named row uses the existing classifier (`trident/project-observation-sources.ts:46`); its app binding and skipped-row rules are at `trident/ci-readiness.ts:51`. | Missing workflow/PR/head, cancellation, unreadable configuration/rows, changed head and exceptions return `unknown` with detail (`trident/project-observation-sources.ts:30`, `trident/project-observation-sources.ts:37`, `trident/project-observation-sources.ts:54`). |
| CI | Reacquires through readiness, then uses the certified readiness classifier (`trident/project-observation-sources.ts:59`). Preserves named failures at `trident/project-observation-sources.ts:66`. | Unreadable or unsettled evidence returns `unknown` (`trident/project-observation-sources.ts:60`). Base evidence is explicitly `null`, so branch failures receive no advisory exemption (`trident/gates/review-ci.ts:31`). |
| Suite | Explicit host strategy, dispatched scope and independent checkpoint reader (`trident/project-observation-sources.ts:12`). Reads the record and checks run/head/round on each observation (`trident/project-observation-sources.ts:74`). | Missing input, missing record, identity mismatch or read exception returns `unknown` (`trident/project-observation-sources.ts:73`). Report claims remain available to the certified suite gate (`trident/project-observation-sources.ts:77`, `trident/gates/review-suite.ts:39`). |

The production `observeCi` summary cannot supply names: its union contains a
conclusion without check rows (`trident/ci-readiness.ts:6`). Using the underlying
acquisition avoids creating another credentialed acquisition implementation.
The default acquisition reads configuration at `trident/production-host-effects.ts:66`
and PR rows at `trident/production-host-effects.ts:115`.

### Missing acquisition and launcher handoff

The next composition caller must supply the suite strategy, actual dispatched
scope, and a reader returning the independently recorded build/fix report with
run/head/round identity (`trident/project-observation-sources.ts:12`). A missing
reader does not establish a clean suite (`trident/project-observation-sources.ts:73`).
The existing driver checkpoint writes head, stage, round and findings
(`trident/build-run.ts:364`); production persists that checkpoint
(`trident/production-host-effects.ts:239`). Neither write supplies the required
suite report. This scoped absence was checked with a positive control:

```sh
rg -n 'baseHead|readiness\(pr|suiteOutcome|suiteEvidence|saveCheckpoint|recordStageEvent' trident/production-host-effects.ts trident/build-run.ts
```

The search found `readiness`, `saveCheckpoint` and `recordStageEvent` at
`trident/production-host-effects.ts:39`, `trident/production-host-effects.ts:239`,
`trident/production-host-effects.ts:423` and `trident/build-run.ts:267`, but no
suite fields or `baseHead`. The acquisition interface takes a PR number, not a
pinned-base commit (`trident/production-host-effects.ts:39`); its base-side
check reads retain names only (`trident/production-host-effects.ts:55`). We
therefore supply no invented base-failure comparison (`trident/project-observation-sources.ts:66`).
A PR-less snapshot also remains unknown for these CI adapters
(`trident/project-observation-sources.ts:32`).

### Vocabulary and continuous enforcement

These sources join the existing `unknown` observation vocabulary. Readiness
propagates unknown through the host gate (`trident/gates/review-readiness.ts:92`);
CI and suite assessments propagate it at `trident/gates/review-ci.ts:23` and
`trident/gates/review-suite.ts:35`. The driver stops the review on those outcomes
(`trident/build-run.ts:443`). Named CI failures become actionable findings when
base evidence is unavailable (`trident/gates/review-ci.ts:33`). Suite reports
remain untrusted claims classified by `trident/gates/review-suite.ts:41`.

Fresh acquisition maintains the observation boundary on each call
(`trident/project-observation-sources.ts:33`, `trident/project-observation-sources.ts:74`).
The driver checks CI before and after review work (`trident/build-run.ts:450`,
`trident/build-run.ts:459`). The existing host watchdog races a hung readiness
observer and aborts independently of that observer cooperating
(`trident/gates/review-readiness.ts:78`, `trident/gates/review-readiness.ts:86`).
The adapters add no budget or retry policy.

### Driver proof and mutations

The production-composition test starts from a persisted built checkpoint and
runs the real driver, gates and project panel source, with fake host commands
and worker transports (`trident/project-build-host.test.ts:274`). It asserts a
panel transport was called, including the driver outcome in the failure message
(`trident/project-build-host.test.ts:314`). Its PR-mode setup is explicit
(`trident/project-build-host.test.ts:277`). It stops at the fake panel refusal;
this is not a live-service or merge test.

All 19 mutations below compiled with `bunx tsc -p trident/tsconfig.json --noEmit`,
ran and gave a wrong answer. Each was restored before a separate green test run.
Enumeration: all 16 `return unknown(...)` branches in the new module, plus each
of the three composition properties. The actual changed line was printed after
writing each mutation. An initial explicit-undefined wiring attempt failed
TypeScript's exact optional-property check and is excluded from this evidence;
the successful wiring mutations omit the property.

Permissive substitutions retain the original condition/catch and replace its
return with:

- **R:** known matching head, resolved required `['test']`, mergeable, named `test` passed.
- **C:** known matching head, status `green`, failing `[]`, base `null`.
- **S:** known matching run/head/round, strategy `''`, scope `full-suite`, report `null`.

Test references in the table are all in `trident/project-build-host.test.ts`:
**R** is line 216 (failed readiness acquisition), **C** is line 241 (CI evidence),
**S** is line 255 (suite acquisition), **P** is line 274 (driver reaches panel).
The suite identity assertion calls the source directly at line 262, so the
certified gate's duplicate identity check cannot mask that mutation.

| Guard / changed line | Mutation | Test | Mutated / restored |
| --- | --- | --- | --- |
| Cancelled before acquisition: `trident/project-observation-sources.ts:30` | R | R | RED / GREEN |
| Missing workflow: `trident/project-observation-sources.ts:31` | R | R | RED / GREEN |
| Missing PR or full head: `trident/project-observation-sources.ts:32` | R | R | RED / GREEN |
| Cancelled during acquisition: `trident/project-observation-sources.ts:36` | R | R | RED / GREEN |
| Unreadable configuration: `trident/project-observation-sources.ts:37` | R | R | RED / GREEN |
| Unreadable PR readiness: `trident/project-observation-sources.ts:38` | R | R | RED / GREEN |
| Mismatched head: `trident/project-observation-sources.ts:39` | R | R | RED / GREEN |
| Malformed mergeability or rows: `trident/project-observation-sources.ts:40` | R | R | RED / GREEN |
| Malformed named row: `trident/project-observation-sources.ts:47` | R | R | RED / GREEN |
| Readiness exception: `trident/project-observation-sources.ts:54` | R | R | RED / GREEN |
| Unknown CI evidence: `trident/project-observation-sources.ts:60` | C | C | RED / GREEN |
| Unsettled CI: `trident/project-observation-sources.ts:62` | C | C | RED / GREEN |
| Missing suite configuration/reader: `trident/project-observation-sources.ts:73` | S | S | RED / GREEN |
| Missing suite record: `trident/project-observation-sources.ts:75` | S | S | RED / GREEN |
| Suite record identity mismatch: `trident/project-observation-sources.ts:76` | S | S | RED / GREEN |
| Suite read exception: `trident/project-observation-sources.ts:78` | S | S | RED / GREEN |
| reviewReadiness: `trident/project-build-host.ts:99` | Omit property (`...{},`) | P | RED / GREEN |
| reviewCi: `trident/project-build-host.ts:100` | Omit property (`...{},`) | P | RED / GREEN |
| reviewSuite: `trident/project-build-host.ts:101` | Omit property (`...{},`) | P | RED / GREEN |

Removing readiness produced "Review readiness observation source is missing";
removing CI produced "Review CI observation source is missing"; removing suite
produced "Review suite observation source is missing". Each failed the panel-call
assertion (`trident/project-build-host.test.ts:314`).

### Validation and deliberate limits

- `bun test trident/project-build-host.test.ts trident/production-host-effects.test.ts trident/gates/`: **144 pass, 0 fail**, 744 assertions across 15 files.
- `bunx tsc -p trident/tsconfig.json --noEmit`: exit 0.
- `bash scripts/ci/lint.sh`: exit 0.
- No test assertions were weakened. The initial driver fixture was corrected to PR mode after its local-mode default exercised local merge readiness instead (`trident/project-build-host.test.ts:277`).

This change does not wire the launcher, implement suite checkpoint persistence,
acquire pinned-base failure evidence, alter certified gates or change product
policy. The suite reader is an explicit remaining integration requirement, not
an implicit clean default (`trident/project-observation-sources.ts:73`). The
as-built path follows this lane's explicit delivery instruction.
