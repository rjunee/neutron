## 2026-09-19 — Draft authenticated native owner model and turn controls

This Open composition slice extends the shared-owner binding without changing
the frozen broker, factory, observer or helper. The inspected model HTTP draft
already has a newer merged successor in this tree; its authenticated route,
client error shape and phone/web model component are reused, not replaced.
Claude and General behavior retain their existing controls.

`open/wiring/codex-owner-controls.ts:97` obtains current model and the complete
bounded native catalog from the existing owner. Reads never start or resume a
session. A model switch requires the project/thread/binding-revision/generation/
epoch/turn conditional identity returned by that read, an idle owner and an
offered model. It sends only `thread/settings/update`, then verifies the same
native thread and selected model after acknowledgement. Uncertain mutation
fences subsequent reuse. `open/wiring/codex-owner-binding.ts:93` carries the
observed native model explicitly into the next turn under its captured epoch.

The protocol shapes were read from the installed native generated TypeScript
schema: `thread/read` exposes configured model and native identity;
`thread/settings/update` returns an empty acknowledgement, not model evidence.
There is no config-file write, new model process, topic-as-thread inference,
seed turn, or Claude fallback in these controls.

`gateway/http/app-native-owner-control-surface.ts:28` exposes authenticated
project-scoped GET/POST `repl-control` alongside the existing `repl-model` route.
Pending questions and active identity come only from the host-owned turn.
`open/wiring/codex-owner-controls.ts:162` uses that turn's original broker writer
for exact approval replies and interrupts. Stale project, thread, turn, binding
revision, generation and epoch are refused. Answers are consumed before sending;
uncertain delivery is fenced and never replayed. One-time command/file approval
decisions are limited to the native offered choices. Structured user answers
must match the exact question IDs. Session-wide permission amendments and
unimplemented permission/MCP answer shapes remain explicit refusals.

Native questions also use the durable same-project chat delivery seam at
`open/composer.ts:1119`, including questions emitted during build dispatch.
The informational substrate event alone would have reached only the Activity
Inspector, so it is not used as evidence of owner delivery. A failed durable
delivery fences the owner rather than silently hiding its question.

Evidence:

- The focused five-file controls/chat/build-wiring suite passes 68 tests.
  It covers current/list/switch in both directions, paginated discovery,
  unoffered models, cold-owner no-spawn, full credential-home marker checks,
  same-thread reuse, second-project isolation, stale approval/interrupt identity,
  one-shot replies, uncertain delivery and unchanged Claude controls.
  The consuming project-build E2E suite also passes all 88 admission, review,
  publication, retry and merge regressions.
- Real Open HTTP/WebSocket composition proves authenticated native route
  reachability, no-credential native chat with the Claude-null control, and a
  native question delivered with a durable sequence and correct project rail.
  The native model boundary is stubbed in those composition tests.
- The manual native smoke passed against the installed CLI and a loopback
  provider: model execution changes in both directions on the same thread,
  pre-switch chat/chat/build/chat continuity, isolated second project, actual
  command approval accept creates only the disposable file and native cancel
  leaves its separate file absent. A stale turn cannot answer the approval.
  Native switch maintenance may issue an old-model request before the owner
  turn; the check attributes execution to the completed turn, not a fixed HTTP
  request index. No owner credentials or live gateway processes are used.
- Semantic mutations bypassing identity checks, rejecting every identity and
  accepting an unconfirmed model switch fail the consuming tests. Restoring
  the implementation passes them. Root/Open TypeScript checks and changed-file
  lint pass. Added lines and commit metadata are privacy-checked separately;
  the earlier full-tree privacy failure is not claimed resolved here.

This is still a draft, not full cutover. Model selection uses the shipped web
and phone affordance; native approval/interrupt actions currently have an
authenticated API and durable question notice, not a new phone/web answer
widget or free-text answer interception. Unsupported question forms remain
pending until answered through a supported native surface or interrupted.
The native interrupt identity path is covered by consuming tests, not a native
interrupt smoke in this record. Cancellation or other uncertain terminal state
can require explicit owner reconciliation rather than permitting silent reuse.

Same-owner restart is not wired here. A future helper-backed composition must
use its awaited approval-reply and fresh-state reconciliation seams; a cached
broker state or fire-and-forget remote reply is not this local contract. Native
tool/prompt-policy integration and unattended live build acceptance also remain
outside this slice. No cutover acceptance box is closed.
