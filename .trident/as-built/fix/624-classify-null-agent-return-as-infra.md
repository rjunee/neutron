## Issue 624 — classify a null build-agent return as infrastructure

### What changed

The round-one build dispatch now turns a null return into an error stamped with the existing
`infra-only` block class at the point where the workflow knows that no build arrived
(`trident/inner-workflow.mjs:8249-8255`). The terminal catch reads only that structured value
and carries it into the persisted failure result (`trident/inner-workflow.mjs:9214-9217`,
`trident/inner-workflow.mjs:9223-9247`). A change to the human-readable message therefore
cannot change the outcome class.

### Existing vocabulary and default cost

No new outcome kind was added. The outer classifier's complete vocabulary is
`infrastructure | genuine` (`trident/orchestrator.ts:987-988`). A non-approval carrying a
non-empty `infra-only` cause is infrastructure (`trident/orchestrator.ts:1019-1026`), while an
unclassified value falls through to `genuine` (`trident/orchestrator.ts:1036`). Only the
infrastructure member enters the durable retry claim and schedules the next dispatch
(`trident/orchestrator.ts:5130-5177`); that default was the defect.

The invariant is maintained at both ends without depending on the failed build agent: the
workflow itself stamps the error before throwing (`trident/inner-workflow.mjs:8249-8255`), and
the workflow catch copies the class into the terminal result (`trident/inner-workflow.mjs:9214-9247`).

### Tests and mutations

The executable workflow fixture makes the real build dispatch return null, proves no review
seat runs, checks the structured class, overwrites the message, and runs the production
classifier (`trident/__tests__/cross-model-dispatch.test.ts:765-780`). The retry fixture feeds
that structured result through the production tick loop, observes one durable retry, advances
the backoff clock, and observes a second dispatch (`trident/infra-retry.test.ts:124-145`). Its
complement drives a findings-carrying code rejection and proves it terminates with zero
infrastructure retries (`trident/infra-retry.test.ts:176-201`).

| Guard | Mutation | Mutated result | Restored result |
|---|---|---|---|
| null return stamp at `trident/inner-workflow.mjs:8254` | `infra-only` to `code`; landing line and diff printed before the run | null-build test red: expected `infra-only`, received no class | focused files green, 71 pass |
| conservative classifier default at `trident/orchestrator.ts:1036` | `genuine` to `infrastructure`; landing line and diff printed before the run | ordinary-failure test red: expected terminal `failed`, received retry phase | focused files green, 71 pass |

Final verification: `bun test trident/__tests__/cross-model-dispatch.test.ts
trident/infra-retry.test.ts` passed 71 tests; `bash scripts/ci/typecheck-all.sh` passed all 51
TypeScript configurations; `bash scripts/ci/lint.sh` passed every reported gate; and
`git diff --check` passed.

### The guard this change had to narrow, and the direction it had to add

`trident/__tests__/ci-gate.test.ts` already pinned the throw path's terminal literal with
`expect(failure).not.toContain('blockKind:')` — "a crash measured no such thing". A stamped
throw violates that assertion literally, and the first cut of this change left it in place,
so the PR was red on its own CI shard. The property the assertion was defending is narrower
than the sentence it was written as: what must never happen is this CATCH asserting a kind
about an exit it did not measure. The guard now pins exactly that — no quoted kind inside
the literal, the conditional spread as the ONE way a kind leaves, and the derivation line
itself — and each of the three is mutation-proven red.

The complement was also missing entirely: nothing anywhere failed when the terminal catch
was mutated to stamp `infra-only` on EVERY throw. Measured, not assumed —
`const thrownBlockKind = 'infra-only'` over the whole `trident/` suite produced no failure
beyond the one already red. That direction is the expensive one: it would hand a genuine
crash (a build committed on the wrong branch, a refused resume) to the infrastructure
auto-retry to replay. It is now driven end to end on the wrong-branch fixture
(`trident/__tests__/cross-model-dispatch.test.ts`, 'a build reported on the WRONG BRANCH…'),
which asserts `terminalCauseKind: 'workflow-threw'`, no `blockKind`, and `genuine` out of
the production classifier.

The null-build case also now runs the classifier on the AS-PRODUCED result before rewording
it. `classifyInnerFailure` needs the class AND a cause that survives redaction with
something left to read, so a stamp riding on an empty `terminalCause` would still classify
`genuine`; asserting only a substituted sentence could not see that.

### Decisions and deliberate exclusions

The change stamps the existing block class instead of adding a message token to the closed
word list, because classification must survive rewording. It does not widen other thrown
workflow errors: errors without the explicit stamp still omit `blockKind` and retain the
classifier's `genuine` default (`trident/inner-workflow.mjs:9214-9247`,
`trident/orchestrator.ts:1036`). No feature flag or parallel path was added. No product decision
changed, so `SPEC.md` was not edited.
