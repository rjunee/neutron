# AS-BUILT

Running log of notable build-time changes, what shipped, and why. Newest first.

## 2026-06-21 — External-tool floor: Google Workspace Core (Drive/Sheets/Docs) + Gmail send (gap-audit P0-6)

Closes the gap-audit external-tool floor (P0-6 / §(b) cat 9,
`~/repos/neutron-managed/docs/research/vajra-neutron-daily-driver-gap-audit-2026-06-20.md`):
Drive/Sheets/Docs were MISSING entirely, and the Email Core was draft-only
(no send). Both are daily Ryan workflows. Scope: `cores/` + the tool layer only
— no `composer.ts`, no admin UI.

**NEW: `@neutronai/google-workspace-core` (`cores/free/google-workspace/`, slug
`google_workspace_core`).** A Tier 1 free Core surfacing nine MCP tools across
three Google APIs, all capability-guarded + audit-logged:

- Drive v3 — `drive_list` / `drive_read` / `drive_upload`
- Sheets v4 — `sheets_read` / `sheets_append` / `sheets_update`
- Docs v1 — `docs_read` / `docs_create` / `docs_update`

Per-service `read:/write:google_workspace_core.{drive,sheets,docs}` capabilities.
ONE Google OAuth grant under the DISTINCT label `google_workspace`
(scopes: `drive` + `spreadsheets` + `documents`) — reuses the SAME per-Core OAuth
plumbing Calendar (`google_calendar`) + Email (`gmail_compose`) already depend on
(runtime composer drives the install-time prompt + resolves a live access token
via the per-Core SecretsAccessor through the shared `OAuthTokenManager`). NOT a
global token registry; the grant connects/disconnects independently. The Core
declares `required: true`, so under the Noop install prompter it lands in the
`manifest_invalid` install-failure bucket exactly like Calendar/Email until the
owner connects Google — surfaced in `/api/cores` as `install_state: failed`.

- `src/backend.ts` — a narrow `GoogleWorkspaceClient` interface with TWO
  implementations: `buildInMemoryGoogleWorkspaceClient()` (in-process store, backs
  the tools test) and `buildGoogleWorkspaceClient()` (hand-rolled `fetch`-based
  Drive/Sheets/Docs REST wrapper, no `googleapis` dep — accepts a lazy
  `accessToken()` accessor + a `fetchImpl` override). Drive read exports
  Google-native files to text (Docs→text/plain, Sheets→text/csv) and downloads
  others via `alt=media`; upload is multipart text. Sheets append/update use
  `valueInputOption=USER_ENTERED`. Docs read flattens the structured document to
  text; create = `documents.create` + a `batchUpdate` insertText; update inserts
  at an explicit index or appends at the resolved end index.
- `__tests__/backend.test.ts` asserts each production op against a mocked Google
  API (HTTP method/path/payload) + the in-memory adapter round-trips.
  `__tests__/tools.test.ts` exercises the capability-gated tool layer + audit
  rows. `__tests__/manifest.test.ts` pins the manifest contract.

**Email Core: Gmail SEND shipped (`email_send`).** HISTORY: send was originally
carved OUT of this Tier 1 Core (drafts-only, three intentional regression guards
asserting "no send tool / no `gmail.send` scope", reserved for a Tier 2 paid
Core). The gap-audit (P0) explicitly reversed that product decision — Gmail-send
is a daily-driver need — so this PR ships it here and FLIPS those guards.

- New `email_send` tool + `GmailClient.sendMessage(...)` on all three backends
  (two in-memory + the production Gmail REST client → `messages.send`). Sends a
  new message or a reply (In-Reply-To/References + `threadId` populated
  server-side). Header-injection is blocked at the shared `buildRawMessage` MIME
  layer (CR/LF/NUL rejected).
- Send gets its OWN capability `write:email_managed_core.send` (distinct from the
  drafts write capability) for clean audit attribution; the OAuth grant now adds
  `gmail.send` (FOUR scopes).
- The 4-point DRAFT rule (DRAFT + INBOX + IMPORTANT + UNREAD) is UNCHANGED. Send
  applies the same INBOX + IMPORTANT + UNREAD visibility labels to the sent thread
  via `threads.modify` (the DRAFT label is N/A for a sent message) so the
  conversation surfaces in the owner's inbox — the send-path counterpart to the
  draft rule. `DraftLabelingError` carries the sent message id for idempotent
  retry on a partial completion.

**Registration plumbing (the thing the prior attempt broke).** The earlier run
failed with `tool_registration_failed` for `calendar_core` + `email_managed_core`
and never opened a PR — a module-resolution break (`Cannot find module
'@neutronai/cores-runtime'`). Root cause avoided here by following the EXACT
existing pattern: new Core added to root `workspaces` + `gateway/package.json`
deps, `bun install` re-run so the `node_modules/@neutronai/*` symlinks
(cores-runtime/cores-sdk/runtime + the gateway→core link) are created identically
to Calendar/Email. New Core's backend factory wired in `gateway/boot-helpers.ts`
(dual-mode: Google REST client when the OAuth accessor is present, in-memory
fallback otherwise) + `google_workspace_core: 'client'` in
`install-bundled.ts:BACKEND_KEY_BY_SLUG`. Gateway inventory tests updated
(`cores-composition` + `cores-surface`: discovered set + the OAuth-gated failure
list, now Calendar + Email + Google Workspace).

**Verify.** `bunx tsc --noEmit` clean. Full `bun test`: 7624 pass / 90 skip /
0 fail across 722 files — INCLUDING every cores registration test
(`cores-composition`, `cores-surface`, `cores-oauth-surface`, install-lifecycle).

## 2026-06-21 — Chat-sync foundation fix-round (Argus REQUEST CHANGES): double-dispatch guard + wiring split

Argus (cross-model with Codex/GPT-5) requested changes on PR #6 with two
BLOCKING findings. This round resolves both.

**BLOCKING #1 — double-dispatch (the headline).** `AppWsAdapter.ingestUserMessage`
de-duped the persisted row on `client_msg_id` (the `AppChatStore.append`
idempotency: a re-sent id returns the existing row with `was_new:false`), but it
**discarded `was_new`** and returned only `{ message_id, seq }`. The app-ws
surface therefore had no idea a send was a duplicate and *unconditionally* ran
the **side-effecting** chat-command filter (`chat_command_filter.match`, which
executes the command, e.g. captures a note) **and** `dispatchInbound` (the agent
loop). So a re-sent `client_msg_id` — an offline-queue flush retry, a double-tap,
or the HTTP fallback racing the WS echo of the same send — fired the agent / a
command **twice**. Storage was idempotent; *behaviour* wasn't, defeating the
spec's idempotency guarantee. Confirmed at `app-ws-surface.ts:322-355` (Codex P1
independently).

*Fix:* `ingestUserMessage` now returns `was_new` (true when no durable log is
wired — legacy mode never de-dupes, so every send dispatches, unchanged; true on
a persist failure — we couldn't prove it a duplicate, so dispatch rather than
silently drop). Both surface paths (WS `message` handler + HTTP `handleSend`)
**gate the chat-command filter + `dispatchInbound` on `was_new`**. The echo is
still re-emitted on a duplicate (the client de-dupes it on `client_msg_id`, so a
reconnecting device still reconciles its bubble) — only the side-effecting
agent/command work is now exactly-once. Files: `channels/adapters/app-ws/adapter.ts`,
`gateway/http/app-ws-surface.ts`.

*Test (real, RED→GREEN):* NEW `gateway/__tests__/app-ws-no-double-dispatch.test.ts`
(4 tests) stands up the REAL surface over `Bun.serve` against a REAL `AppChatStore`
(SQLite temp file) with a counting receiver + counting command filter, and asserts
that re-sending the same `client_msg_id` over WS — and over HTTP, and HTTP-racing-
WS — dispatches the agent + command **exactly once** while re-emitting the echo
both times with the same canonical `seq`/`message_id`. A fourth test wires the
real server append/replay into the real client `SyncEngine` and asserts a single
message yields **exactly one row per device** even with optimistic-insert +
server-echo + a duplicate ingest + a reconnect replay overlapping (the spec's
exactly-once-per-device convergence). Verified RED on the pre-fix tree (3/4 fail
without the gate).

**BLOCKING #2 — "feature inert" (wiring) — cross-repo, clarified.** Argus noted
every `new AppWsAdapter`/`new AppChatStore` lives in `__tests__` and no
production boot in this PUBLIC repo wires `chat_log`. On investigation (Argus
agreed in its own notes) the production boot that constructs the adapter/registry
and calls `createAppWsSurface` lives in the **private `neutron-managed` repo**
(the managed/private split) — it opts into the durable log by passing `chat_log`,
exactly as documented in §2 of the entry below. That boot is **out of scope for
this public PR** (brief: OPEN-repo only, never touch managed). The open-repo half
of the wiring — the adapter's optional `chat_log` seam, graceful degrade when
absent, and the `createWebStore()` OPFS-or-in-memory web store — is complete and
tested here. The one open-repo loose end (a speculative unused `@neutron/chat-core`
dep on `landing/package.json`) is removed (see the web-wiring note below).

