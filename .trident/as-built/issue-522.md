## Issue 522 — twice-daily email brief

### Built

The existing five-minute email poll now checks owner-local 10:00 and 15:00 windows and sends one Gmail message per window (`cores/free/email/src/digest.ts:12`, `cores/free/email/src/digest.ts:46`, `gateway/cores/email-pipeline-wiring.ts:143`). Brief content is grouped by the stored category, includes Gmail thread links, accepts identity-bound LLM summaries, and falls back to stored snippets (`cores/free/email/src/digest.ts:29`, `cores/free/email/src/digest.ts:61`). A delivered brief and its included messages are committed together in the sidecar, and the delivered row is the per-window dedup gate (`cores/free/email/src/pipeline/store.ts:408`, `cores/free/email/src/digest.ts:57`).

The product setting is an additive `instance_metadata.email_digest_enabled` value whose absent/NULL default is enabled (`migrations/0151_instance_email_digest_enabled.sql:1`, `gateway/storage/owner-metadata.ts:67`). The authenticated GET/PUT surface validates a boolean (`gateway/http/email-digest-settings-surface.ts:9`, `gateway/http/email-digest-settings-surface.ts:17`), and the Settings screen reads and changes it (`app/app/settings.tsx:66`, `app/app/settings.tsx:489`). The poll reads the setting and timezone on every tick, so changes do not need a restart (`gateway/cores/email-pipeline-wiring.ts:143`).

The pre-cutover composition explicitly holds Gmail label/archive writes while retaining reads, classification, escalation, queuing, and email-brief delivery (`open/composer.ts:6800`, `gateway/cores/email-pipeline-wiring.ts:135`, `gateway/cores/email-pipeline-wiring.ts:143`). The invariant is maintained at the single `applyMutation` seam and the retry enumerator also stays dormant (`cores/free/email/src/pipeline/poller.ts:733`, `cores/free/email/src/pipeline/poller.ts:766`); it does not depend on Gmail refusing writes.

The rehearsal mode is now selected by the real Open composition instead of being hard-coded into the reusable cron handler (`open/composer.ts:6800`, `gateway/cores/email-pipeline-wiring.ts:135`). This preserves the production write hold while restoring the handler's existing enabled default, so a mutation-only recovery increments `remutated` and joins the handler's existing `ok` accounting rather than being reported as a no-op (`cores/free/email/src/pipeline/poller.ts:280`, `cores/free/email/src/pipeline/poller.ts:772`, `gateway/cores/email-pipeline-wiring.ts:161`).

### Decisions

The new digest outcomes join the cron handler vocabulary: `delivered` makes the existing cron result `ok`; disabled, not-due, already-delivered, and no-recipient fall through to the existing `skipped` default when the poll itself did no work (`gateway/cores/email-pipeline-wiring.ts:160`, `gateway/cores/email-pipeline-wiring.ts:162`). Delivery uses `GmailClient.sendMessage` directly and has no chat sink parameter, preserving chat/push for the existing escalation path (`cores/free/email/src/digest.ts:46`, `gateway/cores/email-pipeline-wiring.ts:125`). The first enabled mailbox with a known address is the delivery address, matching the multi-account client's existing primary-account write rule (`cores/free/email/src/digest.ts:58`, `cores/free/email/src/multi-account.ts:45`).

### Mutation evidence

| Guard | Mutation | Red | Restored green |
|---|---|---|---|
| Setting on/off (`digest.ts:54`) | inverted enabled condition | digest send + off tests both failed | digest test: 3 pass |
| Per-window delivered gate (`digest.ts:57`) | forced condition false | second-send assertion failed | digest test: 3 pass |
| Owner timezone (`digest.ts:14`) | replaced zone with UTC | DST boundary assertion failed | digest test: 3 pass |
| Settings input guard (`email-digest-settings-surface.ts:17`) | inverted boolean check | valid PUT assertion failed | surface test: 1 pass |
| Rehearsal write hold (`poller.ts:738`) | inverted hold condition | no-mailbox-write assertion failed with two writes | poller rehearsal test: 1 pass |
| Exact Open composition inventory (`open-composition-fields-characterization.test.ts:85`) | removed `app_email_digest_surface` declaration | exact-key assertion failed with the live extra field | characterization test: 1 pass |
| Served route-slot classification (`route-slot-coverage-inventory.ts:242`) | removed the complete `app-email-digest` row | classifier failed with the live rung unclassified | route coverage: 5 pass |
| Exhaustive migration ledger (`migrations/runner.test.ts:217`; `migrations/__tests__/live-ledger-125-repair.test.ts:93`; `migrations/__tests__/live-ledger-125-repair.test.ts:177`) | omitted ordinal 151 from all three expectations | all three assertions failed with received `+ 151` | focused migration files: 26 pass |
| Tick write-mode seam (`email-pipeline-wiring.ts:135`; production pin `open/composer.ts:6800`) | forced every handler to `held_back`; separately removed the production holdback | mutation-only recovery failed with `remutated=0`; production wiring expected `held_back` but received `undefined` | both targeted tests: 1 pass each |

