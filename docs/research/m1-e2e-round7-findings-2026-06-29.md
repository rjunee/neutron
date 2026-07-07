# M1 Adversarial E2E — Round 7 (FINAL convergence confirmation) — Findings

Date: 2026-06-29 · Base: `main` @ a76fffa · Method: 3 adversarial code-path
hunters across the CORE M1 happy paths Ryan will actually exercise in the
morning, each loaded with the full rounds-3/4/5/6 triaged exclusion list and
required to verify every claim by hand at `file:line` before assertion, with an
explicit bias-toward-CLEAN mandate (CLEAN is the expected + desired outcome of a
converged product). Grounded by a targeted run of the M1 fix-area test suites.

## Verdict: CLEAN — no new bug, no PR

Find-rate trend: round 3 → 3, round 4 → 3, round 5 → 1, round 6 → 1,
**round 7 → 0**. M1 is converged.

## The 13 prior fixes (#105–#117) — confirmed PRESENT + INTACT

All 13 are the last 13 commits on `main`; each hunter re-verified the relevant
guard at the code level. No fix was reverted or broken.

- **#101** chat auth-gate accepts ambient/Keychain `claude` — `open/composer.ts:234-263`, `open/ambient-claude-auth.ts:95-143`
- **#103** Claude-Max OAuth handoff is the DEFAULT functional first auth screen — `landing/server.ts:1342-1356`, CSP-pinned script `:1135-1145`, gate script `:963-1035`
- **#105/#106** reminders/briefs/project-reminders live-deliver to app-ws — `open/composer.ts:1528-1536,1564-1577,1599-1603`; outbound persist-before-send `reminders/outbound.ts:50-94`
- **#107** import-watcher re-arms on reconnect — `open/composer.ts:2239-2247`
- **#108** finalize unions chat-named projects with import — `gateway/realmode-composer/build-onboarding-finalize.ts:373-392`
- **#109** whitespace-only decode/worker trim parity — `channels/adapters/app-ws/envelope.ts:639-650`
- **#110** chat_command_result + error frames render — `landing/chat-react/controller.ts:309,329`, `app/lib/chat-state.tsx:173-175`, HTTP-fallback parity `:287-296`
- **#111** reminders_create threads recurrence — `cores/free/reminders/src/backend.ts:300-320`
- **#112** OpenAI key rejected at setup-token — `onboarding/interview/engine.ts:9096-9105`; symmetric at `install-token-handoff.ts:46`
- **#113** finalize on import-after-fields-answered idle — `open/composer.ts:1922,2218-2222`
- **#114** app refetches integrations on foreground — `app/lib/app-state-refetch.ts:18-20`, `app/app/integrations.tsx:103-110`, `app/app/cores/[slug].tsx:108-115`
- **#115** doc-search excludes soft-deleted projects — `open/doc-search-live-enumerator.ts:25-43`
- **#116** native bearer-authed image attachments render — `app/lib/attachment-url.ts:54-101`, `app/components/AuthedAttachmentImage.tsx`, `app/components/MessageItem.tsx:71-84`
- **#117** retrying a failed image send re-uploads — `app/lib/attachment-url.ts:123-129`, `app/lib/chat-state.tsx:348-386`

## Test grounding

Targeted M1 fix-area suites (not the full ~8180-test suite): **843 pass / 0
fail** across `app/__tests__` (chat/attachments/upload), `cores/free/reminders`,
`channels/adapters/app-ws` (835 across 77 files), plus
`open/__tests__/doc-search-live-enumerator`,
`open-reminder-appws-live-delivery`, `open-project-reminder-appws-live-delivery`,
and `open-import-upload-wiring` (8 across 4 files). No regressions.

## Core happy paths — CONFIRMED HOLDING (3 of 3 hunters CLEAN)

- **Auth → OAuth handoff → onboarding → chat (CLEAN).** Full chain traced:
  `/initiate` → installer greps `sk-ant-oat…` → `/complete` shape-validates →
  `persistOauthTokenToEnv` (0600) → guarded single supervisor restart → Bun
  auto-loads `.env` → `resolveOpenLlmPool` resolves a live OAuth cred → gate
  clears via the robust `/chat` 503→200 poll → React shell. No `max_oauth`
  double-ask; OpenAI-key mis-paste rejected at both the interview and
  install-token seams.
- **State fact → recall (same session + post-restart) + reminders fire→deliver
  (CLEAN).** scribe→gbrain→durable-recall is single-instance: one
  `GBrainStdioMcpClient` over `GBRAIN_HOME`, shared by the write hook
  (`createScribe`) and read tool (`gbrain_search`), so a fresh boot resolves the
  same on-disk brain → durable recall. Scribe wired into both `/ws/app/chat`
  receivers. Reminder create + fire bind the same composer `db`; recurring
  reschedule is `max(fire_at+delta, now+60)` (no double-fire); fire→deliver is
  persist-before-send to `app:<owner>`.
- **Slash render + history-import + project-registration + attachments
  (CLEAN).** Slash results + error frames render on both surfaces; paperclip →
  DocumentPicker → upload → optimistic bubble (server URL) → `AuthedAttachmentImage`
  → idempotent retry-reupload; web import surface updates the rail LIVE via
  `projects_changed` (0→N guarded auto-select); doc-search drops soft-deleted
  projects.

## Triaged cluster (rounds 3–6) — acknowledged, NOT re-filed

All confirmed still present; none re-filed (awaiting Ryan's design decisions):
app-ws `chat_log`-unwired cluster (inert double-dispatch guard / retry re-runs
agent turn; reconnect-mid-turn orphan reply; inert resume/receipt/reaction/edit
frames); HTTP-send-blocks-full-turn; warm-turn typing indicator;
`update_agent_name`/`update_personality` dead-in-Open + copy; timezone hardcoded
Pacific; cred-pool eviction on key disconnect; OpenAI-embeddings-key
capture-wiring dead; 80-char scribe floor; gbrain boot-backfill + prompt
steering; import source clobber; synthesis-import restart race; non-atomic
credential writes; oversize-WS diagnostics; two-device doc-link scheme; bare-500
surface throws; `merge_projects` orphans data (ISSUES #87); failed-import
retry/skip buttons inert in Path-1; `"Sent an attachment."` agent-can't-see-image
placeholder; chat-created project-reminder `topic_id` vs app reminders tab
(by-design).

## One marginal item — investigated, deliberately NOT filed

The native project-list screen (`app/app/projects/index.tsx:119-124`) fetches
only on mount — no `useFocusEffect`/pull-to-refresh — despite a stale doc comment
in `app/lib/projects.ts:14-15` claiming it "refreshes on focus," so a live native
session won't reflect projects created elsewhere until relaunch. NOT a reportable
M1 bug: native lands on `/projects` to open existing projects, has no
onboarding-chat / create-project entry and no `projects_changed` handler by
design (it is not the M1 import surface — the web client is, and that path
registers projects live). A marginal cross-surface live-sync gap + stale comment,
not a core user-facing M1 defect. Per the bias-toward-CLEAN mandate, not filed.

## Convergence call

Zero new in-scope defects this round across 3 independent core-path hunters; all
13 prior fixes intact; 843 fix-area tests green. With the find-rate at
3→3→1→1→**0** and the remaining surface entirely the already-triaged
design-decision cluster, **M1 is converged.** The overnight M1 loop can close
pending Ryan's morning pass + the triaged design calls.
