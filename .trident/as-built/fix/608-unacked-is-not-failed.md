## 2026-09-14 — Keep unacknowledged chat delivery pending (#608)

### Change and evidence

A missing acknowledgement is unknown delivery, not evidence of failure. Both
render models now explicitly name pending (unknown), failed (rejected/errored),
and acknowledged (delivered/read): app/lib/chat-core/chat-render-model.ts:351 and
landing/chat-react/controller.ts:59. Queued and socket-accepted sends render
pending; explicit failures retain the warning; acknowledgements retain delivery
and read receipts (app/lib/chat-core/chat-render-model.ts:366,
landing/chat-react/controller.ts:2142).

Removed both session acknowledgement deadlines, their options, and the exported
constant. Flushes now notify views without arming a failure writer
(chat-core/web-session.ts:697, app/lib/chat-core/mobile-session.ts:552).
The web context carries DeliveryState instead of a failure boolean
(landing/chat-react/ChatApp.tsx:438); its indicator renders the clock, warning
with retry, or acknowledged ticks (landing/chat-react/DeliveryIndicator.tsx:9).

The filed mobile timeout citation was actually :617-622 before editing (filed
:614-624); the web mapping was :2140-2154 (filed :2136). The filed mobile mapping
:369-373 and web retry label :446-460 matched the checked-out source. Restoring
those original files during mutation testing reached both old timeout writers.

### Vocabulary and consumer audit

This reuses DeliveryState's pending/failed/delivered/read values and removes its
misleading socket-only sent rung. The durable SendStatus vocabulary remains
queued/sent/failed/acked (chat-core/types.ts:114). No schema migration or new
error outcome was introduced. The merge rank still lets acknowledgement beat
failure (chat-core/store.ts:377). A socket throw remains queued for retry,
rather than becoming a definite rejection (chat-core/send-queue.ts:94).

Consumers were enumerated with
`rg -n 'DeliveryState|deliveryState\(|deliveryGlyph\(|deliveryFor\(|\.delivery|latestUserDelivery' app landing chat-core --glob '*.ts' --glob '*.tsx'`.
For the chat-delivery matches:

- Mobile mapping returns pending for queued/sent, failed for failure, and
  delivered/read for acknowledgement (app/lib/chat-core/chat-render-model.ts:366).
  The glyph switch handles each member explicitly (:408).
- Mobile bubbles preserve the latest-message visibility policy, always expose
  failures, and use the normal glyph branch for pending and acknowledged states;
  only read receives the read color (app/components/ChatSyncSurface.tsx:1060,
  :1222, :1238).
- Web mapping retains pending/failed before the acknowledged receipt fallback
  (landing/chat-react/controller.ts:2142). Render equality compares delivery
  (:463), latest-user delivery copies it (:2071), and view equality compares it
  (:438), so pending is handled by ordinary equality and copying.
- Web indexing includes every non-null outbound delivery state
  (landing/chat-react/ChatApp.tsx:458). Missing context/state renders nothing
  (:450); otherwise DeliveryIndicator branches on failure and defaults to the
  pending or acknowledged label/glyph (landing/chat-react/DeliveryIndicator.tsx:9,
  :17). Pending never exposes retry.

The continuous mechanism is removal of the timer writer, not a callback that
requires a responsive server. The client retains uncertainty indefinitely;
reconnect still drains unacknowledged rows (chat-core/send-queue.ts:134), and
inbound echo application still notifies views (chat-core/web-session.ts:503,
app/lib/chat-core/mobile-session.ts:465). The regression tests fail if the old
writers return.

Positive-control audit:
`rg -n 'onAckTimeout|ackTimeoutMs|DEFAULT_ACK_TIMEOUT_MS|resumeAndFlush' app/lib/chat-core/mobile-session.ts chat-core/web-session.ts chat-core/index.ts`
finds the known resumeAndFlush implementation at mobile :489 and web :632,
but none of the removed deadline identifiers in these files. This is a working
tree claim, not a claim about a fetched ref; the lane is explicitly offline.

### Acceptance and tests

- Unknown delivery survives 60 seconds beyond socket acceptance, then reconciles
  after reconnect: chat-core/__tests__/resilience.test.ts:404 and
  app/__tests__/chat-core-mobile-session.test.ts:697. The mobile fixture uses the
  SQLite store and asserts the pending glyph (:703).