### Validation

The assigned collision resolution moved the digest migration to 0151 (`migrations/0151_instance_email_digest_enabled.sql:1`). The exhaustive migration expectations preserve main's 0145 and 0147–0150 entries in ordinal order and append 0151 (`migrations/runner.test.ts:212`, `migrations/runner.test.ts:217`, `migrations/__tests__/live-ledger-125-repair.test.ts:93`, `migrations/__tests__/live-ledger-125-repair.test.ts:177`). The regenerated schema contains both main's model-provider fields and the digest field in migration order (`migrations/expected-schema.txt:989`). Omitting 0151 from all three expectations was observed RED in exactly three assertions; restoring it made the two focused migration files GREEN with 26 tests.

Focused tests passed: 108 tests across the digest, pipeline poller, settings surface, route-slot ratchet, composition-field coverage, settings reachability, and migration snapshot. ESLint passed for every changed TypeScript/TSX file. The email, gateway, open, and root TypeScript projects passed. The repository typecheck matrix checked all 51 projects but failed only at `app/tsconfig.json` because this install cannot resolve the implicit `@types` type library; the app source was still linted and its settings reachability test passed.

The inventory follow-up's original and inventory-focused command passed 87 tests across six files. The surrounding `open/__tests__` run enumerated 875 tests across 117 files: 784 passed and 91 failed, primarily where the restricted build environment refuses loopback listeners, plus one memory-index timeout; both inventory files passed within that run. The rerun typecheck matrix again checked all 51 projects, passing 50 and retaining only the same `app/tsconfig.json` implicit-type-library failure. Repository lint passed.

The migration-collision follow-up passed all 211 migration tests across 25 files, including `migrations/__tests__/live-ledger-125-repair.test.ts` at 4/4. The original five changed test files passed 82 tests, and `open/__tests__/route-slot-coverage.test.ts` passed 5/5. Repository lint passed. The typecheck matrix checked all 51 projects with 50 passing and only the same environment-specific `app/tsconfig.json` implicit-type-library failure.

The tick-accounting follow-up passed 126 tests across the email pipeline wiring suite and every original touched test. The full migration directory passed, and the surrounding `gateway/cores/__tests__` directory passed 135 tests across 16 files. Repository lint passed. The typecheck matrix checked all 51 projects with 50 passing and retained only the already-recorded `app/tsconfig.json` implicit-type-library failure. The public-tree scan found zero violations in every rule it could run; its local PII rule remained unavailable because the external denylist is not present in this build environment.

### Mainline merge resolution

The five conflicted files were enumerated from Git's unmerged status. In `app/app/settings.tsx`, the digest client and toggle state were retained beside main's theme runtime hook (`app/app/settings.tsx:66`, `app/app/settings.tsx:82`), and the current themed Settings structure still contains the email control (`app/app/settings.tsx:489`). In `open/composer.ts`, the owner-metadata import now contains both the digest accessors and main's model-provider initializer (`open/composer.ts:452`), while the production composition retains the rehearsal read and write-hold additions (`open/composer.ts:6795`). In the two migration tests, the resolution unions every mainline ordinal with 0151 in sorted order (`migrations/runner.test.ts:209`, `migrations/__tests__/live-ledger-125-repair.test.ts:93`, `migrations/__tests__/live-ledger-125-repair.test.ts:177`). The schema resolution retains both column families in application order and was verified by regeneration (`migrations/expected-schema.txt:989`).

The resolved five files were also diffed against the pre-merge tip, which exposed the non-conflicting mainline hunks. Those hunks were read rather than accepted from marker absence: main's theme imports and hook remain beside the digest state (`app/app/settings.tsx:46`, `app/app/settings.tsx:82`), and main's provider initializer remains beside the digest metadata accessors (`open/composer.ts:455`). A second diff against `origin/main` showed the branch-owned email surface, rehearsal wiring, 0151 migration, schema column, and three applied-list additions as the remaining branch delta (`open/composer.ts:466`, `open/composer.ts:6797`, `migrations/0151_instance_email_digest_enabled.sql:1`, `migrations/expected-schema.txt:990`, `migrations/runner.test.ts:217`).

After the merge, the eight specifically enumerated test files passed 111 tests. The restored migration-only run passed 26 tests. `bash scripts/ci/typecheck-all.sh` checked all 51 TypeScript projects and passed; `bash scripts/ci/lint.sh` passed every reported gate.

### Deliberately not done

No chat digest path, second scheduler, hardcoded UTC schedule, or feature flag was added. Mailbox mutations remain held back for the comparison period; enabling those writes is a cutover decision outside this issue's `cutover: false` specification.

The regression assertion was not loosened: a handler that performs mutation recovery must still report `ok`, while the real Open composition continues to hold mailbox writes during rehearsal (`gateway/cores/__tests__/email-pipeline-wiring.test.ts:344`, `open/__tests__/open-email-pipeline-wiring.test.ts:101`).
