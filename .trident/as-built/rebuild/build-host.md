## 2026-09-15 — Compose the build host from kept gates

### Change and scope

`createBuildHost` returns the driver dependencies and four-role worker map
(`trident/build-host.ts:40`). Runners are supplied explicitly by provider
(`trident/build-host.ts:17`); a missing or mis-keyed runner reports
`provider-not-connected` (`trident/build-host.ts:30`, `trident/build-host.ts:45`).
Placement uses `placementFor` for both capability checks and turns
(`trident/build-host.ts:46`, `runtime/bounded-work.ts:40`). The public export is
`trident/index.ts:218`.

The following callback inventory was enumerated from `BuildRunDeps` at
`trident/build-run.ts:42` and the returned object at `trident/build-host.ts:58`:

| Callback | Composition and evidence |
| --- | --- |
| prepareWork, measure, publish, merge | Required host effects supplied by the caller, with the driver's exact types; no successful fallback (`trident/build-host.ts:21`, `trident/build-host.ts:59`). |
| admissionGate | Re-read all four briefs and check the existing byte receipt (`trident/build-host.ts:62`, `trident/gates/brief-integrity.ts:2`). Complete project admission remains unknown (`trident/build-host.ts:69`). |
| runLeakGatePreflight | Existing preflight over the snapshot head, with correction attempts disabled after review (`trident/build-host.ts:71`). Exit code and sentinel classification remain in `trident/leak-preflight.ts:206`. |
| assessMergeDiff | Existing complete-diff byte policy (`trident/build-host.ts:72`, `trident/merge.ts:187`). |
| reviewGate | Existing trailer validation and severity filtering (`trident/build-host.ts:74`, `trident/gates/result-contract.ts:216`, `trident/gates/verdict.ts:37`). Panel provenance, cross-model seats and arbitration remain unknown (`trident/build-host.ts:78`). |
| publishGate | Existing mutation proof with the snapshot head required (`trident/build-host.ts:82`, `trident/mutation-prover.ts:4472`). Failed proof blocks; complete publication readiness remains unknown (`trident/build-host.ts:83`). |
| mergeGate | Existing pinned-head CI and base-drift assessment (`trident/build-host.ts:87`, `trident/ci-readiness.ts:18`, `trident/merge.ts:1170`). Unreadable drift is unknown and overlapping drift blocks (`trident/build-host.ts:91`, `trident/merge.ts:1267`). Atomic merge eligibility remains unknown (`trident/build-host.ts:93`). |

### Decisions and limits

This is a conservative composition, not an end-to-end runnable build host:
complete admission deliberately stops a driver run as unknown
(`trident/build-host.ts:69`, `trident/build-host.test.ts:109`). Partial gate tests
call callbacks directly so the admission stop cannot mask their coverage.
The supplied effects still require an integration owner to implement host
measurement, brief preparation and publication; this factory does not certify
those effects (`trident/build-host.ts:21`). The base reference and CI observation
are also host inputs (`trident/build-host.ts:23`, `trident/build-host.ts:26`).

No new product policy or spec decision was chosen. The existing bound-review
entry point requires a PR and panel execution (`trident/review-run.ts:37`,
`trident/review-run.ts:424`); it is not used as proof of this fresh build's panel.
The extracted built-head gate asks an agent to report a command result
(`trident/gates/built-head.ts:25`), so it is not substituted for the driver's
host measurement. The escalation extractor has re-plan/continue/stop outcomes
(`trident/gates/escalation.ts:141`); this change leaves loop control with the
driver's review decisions and round ceiling (`trident/build-run.ts:152`).
These are deliberate integration limits, not claims that those mechanisms are
absent elsewhere in the tree.

### Outcome vocabulary and continuous enforcement

All refusals use the existing worker refusal vocabulary; the driver's admission
loop maps unsupported workers to `refused/worker-unsupported`
(`trident/build-run.ts:98`). Gate `blocked` and `unknown` are handled explicitly
by `gateStop` (`trident/build-run.ts:86`); review has its corresponding explicit
branches (`trident/build-run.ts:153`). A non-clean leak result blocks publication
(`trident/build-run.ts:169`). Exceptions from host effects become unknown
(`trident/build-run.ts:203`). No new error class or fallback classification was
introduced.

The host executes these checks on each callback invocation, including a fresh
brief read and fresh CI/base observations (`trident/build-host.ts:65`,
`trident/build-host.ts:87`). The driver re-measures before external writes
(`trident/build-run.ts:178`, `trident/build-run.ts:192`), independently of the
worker's claims. This does not promise continuous polling outside a build run.

### Validation

`bun test trident/build-host.test.ts`: 12 passed, 40 assertions. Cases are
enumerated by the test declarations in that file, including the two provider
cases generated at `trident/build-host.test.ts:82`.

The root config's include list was inspected with
`rg -n '"trident/|"runtime/|"include"' tsconfig.json trident/tsconfig.json`.
The same search finds the positive control `runtime/**/*.ts` at
`tsconfig.json:16` and the explicit Trident include at `trident/tsconfig.json:3`.
Used `bunx tsc -p trident/tsconfig.json --noEmit` to cover this package;
the final run passed with exit 0 and no diagnostics.
An initial typecheck caught a readonly fixture assignment; fixed by replacing
the request object (`trident/build-host.test.ts:105`), without changing its assertion.

