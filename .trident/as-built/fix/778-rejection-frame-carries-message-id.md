## 2026-09-14 — Correlate explicit message rejection and reach failed delivery

### Change and decision

Issue #778 implements the supplied option 1. `message_rejected` joins the
`AppWsOutbound` union with a required `client_msg_id`, code and readable reason
(`wire-types/app-ws-envelope.ts:326`, `:694`). The validation refusal emits it
only for a user-message frame with a valid correlation ID
(`gateway/http/app-ws-surface.ts:1181`). Ingestion and dispatch errors stay generic:
persist/echo precedes dispatch (`gateway/http/app-ws-surface.ts:1211`, `:1277`).
An exception there cannot establish that the send was rejected.

`SendQueue.rejectFrame` validates the frame, looks up the exact topic/ID, and
writes failed only for a matching unacknowledged row
(`chat-core/send-queue.ts:191`). Unknown or already acknowledged IDs return
`unmatched_rejection`; malformed rejection frames return `invalid_rejection`
(`chat-core/send-queue.ts:198`, `:203`). Those outcomes join the existing error
code vocabulary: the web error handler renders arbitrary codes/messages as a
notice (`landing/chat-react/controller.ts:1297`). Mobile now folds error text into
its visible notice pill (`app/lib/chat-core/chat-render-model.ts:237`,
`app/lib/chat-core/use-mobile-chat.ts:358`, `app/components/ChatSyncSurface.tsx:1336`).
This also corrects the web comment claiming current mobile already showed error
bubbles; the mounted test exposed that gap.

Web and mobile retain separate session implementations, each invoking the
shared rejection operation (`chat-core/web-session.ts:383`,
`app/lib/chat-core/mobile-session.ts:359`). Interception precedes ordinary inbound
normalization, whose default rejects non-message kinds
(`chat-core/types.ts:581`). New errors therefore cannot fall through that default
unnoticed. Acknowledgements remain authoritative through the existing status
rank and store merge (`chat-core/store.ts:148`, `:377`); later echoes are born
acked (`chat-core/sync-engine.ts:85`). This mechanism is local to the receiver and
does not require the rejecting server to keep running. Lost frames remain
unknown. There is no timeout-based failure writer.

### Acceptance and consumer audit

Acceptance lives in `docs/spec-items/message-rejection-correlation.md`; its
index was regenerated. The supplied product decision did not change.

Enumeration used repository-wide `rg -n 'SendStatus' --glob '*.{ts,tsx}'`, then
followed `ChatMessage.status` through the stores, queue, both render models and
their UI bindings. Direct symbol hits: declaration and `ChatMessage` field
(`chat-core/types.ts:132`, `:155`), public export (`chat-core/index.ts:33`), and
web render-model import/field (`landing/chat-react/controller.ts:48`, `:96`).
For the structural consumers, ran
`rg -n "status.*(failed|acked|queued|sent)|(failed|acked|queued|sent).*status"`
over `chat-core`, `app/lib/chat-core`, the web controller and mobile surface,
excluding tests. Positive controls in that same search include the queued write
at `chat-core/send-queue.ts:87` and acked write at `chat-core/sync-engine.ts:85`.
Followed render-state bindings with `rg -n 'DeliveryIndicator|onRetry'` across
both client trees. The complete consumer behavior found by this enumeration:

