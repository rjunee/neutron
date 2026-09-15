## Issue 521 — classification setup from an inbox survey

### What changed

The Email Core now exposes a bounded classification survey that reads one inbox window and derives proposal identity, category, sender membership, and owner-facing questions from the observed domain and message shape (`cores/free/email/src/pipeline/setup.ts:59-107`). Completing the interview validates every answer before writing sender rules and commits the full answer set in one SQLite transaction (`cores/free/email/src/pipeline/setup.ts:109-152`). The public barrel and package subpath expose this setup surface (`cores/free/email/index.ts:190-198`, `cores/free/email/package.json:19-24`).

Setup refusals join the Core's existing code-stamped error vocabulary through `ClassificationSetupError`; callers that do not recognize a new code retain the generic error behavior rather than continuing setup (`cores/free/email/src/errors.ts:128-144`). Owner actions join the existing `SenderRuleHandling` vocabulary: `escalate` maps to `escalate`, while `brief` and `ignore` map to the existing non-escalating `archive` handling (`cores/free/email/src/pipeline/setup.ts:139-148`). The classifier already consumes that handling before deterministic importance patterns, so an ignored class remains non-important on its next classification (`cores/free/email/src/pipeline/classify.ts:171-216`).

### Decisions

The survey is capped at 100 messages and refuses invalid limits, truncated merged results, or any failed mailbox read; an incomplete observation is not represented as an empty successful survey (`cores/free/email/src/pipeline/setup.ts:14`, `cores/free/email/src/pipeline/setup.ts:64-76`). Classes are grouped by sender domain plus observable message shape, while the resulting rules name the sampled senders exactly (`cores/free/email/src/pipeline/setup.ts:39-57`, `cores/free/email/src/pipeline/setup.ts:78-107`, `cores/free/email/src/pipeline/setup.ts:139-149`). This keeps the mechanism generic and the resulting sender data in the instance database.

The complete-answer invariant is maintained continuously by pre-write cardinality and identity checks, and the all-or-nothing persistence invariant is maintained by SQLite itself, so rollback does not depend on the caller surviving the failed write (`cores/free/email/src/pipeline/setup.ts:115-152`).

### Evidence and mutation table

Focused behavior tests cover different samples producing different classes, fresh empty-store setup, an ignored answer reaching the live classifier, incomplete and malformed interviews, incomplete survey reads, and transaction rollback (`cores/free/email/__tests__/pipeline-setup.test.ts:17-141`). The production migration enumeration used `CREATE TABLE IF NOT EXISTS sender_rules|INSERT INTO sender_rules[^\\n]*VALUES`: the positive control matched `cores/free/email/migrations-pipeline/0001_email_pipeline.sql:122`; no seed insertion matched.

| Guard | Mutation | Red evidence | Restored evidence |
|---|---|---|---|
| proposal category derives from the sample | returned `fixed-class` at `setup.ts:56` | different-samples test rejected `fixed-class` | focused suite green |
| ignore stays non-escalating | mapped `ignore` to `escalate` at `setup.ts:142` | fresh-instance/ignore test rejected persisted handling | focused suite green |
| every proposal needs one answer | inverted cardinality check at `setup.ts:132` | incomplete-interview test red | focused suite green |
| unknown and duplicate answers are refused | disabled each identity check at `setup.ts:118` and `setup.ts:124` | malformed-answer test red for each mutation | focused suite green |
| invalid and incomplete surveys are refused | disabled the limit and completeness checks at `setup.ts:64` and `setup.ts:71` | unreadable-or-invalid test red for each mutation | focused suite green |
| answer writes are atomic | removed the transaction at `setup.ts:152` | rollback test observed the first persisted rule | focused suite green |
| setup-file registry membership | removed the `setup.ts` registry row at `identity-env-readers-registry.test.ts:278` | identity-reader suite named `cores/free/email/src/pipeline/setup.ts` in both failing assertions | identity-reader suite green after restoration |

The first fixed-category mutation did not initially red because the test asserted proposal IDs and whole-proposal inequality but not the derived category field. Exact category assertions were added at `cores/free/email/__tests__/pipeline-setup.test.ts:24-25`; the same mutation then reddened the test before restoration.

Final validation: `bun test cores/free/email/__tests__/pipeline-setup.test.ts cores/free/email/__tests__/pipeline-classify.test.ts cores/free/email/__tests__/pipeline-store.test.ts` passed 39 tests; the surrounding `bun test cores/free/email/__tests__` run passed 298 tests across 28 files; and `bun test tests/integration/identity-env-readers-registry.test.ts` passed 21 tests. `bunx tsc --noEmit -p cores/free/email/tsconfig.json`, `bash scripts/ci/lint.sh`, and `git diff --check` passed. The repository has no `typecheck` or `lint` package script, so those `bun run` commands reported `Script not found`; the package-scoped TypeScript command and CI lint script above are the available equivalents. The leak gate found zero findings from its runnable checks but reported its local PII denylist unavailable, so it was incomplete rather than clean.

The identity-reader registry suite initially failed both membership assertions because the category sanitizer's broad regex at `cores/free/email/src/pipeline/setup.ts:54` matches the underscore in an identity-name candidate. The registry row at `tests/integration/identity-env-readers-registry.test.ts:278-279` records why that regex exists and explicitly does not claim an environment read. The environment-access search used `process\.env[^\n]*(NEUTRON_HOME|OWNER_HOME|NEUTRON_DB_PATH)|(NEUTRON_HOME|OWNER_HOME|NEUTRON_DB_PATH)[^\n]*process\.env` across the setup file and `scripts/email-accounts.ts`; its positive control matched `scripts/email-accounts.ts:64`, while the setup file had no match.

### Deliberately not changed

No rerun-on-drift flow or cross-mailbox rule merge was added because both are outside the item (`docs/plans/2026-08-06-email-core-consolidation-plan.md:558`). No default sender rules or owner-specific taxonomy was added; fresh-store emptiness remains covered at `cores/free/email/__tests__/pipeline-store.test.ts:58-61`. `SPEC.md` was not changed because this implementation does not alter a product decision recorded there.
