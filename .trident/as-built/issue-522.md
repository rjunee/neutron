## Issue 522 — twice-daily email brief

### Built

The existing five-minute email poll now checks owner-local 10:00 and 15:00 windows and sends one Gmail message per window (`cores/free/email/src/digest.ts:12`, `cores/free/email/src/digest.ts:46`, `gateway/cores/email-pipeline-wiring.ts:141`). Brief content is grouped by the stored category, includes Gmail thread links, accepts identity-bound LLM summaries, and falls back to stored snippets (`cores/free/email/src/digest.ts:29`, `cores/free/email/src/digest.ts:61`). A delivered brief and its included messages are committed together in the sidecar, and the delivered row is the per-window dedup gate (`cores/free/email/src/pipeline/store.ts:379`, `cores/free/email/src/digest.ts:57`).

The product setting is an additive `instance_metadata.email_digest_enabled` value whose absent/NULL default is enabled (`migrations/0145_instance_email_digest_enabled.sql:1`, `gateway/storage/owner-metadata.ts:66`). The authenticated GET/PUT surface validates a boolean (`gateway/http/email-digest-settings-surface.ts:9`, `gateway/http/email-digest-settings-surface.ts:17`), and the Settings screen reads and changes it (`app/app/settings.tsx:65`, `app/app/settings.tsx:465`). The poll reads the setting and timezone on every tick, so changes do not need a restart (`gateway/cores/email-pipeline-wiring.ts:141`).

The pre-cutover composition explicitly holds Gmail label/archive writes while retaining reads, classification, escalation, queuing, and email-brief delivery (`gateway/cores/email-pipeline-wiring.ts:111`, `gateway/cores/email-pipeline-wiring.ts:133`, `cores/free/email/src/pipeline/poller.ts:738`). The invariant is maintained at the single `applyMutation` seam and the retry enumerator also stays dormant (`cores/free/email/src/pipeline/poller.ts:733`, `cores/free/email/src/pipeline/poller.ts:766`); it does not depend on Gmail refusing writes.

### Decisions

The new digest outcomes join the cron handler vocabulary: `delivered` makes the existing cron result `ok`; disabled, not-due, already-delivered, and no-recipient fall through to the existing `skipped` default when the poll itself did no work (`gateway/cores/email-pipeline-wiring.ts:154`). Delivery uses `GmailClient.sendMessage` directly and has no chat sink parameter, preserving chat/push for the existing escalation path (`cores/free/email/src/digest.ts:46`, `gateway/cores/email-pipeline-wiring.ts:125`). The first enabled mailbox with a known address is the delivery address, matching the multi-account client's existing primary-account write rule (`cores/free/email/src/digest.ts:58`, `cores/free/email/src/multi-account.ts:45`).

### Mutation evidence

| Guard | Mutation | Red | Restored green |
|---|---|---|---|
| Setting on/off (`digest.ts:54`) | inverted enabled condition | digest send + off tests both failed | digest test: 3 pass |
| Per-window delivered gate (`digest.ts:57`) | forced condition false | second-send assertion failed | digest test: 3 pass |
| Owner timezone (`digest.ts:14`) | replaced zone with UTC | DST boundary assertion failed | digest test: 3 pass |
| Settings input guard (`email-digest-settings-surface.ts:17`) | inverted boolean check | valid PUT assertion failed | surface test: 1 pass |
| Rehearsal write hold (`poller.ts:738`) | inverted hold condition | no-mailbox-write assertion failed with two writes | poller rehearsal test: 1 pass |

### Validation

Focused tests passed: 108 tests across the digest, pipeline poller, settings surface, route-slot ratchet, composition-field coverage, settings reachability, and migration snapshot. ESLint passed for every changed TypeScript/TSX file. The email, gateway, open, and root TypeScript projects passed. The repository typecheck matrix checked all 51 projects but failed only at `app/tsconfig.json` because this install cannot resolve the implicit `@types` type library; the app source was still linted and its settings reachability test passed.

### Deliberately not done

No chat digest path, second scheduler, hardcoded UTC schedule, or feature flag was added. Mailbox mutations remain held back for the comparison period; enabling those writes is a cutover decision outside this issue's `cutover: false` specification.