| Consumer | Behavior for reachable failed |
|---|---|
| Queue, `chat-core/send-queue.ts:101`, `:134`, `:170` | Normal flush only drains queued; reconnect and per-message retry resend failed. Retry retains the established rejection until an echo resolves it; socket failure does not create rejection. |
| Shared merge/in-memory store, `chat-core/store.ts:148`, `:377`, `:503`, `:518` | Failed outranks sent and loses to acked; excluded from queued count; preserved by acknowledged-history reset. |
| OPFS, `chat-core/stores/opfs-store.ts:98`, `:107`, `:133`, `:147`, `:182` | Delegates status behavior to in-memory store; snapshots full rows. |
| SQLite, `app/lib/chat-core/sqlite-store.ts:369`, `:443`, `:460`, `:733` | Shared merge, queued-only count, acked-only reset, explicit failed decode; unknown stored values default to queued. Native adapter selects this store or in-memory (`app/lib/chat-core/op-sqlite-store.ts:68`). |
| Sync engine, `chat-core/sync-engine.ts:85` | Echo advances failed to acked through store merge. |
| Sessions, `chat-core/web-session.ts:340`, `app/lib/chat-core/mobile-session.ts:252` | Retry delegates the selected ID to flushOne and refreshes the view. Rejection refreshes both views at the locations above. |
| Web model/UI, `landing/chat-react/controller.ts:1967`, `:2141`; `landing/chat-react/DeliveryIndicator.tsx:9`; `landing/chat-react/ChatApp.tsx:451`, `:2584` | Failed maps to warning/retry; sent stays pending. Button invokes controller retry using the render ID, which is the client message ID. |
| Mobile model/UI, `app/lib/chat-core/chat-render-model.ts:372`, `:418`; `app/components/ChatSyncSurface.tsx:1222` | Failed maps to warning and tappable retry; sent/queued stay pending; acked shows delivered/read. |

The web controller's other failed branch is import-job status, not SendStatus
(`landing/chat-react/controller.ts:1342`). The explicit-rejection wording sweep
used `rg -n 'explicit rejection or send error|rejected/errored|NO CLIENT PATH PRODUCES|what would make it reachable|SendStatus'`
across both clients and chat-core: obsolete claims were removed, while the
SendStatus hits above are positive controls. A separate queued/sent sweep
updated reset/reconnect comments to include reachable failed sends.

### Tests and mutation proof

All 258 targeted tests passed across these 12 files (enumerated from the explicit
runner arguments, never a whole-suite run):

- `chat-core/__tests__/send-queue.test.ts`
- `landing/chat-react/__tests__/controller.test.ts`
- `app/__tests__/imessage-chat-ux.test.tsx`
- `gateway/__tests__/app-ws-rejection.test.ts`
- `chat-core/__tests__/web-session.test.ts`
- `chat-core/__tests__/resilience.test.ts`
- `chat-core/__tests__/store.test.ts`
- `app/__tests__/chat-core-mobile-session.test.ts`
- `app/__tests__/chat-core-sqlite-store.test.ts`
- `app/__tests__/chat-core-render-model.test.ts`
- `landing/chat-react/__tests__/delivery-indicator.test.tsx`
- `scripts/__tests__/spec-items-index.test.ts`

The mobile mounted test drives the real session and taps the rendered warning,
asserting that only the rejected ID is resent, a sibling remains pending, and
unknown/stale IDs show a notice (`app/__tests__/imessage-chat-ux.test.tsx:597`).
The web test drives the real session/controller, including generic error,
explicit rejection, retry, unknown ID and late echo
(`landing/chat-react/__tests__/controller.test.ts:1775`). Existing independent
virtual-clock tests retain pending past the former deadline on both platforms
(`chat-core/__tests__/resilience.test.ts:408`,
`app/__tests__/chat-core-mobile-session.test.ts:698`).

Each mutation below ran alone, printed the actual altered source line, failed
with exit 1, then was restored and passed with exit 0. Queue mutations use the
explicit-rejection test; web uses its new integration test; mobile uses its new
mounted test; server uses its new direct-handler test.