- Each of sent/pending, failed/failed and acked/delivered is asserted in the web
  controller (landing/chat-react/__tests__/controller.test.ts:1728) and indicator
  markup (landing/chat-react/__tests__/delivery-indicator.test.tsx:9).
- Mobile render tests retain explicit failure, receipt, and glyph controls
  (app/__tests__/chat-core-render-model.test.ts:151).
- Full browser composition shows the pending clock and a late echo's delivered
  ticks (landing/chat-react/__tests__/component.test.tsx:143, :246).

The old tests explicitly required timeout failure; those assertions prescribed
this defect and were replaced with exact sent/pending assertions. No assertion
was broadened to accept both outcomes, and explicit failure controls remain.

### Mutation table

Each mutation printed its actual changed line, ran the named tests red, then
restored the implementation and ran green. Original-line references in the first
row refer to the restored pre-change files; other references are current.

| Guard/property | Mutation and printed location | Red | Restored green |
|---|---|---|---|
| Silence cannot write failure | Restore old timeout writers, chat-core/web-session.ts:789 and app/lib/chat-core/mobile-session.ts:621 | 2 failures | 43 tests in resilience + mobile-session |
| Mobile unknown remains pending | Return failed at app/lib/chat-core/chat-render-model.ts:369 | 2 failures | 26 render-model tests |
| Mobile failure remains failure | Return pending at app/lib/chat-core/chat-render-model.ts:371 | 1 failure | 26 render-model tests |
| Mobile acknowledgement delivers | Return pending at app/lib/chat-core/chat-render-model.ts:374 | 2 failures | 26 render-model tests |
| Web unknown remains pending | Return failed at landing/chat-react/controller.ts:2145 | 2 failures | 72 controller + indicator tests |
| Web failure remains failure | Return pending at landing/chat-react/controller.ts:2147 | 2 failures | 72 controller + indicator tests |
| Web acknowledgement delivers | Return pending at landing/chat-react/controller.ts:2154 | 1 failure | 3 indicator tests |
| Only failure gets retry | Invert branch at landing/chat-react/DeliveryIndicator.tsx:9 | 2 failures | 3 indicator tests |
| Pending reaches the browser bubble | Index only failures at landing/chat-react/ChatApp.tsx:458 | 1 failure | 20 component tests |

### Validation

The seven touched non-DOM test files passed together: 174 tests. The touched
browser component file passed separately: 20 tests. Repository lint passed.
`bash scripts/ci/typecheck-all.sh` passed all 51 configurations.
`bash scripts/ci/lint.sh` passed. `git diff --check` passed.

Exact focused test commands (the touched-test inventory comes from the change
diff plus the newly added indicator test):

```sh
bun test app/__tests__/chat-core-mobile-session.test.ts app/__tests__/chat-core-render-model.test.ts app/__tests__/chat-core-sqlite-store.test.ts chat-core/__tests__/resilience.test.ts chat-core/__tests__/web-session.test.ts landing/chat-react/__tests__/controller.test.ts landing/chat-react/__tests__/delivery-indicator.test.tsx
bun test landing/chat-react/__tests__/component.test.tsx
```

The public-tree leak gate reported zero findings from rules that ran, but exited
incomplete because the private PII denylist was unavailable. This is not a clean
leak-gate result; the orchestrator must run the private rules before publication.

### Decisions and limits

Deleted the old acknowledgement timer path rather than adding an option or
retaining two behaviors. Kept the durable statuses and their merge precedence;
reclassifying historical failed rows without cause metadata could hide a real
failure (chat-core/types.ts:128, chat-core/store.ts:377). Such old rows can still
render failed until a server echo reconciles them. This change prevents new
false timeout failures; it does not infer historical rejection provenance.

No server scheduling, dispatch doctrine, retry identity, or transport liveness
redesign was attempted. The issue's separate long-running-work dispatch proposal
is outside this fix. SPEC.md's product decisions were not changed.

Searched the tree for `ack.timeout`, `sent.*failed`, and `✓ sent`, with the
SendStatus union as positive control. Corrected live comments and the two W5
planning documents. Historical frozen as-built descriptions stay as records of
what shipped then, including docs/AS_BUILT.md and
docs/research/AS-BUILT-archive-2026-07.md:5756. Unrelated task outcomes and send
retry/merge descriptions remain because they do not equate silence with failure.

This single shard uses the lane's explicitly requested .trident/as-built branch
path, overriding the standard docs/as-built location. No parallel record was
created. No push, PR creation, or merge is part of this lane's delivery.
