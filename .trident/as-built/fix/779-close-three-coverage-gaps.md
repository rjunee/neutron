## 2026-09-14 — Close three message-delivery coverage gaps (#779)

### What changed

The web reconnect fixture now advances its virtual clock after the second
socket has resent the unacknowledged message and requires the durable row to
remain `sent` (chat-core/__tests__/resilience.test.ts:421,
chat-core/__tests__/resilience.test.ts:428). The matching mobile fixture makes
the same post-reconnect assertion and also checks the render vocabulary remains
`pending` (app/__tests__/chat-core-mobile-session.test.ts:713,
app/__tests__/chat-core-mobile-session.test.ts:719). Together these cover the
independent reconnect drains at chat-core/web-session.ts:658 and
app/lib/chat-core/mobile-session.ts:512, not only the initial send drains.

The device-shaped surface test now creates a persisted failed row, makes the
mounted hook reload it, presses the labelled retry control, and requires a
second outbound frame with the original body and idempotency key
(app/__tests__/mobile-chat-send-on-device.test.tsx:147,
app/__tests__/mobile-chat-send-on-device.test.tsx:183). This exercises the real
failed branch rendered at app/components/ChatSyncSurface.tsx:1222 and the real
interaction path rather than asserting only a source string.

The test runner now reads its aggregate results only when the file exists. A
missing file is expected when the current shard owns zero files, while a missing
file with a nonzero assignment is a loud fatal exit
(scripts/run-tests.sh:756, scripts/run-tests.sh:772). The zero-assignment fixture
requires the audit and pass lines while rejecting both the shell diagnostic and
the real missing-results fatal (scripts/run-tests-selftest.test.ts:137,
scripts/run-tests-selftest.test.ts:145).

### Decisions and maintained invariants

The reconnect coverage was added to both independently implemented clients;
sharing only the web assertion would leave the mobile copy unguarded. The
continuous mechanism is the focused regression suite in CI: it observes durable
state after each reconnect drain and does not depend on the remote peer
answering.

The UI test uses the mounted surface and accessibility-labelled press because
the property is an affordance, not merely text. It also checks the retry reuses
the original identity, so a replacement inert label cannot satisfy it
(app/__tests__/mobile-chat-send-on-device.test.tsx:183,
app/__tests__/mobile-chat-send-on-device.test.tsx:186).

The runner's new nonzero missing-results outcome joins its existing `FATAL`
vocabulary and exits 1 immediately (scripts/run-tests.sh:772). Expected empty
work remains in the ordinary audit vocabulary and finishes as 0/0 PASS; the
test pins both distinctions (scripts/run-tests-selftest.test.ts:145).
Suppressing stderr was deliberately rejected because it would collapse expected
empty work and a broken nonempty execution into the same output.

No feature flag, alternate runtime path, or delivery-state value was added.
`SPEC.md` and the filed product decisions were unchanged because this change
strengthens tests and runner diagnostics without changing product behavior.

### Mutation table

| Guard | Mutation and printed landing line | Red | Restored green |
|---|---|---|---|
| Web reconnect remains unknown | Added a reconnect `failed` writer at chat-core/web-session.ts:662 | chat-core/__tests__/resilience.test.ts:430 received `failed` | 12/12 |
| Mobile reconnect remains unknown | Added a reachable reconnect `failed` writer at app/lib/chat-core/mobile-session.ts:516 | app/__tests__/chat-core-mobile-session.test.ts:722 received `failed` | targeted 1/1 |
| Mobile retry is reachable | Disabled the failed render branch at app/components/ChatSyncSurface.tsx:1222 | app/__tests__/mobile-chat-send-on-device.test.tsx:183 could not find the labelled control | targeted 1/1 |
| Empty shard has no false diagnostic | Restored the direct read at scripts/run-tests.sh:770 | scripts/run-tests-selftest.test.ts:147 received the shell missing-file diagnostic | targeted 1/1 |

Each mutation's changed line and diff were printed before its red run. An
initial mobile mutation referenced already-removed timer infrastructure and
failed before the target assertion; that result was discarded and replaced by
the reachable writer recorded above.

### Validation

The touched-test inventory was enumerated from `git diff --name-only` and all
four changed test files passed together: 63 tests. `bun run typecheck` was not a
repository command and correctly reported that the script does not exist; the
repository checks `bash scripts/ci/typecheck-all.sh` passed all 51 TypeScript
configurations and `bash scripts/ci/lint.sh` passed every lint gate.
`git diff --check` passed.

### Deliberately not changed

The unused `latestUserDelivery` field mentioned in the brief was left alone
because it is explicitly outside the three requested gaps. No production
message-delivery behavior was changed. No whole-suite run was attempted, per the
lane instruction to run only the specific touched tests. No push, PR creation,
or merge is part of this build-lane delivery.