| Guard / path and line | Mutation | Mutated | Restored |
|---|---|---|---|
| object shape, `chat-core/send-queue.ts:194` | `// mutation: removed guard` | RED (1) | GREEN (0) |
| explicit frame kind, `chat-core/send-queue.ts:196` | `// mutation: removed guard` | RED (1) | GREEN (0) |
| wire schema, `chat-core/send-queue.ts:198` | `if (false) {` | RED (1) | GREEN (0) |
| unknown id, `chat-core/send-queue.ts:203` | `if (msg.status === 'acked') {` | RED (1) | GREEN (0) |
| stale id, `chat-core/send-queue.ts:203` | `if (msg === null) {` | RED (1) | GREEN (0) |
| failure writer, `chat-core/send-queue.ts:206` | `await this.store.upsert({ ...msg, status: 'sent' })` | RED (1) | GREEN (0) |
| web dispatch, `chat-core/web-session.ts:383` | `const rejection = null` | RED (1) | GREEN (0) |
| mobile dispatch, `app/lib/chat-core/mobile-session.ts:359` | `const rejection = null` | RED (1) | GREEN (0) |
| mobile notice, `app/lib/chat-core/chat-render-model.ts:237` | `if (false) {` | RED (1) | GREEN (0) |
| mobile retry callback, `app/components/ChatSyncSurface.tsx:1227` | `onPress={() => {}}` | RED (1) | GREEN (0) |
| server correlation, `gateway/http/app-ws-surface.ts:1190` | `type: 'error',` | RED (1) | GREEN (0) |
| server frame kind, `gateway/http/app-ws-surface.ts:1185` | `const correlated = true &&` | RED (1) | GREEN (0) |
| server id bound, `gateway/http/app-ws-surface.ts:1186` | `typeof id === 'string' && id.length > 0` | RED (1) | GREEN (0) |
| queue version, `chat-core/send-queue.ts:198` | `if (typeof id !== 'string' \|\| id.length === 0 \|\| id.length > 128 \|\|` | RED (1) | GREEN (0) |
| queue id type, `chat-core/send-queue.ts:198` | `if (frame['v'] !== 1 \|\| id.length === 0 \|\| id.length > 128 \|\|` | RED (1) | GREEN (0) |
| queue empty id, `chat-core/send-queue.ts:198` | `if (frame['v'] !== 1 \|\| typeof id !== 'string' \|\| id.length > 128 \|\|` | RED (1) | GREEN (0) |
| queue id length, `chat-core/send-queue.ts:198` | `if (frame['v'] !== 1 \|\| typeof id !== 'string' \|\| id.length === 0 \|\|` | RED (1) | GREEN (0) |
| queue code type, `chat-core/send-queue.ts:199` | `typeof frame['message'] !== 'string') {` | RED (1) | GREEN (0) |
| queue message type, `chat-core/send-queue.ts:199` | `typeof frame['code'] !== 'string' \|\| false) {` | RED (1) | GREEN (0) |
| server empty id, `gateway/http/app-ws-surface.ts:1186` | `typeof id === 'string' && id.length <= 128` | RED (1) | GREEN (0) |
| server id type, `gateway/http/app-ws-surface.ts:1186` | `id.length > 0 && id.length <= 128` | RED (1) | GREEN (0) |

### Verification and deliberate limits

`bash scripts/ci/typecheck-all.sh`: all 51 configurations passed.
`bash scripts/ci/lint.sh`: passed. The typecheck matrix invokes tsc for each
discovered configuration (`scripts/ci/typecheck-all.sh:67`).
`git diff --check`: passed.

The existing socket server suite could not start: its `Bun.serve({port:0})`
fixture failed at `gateway/__tests__/app-ws-surface.test.ts:40`. No assertions were
weakened or skipped. The new server test instead invokes the real WebSocket
message handler and real adapter directly, proving correlated refusal, an
accepted retry, and a downstream error after echo that remains generic
(`gateway/__tests__/app-ws-rejection.test.ts:6`). A real socket round trip remains
for CI in an environment that can bind a port.

The leak gate reported zero findings from rules run, but INCOMPLETE because the
private PII denylist is unavailable; both file and message PII checks require
that credential. This is not a clean leak verdict. The final message will be
checked again after the local commit.

Did not turn ingest/dispatch exceptions into delivery rejection, introduce an
ack timer, change the status rank, change reconnect retry policy, retire failed,
change native dependencies, push, open a PR or merge. No Expo APIs changed;
the module's external documentation prerequisite could not be fetched under the
explicit offline instruction. The task-specific record location overrides the
repository's usual docs/as-built location; this is the single record.
