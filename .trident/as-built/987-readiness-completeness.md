## #987 — Restore review readiness completeness evidence

### Change and decisions

The supplier now reads PR identity and mergeability, then acquires check runs and
classic statuses at that exact head (`trident/production-host-effects.ts:115-132`).
Each list needs a safe integral `total_count` equal to its array length; failure,
timeout, invalid JSON, missing arrays and invalid counts yield incomplete evidence
(`trident/production-host-effects.ts:121-128`). Zero with an empty array is valid.
Both lists must be complete before rows are released; partial rows are discarded
(`trident/production-host-effects.ts:134-136`). This also prevents consumers of the
shared supplier from classifying a usable-looking prefix.

`checksComplete` carries that witness through the source contract
(`trident/production-host-effects.ts:39`), row adapter
(`trident/project-observation-sources.ts:53`) and observation type
(`trident/gates/review-readiness.ts:11-12`). An omitted witness remains incomplete;
the optional field permits injected sources to express that lack of evidence,
without a fallback to array length (`trident/gates/review-readiness.ts:46`).
The injected complete fixture was updated at `trident/build-host.test.ts:35`.

Incomplete lists join the existing `pending` vocabulary at
`trident/gates/review-readiness.ts:46`. Its existing default is to wait and probe
again, while `unknown` and `blocked` return immediately
(`trident/gates/review-readiness.ts:94-99`). The witness therefore cannot turn an
incomplete list into a check failure or refusal. Independent configuration,
revision and conflict checks retain their precedence
(`trident/gates/review-readiness.ts:33-38`). Malformed PR identities use the existing
`unreadable` supplier outcome (`trident/production-host-effects.ts:118`), which the
adapter maps to `unknown` (`trident/project-observation-sources.ts:38`).

The existing base producer parser and null-on-incomplete fast-fail exemption stay
in place (`trident/production-host-effects.ts:55-60`,
`trident/production-host-effects.ts:107-110`). The configuration-error inference
requires non-null produced evidence (`trident/ci-readiness.ts:58-59`). This change
adds no new configuration-fault inference.

Every observation reacquires and validates both lists; maintenance of the witness
is host-owned (`trident/production-host-effects.ts:121-136`). A hung acquisition
remains bounded by the host watchdog, independently of observer cooperation
(`trident/gates/review-readiness.ts:77-85`).

### Tests and mutations

Every mutation below compiled with `bunx tsc -p trident/tsconfig.json --noEmit` and
then produced a wrong-answer assertion failure. Mutated lines were printed before
execution. Every guard was restored before final validation.

| Guard | Mutation and landed line | Red evidence | Restored |
| --- | --- | --- | --- |
| Predicate completeness | Remove guard, trident/gates/review-readiness.ts:46 | Required-name prefix passed instead of pending, trident/gates/review-readiness.test.ts:90 | Green |
| Waiting asymmetry | Return blocked, trident/gates/review-readiness.ts:46 | Zero waits instead of one, trident/gates/review-readiness.test.ts:101 | Green |
| Integral count | Fall back to array length, trident/production-host-effects.ts:126-127 | Fractional count accepted, trident/production-host-effects.test.ts:927 | Green |
| Matching count | Replace equality with true, trident/production-host-effects.ts:127 | Truncated list accepted, trident/production-host-effects.test.ts:927 | Green |
| Successful list read | Remove refusal, trident/production-host-effects.ts:124 | Failed read with valid payload accepted, trident/production-host-effects.test.ts:951 | Green |
| Pinned probe identity | Remove head validation, trident/production-host-effects.ts:118 | Invalid head addressed probes, trident/production-host-effects.test.ts:967 | Green |

Count cases enumerate both endpoints and
valid, truncated, negative, fractional, string, null and missing counts
(`trident/production-host-effects.test.ts:918-928`). Failed reads preserve valid
payloads to ensure reachability of the read-success mutation
(`trident/production-host-effects.test.ts:945-946`). Adapter propagation is tested
in `trident/project-build-host.test.ts:319-325`.

### Deliberate limits

The probes request one page of 100 rows per endpoint; pagination is future work
(`trident/production-host-effects.ts:131-132`). Larger responses remain pending
through the incomplete witness, not a configuration failure
(`trident/production-host-effects.ts:134-136`,
`trident/gates/review-readiness.ts:46`). Live service behavior was not exercised in
this offline lane. Pinned-base advisory acquisition remains outside this change
(`trident/project-observation-sources.ts:64-65`). No product decision changed.

### Final validation

- `bun test trident/gates/ trident/project-build-host.test.ts trident/production-host-effects.test.ts trident/build-host.test.ts`: 195 passed, zero failed, 15 files. The extra explicit file validates the adjusted injected fixture.
- `bunx tsc -p trident/tsconfig.json --noEmit`: passed, including both required mutations and all four supplier mutations.
- Changed-file `bunx eslint`: passed on the seven TypeScript files enumerated by `git diff --name-only`.
- `git diff --check`: passed. The record contains exactly one second-level heading.

The replaced contract comment was searched across the tree with
`rg -n 'Must acquire complete configuration and check rows|Acquire configuration and revision' --glob '*.ts' --glob '*.md' .`.
Only the updated contract matched, at `trident/gates/review-readiness.ts:23`;
that match is the positive control for the old sentence's absence.
