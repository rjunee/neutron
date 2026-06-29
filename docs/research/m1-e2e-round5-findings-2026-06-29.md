# M1 Adversarial E2E — Round 5 (overnight convergence) — Findings

Date: 2026-06-29 · Base: `main` @ bed9a64 · Method: 4 parallel hunters —
3 adversarial code-path hunters across the truly-unexercised tail
(multi-core interplay + settings round-trip; session-resume after a hard
crash mid-onboarding + very-large-history-import; attachments + React error
rendering) plus 1 regression-confirmer over the 11 merged fixes. Every
finding re-verified by hand at `file:line` before assertion; the round-3/4
triaged cluster was loaded into each hunter and NOT re-filed.

## Verdict: BUGS_FOUND → 1 NEW PR (no merge)

| # | NEW bug (severity) | Root cause | PR |
| - | ------------------ | ---------- | -- |
| 1 | In the Expo native app, an image the owner attaches and sends renders as a broken/blank thumbnail in their own bubble (and on history replay). The web surface renders it correctly — a both-surfaces parity gap, reachable in M1 via the wired paperclip→`DocumentPicker` flow. (MED, user-facing) | The gateway echoes the attachment as a RELATIVE, bearer-authed URL `/api/app/upload/<user>/<hash>.<ext>` (`gateway/http/app-upload-surface.ts:283`); `reconcileEcho` swaps the local `file://` uri for it (`app/lib/chat-streaming.ts:237`); `MessageItem` rendered `<Image source={{ uri }}>` with no host + no `Authorization` header (`app/components/MessageItem.tsx:67-74`). The GET requires `Authorization: Bearer`, honoring no query/cookie token (`app-upload-surface.ts:358`) → 401 → broken thumbnail. Web handles it via `AttachmentImage`/`fetchAttachmentObjectUrl` (`landing/chat-react/ChatApp.tsx:52-95`); native had no equivalent. | #TBD |

The fix adds a pure `resolveAttachmentSource` + `isAuthedAttachmentUrl`
(`app/lib/attachment-url.ts`, fail-closed same-origin bearer check mirroring
the web client) and an `AuthedAttachmentImage` component
(`app/components/AuthedAttachmentImage.tsx`) — native renders with
`source.headers`; RN-web fetches-with-bearer→object-URL like the web client.
`MessageItem` routes `attachments` + `image_urls` through it; the chat screen
threads `{ base_url, token }`. Regression test (12 tests, incl. a CONTROL for
the pre-fix host-less URL); `tsc` clean; chat suites green (54); lint clean.

## The 11 prior fixes — confirmed PRESENT + INTACT (no regressions)

All 11 are literally the last 11 commits on `main`, so no later commit could
have undone them; the regression-confirmer additionally verified each guard at
the code level and ran the cheap suites:

- #105/#106 reminders/briefs/project-reminders live-deliver to app-ws — `open/composer.ts:1564,1565,1528,1599`
- #107 import-watcher re-arms on reconnect — `open/composer.ts:2239-2247`
- #108 finalize unions chat-named projects — `gateway/realmode-composer/build-onboarding-finalize.ts:377-391` (5 pass)
- #109 whitespace-only decode/worker trim parity — `channels/adapters/app-ws/envelope.ts:643` (13 pass)
- #110 chat_command_result + error frames render — `landing/chat-react/controller.ts:329`, `app/lib/chat-state.tsx:173` (21 pass)
- #111 reminders_create threads recurrence — `cores/free/reminders/src/backend.ts:300-320` (28 pass)
- #112 OpenAI key rejected at setup-token — `onboarding/interview/engine.ts:9096` (3 pass)
- #113 finalize on import-after-fields-answered idle — `open/composer.ts:1922,2219`
- #114 app refetches integrations on foreground — `app/lib/app-state-refetch.ts:18`, `app/app/integrations.tsx`, `app/app/cores/[slug].tsx` (3 pass)
- #115 doc-search excludes soft-deleted projects — `open/doc-search-live-enumerator.ts:33` (3 + 9 pass)

## Triaged cluster (rounds 3–4) — acknowledged, NOT re-filed

All confirmed still present; none re-filed (awaiting Ryan's design decisions):
the app-ws `chat_log`-unwired architectural cluster (inert double-dispatch
guard; reconnect-mid-turn orphan reply; inert resume/receipt/reaction/edit
frames); HTTP-send-blocks-full-turn; warm-turn typing indicator;
`update_agent_name`/`update_personality` dead-in-Open + copy; timezone hardcoded
Pacific; cred-pool eviction on key disconnect; OpenAI-embeddings-key
capture-wiring dead; 80-char scribe floor; gbrain boot-backfill + prompt
steering; import source clobber; synthesis-import restart race; non-atomic
credential writes; oversize-WS diagnostics; two-device doc-link scheme;
bare-500 surface throws; `merge_projects` orphans data (ISSUES #87); the
server still runs an attachment turn with the `"Sent an attachment."`
placeholder (agent can't see the image — known limitation, separate from this
render fix).

## Verified-CLEAN areas this round (no manufactured bugs)

- **Multi-core interplay + settings round-trip.** Cores are genuinely mounted
  end-to-end in Open (`mountOpenCores` → `composition.cores` →
  `installBundledCores` → `wireCoresSurfaces` → HTTP threading); `/cal`,
  `/email`, `/note`, `/remind`, `/research` route to their Core on both the web
  and app-ws surfaces; Calendar/Email/Google fail-soft to in-memory clients when
  `NEUTRON_CORES_GOOGLE_CLIENT_ID` is unset (graceful empty, never a hard error).
  agent-settings + Integrations/Tasks mutations persist to canonical stores and
  reflect back; the OpenAI system slot's `kind`/`label` round-trip matches
  between `ApiKeyStore.add` and `buildIntegrationsStatus`; engagement-mode
  migration `0088` present.
- **Session-resume after a hard crash mid-onboarding.** Onboarding state is
  `SqliteOnboardingStateStore`-durable (phase + `phase_state_json`,
  transactional). The only process-owned autonomous phase in Open
  (`import_running`) re-arms its 5 s cron at every boot; a frozen post-crash
  import is unwedged via a persisted `import_progress_anchor_at` timeout (cancel
  → partial-synthesis-or-fail → graceful advance), never a permanent wedge.
  `on_session_open` re-arms the watcher + finalizes-if-ready for both
  `import_running` and `import_analysis_presented`.
- **Very-large-history-import.** Streaming chunker + per-chunk durable
  persistence + content-hash dedup; no unbounded await-all fan-out; upload
  size-capped (5 GB default, `NEUTRON_MAX_UPLOAD_BYTES`) with a clean `413`;
  large exports use the chunked resumable protocol with gap/contiguity/length
  enforcement and magic-bytes validation — no silent-truncation path. (The
  >1 GB whole-zip-in-Buffer OOM is the already-documented parser limitation.)
- **React error rendering** (web): `error`, `chat_command_result`, and the
  zero-length-delta streaming opener all clear `awaitingReply` and push a
  visible notice (empty bodies fall back to a generic message); `isRunning`
  clears on every terminal frame; import/upload failures surface honest
  notices incl. the `job_id: null` silent-false-success guard.
