# M1 Adversarial E2E — Round 3 (convergence sweep) — Findings

Date: 2026-06-29 · Base: `main` @ 6c64637 · Method: 5 parallel adversarial
code-path hunters across the long tail, each finding grounded in `file:line` and
verified before assertion. Three real, user-facing bugs fixed (one PR each, NOT
merged); the rest documented below.

## Verdict: BUGS_FOUND → 3 PRs (no merge)

| # | Bug (severity) | PR |
| - | -------------- | -- |
| 1 | Slash-command results + `error` frames render nowhere on the chat clients → typing spinner spins forever and `/note` `/remind` `/cal` `/skills` output is lost on web (and dropped on native). Both surfaces. (HIGH) | #110 |
| 2 | Recurring reminders unreachable via the agent: `reminders_create` had no recurrence field yet SKILL.md told the agent to pass one → silent one-shot + false "every week" confirmation. (MEDIUM-HIGH) | #111 |
| 3 | An OpenAI key pasted at the `claude setup-token` step passed the length-only check and was silently mis-stored as the Claude substrate credential + falsely advanced → later premium-model calls fail with no paste-time error. (silent corruption) | #112 |

Each PR's Codex cross-model review surfaced at most one P2 (HTTP-fallback command
result for #110; snooze recurrence-preservation for #111); both fixed in-PR. #112
came back clean.

## Prior 5 fixes — confirmed present in main + no regressions found
#105/#106 (reminder + project-reminder live-delivery to app-ws), #107 (import
watcher re-arm on reconnect), #108 (onboarding finalize unions chat-named
projects), #109 (whitespace-only message decode/worker trim parity). The targeted
hunters re-verified the relevant areas intact (e.g. #109 trim parity symmetric on
both transports; #105/#106 brief + reminder delivery on `app:<owner>`).

## Deferred / documented (named, NO PR) — for Ryan's triage

### Architectural cluster — the app-ws adapter is built with NO durable `chat_log` (`open/composer.ts` `new AppWsAdapter`)
This single root cause makes several "wired" features inert. Worth a deliberate
decision (wire `chat_log`, or accept the limitations for M1):
- **Double-dispatch guard is inert (HIGH).** `ingestUserMessage` short-circuits to
  `was_new: true` when `chat_log === undefined`, so the surface idempotency gates
  never trip. The retry button (`app/lib/chat-state.tsx` re-sends the same
  `client_msg_id`) and the WS→HTTP fallback can RE-RUN the agent turn — duplicate
  replies, double LLM spend, double side effects (the agent holds Bash/Write/Edit).
  A contained alternative to wiring `chat_log`: a transport-level seen-`client_msg_id`
  cache in the surface.
- **Reconnect mid-turn orphans the reply (MEDIUM).** `replayAfter` returns `[]`,
  `session_ready` carries no `last_seen_seq`, and the app-ws `on_session_open`
  never re-emits the latest reply (the legacy landing surface has
  `reEmitActiveSeedPromptIfAny`; app-ws doesn't). A reply emitted during a socket
  blip is persisted to `button_prompts` but never live-pushed → looks like a hang.
- `resume` / `receipt` / `reaction` / `edit` frames decode + route but are globally
  inert (their logs are unwired) — if the UI exposes those taps they silently no-op.

### Reminders / proactive
- **Morning brief fires on a hardcoded `America/Los_Angeles` 7am** (`gateway/proactive/morning-brief.ts` defaults; `open/composer.ts` never threads a timezone) → non-Pacific owners get the brief at the wrong local hour. (LOW-MEDIUM)

### Credentials / error-handling
- **Disconnecting a BYO OpenAI key doesn't evict it from the memoized credential pool** (`gateway/realmode-composer/memoize-credential-pool.ts` invalidates only on `.env` mtime / all-cooldown) → the deleted key keeps being used until restart. Google OAuth disconnect is immediately effective (no in-memory cache). (MEDIUM, security-motivated)
- **Web client swallows `error`-frame text** — fixed in #110 (was: spinner cleared, nothing shown).
- **Uncaught surface throws return bare-text `500`, not JSON** (OAuth disconnect / api-key set+delete re-throw on a DB fault; top-level backstop returns `"Internal Server Error"`) → JSON clients render a blank failure. (LOW-MEDIUM)
- **Non-atomic credential writes** — OpenAI key rotation is delete-then-add (a failed add destroys the working key); OAuth connect writes 3 rows non-transactionally (a mid-write fault can persist access-without-refresh → `getStatus` reports connected but the first refresh fails). (LOW)
- **Oversize WS `user_message` (>16,384 chars) reports `malformed_envelope`** instead of a `body_too_long` matching the HTTP path. (LOW, diagnostics)
- **Two devices, different platforms:** doc-link scheme is resolved once via the last-registered platform and fanned to all devices, so one device gets undispatchable links. (LOW-MEDIUM)

### Onboarding
- **OpenAI-embeddings-key CAPTURE wired nowhere** (the headline of #112's area): `storeOptionalKey`/`detectOptionalKey` have no production callers; the consumer in `open/composer.ts` is live. #112 stops the silent corruption; the full capture-wiring needs an `ApiKeyStore` threaded through the engine deps + `build-landing-stack` + composer (it writes a secrets row AND an `api_keys` table row the consumer reads) and end-to-end verification on a real instance. Tracked follow-up.
- **Synthesis import result is in-process only:** a gateway restart between the synthesis job's DB `completed` flip and the engine's next poll yields a "successful" import with zero projects (`build-synthesis-import-runner.ts` holds results in a Map; no resume row). Narrow restart race. (LOW-MEDIUM)
- OpenAI-key offer activation copy overpromises ("the key alone enables it") — compounds the dead capture; correct after wiring it.

### Memory / recall (largely sound post-#96/#97)
- **80-char extraction floor** (`scribe/scribe-budget.ts` `SCRIBE_MIN_CHARS`) drops terse single-fact turns ("Co-founder: Jane Park, ex-Stripe") from structured memory — they stay in `message_search` history but never become an entity page. Tuning value lifted from Nova's Telegram threshold; too high for a personal-memory product. (MEDIUM, tuning)
- **No boot-time backfill of on-disk `entities/*.md` into gbrain:** pages written while the gbrain binary was missing are invisible to `gbrain_search` forever (the agent can still grep the files). (LOW-MED)
- **`gbrain_search` is not surfaced in the live-agent prompt** (steers to filesystem grep); project-topic turns omit `entities/` entirely → the semantic layer is underused. (LOW, prompt tuning)
- **Import `source` citation clobbered on first chat-touch** (`scribe/write-to-gbrain.ts` overwrites `source` over merged frontmatter; `mention_count`/`category` are preserved). (LOW)

## Verified-CLEAN areas (no manufactured bugs)
Phase state machine + legal transitions; multi-project additive naming;
concurrent/late/solicited uploads; ChatGPT + Claude export parsers; synthesis is
real (not a placeholder); rapid-fire turn serialization (`turnChains`); code-block /
markdown pass-through; malformed-WS-frame structured errors; chat-history JSON
errors; entity scribe write→gbrain→durable-recall loop; recurring tick reschedule
(weekly +7d, floor at now+60s, no double-fire); brief compose + LLM-less fallback;
idle-nudge intentionally not registered in Open; Google OAuth disconnect; Open
chat-topics surface hardcodes `unread_count: 0` (fake-unread is managed-only).