**Cross-model review (Codex/GPT-5) — one fix taken, three follow-ups logged.**
The fix-round Codex pass surfaced four correctness gaps in the *original*
Phase-1 design (none in the double-dispatch fix itself; all pre-existing, not in
Argus's blocking set). Triaged:

- **TAKEN — sent-but-unacked sends are now retried on reconnect (Codex P1).**
  `SendQueue` marked a row `sent` the instant `WebSocket.send()` accepted the
  frame; if the socket dropped before the server persisted + echoed it, the row
  was stranded `sent` and a plain `flush` (which only drains `queued`) never
  retried it — a silently lost send. NEW `SendQueue.flushUnacked` re-drives every
  not-`acked` row (queued + sent) oldest-first; `WebChatSession.resumeAndFlush`
  now calls it on every (re)connect. This is SAFE precisely because of this PR's
  guarantees: every send carries a `client_msg_id`, so the server de-dupes the
  retry, and the new `was_new` guard means the re-delivery never re-fires the
  agent. `acked` rows are never re-sent. Tests: 3 in `send-queue.test.ts` +
  1 reconnect-retry in `web-session.test.ts` (RED→GREEN).
- **FOLLOW-UP (Codex P1) — rich agent envelopes are flattened on replay.**
  `AppChatStore.append` persists only `body/project/created_at`, so
  `replayAfter` reconstructs a bare `agent_message` — a device that reconnects
  loses `options`/`image_urls`/`citations`/`doc_refs`/`deep_link`/
  `upload_affordance` that live devices saw. Proper fix needs a schema change
  (store the full envelope JSON) + a migration; deferred to a dedicated PR rather
  than widen this fix-round into the persistence schema.
- **FOLLOW-UP (Codex P1) — resume does not page past the first 500 rows.**
  The server caps each replay at `DEFAULT_REPLAY_LIMIT` (500); a cold/long-
  offline client sends one `resume` and stops, so topics with >500 persisted
  messages never pull the tail. Robust paging needs a server "resume
  complete / has-more" marker (a protocol addition) so the client knows to
  re-resume from the new high-water mark; deferred.
- **FOLLOW-UP (Codex P2) — mixed web+native fan-out uses one platform.**
  `getPlatform` returns only the most-recently-registered platform, used to pick
  the doc-link scheme for the whole fan-out, so a simultaneously-connected
  web+native account gets one device's links in the wrong scheme. Needs
  per-device envelope encoding in the registry fan-out; deferred (P2).

## 2026-06-21 — Chat-sync foundation (Phase 1): server `seq`/`resume`/multi-device + `@neutron/chat-core`

The first phase of web↔mobile Telegram-parity (research:
`web-chat-telegram-parity-architecture-2026-06-20`). Delivers the defining
"Telegram feel" — offline send, gap-free reconnect, instant cold-open,
multi-device consistency — with **zero UI-framework change**. Append-only
chat → a hand-rolled sync engine (server monotonic `seq` + per-client cursor +
idempotent send-queue), not a CRDT/RxDB.

**1. Durable per-topic message log + monotonic `seq` (server).** Until now the
app-ws surface (`/ws/app/chat`) emitted user/agent messages in-memory only —
nothing persisted, so a message sent while a socket was down was lost and there
was no ordering key for multi-device. New migration `0079_app_chat_messages.sql`
+ `persistence/app-chat-store.ts` (`AppChatStore`) append every message with a
monotonic, per-topic `seq` (`PRIMARY KEY (topic_id, seq)`), de-duplicated on
`(topic_id, client_msg_id)`. `replayAfter(topic, after_seq)` is the resume
query (`WHERE seq > ? ORDER BY seq`). The store is wired through an
`AppChatMessageLog` interface so the adapter stays DB-agnostic + unit-testable.

**2. `resume` replay + `seq` on the wire (app-ws).** New inbound control frame
`{ v:1, type:'resume', after_seq:N }` (decoded by the new `decodeAppWsResume`,
kept separate from the message decoder so the `user_message` path keeps its
narrow type). The surface replays the gap to the *requesting* socket only.
`seq` now rides on every outbound `user_message`/`agent_message`; `session_ready`
carries `last_seen_seq` so a client can skip an unneeded resume. The
`AppWsAdapter` gained an optional `chat_log` — when wired it persists +
stamps `seq` (back-compat: absent → legacy in-memory behaviour, all existing
tests unchanged). Production boot (managed) opts in by passing `chat_log`.

**3. Multi-device session registry.** `InMemoryAppWsSessionRegistry` changed
from `Map<topic, sender>` (last-wins, silently dropped a second device) to
`Map<topic, Set<sender>>` with fan-out to every live device on the account,
identity-aware per-device unregister, and a dead-socket sweep that never aborts
the fan-out. Combined with per-client `seq` cursors, web + phone converge on
one transcript.

**4. `@neutron/chat-core` — transport-agnostic client lib (new workspace).**
The shared logic the web (and, Phase 2, mobile) clients consume:
- `Store` interface + `InMemoryStore` (ordering: by `seq`, never clock;
  optimistic tail last) and an OPFS-backed `OpfsChatStore` with
  `createWebStore()` that **degrades gracefully** to in-memory when OPFS /
  `createWritable` is unavailable (scope-guard requirement);
- `SendQueue` — idempotent on `client_msg_id`, offline-buffering, flush-on-
  reconnect, never double-sends;
- `SyncEngine` — append-only apply (UPSERT dedup + optimistic reconcile),
  `last_seen_seq` cursor, `resume` request builder;
- `ChatWsClient` — reconnect with exponential backoff + jitter, AppState-aware
  (pause/resume), injectable socket + timers;
- `WebChatSession` — the high-level composition a web client instantiates to
  get optimistic send + offline queue + gap-free reconnect + instant cold-open
  against the seq-aware app-ws protocol.

**Web wiring decision (noted per autonomy mandate):** the only existing
vanilla-TS web client, `landing/chat.ts`, talks to the *onboarding* `/ws/chat`
bridge (a different protocol with no `seq`), not `/ws/app/chat`. Rather than
risk destabilising that 4,476-line client by retrofitting it onto a different
surface, the chat-core integration is delivered as the fully-tested
`WebChatSession` composition (consumed by the seq-aware app web client).
Repointing `landing/chat.ts` itself — and adopting `createWebStore()` there — is
deferred to the Phase-3 web UI uplift, where the client is migrated anyway.
(Fix-round: the speculative `@neutron/chat-core` dep that had been added to
`landing/package.json` was removed — `landing/` imports nothing from chat-core,
so the declaration was a decoupled artifact that bundled nothing; it'll be added
back when the client is actually migrated. Argus BLOCKING #2.)

**Out of scope (later phases):** React/assistant-ui migration (P3), mobile
op-sqlite wiring (P2), FTS5 search / read receipts (P4). The `Store` interface
is the seam a Phase-2 wasm-SQLite engine drops into.

**Tests:** 73 new tests — chat-core (`sync-engine`, `send-queue`, `ws-client`,
`store`, `web-session`), `AppChatStore` seq/idempotency/resume, multi-device
registry, adapter seq/resume end-to-end, `resume` decode. `bunx tsc --noEmit`
clean; schema snapshot + migration-list regenerated.

## 2026-06-20 — CI green on the public runner: grep falls back to POSIX grep + least-privilege workflow token

Post-public-flip hardening on rjunee/neutron. Two CI/security fixes; PR-A.

**1. `grepScoped` CI failure — ripgrep is not on the GitHub runner.** The
`grep` codegen tool (`cores/free/code-gen/src/tool-handlers.ts:grepScoped`)
shelled out unconditionally to `rg` (ripgrep). It passes locally (rg installed)
but the stock `ubuntu-latest` runner has no ripgrep, so `Bun.spawn(['rg', …])`
fails and the two `grepScoped` tests error in CI. Fix (the more robust option in
the brief): the tool now prefers ripgrep but **falls back to POSIX `grep`** when
`Bun.which('rg')` returns null — robust for any self-hoster's CI too, not just
GitHub's. Both binaries emit `path:line:text` with `-n` and exit 1 on no-match,
so the caller sees an identical shape either way; the fallback adds `-r` plus
`--exclude-dir=.git --exclude-dir=node_modules` (the ignores rg applies
implicitly) and maps `--glob` → `--include=`. Tool description + the stale
"using ripgrep" wording updated to match.

**2. `actions/missing-workflow-permissions` (1 CodeQL alert).** Added an
explicit least-privilege top-level `permissions: { contents: read }` block to
`.github/workflows/ci.yml` (the only workflow; CodeQL runs via GitHub default
setup, no committed codeql.yml). CI only reads the checkout + runs
typecheck/tests, so no write scopes are granted.

**3. Midnight-boundary flake in `restore-ui.test.ts` (the actual red on the
first CI run).** With the ripgrep cause fixed, CI still failed on a SEPARATE,
date-dependent test: `groupSnapshotsByDay > labels today / yesterday correctly`.
The run executed at `00:00:30 UTC` (the runner's tz is UTC), and the test built
a "today" snapshot at a fixed `60_000 ms` ago — which at 30 s past local midnight
lands at `23:59:30` YESTERDAY, so "Today" had 1 snapshot instead of 2. The
`groupSnapshotsByDay` implementation is correct; the test was fragile. Fixed by
anchoring the today snapshots to instants guaranteed within the local calendar
day (`[startOfToday, now]`: midnight-today + the midpoint to now), mirroring the
existing noon-yesterday anchor. Hardened the sibling "preserves order within a
day" test the same way (it had the same latent ~3 s post-midnight flake). Proven
against the exact failure instant (`now = 2026-06-21T00:00:30Z`, tz UTC):
Today=2 / Yesterday=1.

**Verify.** `bun test cores/free/code-gen/__tests__/tool-handlers.test.ts` →
16/16 pass with ripgrep present AND with `rg` removed from PATH (grep-fallback
path exercised on BSD grep; GNU grep on the Linux runner supports the same
flags). `bun test app/__tests__/restore-ui.test.ts` → 19/19. `bunx tsc --noEmit`
clean. First CI run confirmed both `grepScoped` tests PASS on the stock runner
(grep fallback works) — only the unrelated date flake was red, now fixed.

## 2026-06-20 — chat client: scheme/host allow-list on navigation + image sinks (CodeQL js/xss + open-redirect)

Post-public-flip security hardening on rjunee/neutron; PR-B. CodeQL flagged 8
alerts in `landing/chat.ts` (3 js/xss + 5 js/client-side-unvalidated-url-
redirection), all on three DOM sinks that consume values arriving over the
gateway WebSocket. VERIFIED each, then fixed at the sink.

**The three sinks.**
- `handleRedirect` (redirect envelope) → `window.location.replace/href = target`
  built from `msg.new_url` + `msg.new_start_token`.
- `handleSlugRenamed` (slug-rename CTA click) → `window.location.assign/href =
  target` built from `buildSlugRenamedTarget(msg.new_host, …)`.
- image-gallery option render → `img.src = opt.image_url`.

**Why it's a real sink class.** Even though these envelopes come from the
authenticated gateway, a value that flows into `window.location` is an
execution sink: a `javascript:` (or `data:`/`vbscript:`) URL there is DOM-XSS,
and an unconstrained host is an open redirect. The chat agent/LLM can influence
some of these fields, so they are treated as untrusted at the boundary.

**The fix — allow-list at the sink (escape-the-scheme, validate-the-target).**
Two exported, unit-tested helpers in `landing/chat.ts`:
- `safeNavUrl(raw)`: parses the target (relative resolves against the current
  document), returns it only when it normalizes to an `http:`/`https:` URL with
  a non-empty host, else null. Both location handlers now navigate to the
  RETURNED value (so the check is on the exact string that reaches the sink) and
  refuse to navigate (status "redirect/open blocked: unsafe target") when null.
- `safeImageSrc(raw)`: accepts only `http`/`https` (incl. relative paths that
  resolve to the app origin) and inline `data:image/*`; any other scheme →
  null, and the gallery option falls back to its plain-text label.

**Tests.** NEW `landing/__tests__/chat-url-sanitizers.test.ts` (12) pins
http(s) pass-through + rejection of `javascript:`/`data:`/`vbscript:`/`file:`/
empty/garbage for `safeNavUrl`, and http(s)/`data:image` accept + `javascript:`/
non-image-`data:` reject for `safeImageSrc`. Existing
`chat-slug-renamed-target.test.ts` (13), `chat-slug-renamed-cta.test.ts`,
`option-grid-layout.test.ts`, `chat-rendering.test.ts` (39 combined) stay green
— behaviour for legitimate http(s) targets is unchanged. `bunx tsc --noEmit`
clean.
## 2026-06-20 — onboarding: prompt body↔options desync + double name-ask (first-run showstopper)

Owner-confirmed P0 launch defect on a fresh public install. First-run onboarding
asked the name TWICE and emitted a prompt whose BODY was the "what's your first
name?" question but whose BUTTONS were the import offer (Yes ChatGPT / Yes Claude
/ Neither) — body and options came from DIFFERENT phases. Server-log proof
(`~/neutron/data/logs/server.log`): after the required-fields audit confirmed the
name was collected and the engine had advanced to `ai_substrate_offered`, the
emitted prompt `5dcdf824` had `body_len=40` (a name re-ask) with `options=3`
(the import buttons).

**Why the prior #308/#310 fixes didn't close it.** They were verified against
mocked phase-spec resolvers that returned clean per-phase specs, so they never
exercised the REAL resolver's parse → materialize → engine-emit seam where the
defect actually lives. The bug only reproduces on the production LLM path.

**Root cause (two interacting parts).**
1. *Lagged body.* On Open, the phase-spec LLM ("rephrase this phase's prompt")
   runs on ONE warm, ACCUMULATING `cc-llm` REPL session (`open/composer.ts` —
   intentionally not `ephemeral`, no `/clear`). On a cold-start / accumulated-
   context turn the model can return the PREVIOUS phase's body — a name re-ask
   emitted while the engine has already advanced to the import offer. The
   resolver's `withTimeout` also deliberately does not cancel a slow turn, so the
   warm session keeps drifting. (`onboarding/interview/phase-spec-resolver.ts`,
   `runtime/.../persistent-repl-substrate.ts`, `open/composer.ts:185`.)
2. *The graft that made it user-visible.* The #7264779 "BUG-2" hardening in
   `materializeSpec` grafted the CURRENT phase's static options onto an LLM spec
   whenever the LLM returned an empty options array. So a lagged NAME body (which
   the model emits option-less, thinking it's the free-text signup step) got the
   `ai_substrate_offered` import buttons stapled on — manufacturing the exact
   "name body + import buttons" desync and the phantom second name-ask.

**The fix — body and options must always come from the SAME phase.**
`onboarding/interview/phase-spec-resolver.ts`:
- `resolve()` now discards the whole LLM spec when an *option-bearing* phase
  (`intent.allowed_option_values.length > 0`) comes back *option-less*. The engine
  then falls back to the FULL static spec for that phase (body AND options both
  in-phase). This subsumes the BUG-2 phantom-buttons fix more robustly: an
  option-bearing phase can no longer emit a body without its buttons. A NON-empty
  option *subset* from the LLM is still a legitimate narrowing and is preserved.
- `materializeSpec` no longer grafts static options onto an LLM body — body and
  options are used exactly as the LLM produced them on that one in-phase call.
- The resolver system prompt now instructs the warm accumulating model that each
  call is a STANDALONE rephrase of the CURRENT phase — ignore prior turns'
  questions — reducing cross-phase body drift on free-text phases too.

Net effect: the name is asked exactly once, and every prompt's body matches its
buttons. With the lagged name-body discarded, the import step renders the proper
static import prompt instead of a second name-ask.

**Tests (RED→GREEN on the REAL path).**
- `onboarding/interview/__tests__/engine-llm-resolver.test.ts` — NEW block drives
  the PRODUCTION `buildLlmPhaseSpecResolver` (real `parseLlmSpec` +
  `materializeSpec`) through a real `InterviewEngine.emitPhasePrompt`, feeding the
  `LlmCallFn` the exact lagged JSON the warm session produced live (name body,
  empty options) and asserting the emitted prompt's body↔options are in-phase.
- `onboarding/interview/__tests__/phase-spec-resolver.test.ts` — NEW block locks
  the invariant at the resolver + materializer (no graft; option-less option-
  bearing phase → static fallback; subset preserved; free-text unaffected).
- Both fail on the pre-fix tree and pass after. `bunx tsc --noEmit` clean;
  `bun test` 7438 pass / 0 fail; leak-gate silent.

## 2026-06-20 — #314: deterministic port bind on restart (no silent random-port fallback)

Owner-confirmed P1 self-host defect (#314), fixed on
`fix-deterministic-port-bind-314-20260620` and merged into `open-converge`. Hit
live twice on the owner's instance: after a restart (crash, reboot, `neutron
restart`), when the configured port (default 7800 via `NEUTRON_PORT`) was not
instantly free, the new server did not end up on its configured port — so the
owner's bookmarked `http://127.0.0.1:7800` broke, and one episode left two
servers running (old squatting 7800, new elsewhere).

**Root cause.** `boot()` (`gateway/index.ts`) opened the listener with a bare
`Bun.serve({ port })` and no EADDRINUSE handling. The transient cause of a busy
port on restart is the *prior* process still releasing the socket during its
graceful drain — but there was no bounded retry to ride that window out. A
configured port that should be honored-or-fail was instead left to crash/race
with no deterministic outcome. (For the record: Bun.serve THROWS EADDRINUSE
rather than literally binding a random port; the user-visible "wrong port"
traced to the restart overlap + the missing deterministic rebind, not to Bun
silently randomizing.)

**The fix (deterministic-or-loud).** New `bindHttpListener()` helper in
`gateway/boot-helpers.ts`, wired into `boot()`:
- **`port !== 0` (explicitly resolved: `NEUTRON_PORT` / `--port`, or the fixed
  7800 default):** bind it and ONLY it. On EADDRINUSE, retry on a short backoff
  through a bounded window (default ~8s) to ride out the prior process releasing
  the socket; if still held, **FAIL LOUD** — throw a clear, actionable error
  (`port <N> is already in use … stop it (neutron stop) or set NEUTRON_PORT …
  Refusing to silently bind a different port (#314)`) and exit non-zero. Never
  moves to a random port.
- **`port === 0` (the genuine "pick anything" case — dev/tests pass
  `--port=0` / `BootOptions.port=0`):** single attempt, OS auto-selects a free
  port, exactly as before.
- Non-EADDRINUSE errors rethrow immediately (no retry masking real boot faults).

**Restart helper.** `neutron-service.sh do_restart` now VERIFIES (best-effort,
via `_wait_http_up` curling `/healthz`) that the new process came back up on the
**configured** port and warns loudly otherwise. Both supervisor primitives
already serialize old-exit-before-new-start (launchd `kickstart -k` kills the
running instance before respawning; systemd `restart` does ExecStop → wait →
ExecStart), so the residual socket-release overlap is the part the server-side
retry now covers.

**Tests (REAL, RED→GREEN).** `gateway/deterministic-bind.test.ts` stands up an
actual `Bun.serve` squatter on a fixed port and exercises `bindHttpListener`
against it: (1) a persistently-occupied configured port FAILS LOUD with a clear
message and never binds a different port; (2) a squatter that releases mid-boot
→ the helper retries and binds the SAME configured port; (3) control: `port 0`
auto-selects a free port in a single attempt; (4) non-EADDRINUSE errors rethrow
fast. Also verified live end-to-end on a non-7800 port (7811 clean boot; 7812
squatter → 8s retry → loud exit, no random bind). `bunx tsc --noEmit` clean,
`gateway/` suite 1894 pass / 0 fail, leak-gate silent. #314 closed.

## 2026-06-20 — OSS community-health files for the public flip

Added the standard public-OSS community files ahead of the rjunee/neutron public
flip: CONTRIBUTING.md (dev setup via Bun + install.sh, test discipline, PR
process), SECURITY.md (private vuln reporting via GitHub advisories / ryan@junee.org,
self-host trust model, no key commits), CODE_OF_CONDUCT.md (Contributor Covenant
2.1). LICENSE (Apache-2.0) + README already present. Docs-only; no code change.

## 2026-06-20 — GO-LIVE: make the wow first-week brief TRUTHFUL (no fabricated overnight/reminder claims)

Owner-confirmed defect on the converged Open install, fixed on
`fix-brief-truthful-20260620` and merged into `open-converge`. Owner decision:
**option A — make the brief truthful now**; option B (actually wiring real
overnight work at onboarding) is a logged post-launch follow-up, OUT OF SCOPE
here.

**The defect.** The end-of-onboarding wow first-week brief (action 01,
`onboarding/wow-moment/actions/01-first-week-brief.ts`) ASSERTED scheduled
overnight work and reminders that were never created. The owner's real DB had
`overnight_queue = 0 rows` and `reminders = 0 rows`, yet the brief said "I've
queued these to work on overnight while you sleep: …" and "I'll run that
overnight pass at 7am tomorrow …". Root cause: `appendOvernightPreview` +
`overnightItems` SYNTHESIZED that list from speculative dispatch-context inputs
(`ctx.stalled_threads`, `ctx.import_result.proposed_tasks`, "import not null")
and presented the speculation as a committed schedule. Action 07 only registers
the per-project `overnight-<slug>` cron that ticks the engine; it does not
enqueue any `overnight_queue` rows at onboarding. So the queue is genuinely
empty and every "queued/scheduled" claim was fabricated.

**The fix (honest-by-construction).** `appendOvernightPreview` now reads the
REAL `overnight_queue` for the project at render time (new
`readQueuedOvernight` helper → `OvernightQueueStore(ctx.db).listByProject(slug)`
filtered to `queued`/`in-flight` rows; any read failure returns `[]` so the
brief OFFERS rather than ever fabricating). Two branches:
- **rows present (control):** reflect the real rows by `description` (capped),
  "I'll work through that queue overnight …".
- **empty queue (the onboarding reality):** emit an OFFER, never a schedule —
  "Nothing is scheduled overnight yet. I can run autonomous overnight work or
  set reminders whenever you want, just ask (for example "schedule overnight
  research on <real project>" or "remind me Monday 9am")."

The deleted `overnightItems` synthesizer is gone entirely. The per-project
pointer ("each project on the left has its own topic") is kept because it is
true (the engine seeds a topic per kept project). Real projects are still
stated from the canonical kept set via `mergeProjects` (unchanged). The brief
never claims reminders are set; the reminders section remains labelled
"suggested" (proposals from import, not active reminders). Reading the live
table is self-correcting: once real work is queued, a later brief reflects it.
No em dashes in the user-facing copy (house style).

**Post-launch follow-up (option B).** Actually wiring real autonomous overnight
work at onboarding (enqueuing `overnight_queue` rows the engine then executes)
is deferred. Until then the brief OFFERS overnight work rather than asserting
it; the moment rows exist, the control branch surfaces them automatically.

**Tests (RED→GREEN, real produced-string assertions, not bookkeeping flags).**
- `onboarding/interview/__tests__/wow-fired-overnight-preview.test.ts` rewritten:
  empty-queue case (stalled threads + proposed tasks present, the exact inputs
  the old code fabricated from) asserts the brief does NOT claim queued/
  scheduled/7am work, DOES reference the real project, DOES contain the offer,
  and has no em dashes; a CONTROL case inserts real `overnight_queue` rows
  (queued + in-flight) via `OvernightQueueStore` and asserts the brief reflects
  them while excluding terminal + other-project rows.
- `onboarding/wow-moment/actions/__tests__/01-first-week-brief.test.ts` gains a
  co-located empty-queue truthful test + a control test.

**Verify.** `bunx tsc --noEmit` clean (ignoring the sibling `../neutron-open`
aliasing artifact). `bun test` green. `scripts/ci/leak-gate.sh --tree .`
silent. STAYED OUT of `gateway/realmode-composer/build-live-agent-turn.ts` and
`open/composer.ts` (a concurrent Forge owns those).

## 2026-06-20 — GO-LIVE live-agent chat: serialize overlapping turns per (instance, topic)

Owner dogfood found the General live-agent chat unreliable: two questions typed
in quick succession ("are any reminders currently set?" then "and what overnight
work is currently scheduled?") produced the "Waking up your workspace for the
first time…" ack MULTIPLE times, rendered the reminders answer TWICE, and NEVER
answered the overnight question. Server log showed two `live_agent_turn` events
both COLD-started → two parallel cold sessions racing for the same (instance,
topic). Fixed on `fix-live-agent-turn-race-20260620` and merged into
`open-converge`. Reproduce-first (RED→GREEN); tsc clean; full suite green; leak
gate silent.

**Root cause — overlapping turns each cold-spawn a separate session.**
`gateway/realmode-composer/build-live-agent-turn.ts`'s `runLiveAgentTurn` had NO
per-(instance, topic) serialization. The cold/warm decision reads an in-process
`contextSent` set, but `contextSent.add(topicKey)` only runs AFTER a turn's
dispatch settles (and the warm CC session it establishes is pooled just as
late). So when a 2nd turn on the SAME (instance, topic) arrives BEFORE the 1st
settles, BOTH turns see `isColdFirstTurn` → BOTH arm the cold-start "waking up"
ack → BOTH compose the heavy first-turn persona/context prompt and cold-spawn a
parallel session for the same key. The persistent REPL's own `acquireTurn()`
mutex serializes turns ON one warm session, but it cannot stop two turns from
cold-spawning two sessions before either is pooled — that pre-pool gap is the
race.

**Fix — a per-(instance, topic) turn chain at the composer seam.**
`buildLiveAgentTurn` now keeps a `turnChains: Map<topicKey, Promise<void>>`
holding the tail of each topic's in-flight turn chain. The returned
`runLiveAgentTurn` is a thin serializer: it chains the turn's body onto the
prior turn's tail, so turns for one (instance, topic) run strictly
one-at-a-time and in arrival order — the 1st turn establishes the warm session
and pays the single cold-start ack; the 2nd runs ONLY after it settles, sees
`contextSent`, skips the ack, reuses the warm session, and answers its own
question in order. The chain tail swallows the prior turn's outcome on BOTH
settle paths (`() => undefined`) so one turn's failure never wedges the chain,
and the map self-prunes once a topic's chain drains (the tail deletes its own
entry iff it is still the current tail). Distinct topics keep distinct chains,
so cross-topic turns still run concurrently. The existing turn body
(`runTurnBody`) — persistence, cold-start ack, dispatch, persist-before-send,
per-turn timeout + abandon handling — is unchanged; only its invocation is now
gated through the chain. This mirrors the monorepo's one-turn-at-a-time-per-
session discipline.

**Reproduce.** **NEW** `gateway/realmode-composer/__tests__/build-live-agent-turn-overlap.test.ts`
fires TWO turns on the SAME (instance, topic) nearly simultaneously (2nd before
the 1st settles, via a recording substrate that answers after a 60ms cold
window) and asserts: exactly ONE "Waking up" ack, exactly ONE cold first-turn
dispatch (single warm session — the 2nd dispatch carries only the bare user
text), and TWO distinct in-order replies (Q1 → Q2, no duplicate, no dropped
turn). RED on pre-fix code (two acks, two cold dispatches); GREEN with the
chain.

**Verify.** `bunx tsc --noEmit` clean (sibling `../neutron-open` aliasing
filtered). `bun test gateway/realmode-composer/` → 331 pass / 3 skip / 0 fail
(incl. the new overlap test + 17 existing live-agent tests). Full `bun test` →
7424 pass / 90 skip / 1 fail — the lone failure is
`gateway/__tests__/app-docs-client.test.ts > deleteFolder() removes an empty
folder`, a git-backed test that timed out at 5s under 701-file parallel load and
passes in 177ms in isolation (pre-existing flake, unrelated to this single-file
change). `bash scripts/ci/leak-gate.sh --tree .` → SILENT.

## 2026-06-20 — GO-LIVE chat polish: persist the wow brief to history + remove the fake unread badge

Two owner-reported polish defects on the converged Open install, fixed on
`fix-chat-polish-20260620` and merged into `open-converge`. Reproduce-first;
real-boot regression tests (DB / composed-server observable, not mock-only);
tsc clean; full suite green; leak gate silent.

**A — the wow first-week brief vanished on reload.** The end-of-onboarding
projects + overnight summary (action 01) showed live during onboarding but was
GONE on General reload; only the "Everything's ready" turn after it survived.
Root cause: the wow channel adapter's `sendText`
(`gateway/realmode-composer/build-wow-dispatcher.ts`) only did a live
`webRegistry.send({type:'agent_message'})` and threw on undelivered — it NEVER
wrote to `button_prompts`, the chat-history store `GET /api/v1/chat/history`
reads. `emitPrompt` persists via `buttonStore.emit`; `sendText` did not, so the
brief was ephemeral (the owner's DB held 10 General turns, none the brief). Fix:
after a CONFIRMED delivery, `sendText` now persists the text to `button_prompts`
as an inert, already-resolved agent-bubble turn (emit a zero-option /
allow_freeform prompt carrying the body, then `resolve` it with an empty
resolution → satisfies the history filter and renders agent-only via
`renderHistoricalTurn`). Strictly best-effort: it runs ONLY on the success path,
wrapped in try/catch so a DB hiccup logs + continues and NEVER turns a delivered
message into a dispatch failure — the load-bearing throw-on-undelivered
semantics (the action-runner's per-action `outcome.failed[]` routing) are
untouched. No idempotency key (matches action 01's "re-running re-emits the
brief" contract); no double-render (the live envelope carries no `prompt_id`, so
the client's `prompt_id`-keyed dedup never collides). Refactor: the channel
adapter was extracted into an exported `buildWowChannelAdapter(deps)` so its
persistence behaviour is unit-testable directly with a real `ButtonStore` + a
stub `webRegistry` (production wiring unchanged).

**B — every project sidebar showed a perpetual "1" unread badge.** Owner: "why
does every project have a little '1' indicator? It seems to always reset to 1."
Root cause: the Open topics surface (`open/chat-topics-surface.ts`) sourced
`unread_count` from `ButtonStore.listTopicsByUser`, which derives it as the count
of UNRESOLVED + unexpired `button_prompts` — and every materialized project
carries exactly ONE unresolved opening seed prompt, so the badge sat at 1
forever. There is NO per-topic last-read / last-seen marker persisted anywhere,
so "unread" cannot be computed honestly — it was a fake indicator. Decision
(per the owner's standing no-fake-indicators rule): REMOVE rather than build a
last-read subsystem for go-live. The surface now reports `unread_count: 0` for
every topic, so the client badge (which hides at 0) never paints a fake "1". The
client badge mechanism and wire field are left intact (the Managed surface and a
future real last-read seam can still use them).

Tests: NEW `open/__tests__/wow-brief-history-persist.test.ts` (3) drives the REAL
`buildWowChannelAdapter` over a real `ButtonStore`, asserts the brief lands in
`button_prompts` AND that a real Open boot's `GET /api/v1/chat/history` returns
it as a resolved agent turn, AND that no-active-WS still throws + persists
nothing. NEW `open/__tests__/chat-topics-no-fake-unread.test.ts` (1) boots the
real Open composition with a project whose only row is its unresolved opening
seed and asserts `GET /api/v1/chat/topics` returns `unread_count: 0` (was 1).
`bunx tsc --noEmit` clean; full `bun test` 7424 pass / 0 fail / 90 skip; leak
gate silent. (Also reworded a pre-existing leak-gate-flagged phrase in
`docs/SYSTEM-OVERVIEW.md` describing the warm CC session to the Open
`per-(project,topic)` framing so the leak gate is silent on the tree.)

## 2026-06-20 — GO-LIVE: chat history 404 — wire `chat_history_surface` into the Open composer

Owner retest after the 5-fix pass: General reloaded EMPTY and project-switch
still showed only the single live re-emit. Real forensics (owner instance DB +
browser console) nailed it: `button_prompts` held all 10 General turns and the
exact server history query returned all 10, but the browser logged
`GET /api/v1/chat/history?limit=20 → 404` / `[chat] event=history-hydrate-failed
status=404 — falling back to live-WS-only`. **Root cause: the Open composer
(`open/composer.ts`) mounted `chat_topics_surface` (the sidebar rail) but NEVER
mounted `chat_history_surface` (the message hydration), so `/api/v1/chat/history`
404'd in the composed server — the handler + its unit tests existed; only the
wiring was missing (the OSS carve dropped it).** The earlier "#2/#3" pass cleared
the loading spinner and added render-path tests but never exercised the real
route, so the 404 survived. Fix: construct `createChatHistorySurface({ store:
landing.buttonStore, resolveUserClaim: cookieToUserClaim, project_slug })` and add
`chat_history_surface` to the Open composition output, mirroring the topics
surface exactly. Regression lock — NEW `open/__tests__/open-chat-history-wiring.test.ts`
boots the REAL Open composition over `Bun.serve`, seeds a General `button_prompts`
turn, and asserts `GET /api/v1/chat/history` is MOUNTED (200 + returns the turn
WITH the owner cookie / 401 without) — was 404. `bunx tsc --noEmit` clean; new
test 2 pass / 0 fail. This is the missing reachability test that let the bug slip.

## 2026-06-20 — GO-LIVE chat-surface fixes: 5 post-onboarding defects (public-flip gate)

Owner live-dogfood of the converged Open install surfaced 5 defects on the
daily-driver chat surface. All fixed on `fix-chat-surface-20260620` and merged
into `open-converge`. Reproduce-first; real regression tests; tsc clean; leak
gate silent.

1. **[P0 — General topic was DEAD] completed-phase General typed messages got
   zero response.** Root cause: the General `user_message` live-agent gate
   (`isLiveAgentEligible`, `gateway/http/chat-bridge.ts`) was the ONLY caller
   that passed `respect_final_handoff: true` — project topics passed `false`.
   An owner who finishes onboarding and never taps the wow final-handoff "Done"
   leaves `phase_state.final_handoff_active` stuck `true` forever, so EVERY
   typed General message returned `eligible=false`, fell through to the engine's
   `handleFinalHandoffOnCompleted` → `noop_terminal`, and the topic went silent
   — while project topics (which ignore the flag) worked. Fix: removed the
   `respect_final_handoff` gate entirely; General now mirrors project topics
   (`phase==completed` ⇒ live agent). The wow buttons still work — a
   `button_choice` TAP bypasses the `user_message` gate and routes to the engine
   handoff handler unchanged; only TYPED replies now reach the live agent.
   Tests: `chat-bridge-live-agent-turn.test.ts` (typed-with-pending-handoff →
   live agent; tap → engine).
2. **[client] Reload hung on "Setting things up…" forever.** The loader cleared
   only on first rendered content; a completed-instance reload emits no fresh
   first agent message and General history can be empty, so it hung until a
   topic switch. Fix: the server stamps `resumed: true` on a returning session's
   `session_ready` (cookie-only resume + spent-jti fallback in `landing/server.ts`);
   the client clears the loader on that signal (`handleSessionReady`, `chat.ts`).
   Fresh onboarding arrives WITHOUT `resumed`, so its loader still covers the
   bring-up window. Tests: `chat-setup-indicator.test.ts`.
3. **[client] Topic switch dropped history to the last message.** Verified
   ALREADY RESOLVED at `open-converge@6a82c57` by the 2026-06-19 BUG #310 fix
   (render unresolved historical rows inert instead of `if (!turn.resolved)
   return`). Added regression coverage that locks full-history rendering across
   a switch, including the in-flight-initial-hydrate abort race
   (`topic-switch-history-go-live.test.ts`).
4. **[client] Topic switch killed the typing indicator.** Re-attach on a fresh
   turn works (test); hardened `switchTopic` to also
   `clearOpenTypingTimeout()` — the one-shot on-open dangling-dots timeout was
   never torn down on switch and could fire on the new topic, force-clearing a
   live indicator.
5. **[onboarding] "ignore <project>" acknowledged but the project was created.**
   The `projects_proposed` removal seam exists (`removed_projects` union-minus-
   removals merge, tested) but the LLM router prompt only enumerated
   "drop/cut/skip", so "ignore real estate investing" was acknowledged
   conversationally yet never populated `removed_projects` → re-added by the
   additive union → materialized. Fix: "ignore"/"exclude"/"leave out"/"don't set
   up"/"remove" are now first-class removal verbs in `llm-router.ts`; honest
   copy in the `projects_proposed` prompt + FAQ ("just say 'ignore X'… you can
   also rename or delete any project later"). Test: `projects-proposed-ignore-removal.test.ts`
   pins that an ignore is excluded from the materialized set.

Verification: `bunx tsc --noEmit` clean; `bun test` gateway/http (221), landing
(437), onboarding interview+synthesis (941/35 skip) all 0 fail + the new suites;
`scripts/ci/leak-gate.sh --tree .` SILENT.

## 2026-06-20 — onboarding import copy: drop "One moment", set large-import expectation

Owner-dogfood feedback during the converged-Open install test: the import-scan
status copy said "One moment" while the synthesis read of a large ChatGPT
export legitimately runs for minutes. Changed both the dynamic import-running
status (`buildImportRunningPromptSpec`, `phase-prompts.ts:~2150`) and the static
`import_running` fallback body (`~194`) from "One moment." → "This may take a
while if you have a large import." Copy-only; no logic change. `onboarding/interview`
987 pass / 0 fail, tsc clean.

## 2026-06-19 — Open public-flip convergence (Trident + overnight + fixes assembled)

Final assembly of the `open-converge` branch ahead of the Open public flip.
**Assembly + green-up only — no new feature work.**

### Merges
- `trident-port` (PR-1→5: foundational Trident engine, `code_trident_runs`
  state machine + tick driver, Forge→Argus review/fix/merge loop, Ralph
  spec-driven build mode, `/code` → Trident, restart-resume) merged.
- `overnight-engine` (the real Autonomous Overnight-Work engine that runs ON
  Trident: `onboarding/overnight/` queue-store + dispatcher + morning-brief +
  STATUS.md sync, migration `0078_overnight_queue`) merged.
- Only conflict was `AS-BUILT.md` (append-conflict on both merges) — resolved
  by KEEPING BOTH sides' entries. Code merged cleanly (Trident in `trident/`,
  overnight in `onboarding/overnight/`, prepublic-scrub fixes in
  onboarding/chat/landing — disjoint trees).

### Type-clean (`bunx tsc --noEmit` → 0 errors)
- `onboarding/overnight/dispatcher.ts` — omit `context_text` when undefined
  (exactOptionalPropertyTypes); guard malformed `shiftLocalDate` parse.
- `onboarding/overnight/status-md-sync.ts` — guard regex capture groups +
  array index access under noUncheckedIndexedAccess.
- `onboarding/wow-moment/project-materializer.ts` — pass the woven related-
  signal STRING (`weaveRelatedSignal`) into `renderSeedContext`, not the raw
  `RelatedImportSignal` object.
- overnight `*.test.ts` — non-null assertions on already-length-checked array
  indices (assertions not weakened).
- The Trident `git-mode.ts` `cwd` error noted in the brief was already fixed by
  PR-5. Zero cross-worktree (`../`) sibling-artifact errors this run.

### Test + leak-gate green
- `bun test` — full suite **7406 pass / 90 skip / 0 fail** on a clean run.
  Two fixes: `migrations/runner.test.ts` now includes migration `0078`; the
  `m2-mira-v3-tangent-coverage` signup tangent assertion now expects an
  amend/answer carrying a NAME to auto-advance signup (the BUG1
  onboarding-opening-fix behavior — the prior "pass" was a FALSE read from a
  cross-worktree symlink in a sibling checkout that ran the OLD `main` engine).
  A small set of gateway HTTP-surface tests (`app-docs-surface`,
  `app-reminders-surface`) are a PRE-EXISTING concurrency flake — they pass in
  isolation, pass on clean reruns, and are untouched by this merge (last
  modified at the base import commit `23c4351`).
- `scripts/ci/leak-gate.sh --tree .` — **SILENT ✅ (0 findings)**. Tier-1 PII
  rule skips because `LEAK_GATE_PII_DENYLIST_B64` is unset (expected for the
  public tree). Proof: `git grep '1003775096851'` → 0; `git grep -i 'managed
  customer'` → 0; no committed base64 PII blob.

### Framing sweep (harness, not "personal AI agent")
- README already reframed to "an agent harness for Claude Code" (0 stale
  "personal AI agent"/"platform" hits).
- `agent-name-suggester.ts` + `personality-character-suggester.ts` system
  prompts: dropped "personal AI agent" → "their agent" (these describe the
  user's named assistant, not the product).
- `build-project-doc-composer.ts` "personal AI workspace" reviewed and KEPT —
  it accurately names the user's local workspace, not the product framing.

## 2026-06-19 — Per-project chat: preserved history (#310) + STATUS.md opening (#308)

Two live-dogfood bugs that share the per-project-topic / `button_prompts`
code path, fixed together.

### BUG #310 (P1) — project chat history not preserved (only the latest message showed)

All per-project history derives from the `button_prompts` table via
`ButtonStore.listHistoryByTopic`. Two compounding causes:

**Cause 1 (rendering) — `landing/chat.ts`.** `renderHistoricalTurn` did
`if (!turn.resolved) return`, dropping EVERY unresolved historical row and
relying on the server's live re-emit (`reEmitActiveSeedPromptIfAny`) to
repaint. But the re-emit ships only the SINGLE most-recent unresolved row, so
any earlier unresolved turn vanished on a topic switch (a project whose only
row was its unresolved opening seed showed exactly one message).

**Fix.** Render unresolved rows as inert agent bubbles (no button keyboard,
no paired user reply). The ONE exception is the topic's single most-recent
unresolved row — the "active prompt" the server re-emits live WITH its
clickable keyboard — which is left for the live re-emit so the dedup
(`renderedPromptIds`) can't strip its buttons. `prependHistoryBatch` computes
that `activePromptId` from `turns[0]` of the newest batch only (older "Load
earlier" pages never contain it) and threads it into `renderHistoricalTurn`.

**Cause 2 (persistence) — `gateway/http/chat-bridge.ts`.** On a project topic,
a `user_message` only persisted when `liveAgentEligible`; otherwise the stub
reply was a live-only `send({type:'agent_message'})` never written to
`button_prompts`, so the turn was lost on switch/refresh.

**Fix.** New `persistProjectStubTurn` helper in `handleProjectTopicInbound`
persists the stub turn regardless of `liveAgentEligible`, reusing the
live-agent pattern: stamp the typed text as the `__freeform__` resolution of
the prior unresolved row, then emit the stub reply as a new unresolved row
(10-year TTL). The live envelope now carries `topic_id` + the persisted
`prompt_id` so the client dedups it against the history re-emit.

### BUG #308 — generic "want me to dig into…" opening instead of a STATUS.md summary

`buildDeterministicProjectOpening` emitted a hardcoded
`` `Want me to dig into ${firstTopic}?` `` and sourced only the README first
paragraph / import rationale. STATUS.md (written by the materializer at
`<owner_home>/Projects/<slug>/STATUS.md`) was never read.

**Fix (`gateway/realmode-composer/`).** Added `status_md` to
`ProjectOpeningDocs`; read STATUS.md at the doc-load seam. New `parseStatusMd`
parses the frontmatter (one-liner / status / priority) + body summary + an
"Open threads" list. The deterministic opening now leads with a status
summary, an ask-for-corrections line, and a per-project next-action hook
(prefers an open thread, then a suggested topic, then an open question). The
LLM composer (`build-project-opening-message.ts`) gets STATUS.md fed first in
its prompt + a system instruction to summarize it and invite corrections. No
em dashes in the new copy.

### Tests

- `landing/__tests__/chat-history-hydrate.test.ts` — new case: older
  unresolved turns render inert while the newest unresolved (active) is left
  for the live re-emit (with buttons).
- `landing/__tests__/project-chat-status-opening.integration.test.ts` — ONE
  integration test covering BOTH bugs end to end (handoff hook -> ButtonStore
  -> chat-bridge -> store reads -> ChatClient DOM): the opening summarizes
  STATUS.md, stub turns persist, and the full transcript renders on
  switch-back.
- `bunx tsc --noEmit` clean. Existing `ProjectOpeningDocs` fixtures updated
  with `status_md`.
## 2026-06-19 — Onboarding COMPLETION flow fix (#309) + timezone auto-skip (#306)

Live owner-dogfood bugs in the end-of-onboarding handoff. Branch
`onboarding-handoff-tz` off `prepublic-scrub`.

### #309 — the two final-handoff messages were too long / confusing / wrong

The completion flow emits two General-topic messages in sequence: the wow
first-week brief (`onboarding/wow-moment/actions/01-first-week-brief.ts`,
fires LAST in the dispatcher) and the final-handoff guide
(`onboarding/interview/final-handoff-prompts.ts:buildFinalHandoffPromptSpec`,
emitted by `engine.ts:emitFinalHandoffPrompt` after the `completed` upsert).
Per-project detail already routes to each project's own topic via
`gateway/realmode-composer/build-onboarding-handoff.ts:emitProjectSeeds`
(`web:<user_id>:<slug>`). Four fixes, all in the MESSAGE content (the
overnight-WORK engine was untouched):

1. **Respect the user's project trim.** `01-first-week-brief.ts:mergeProjects`
   re-added the full `import_result.proposed_projects` on top of
   `captured_projects`, resurrecting every project the user trimmed away (the
   owner trimmed to 4 and the brief still rendered `Projects on deck (9)`).
   `captured_projects` is already the kept set when the engine observed a
   `projects_proposed` confirmation (`ctx.projects_confirmed === true`,
   plumbed from `primary_projects_confirmed`). Fix: gate the import merge on
   `!projects_confirmed`, mirroring `03-project-shells.mergedProjects`.
   Unconfirmed/legacy callers keep the dedupe-merge.

2. **Killed the hardcoded "AC install" example.** The overnight footer
   hardcoded `"drop the AC install"` — a fabricated project the user never
   had. Replaced with a non-fabricated example drawn from the user's ACTUAL
   kept projects (`"drop <FirstKeptProject>"`), else a generic
   `"drop an item"`.

3. **Consolidated the close; no premature "You're all set."** The brief used
   to end with a dangling question (`"Want to change what's queued?"`) that
   the final-handoff's `"You're all set"` immediately barreled past. The brief
   no longer poses a hard closing question (the final-handoff carries the one
   closing invite), and the guide greeting changed from `"You're all set"` to
   `"Everything's ready"` — a calm hand-off into action, not a triumphant
   terminal receipt. The owner-liked `"What's something I can help you with
   right now?"` invite stays.

4. **High-level in General, detail per-project.** The per-project overnight
   breakdown (`"Per-project background analysis for <X>"`) was enumerated in
   General. Removed it from `overnightItems` (General now carries only the
   cross-cutting overnight work — stalled-thread drafts, queue re-rank, graph
   refresh) and added a high-level pointer: *"Each project on the left has its
   own topic — open one to see what I've lined up for it."* Each project's
   specifics already land in its own topic via `emitProjectSeeds`.

### #306 — interview asked for the timezone even when auto-detected

The web client auto-detects the IANA timezone
(`landing/chat.ts:detectBrowserTimezone`) and sends it as the `?tz=`
WS-upgrade param, but the server never persisted it: `phase_state.timezone`
was only ever READ (by persona-gen, `engine-internals.ts`), never WRITTEN, so
it stayed empty and the agent had nothing to treat as "already known". Worse,
the "never ask for timezone" instruction lived in `prompts/onboarding/
interview-base.md`, which is DEAD (not wired to any live driver — the live
system prompt is `onboarding/interview/skills/_envelope.md`). Fixes:

- **Persist `?tz=` end-to-end.** `landing/server.ts` parses `tz` on the token
  WS upgrade → `SocketState.browser_timezone` → `ChatBridge.startSession` →
  `gateway/http/chat-bridge.ts` forwards it to `engine.start` → new
  `StartInput.timezone` → stamped onto `phase_state.timezone` on the first
  start. New `engine-internals.ts:sanitizeBrowserTimezone` is the server-side
  trust boundary (IANA shape, ≤64 chars); an invalid/oversize/wrong-shape
  value is dropped (key stays absent → ask-nothing fallback). Shallow-merge
  upsert means a later reconnect that omits `?tz=` never clobbers connect-1's
  value.
- **Live never-ask rule.** Ported the never-ask-timezone instruction into the
  live `_envelope.md`, and the gap-fill user prompt now surfaces a stamped
  timezone as `known_timezone=<zone>` (`llm-prompt-driver.ts`,
  `PhaseContextBundle.known_timezone`) so the model treats it as captured and
  never asks.

### Tests

New: `onboarding/interview/__tests__/timezone-autoskip.test.ts`
(`sanitizeBrowserTimezone` cases + `engine.start` stamps/drops timezone +
envelope carries the rule); two new cases in `01-first-week-brief.test.ts`
(trim respected when confirmed; legacy merge preserved when not). Updated:
`wow-fired-overnight-preview.test.ts` (no per-project enumeration / no "AC
install" / new pointer + project-derived drop example) and the
`llm-prompt-driver-envelope.test.ts` byte-for-byte pin (new envelope
paragraph). Test seam: `projects_confirmed` added to
`wow-moment/__tests__/test-helpers.ts:buildContext`.

## 2026-06-19 — Trident-port PR-5 (FINAL): remaining Vajra fixes + restart-resume + `/code` → foundational Trident

Last of the ~5 sequential PRs — completes the foundational Trident port. PR-2
landed the state-machine + tick + store; PR-3 the real Forge/Argus substrate
sessions; PR-4 the Ralph plan↔task loop. PR-5 ports the remaining
battle-tested Vajra fixes with explicit regression tests, hardens
restart-resume, and rewires `/code` to be a THIN entry into foundational
Trident (creates a `code_trident_runs` row; the tick drives it) instead of the
Code-Gen Core wrapper's separate orchestration path.

**1. Remaining Vajra fixes — mapped + explicitly tested.** NEW
`trident/vajra-fixes.test.ts` (23 tests) is the one-file map from each Vajra
`/trident` SKILL.md / forge-argus fix to its Open analog, each with a narrow
assertion so none can silently regress:
- **Spawn validation / no phantom in-flight** — `TridentSessionManager.spawn`
  records the `running` entry SYNCHRONOUSLY before returning (the Open analog
  of Vajra's poll-up-to-60s spawn confirm); a blank minted id throws. So a
  `classify`/`isTracked` immediately after spawn can never miss the session.
- **Reap / "session never became ready" → bounded re-dispatch** — see (2).
- **Oversized-diff guard** — `chooseArgusScope` + `computeDiffLineCount` +
  `ARGUS_DIFF_LINE_LIMIT` (3000): over-ceiling steers Argus to meaty commits +
  "could not verify"; an unmeasurable diff is conservatively treated as OVER.
- **max_rounds / max_ralph_rounds caps** — `computeTransition` fails loudly
  with a named reason past either cap; the single ralph-round counter lives in
  the plan transition (no double-count).
- **Phantom-ID / async-registry race** — a `classify` before completion
  reports `running` (never a phantom crash); an unknown id defaults to the
  SAFE `running` (non-null id blocks a re-spawn); `unknown_session:'crashed'`
  opts into loud orphan failure.
- **No silent exit / no silent merge** — a forge-init with no PR contract →
  `crashed`; an unparseable Argus verdict → `REQUEST_CHANGES` (never
  auto-merge).
- **Missing REMAINING_TASKS fails loud** — a Ralph bootstrap/planner with no
  valid count → `failed`, never a partial-build review.
- **Model routing defaults** — Forge/Argus models default + ride on every
  dispatch (never empty); overrides route through; nothing defaults to the
  export-control-disabled Fable id.

**2. Restart-resume + reap, hardened.** NEW `session.isTracked(id)` exposes
whether a persisted `subagent_run_id` is still tracked in-memory (false after a
control-plane restart — the Open analog of Vajra's "is the tmux window / PID
alive?" reap). NEW orchestrator option `on_orphaned_session`
(`'redispatch'` default / `'wait'` / `'fail'`): on a tick, a non-null
persisted sub-agent the manager no longer tracks is recovered BEFORE
poll/spawn — `redispatch` resumes the run by re-launching that phase, BOUNDED
to one re-dispatch per run per process (the re-spawned session registers
synchronously, so steady state never re-enters; a per-process guard stops a
crash-restart storm). This is NOT a double-spawn — the prior in-process agent
is already gone, so exactly one agent is ever live. NEW
`trident/restart-resume.test.ts` (5 tests) simulates a restart (fresh
orchestrator + empty session map over the same store row) mid-`argus` and
mid-`ralph-task` and asserts: the lost phase re-dispatches exactly once, the
stale id is replaced by a fresh TRACKED session, `runningCount() === 1` (no
second agent), and the run drives to `done`; plus `wait`/`fail` policy
coverage.

**3. `/code` → foundational Trident (Code-Gen wrapper retired for `/code`).**
NEW `trident/code-command.ts` — the Trident-native `/code` parser + dispatcher
(`parseCodeCommand` / `parseAndExecuteCodeCommand` / `slugifyTask`). `/code
<task>` no longer drives the Code-Gen Core's `CodegenOrchestrator` + in-memory
tracker + sidecar; it CREATES a `code_trident_runs` row (git-mode + Ralph
auto-detected) and returns — the foundational tick loop picks it up and drives
forge-init → argus → fix loop → merge → done. State in SQLite ⇒ a `/code`
build survives a restart and resumes from its phase. The command grammar
(`/code <task>` / `/code stop [id]` / `/code help`) matches the Core's S2 shape
so the UX is unchanged. NEW `trident/code-command.test.ts` (12 tests) incl. an
END-TO-END path: `/code` text → row → tick loop (mocked substrate) → APPROVE →
`gh pr merge` → `done`.

**4. Boot wiring + the production `/code` filter.**
- `gateway/composition/build-core-modules.ts` — the `trident` module now wires
  the REAL orchestrator `step` (`buildTridentOrchestrator` over a
  `TridentSessionManager`) when the composer threads `input.trident.dispatch`;
  else it falls back to `stubAdvanceDeps` (unchanged Open default). The
  dispatch is one Forge/Argus turn → terminal text, built from the
  per-instance Anthropic substrate (the same credential closure the Code-Gen
  Core's sub-agent dispatch consumed before Trident superseded the wrapper).
- NEW optional `input.trident` seam in `composition/input/misc-input.ts`
  (`dispatch` / `run_host` / models / timeout / `on_orphaned_session`).
- NEW `buildTridentCodeChatCommandFilter` in `gateway/boot-helpers.ts` (+
  re-exported from `gateway/index.ts`) — the production `/code` filter that
  creates Trident runs, superseding `buildCodegenChatCommandFilter` (now marked
  SUPERSEDED, retained for the Core's legacy MCP-tool path + tests). NEW
  `gateway/__tests__/trident-code-command-wiring.test.ts` (5 tests).
- NEW exported `spawnCapture` (default `Bun.spawn` host runner) from
  `trident/git-mode.ts` for the orchestrator's `run_host` default.

**Verify.** `bunx tsc --noEmit` clean (0). `bun test trident/` → 161 pass / 0
fail (was 121; +40 new across vajra-fixes, restart-resume, code-command).
Full suite `bun test` → 7354 pass / 90 skip / 2 fail; both failures are
PRE-EXISTING and unrelated (`notes-production-composer` passes 7/0 in isolation
= load flake; `m2-mira-v3-tangent-coverage` fails identically with this PR's
tracked changes stashed = pre-existing onboarding-LLM flake). Zero regressions.

### Decisions Log (PR-5)
- **Resume = bounded re-dispatch, not just reap.** Vajra reaped a dead agent
  and re-dispatched. Open's substrate is in-process, so a restart definitively
  kills the agent — re-dispatch is recovery, not double-spawn. Default policy
  is `redispatch`; bounded one-per-run-per-process. `wait`/`fail` are opt-in.
- **`/code` rewired to Trident at the wiring layer; the Code-Gen Core
  orchestration is NOT physically deleted in this PR.** A grep-verified
  analysis (the brief's "KEEP anything still uniquely used") shows the Core's
  `CodegenOrchestrator`/runner/`chat-commands`/sidecar are still referenced by
  the Core's four `codegen_*` MCP tools, its install-lifecycle + manifest, the
  Managed graph composer, and ~106 self-contained passing tests. Deleting them
  inline would red those suites and is a separate Core-removal change. `/code`
  is fully retired-to-Trident (the production filter creates Trident runs); the
  physical file deletion + substrate relocation is the documented remaining
  step. See STATUS.md.
- **No `git worktree remove` on merge (carried from PR-3).** Open uses plain
  branches; deleting an operator's checked-out worktree is the data-loss
  footgun the spec forbids.

## 2026-06-19 — Real Autonomous Overnight-Work engine (runs ON Trident)

Replaces the preview-only morning check-in stub
(`onboarding/wow-moment/overnight-cron.ts`, `wow_overnight_handler`, which
delivered a "here's what's on deck" message but never ran any work) with a real
engine that, while the user sleeps, dispatches each project's highest-priority
queued items — **each as its own Trident run** (Forge→Argus→merge) — and a
morning brief reports the REAL result of every run. Neutron-Open (SQLite) port
of Vajra's `gateway/overnight-dispatcher.ts`, with the Ryan-locked correction
that each item is a Trident run, NOT a single throwaway substrate turn.

**Why:** Ryan rejected the earlier fake-copy fix — the overnight work must
ACTUALLY run, on the ported Trident, and the brief must report real results
(never invented).

- **NEW `migrations/0078_overnight_queue.sql`** — `overnight_queue` (owk-id PK,
  project scope, agent_role, priority, status, the `[context:]` hard-gate
  column, `result`, the `trident_run_id`/`trident_slug` link, `ralph`,
  lifecycle stamps) + `overnight_budget` (per-window dispatch counter). SQLite
  is the runtime source of truth; STATUS.md is the agent's rendering of it.
- **NEW `onboarding/overnight/queue-store.ts`** — typed `ProjectDb` CRUD +
  owk-id allocation (`owk-YYYYMMDD-NNN`) + the atomic per-window budget counter.
- **NEW `onboarding/overnight/status-md-sync.ts`** — the agent-maintained
  STATUS.md `## Autonomous Overnight Work` block: render-from-queue + parse
  (round-trip / hand-seed migration), the opt-in frontmatter flag, and the
  `[context:<path>]` HARD GATE (Vajra grammar, re-pointed to the per-project
  repo root: 64 KB cap, no abs paths, no `..`, symlink-escape rejected).
- **NEW `onboarding/overnight/dispatcher.ts`** — window (23:00–07:00 local) /
  budget (2 concurrent / 8 per window, env-overridable) / scan / advance /
  reporter. SCAN reconciles + gates + dispatches by creating a
  `code_trident_runs` row per item; ADVANCE polls those runs and records each
  REAL terminal result + writes `docs/overnight/<owk-id>.md` + re-renders
  STATUS.md.
- **NEW `onboarding/overnight/morning-brief.ts`** — real-results-only reporter:
  General high-level summary (counts + one line per project) + per-project
  detail (each completed item's result + each failure's reason), routed to
  bound topics with a General fallback; quiet-night = one honest line. Never
  invents.
- **NEW `onboarding/overnight/register.ts`** — `overnight_handler` (the engine)
  + production seams (real-fs STATUS.md IO + result-doc writer, the
  `TridentRunStore`-backed Trident seam with merge-mode auto-detect + context
  threading, opted-in project enumeration over `<owner_home>/Projects/`).
- **CHANGED `onboarding/wow-moment/actions/07-overnight-pass.ts`** — renamed the
  cron job `wow-overnight-<slug>` → **`overnight-<slug>`**, repointed it at
  `overnight_handler`, and changed the cadence 24h → **~30-min** (the engine
  gates window/budget/reporter internally).
- **CHANGED `gateway/composition/build-core-modules.ts`** — registers the real
  `overnight_handler` engine unconditionally, replacing the check-in stub.
- **CHANGED `onboarding/wow-moment/project-materializer.ts`** — makes the
  onboarding promise TRUE: writes `autonomous_overnight_enabled: true`
  frontmatter into every materialized project's STATUS.md AND seeds one grounded
  overnight bullet pointing at a real `docs/overnight/seed-context.md` (written
  from the synthesized project context). The engine's scan reconcile adopts it
  into a real queue row → the hard gate passes → it runs as a Trident run on the
  first overnight window.

**Tests (REAL — no bookkeeping-only):** `onboarding/overnight/*.test.ts` walk
the real dispatcher with a scripted Trident seam AND the real `TridentRunStore`:
a queued item creates a Trident run + the morning brief reports its REAL result
(asserted via the doc-on-disk at `docs/overnight/<owk-id>.md`, the queue row's
recorded `result=PR#42`, and the re-rendered STATUS.md — NOT "phase advanced");
the context-gate rejects a no-`[context:]` item; budget/concurrency caps hold;
window gating; morning-brief General-summary + per-project routing + General
fallback + never-invent-on-empty; a hand-seeded STATUS.md bullet becomes a real
queue row. `tsc` clean (only the pre-existing global `bun`-types contamination);
overnight suite 42 pass + trident suite 121 pass; onboarding 1538 pass / 0 fail.

**Known gap (Trident PR-5):** the engine creates + polls REAL `code_trident_runs`
rows, but those rows only ADVANCE end-to-end once the Trident tick loop boots on
a live `TridentDispatch` instead of `stubAdvanceDeps`. Until then a production
overnight run is created + tracked but sits at `forge-init`; the full path is
proven by the test suite driving the run to terminal through the same store the
engine polls.

## 2026-06-19 — Trident-port PR-4: Ralph spec-driven build mode (plan ⇄ task loop)

Fourth of ~5 sequential PRs. PR-2 wired the Ralph transition GRAPH into the
state machine (the `forge-init → ralph-plan ⇄ ralph-task` cycle + the
`max_ralph_rounds` cap, fully unit-tested); PR-3 wired the real Forge/Argus
substrate sessions but left the Ralph phases as a typed seam
(`TridentPhaseNotWiredError`). PR-4 wires the REAL one-task-per-fresh-context
loop into those phases — ported from Vajra's `~/.claude/skills/trident/SKILL.md`
§ "Ralph build mode (v3)" onto Open's substrate. Lineage: Geoffrey Huntley's
"ralph" loop + Spec-Kit's specify→plan→tasks→implement.

**Why Ralph:** a large, spec-driven build done in ONE Forge context drifts as
its window fills/compacts ("agent forgets what we agreed"). Ralph decomposes
the build into FRESH single-task spawns whose progress lives in FILES + git
history (`IMPLEMENTATION_PLAN.md`, `AS-BUILT.md`, commits), never a context
window — so it cannot drift. An active planning pass each iteration diffs
`SPEC.md` against the actual code, so a regressed/half-built task re-opens as a
`- [ ]` and the loop self-corrects.

- **CHANGED `trident/git-mode.ts`** — added Ralph mode DETECTION (mirrors the
  skill): `detectRalphMode(repoPath, probe, {explicit})` → a run is Ralph when
  explicitly requested OR the repo's git root contains a `SPEC.md` ("governed"
  repo). `defaultRalphModeProbe` resolves the git root via
  `git rev-parse --show-toplevel` then checks `<root>/SPEC.md` (file-existence
  injectable for tests). A throwing probe degrades to legacy (never errors run
  creation). The run-creation call site is PR-5 (the seam is exported + tested
  now).
- **CHANGED `trident/prompts.ts`** — three Ralph renderers + a planner parser:
  `RALPH_BOOTSTRAP_NOTE` (appended to `renderForgePrompt` when `run.ralph`: the
  first iteration writes `IMPLEMENTATION_PLAN.md`, builds ONLY the top task,
  reports `REMAINING_TASKS`); `renderRalphPlanPrompt` (a docs-only planning
  pass — diff SPEC vs code, rewrite the plan, emit `REMAINING_TASKS` +
  `NEXT_TASK`, NEVER rewrite SPEC); `renderRalphTaskPrompt` (a fresh Forge that
  implements ONLY the surfaced task + checks it off). New `parseRalphPlan`
  parses a planner's `REMAINING_TASKS`/`NEXT_TASK` WITHOUT requiring the PR
  contract lines (a planner does a docs-only commit). The **fail-loud guard**
  is now strict `^[0-9]+$` (new `parseStrictCount`): a garbled count → `null`,
  never coerced to 0.
- **CHANGED `trident/session.ts`** — `recordCompletion` now special-cases the
  `ralph-plan` phase: parse via `parseRalphPlan`, thread the `NEXT_TASK` to the
  following ralph-task via a new `nextTaskFor(run_id)` map (mirrors the
  argus→forge-fix `findingsFor` handoff). A planner that omits a valid count →
  `remaining: null`, which the state machine fails loudly on. (This fixed a
  latent PR-3 gap: a VALID planner output, having no PR lines, would have been
  mis-failed by `parseForgeOutput`.)
- **CHANGED `trident/orchestrator.ts`** — `spawnForPhase` now wires
  `ralph-plan` (renders the planning prompt) and `ralph-task` (renders the
  one-task prompt with the threaded `NEXT_TASK`). Every LIVE phase is wired;
  `TridentPhaseNotWiredError` is now a never-should-happen backstop (terminal
  phases are short-circuited before spawn).
- **Hand-off to review.** The state machine (PR-2) already routes
  `ralph-plan` with `REMAINING_TASKS=0` → `argus` → the PR-3 fix/merge loop.
  With the spawns wired, a governed run now actually walks plan ⇄ task until
  convergence, then reviews + merges the accumulated branch per git-mode.

### Tests (`trident/ralph.test.ts` + additions to `prompts.test.ts`)

23 new tests (121 total in `trident/`, up from PR-3's 98). `ralph.test.ts`
drives the REAL orchestrator loop with a scripted substrate that performs the
ACTUAL file side-effects a live session would (writes `IMPLEMENTATION_PLAN.md`,
checks one task off per ralph-task, appends `AS-BUILT.md`) — so the loop
converges through genuine file state and assertions hit real artifacts:
- a governed 3-task run walks forge-init → plan ⇄ task → (0 remaining) → argus
  → merge → done; final plan has every task `- [x]`, `AS-BUILT.md` records each
  built task, and exactly ONE ralph-task ran per remaining task (one task per
  fresh context) with a planning pass between each (active drift-catch).
- a bootstrap reporting 0 remaining short-circuits straight to review.
- fail-loud: a bootstrap that omits OR garbles `REMAINING_TASKS` → `failed`,
  never merged; a planner pass that omits it → `failed`, never merged.
- `max_ralph_rounds` bounds a never-converging planner → `failed` (no merge).
- `detectRalphMode`: explicit flag, governed-repo SPEC.md detection,
  ungoverned → legacy, throwing-probe degradation, and a real temp-dir probe.
`prompts.test.ts` adds strict-count rejection + `parseRalphPlan` cases + the
three render-prompt assertions.

**Verify.** `bunx tsc --noEmit` clean (0 errors). `bun test trident/` → 121
pass / 0 fail. Out of scope (PR-5): the production run-creation call site +
retire the code-gen Core wrapper. Seams left intact.

## 2026-06-19 — Trident-port PR-3: the Forge → Argus review → fix → merge loop (substrate sessions)

Third of ~5 sequential PRs. PR-2 landed the state-machine SKELETON (phase
enum, transition graph, round/ralph-round caps) with `deps.classify`
always reporting "running". PR-3 wires the REAL agentic loop into those
phases: it spawns Forge/Argus as substrate sessions, parses the verdict,
loops fix↔review to `max_rounds`, then merges per the git mode — the heart
of Trident, ported from Vajra's `/trident` SKILL.md onto Open's substrate
(no tmux, no `spawn-agent.sh`, no ScheduleWakeup — one in-process tick
loop drives every run).

- **NEW `trident/prompts.ts`** — trident-OWNED port of Vajra's
  `forge.md` + `argus.md`, adapted to Open's substrate. `renderForgePrompt`
  / `renderForgeFixPrompt` / `renderArgusPrompt`, plus the locked-contract
  parsers: `parseForgeOutput` (PR_NUMBER / BRANCH / WORKTREE + optional
  Ralph `REMAINING_TASKS`, back-walked so trailing preamble can't shadow),
  `parseArgusVerdict` (fail-safe `REQUEST_CHANGES` on unparseable output —
  never auto-merge a verdict it can't read), `parseArgusFindings`. The
  **oversized-diff guard** lives in `chooseArgusScope`: round-1 reads the
  full `<base>..HEAD` diff only under the 3000-line ceiling, else it steers
  Argus to the meaty commits + "state what you could not verify"; round 2+
  always reviews the single fix commit via `git show HEAD`. The Argus
  prompt carries the no-silent-exit invariant verbatim.
- **NEW `trident/session.ts`** — `TridentSessionManager` bridges the
  BLOCKING `TridentDispatch` (a Forge/Argus turn → terminal text, same
  shape code-gen's `buildRuntimeSubagentDispatch` produces) onto the tick's
  poll-every-tick model: `spawn(input)` records `running` SYNCHRONOUSLY and
  fires the dispatch in the background; `classify(run)` polls by
  `subagent_run_id`. Ported Vajra fixes: **no phantom-id poll** (the
  running entry is written before `spawn` returns; an empty mint throws);
  **no silent exit** (a forge-init with no contract lines surfaces as
  `crashed`, never silent success; a Ralph planner that omits
  `REMAINING_TASKS` yields `remaining: null` → the state machine fails it
  loudly). Forge PR/branch/worktree are captured in-memory and folded onto
  the row by the single-writer tick step (NOT written from the background
  dispatch — that races the tick's own `save`; this was a real bug caught
  + fixed in test).
- **NEW `trident/merge.ts`** — fills the PR-2 `cleanupAfterMerge` seam.
  `'pr'` → `gh pr merge <pr> --squash` then delete the remote + local
  branch; `'local'` → `git checkout <base>` + `git merge --no-ff <branch>`
  then delete the local branch. Ryan-locked: **NO `git worktree remove`**
  (Open uses plain branches). `detectBaseBranch` resolves `origin/HEAD`,
  defaulting to `main`.
- **NEW `trident/orchestrator.ts`** — `buildTridentOrchestrator` →
  the tick `step`: (1) spawn-if-needed (the single, `subagent_run_id ===
  null`-guarded spawn site — so a re-entrant tick never double-spawns),
  (2) poll + transition via the pure `advanceTridentRun`, (3) merge on the
  `done` transition (a merge failure routes to `failed`, recoverable).
  `computeDiffLineCount` (numstat-based, conservative-on-failure) feeds the
  oversized-diff guard. Ralph phases throw `TridentPhaseNotWiredError`
  (typed seam → PR-4) and fail the run bounded rather than spin.
- **CHANGED `trident/tick.ts`** — `TridentTickOptions` now accepts a
  `step` (PR-3's spawn+poll+merge) as an alternative to `deps` (the PR-2
  classify-only default). Boot still passes `stubAdvanceDeps`; the comment
  in `build-core-modules.ts` documents the exact `buildTridentOrchestrator`
  wiring that flips production onto the live loop once the gateway
  credential closure is threaded into a `TridentDispatch` (PR-5).
- **FIXED `migrations/runner.test.ts`** — PR-2 added migration `0077` but
  left the expected-versions list at `…76`; added `77`.

### Tests (`trident/{prompts,session,merge,orchestrator}.test.ts` — all real)

48 new tests (98 total in `trident/`, up from PR-2's 50). The orchestrator
suite drives the loop end-to-end through the real tick + store + a scripted
fake dispatch + fake git/gh seam, asserting real state transitions AND the
git/merge calls (not just "phase advanced"):
- forge-init → argus(APPROVE) → merge → done — pr mode runs
  `gh pr merge 42 --squash`; local mode does `git checkout main` +
  `git merge --no-ff` + `branch -D` and never calls `gh`.
- REQUEST CHANGES → forge-fix → argus → APPROVE → merge (round increments,
  2 forge + 2 argus turns).
- max-rounds exhaustion → failed, never merges.
- a forge-init with no contract lines → failed (crashed).
- resume safety: a re-entrant tick while the sub-agent is in flight polls,
  does NOT spawn again (dispatch called exactly once).
- oversized-diff guard: a 5000-line numstat steers the Argus prompt to the
  meaty-commits scope; a small diff lets it read the full diff.

**Verify.** `bunx tsc --noEmit` clean (0 errors). `bun test trident/` →
98 pass / 0 fail. Broader suite: the only failing test
(`tests/integration/m2-mira-v3-tangent-coverage.test.ts`, an onboarding LLM
fixture) fails identically on the base commit — pre-existing, untouched by
this PR.

## 2026-06-19 — Trident-port PR-2: state machine + tick driver + git-mode auto-detect

Second of ~5 sequential PRs porting Vajra's full Trident into Neutron Open
as **foundational runtime** (not a Core). PR-1 wired the existing code-gen
engine into the prod `/code` boot path; PR-2 lands the runtime the eventual
autonomous loop runs on: a durable state machine, an in-process tick driver
that advances it, and per-run git-mode detection. The actual Forge/Argus
sub-agent spawning is PR-3 and the Ralph one-task-per-fresh-context loop is
PR-4 — both build on the typed seams left here.

### What shipped

- **NEW migration `migrations/0077_code_trident_runs.sql`** — the SQLite
  translation of Vajra's `/trident` skill state file
  (`~/vajra/gateway/trident-<slug>.state.json`). One row per pipeline.
  Columns: `id` (uuid PK) + `slug` (the skill's per-run key, UNIQUE per
  `project_slug`); `phase` (CHECK enum: `forge-init | ralph-plan |
  ralph-task | argus | forge-fix | done | failed | stopped` — the skill's
  seven phases + `stopped` for `/trident stop`); `round`/`max_rounds`
  (Argus loop cap, default 8); `ralph`/`ralph_round`/`max_ralph_rounds`
  (Ralph flags, default cap 20); `branch`/`pr`; `merge_mode` (CHECK
  `local | pr`, default `local`); `subagent_run_id`/`subagent_status`
  (the in-flight sub-agent persisted ON the row — restart-resume — NOT in
  the disconnected generic `runtime/subagent/` registry); `repo_path`/
  `worktree`/`task`; `chat_id`/`thread_id` (delivery routing);
  `failure_reason`; `started_at`/`last_advanced_at` (ISO-8601). Indexes:
  UNIQUE `(project_slug, slug)` + a PARTIAL index on `phase` excluding the
  terminal set (the tick driver's "load non-terminal runs" query stays
  flat-cost as finished runs accumulate). `expected-schema.txt` snapshot
  regenerated.

- **NEW `trident/` workspace package `@neutronai/trident`** (registered in
  root `package.json` workspaces + deps):
  - `store.ts` — `TridentRunStore`, the CRUD wrapper over the table,
    shaped like `reminders/store.ts` (async writes via `ProjectDb.run`,
    sync reads, injectable clock). `create` / `get` / `getBySlug` /
    `listNonTerminal` / `update` (partial patch) / `save` (full snapshot,
    the shape the state machine returns) / `delete`.
  - `state-machine.ts` — `advanceTridentRun(run, deps)` + the pure
    `computeTransition`. The phase graph is ported verbatim from the
    skill: legacy one-shot `forge-init → argus`; Ralph
    `forge-init → ralph-plan → ralph-task → ralph-plan …`; `argus`
    APPROVE → `done`, REQUEST CHANGES → `forge-fix` (round++ until
    `max_rounds` → `failed`); `forge-fix → argus`. The Ralph round
    increment + `max_ralph_rounds` cap live in a single `enterRalphPlan`
    (mirrors the skill's "Spawn a Ralph planner" shared block) so a
    non-converging plan↔task loop fails loudly. The skill's "missing
    `REMAINING_TASKS` fails loudly, never silently" rule is enforced: a
    Ralph bootstrap/planner with no remaining count → `failed`, never a
    silent partial-build review. `deps.classify` is the PR-3/PR-4 seam
    (reads sub-agent outcome + spawns next phase); `stubAdvanceDeps`
    (always "running") is the PR-2 production stub.
  - `tick.ts` — `TridentTickLoop`, modelled on `reminders/tick.ts`:
    single-flight `setInterval` (default 90 s = the skill's ScheduleWakeup
    cadence), loads `listNonTerminal` each tick, advances each via
    `advanceTridentRun`, persists only on a real transition (idempotent),
    per-run try/catch so one failure can't abort the tick.
  - `git-mode.ts` — `detectMergeMode(repoPath, probe)`: `'pr'` iff a
    GitHub `origin` remote AND `gh` are both present, else `'local'` (a
    throwing probe degrades to `local`, never errors a run).
    `defaultGitModeProbe` shells `git remote get-url origin` + `gh
    --version` via `Bun.spawn` (injectable runner for tests).
    `cleanupAfterMerge` is the PR-3 merge/teardown seam — typed stub for
    both `pr` + `local` modes now.

- **Production wiring** — `gateway/composition/build-core-modules.ts`
  gains a `tridentModule` (constructs `TridentRunStore` over `input.db`,
  starts a `TridentTickLoop` with `stubAdvanceDeps`, stops it on
  shutdown), registered in `gateway/composition.ts` right after the
  reminders module — exactly the way the reminders tick is registered. The
  stub deps mean the loop is live + restart-safe but advances nothing
  until PR-3 wires the real sub-agent classifier.

### Tests (`trident/*.test.ts`, all real — DB round-trips, no mocked SQL)

- `store.test.ts` — migration applies (table exists); create/get
  round-trips every column + defaults + overrides; `getBySlug`
  project-scoping + UNIQUE-constraint rejection; partial `update`
  re-stamps `last_advanced_at`; `save` snapshot; `listNonTerminal`
  excludes done/failed/stopped, oldest-advanced first; `delete`; CHECK
  rejects an invalid phase.
- `state-machine.test.ts` — `isTerminalPhase`/`TERMINAL_PHASES`; the full
  legacy loop walk; every Ralph transition + both round caps; the
  loud-fail on missing `REMAINING_TASKS`; `advanceTridentRun`
  terminal/running/crashed/completed paths incl. sub-agent-slot clearing +
  clock stamping; `stubAdvanceDeps` never advances.
- `tick.test.ts` — advances every non-terminal run whose sub-agent
  completed; never touches terminal runs; idempotent under "running";
  `per_tick_limit` cap; one run's error doesn't abort the tick; `start`
  idempotent + `stop` safe twice.
- `git-mode.test.ts` — `isGithubRemoteUrl` https/ssh accept + non-GitHub
  reject; `detectMergeMode` truth table incl. throwing-probe → local;
  `defaultGitModeProbe` with an injected runner (pr/local discrimination);
  `cleanupAfterMerge` stub-vs-injected for both modes.

**Verify.** `bunx tsc --noEmit` clean (0 errors). `bun test trident/` →
50 pass / 0 fail. Full `bun test` green (see PR description for counts).

## 2026-06-19 — Trident-port PR-1: wire the code-gen engine into the production boot path (the foundation)

First of ~5 sequential PRs porting Vajra's full Trident into Neutron Open
as **foundational runtime**. PR-1 scope is ONLY the foundation — NOT the
Trident state machine / Ralph / multi-round Argus loop (PR-2→5).

### Investigation — what the production `/code` boot path actually wires (file:line)

**Open has no in-repo production graph composer.** The boot shell
(`gateway/index.ts:174 boot()`) composes the module graph from a composer
loaded via the `NEUTRON_GRAPH_COMPOSER_MODULE` env seam
(`gateway/index.ts:517 loadGraphComposerFromEnv`). That env points at the
**Managed** `provisioning/realmode-composer.ts`, which is NOT in this
public repo (no `provisioning/` dir; nothing exports `buildGraphComposer`
here). Open self-hosts with the env unset boot a `/healthz`-only shell
with no chat surface and no Cores.

**The Open-side seam the (absent) composer calls is
`buildCoresBackendFactories` (`gateway/boot-helpers.ts:568`).** Its
`codegen_core` factory (`gateway/boot-helpers.ts:898-911`, pre-PR-1)
returns the threaded `codegenOrchestratorFromOpts` **when present**, but
**silently falls to `buildSkeletonCodegenRunner()` when omitted**. The
skeleton runner (`cores/free/code-gen/src/backend.ts:425`) throws
`CodegenNotConfiguredError` ("install the Tier 2 Coding Core") on every
`run(...)` — so a composer that forgets to thread the orchestrator
degrades `/code` to a Tier-2 wall **even on a credentialed instance where
the real Forge → Argus → merge loop could run**.

**This is asymmetric with the Research Core**, which HARD-REQUIRES its
backend — `buildCoresBackendFactories` throws if `researchProjectBackend`
is omitted (`gateway/boot-helpers.ts:887-895`), closing the same
silent-no-op class (research Argus r1 BLOCKER #4). Codegen never got that
treatment.

**The full codegen production chain exists but is three hand-wired
pieces** (none invoked by any in-repo production code — only the absent
Managed composer + tests call them):
1. `buildCodeGenLlmCall` (`gateway/cores/code-gen-factory.ts:146`) —
   resolves the Anthropic credential (Max OAuth → BYO `NEUTRON_ANTHROPIC_API_KEY`
   → no-credential sentinel) and builds the `CodegenLlmCall` closure. SOLE
   `@anthropic-ai/sdk` importer for codegen.
2. `buildCodegenWiring` (`cores/free/code-gen/src/wiring-production.ts:105`)
   — sidecar resolver + `buildRuntimeSubagentDispatch` + `buildRuntimeCodegenRunner`
   + `CodegenOrchestrator` + `build_chat_command_context` factory.
3. `buildCodegenChatCommandFilter` (`gateway/boot-helpers.ts:511`) — the
   `/code` chat filter wrapping `parseAndExecuteCodeCommand`.
Drop any link (most easily: omit `codegenOrchestrator` from step (2)→the
backend factory) and `/code` silently degrades to the skeleton.

**Conclusion: the production `/code` path CAN run the real engine when the
composer wires all three pieces (proven by
`gateway/__tests__/code-gen-core-credential-resolution.test.ts`), but the
seam allows a silent skeleton fall-through that the diagnostic flagged.**

### Code-Gen Core inventory (for the PR-5 fold/retire decision)

Tier-1 free Core at `cores/free/code-gen/` — productizes the owner's
`/trident` skill as `/code` for chat-driven users. Public barrel:
`cores/free/code-gen/index.ts`. Modules:
- `src/manifest.ts` — Core slug + 3 SDK capabilities (`host:gh`,
  `network:github`, `agent:dispatch_subagent`) + 4 tool names.
- `src/backend.ts` — `CodegenOrchestrator` (in-memory FIFO task tracker;
  `dispatch`/`status`/`fetch`/`cancel`), the typed-error hierarchy, the
  in-memory + **skeleton** runners (`buildSkeletonCodegenRunner` →
  `CodegenNotConfiguredError`).
- `src/runtime-runner.ts` — production `RuntimeCodegenRunner`: composes
  Forge → Argus → (auto-)merge in-process via a `SubagentDispatch`
  closure + host `gh`/`git`/`bun test` runners + per-project worktree +
  sidecar. Auto-merge default-ON in S2 (`gh pr merge` on Argus APPROVE,
  audit `who_confirmed='autonomous'`). `max_argus_rounds` cap.
- `src/substrate-runtime.ts` — substrate-agnostic `CodegenLlmCall`
  closure interface + `buildRuntimeSubagentDispatch` (the multi-turn
  tool loop: Forge/Argus tool defs → handlers → LLM call). **This is the
  `dispatch_subagent` closure loop.**
- `src/tool-handlers.ts` — scoped Forge (read/write/edit/glob/grep/bash)
  + Argus (read-only + scoped bash) tool defs + handlers.
- `src/chat-commands.ts` — `/code <task>` + `/code stop|cancel` parser +
  dispatcher (`parseAndExecuteCodeCommand`); `CodeCommandContext` +
  `CodegenChatNotifier` (terminal-notification seam, declared but not yet
  called in S2).
- `src/prompts/forge-system.ts` + `argus-system.ts` — IN-TREE Forge/Argus
  system prompts + output parsers (zero host-app imports).
- `src/sidecar/store.ts` — per-project SQLite sidecar
  (`<OWNER_HOME>/Projects/<id>/code-gen/code-gen.db`): `tasks` + `audit`
  + `settings` + `transcripts`. Resolver + migrations.
- `src/worktree-resolver.ts` — per-project git worktree at
  `<OWNER_HOME>/Projects/<id>/code/`.
- `src/host-runners.ts` — `HostGh/Git/BunTest` runner interfaces +
  `buildStubHostRunners`.
- `src/wiring-production.ts` — `buildCodegenWiring` (the assembly factory).
- `src/ui/launcher-icon.ts` + `app-tab-surface.ts` — P5.3 launcher tile +
  app-tab metadata.
- `src/tools.ts` — the 4 MCP tools (`codegen_dispatch`/`_status`/`_fetch`/
  `_cancel`) over the orchestrator.

`/code` flow: chat `/code <task>` → `parseAndExecuteCodeCommand` →
`CodegenOrchestrator.dispatch` (mints task, schedules via `setImmediate`)
→ `RuntimeCodegenRunner.run` → resolve worktree → Forge sub-agent (via
`dispatch_subagent` closure loop) → write sidecar task row → Argus
sub-agent (≤ `max_argus_rounds`) → on APPROVE `gh pr merge` + audit row.
**For PR-5: fold the runtime runner + dispatch loop + prompts + sidecar +
worktree resolver into foundational Trident; retire the Core wrapper
(manifest + 4 MCP tools + launcher/app-tab) once `/code` routes through
the foundation directly.**

### PR-1 fix — consolidate the chain so the composer can't forget

NEW `gateway/cores/build-production-codegen-wiring.ts` →
`buildProductionCodegenCoreWiring(opts)`: ONE call that chains
credential-resolution → `buildCodegenWiring` → `buildCodegenChatCommandFilter`
and returns `{ codegen_orchestrator, chat_command_filter, sidecar_resolver,
runner, credential_source }`. Mirrors the Research Core's
`buildProductionResearchCoreWiring` (gateway-side, not in-Core, because
codegen's credential factory is gateway-side). REUSES the existing
`wiring-production` factory — no duplication. The composer threads
`codegen_orchestrator` into `buildCoresBackendFactories({ codegenOrchestrator })`
and `chat_command_filter` into the app-WS surface in a single step,
eliminating the drop-a-link drift.

Also hardened the flagged fall-through: `gateway/boot-helpers.ts:898-911`
now `console.warn`s LOUDLY when `codegenOrchestrator` is omitted
(mirroring the Tasks-composer guardrail, Argus r2 BLOCKING #2), pointing
at the new entrypoint. The skeleton STAYS (it is the legitimate Tier-1
safe-install shape for Open self-hosts that never wire codegen —
`install_ok` must stay TRUE); we only made the silent degrade observable.

### Tests

- **NEW** `gateway/__tests__/code-gen-core-prod-wiring-real-runner.test.ts`
  (3 tests): boots `composeProductionGraph` through
  `buildProductionCodegenCoreWiring` and asserts `/code <task>` dispatches
  through the REAL runtime runner — Argus APPROVEs, `gh pr merge` fires
  once for PR #42, durable sidecar task + audit rows written. A SKELETON
  CONTROL wires the same graph to a skeleton orchestrator and asserts ZERO
  merges + ZERO sidecar rows — proving the real-path assertions
  discriminate (the guard FAILS against the pre-fix skeleton path). A
  no-credential test proves the entrypoint still returns a REAL
  orchestrator whose `/code` short-circuits with the friendly install hint
  (`no_credential`), NOT the skeleton Tier-2 wall.

**Verify.** `bunx tsc --noEmit` clean (0 errors). `bun test cores/free/code-gen/`
→ 106 pass. `bun test gateway/__tests__/code-gen-core-*` + `cores-composition`
+ `code-gen-factory` → 33 pass (incl. the 3 new). Full `bun test gateway/`
green except pre-existing flake (see STATUS).

## 2026-06-19 — Onboarding OPENING flow fix (signup double-ask + phantom buttons)

Two live-reproduced go-live blockers in the onboarding opening (the prod
LLM-router path: `phaseSpecResolver` + `llmRouter`, NOT the prod-dead
`promptDriver`).

### BUG 1 — signup double-asked the name (wouldn't advance on a bare "Ryan")

**Root cause.** Signup advancement on the prod path depended on the LLM
router classifying the typed name as `advance`, but `PACK_SIGNUP.advance_examples`
was empty `[]`, so the router classified a bare name as `amend` (it volunteers
a fact) or a low-confidence `answer`. Those fell to the generic amend/answer
tails in `dispatchRouterDecision`, which persisted `user_first_name` but
re-emitted + STAYED on signup → the second name-ask. The deterministic
name-guard (`extractAgentNameFromFreeform` → `sanitizeUserFirstName`) only ran
on the non-router `consumeChoice` path (tests), never in prod.

**Fix (primary).** `onboarding/interview/engine.ts` — new
`tryAdvanceSignupFromRouter` helper invoked at the top of
`dispatchRouterDecision` for `state.phase === 'signup'` on `amend`/`answer`.
When a valid `user_first_name` is present (from the whitelisted `state_delta`,
already persisted on `phase_state`, or extractable from the freeform via the
existing name helpers), it builds the synthetic `__freeform__` choice and routes
through `consumeChoice` — the same path the working `advance` branch and the
unit test use — so signup → `instance_provisioned` → `ai_substrate_offered`
fires. Returns `null` (falls through to normal handling) when there is no name
signal, so genuine tangents ("why do you need my name?") still get their FAQ
answer and unparseable replies still hit the clarify-reprompt guard. The
amend-key whitelist (`whitelistRouterStateDelta`) runs on this path too, so the
bookkeeping-key security gate is preserved.

**Fix (defense-in-depth).** `onboarding/interview/phase-spec-resolver.ts` —
populated `PACK_SIGNUP.advance_examples` with bare-name exemplars ("Ryan",
"Sam Doe", "call me Jane", "I'm Alex" → advance) so the router itself classifies
a name as `advance`.

### BUG 2 — "Tap one of the buttons above" with NO buttons rendered

**Root cause.** `emitButtonsOnlyNudge` always sent `BUTTONS_ONLY_NUDGE_TEXT`
("tap one of the buttons above…") even when the resolved spec came back
option-stripped — a text bubble promising buttons that don't exist.

**Fix.**
1. `onboarding/interview/interaction-mode.ts` — new
   `NO_BUTTONS_FALLBACK_NUDGE_TEXT = "Just reply here to continue."`.
2. `onboarding/interview/engine.ts` — `emitButtonsOnlyNudge` now resolves the
   live spec FIRST and sends the button-free fallback copy when the spec has no
   options (a `message_override` validator reason still wins), so the nudge copy
   always matches the rendered button state.
3. `onboarding/interview/phase-spec-resolver.ts` — `materializeSpec` hardening:
   an option-bearing phase never resolves option-less. If the LLM resolver drops
   the options a phase structurally needs, the static fallback's options are
   restored (a non-empty subset from the LLM is preserved — only a full drop is
   repaired).

### Tests — closed the test-path gap that let this ship green

- **NEW** `onboarding/interview/__tests__/signup-router-prod-path.test.ts` —
  wires the PROD path (a REAL `LlmRouter` via `buildLlmRouter` backed by an
  in-memory `FixtureAnthropicClient`, plus the real `PACK_SIGNUP`) and drives
  `advance("Ryan")` through the REAL router classification (not a stubbed
  decision). Asserts signup ADVANCES (name captured, not re-asked) on `amend`
  and `answer` classifications, that a genuine tangent does NOT over-advance,
  and that `PACK_SIGNUP.advance_examples` is now non-empty. These advance
  assertions FAIL on pre-fix code and PASS with the fix.
- **UPDATED** `interaction-mode-routing.test.ts` — the buttons-only enforcement
  test now asserts the nudge copy MATCHES the resolved button state
  (`BUTTONS_ONLY_NUDGE_TEXT` when options render; `NO_BUTTONS_FALLBACK_NUDGE_TEXT`
  when option-less — e.g. `persona_reviewed` without a wired `personaComposer`).
- **UPDATED** `engine-router-integration.test.ts` — the two amend-whitelist
  security tests reflect the new signup behavior: a name-bearing amend now
  auto-advances (bookkeeping keys still rejected, attacker `active_prompt_id`
  never lands); the all-rejected test uses a non-name freeform so it stays on
  signup (preserving the stay-path whitelist coverage).
- Existing `signup-asks-name.test.ts` stays green.

**Verify.** `bunx tsc --noEmit` introduces no new genuine errors (the
pre-existing 66 are a dual-worktree `@neutronai/*` → sibling-clone aliasing
artifact; the one added line in the new test is the identical `stubPlatform`
PlatformAdapter aliasing the two sibling router-test files already exhibit).
`bun test onboarding/interview/` → 981 pass / 35 skip / 0 fail. Full `bun test`
→ 7187 pass / 90 skip / 0 fail.
