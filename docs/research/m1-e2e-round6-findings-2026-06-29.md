# M1 Adversarial E2E — Round 6 (FINAL convergence confirmation) — Findings

Date: 2026-06-29 · Base: `main` @ 286ad73 · Method: 4 adversarial code-path
hunters across the CORE M1 happy paths Ryan will actually exercise in the
morning (auth + onboarding-to-completion; chat turn + memory recall same-session
& post-restart; reminders one-shot + recurring fire→live-deliver; slash-command
render + history-import + project-registration + attachments). Each hunter was
loaded with the full rounds-3/4/5 triaged exclusion list and verified every
claim by hand at `file:line` before assertion. Find-rate trend: round 3 → 3,
round 4 → 3, round 5 → 1, **round 6 → 1**.

## Verdict: BUGS_FOUND → 1 NEW PR (no merge)

| # | NEW bug (severity) | Root cause | PR |
| - | ------------------ | ---------- | -- |
| 1 | In the Expo native app, **retrying a failed image send never recovers the image**. The optimistic bubble keeps the raw *local* device URI; `retry()` re-sent it verbatim with no re-upload (only `send()` ever called `performUpload`). The gateway's `sanitizeAttachments` rejects the WHOLE `attachments` array if any entry isn't `https?://`/`/`-prefixed, so an **image-only retry 400s** (`missing_body`, permanent — every tap re-fails) and a **text+image retry silently drops the image**. Reachable in M1 via the wired paperclip→`DocumentPicker` flow (the natural untested companion to #116, which fixed *rendering* the same attachments). (MED, user-facing) | Optimistic bubble stores local URIs `app/lib/chat-state.tsx:322`; only `reconcileEcho` swaps them to the server URL `app/lib/chat-streaming.ts:237`, which never runs on a failed send; `retry()` read `target.attachments` (local URIs) and passed them straight to `dispatchSend` with no upload `app/lib/chat-state.tsx:355-361`; gateway drops a mixed/local array `channels/adapters/app-ws/envelope.ts:675`. | #TBD |

**Fix.** A pure `resolveSendableAttachments(storedUris, uploadFn)`
(`app/lib/attachment-url.ts`) routes the bubble's stored URIs back through the
same `performUpload` step `send()` uses (which already no-ops already-uploaded
URLs via `isAlreadyUploadedAttachmentUrl`); `retry()` now calls it before
re-sending. Idempotent for the already-uploaded case, recoverable for the
upload-failed case. Regression test (8 tests, incl. a CONTROL that reproduces
the pre-fix rejection against the **real** gateway `sanitizeAttachments` for
`file://`/`content://`/`ph://`) — `app/__tests__/chat-retry-reupload-attachments.test.ts`.
`tsc -p app/tsconfig.json` clean; adjacent chat suites green (39).

## The 12 prior fixes — confirmed PRESENT + INTACT (no regressions)

All 12 are literally the last 12 commits on `main`, and each hunter re-verified
the relevant guard at the code level:

- **#101** chat auth-gate accepts ambient/Keychain `claude` — `open/composer.ts:234-263`, `open/ambient-claude-auth.ts:95-137`
- **#103** Claude-Max OAuth handoff is the DEFAULT functional first auth screen — `landing/server.ts:1342-1356`, CSP-pinned script `:1135-1145`
- **#105/#106** reminders/briefs/project-reminders live-deliver to app-ws — `open/composer.ts:1528-1536,1564-1577,1599-1603`
- **#107** import-watcher re-arms on reconnect — `open/composer.ts:2239-2247`
- **#108** finalize unions chat-named projects with import — `gateway/realmode-composer/build-onboarding-finalize.ts:373-392`
- **#109** whitespace-only decode/worker trim parity — `channels/adapters/app-ws/envelope.ts:639-650`
- **#110** chat_command_result + error frames render — `landing/chat-react/controller.ts:309,329`, `app/lib/chat-state.tsx:163-175`
- **#111** reminders_create threads recurrence — `cores/free/reminders/src/backend.ts:300-320`
- **#112** OpenAI key rejected at setup-token — `onboarding/interview/engine.ts:9096-9105`
- **#113** finalize on import-after-fields-answered idle — `open/composer.ts:1922,2218-2222`
- **#114** app refetches integrations on foreground — `app/lib/app-state-refetch.ts:18-20`, `app/app/integrations.tsx:103-106`, `app/app/cores/[slug].tsx:108-111`
- **#115** doc-search excludes soft-deleted projects — `open/doc-search-live-enumerator.ts:25-43`
- **#116** native bearer-authed image attachments render — `app/lib/attachment-url.ts`, `app/components/AuthedAttachmentImage.tsx`, `app/components/MessageItem.tsx:71-84`

Full M1 suite: **2525 pass / 38 skip / 1 fail**, where the single fail
(`open projects_changed live-refresh wiring`) is a parallel-execution tempdir
flake (ENOENT on a temp `.heartbeat`) — it **passes in isolation** (verified
twice), untouched by this change.

## Core happy paths — CONFIRMED HOLDING (3 of 4 hunters CLEAN)

- **Auth + onboarding → chat (CLEAN).** Full path traced: `resolveOpenLlmPool`
  → gate page poll/navigate → install-token handoff (idempotent, single guarded
  restart) → `.env` persist + supervisor restart → onboarding preamble →
  post-turn extractor → required-fields audit → finalize/persona-gen →
  drop-into-chat. Preamble↔audit field contract aligned (5 fields incl. ≥3
  projects, ≥1 non-work interest); no `max_oauth_offered` double-ask after
  handoff (auto-skip checks `CLAUDE_CODE_OAUTH_TOKEN`).
- **Chat turn + memory recall (CLEAN).** scribe→gbrain→durable-recall loop
  correctly wired and single-instance: write (`scribe/index.ts` →
  `write-to-gbrain.ts` → `GBrainSyncHook` slug-carrying `put_page`) and read
  (`gbrain_search` reachable — registered in the `neutron` MCP, tool bridge on,
  allow-all gate) hit the SAME on-disk brain (`GBRAIN_HOME`), so **post-restart
  recall is durable**. turnChains serialize per-(project,topic); reply
  translator lands on the `app:<owner>` socket.
- **Reminders fire → live-deliver (CLEAN).** #105/#106/#111 intact; recurring
  reschedule claims-before-dispatch with `max(fire_at+delta, now+60)` (no
  double-fire/catch-up storm); snooze preserves cadence via `createRecurring`;
  fire→deliver persists-before-send (durable `button_prompts` first, best-effort
  live push); brief compose falls back to the pure template + retries on deliver
  failure.

## Triaged cluster (rounds 3–5) — acknowledged, NOT re-filed

All confirmed still present; none re-filed (awaiting Ryan's design decisions):
app-ws `chat_log`-unwired cluster (inert double-dispatch guard; reconnect-mid-turn
orphan reply; inert resume/receipt/reaction/edit frames); HTTP-send-blocks-full-turn;
warm-turn typing indicator; `update_agent_name`/`update_personality` dead-in-Open +
copy; timezone hardcoded Pacific; cred-pool eviction on key disconnect;
OpenAI-embeddings-key capture-wiring dead; 80-char scribe floor; gbrain
boot-backfill + prompt steering; import source clobber; synthesis-import restart
race; non-atomic credential writes; oversize-WS diagnostics; two-device doc-link
scheme; bare-500 surface throws; `merge_projects` orphans data (ISSUES #87);
failed-import retry/skip buttons inert in Path-1; the `"Sent an attachment."`
agent-can't-see-image placeholder.

## Adjacent observations — documented, NO PR (for Ryan's triage)

- A project reminder created via **chat** stores `topic_id = raw project_id`
  (`cores/free/reminders/src/backend.ts:313`), whereas the app reminders **tab**
  lists by `app-project:<id>` (`app-reminders-surface.ts:47-49`), so a
  chat-created project reminder won't appear in that tab. Explicitly documented
  as intended (`app-reminders-surface.ts:20-22`); **live delivery is unaffected**
  (#106 routes all fires to the bare owner topic). By-design, not filed.

## Convergence call

One MED bug this round, in the attachment retry path — a real, deterministic,
one-helper fix, not a marginal/manufactured issue. The four CORE happy paths
(auth→onboarding→chat, chat-turn→memory-recall, reminders fire→deliver, slash/
import/projects) otherwise HOLD, and all 12 prior fixes are intact. With the
find-rate at 3→3→1→1 and the remaining surface dominated by the already-triaged
design-decision cluster, **M1 is converged**: ship PR #TBD and the overnight
loop can close pending Ryan's morning pass + the triaged design calls.
