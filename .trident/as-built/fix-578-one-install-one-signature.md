## 2026-09-14 — one Skill Forge install has one signature

### What changed

The install signature now hashes normalized user intent together with the ordered normalized action shape; run artifacts remain outside the identity because they are outputs (`skill-forge/signature.ts:47-55`). Proposal creation now uses one transactional eligibility operation that refuses an already-active signature, any pending proposal, or any proposal created within the preceding 24 hours (`skill-forge/proposals-store.ts:91-115`). The workflow completion path uses that operation before notifying (`skill-forge/forge.ts:74-93`).

The regression proof uses two workflows with the same actions and different intents, obtains two proposals after the required interval, then reruns the first intent and obtains no third proposal (`skill-forge/__tests__/forge.test.ts:107-123`). Signature-level coverage also proves that artifact changes do not alter identity, intent changes do, and casing or whitespace changes do not (`skill-forge/__tests__/signature.test.ts:60-72`).

### Decisions

Intent is the stable discriminator because `CompletedWorkflow.intent` is the user-facing goal (`skill-forge/types.ts:33-40`), while artifacts are produced or touched outputs (`skill-forge/types.ts:41-45`). JSON encoding of the two signature components avoids ambiguous string boundaries (`skill-forge/signature.ts:52-55`).

The throttle is a rolling 24-hour window rather than a calendar-day boundary. Its three refusal predicates share the transaction that performs insertion (`skill-forge/proposals-store.ts:96-115`), so concurrent completion hooks cannot both pass eligibility; the concurrent-attempt test observes exactly one pending row (`skill-forge/__tests__/proposals-store.test.ts:103-110`). This transaction is the mechanism that continuously maintains the invariant and does not depend on either competing caller failing.

No new public outcome value was added. The new refusals join `SkillForge.onWorkflowCompleted`'s existing `ProposalRecord | null` vocabulary; `null` already means no proposal and the caller therefore sends no notification by default (`skill-forge/forge.ts:69-93`). A missing eligibility query result does not join that permissive result: it throws (`skill-forge/proposals-store.ts:108-111`), with a focused test for that distinction (`skill-forge/__tests__/proposals-store.test.ts:92-101`).

### Mutation table

| Guard | Mutation | Red result | Restored result |
|---|---|---|---|
| Intent participates in the hash (`skill-forge/signature.ts:54-55`) | Hashed step shape alone; printed mutated line 55 and its diff | Signature test failed at `skill-forge/__tests__/signature.test.ts:70`; workflow test failed at `skill-forge/__tests__/forge.test.ts:114` | Focused suite green |
| Active signature blocks creation (`skill-forge/proposals-store.ts:102`) | Added constant false to that predicate; printed mutated line 102 and its diff | Rerun created a third proposal, failing `skill-forge/__tests__/forge.test.ts:118` | Focused suite green |
| Pending proposal blocks creation (`skill-forge/proposals-store.ts:103`) | Changed pending status comparison to a non-status string; printed mutated line 103 and its diff | Isolated pending assertion failed at `skill-forge/__tests__/proposals-store.test.ts:80` | Focused suite green |
| Rolling-day throttle blocks creation (`skill-forge/proposals-store.ts:104`) | Disabled the timestamp predicate with constant false; printed mutated line 104 and its diff | Isolated daily assertion failed at `skill-forge/__tests__/proposals-store.test.ts:87` | Focused suite green |
| Missing query result throws (`skill-forge/proposals-store.ts:108-110`) | Inverted the null condition; printed mutated line 108 and its diff | Missing-result assertion failed at `skill-forge/__tests__/proposals-store.test.ts:98`; ordinary eligibility also failed | Focused suite green |
| Eligibility and insert are serialized (`skill-forge/proposals-store.ts:98-115`) | Replaced the database transaction with a direct async invocation; printed mutated lines 98-115 and their diff | Two concurrent proposals were created, failing `skill-forge/__tests__/proposals-store.test.ts:109` | Focused suite green |

### Verification

`bun test skill-forge/__tests__/signature.test.ts skill-forge/__tests__/proposals-store.test.ts skill-forge/__tests__/forge.test.ts`: 25 pass, 0 fail, 84 assertions. `bunx tsc -p skill-forge/tsconfig.json --noEmit` passed, and `skill-forge/tsconfig.json` also passed in the 51-configuration repository matrix. `bash scripts/ci/lint.sh` passed every reported gate.

The root package defines test commands but no `typecheck` script (`package.json:57-62`), so `bun run typecheck` correctly reported that the script was absent. The repository command is the matrix required by `CONTRIBUTING.md:79`. That matrix reported unrelated existing failures in the app, gateway, logger, onboarding, and root configurations; the affected Skill Forge configuration passed. The final focused typecheck and tests were rerun after restoration.

The leak gate reported zero findings from every rule it could run, but explicitly returned incomplete because its external PII denylist was unavailable; `scripts/ci/leak-gate.sh:857-871` defines that fail-closed result.

### Deliberately not changed

The historical migration remains unchanged: it records the schema and rationale at the time that table was introduced (`migrations/0086_skill_forge_proposals.sql:1-30`), while this lane is scoped to Skill Forge and its tests. `SPEC.md` was not changed because this repair implements the filed behavior without changing a product decision. The full test suite was not run, as required by the lane brief.