### Mutation evidence

Each row was run separately against the final host. The table records the actual
mutated source line printed during execution, the failing test, and a restored
12-test green run. All 20 mutations parsed and executed; failures were behavioral
assertions, not parse failures. Gate mutations use the permissive value from that
callback's existing vocabulary (`allow`, `approve`, or `clean`). The extra runner,
placement and head-pin mutations test the construction boundary. Each restoration
was verified before the next mutation. No mutation survived.

| Guard | Actual mutation location and line | RED test | Restored |
| --- | --- | --- | --- |
| missing runner support | `trident/build-host.ts:33: supports: () => ({ ok: true }),` | missing provider is refused by the driver before effects; mis-keyed provider is refused without falling back | GREEN, 12 tests |
| missing runner execution | `trident/build-host.ts:34: run: async () => ({ kind: 'unknown', detail: 'mutated' }),` | missing provider is refused by the driver before effects | GREEN, 12 tests |
| provider identity | `trident/build-host.ts:45: const runner = supplied ? supplied : unavailableRunner(selected.provider)` | mis-keyed provider is refused without falling back | GREEN, 12 tests |
| placement | `trident/build-host.ts:46: const placement = 'headless' as const` | placement follows project provider for pi | GREEN, 12 tests |
| brief integrity | `trident/build-host.ts:67: if (briefIntegrity(text) !== brief.integrity) return { kind: 'allow' }` | brief integrity blocks changed bytes including the fix brief | GREEN, 12 tests |
| unreadable brief | `trident/build-host.ts:66: catch { return { kind: 'allow' } }` | unreadable admission and complete admission policy stay unknown | GREEN, 12 tests |
| admission policy | `trident/build-host.ts:69: return { kind: 'allow' }` | unreadable admission and complete admission policy stay unknown | GREEN, 12 tests |
| leak preflight | `trident/build-host.ts:71: runLeakGatePreflight: async (snapshot) => ({ status: 'clean', head: snapshot.head, attempts: 0, findings: [], skipped_rules: [], note: 'mutated' }),` | leak preflight preserves incomplete and clean outcomes at snapshot head | GREEN, 12 tests |
| diff size | `trident/build-host.ts:72: assessMergeDiff: (diff) => ({ allow: true, measured_bytes: Buffer.byteLength(diff) }),` | complete diff size gate blocks oversized bytes | GREEN, 12 tests |
| review validation | `trident/build-host.ts:75: if (!checked.ok) return { kind: 'approve' }` | malformed review stays unknown and blocking severity blocks | GREEN, 12 tests |
| review severity | `trident/build-host.ts:77: if (findings && findings.length > 0) return { kind: 'approve' }` | malformed review stays unknown and blocking severity blocks | GREEN, 12 tests |
| review provenance | `trident/build-host.ts:78: return { kind: 'approve' }` | malformed review stays unknown and blocking severity blocks | GREEN, 12 tests |
| mutation proof | `trident/build-host.ts:83: if (!proof.ok) return { kind: 'allow' }` | mutation proof blocks missing nomination and pins the reviewed head | GREEN, 12 tests |
| mutation head binding | `trident/build-host.ts:82: const proof = await runMutationProofGate({ ...options.mutation, claim })` | mutation proof blocks missing nomination and pins the reviewed head | GREEN, 12 tests |
| publication readiness | `trident/build-host.ts:84: return { kind: 'allow' }` | mutation proof blocks missing nomination and pins the reviewed head | GREEN, 12 tests |
| CI unreadable | `trident/build-host.ts:88: if (ci.kind === 'cannot-read') return { kind: 'allow' }` | CI unreadable stays unknown; red, absent, running and wrong head block | GREEN, 12 tests |
| CI non-green | `trident/build-host.ts:89: if (ci.kind !== 'green') return { kind: 'allow' }` | CI unreadable stays unknown; red, absent, running and wrong head block | GREEN, 12 tests |
| base drift unreadable | `trident/build-host.ts:91: if (!drift.assessable) return { kind: 'allow' }` | base drift preserves uncertainty and blocks overlapping changes | GREEN, 12 tests |
| base drift overlap | `trident/build-host.ts:92: if (shouldHoldForBaseDrift(drift, new Set(), { hold_when_unassessable: true })) return { kind: 'allow' }` | base drift preserves uncertainty and blocks overlapping changes | GREEN, 12 tests |
| merge eligibility | `trident/build-host.ts:93: return { kind: 'allow' }` | CI unreadable stays unknown; red, absent, running and wrong head block; base drift preserves uncertainty and blocks overlapping changes | GREEN, 12 tests |

### Deliberately outside this change

No launcher removal, alternate control loop, runner implementation, deployment,
push, PR creation or merge. The lane instruction chooses this record path over
the standard documentation shard location. Only the two new host files, this
record and the barrel export are staged for the local commit.
