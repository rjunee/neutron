# AS_BUILT

Running log of what shipped, newest first. One entry per merged change.

## 2026-07-23 — /reset chat command: clear the live session's model context via CONTEXT_RESET_COMMAND under the turn mutex

Branch `trident/reset-chat-command` (new PR vs main). Ports task 4 of the input-modalities-commands work — deliberately left UNBUILT in PR #428 because the originally-planned primitive was verify-before-assert'd as WRONG.

- **WHY the respawn primitive was wrong (verified finding).** `respawnSupervisedSession` (`runtime/adapters/claude-code/persistent/supervision.ts` → `session-respawn.ts`) ALWAYS `--resume`s the same transcript ("respawn is always resume") — it PRESERVES context, so using it for `/reset` would be a no-op-that-looks-done. Ryan pinned the design 2026-07-23: `/reset` should behave like sending Claude Code's own `/clear` to the live REPL — clear the MODEL's conversation while the underlying `claude` process (its MCP servers / dev-channel / system prompt) stays alive.
- **The right primitive:** `CONTEXT_RESET_COMMAND = '/clear'` (`signatures.ts:164`), actuated exactly as the per-turn import warm-session reset does (`pool.ts:372-402`, holding the `acquireTurn` mutex).
- **NEW `runtime/adapters/claude-code/persistent/context-reset.ts`** — `resetPooledSessionContext({substrate_instance_id, user_id, project_scope, acquire_wait_ms?, idle_quiet_ms?, idle_max_ms?})`. Prefix-matches warm `pool` entries (`pool-state.ts`) on the first three `SESSION_KEY_SEP`-joined key dimensions (credential dimension WILDCARDED — resolved per-dispatch); the trailing NUL guarantees the 3-dim prefix can't false-match a legacy 2-dim key. For each live session: BOUNDED-acquire the turn mutex (`Promise.race` against `acquire_wait_ms`); if the timeout wins, self-release the still-queued slot via `fireAndForget(acquireP.then(r => r()))` so a later turn is never wedged, and return `busy` having written NOTHING; else, under the mutex, run the `pool.ts:378-385` sequence verbatim (`waitForReplIdle` → `child.write('/clear\r')` → sleep → `waitForReplIdle`). Typed outcome: `{ok, sessions_reset} | busy | no_live_session | reset_failed`.
- **`gateway/boot-chat-command-filters.ts`** — `buildResetChatCommandFilter({reset})` mirroring `buildStatusChatCommandFilter` exactly: `isExactSlashCommand(body, '/reset')` word boundary (`/resetfoo`/`/resets` fall through to the LLM), injected reset thunk, reply text composed from the LIVE outcome via exported `formatResetOutcome` (never a canned success — `busy` / `no_live_session` reply honestly that nothing was cleared). `busy` / `reset_failed` carry a structured `error`; `no_live_session` is informational text with no `error`. Re-exported (fn + `ResetChatOutcome` type) via `gateway/composer-contract.ts` → served through the `gateway/boot-helpers.ts` barrel.
- **`open/composer.ts`** — builds `resetChatCommandFilter` next to `statusChatCommandFilter`, binding the thunk to `resetPooledSessionContext` with `substrate_instance_id: 'cc-agent-' + owner_handle` (matches `open/wiring/substrates.ts` `liveAgentSubstrate`), `user_id: OWNER_USER_ID`, `project_scope: input.project_id ?? 'general'` (mirrors `build-live-agent-turn.ts` `turn.project_id ?? 'general'` — the live pool's project dimension). Appended to `buildChainedChatCommandFilter([...])` after `statusChatCommandFilter`, so BOTH the web onboarding chat and the app-ws chat route `/reset` through one path. No `late<T>` holder — all deps exist at chain-build time.
- **Documented limitation (deliberate non-goal):** when NO warm session exists for the scope (e.g. right after a gateway restart, before any turn), `/reset` replies `no_live_session` honestly — but a later cold spawn may `--resume` the prior transcript from the repl-registry, so context is not cleared in that edge. Full cold-reset semantics would need registry surgery on the respawn-is-always-resume machinery, out of scope per Ryan's pinned live-session design.
- **Tests:** NEW `gateway/__tests__/reset-command-wiring.test.ts` (claims `/reset`; outcome-derived reply + typed `data`; project_id threading + omission; whitespace/trailing-args tolerance; `/resetfoo`/`/resets`/prose fall through AND never invoke the reset thunk; busy/no_live_session/reset_failed → correct text + `error` shape; chained-last wiring; `formatResetOutcome` variants). NEW `runtime/adapters/claude-code/persistent/__tests__/context-reset.test.ts` — REAL PTY-write behavior (harness cloned from `import-warm-session-reset.test.ts` with a controllable reply gate): warm turn → reset writes exactly one literal `'/clear\r'` AFTER the message and the process survives (spawnCount 1, subsequent turn completes); scope isolation (proj-A reset never touches proj-B; cold scope → no_live_session); busy path (mid-turn reset → busy, writes nothing, then a later turn still runs — proving the abandoned mutex slot self-released); wait-then-proceed (generous budget rides out the turn then clears); empty pool → no_live_session.
- **Gates:** `bunx tsc --noEmit` clean; `bash scripts/ci/lint.sh` all gates green (incl. the void-promise gate for the detached self-release); `bash scripts/ci/depcruise.sh` 0 new violations (baseline untouched). Regression: `import-warm-session-reset.test.ts` + `status-command-wiring.test.ts` green. NO FEATURE FLAGS.

## 2026-07-22 — Dogfood PR #429 Argus r2 on task 10: budget-floor clamp (unrunnable sub-floor deep-research budget) + unbound chat-ack dedup collision + Sonnet dispatcher default

Branch `trident/dogfood-fixes-jul21` (PR #429). Argus round-2 raised one CONFIRMED major (codex veto) + one code-verified minor + two non-blocking nits on the task-10 tool loop. Fixes (all additive, NO feature flags):

- **MAJOR — `budget_ms < ~20s` deterministically failed deep research with a misleading zero-tool error.** The agentic loop reserves `FINALIZE_MARGIN_MS` (20s) of every budget for the forced final-answer turn, so any `budget_ms` below that made the sub-agent finalize on iteration 1 with ZERO tool calls; with `tools_available: true` that trips the orchestrator's grounding gate and fails the whole run with "sub-agent made zero tool calls" whose REAL cause is an unrunnable budget. `budget_ms` was exposed unvalidated on the MCP `research_deep` surface. FIX: new `SUB_AGENT_MIN_BUDGET_MS = 60_000` floor (`cores/free/research/src/manifest.ts`); `dispatchResearchSubAgent` (`sub-agent.ts`) now resolves `budget_ms` robustly (non-finite / non-positive → default, never poisoning `Math.max`/`setTimeout`) THEN clamps UP to the floor. The floor covers BOTH the outer `runWithTimeout` race and the inner dispatch (shared `budget_ms`), so the loop always has room for ≥1 real tool round + the finalize turn. Added an injectable `min_budget_ms` DI-default seam (like `now`) so timeout-path tests still drive tiny budgets; production never sets it.
- **MINOR — unbound `build_dispatched` acks collided on one dedup key.** `work-board/chat-ack.ts` keyed dedup on `${item_id}\0${kind}`; a chat-dispatched build with no board item posts `item_id: ''`, so every unbound build within the 30s window shared `\0build_dispatched` and the 2nd distinct build's ack was silently swallowed. FIX: key is now `${project_id}\0${item_id}\0${kind}\0${title}` — different unbound builds (different titles) each ack; a genuine double-fire of the SAME event still dedups; cross-project events no longer collide.
- **NIT cleanup — `buildRuntimeResearchSubAgentDispatcher` `default_model` fallback was `FAST_MODEL`** (dead on the live path — `sub-agent.ts` always threads Sonnet), contradicting task-7's Sonnet-for-deep-research intent. Changed to `SONNET_MODEL`; removed the now-unused `FAST_MODEL` import + stale comments.

The two remaining r2 nits (grounding gate counting failed tool calls as grounding; the same finalize-margin behavior described above) are intended-per-spec / covered by the floor and left as-is.

Tests: `cores/free/research/__tests__/sub-agent.test.ts` +5 (below-floor clamp; at/above-floor passthrough; omitted→default; non-finite/non-positive→default; `min_budget_ms:0` seam) + 3 existing fast-timeout tests updated to pass `min_budget_ms:0`. `work-board/chat-ack.test.ts` +3 (two unbound different-title builds both post; same unbound build dedups; cross-project empty-item events not suppressed). Green: `bun test cores/free/research work-board` 502 pass / 2 skip / 0 fail; `tsc -p cores/free/research` + `tsc -p work-board` exit 0. NO FEATURE FLAGS.

## 2026-07-22 — Dogfood PR #429 Argus r1 BLOCKER on task 10: cancel a timed-out research sub-agent dispatch so it stops burning LLM/tool resources after its concurrency slot is released

Branch `trident/dogfood-fixes-jul21` (PR #429). Argus round-1 raised one CONFIRMED BLOCKER on the task-10 tool loop (corroborated by a second reviewer's finalize-race nit): `runWithTimeout` (`cores/free/research/src/sub-agent.ts`) is a bare `Promise.race` with NO cancellation, and its `finally` releases the concurrency slot on timeout — but the underlying agentic `dispatch()` loop (`substrate-runtime.ts`) had no abort signal, so an `llm_call` resolving AFTER `budget_ms` kept running: it would parse the response, execute the requested tool, and issue the forced-finalize `llm_call` — all under a slot a NEW job had already claimed. The per-owner concurrency/budget guarantee was broken (an orphaned run could burn a second slot's worth of LLM + tool calls indefinitely).

FIX — cooperative cancellation via `AbortSignal` (additive, no feature flag):
- **`cores/free/research/src/sub-agent.ts`** — `RuntimeSubAgentDispatchInput` gains additive-optional `signal?: AbortSignal`. `dispatchResearchSubAgent` now creates an `AbortController`, threads `controller.signal` into `dispatch()`, and calls `controller.abort()` in the `finally` (alongside `release()`). The `finally` fires on timeout, error, AND success — on timeout this is exactly what tells the orphaned loop to stop; on success/error the dispatch has already settled so the abort is a harmless no-op. The canned dispatcher ignores the field → byte-identical.
- **`cores/free/research/src/substrate-runtime.ts`** — new exported `SubAgentDispatchAbortedError`. The emulated tool loop now calls a `throwIfAborted()` guard (a) at the top of every round (prevents issuing the next `llm_call` / forced-finalize turn after a tool result), and (b) immediately after each `await opts.llm_call(...)` resolves (prevents parsing + tool-execution + any further round on a call that only completed AFTER the outer race already tripped). The thrown rejection is discarded by the outer `Promise.race` (which already rejected with `SubAgentTimeoutError`); its only job is to halt the loop. The v1 tool-less single-call path is untouched (byte-identical).

Single-reviewer minors/nits from r1 (budget_ms ≤ FINALIZE_MARGIN_MS round-0 forced finalize; the intended zero-tool grounding behavioral change; forced-turn tool_call-envelope-as-text; partial-executor rider mismatch) are all non-production-reachable / "bounded and safe" / intended-per-spec and are NOT defects — left as-is.

Tests: `cores/free/research/__tests__/substrate-runtime-tool-loop.test.ts` +T9 (signal aborted while an `llm_call` is in flight → loop throws `SubAgentDispatchAbortedError`, executes NO tool, issues NO second `llm_call`) +T10 (already-aborted signal → zero `llm_call`s, throws immediately). `cores/free/research/__tests__/sub-agent.test.ts` +2 (outer budget timeout releases the slot AND aborts the signal handed to the dispatcher; successful dispatch also aborts the signal on completion — idempotent cleanup). Green: `bun test cores/free/research` 209 pass / 2 skip / 0 fail; `tsc --noEmit -p tsconfig.json` exit 0. NO FEATURE FLAGS.

## 2026-07-22 — Dogfood PR #429 task 10: agentic tool loop in the research_deep sub-agent dispatcher (real vault/web tool grounding)

Branch `trident/dogfood-fixes-jul21` (PR #429). Discovered-root-cause follow-up to task 7. WHY: `research_deep`'s production sub-agent dispatcher (`buildRuntimeResearchSubAgentDispatcher`) was the v1 single-call adapter whose own docstring said "tool-calling is deferred" — it always returned `tool_calls: []` + `tools_available: false`, while the Atlas system prompt (`sub-agent-prompt.ts`) MANDATES research_vault_search/research_web_search/research_web_fetch use. So even on Sonnet (task 7), deep research was closed-book: every claim could only be `confidence:"unverified"`. ROOT-CAUSE CONSTRAINT (planner-verified): native Anthropic Messages-API `tools`/tool_use blocks are impossible here — production `llm_call` is `buildResearchLlmCallForOwner` (`gateway/boot-research-wiring.ts:53-84`) packing system+user into `AgentSpec.prompt` on the CC-subprocess substrate, whose `respondToTool` THROWS (`gateway/wiring/build-llm-call-substrate.ts:915,922`), and direct Anthropic HTTPS is forbidden (`build-anthropic-messages-client.ts:12-20`).

FIX — EMULATE the tool protocol over sequential text `llm_call` rounds (NO feature flags; real default):
- **`cores/free/research/src/substrate-runtime.ts` — the loop.** New exported types `ResearchSubAgentToolExecutor` / `ResearchSubAgentToolExecutors`; new consts `DEFAULT_MAX_TOOL_ROUNDS=6`, `TOOL_RESULT_MAX_CHARS=30_000`, `FINALIZE_MARGIN_MS=20_000`, exported markers `TOOL_CALL_BLOCK_MARKER`, `TOOL_RESULT_BLOCK_MARKER(name)`, `FINALIZE_MARKER`. Options extended (all additive/optional): `tool_executors`, `max_tool_rounds`, `now`. The dispatcher advertises a strict JSON envelope `{"tool_call":{"tool","input"}}` in a module-level `toolProtocolRider(offered)` appended to the sub-agent system prompt (per-tool input-shape hints; plain hyphens, no em dashes), executes the named executor via the injected map, threads a `[TOOL_RESULT <name>]` block into the next round's user prompt (`extractJson`-parsed each round), and loops until the model emits the final brief JSON. Bounded by `budget_ms` (a `FINALIZE_MARGIN_MS` pre-check per round forces the final-answer turn) + `max_tool_rounds` (forced `[FINAL ANSWER REQUIRED]` last turn). Unknown-tool + throwing-executor + `{error}`-returning-executor all thread an error result and record `success:false` while the loop continues; oversized results truncate to `TOOL_RESULT_MAX_CHARS` with a `...[truncated N chars]` suffix. Returns real `tool_calls` + `tools_available: true`. When NO executors are supplied (or none of the requested tools have one), it makes ONE tool-less `llm_call` returning `tool_calls: []` + `tools_available: false` — byte-identical v1 back-compat (degradation, not a flag). Outer `dispatchResearchSubAgent` `runWithTimeout` still races the whole dispatch against `budget_ms`; the internal margin lets the loop self-finalize first.
- **`cores/free/research/src/sub-agent.ts`** — `RuntimeSubAgentDispatchInput` gains additive-optional `project_id` (per-project scoping for tool executors); `dispatchResearchSubAgent` threads `input.project_id` into the dispatch call. `ResearchSubAgentToolCall` shape unchanged.
- **`cores/free/research/src/wiring-production.ts`** — builds the three REAL executors and threads them: `research_vault_search` (resolves the project sidecar via the SAME `ResearchStoreResolver` + runs `searchPriorBriefs`), `research_web_search` (`buildTavilyProvider` + `webSearch`; key re-read PER DISPATCH from a new `tavily_api_key` getter; graceful no-key degradation message), `research_web_fetch` (`webFetch` with its `DEFAULT_WEB_FETCH_ALLOWLIST` + SSRF/DNS-pin guards intact). Each executor is TOTAL (outer try/catch → `{error}`; bad-shape input → `{error: 'invalid input: ...'}`). Manifest now resolves BEFORE the dispatcher. New additive options: `tavily_api_key`, `web_search_fetcher`, `web_fetch_fetcher`, `web_fetch_lookup` (test seams).
- **`gateway/cores/mount-open-cores.ts`** — threads `tavily_api_key: () => input.secretsStore.get({ owner_handle: ownerHandle, kind: 'byo_api_key', label: 'tavily' })` into `buildProductionResearchCoreWiring` (re-read per dispatch → a key pasted in Settings lands without restart).
- **`cores/free/research/index.ts`** — exports the new executor types + loop consts/markers.

This ARMS task 7's zero-tool grounding gate in production: a deep run that goes straight to the brief (zero tool calls) now retries once then fails by design.

Tests: new `cores/free/research/__tests__/substrate-runtime-tool-loop.test.ts` (T1 envelope→executor→threaded-result→final; T2 round cap → 3 llm calls; T3 budget cap → 2 llm calls via injected `now`; T4 unknown tool; T5 throwing executor; T6 v1 back-compat single call; T7 offered-intersection-empty → v1 path; T8 truncation cap); new `cores/free/research/__tests__/wiring-production-tools.test.ts` (real vault round through `deep()` completes + threads `{"hits":[]}`; web_fetch allow-list reject; tavily-absent degradation; tavily-with-key hits via a stub fetcher); UPDATED `gateway/__tests__/research-core-production-composer.test.ts` (harness `llm_call` scripts a vault tool round on the Atlas first turn so the now-armed gate is satisfied). Green: `bun test cores/free/research` 205 pass / 2 skip / 0 fail; `bun test gateway/__tests__/research-core-production-composer.test.ts gateway/__tests__/research-core-mcp-default-project-and-lazy-resolve.test.ts gateway/__tests__/cores-integrations-surface.test.ts` 26 pass / 0 fail; `tsc -p cores/free/research` + `tsc -p gateway` exit 0. Pre-existing depcruise `cores-use-sdk-only` edges (`sub-agent.ts`/`email/tools.ts`/`code-gen` → `runtime/models.ts`, from tasks 7/8) and the task-2 void-promise gate finding are unchanged by task 10 (no NEW layering violation; +4 cruised deps). NO FEATURE FLAGS.

## 2026-07-22 — Dogfood PR #429 task 8: de-hardcode 4 Claude model-id literals through runtime/models.ts resolver

Branch `trident/dogfood-fixes-jul21` (PR #429). Ryan: 'that's bad design' — `runtime/models.ts` docstring says 'never hardcode a Claude model id outside this file', yet 4 code literals escaped the resolver. Tasks 1–7 already fixed the 2 research-core literals in task 7. These 4 remain:

- **`tasks/prioritize-llm.ts` — `DEFAULT_TASK_PRIORITIZE_MODEL`.** Was `'claude-haiku-4-5'` (bare literal); now `= FAST_MODEL` (imports `@neutronai/runtime/models.ts`). Exported const is preserved; used at `:137` and re-exported via `tasks/index.ts:55`. `tasks` already declared `@neutronai/runtime` in its package.json — no dep change. LIVE-DEFAULT NOTE: `gateway/composition/build-core-modules.ts` passes `model` only when config supplies one; composition that omits the model key gets this default. Live behavior changes `'claude-haiku-4-5'` → `FAST_MODEL` (`'claude-haiku-4-5-20251001'` by default, `NEUTRON_FAST_MODEL`-overridable). Both ids carry identical pricing rows in `model-pricing.ts:106,:115` — benign.
- **`gateway/tasks/p6/nudge-engine.ts` — `DEFAULT_NUDGE_MODEL`.** Same pattern. Was `'claude-haiku-4-5'`; now `= FAST_MODEL`. Same live-default note as above.
- **`cores/free/email/src/tools.ts` — `resolveModel()` fallback.** Was `return m ?? 'claude-haiku-4-5-20251001'`; now `return m ?? FAST_MODEL`. Default is byte-identical (`FAST_MODEL` resolves to `'claude-haiku-4-5-20251001'`). Import shape mirrors `research-orchestrator.ts:17` (the CI-green cores-band precedent). `email` package.json already declared `@neutronai/runtime`.
- **`cores/free/code-gen/src/substrate-runtime.ts` — `buildCannedCodegenLlmCall` default model.** Was `model: chosen.model ?? 'claude-sonnet-4-6'`; now `= SONNET_MODEL`. Added `"@neutronai/runtime": "workspace:*"` to `cores/free/code-gen/package.json` dependencies (alphabetical, after `@neutronai/prompts`); ran `bun install` to update lockfile.

DO-NOT-TOUCH honoured: the 3 `'claude-haiku-fallback'` DI sentinels (`mcp-tools-extra.ts:146`, `calendar-wiring.ts:223`, `mount-cores-scribe-fan-out.ts:300`) — confirmed benign per-call DI-default placeholders; comments in `auth/max-oauth.ts` and `model-update-watchdog.ts`; `config/index.ts:52-55` VERBATIM-FIDELITY defaults table.

Tests (4 new test blocks, all compare against the IMPORTED const, never a re-hardcoded literal): `tasks/__tests__/prioritize-llm.test.ts` — `DEFAULT_TASK_PRIORITIZE_MODEL === FAST_MODEL`; `gateway/tasks/p6/__tests__/nudge-engine.test.ts` — `DEFAULT_NUDGE_MODEL === FAST_MODEL`; `cores/free/email/__tests__/tools.test.ts` — `email_triage` with `deps.model` absent → `triage.model === FAST_MODEL`; `cores/free/code-gen/__tests__/substrate-runtime.test.ts` — canned response with no `model` field → returned `result.model === SONNET_MODEL`. Green: `bun test tasks cores/free/email cores/free/code-gen gateway/tasks` 568 pass / 0 fail; `tsc -p tasks/email/code-gen/gateway` all exit 0; eslint clean.

## 2026-07-22 — Dogfood PR #429 task 6: chat text-input lag — make the web chat render fan-out identity-stable

Branch `trident/dogfood-fixes-jul21` (PR #429). Ryan dogfooding: typing in the web chat text box feels laggy, not snappy like Telegram. ROOT CAUSE (planner render-count probes against the REAL installed `@assistant-ui/react` 0.14.23; the earlier "profile first" framing is satisfied by this evidence): `landing/chat-react/controller.ts` `computeVm()` rebuilt FRESH `RenderMessage` objects (`durable.map(...)`) AND a fresh `messages` array on EVERY `publish()` — 20 call sites, including PER STREAMING TOKEN (`agent_message_partial`). assistant-ui caches its message→ThreadMessage conversion by message OBJECT identity and memoizes each row on it; a fresh identity every publish busted BOTH, so probes measured all 30/30 rows re-converted + re-rendered per publish (vs 0 with stable identities) → a full un-memoized react-markdown re-parse of the WHOLE transcript per token/frame. That main-thread load is the typing lag. REFUTED as the cause: keystroke fan-out through the assistant-ui composer store (0 message re-renders) and parent re-renders alone (assistant-ui memoizes rows internally). Fix (all web, NO feature flags — single live path):

- **`controller.ts` — computeVm is now IDENTITY-STABLE, content byte-identical.** New `private renderCache = Map<string, RenderMessage>`. Each `computeVm` builds each durable row candidate exactly as before, then reuses the PRIOR object (`renderCache.get(id)`) when a total flat comparator `sameRenderMessage(prev, next)` says they're structurally equal, writing the chosen object into a fresh `nextCache` (which auto-prunes vanished ids); live stream bubbles are cached the same way under `stream:<messageId>` (a token append changes `text` → new identity, correct; an unrelated publish mid-stream reuses the bubble). After building the `messages` list, if the PREVIOUS vm's array is the same length with every element reference-equal, the PRIOR array is reused (guarded — the first computeVm runs from the constructor before `this.vm` exists). `sameRenderMessage` is a module-level TOTAL comparator: `===` on every scalar field + flat length/element compares for `attachments` / `reactions` / `options` / `uploadAffordance` (no JSON.stringify, no deep recursion) — a false "equal" would freeze a real update, so it covers every field the VM emits. Outputs are unchanged; ONLY object identities change, so the existing `controller.test.ts` stays green untouched.
- **`ChatApp.tsx` — render-stable context values + selector-ized composer.** Extracted exported hooks `useUploadsCtx(config, fetchImpl)` (memo on `[token, origin, fetchImpl]`) and `useDocLinkCtx(origin, onOpenDocLink)` (memo on `[origin, onOpenDocLink]`; `onOpenDocLink` is a verified-stable `useCallback` at ProjectShell.tsx). Previously both were fresh object literals per render, and a context value change BYPASSES `React.memo` straight into every `AttachmentImage`/`TextPart`. The `Composer` now subscribes to a BOOLEAN selector `useComposer((s) => s.text.trim().length > 0)` and reads the live text imperatively in `send()` via `composerRuntime.getState().text` — so a keystroke re-renders the composer subtree only when the Send button's enabled state flips (empty↔non-empty), not on every character.
- **`Markdown.tsx` — `React.memo` + memoized `components`.** The component export is wrapped in `memo` (an agent bubble whose `text` is unchanged now skips the react-markdown re-parse entirely) and the per-render `components={{pre, a}}` object is hoisted into a `useMemo` keyed `[onDocLink, origin]`. The module-const remark/rehype plugin arrays were already stable.
- **Tests — new `landing/chat-react/__tests__/render-isolation.test.tsx` (4 groups, 7 cases).** T1 (pure controller): an unrelated `projects_changed` publish keeps the SAME `messages` array + every row identity; a streaming token changes the array + ONLY the stream bubble, reusing every durable row; a `reaction_update` changes EXACTLY that row, siblings reused. T2 (end-to-end over the REAL `useChatRuntime` + controller under `AssistantRuntimeProvider` + `ThreadPrimitive.Messages` with counting message/part components, 20 messages): an unrelated frame → 0 durable-row re-renders; 3 streaming tokens → total row re-renders bounded by a small constant (≤15) and 0 for every durable row, NOT O(transcript). T3: `useUploadsCtx`/`useDocLinkCtx` return reference-equal values across host re-renders with unchanged inputs, new identity on input change. T4: `Markdown.$$typeof === Symbol.for('react.memo')` + stable DOM across a parent re-render. Green: `bun test landing/chat-react` 405 pass / 0 fail (398 prior + 7 new; controller/component/snapshot-stability suites untouched); `tsc -p landing/chat-react` + eslint clean. `useNeutronChat.ts` (the #354 adapter memo + SEV1 per-conversation runtime keying) untouched. NO FEATURE FLAGS.

## 2026-07-22 — Dogfood PR #429 task 5: per-project opening variance — de-template the kickoff opening_message prompt + has_context-first work-signal gate

Branch `trident/dogfood-fixes-jul21` (PR #429). Ryan dogfooding: some newly-created projects opened with a rich, project-specific starting-plan presentation while others got a generic hardcoded opener, and the rich ones all read like the same message with the nouns swapped. TWO verified root causes, both fixed here.

- **PROMPT CONVERGENCE (`gateway/wiring/build-project-kickoff-composer.ts`).** The `opening_message` system prompt mandated a fixed 3-beat sentence plan including the verbatim beat "that you took a first pass and drafted a starting document, and invite the owner to review it and tell you what to change" — so every opener was that template with nouns swapped. Rewrote the branch to KEEP the hard invariants (output only the message text, 2-3 sentences, second person, grounded ONLY in context / no invented facts, mention the drafted doc so the appended tappable link lands, no links/filenames, no greetings, no em dashes) but BAN stock template phrasing + a fixed sentence order and instruct leading with THIS project's most specific content, so two projects never read alike. The comment block now marks the beats FUNCTIONAL, not verbatim-mandated. Token budget, timeout, `userPrompt()`, and the draft_doc/interest_brief prompts are untouched.
- **GATE STARVATION (`onboarding/openings/kickoff.ts`).** `hasWorkSignal()` required open_threads OR summary/slices OR (rationale AND topics) — strictly divergent from the materializer's own data-sufficiency verdict `MaterializeOutcome.has_context` (`project-materializer.ts` = importCtx || slices; importCtx = `hasRealProjectContext`, which counts the owner's OWN captured `project.rationale`). That owner-stated rationale never reaches `KickoffSignal` (only import-derived `matched` carries rationale — `finalize.ts`), so an owner-described work project with no import match had `has_context=true` yet failed the gate and fell to the generic deterministic opening, while an import-matched sibling got the rich starting-plan doc — Ryan's exact variance. `KickoffSignal` now carries `has_context` (from `input.outcome?.has_context ?? false`); `hasWorkSignal` checks it FIRST as the single source of truth, and loosens the outcome-null fallback rationale AND topics → OR (aligned with `hasInterestSignal`). A bare deterministic-template README with no outcome and no import signal STILL does not qualify — the "better nothing than a bad job" line holds, and `has_context:false` projects keep the honest no-context prompt via `buildNoContextProjectOpening`.
- **Tests (`gateway/wiring/__tests__/build-project-kickoff.test.ts`).** Existing helpers default `has_context:false` + `matched:null`, so the thin-work→null non-regression anchor stays green unchanged. Added: work project with has_context alone (owner-described, matched:null, zero slices/summary/threads) → draft-doc; rationale-only match with NO materializer outcome → draft-doc (the AND→OR loosening); and an opening_message prompt-contract test on the REAL `buildProjectKickoffComposer` via a capturing fake client — asserts the OLD mandatory beat is gone, the vary-phrasing instruction + appended-link note are present, and the call rides `OPENING_MESSAGE_MAX_TOKENS`. Green: `bun test gateway/wiring` 613 pass / 0 fail; `tsc -p onboarding` + `tsc -p gateway` + `tsc -p open` clean; eslint clean. NO FEATURE FLAGS.

## 2026-07-22 — Dogfood PR #429 Argus r2 round-3: chat-ack dedup-ordering + cumulative correction-pattern occurrences + astral-safe title truncation

Closes the three surviving Argus round-2 findings on the task-4 branch (the BLOCKER + minor #4 + nit #5 were already resolved in commit `8b5cad1f`; this round takes the two remaining majors + the truncation nit).

- **`work-board/chat-ack.ts` (major): dedup stamp now recorded AFTER a successful post, not before.** The dedup memo `lastPostedAt.set(key, t)` previously ran *before* `resolve_chat_id` + `post`; since the whole body is try/catch-swallowed, a throw in chat-id resolution or transport left the `(item, kind)` entry stamped with no ack ever delivered — muting every retry for the full 30s window. Moved the stamp to run only after delivery returns, so a failed attempt leaves no stamp and an in-window retry can still land once transport recovers.
- **`scribe/reflect/correction-patterns.ts` + `reflect-pass.ts` (major): promoted correction-pattern pages keep a CUMULATIVE occurrence count/list.** `writeEntity` renders `compiledTruth` as a full replacement, so recomposing the page from the current scan window alone shrank an already-promoted page's `Observed N times` count + `## Occurrences` list whenever an older occurrence aged out of the window (the timeline itself was preserved by the writer's append+dedupe, but the human-readable body regressed). `composePatternPage` now takes an optional `priorOccurrences` (the existing page's persisted `reflect:correction-pattern` timeline rows, keyed `<ts>\x1f<body>` byte-identical to `correctionOccurrenceKey`) and UNIONs them into the count + timestamp list; `reflect-pass.ts` finds the existing page first and feeds its rows in. Learning/title/why still derive from the newest current member; timeline rows are still emitted for the current cluster only (no double-write — the writer dedupes).
- **`work-board/chat-ack.ts` (nit): `truncateTitle` measures + slices by code POINTS (`Array.from`), not UTF-16 code units** — an astral char (emoji) straddling the cut index no longer yields a lone surrogate before the ellipsis.
- **Tests.** `work-board/chat-ack.test.ts`: failed-post leaves no dedup stamp (retry re-delivers, then the success dedups); failed-resolve leaves no stamp; astral-heavy title truncates with no unpaired surrogate. `scribe/__tests__/correction-patterns.test.ts`: prior persisted rows unioned into count+list; a prior row already in the window isn't double-counted; no-prior path byte-identical to old behavior. Green: `bun test work-board scribe` 431 pass / 0 fail; `tsc -p work-board` + `tsc -p scribe` clean. NO FEATURE FLAGS.

## 2026-07-22 — Dogfood PR #429 task 4: deterministic chat ack when chat-dispatched work hits the board (+ doctrine spoken-ack)

Branch `trident/dogfood-fixes-jul21` (PR #429). Ryan dogfooding: dispatching work from a project chat pops the Work pane instantly but the CHAT stays silent — so it looks like nothing happened. ROOT CAUSE (verified): the live agent is a warm Claude Code REPL whose ONLY chat output is the dev-channel `reply()` tool — exactly ONE per turn, landing at TURN END (`runtime/adapters/claude-code/persistent/dev-channel-impl.ts`; Stop hook `hooks/enforce-reply.ts`; a 2nd reply is turn-id-rejected). A chat-dispatched INLINE job runs INSIDE that turn (doctrine `gateway/wiring/operating-doctrine.ts`) for up to 45 min (`gateway/wiring/build-live-agent-turn.ts` TURN_ABSOLUTE_CEILING_MS), while the card fires `work_board_changed` immediately via the store's `onChange` — so the pane updates but chat is silent until the turn settles, and a spoken ack depended entirely on the model choosing to speak. There is no per-block/mid-turn text delivery to fix (terminal text is invisible by design), so the fix is a deterministic out-of-band post.

- **NEW `work-board/chat-ack.ts` — `buildWorkBoardChatAck({ resolve_chat_id, post, now?, dedup_window_ms? })`.** A tiny side-effect-only poster the AGENT-TOOL layer calls the moment a chat-dispatched board mutation succeeds, putting a short agent-style one-liner into the originating chat RIGHT AWAY — independent of the turn's own reply(). Three kinds: `card_added` (`▸ On the Work Board: "…"`), `build_dispatched` (`⑂ Build dispatched: "…" — running autonomously; the result will post here when it lands.`), `inline_started` (`› Working on "…" now — I'll post here when it's done.`). NEVER throws (whole body try/catch-swallowed — the ack must never perturb a tool result). Per-`(item_id, kind)` 30s dedup (a reconciliation/double-fire can't double-post the SAME event; DIFFERENT kinds for one item — add→dispatch in a turn — both post). Titles > 96 chars truncate to 95 + `…`. Stale memo entries pruned lazily per post.
- **Agent-tool hooks (agent surface ONLY, `work-board/agent-tool.ts`).** `registerWorkBoardToolSurface` opts gains `chatAck?`. `work_board_add` posts `card_added` after a SUCCESSFUL create (both the specDoc and plain-store branches); a validation-failed add posts nothing. `work_board_update` reads the row BEFORE the update and posts `inline_started` ONLY on an `inline_active` false→true flip (true→true and inline-less patches post nothing). Absent `chatAck` → byte-identical to before.
- **Trident build-tool hooks (`trident/work-board-build-tool.ts`).** `TridentBuildToolDeps` gains `chat_ack?`. `work_board_dispatch_build` + `work_board_start` post `build_dispatched` AFTER a successful `dispatchBoardBoundBuild` (title from the bound item via `deps.work_board.get`, else the first line of `task` truncated). A REJECTED/underspecified/unknown dispatch posts NOTHING — the agent must ask the clarifying question (#337 covers that path).
- **Composer wiring (`open/composer.ts`), DI presence NOT a feature flag.** ONE shared `buildWorkBoardChatAck` instance built from `tridentDeliveryChatId` (project_id → chat topic) + `buildClarifyPoster.post?.` (the #337 durable+live app-ws seam — persists AND fans live "exactly like a normal agent reply"; `.post?.` dereffed at fire time so late-binding is a safe no-op). Threaded through `gateway/composition/input/misc-input.ts` (`work_board?.chat_ack`, `trident_build_dispatch?.chat_ack`) + `build-core-modules.ts` into both tool surfaces. Open always wires it; NO env gate. Human HTTP work-board adds and the ▶ HTTP route post nothing (they never call it); cron/reminder tool calls with null project_id acking into General is accepted.
- **Doctrine (`gateway/wiring/operating-doctrine.ts`).** Appended one sentence to the always-rendered board principle (`DOCTRINE_PRINCIPLES[5]`): the automatic confirmation is mechanical, so the agent's own reply must STILL acknowledge the work in its voice — what it's doing, how it runs (inline now vs a dispatched autonomous run), and that results will post here. `BUILD_ROUTING_DOCTRINE` unchanged.
- **Tests.** New `work-board/chat-ack.test.ts` (exact text per kind + truncation, resolver receives project_id incl. null→General, same-(item,kind) suppressed / different-kind not / different-item not / after-window reposts / custom window, injected clock, throwing post + throwing resolver swallowed). Ack seams in `work-board/agent-tool.test.ts` (both add branches, validation-fail no-post, inline false→true posts / true→true no-post / no-inline_active no-post, omitted ack no-throw) and `trident/work-board-build-tool.test.ts` (dispatch_build ok → title, rejected/unknown no-post, start ok → title, omitted ack unchanged). Doctrine test pins the spoken-ack sentence. Green: `bun test work-board trident gateway/wiring` 1323 pass / 0 fail; the four task-4 files 68 pass; `bun test gateway/composition open` 536 pass (1 pre-existing environmental flake — the memory_health `/healthz` test times out under concurrent load with Ollama unreachable; passes 2/2 in isolation). `tsc -p work-board/trident/gateway/open` clean; depcruise clean (new `trident → work-board/chat-ack` edge rides the existing package edge, no new cross-band violation).

## 2026-07-22 — Dogfood PR #429 Argus review of the seed-eviction fix: two BLOCKERs (occurrence-key trailing space + personality-suggester lost update)

Branch `trident/dogfood-fixes-jul21` (PR #429). Argus reviewed the persisted-cluster-identity fix (commit `90f99e18`) and raised two CONFIRMED (2-reviewer) BLOCKERs; both fixed here.

- **BLOCKER — occurrence-key truncation stranded a trailing space, silently defeating the seed-eviction fix (`scribe/reflect/correction-patterns.ts`).** `occurrenceBody` = `truncate(oneLine(...), 500)` with NO trailing trim: a 500-char cut landing right after a space kept the trailing space in the LIVE occurrence key, while every disk path (`runtime/entity-format.ts` render, `extractTimeline`, `mergeTimeline`) `.trim()`s the row body. So for any correction whose one-lined `<wrong> → <right>` exceeds 500 chars, the live key never byte-matched the key reconstructed from the persisted page, `resolveClusterSlug`'s occurrence overlap fell to 0, the fallback slug drifted after seed eviction, and a duplicate/orphan concept page was minted on the live 6h reflect pass — reintroducing the exact identity drift `90f99e18` closed. FIX: `.trim()` after truncate so the live key is symmetric with the persisted (trimmed) row on both sides. One-line change; the persisted-identity mechanism is otherwise unchanged.
- **BLOCKER — background personality-suggestion upsert could regress onboarding phase + resume-window timer via a lost update (`onboarding/interview/live-personality-suggestions.ts`, `onboarding/interview/sqlite-state-store.ts`, `onboarding/interview/state-store.ts`).** The live suggester's fire-and-forget task reads state, runs an up-to-45 s LLM call, then `upsert`s a `phase_state` patch stamping `phase` + `advanced_at` from its STALE pre-call read. The store's UPDATE wrote `phase`/`last_advanced_at` UNCONDITIONALLY (the phase_state MERGE was already safe — it re-reads inside the txn), so a turn that advanced/completed onboarding while the call was in flight got stamped back to the stale phase. FIX: new `preservePhaseAndTimer` flag on `UpsertOnboardingStateInput` — when set AND the row exists, `upsert` preserves the row's CURRENT `phase` + `last_advanced_at` (read inside the same write) while still landing the patch; the caller-supplied `phase`/`advanced_at` become a fallback used ONLY when the row must be re-INSERTed. Applied to both `SqliteOnboardingStateStore` and `InMemoryOnboardingStateStore`; the suggester's write now passes `preservePhaseAndTimer: true`. No CAS/rollback complexity; a foreground write (which owns the transition) omits the flag and is unchanged.
- **Tests.** `scribe/__tests__/correction-patterns.test.ts` — new 500-char-boundary describe: the live key has no trailing space and equals the key rebuilt from the persisted timeline-row body (both RED pre-fix). `scribe/__tests__/reflect-pass.test.ts` — new pass-level seed-eviction-at-the-boundary test (>500-char shared body; ONE page, no duplicate at the drifted slug — RED pre-fix, verified). New `onboarding/interview/__tests__/state-store-preserve-phase-timer.test.ts` (both store impls): a stale background write with the flag does NOT regress a concurrent advance and still lands its patch; without the flag it DOES clobber (proves the flag is load-bearing); absent-row falls back to INSERT. Suites green: `scribe/__tests__/{correction-patterns,reflect-pass}.test.ts` 54 pass; `bun test onboarding/interview` 564 pass; `tsc --noEmit` clean.

## 2026-07-22 — Dogfood PR #429 Argus r2 round-2: correction-pattern slug BLOCKER + personality anchor/fingerprint hardening

Branch `trident/dogfood-fixes-jul21` (PR #429). Argus round-2 raised a CONFIRMED (2-reviewer) BLOCKER on the correction-pattern slug plus three single-reviewer minors/nits on the live personality suggester. Note on scope: reviewer B measured PR #429 at 8,532 insertions / 72 files — that was against a stale local `main`; the executor-mode subsystem (`reminders/ritual-registration.ts`, `runtime/backlink-repair.ts`, `tools/approval.ts`, migration 0107) landed on `main` via #426/#427 and is NOT in this branch's diff. Against `origin/main` the branch is 2,077 insertions / 21 files. The out-of-scope executor findings (`ApprovalManager.cancelPending` returning true for an already-expired row; `backlink-repair` `stats.repaired` over-count) live in files this branch does not touch — logged for whoever owns those files, not fixed here.

- **BLOCKER — correction-pattern slug was NOT window-invariant, and same-slug collisions silently dropped occurrences (`scribe/reflect/correction-patterns.ts`, `scribe/reflect/reflect-pass.ts`).** The interim `stablePatternSlug` derived identity from the digest of the tokens present in a MAJORITY of the cluster's CURRENT `right`-field members. "Majority over current membership" is a function of which members are in the 200-scan window, so as members age in/out the majority set shifts and the slug moves for the SAME lesson (reviewer's counterexample: `right` of `alpha beta`/`alpha gamma`/`beta gamma` → majority {alpha,beta,gamma}; swap one member for `gamma delta` → {alpha,gamma} → different slug → duplicate/orphan page). FIX (a): `stablePatternSlug` now derives from the cluster SEED (its oldest member) alone — the digest of the seed's sorted, de-duplicated `right` vocabulary. `clusterCorrections` already seeds each cluster on its oldest member and later occurrences JOIN it, so the seed is a membership-INDEPENDENT anchor; adding/removing non-seed members no longer moves the slug. (Honest bound: not absolutely window-invariant — if the seed itself ages out, the next-oldest becomes the seed, but its `right` is near-identical by the same premise, so the slug is stable in practice and strictly more so than either prior scheme. The over-claiming "WINDOW-INVARIANT" comments were corrected across both files.) FIX (b): `promoteCorrectionPatterns` now MERGES qualifying clusters that derive the same slug into one page BEFORE writing. Two distinct clusters (low full-text Jaccard, never clustered together) can share a seed `right` vocabulary → same slug; without merging the first cluster's create succeeded and the second hit a CAS conflict (`ifBodyEquals: null` vs the now-existing page) and its occurrences were silently dropped forever, never self-healing. Merging appends both clusters' timeline rows to one page (rows dedupe on `(ts,source,body)`).
- **minor — personality anchor race (`onboarding/interview/live-personality-suggestions.ts`).** A pick RENDERED on turn N could fail to settle `agent_personality` when tapped on turn N+1 if a mid-turn signal change regenerated the memo to a different personalized set in between (`candidatePersonalityAnchorNames` unioned only the CURRENT memo, so the tapped name was no longer an anchor). FIX: new append-only `personality_character_anchor_history` phase_state key accumulates every name ever persisted as an `'llm'` memo; `candidatePersonalityAnchorNames` unions it, so any previously-rendered name still anchors after a regeneration. Written in `maybeKickoff`'s persist path (de-duped, case-insensitive).
- **nit — `signalsFingerprint` was array-order-sensitive.** `['a','b']` vs `['b','a']` produced different fingerprints, forcing an avoidable ~45s Opus regeneration of a frozen memo. FIX: sort copies of `primary_projects`/`non_work_interests` before stringify (the fingerprint tracks WHICH signals are known, not their storage order); the caller's arrays are untouched.
- **nit — stale comment in `onboarding/interview/onboarding-preamble.ts`** claimed the personality option renders "just the name" while the code renders `- name (why)`; comment corrected.
- **Tests.** `scribe/__tests__/correction-patterns.test.ts` — new discriminating test (majority set shifts while the seed is constant → slug unchanged) + caller-ordering invariance. `scribe/__tests__/reflect-pass.test.ts` — new same-slug-distinct-clusters MERGE test (two clusters, one page, all six occurrences preserved). `onboarding/interview/__tests__/live-personality-suggestions.test.ts` — anchor-history union + malformed-history tolerance + fingerprint order-invariance + history accumulation-across-regeneration. Suites green: `scribe/__tests__/correction-patterns.test.ts` + `scribe/__tests__/reflect-pass.test.ts` 42 pass; `bun test onboarding/interview` 561 pass; `tsc -p scribe` + `tsc -p onboarding` clean.

## 2026-07-21 — Dogfood task 2: wire the REAL Opus personality suggester into the LIVE (Path-1) onboarding

Branch `trident/dogfood-fixes-jul21` (Ralph task 2 of the 2026-07-21 dogfood-night plan, PR #429). The live CC-session onboarding rendered the SAME five static personality names (`DEFINED_PERSONALITY_CHARACTERS`) to every owner, because the Opus-backed `PersonalityCharacterSuggester` (built at `open/composer.ts:1284`) was only consumed by the retired phase machine (`engine-spec-resolution.ts`) — never by the live per-turn step guard. This wires the personalized suggester into the live path WITHOUT ever blocking a turn on the 45s call.

- **New coordinator (`onboarding/interview/live-personality-suggestions.ts`).** `buildLivePersonalitySuggestionCoordinator({suggester, stateStore, owner_slug, seed, fireAndForget})` returns `guardCharacters(phase_state)` (memoized picks `[...personalized, ...wild]` or null → caller keeps the static default) and `maybeKickoff(user_id, st)` (never throws, never awaited). Kickoff fires a background generate iff `agent_personality` is unsettled AND ≥1 real signal is present AND (no memo OR memo not `'llm'` OR fingerprint changed) AND no pending run for this user (per-user `Map` dedup, cleared in `.finally`). Only `source==='llm'` results persist; a fallback persists nothing (next turn retries — mirrors the old engine's stored-but-never-frozen rule). Before writing, the task RE-READS the row (avoid stale-phase clobber, the Codex-P1 lesson) and skips if the row vanished or personality settled meanwhile; the upsert preserves `last_advanced_at` (resume-window timer). Memoizes into the SAME `phase_state` keys the old path uses (`personality_character_suggestions` + `..._source`) PLUS a new `..._fingerprint` (`JSON.stringify([name, projects, interests])`) so picks REGENERATE when the owner's signals change (Path-1 collects them incrementally; personality is asked LAST, so LLM picks land in time) and FREEZE once an `'llm'` memo matches. Also exports `computeSuggesterSignals`/`signalsFingerprint`/`hasAnySignal`/`readLiveCharacterMemo`/`candidatePersonalityAnchorNames`.
- **`personality-character-suggester.ts`** — exports `FALLBACK_CHARACTER_NAMES` (both diverse-fallback pools' names; the pools stay module-private).
- **`onboarding-preamble.ts`** — `StepGuardOptions` gains optional `personality_characters`; `StepGuardCopy.lines(ctx)` receives the set to render (the composer's memoized Opus picks, or the static `DEFINED_PERSONALITY_CHARACTERS` default when absent — byte-identical pre-suggester behavior), rendered as `- name (why)` (parens, never em dashes). The preamble goal-4 no longer enumerates a fixed list; it directs the agent to offer EXACTLY the archetype list named in the per-turn `<onboarding_required_steps>` PERSONALITY block (personalized to this owner), keeping the "Something else (I'll describe it)" escape. `DEFINED_PERSONALITY_CHARACTERS` stays the guard default; `DEFINED_PERSONALITY_CHARACTER_NAMES` stays exported.
- **`button-backed-answer.ts`** — the personality anchor (was the static 5 names) is now `candidatePersonalityAnchorNames(input.phase_state)` (static ∪ 16 pool names ∪ memoized picks), so a tap OR typed answer against ANY rendered list (static, diverse-pool fallback, or LLM picks) still deterministically settles `agent_personality`. The import-decision menu shares no character name, so the two steps stay mutually exclusive anchors.
- **`open/composer.ts`** — builds the coordinator after `onboardingStateStore` (seed = `project_slug`) when `personalityCharacterSuggester !== undefined`; inside `onboardingContext` it calls `maybeKickoff(user_id, st)` then reads `guardCharacters(st.phase_state)` and threads the result into `buildOnboardingStepGuardFragment` options. The generate is never awaited on the turn path. NO feature flag.
- **Tests.** New `__tests__/live-personality-suggestions.test.ts` (zero-signal → no generate; signal → generate once + concurrent dedup; llm → persists the 3 keys with re-read phase + preserved `advanced_at`, guard returns the 5 picks in order; fallback → no persist + retry; fingerprint freeze vs regenerate on a new interest; settled/settled-meanwhile → no kickoff/no write; suggester rejection swallowed; anchor union = static 5 ∪ 16 pool ∪ memo). Updated `onboarding-preamble.test.ts` (guard renders the supplied set exactly / static default when absent; preamble references the guard block, no static enumeration) and `button-backed-answer.test.ts` (tap of a memoized Opus name; tap of a pool name with no memo; typed descriptor after a dynamic menu; import options never anchor personality). `bun test onboarding/interview` 561 pass (was 555 at task-2 land; +6 across the Argus r2 hardening rounds); `tsc -p onboarding` + `tsc -p open` clean. NOTE: reachability (a fresh-install live onboarding turn actually rendering the Opus picks) is verified on the box during the dogfood pass, not in jsdom.

## 2026-07-21 — #380 round-3: React chat-client blank-screen CLASS fix — root auto-recovery + full pane guard sweep

Branch `trident/dogfood-fixes-jul21` (Ralph task 1 of the 2026-07-21 dogfood-night plan). Ryan still hit full-app blank screens on doc-fetch 503s AFTER PR #417 (which guarded DocumentsTab only). Root cause (per `landing/chat-react/__tests__/doc-pane-unmount-503.test.tsx` header): a setState-after-unmount surfaces in a real browser commit as React's teardown-phase invariant ("Tried to unmount a fiber that is already unmounted"), thrown from React's OWN commit/teardown phase — so it BYPASSES every error boundary (`PaneErrorBoundary`, `ChatErrorBoundary`, which only catch RENDER errors) and React unmounts the WHOLE root → blank until manual reload. Per-continuation guards are whack-a-mole; this adds the CLASS fix (a root-level net) plus finishes the guard sweep.

- **Part A — root auto-recovery (`landing/chat-react/main.tsx`).** `createRecoveryPolicy({ maxRecoveries: 3, windowMs: 60_000, now? })` — a pure, unit-tested bounded crash policy (rolling window, timestamps pruned outside it). `mount(rootEl, mountConfig, policy, opts?)` calls `createRoot(rootEl, { onUncaughtError })` (React 19.1); the handler consults the policy and SCHEDULES recovery on a macrotask (never synchronously from React's error path): on 'remount' it tears down the dead root, clears the container, and remounts with the SAME controller + OPFS store (both live outside React, so the transcript + session survive); on 'fatal' it paints a VISIBLE error card with a Reload button (`.car-fatal` / `.car-fatal-reload`, styled in `chat-react.html`). A silent blank is now impossible. `performRecovery` + `createRecoveryPolicy` + `mount` are exported for tests. StrictMode kept; `boot()`'s config/store/controller construction untouched.
- **Part B — unmount-guard sweep.** Applied the DocumentsTab alive-ref + abort-reads pattern to every remaining async continuation that touches setState: `IntegrationsTab.tsx` (loadCodex/connect/disconnect/archived/restore/saveKey/clearKey) and `SettingsTab.tsx` (codex status/connect/disconnect, creds list, settings GET/PATCH, add/remove credential, rename, emoji, archive) — both now hold a `mountedRef` + `abortRef`, thread an abort signal into GET reads via a `withSignal` wrapper (writes never aborted), and bail every continuation on `!mountedRef.current`. `ChatApp.tsx` — added alive-ref guards to `TopicRail`'s create-project continuation and `ChatSurface`'s history-import upload continuation (progress + then + catch). Audited and confirmed already-safe (no change): `work-activity.tsx` (subscription unsub + timer cleanup), `PlansPane.tsx` (timer cleanup + synchronous summary callback), `WorkBoardTab.tsx` (already fully `aliveRef`-guarded), `useAttachmentDraft.ts`/`useNeutronChat.ts` (Root-owned / no in-hook setState-after-unmount), `tab-overflow.tsx`/`HtmlDoc.tsx`/`DocSidebar.tsx` (no async setState continuations).
- **Tests (discriminating — each goes RED when its half of the fix is reverted; jsdom cannot reproduce the browser fiber invariant, so they pin the defensive contract, per the doc-pane-unmount-503 standard).** New `__tests__/root-recovery.test.tsx` (7): policy window math (3 remounts then fatal; budget refills after the window; defaults); `performRecovery` 'remount' clears + calls remount, 'fatal' paints the card + Reload button and does NOT remount; `mount()` renders through the onUncaughtError-configured root. New `__tests__/settings-tab-unmount.test.tsx` (3): a credential DELETE settling after unmount does NOT refetch the list (RED if the `mountedRef` guard is removed), an in-flight creds READ is aborted on unmount (RED if the abort cleanup is removed), and a load failure while mounted degrades to the pane-local error while siblings survive. New `__tests__/integrations-tab-unmount.test.tsx` (2): in-flight integrations READ aborted on unmount, load failure degrades locally. All existing pane tests stay green.
- **Round-2 (Argus BLOCKER — concurrent-error root-recovery race).** The `onUncaughtError` handler was inlined in `mount()` and closed over a single `root`; two pane 503s settling within the same macrotask tick each recorded a crash and scheduled a recovery, so recovery #2 wiped and orphaned the root that recovery #1 had just remounted (leaked React root + duplicate controller subscription). Fixed by extracting `buildUncaughtErrorHandler(policy, schedule, ctx)` (`main.tsx`) with a per-root `recovering` guard: the first uncaught error records + schedules; every subsequent error for that root is ignored (its recovery is already in flight and will remount a fresh root with its own fresh handler). One error → one recovery. The factory also makes the decision→schedule→`performRecovery` seam directly unit-testable. Added 3 handler-level tests to `root-recovery.test.tsx` (now 10): records+schedules exactly once then clears+remounts; **DISCRIMINATING** — two errors before the tick collapse to ONE record/schedule/remount (RED without the guard); a 'fatal' decision routes to the visible card and does not remount. Also documented the bounded (≤`maxRecoveries`), harmless stale-VM-subscriber note in `mount()`'s docstring (React 19 no-ops setState on unmounted, so a lingering closure can't loop/crash). `landing/chat-react/` suite 397 pass; `tsc -p landing` clean. NOTE: the browser-only teardown invariant is still jsdom-unobservable — #380 stays OPEN until a real-browser repro-then-not-repro on the box.

## 2026-07-21 — Executor-mode reminders: CLOSE Argus r2 round-2 BLOCKER — bundled rituals had no approval/scheduling path (`rituals_enable`)

Branch `trident/executor-reminders-p2` (PR #427). Argus round-2 found (codex-corroborated, independently confirmed against code) that the three bundled rituals (`morning-brief`/`evening-wrap`/`daily-delta`) were seeded + registered at boot but **permanently unusable**: `rituals_propose` refuses their ids (`exists_on_disk`/`duplicate_id` — the seeded `.md` already exists + the def is already registered), the only `requestRitualApproval` caller lived inside `propose`, and `readSchedule` needs an `<id>.def.json` that `seedBundledRituals` never writes (it writes `.md` only). Net: an owner asking to enable `morning-brief` had NO path — the ritual could never be approved, never scheduled, never fired. Closed by adding the missing ENABLE path.

- **New `RitualRegistrationService.enable(id, schedule)`** (`reminders/ritual-registration.ts`). Takes ONLY the id + schedule (the prompt/surface/scope are owned by the already-registered def): resolves the registered def, re-runs the same content guards over the LIVE seeded/owner `<id>.md` bytes (NFC-normalize, reject bidi/zero-width/C0, refuse empty/over-16KiB), never-clobber-guards on an existing `<id>.def.json` (`already_enabled`), writes ONLY the `<id>.def.json` (the seeded `.md` is never written or clobbered), then requests the SAME content-hash-bound owner approval `propose` does. New error codes `unknown_ritual` / `missing_prompt` / `already_enabled`.
- **Shared approval tail.** The register + `requestRitualApproval` + emit-both-prompts + full-rollback block was extracted from `propose` into one `requestApprovalAndEmit({ def, normalized, schedule, register, cleanup })` helper that both `propose` (`register:true`; rollback unregisters + rm's both files) and `enable` (`register:false` — never unregister a bundled def; rollback rm's ONLY the `.def.json`) call — identical approval prompt, content-hash binding, and grant/file rollback. No behavior change to `propose` (its 26 existing tests still pass).
- **Wired end-to-end (`done` = reachable).** New `rituals_enable` MCP tool: `cores/free/reminders/package.json` manifest entry (id + schedule input schema, `write:reminders_core.db`), `TOOL_NAMES` (`manifest.ts`), `RemindersRitualService.enable` + `RemindersBackend.enableRitual` + impl (`backend.ts`), `buildExtraTools` handler (`mcp-tools-extra.ts`) — X2 lockstep so `install-bundled` doesn't hard-fail `manifest_incomplete`. `RitualEnableInput` exported from both barrels. Manifest now declares **9** tools.
- **Tests.** `reminders/ritual-registration.test.ts` — 7 new: `propose` REFUSES a bundled id (proves enable is the required path); `enable` writes ONLY the `.def.json` + mints ONE content-hash-bound grant + emits + creates NO reminder row; owner Approve on an enabled bundled ritual SCHEDULES it (the full blocker close — reminder row appears, `status` → approved+scheduled); `already_enabled` / `unknown_ritual` / `invalid_schedule` refusals; enabled `def.json` survives boot re-registration (skipped as duplicate, bundled def wins). `cores/free/reminders/__tests__/rituals-tools.test.ts` — `rituals_enable` wired-dispatch + fail-closed-when-unwired. `install-lifecycle.test.ts` tool-count 8→9. Suites green: `reminders/` + `cores/free/reminders/` 388 pass / 3 skip; `tsc -p reminders` + `tsc -p cores/free/reminders` + `tsc -p open` clean.
- Honors overturn 3 (registration agent-callable; security in the approval GATE, not the surface) — `enable` fires nothing; the ritual runs only after the owner taps Approve on the code-rendered prompt.

## 2026-07-21 — Executor-mode reminders task 10: CLOSE Argus r1 round-2 (doc-accuracy BLOCKER + deny-on-approved minor)

Branch `trident/executor-reminders-p2` (PR #427). Argus round-1 review of the task-10 docs found one doc-accuracy BLOCKER plus stale citations and one approval-handler minor; all closed here.

- **BLOCKER — `SYSTEM-OVERVIEW.md` misdescribed the `RitualDef` contract.** The ritual-executor section claimed `RitualDef` "declares `id`, the self-contained `prompt` bytes, a `tool_surface`, an `egress` class, a `scope`, a cadence, a tier, and a timeout" — but the interface (`reminders/rituals.ts:131`) has EXACTLY six fields: `id`, `description`, `scope`, `tool_surface`, `egress`, `silent`. Rewrote the bullet to match: the prompt bytes live in the separate `rituals/<id>.md` file (derived from `id`, module header §34-36), the cadence lives on the scheduled reminder row (`ritualCadenceString`, `reminders/ritual-approval.ts:109`), and the model TIER (`RITUAL_MODEL_TIER`, `reminders/rituals.ts:55`) + spawn TIMEOUT (`RITUAL_TIMEOUT_MS`, `reminders/rituals.ts:47`) are module CONSTANTS, not def fields — with a note that the content-hash deliberately binds all six (drawing prompt from file, cadence from row, tier/timeout from constants), so the hash covers more than the def.
- **minor — a DENY re-tap on an already-APPROVED grant silently re-scheduled.** `handleOwnerButtonAnswer` dropped the `:a`/`:d` suffix once a grant left `'pending'`, so the r1 reconciliation branch (self-heal a stranded approved ritual on a re-tap) fired for a Deny tap too. `reminders/ritual-registration.ts:645-666` now reads the re-tapped decision and reconciles ONLY on an APPROVE re-tap; a DENY re-tap on an approved grant is inert with a clear "already approved — this Deny did nothing; re-propose to stop it" message (revoke-via-button is not a v1 path). New regression test (`reminders/ritual-registration.test.ts` — "deny re-tap on an approved grant": no double-schedule, grant unchanged, no second `respondApproval`).
- **Stale citations refreshed** (files grew after the entries were written): `AS_BUILT.md` task-9 backlink wire `open/wiring/memory.ts:214`→`:231` (the `wrapSyncHookWithBacklinkRepair(...)` call; `gbrainSyncHook = backlinkRepairHook` at `:235`), matching `SYSTEM-OVERVIEW.md`; task-8 `renderRitualApprovalBody` `ritual-registration.ts:279-334`→`:301` and `handleOwnerButtonAnswer` `:407-540`→`:611`.
- **Tests:** `reminders/ritual-registration.test.ts` 26 pass; `bun test reminders/` 373 pass / 3 skip; `bunx tsc -p reminders/tsconfig.json` clean.

## 2026-07-21 — Executor-mode reminders: CLOSE Argus r2 (2 BLOCKERs + 3 minors) on tasks 8/9

Branch `trident/executor-reminders-p2` (PR #427). Review-round hardening; no new surface.

- **BLOCKER 1 — completed one-shot ritual could be REPLAYED.** The schedule-on-approve dedup keyed on `status='pending'` only, so once a one-shot fired (row → `'fired'`) a re-tapped Approve minted a fresh reminder. `reminders/store.ts` — `hasPendingRitualRow` → **`hasScheduledRitualRow`**, now `WHERE ritual_id=? AND status <> 'cancelled'` (a fired one-shot still holds the slot; a cancelled ritual can be re-proposed). Call sites in `reminders/ritual-registration.ts:728,813` updated.
- **BLOCKER 2 — concurrent approval answers could DOUBLE-SCHEDULE.** The sync pre-check + awaited INSERT was a check-then-act race (content + egress grants for a web ritual). New migration **`0107_ritual_reminder_unique.sql`** — partial `CREATE UNIQUE INDEX idx_reminders_ritual_scheduled ON reminders(ritual_id) WHERE ritual_id IS NOT NULL AND status <> 'cancelled'` makes "≤1 live-or-completed reminder per ritual" a DB invariant (also closes BLOCKER 1 atomically). `ReminderStore` gains `isRitualScheduleConflict(err)` (matches `UNIQUE constraint failed: reminders.ritual_id`, verified against bun:sqlite); `ensureScheduled`'s create catch treats a conflict as "already scheduled", not a retry-able error. `migrations/expected-schema.txt` regenerated.
- **minor 1 — backlink repair rewrote links inside code.** `runtime/backlink-repair.ts rewriteLinks` now masks via `stripCode` (exported from `runtime/auto-link.ts`) and rewrites a match ONLY when its offset survives stripCode intact — literal `[[white-board]]` in a fence/inline-span is left untouched, matching the extractor.
- **minor 2 — mdlink title dropped.** The optional `(target "Title")` title group is now captured and re-emitted verbatim.
- **minor 3 — correction-pattern slug drifted past the 200-scan window.** `scribe/reflect/correction-patterns.ts` — new exported `stablePatternSlug`: the slug is now `correction-pattern-<digest of the cluster's majority `right`-field vocabulary>` (window-INVARIANT), replacing the oldest-member-id slug that changed every time the scan window slid past the oldest occurrence, orphaning the prior page.
- **Nits (deferred, benign per the findings):** readdirSync-in-async-drain (off the write-response path, single-owner scale), `stats.repaired` overcount (observability-only), promoted-page LLM re-synthesis eligibility (timeline preserved, no wikilinks to lose).
- **Tests:** explicit per-fix assertions — store replay/race + `isRitualScheduleConflict` scoping (`reminders/store.test.ts`), registration race→"already scheduled" (`reminders/ritual-registration.test.ts`), code-fence-skip + title-preservation unit tests (`runtime/__tests__/backlink-repair.test.ts`, `rewriteLinks` exported), window-slide invariance (`scribe/__tests__/correction-patterns.test.ts`). Test-harness fixes for the new invariant: `reminders/ritual-executor.test.ts ritualRow` frees the prior slot; `reminders/rituals.test.ts` 0106-rebuild staging excludes versions ≥ 106 (0107 depends on 0106's column); `migrations/runner.test.ts` expects 107. Suites green: reminders 372 pass, runtime 1561 pass, scribe 133 pass, migrations 40 pass; `tsc -p tsconfig.json` clean.

## 2026-07-21 — Executor-mode reminders task 10: docs close-out + work-board CI fixture fix

Branch `trident/executor-reminders-p2` (PR #427). Docs-only close-out of the executor-mode reminders sprint (engine tasks 0-9 already landed on this branch + PR #426) plus the one CI merge prerequisite.

- **Three doc surfaces updated.** `docs/AS_BUILT.md` — the two new entries above (the a2d93b99 Argus r1 round-2 fixes + this close-out). `docs/SYSTEM-OVERVIEW.md` — a new `## Ritual executor — approval-gated code rituals (reminders/)` section inserted after the Reminders Core section and before `## Proactive messaging`, plus the memory-consolidation cadence text updated for the AS-LANDED Q2 tier split (backlink repair = event-driven on the sync hook; correction-pattern promotion = reflect-pass step 4; daily-delta = bundled ritual). `reminders/AGENTS.md` — full rewrite from the pre-implementation P0 stub to the real reminder-engine + ritual-executor surface.
- **Work-board CI fixture fix (SEPARATE commit `b5d631ad`).** Pre-existing main fixture rot inherited by every branch: `work-board/store.ts:56` makes `task_type: WorkBoardTaskType` a REQUIRED field of `WorkBoardItem`, but the `item()` fixture at `work-board/fragment.test.ts:5-20` omitted it (the only missing field), so the CI Typecheck matrix was RED on any branch. Added `task_type: 'build',` to the fixture (mirrors store.ts field order). `bunx tsc -p work-board/tsconfig.json` exits 0; `bun test work-board/` 74 pass. The executor branch never touched `work-board/`.
- **Sprint close.** Executor-mode reminders tasks 0-10 complete across PR #426 (tasks 0-6R, merged to main `63fe4119`) and PR #427 (tasks 7-10, this branch).

## 2026-07-21 — Executor-mode reminders task 9/8 (Argus r1 round-2 fixes, PR #427)

Branch `trident/executor-reminders-p2` — commit `a2d93b99` closing the five Argus round-1 findings on the task-8/9 ritual-registration + backlink-repair work. `tsc` clean; a new regression test lands per fix (`reminders/ritual-registration.test.ts`, `runtime/__tests__/backlink-repair.test.ts`).

- **BLOCKER — web-ritual CONTENT approval was unreachable.** The live-agent capture keyed ritual eligibility off `latestPromptByTopic` (a single prompt), so once the SEPARATE egress-approval prompt landed the CONTENT Approve token was no longer "latest" and failed the T8 persisted-option-set membership check — a web ritual could never be content-approved, hence never scheduled. Added `ButtonStore.recentPromptOptionsByTopic` (`channels/button-store.ts:881` — the union of recent UNRESOLVED prompt option values) and a separate `priorRitualOptions` computed from it in `gateway/wiring/build-live-agent-turn.ts:743,746,787-794`, so both the content and egress tokens stay capturable while the onboarding capture stays latest-only.
- **BLOCKER — an approved-but-unscheduled ritual could strand.** A transient failure after `respondApproval` left a ritual approved with no reminder row and no self-heal. Extracted an idempotent `ensureScheduled` (`reminders/ritual-registration.ts:653,681,692`, never throws out) and made a re-tap of an already-APPROVED grant RE-DRIVE scheduling; the decision-record step is isolated so a scheduling failure no longer mislabels a recorded decision.
- **MAJOR — a rejecting approval-prompt `emit` left a registered-but-promptless ritual** whose on-disk files + duplicate guard blocked every re-propose. `propose` now FULLY rolls back on emit failure (`reminders/ritual-registration.ts:590-600` — registry `unregister` + delete both `wx` files + `ApprovalManager.cancelPending` on both grants routed through the async mutex) and throws `emit_failed` (`reminders/ritual-registration.ts:153,597`).
- **minor — `rituals_status` mis-labeled a DENIED grant as 'none'.** New `ApprovalManager.findByToolName` (`tools/approval.ts:255`) lets status report the real DENIED state.
- **minor — backlink-repair re-scanned the corpus per job.** The existing-slug enumeration is hoisted to ONCE per drain cycle (`runtime/backlink-repair.ts:302-312` — `enumerateExistingSlugs` inside `drain()` before the queue loop) instead of O(jobs × corpus); eventual consistency preserved because a page created by a concurrent write schedules its own job for the next drain.

## 2026-07-21 — Executor-mode reminders task 9 (Q2 overturn-2): dreaming's uncovered half INTO CORE MEMORY, split by tier

Branch `trident/executor-reminders-p2` (PR #427). Ryan's Q2 overturn folds the three pieces of Vajra "dreaming" that were NOT covered by scribe/reflect into core memory, split by tier — NOT a separate dreaming ritual. All deterministic where it can be; NO feature flags.

- **(a) Deterministic entity BACKLINK REPAIR, event-driven on the sync hook** — new `runtime/backlink-repair.ts` (`wrapSyncHookWithBacklinkRepair`), a THIRD `SyncHook` wrapper layer wired OUTERMOST in `open/wiring/memory.ts:231` (the `wrapSyncHookWithBacklinkRepair(...)` call; `const gbrainSyncHook = backlinkRepairHook` at `:235`). On every entity write it inspects `newLinks` for a target with no entity page; a UNIQUE strip-hyphen-key match (`[[white-board]]` vs `entities/concepts/whiteboard.md`) → rewrites the source page's compiled-truth wikilinks/mdlinks via `writeEntity` (CAS `ifBodyEquals` on the event body, `backlink-repair:<slug>` provenance timeline row) and self-references the wrapper as the repair write's syncHook so it RE-ENTERS the full chain (GBrain `remove_link`/`purgeDeferred` retracts the broken edge, re-adds the fixed one — ISSUES #102). Orphan (0 candidates) / ambiguous (>1) → logged, NEVER mutated (the always-safe direction). Coalesced single-flight drain + `idle()` seam + re-entrancy guard; termination is structural. `normaliseSlug` exported from `runtime/auto-link.ts` as the single grammar. `stats.repaired` counts committed-only.
- **(b) Correction-pattern promotion as reflect-pass STEP 4** — new `scribe/reflect/correction-patterns.ts` (`clusterCorrections` Jaccard oldest-seed-stable + `composePatternPage`), driven by `runReflectPass` (`scribe/reflect/reflect-pass.ts` step 4) UNCONDITIONALLY of substrate (deterministic; LLM-less boxes included), guarded only on an injected `readCorrections` seam (no scribe→reflection package edge — `open/wiring/memory.ts` wires the real `readRecentCorrections` with `DEFAULT_CORRECTION_SCAN_LIMIT`). ≥3-occurrence clusters promote to a kind-`concept` entity page (window-invariant slug `correction-pattern-<majority-`right`-vocabulary digest>` via `stablePatternSlug` — see the 2026-07-21 Argus-r2 entry above) through the pass's `writeEntity`+`syncHook` → GBrain + `entities/INDEX.md`. Idempotent via timeline `(ts,source,body)` dedupe + `changed:false`. Report gains `correctionsScanned`/`patternsPromoted`.
- **(c) `daily-delta` — a THIRD bundled read-only ritual** — `reminders/rituals/daily-delta.md` (reads `entities/INDEX.md` + `corrections/corrections-log.md` + `diary/`, posts a ≤15-line last-24h memory delta) + a third frozen def in `reminders/bundled-rituals.ts:BUNDLED_RITUAL_DEFS`. Seeds + registers via the existing composer loops (zero composer change); stays UNAPPROVED until the owner's task-8 act. The time-anchored survivor of the split (nothing in memory triggers a daily delta).
- Every sub-part ships BOTH a `toHaveBeenCalled()`-style spy assertion AND an artifact-on-disk assertion; (a) additionally has a `wireMemory`-level wiring proof (`open/__tests__/backlink-repair-wiring.test.ts`). Suites green: runtime 1556 pass/3 skip, scribe 131 pass, reminders 363 pass/3 skip. depcruise clean (no new cross-band violations); no new package edges; no feature flags.

## 2026-07-21 — Executor-mode reminders task 8 (Q3 overturn-3): agent-callable ritual registration with in-chat approval — the approval RENDERING carries the security

Branch `trident/executor-reminders-p2` (PR #427). An agent can now PROPOSE a scheduled, unattended ritual; the ritual only ever fires after the OWNER explicitly approves it in chat. The security lives in the APPROVAL GATE, not in who-can-call.

- **Engine `validateRitualDef` extract + `ritual_id` WRITE path.** `reminders/rituals.ts` — the register-time structural validation (charset, enums, tool-surface/egress consistency, EXCEPT the duplicate-id check) is extracted into an exported `validateRitualDef(def)`; `createRitualRegistry().register` delegates + keeps the duplicate guard (behavior-neutral — `reminders/rituals.test.ts` unchanged, green). `reminders/store.ts:138-167,178-229` — `create`/`createRecurring` accept an optional `ritual_id` (RITUAL_ID_RE-guarded, malformed THROWS fail-closed) and INSERT the column + return it; new `hasScheduledRitualRow(ritual_id)` (charset-guarded `SELECT 1 … WHERE ritual_id=? AND status <> 'cancelled'`; hardened from the original pending-only `hasPendingRitualRow` — see the 2026-07-21 Argus-r2 entry above).
- **Approval id passthrough.** `reminders/ritual-approval.ts:161-215` — `requestRitualApproval` mints `content_id` (+ `egress_id` for web defs) and threads each as `ApprovalRequest.id` so the durable `tool_approvals` row lands under an id the caller returns + encodes into the opaque button token (no side-table).
- **NEW `reminders/ritual-registration.ts` — the engine service (approval-gate rendering + capture).** `propose()` (order matters, all-or-nothing before any write): NFC-normalize the prompt (the NORMALIZED bytes are what is hashed/rendered/written) → reject bidi/zero-width/C0 controls (`RITUAL_PROPOSAL_BANNED_CHARS_RE`, never sanitize silently) → REFUSE empty/over-16 KiB (`RITUAL_PROPOSAL_MAX_PROMPT_BYTES`, never truncate) → `validateRitualDef` → refuse scope≠'instance' (v1) → validate schedule (finite fire_at; recurrence XOR recurrence_spec) → NEVER-CLOBBER (registry.get / `<id>.md` / `<id>.def.json` existsSync) → write both files with fs flag `'wx'` (rollback the `.md` if the `.def.json` write fails) → `registry.register` → `requestRitualApproval` → emit a CODE-rendered, PREFORMATTED, fence-hardened approval `ButtonPrompt` (`renderRitualApprovalBody`) via the injected `emit` seam; NO reminder row, fires nothing (no register-and-fire). `renderRitualApprovalBody` (PURE, `ritual-registration.ts:301`): capability BULLETS not bare tool names (Read/Glob/Grep → "read any file in your Neutron home"; WebSearch/WebFetch → "reach the public internet — content could be sent out"; `GATED_WRITE_TOOLS` → "(CURRENTLY BLOCKED at fire time until sandboxing ships)"; unknown/`mcp__` → raw token "(bridge tool)"), a "Runs UNATTENDED … up to 45 minutes … smart model tier" line, itemized URLs/paths/`mcp__*` refs each in its own fenced block, the FULL prompt inside a backtick fence whose length = max(3, longest internal run + 1) so no prompt content can close it (the button body is Markdown-rendered — `channels/button-primitive.ts:194` — this is the preformatted defense), and a footer "Typing anything else will NOT approve or deny". `handleOwnerButtonAnswer` (`ritual-registration.ts:611`): the deterministic affirmative-act capture — eligibility ONLY from an EXACT `rap:<22-char base64url of the row UUID>:a|d` token that is BOTH regex-valid AND present in the prior prompt's PERSISTED option set (the `captureButtonBackedRequiredField` discipline, `onboarding/interview/button-backed-answer.ts:207-209`); OWNER-only (a non-owner tap is refused WITHOUT touching any row); resolves the `tool_approvals` row via `respondApproval`; on approve, schedule-on-approve IFF `createRitualApprovalCheck(...).isApproved(def, liveBytes)` verifies over the LIVE file bytes (which also requires the egress grant for web defs) AND `!hasPendingRitualRow`; ANY db/fs throw → catch, log, "nothing was changed" and DO NOT schedule (fail closed). `status()`, `loadPersistedRitualDefs()` (boot re-registration of `<id>.def.json`, never throws — boot safety), opaque token codec `uuidToToken`/`tokenToUuid` (full option value ≤ `VALUE_BYTE_CAP` 37). Barrel-exported from `reminders/index.ts`.
- **Delivery seam extension.** `gateway/http/deliver.ts` — `DeliveryEnvelope` gains optional `options` / `idempotency_key` / `metadata`, honored ONLY on durability `'reply'` (threaded into `buildButtonPrompt` AND the routed-push `ChatOutbound.options`, previously hardcoded `[]`). Absent ⇒ byte-identical legacy behavior (`gateway/http/__tests__/deliver.test.ts`).
- **Live-agent capture seam.** `gateway/wiring/build-live-agent-turn.ts` — `BuildLiveAgentTurnInput.ritualApprovalCapture`; the prior-prompt durable-option read is widened to also fire when the capture is wired (not onboarding-only); the capture runs AFTER step-1 user-turn persistence + transcript append and BEFORE the onboarding required-answer capture (so an opaque `rap:` token can never fall through to the personality free-text capture or the substrate). On a non-null result the runner persists an inert confirmation, ships it via `sendSafe`, and returns `replied` WITHOUT dispatching the LLM turn (T8: unrelated reply → null → normal turn).
- **Composer wiring.** `open/composer.ts` — inside `ritual_executor_factory` (the one closure holding the graph `ApprovalManager`): `loadPersistedRitualDefs` after `registerBundledRituals`, then construct `createRitualRegistrationService({ registry, rituals_dir, approvals, store: new ReminderStore(db), project_slug, owner_user_id: OWNER_USER_ID, approval_topic_id, emit: deliver(...durability:'reply'...) })` and assign the outer `let ritualRegistration` binding; `buildLiveAgentTurn` gains `ritualApprovalCapture: (i) => ritualRegistration?.handleOwnerButtonAnswer(i) ?? null`; a late-bound `ritualRegistration: () => ritualRegistration` getter threads through `mountOpenCores` → `buildCoresBackendFactories` (`CoresBackendFactoriesOptions.ritualRegistration`). `llmPool===null` ⇒ factory never runs ⇒ `ritualRegistration` stays null ⇒ capture no-ops + tools throw unavailable (fail closed, no flags).
- **Reminders-Core MCP surface (X2 lockstep — manifest + `TOOL_NAMES` + handlers one commit).** `cores/free/reminders/package.json` `neutron.tools[]` + `src/manifest.ts` `TOOL_NAMES` + `src/mcp-tools-extra.ts` handlers gain `rituals_propose` (write cap; description says it only runs after the OWNER approves in chat) and `rituals_status` (read cap). `src/backend.ts` — a NARROW structural `RemindersRitualService` interface (propose + status; the Core never imports the engine service module) + OPTIONAL `proposeRitual?`/`ritualsStatus?` methods (the `convertToTask?` precedent) dereffing a late-bound `rituals?: () => RemindersRitualService | null` getter PER-CALL + typed `RitualsUnavailableError` (fail-closed when unwired). `gateway/boot-cores-factories.ts` reminders_core branch threads `rituals: opts.ritualRegistration`.
- **ACCEPTANCE proven by tests (REAL `ApprovalManager` + migrated temp DB):** `reminders/ritual-registration.test.ts` (19 tests) — propose happy path (files on disk, one pending grant, content_hash pin, emit-once 2 options within the 37-byte cap, code-rendered body, ZERO reminder rows, `store.create` 0×); **T8** — an unrelated owner reply returns null, a freeform attach never touches the `tool_approvals` row, `respondApproval` 0×, `isApproved` false, `validateRitualFire` → `unapproved`; no-self-approval; approve → schedule-on-approve with `ritual_id` + cadence + no double-schedule; deny; egress two-grant (content-approve alone not enough); over-cap refusal + bidi/zero-width rejection + NFC + fence hardening; never-clobber; cadence/surface widening drops approval; `loadPersistedRitualDefs`. Plus store/approval/deliver/live-agent-capture/reminders-Core suites. `bun test reminders/ migrations/ cores/free/reminders/ gateway/wiring/ gateway/http/ channels/` 1727 pass; `open/ + composition + cores` 413 pass; `tsc -p {reminders,open,gateway,cores/free/reminders}` clean; eslint + depcruise clean on task-8 files.

## 2026-07-21 — Executor-mode reminders task 6R (REQUEST_CHANGES round-4 fixes): 0106 skip_reason CHECK admits gated_tool_surface; sync launch failure settles crashed

Two correctness bugs in the skip-recording / crash-settle paths on PR #426 (branch `trident/executor-mode-reminders`). The T5 security verdict itself PASSED review — the gate (`validateRitualFire` `gated_tool_surface` refusal, `GATED_WRITE_TOOLS`, PROFILE_RITUAL, buildSettings permissions plumbing) is UNTOUCHED; these are the recording/settle paths downstream of it.

- **BLOCKER A — the 0106 `skip_reason` CHECK omitted `'gated_tool_surface'`, re-opening the hot-loop/data-loss class for gated rituals.** The CHECK value list admitted only 4 of the 5 `RitualFireSkipReason` members, but `validateRitualFire` returns `'gated_tool_surface'` for any Bash/Write/Edit/MultiEdit/NotebookEdit ritual (`reminders/rituals.ts:302,367-371`) and the executor persists it verbatim via `insertSkipped` into the STRICT table (`reminders/ritual-executor.ts:389-396`). A gated fire therefore hit `CHECK constraint failed` → `insertSkipped` threw → `fire()` outer catch re-threw → `reminders/tick.ts` `claimRevert` → the occurrence re-fired every 30s tick forever with NO durable `code_ritual_runs` row. FIX: `migrations/0106_ritual_schema.sql:86` — CHECK value list gains `'gated_tool_surface'` (in-place: 0106 is branch-only, absent on main, no recorded checksum in `migrations/runner.ts`, no deployed DB has it — a 0107 would be wrong). `migrations/expected-schema.txt:527` regenerated via `bun migrations/regen-snapshot.ts` (exactly the one CHECK-list line changed). `reminders/ritual-runs.ts:15` stale 3-member header comment corrected to the full 5-member union (doc-only). Tests: `reminders/ritual-runs.test.ts` `test.each` over all 5 members — "insertSkipped accepts every RitualFireSkipReason member against the real 0106 DDL (CHECK lockstep)" — lands a durable row against the REAL migrated DDL (pre-fix, the `gated_tool_surface` case throws `CHECK constraint failed`); `reminders/ritual-executor.test.ts` end-to-end — "gated tool surface (Bash) → durable skipped/gated_tool_surface row, fire() RESOLVES, nothing spawned" (the no-hot-loop proof: `fire()` resolves so the tick does not `claimRevert`).
- **BLOCKER B — a synchronous launch-construction throw wedged the run.** Step (f) of the executor evaluated `deps.resolve_model()` and the `deps.turn(...)` call itself SYNCHRONOUSLY during the `fireAndForget` argument construction — AFTER the durable 'running' row (`insertRunning`) and the LIVE `ritual:<id>` registry record (`spawnSubagent` `on_duplicate:'refuse'`) already existed. A sync throw skipped the never-yet-attached `.catch`, landed in the outer startup catch and re-threw → the tick reverted the occurrence claim WHILE the spawn key stayed live → every re-fire was refused as a duplicate ('failed' rows) and the original run stuck 'running' until boot reap. FIX: `reminders/ritual-executor.ts:559-579` — the `fireAndForget` launch is wrapped in `try/catch`; a synchronous `launchErr` routes through the SAME `settleCrashed` path as a promise rejection (run row → 'crashed', registry `updateTerminal` frees the spawn key since `liveByKey` counts only pending|running, failure notice via the guarded `surfaceFailure`), then `return` (NOT re-throw) so the occurrence is legitimately consumed — no `claimRevert`, no stuck 'running', no live-key wedge. `settleCrashed` (`reminders/ritual-executor.ts:326-362`) is fully guarded and never rejects, so the bare `await` is safe and keeps the settle inside the tick quiescence boundary (task-5R discipline). The step-(f) comment and the outer-catch comment (`reminders/ritual-executor.ts:581-596`) record the sync hazard; the documented `fire()` contract ("never rejects once a durable row exists") is unchanged — this fix makes the code honor it. Tests: `reminders/ritual-executor.test.ts` — "resolve_model throws synchronously → run settles crashed, spawn key freed, fire() resolves; a re-fire is admitted" (includes the regression half: the second fire of the same ritual is ADMITTED, proving the key was freed) and "turn() throwing synchronously (non-promise) settles crashed identically".

Suites green: `bun test reminders/` (316 pass), `bun test migrations/` (40 pass), `bun test gateway/` (2778 pass, 2 skip); `bun x tsc --noEmit -p reminders/tsconfig.json` clean.

## 2026-07-21 — Executor-mode reminders task 6 (Argus round-2 doc/forward-guard fixes): fire() contract docs + GATED_WRITE_TOOLS lockstep note + composer verdict comment

Round-3 corrections on PR #426 (branch `trident/executor-mode-reminders`) — documentation/forward-guard only, no behavior change (all fixes are comments; suites unchanged 74/74 on the two touched suites).

- **MINOR — stale `fire()` contract docs corrected.** `reminders/ritual-executor.ts` — the `RitualExecutor` interface doc (was "`fire(reminder)` never rejects") and the `createRitualExecutor` doc (was "`fire()` NEVER throws") contradicted the round-2 fix that makes `fire()` REJECT on a STARTUP failure (module header line 23; throw sites at the `insertRunning`-recovery re-throw and the outer catch). Both now state the real contract — REJECTS on startup failure so the tick (`reminders/tick.ts`) reverts its occurrence claim; never rejects once a durable row exists; never awaits the detached turn — closing a doc trap for future importers of the exported seam (`reminders/index.ts`).
- **MINOR — `GATED_WRITE_TOOLS` lockstep-maintenance note added.** `reminders/rituals.ts` — the gate is an ENUMERATED denylist (5 built-ins), so a write-capable name NOT in the set (a new built-in, or an `mcp__server__tool` bridge name admitted by `TOOL_TOKEN_RE`) would PASS the gate. Not reachable today (the ritual substrate wires no tool bridge and shipped rituals are read-only with an explicit Read/Glob/Grep allow-list). Comment records the two lockstep lanes + recommends flipping to a read-only ALLOW-LIST (fail-closed for unknown/bridge names) when the OS-sandbox sprint or task 8/9 revisits the gate.
- **NIT — composer `scope_cwd` comment corrected.** `open/composer.ts` — the block comment + throw message said per-project write-containment "lands in task 6"; task 6's T5 verdict is UNPROVABLE, so containment is deferred to the OS-sandbox prerequisite sprint. Comment + throw string now say so (the fail-closed behavior itself was already correct).

## 2026-07-21 — Executor-mode reminders task 6 (Argus r1 round-2 fixes): ritual startup fails CLOSED with claim revert; STAY GATED enforced by code

Round-2 corrections on PR #426 (branch `trident/executor-mode-reminders`).

- **BLOCKER — a ritual startup failure no longer silently consumes the occurrence.** `reminders/ritual-executor.ts` — the `fire()` outer catch used to log-and-RESOLVE any startup throw (`validateRitualFire`, `insertSkipped`, `insertFailed`, or a total run-store outage on the `insertRunning` recovery path), so the tick consumed the #319 claim with NO durable `code_ritual_runs` row and NO launch — a scheduled run lost with one log line. Now `fire()` RE-THROWS a startup failure, and `reminders/tick.ts` reverts the #319 claim (the same `claimRevert` the nudge dispatcher uses: `revertRecurrenceAdvance` for recurring, `reopen` for one-shot) so the occurrence re-fires next tick. Paths that DID land a durable row (skipped/failed/running) still resolve = consume. The detached substrate TURN stays fire-and-forget + fail-soft inside the executor, so a `fire()` rejection is unambiguously a startup loss. The unwired-executor branch still consumes (a permanent condition, not a transient loss). Tests: `reminders/tick.test.ts` (recurring reverts + re-fires, one-shot reopens + re-fires), `reminders/ritual-executor.test.ts` (startup run-store throw → rejects; insertRunning+insertFailed total outage → rejects, spawn key freed, turn never launched).
- **MINOR — a persistent run-store failure at turn settlement no longer leaks the ritual spawn key.** `reminders/ritual-executor.ts` `settleTerminal`/`settleCrashed` — `runs.markTerminal` was awaited UNGUARDED; a throw jumped to `settleCrashed`, which retried the same failing store and never reached the registry `updateTerminal` that frees `spawn_key ritual:<id>` (`on_duplicate:'refuse'`), refusing all future fires until restart. `markTerminal` is now individually guarded so the registry terminal (key-free) ALWAYS runs, independent of run-history persistence.
- **MAJOR — "STAY GATED" for Bash/Write rituals is now enforced by CODE, not absence.** `reminders/rituals.ts` — `validateRitualFire` refuses fail-CLOSED any ritual whose `tool_surface` grants a write/exec-class tool (`GATED_WRITE_TOOLS` = `Bash`/`Write`/`Edit`/`MultiEdit`/`NotebookEdit`) with the new `gated_tool_surface` skip verdict, BEFORE any disk read or approval check. A def may still REGISTER a Bash surface (overturn 1 — Bash is portable) but can never FIRE until the OS-sandbox sprint lifts the gate (T5 verdict UNPROVABLE). Read-only rituals unaffected. Test: `reminders/rituals.test.ts` `test.each([Bash,Write,Edit,MultiEdit,NotebookEdit])`.
- **NITs.** `build-settings.ts` no longer writes a hollow `permissions: {}` for an all-empty input (test added). `ritual-write-containment.e2e.test.ts` — stale `acceptEdits` comment corrected (in-scope acceptance comes from the `allow` rules, not the dropped `acceptEdits`); ARM A now asserts `reachedTerminal` when the channel bound (the no-wedge signal was console-only).
- Affected suites green: `bun test reminders …` 109/109; full `reminders` + composition + auto-approve-gate 406/406; `tsc --noEmit` 0 errors.

## 2026-07-21 — Executor-mode reminders task 6: T5 write-containment spike (HARD SECURITY GATE) — VERDICT: UNPROVABLE

Substrate-layer plumbing + the real-PTY spike for path-scoped ritual write containment, on PR #426 (branch `trident/executor-mode-reminders`).

- **`buildSettings` writes an optional CC `permissions` block.** `runtime/adapters/claude-code/persistent/build-settings.ts` — new `SettingsPermissions` type (`allow`/`deny`/`ask`/`defaultMode`); when `input.permissions` is set, a `permissions` key is emitted ALONGSIDE the existing `hooks.Stop` block (0600 atomic write preserved, empty sub-arrays dropped). Absent ⇒ byte-identical to the pre-task-6 Stop-hook-only write. Re-exported from the adapter boundary (`index.ts`).
- **The `tool-use-approve` auto-approver is now gate-able.** `runtime/adapters/claude-code/persistent/spawn.ts` — the register block that presses `['1','enter']`="Yes" on any tool-use permission prompt (incl. Bash via `runthiscommand`, `signatures.ts:89-90`) is wrapped in `if (options.disableToolUseAutoApprove !== true)`. Every OTHER detector — the wedged-prompt deadlock-recovery ladder (`createWedgedPromptDetector()`, the no-hang backstop), disclaimer-dismiss, rate-limit, resume/compact pickers, banners — stays unconditionally registered. `buildSettings({settingsPath})` now forwards `options.permissions` when present.
- **Two new spawn/substrate options threaded end-to-end (direct call-args, NOT `SubstrateProfile`).** `disableToolUseAutoApprove?` + `permissions?` on `PersistentReplSubstrateOptions` (`persistent/types.ts`), `ClaudeCodeSubstrateOptions` (`runtime/adapters/claude-code/index.ts` + `createClaudeCodeSubstrateAuto` forwarding), and `BuildLlmCallSubstrateInput` (`gateway/wiring/build-llm-call-substrate.ts`, forwarded in the opts-resolution block). NOT routed through `SubstrateProfile` — `PROFILE_RITUAL` stays frozen so `gateway/wiring/__tests__/substrate-profiles.test.ts` equivalence net stays green; a future writing-ritual factory sets these directly.
- **Tests.** `persistent/__tests__/ritual-auto-approve-gate.test.ts` (fake-host): `disableToolUseAutoApprove:true` ⇒ session scanner does NOT carry `tool-use-approve` while `wedged-interactive-prompt`/disclaimer/rate-limit/compact-resume DO; default carries it. `OutputScanner.has(id)` introspection seam added (`output-scan.ts`). `build-settings.test.ts` extended: permissions block written + Stop hook intact + 0600 + no `permissions` key when unset. `persistent/__tests__/ritual-write-containment.e2e.test.ts` (real PTY, `NEUTRON_PTY_E2E=1`, `describe.skipIf`) — the T5 spike; opt-out suite skips it (605 pass / 3 skip / 0 fail in `persistent/`).
- **VERDICT: UNPROVABLE** (recorded in `docs/plans/executor-mode-reminders-2026-07-20.md` → "T5 write-containment spike verdict — 2026-07-21"). A ritual REPL with `skip_permissions:false` + a settings `permissions` block bound its dev-channel MCP in only 1/6 real-PTY runs (vs 2/2 for the no-permissions + `skip_permissions:true` sibling control, interleaved on the same box/creds); the one bound run WEDGED on an interactive tool-use permission prompt (neither the in-scope control write nor the out-of-scope write landed, no terminal state). No out-of-scope file ever escaped, but a clean fail-closed-without-wedge was NOT demonstrated. Consequence: an OS-level sandbox (reserved `SubstrateSandboxConfig`) becomes its own prerequisite sprint; Bash/writing rituals STAY GATED; read-only rituals (task 7) ship under Layer 1. The task-6 plumbing is landed and dormant until that sprint.

## 2026-07-21 — Executor-mode reminders task 5 (Argus r3 fixes): ritual startup joins the tick quiescence boundary

Round-3 corrections on PR #426 (branch `trident/executor-mode-reminders`).

- **The tick now AWAITS ritual `fire()` startup — the data-loss window is closed
  (MAJOR).** `reminders/tick.ts:231` wrapped the whole `ritual_executor.fire(reminder)`
  in `fireAndForget('ritual-fire', …)`, detaching validation + spawn + the durable
  `code_ritual_runs` 'running' insert from the tick body. `ReminderTickLoop.stop()`
  (tick.ts:135-137 → SupervisedLoop quiescence await, `loop/index.ts:319` stop
  awaits `inflight`) could therefore resolve BETWEEN a consumed #319 claim and its
  durable run row — a claimed occurrence consumed with NO durable record = data loss
  on shutdown/crash. Fixed to `await this.ritual_executor.fire(reminder)`
  (`reminders/tick.ts:231`): claim → validate → durable 'running' row now completes
  INSIDE the quiescence boundary. Only the long-running substrate TURN stays detached,
  and that detachment is INTERNAL to the executor (`fireAndForget('ritual-run')`,
  `reminders/ritual-executor.ts:494`) — the tick never blocks on an up-to-45-min run;
  startup is milliseconds of local DB writes plus one prompt read. The now-unused
  `fireAndForget` import was dropped (tick.ts:19) and the guard log key renamed
  `ritual_fire_sync_throw` → `ritual_fire_threw` (it now also covers async
  rejections). Regression test: an un-awaited `runOnce()` + immediate `await stop()`
  with a REAL executor + never-settling turn leaves exactly the durable 'running'
  row — `reminders/tick.test.ts` "a claimed ritual occurrence + immediate stop()
  leaves a durable running row — never zero rows" (deterministically null on the
  pre-fix code).
- **`postNotice` honors spec §267 — one retry then a logged failure notice (minor a).**
  `reminders/ritual-executor.ts:169-193`: a `post()==false` result (the durable
  reply write was swallowed — `gateway/http/deliver.ts:187-188` → `reminder-outbound.ts:41-42`)
  is retried ONCE; a still-false result logs `ritual_notice_post_not_persisted`. A
  THROWN post keeps the existing `ritual_notice_post_failed` catch path.
  `gateway/http/deliver.ts` is unchanged — its `{persisted:false}` reply contract is
  correct and the consumer honors it.
- **Executor-side pre-slice dropped; the formatter owns truncation (minor b).**
  `reminders/ritual-executor.ts:278` no longer `.slice(0, 160)` the settled
  failure reason before handing it to `formatRitualFailureNotice`
  (`reminders/ritual-delivery.ts:60-63`), which owns whitespace-collapse THEN the
  160-char cap. The old pre-slice truncated BEFORE collapse and could under-fill the
  notice. The `:297` 4000-char DB `failure_reason` cap (a different concern) stays.
- Tests: `bun test reminders/` 300 pass / 0 fail; `bun test gateway/` + `bun test loop/`
  green.

## 2026-07-21 — Executor-mode reminders task 5 (Argus r2 fixes): escalation fires after a cancel-broken streak + insertRunning-failure no longer wedges a ritual

Round-3 corrections on PR #426 (branch `trident/executor-mode-reminders`).

- **`shouldEscalate` now re-arms after ANY streak-breaker, not only a success
  (BLOCKER).** `reminders/ritual-delivery.ts` gated re-arm on the 4th (older) row
  being `=== 'finished'`, but `cancelled` also breaks a streak (it is outside
  `FAIL`) — so a fresh 3-failure streak preceded by an operator cancel
  (`[failed,failed,failed,cancelled]`) NEVER escalated, for the streak's entire
  life. Fixed to gate on `!FAIL.has(4th.status)`: any non-failure streak-breaker
  (`finished` OR `cancelled`) re-arms the once-per-streak notice. `FAIL` is now
  typed over the full `RitualRunStatus` union so the un-narrowed 4th-row status
  typechecks. The wrong assertion in `reminders/ritual-delivery.test.ts` was
  corrected to expect `true`.
- **A run-history write that fails AFTER the subagent spawned no longer wedges
  the ritual (minor).** `reminders/ritual-executor.ts`: if `insertRunning` throws
  after `spawnSubagent` persisted its `pending` `ritual:<id>` registry record,
  the catch now marks that record terminal via `updateTerminal` (which never
  rejects) so the `on_duplicate:'refuse'` guard's `liveByKey` no longer sees it —
  every future fire would otherwise be refused as a duplicate with no durable row
  explaining why. Then a durable `failed` run row + failure notice are landed
  best-effort. New test in `reminders/ritual-executor.test.ts` proves the key is
  freed (`liveByKey` undefined, record `crashed`), the failed row exists, the
  notice posts, and the turn never launches.
- **`listRecentTerminal` doc now lists `cancelled` (nit).** The interface comment
  in `reminders/ritual-runs.ts` omitted `cancelled` though the SQL `IN`-clause
  includes it; corrected to match.

## 2026-07-21 — Executor-mode reminders task 5 (Argus r1 fixes): ritual prompt wiring + scope fail-close + cancel/escalation semantics

Round-2 corrections on PR #426 (branch `trident/executor-mode-reminders`).

- **Ritual REPL prompt now actually reaches the spawned agent (BLOCKER).**
  `ClaudeCodeSubstrateOptions` gains `appendSystemPromptFile`, and the DEFAULT
  anthropic factory `createClaudeCodeSubstrateAuto` now FORWARDS it onto
  `PersistentReplSubstrateOptions` (`runtime/adapters/claude-code/index.ts`). It
  was dropped there, so a ritual REPL spawned with the CHAT persona
  (`repl-agent-base.md`) instead of the executor prompt, and the open typecheck
  failed (TS2339 at `gateway/wiring/build-llm-call-substrate.ts:693`). New
  end-to-end test `runtime/adapters/claude-code/persistent/__tests__/append-system-prompt-wiring.test.ts`
  proves the whole chain: the real factory forwards the field AND the spawned
  argv carries `--append-system-prompt-file` (custom when set, `repl-agent-base.md`
  default when unset) — replacing the fake-factory coverage that masked it.
- **Project-scoped rituals fail CLOSED instead of over-granting owner_home
  (MAJOR).** Design doc §Layer 4: 'instance' rituals root at `owner_home`,
  'project' rituals at their project dir. v1 wires ONLY the 'instance' root
  (per-project rooting + write-containment is task 6). The composer's `scope_cwd`
  (`open/composer.ts`) now THROWS for a non-'instance' scope, and the executor
  (`reminders/ritual-executor.ts`) resolves the scope cwd BEFORE any 'running'
  row, landing a durable `skipped` row (new skip reason `unsupported_scope`)
  rather than silently running a project ritual from the owner-wide dir. No
  running-row orphan, no escalation.
- **Operator/shutdown cancel is no longer a scary failure (minor).** New
  terminal run status `cancelled` (migration `0106`, `RitualRunTerminalStatus`).
  `settleTerminal` records `cancelled` (not `failed`), posts NO failure notice,
  and — being outside the `FAIL` set — breaks a consecutive-failure streak rather
  than feeding the escalation.
- **Escalation window ordered by COMPLETION (minor).**
  `RitualRunStore.listRecentTerminal` now orders `ended_at DESC, started_at DESC,
  run_id DESC` (was `started_at DESC`) so 'consecutive' failures are consecutive
  by when they finished; `cancelled` rows are included in the terminal window.
- Migration `0106_ritual_schema.sql` `status`/`skip_reason` CHECK enums extended
  (`cancelled`, `unsupported_scope`); `migrations/expected-schema.txt` regenerated.

## 2026-07-21 — Executor-mode reminders task 5: completion delivery + failure surfacing + boot reap + 30d retention

A ritual's terminal event now reaches the owner. The detached settle chain writes
the durable `code_ritual_runs` row FIRST, then posts through the ONE out-of-turn
delivery seam (`Deliver` → the existing `ReminderOutbound`, concrete impl
`buildButtonStoreReminderOutbound({ deliver })`) — the SAME instance the nudge
dispatcher uses — to the owner's bare `app:<user>` topic. Spec of record:
`docs/plans/executor-mode-reminders-2026-07-20.md`. NO feature flags.

- **Completion delivery** (`reminders/ritual-executor.ts` `settleTerminal`,
  ~ln 209-267): after `runs.markTerminal(...)`, a `finished` non-silent ritual
  posts its final text (`r.result.trim()`), or `formatRitualCompletionFallback`
  when the output is empty; a `silent` ritual posts NOTHING on success. Delivery
  deps `outbound` + `resolve_topic` are REQUIRED on `RitualExecutorDeps`, so the
  composer wiring is TypeScript-enforced.
- **Failure surfacing** (`reminders/ritual-executor.ts` `surfaceFailure`,
  ~ln 189-215): every failure terminal (failed / timed_out / crashed, plus the
  spawn-refusal `insertFailed` path ~ln 262-273) posts exactly one one-line
  notice `Ritual '<id>' <status> (run <run_id>)` (`formatRitualFailureNotice`).
  Silent suppresses SUCCESS output only — failure notices always post. 'skipped'
  rows get no notice.
- **Consecutive-failure escalation** (`shouldEscalate`,
  `reminders/ritual-delivery.ts`): a deterministic once-per-streak rule over the
  last 4 terminal rows (`listRecentTerminal({ritual_id, limit:4})`) — fires one
  `formatRitualEscalationNotice` the moment a streak crosses 3, with zero new
  state. Checked in `surfaceFailure` after the failure row is written.
- **Boot reap of orphaned 'running' rows** (`reapOrphanRitualRuns`,
  `reminders/ritual-delivery.ts`; wired `open/composer.ts` after the ritual
  factory): a `code_ritual_runs` row a PRIOR boot left 'running' is marked
  'crashed' (`markTerminal`'s `WHERE status='running'` guard = idempotency) and
  gets one boot-reap notice. `code_ritual_runs` has NO boot_id — current-boot
  safety is ORDERING: the driver's FIRST statement is a SYNCHRONOUS
  `listOrphanRunning()` snapshot taken during compose, before build-core-modules
  starts the tick loop, so no current-boot 'running' row can exist in it. NOT
  llmPool-gated (orphans from a prior LLM-enabled boot surface even credential-less).
- **30-day retention prune** (`RitualRunStore.pruneOlderThan`,
  `RITUAL_RUN_RETENTION_MS`, `reminders/ritual-runs.ts`): chained after the reap
  at boot; deletes terminal/skipped rows with `started_at` STRICTLY older than
  `Date.now() - 30d`, never 'running' rows.
- **Composer wiring** (`open/composer.ts`): hoisted ONE `reminderOutbound` +
  ONE `ritualRuns` store shared by the nudge dispatcher, the ritual executor, and
  the boot reap; executor factory gains `outbound` + `resolve_topic`; the reap +
  prune fire-and-forget runs unconditionally at compose (fireAndForget precedent
  `composer:888`).
- Tests: `reminders/ritual-delivery.test.ts` (formatters + `shouldEscalate` truth
  table), `reminders/ritual-runs.test.ts` (listRecentTerminal / listOrphanRunning
  / pruneOlderThan + T6 seeded-orphan reap + idempotence), and T3 behavioural
  completion added to `reminders/ritual-executor.test.ts` (artifact-on-disk +
  durable history row + silent + failure-notice variants + escalation streak +
  post-failure resilience). `bun test reminders/` = 290 pass.

## 2026-07-21 — Executor-mode reminders task 4: executor dispatch branch in the TICK + ritual executor + cc-ritual substrate + ritual lane + code_ritual_runs writer

The live wiring that turns a `ritual_id` reminder row into a scheduled, scoped
sub-agent REPL. The tick's #319 claim is reused verbatim for ritual rows, but
they NEVER reach the nudge dispatcher / `on_fired` and NEVER revert their claim —
every attempt is recorded durably in `code_ritual_runs` instead. Spec of record:
`docs/plans/executor-mode-reminders-2026-07-20.md`. NO feature flags. Generic
read-only surface only for now (zero defs registered until task 7).

- **Ritual concurrency lane** (`runtime/subagent/registry.ts` `MAX_CONCURRENT_RITUALS=2`;
  `runtime/subagent/spawn.ts` cap check): a `ritual` spawn counts ONLY live ritual
  rows against the 2-cap; every other kind counts ONLY live non-ritual rows against
  `MAX_CONCURRENT_SUBAGENTS=8`. Bidirectional isolation — a ritual pileup can't
  starve interactive `/dispatch` + Trident, and 8 live builds never block a ritual.
- **Tools threading** (`agent-dispatch/service.ts` `DispatchTurnInput.tools?`;
  `agent-dispatch/substrate-turn.ts`): the runner maps `input.tools` onto stub
  `AgentSpec` ToolDefs (the `trident/conflict-resolver.ts:80-87` precedent) so a
  ritual's `tool_surface` reaches the spawned REPL's `--tools` argv. Omitted →
  the historical toolless `tools:[]` (dispatch family unchanged).
- **`PROFILE_RITUAL`** (`gateway/wiring/substrate-profiles.ts`) — the scheduled
  ritual REPL trust class; byte-identical `{skip_permissions:true}` today, kept
  DISTINCT so the T5 write-containment spike (task 6) tightens THIS grant first.
  Frozen in the byte-identity equivalence test.
- **`append_system_prompt_file` threading** (`gateway/wiring/build-llm-call-substrate.ts`
  `BuildLlmCallSubstrateInput.append_system_prompt_file?` → `ClaudeCodeSubstrateOptions.
  appendSystemPromptFile`, emitted `build-repl-argv.ts:109`). Absent → the
  substrate's `repl-agent-base.md` default (chat persona) — unchanged for every caller.
- **`reminders/ritual-agent-base.md`** (NEW, shipped in the package) — the
  UNATTENDED-executor system prompt (no user present, never ask, use only granted
  tools, one final reply). `RITUAL_AGENT_BASE_PROMPT` absolute path exported from
  `reminders/prompt-path.ts` (module-dir pattern).
- **`makeRitualSubstrate`** (`open/wiring/substrates.ts`) — a FRESH ephemeral
  `cc-ritual-*` REPL per fire, `PROFILE_RITUAL`, `append_system_prompt_file:
  RITUAL_AGENT_BASE_PROMPT`, NO `enableToolBridge`, NO owner-chat sinks; throws on
  empty pool. Single-arg `(cwd)=>Substrate` so it drops into `buildCancellableDispatchTurn`.
- **`reminders/ritual-runs.ts`** (NEW) — the SOLE `code_ritual_runs` writer
  (`migrations/table-ownership.json` entry added). `createRitualRunStore(db)`:
  `insertSkipped` (started=ended=now, skip_reason) / `insertRunning`
  (subagent_run_id + content_hash) / `insertFailed` (spawn-refusal; no subagent
  row) / `markTerminal` (finished|failed|timed_out|crashed + ended_at + output
  truncated to 4000 chars, guarded `WHERE status='running'`). Async `db.run` only.
- **`reminders/ritual-executor.ts`** (NEW) — `createRitualExecutor(deps).fire(reminder)`:
  NEVER throws, NEVER awaits the turn. Validates via `validateRitualFire` + the
  content-hash checker built from the row's LIVE cadence (skip → durable 'skipped'
  row, spawns nothing); `spawnSubagent` kind `'ritual'` on the lane (spawn_key
  `ritual:<id>`, on_duplicate 'refuse'; refusal → 'failed' row, no registry leak);
  'running' row + best-effort registry running-flip; launches ONE substrate turn
  detached via `fireAndForget`. Settlement maps completed→finished, timed_out→
  timed_out, failed/cancelled→failed, rejection→crashed on the run row + drives the
  registry record terminal. STRUCTURAL `RitualTurn` type (no agent-dispatch import)
  so the composer passes the SAME `buildCancellableDispatchTurn` closure. NO
  delivery/notices (task 5).
- **Tick executor branch** (`reminders/tick.ts`) — `ReminderTickOptions.ritual_executor?`;
  after the #319 claim a `ritual_id` row routes to `ritual_executor.fire` via
  `fireAndForget('ritual-fire', …)`, SKIPS the dispatcher + `on_fired`, `fired++`,
  and is NEVER reverted; `runOnce` resolves while the turn is pending. No executor
  wired → the (already-claimed) row is consumed + logged, never a nudge fallback.
  Nudge path byte-identical.
- **Composition wiring** — `CompositionInput.ritual_executor_factory?` (`gateway/
  composition/input/notifier-input.ts`); `remindersModule deps:['approval']` builds
  the executor with the graph's `ApprovalManager` (`gateway/composition/build-core-modules.ts`);
  the Open composer builds the factory (llmPool-gated) reusing the hoisted
  `subagentRegistry` + `makeRitualSubstrate` + `getBestModel`, registry rooted
  `<owner_home>/rituals` (ZERO defs until task 7), scope→owner_home v1 (`open/composer.ts`).
- **Tests** — `runtime/subagent/spawn-lane.test.ts` (lane isolation both directions);
  `agent-dispatch/substrate-turn.test.ts` (tools→spec.tools names / omitted→[]);
  `reminders/tick.test.ts` (ritual→executor not dispatcher/on_fired; nudge contract
  untouched; recurring ritual advances with NO revert on fire() reject; unwired→
  consumed+logged; fire-and-forget proof); `reminders/ritual-executor.test.ts`
  (skip verdicts durable + no spawn; approved → registry 'ritual' + 'running' row
  content_hash + turn input; each terminal mapping; crash; spawn-cap 'failed' no
  leak; fire() never rejects); `gateway/wiring/__tests__/substrate-profiles.test.ts`
  (PROFILE_RITUAL byte-identity + append_system_prompt_file threading);
  `gateway/composition/build-core-modules-ritual-executor.test.ts` (factory invoked
  with the graph ApprovalManager + wired as the tick branch, mutation-kill).
  `bash scripts/ci/depcruise.sh`: NO new cross-band edge.

## 2026-07-21 — Executor-mode reminders task 3: content-hash ritual approval gate + real approval notifier

The approval infrastructure that gates every ritual fire, plus the composer's
FIRST real `approval_notifier` (was a no-op stub). No new table, no migration —
durable grants are ordinary `tool_approvals` rows (migration-0004 DDL,
`migrations/0004_gateway_core.sql:66-79`). Spec of record:
`docs/plans/executor-mode-reminders-2026-07-20.md`.

- **`ApprovalManager.findApproved(project_slug, tool_name)`** (`tools/approval.ts`)
  — a generic synchronous query returning every `status='approved'` row for the
  pair, `ORDER BY decided_at ASC` (mirrors `get`/`listPending`). This is the ONLY
  ritual-agnostic addition to the platform layer; ALL ritual logic lives in
  `reminders/` (a legal services→platform edge — `.dependency-cruiser.cjs`
  `platform-stays-low` forbids the reverse).
- **`reminders/ritual-approval.ts`** (new; `reminders/package.json` gains
  `@neutronai/tools`):
  - `computeRitualContentHash` — SHA-256 hex over a canonical JSON ARRAY of
    (prompt bytes ‖ SORTED tool surface ‖ scope ‖ cadence ‖ model tier ‖
    timeout). JSON-array canonicalization is delimiter-injection-proof; sorting
    the surface makes grant order irrelevant.
  - `ritualCadenceString` — `spec:<cron>` | `legacy:<coarse>` | `once` from the
    row's mutually-exclusive `recurrence_spec`/`recurrence` (`reminders/store.ts:41-49`).
  - `ritualApprovalToolName`/`ritualEgressApprovalToolName` — the namespaced
    `tool_name` (`ritual:<id>` / `ritual-egress:<id>`); `:` is forbidden in both
    the ritual id charset and tool tokens, so these never collide with a real tool grant.
  - `requestRitualApproval` — submits a `prompt-user` request (the FIRST real
    production caller of `ApprovalManager.requestApproval`) carrying the content
    hash in `args_json`; an `egress:'web'` def mints a SECOND, separately-approved
    `ritual-egress:<id>` request bound to the SAME hash (approving content never
    implicitly approves egress). Returns both decision promises without awaiting.
  - `createRitualApprovalCheck({manager, project_slug, cadence})` — implements
    task 2's `RitualApprovalCheck` seam. RECOMPUTES the hash from the LIVE prompt
    bytes on EVERY `isApproved` call (ported Vajra prompts are mutable files);
    requires a content grant, and for web defs an egress grant, whose
    `args_json.content_hash` matches. A malformed `args_json` row is skipped
    (never a match, never a throw); DB/manager errors PROPAGATE so
    `validateRitualFire` fail-closes to 'unapproved'. **Design consequence:**
    a cadence change or a `reminders_update` (atomic cancel+create → new id,
    `cores/free/reminders/src/mcp-tools-extra.ts:64`) DROPS approval.
- **`open/wiring/approval-notifier.ts`** (new) — `buildAppWsApprovalNotifier`
  replaces the composer's `approval_notifier: { notify: async () => undefined }`
  no-op (`open/composer.ts`, base composition). Broadcasts a PLAIN-TEXT
  `agent_message` (`Approval requested [<id>]: <tool_name>[ — <description>]`) to
  every live app-ws topic per the `watchdogNotifier` precedent (composer
  ~3338-3364); fail-soft throughout (never throws into `ApprovalManager`; one dead
  socket never stops the rest). NEVER includes prompt bytes / tool surface / args
  beyond `description`, never Markdown — the rich itemized rendering with the
  affirmative-act binding is task 8. `appWsRegistry` (composer :2051) satisfies
  the structural `ApprovalNotifierRegistry` by construction.
- **NO auto-approval anywhere** — every request is `policy:'prompt-user'`; a
  bundled ritual stays unapproved (→ fire-time SKIP) until the owner's explicit
  `respondApproval`. No-self-approval enforcement (`resolution_speaker_user_id`)
  arrives with task 8's ButtonStore surface.
- **Tests** — `reminders/ritual-approval.test.ts` (11 cases: hash determinism +
  per-field sensitivity + order-insensitive surface; cadence-string; single- and
  dual-grant request with durable-record assertions; end-to-end seam bind over the
  real registry with an on-disk prompt; RE-VERIFY-EVERY-FIRE prompt-tamper drop;
  cadence-change drop; egress-separately-approved; denied/pending/malformed
  non-match; throwing-store fail-closed through `validateRitualFire`; no-auto-approve
  pending-decision). `tools/approval.test.ts` +1 (`findApproved` slug/tool/status
  filtering). `open/__tests__/approval-notifier.test.ts` (3: per-topic broadcast +
  body content, malformed-args fallback, dead-socket resilience). All green;
  `reminders/` + `tools/` suites 275 pass; dep-cruiser + tsc (reminders/tools/open) clean.

## 2026-07-20 — Executor-mode reminders task 2: ritual schema + registry module (migration 0106)

The persistent + pure-logic foundation of the ritual layer (executor-mode
reminders — a reminder that spawns a scoped sub-agent REPL at fire time instead of
composing a nudge). Schema + registry only; the tick dispatch branch, approval
gate, and completion delivery are plan tasks 3-5. Spec of record:
`docs/plans/executor-mode-reminders-2026-07-20.md`.

- **Migration `0106_ritual_schema.sql`** — three forward-only DDL units:
  (A) nullable opaque-TEXT `reminders.ritual_id` (0095 `recurrence_spec`
  precedent — the in-process registry is the authoritative validator, a CHECK
  would force a table rebuild per ritual; NULL = nudge row, no backfill); (B) new
  durable `code_ritual_runs` run-history table (own retention, NOT pruned on the
  subagent-registry liveness prune, `runtime/subagent/store.ts:171` — the durable
  answer to "why didn't my morning brief run"; richer status vocab than the
  registry: `skipped`/`running`/`finished`/`failed`/`timed_out`/`crashed` +
  `skip_reason` CHECK-coupled to `skipped` via `CHECK ((status='skipped') =
  (skip_reason IS NOT NULL))`; carries `subagent_run_id`/`content_hash`/
  `failure_reason`/`output_summary`; a `ritual`+`started_at` index and a partial
  `live` index); (C) widened `code_subagent_registry.agent_kind` to admit
  `'ritual'` via create-copy-drop-rename (SQLite cannot ALTER a CHECK), the 0100
  DDL reproduced verbatim with only the enum widened, STRICT + all CHECKs + both
  0100 indexes preserved, rows copied by explicit column list. `expected-schema.txt`
  regenerated (only the three expected shapes — reminders col, new table+indexes,
  agent_kind enum + the RENAME name-quote); `runner.test.ts` version list + 106.
  NO `table-ownership.json` entry — coverage is opt-in and this table has no
  writers yet (the first runtime-writer task adds it).
- **`AgentKind` widened** (`runtime/subagent/registry.ts:25`) to include `'ritual'`.
  Consumers are `Partial<Record<AgentKind,…>>` (watchdog, dispatch prompts) OR
  narrow the union with `Exclude`: trident `DispatchAgentKind` now excludes BOTH
  `'core'` and `'ritual'` (`trident/agent-prompts.ts:50`) so its persona
  `Record`s stay exhaustive — a ritual is spawned by the reminders tick with its
  own `rituals/<id>.md` prompt, never through the trident persona loader (Argus
  round-2 BLOCKER fix: the earlier "compile-safe, only Partial consumers" claim
  was false — `PersonaAgentKind` derives from `AgentKind` via non-partial
  `Record` and broke `tsc`).
- **`reminders/rituals.ts`** — the pure registry + fail-CLOSED fire-time verdict.
  `RitualDef` (charset-guarded id `^[a-z0-9][a-z0-9-]{0,63}$` — traversal
  impossible by construction; `description` non-empty ≤200 chars = the approval
  capability line [task 8]; `scope` project|instance; `tool_surface` NEVER empty
  [#361 toolless-class pin], each entry a tool token [`Bash` allowed — overturn 1,
  security rides the approval gate not exclusion]; `egress` `'none'|'web'`
  register-time-consistent with the surface; `silent`; NO `requires_approval`,
  NO `prompt_path`/`model`/`timeout` fields — approval is a separate content-hash
  record [task 3], prompt derived `rituals/<id>.md`, tier `'best'` + 45-min
  timeout are module constants). `createRitualRegistry({rituals_dir})` →
  `register()` (throws on bad id/dup/empty-or-long description/empty surface/bad
  token/egress-inconsistency; stores a frozen copy) / `get` / `list` /
  `promptPathFor`. Argus round-2: `assertValid` now also runtime-guards the
  `scope`/`egress`/`silent`/`tool_surface` field TYPES (a def can arrive from
  imported user-data JSON the compiler never saw — a bogus `scope:'arbitrary'`
  or `egress:'bogus'` now FAILS CLOSED at register time instead of slipping past
  the consistency checks). Argus round-3 extends this to the two regex-validated
  fields: `def.id` and each `tool_surface` entry now get a `typeof … !== 'string'`
  guard BEFORE `RegExp.test` (which stringifies its argument, so `42`→`"42"` and
  `null`→`"null"` would MATCH the charset and register under a non-string Map key
  / freeze a non-string tool grant into the surface that flows to approval hashing
  + spawn — now both throw). `validateRitualFire(registry, approvals, id, log)`
  async → `unknown_ritual` | `missing_prompt` (missing/unreadable/empty/over-256KB;
  the 256 KiB cap is now enforced from `statSync().size` BEFORE the file is read
  into memory — Argus round-2 minor) |
  `unapproved` (false OR THROW — fail CLOSED) | ok. The `RitualApprovalCheck` seam
  is REQUIRED (no permissive default anywhere), consulted only after the prompt is
  read. A fail verdict logs once and SKIPs — never degrade-to-nudge, never
  `tools:[]`.
- **`reminders/store.ts`** — `ritual_id` is READ-THROUGH only: plumbed through
  `Reminder`, `ReminderDbRow`, `COLS`, `rowToReminder`, and the two return
  literals (`ritual_id: null`). Deliberately NOT added to `CreateReminderInput` /
  `CreateRecurringReminderInput` and NOT written in either INSERT — the only writer
  lands with its validation (registration = task 8, tick wiring = task 4), so the
  column defaults NULL untouched. Public surface exported from `reminders/index.ts`.
- **Tests** — `reminders/rituals.test.ts`: registry round-trip + frozen-copy
  independence; every `register()` invariant is a throw (bad ids, dup, empty
  surface, bad token, both egress inconsistencies, empty/over-long description,
  Bash-surface accepted); all four fire verdicts with `not.toHaveBeenCalled` on
  early skips and `toHaveBeenCalledWith(def, exact-bytes)` on the approval seam,
  approval-THROW → unapproved with a single log line, artifact-grounded happy-path
  marker + no-fallback-shape assertion; constants; 0106 CHECK tests
  (`agent_kind` ritual ok / bogus rejected, `code_ritual_runs` status +
  skip_reason invariant) + a rebuild-preserves-data test (apply 0000-0105, insert
  a legacy `forge` row, apply 0106, assert the row survives field-for-field and
  `ritual` now inserts). `reminders/store.test.ts`: create() defaults `ritual_id`
  null + a raw-`UPDATE` read-through round-trip (the write path deliberately
  doesn't exist yet).

## 2026-07-20 — M2-3 round 2: §7.2 merge-safety gate closes the memory-consolidation arming precondition (Argus r1 BLOCKER)

Task 1 of the executor-mode-reminders branch armed the 6h memory consolidation ON
by default (P0-4), but the memory-system design named two mitigations as "STILL
PENDING before arming" (the §7.2 name-tripwire and merge-loser quarantine) and the
dedup code comments lied about them — `jaccard.ts` claimed "consolidation is not
armed" (now false) and cited a "§7.2 merge name-tripwire" that had no
implementation. Argus flagged the armed-without-mitigation state as a corruption
BLOCKER. This round implements the actual safety gate that prevents the
irreversible false-fusion and makes the comments true.

- **`isMergeSafeCluster` merge-safety gate** (`scribe/reflect/jaccard.ts`), applied
  by `dedupPages` to every candidate cluster BEFORE the irreversible fuse
  (`scribe/reflect/reflect-pass.ts`). Two gates block the two false-positive
  signatures the 0.7 Jaccard cut alone would let through:
  - Gate A (**shared name token**) — HOLDS two DIFFERENT-named entities that reach
    the bar only via shared relation targets (`Bob`/`Carol` each `Works at
    [[org0]]/[[org1]]/[[org2]]` = 0.714 but share no name token). §7.2 residual B.
  - Gate B (**corroboration beyond the name**) — excluding the name, members must
    still be pairwise ≥ threshold similar on BODY-ONLY tokens; HOLDS two DISTINCT
    fact-less entities sharing an identical name (two "John Smith" pages score 1.0
    on name tokens but collapse to empty body sets once the name is excluded).
    §7.2 residual A. Name exclusion is EXPLICIT: each candidate's title tokens are
    subtracted from its body token set before the pairwise score, because
    `stripBoilerplate` only removes the generated `# <Name>` H1 — name tokens that
    appear in PROSE (`John Smith is an engineer at Google` vs `… at Facebook`) would
    otherwise inflate body Jaccard to 0.75 ≥ 0.7 and irreversibly merge two distinct
    people; with title tokens subtracted the score drops to 0.667 < 0.7 → correctly
    HELD (Argus r1 blocker fix).
- **HELD ≠ merged.** A held cluster keeps every member as its own survivor (the
  pass's always-safe missed-merge direction), increments the new
  `ReflectReport.held` counter, and is logged LOUDLY so the owner can hand-merge a
  genuine duplicate the gate was conservative on. Merge-loser quarantine is NO
  LONGER an arming blocker — the gate prevents the false identity-fusion outright,
  and genuine near-duplicate losers are already absorbed into the survivor before
  deletion (no content loss).
- **Comments/docs corrected** to match the armed reality: `jaccard.ts`
  (`DEFAULT_JACCARD_THRESHOLD` + `MIN_DISTINGUISHING_TOKENS` doc), the memory-system
  design doc's "STILL PENDING before arming" block, and SYSTEM-OVERVIEW's dedup
  section (which had downgraded "close before arming" to "corpus-tuning follow-up").
- **Tests** (reproduce-then-fix): `scribe/__tests__/reflect-jaccard.test.ts`
  (`isMergeSafeCluster` holds residuals A + B, passes genuine near-duplicates,
  singleton trivially safe) and `scribe/__tests__/reflect-pass.test.ts`
  (behavioural, real on-disk: two "John Smith" pages HELD with both surviving +
  nothing deleted + `report.held == 1`; `Bob`/`Carol` HELD; genuine near-duplicates
  still merge with `report.held == 0`). Suite: 122 scribe tests green.
- **Argus r1 minors** also addressed: `open/__tests__/reflect-loop-arming.test.ts`
  leak-guard now spies on `SupervisedLoop.start` keyed on the loop's IDENTITY
  (`name`), not the no-longer-unique 6h cadence; `open/__tests__/loop-inventory-boot-shell.test.ts`
  real-boot test timeouts raised 30s→60s to absorb full-suite-parallelism
  contention (a genuinely-hung boot is still a distinct, louder signal).

NOTE: the executor-mode reminders deliverable (ritual schema, executor dispatch
branch, approval gate, T5 write-containment) is NOT built by this PR — it is the
remaining RALPH iterations 2–10 on `IMPLEMENTATION_PLAN.md`. This branch is Task 1
(consolidation flag-collapse) + its arming precondition. P0-1 M2 is NOT done.

## 2026-07-20 — #374 Defect 2a: the LIVE onboarding-complete emit stamps the durable handoff marker ONLY on real delivery (kills the residual post-claim bounce)

Closed the OPEN half of the #374 claim-jank fix. The reconnect-recovery replay in
`open/wiring/app-ws.ts` re-fires `onboarding_completed` while
`onboarding_handoff_emitted_at` is still NULL and phase === `completed`. Migration
0054 (`0054_onboarding_state_handoff_emitted_at.sql`) + #404 made the REPLAY path
stamp after its own send (stopping the INFINITE loop), but the LIVE emit at
finalize never wrote the stamp — so on a Managed box the FIRST reconnect after
finalize still saw a null stamp and re-fired the frame ONCE, bouncing the
just-completed owner to the claim / manual-link screen (#374 Defect 2). The signal
was at-most-once per page load on the replay side but NOT at-most-once across the
live + replay paths.

- **Delivery-aware stamp on the live emit** (`onboarding/openings/finalize.ts`,
  step (5c), right after `deps.emitOnboardingCompleted?.(...)`). The emit seam now
  RETURNS whether the frame reached at least one live socket:
  `fanOnboardingCompleted` (`open/composer.ts`) accumulates the registry
  `send()` boolean (`channels/adapters/app-ws/session-registry.ts` returns true iff
  a device received it) and returns it; `emitOnboardingCompleted` propagates it.
  finalize stamps `onboarding_handoff_emitted_at` (via the SAME
  `OnboardingStateStore.upsert` the replay path uses) ONLY when that delivery is
  true. Gating on delivery — not on the seam being wired (the seam is
  UNCONDITIONALLY wired in production) — is the round-2 correction: a finalize that
  reaches ZERO sockets (a background import-completion watcher fires with the tab
  closed) leaves the stamp null so the reconnect replay still recovers the claim
  redirect exactly once. Guarded + idempotent (only stamp while still null, so a
  coalesced/duplicate finalize never double-stamps) and best-effort + non-throwing
  (a failed stamp never rolls back the completed owner; worst case is one extra
  replay, the pre-fix behaviour).
- **Result**: when the live frame was delivered, the post-finalize reconnect reads
  a non-null stamp and does NOT re-emit → no residual bounce; when it was dropped,
  the null stamp keeps the reconnect replay armed for exactly-once recovery.
  `onboarding_completed` is now genuinely at-most-once across the live + replay
  paths without stranding the offline-finalize owner.
- **Tests** (reproduce-then-fix):
  `gateway/wiring/__tests__/build-onboarding-finalize.test.ts` — a LIVE, DELIVERED
  emit finalize now stamps `onboarding_handoff_emitted_at` (failed on prior main:
  stayed null) + a guard-negative that the app-ws replay predicate
  (`completed && stamp === null`) is false afterwards; a seam-WIRED-but-ZERO-SOCKETS
  finalize (frame dropped) leaves the stamp null so the replay predicate stays true
  (fails under the round-1 seam-gated fix, which stamped and stranded the offline
  owner); and an LLM-less-path (no seam) test that the stamp stays null.
  `tests/integration/claim-redirect-once.open.test.ts` — after a real live+delivered
  finalize, the FIRST reconnect against the real app WebSocket emits ZERO
  `onboarding_completed` frames (failed on prior main: the null stamp let the replay
  re-fire once). Scope: the live-emit stamp only; the Managed claim flow (Defect 1
  start-token + 2b auto-redirect) is a separate PR.
## 2026-07-20 — Per-project isolated onboarding compose (#377 + #378, Approach A)

Closed the two trust-critical onboarding-opening defects (SPEC Decisions Log
2026-07-20 "Per-project session OPENINGS are FULLY LLM-composed + unique per
project"), the SAFE way — WITHOUT the two BLOCKERS the prior attempt (#419) hit
(reusing the live-chat `cc-agent-*` pool key, which could evict an in-flight live
turn (B1) and open a tool-enabled prompt-injection path (B2)). Each half ships a
reproduce-then-fix test that FAILS on prior main.

- **#378 cross-project bleed — isolate BOTH the openings AND the doc materializer**
  (`open/wiring/substrates.ts`, `open/composer.ts`, `gateway/wiring/build-project-doc-composer.ts`,
  `gateway/wiring/build-project-kickoff-composer.ts`). Previously the project-doc
  composer (README / `docs/transcript-summary.md`), the agentic-kickoff DOC
  composer (`starting-plan.md`), and the opening composer ALL shared ONE
  accumulating owner-wide `cc-llm-*` phase-spec session, so project 2/3's docs +
  openings echoed project 1. New `makeComposeSubstrate(project_id)` factory builds
  a per-project `cc-compose-*` substrate with `projectIdResolver: () => project_id`;
  the composers resolve their client through a `clientForProject(project_id)`
  factory (`composeClientForProject`). The warm-pool key folds the project id
  (S3 §2), so each project keys a DISTINCT transcript → no bleed. Closing the DOC
  MATERIALIZER too (not just the openings) is what fully closes #378 (B3 — the docs
  FEED the openings).
- **Approach A safety (fixes #419's B1/B2)** — `cc-compose-*` is a DISTINCT pool-key
  namespace from live-chat `cc-agent-*`, so a compose can NEVER evict/terminate the
  owner's in-flight live-chat turn (B1); it is TOOLLESS (no `enableToolBridge`, new
  `PROFILE_ISOLATED_COMPOSE`) so untrusted project-doc-derived input has no tool
  surface and cannot persist into a tool-enabled live session (B2); and it wires
  NONE of the owner-facing notice/delivery sinks, so compose text/banners never
  post to the owner's chat (B2 side-effect).
- **#377 hardcoded lead removed — opening is FULLY LLM-composed** (`onboarding/openings/kickoff.ts`,
  `gateway/wiring/build-project-kickoff-composer.ts`). Dropped the two hardcoded
  lead scaffolds ("I took a first pass at X and drafted a starting plan" / "I did a
  little digging on X and jotted some starting notes"). The kickoff composer gains
  an `opening_message` kind that composes the presenting chat bubble in the SAME
  per-project isolated session (grounded in the project's signal + the drafted doc
  gist); the kickoff appends the tappable `docs:/` link. On any message-compose
  failure it degrades to the doc's own first prose paragraph — and, for a
  heading-only generated doc, to the doc's OWN first heading text
  (`firstHeadingText`) — always project-unique + document-derived, never the
  retired generic boilerplate (round-2: Argus flagged the last-resort rung as a
  reusable-across-projects hardcoded lead; the heading-derived rung closes it).
- **Tests** — `#378` cross-bleed (real composer, 3 projects, isolated vs shared
  session model — the shared path demonstrates the on-main bleed); white-box
  isolation (`cc-compose-*` keyed by project_id, distinct pool key, toolless, no
  sinks); no-mid-turn-kill (compose never shares the `cc-agent-*` key); #377
  (openings vary per project + no hardcoded lead). `bun test onboarding/` 940/0;
  touched gateway/open wiring suites green.
- **Scope** — ZERO changes to the live-chat `cc-agent-*` turn logic, the phase-spec
  resolver/suggester session, or unrelated onboarding phases.

## 2026-07-20 — #371 (part b): tenant-side auth screen is managed-unreachable

The OSS install-token / Claude-auth surface in `landing/server.ts` is now gated
OFF on a **managed** tenant — the Open-side backstop for #371 (Ryan saw a
DUPLICATE auth screen on a managed box). The install-token surface exists for an
OSS self-hoster with no control plane; on managed the control plane owns auth
(the tenant is seeded with the Max token by the control-plane handoff — the #371
control-plane RACE half is already fixed + deployed in the Managed repo), so the
tenant-side screen must be UNREACHABLE.

- **Deployment-role signal reaches the landing server.** `LandingServerOptions`
  gains `deploymentMode?: 'open' | 'managed' | 'connect'`, threaded from the
  canonical `resolveDeploymentMode()` (`NEUTRON_ROLE`) in
  `gateway/wiring/build-landing-stack.ts`. When the option is unwired,
  `createLandingServer` falls back to `resolveLandingDeploymentMode(process.env)`
  (a local mirror of `gateway/deployment-mode.ts` — landing takes no dependency
  on gateway) so the gate holds env-derived even if a composer forgets it. NOT a
  feature flag: the same managed-vs-open discriminator onboarding sequencing uses.
- **Two gates, when role === managed** (`landing/server.ts`):
  the four `/oauth/max/install-token/*` routes are intercepted BEFORE
  `installTokenHandler` (`landing/server.ts:901`), and `GET /chat`'s
  `chatAuthGate` unauthenticated branch (`landing/server.ts:968`) — both serve
  the neutral `renderManagedProvisioningHtml` "workspace is being provisioned"
  page (HTTP 503) instead of the OSS auth screen. Open/self-host default: both
  surfaces serve normally.
- **Reproduce-then-fix test** (`landing/__tests__/managed-install-token-gate.test.ts`,
  8 tests): managed → install-token route + `/chat` gate → 503 provisioning page
  (NOT the OSS screen); open → both serve; `NEUTRON_ROLE=managed` env backstop
  with the option unset. Verified FAILING on prior main (managed install-token
  route returned the OSS handler's 200, not 503).

## 2026-07-20 — #375: post-onboarding workspace opens on General, not a random project

The workspace `/chat` load (notably the post-onboarding Managed claim redirect to
`https://<slug>/chat`, which carries NO topic) used to land on an arbitrary PROJECT
topic — a confusing "where am I?" landing. Root: `landing/chat-react/config.ts`
`resolveBootstrapConfig` read the server-injected `window.__neutron_active_project_id`
(set to the FIRST project row by `open/wiring/owner-gate.ts:216`) as the initial
scope, so a bare load opened whatever project happened to be first.

- **Client default is now General** (`landing/chat-react/config.ts`). New pure helper
  `initialProjectIdFromLocation(search, projects)` decides the initial scope: it
  returns a project id ONLY for an explicit deep-link on the page URL —
  `?project=<id>` (canonical) or `?topic=<id>` (alias) — validated against the
  project-id char class AND the injected project list (unknown/malformed → General).
  Everything else → `null` (General). `__neutron_active_project_id` is no longer read
  for the initial scope (kept on the `WindowLike` type + still server-injected for
  back-compat, marked deprecated). Deep-links to a specific project topic still open
  that project.
- **Tests** (`landing/chat-react/__tests__/config.test.ts`): reproduce-then-fix —
  a bare `/chat` load with `__neutron_active_project_id: 'p1'` injected now resolves
  `projectId: null` (FAILED on prior main, which returned `'p1'`); `?project=`/`?topic=`
  deep-links open the named project; unknown ids fall back to General. Full
  `landing/chat-react` suite green (371 pass, 0 fail).

## 2026-07-20 — Chat #376: a RAW doc-link in a chat message opens the Docs tab

Fixed the live #376 defect (hit 2026-07-20 on the onboarding "first pass" message):
a file/doc link in a chat bubble did NOTHING when clicked. Root cause, verified
against real rendering: `rehype-sanitize` strips a `docs:`/`neutron:` scheme href
BEFORE any click handler can read it, so a bubble carrying the canonical marker
`docs:/<id>/<path>` or the native `neutron://docs/<id>/<path>` shape rendered a
DEAD link (an `<a>` with no `href`). The `app-ws` adapter rewrites LIVE web pushes
to the web `/projects/<id>/docs?path=…` shape (which the client already
intercepts), but the RESUME replay (`appChatRowToEnvelope`) re-emits the persisted
body verbatim, and that body is channel-baked at send time — so a non-web-baked
doc-link reaches the web client raw.

- **FIX (client, in Neutron Open)** — `landing/chat-react/doc-link-nav.ts` adds
  `webifyDocLinkHref`, which normalizes the two RAW project-doc shapes
  (`docs:/<id>/<path>` marker + `neutron://docs/<id>/<encoded path>` native scheme)
  to the same-origin `/projects/<id>/docs?path=<enc>` URL (traversal-guarded,
  anchor-tail-stripped). `landing/chat-react/Markdown.tsx` runs it as a rehype
  plugin (`rehypeWebifyDocLinks`) BEFORE `rehype-sanitize`, so the href survives
  sanitize and the existing `onDocLink` tap-interception (+ SPA-boot handler) open
  it in the Documents tab. External URLs and the already-web shape are untouched.
- **Tests (reproduce-then-fix)** — `__tests__/doc-link-raw-marker-open.test.tsx`
  delivers a RAW `docs:/acme/brief.md` marker, clicks it, and asserts the Documents
  tab activates + the doc opens (FAILS on prior main: the link had no href → the
  click was inert). `__tests__/doc-link-nav.test.ts` adds `webifyDocLinkHref` unit
  coverage (marker, native, nested, anchor-strip, traversal-reject, external
  untouched, `.`/`..` projectId rejected). `landing/chat-react` suite green
  (382 pass, 0 fail on current main post-rebase).

## 2026-07-20 — Work Board #379: trackable work ≠ a Trident build run

Closed the three #379 dogfood defects rooted in "a Work Board card == a Trident
BUILD run" (SPEC Decisions Log 2026-07-20 "Work Board: 'trackable work' ≠ 'a
Trident build run'"). Each ships a reproduce-then-fix test that FAILS on prior main.

- **WRITE — leave a card for ANY substantial work** (`gateway/wiring/operating-doctrine.ts`).
  Lifted "leave a trackable Work Board card for ANY substantial/multi-step work —
  research, analysis, deep work, OR a build: `work_board_add` FIRST, set
  `inline_active` while working, mark done when finished" into an UNCONDITIONAL
  `DOCTRINE_PRINCIPLES` entry (ships every turn). Previously the ONLY card
  directive lived in `BUILD_ROUTING_DOCTRINE` — scoped to explicit builds AND
  phrased "if you have the `work_board_dispatch_build` tool", so a research job
  left no card. Trident-routing specifics stay build-scoped.
- **DISPLAY — a plain active card opens the pane** (`landing/chat-react/WorkBoardTab.tsx`
  `summarize`, `landing/chat-react/PlansPane.tsx` controller). `WorkBoardSummary`
  gains `active` = a non-terminal in_progress/inline_active card with NO live run
  (`linked_run_id: null`). The desktop pane now KICKS OPEN on `running` OR `active`
  rising, stays open while any of running/failed/active > 0, and auto-CLOSES only
  once ALL THREE are zero. Sticky + manual-toggle preserved. Fixes the plain
  in_progress card that never opened the pane.
- **ROUTING + LIFECYCLE — the ▶ routes BY TASK TYPE** (migration `0105`, `work-board/store.ts`,
  `gateway/http/work-board-surface.ts`, `agent-dispatch/board-research-start.ts`,
  `open/composer.ts`, `landing/chat-react/*`). New `task_type` column ('build' |
  'research', DEFAULT 'build') + a minimal web Build/Research picker. The ▶/play
  route now branches: a 'research' card dispatches an **Atlas** research run
  (agent-dispatch), a 'build' card dispatches **Trident**. Research LIFECYCLE
  (`createBoardResearchStarter`): delivers the Atlas result back to the originating
  chat via the durable app-ws poster (persisted → renders in React), and on
  terminal (success OR crash/cancel/timeout) marks the card terminal (done |
  failed) so the pane auto-closes — never stranding it in_progress. Guards:
  surface `409 already_running` on a live linked run + a per-card `spawn_key`
  coalesce (no duplicate Atlas run) + delete-cancels the dispatch run.

> Pre-consolidation history (unit K6, 2026-07-05): the former root `AS-BUILT.md`
> (7,647 lines — the anchored record of behavioral invariants through 2026-07-04)
> is archived VERBATIM at `docs/research/AS-BUILT-archive-2026-07.md`, and the
> former `docs/AS-BUILT.md` (1,469 lines — PTY terminal-detection ports, the
> Trident v2 Workflow cutover, Work Board Phase 1a/1b, parity-gap closures) at
> `docs/research/AS-BUILT-docs-archive-2026-07.md`. This file is the ONE live
> changelog going forward.

## 2026-07-20 — M2-3 / P0-4: `NEUTRON_PERFECT_RECALL` collapsed — perfect-recall lane default-ON, 6h consolidation

Deleted the `NEUTRON_PERFECT_RECALL` feature flag (`runtime/perfect-recall-flag.ts`
+ its test + the sole-consumer `runtime/env-flag-tokens.ts`). The whole
perfect-recall lane — RB1 memory-index manifest, RB3 reflect-consolidation loop,
RB4 supersede, RC2 agent-nexus — is now the UNCONDITIONAL default, and the reflect
consolidation cadence flips 24h→6h ON by default (`DEFAULT_REFLECT_INTERVAL_MS =
6 * 60 * 60 * 1000`, `scribe/reflect/reflect-pass.ts`). This clears the standing
no-feature-flags violation (Ryan-locked, no dual code paths) and creates the
always-running attachment point the dreaming-half-into-core-memory work needs.
Ryan-locked: consolidation every 6h, ON by default (neutron-managed SPEC Decisions
Log 2026-07-20; managed SPEC §374-376; deepened plan build-order #1).

- **Four un-gated sites in `open/wiring/memory.ts`** — `memoryIndexHook`
  (wrap-sync-hook-with-memory-index, RB1), scribe `supersede` (RB4), `nexus =
  new NexusStore(...)` (RC2), and the `reflectLoop` `SupervisedLoop` (RB3) are all
  constructed unconditionally. The `WiredMemory` type tightens to non-optional
  (`memoryIndexRead: () => Promise<string | null>`, `nexus: NexusStore`,
  `reflectLoop: SupervisedLoop`), so the composer's `reflectLoop !== null` /
  `memoryIndexRead !== undefined` null-guards are removed (register-before-start +
  quiescing-stop ordering preserved verbatim).
- **LLM-less degrade path survives** — the substrate is still `llmPool`-gated
  (a real runtime condition, not a flag): an LLM-less box gets scribe=null and a
  dedup-only reflect pass, and `immediate:false` means no boot-time LLM call.
- **`supersede` option removed from the public scribe surface** (`scribe/extract.ts`,
  `scribe/index.ts`, `scribe/write-to-gbrain.ts`) — belief-evolution supersede is
  always on; the RB4 `relations[].supersedes` data marker is unchanged.
- **`gateway/nexus/nexus-emit.ts`** drops the dead `isPerfectRecallEnabled`
  re-export (grep-zero importers) and its flag-era doc block.
- Acceptance: `grep -rn "NEUTRON_PERFECT_RECALL|isPerfectRecallEnabled|perfect-recall-flag"
  --include='*.ts'` (excl. node_modules) → ZERO hits; a default-env boot constructs +
  registers + starts the reflect loop at 6h (`reflect-loop-arming.test.ts` asserts
  `describe().intervalMs === 21_600_000` with NO env var set); `bun test` green.

## 2026-07-20 — M2-3: memory-consolidation correctness — 3 dedup/supersede corruption blockers

Closed the three data-integrity blockers that gate the memory build
(memory-system-design-2026-07-20 blockers 1–3). All are correctness fixes to the
consolidation code — now the always-on default (the `NEUTRON_PERFECT_RECALL` flag
that gated it was collapsed the same day; see the entry above). These protect the
owner's canonical corpus from silent permanent corruption when consolidation runs.
Each fix ships with a reproduce-then-fix test that provably FAILS on the prior main.

- **BLOCKER 1 — dedup no longer fuses UNRELATED entities** (`scribe/reflect/jaccard.ts`).
  On main, five fact-less company pages (`# <Name>` + `Mentioned in chat (kind: X).`)
  collapsed into ONE entity in a single transitive pass — the exact corpus shape
  every real install accumulates. Three vectors fixed:
  - (1a) `stripBoilerplate` strips ONLY generated boilerplate before scoring — the
    generated title H1 (label == page title), the generated section headings
    (`## Relationships`/`## Merged`), and the fact-less `Mentioned in chat` line —
    and NEVER a hand-authored factual heading at any level (the #415 over-reach
    stripped ALL H1s and destroyed distinguishing factual tokens → false merges).
  - (1b) `tokenize` KEEPS numeric/alphanumeric tokens (`2024`, `q1`, `v2`) that
    `Intl.Segmenter` marks non-word-like and the old `continue` DROPPED, so
    fiscal-year / versioned / quarterly pages keep their only discriminator
    (ISSUES #373, resolved).
  - (1c) clustering now forms CLIQUES (every pair ≥ threshold — no transitive
    closure; a greedy clique that never over-merges) and requires
    `MIN_DISTINGUISHING_TOKENS` (= 2) non-boilerplate tokens for a page to be a
    merge candidate. The Jaccard threshold stays 0.7, configurable, flagged
    UNVALIDATED (must be re-measured on a real corpus before arming). Known accepted
    residuals to close before arming: (i) two DISTINCT fact-less entities sharing an
    identical ≥ 2-word name still merge (gated behind the merge name-tripwire);
    (ii) two DIFFERENT-named entities each asserting the SAME ≥ 3 relation targets
    can reach 0.714 because relation-verb tokens are not stripped and shared targets
    inflate overlap (`Bob`/`Carol` each `Works at [[org0/1/2]]`). Fix before arming:
    strip relation-verb tokens and/or gate a merge on a shared name token.
- **BLOCKER 2a — supersede survives resynth** (`stripSupersededSentences`,
  `scribe/write-to-gbrain.ts`). The strip is now keyed on the graph TRIPLE
  (predicate, object), not on matching the generated `RELATION_SENTENCE` template.
  On main, once a page was resynthesized into natural prose, every future supersede
  on it was a silent permanent no-op (`works_at NewCo` AND `works_at OldCo`
  asserted forever). Compound sentences are still spared entirely. Accepted residual:
  a single-relation sentence with descriptive prose is dropped IN FULL — the retired
  relation persists as an additive dated timeline row (`works_at oldco`), but
  `stripSupersededSentences` writes NOTHING to the timeline, so the sentence's
  descriptive detail and any co-located still-current non-edge fact (`earns $400k`)
  leave current truth and are not re-recorded. (Runs under the always-on
  consolidation default — see the flag-collapse entry above.)
- **BLOCKER 2b — resynth may not mutate a predicate** (`preservesEdges`,
  `scribe/reflect/reflect-pass.ts`). The accept-gate now compares extracted
  (predicate, object) PAIRS, not just wikilink TARGETS. On main a rewrite that kept
  the target but changed the verb (`Works at [[acme]].` → `Mentions [[acme]].`)
  passed the gate and committed, degrading a `works_at` edge to `mentions` — and
  because supersede is predicate-scoped, that mutated edge could then never be
  retired. Such a rewrite is now REJECTED.

Tests: `scribe/__tests__/reflect-jaccard.test.ts` (dedup vectors, clique,
min-token, numeric tokens, boilerplate strip), `scribe/__tests__/reflect-pass.test.ts`
("a re-synthesis that MUTATES a predicate on a preserved target is rejected"),
`scribe/__tests__/scribe-temporal-invalidation.test.ts` ("a SINGLE-relation PROSE
sentence for a superseded target IS retired"). Full `bun test scribe/` green (119).
Explicitly OUT of scope: blocker 4 (token-budget), doctor sequencing, the
timestamp-ordering guard, the watermark.

## 2026-07-20 — M2-1: the Cores→scribe fan-out now receives the LIVE Google clients

Closed a "wired but does nothing" partial-port. The Cores→scribe phase-2 fan-out
(scheduled Calendar + Email Cores → ambient extraction → GBrain) was CONSTRUCTED
inside `wireMemory` (`open/wiring/memory.ts`) with NO calendar/gmail clients, so
`mountCoresScribeFanOut` fell back to fresh `buildInMemoryCalendarClient()` /
`buildInMemoryGmailClient()` stand-ins. Result: ambient email/calendar → memory
extraction ran but **emitted nothing by construction, even with Google connected**
(the module's own comment said as much). Meanwhile `mountOpenCores` already built
the real OAuth-backed `calendarClient`/`gmailClient` (the SAME instances the
`calendar_core`/`email_managed_core` MCP tools + `/cal`/`/email` filters use) — but
never exposed them, and `wireMemory` (composer `open/composer.ts:~1046`) runs
~100 lines BEFORE `mountOpenCores` (`~:1150`), so they could not simply be passed.

THE FIX — **late-binding**, mirroring the `reflectLoop` precedent (construct early
/ register cleanup early / arm after the dependency exists):
- `MountedOpenCores` now exposes `calendarClient` + `gmailClient`
  (`gateway/cores/mount-open-cores.ts`).
- `mountCoresScribeFanOut` no longer takes clients or starts anything at
  construction; it returns a handle with `arm({ calendarClient, gmailClient })`
  that builds + starts the two schedulers, plus `stop()`/`idle()`. `arm()` is
  failure-atomic (a throw mid-arm tears down what it started) and single-shot
  (second call throws); `stop()` is a safe no-op before `arm`
  (`gateway/cores/mount-cores-scribe-fan-out.ts`).
- `wireMemory` CONSTRUCTS the fan-out (unarmed) + registers its `stop()` cleanup
  early, and surfaces it on `WiredMemory.coresScribeFanOut`; the composer ARMS it
  LAST with `coresWiring.calendarClient` / `coresWiring.gmailClient`, after every
  failure-prone step — so a composition failure between construct and arm leaks no
  running scheduler.

Behaviour: OAuth absent → the clients are in-memory fallbacks and the schedulers
fan out nothing (unchanged, correct degrade for an LLM-less / Google-less box);
Google connected → real events/mail now flow into GBrain with **zero further
wiring**. NO feature flag, one code path. Tests: `mount-cores-scribe-fan-out.test.ts`
(live-client arm → gmail message reaches the scribe writer + the live calendar
client is read; unarmed → schedulers null + `stop()` clean no-op; in-memory arm →
fans nothing; arm-twice guard) and `mount-open-cores.test.ts` (clients exposed).
Suites green: `open/` 334, `gateway/cores/` 76, `scribe/` 109.

## 2026-07-20 — SubstrateProfile refactor (tool-security redesign Step 0)

BEHAVIOUR-PRESERVING refactor — zero runtime change. Prerequisite (correction #6)
for the tool-security redesign (`docs/plans/tool-security-redesign-2026-07-20.md`).

The 8 production `buildLlmCallSubstrate({ ..., skip_permissions: true })` call
sites each hand-copied the security knob inline. That made the coming permission
migration (drop `--dangerously-skip-permissions` → `dontAsk`) 8 risky per-site
edits, which is incompatible with the no-feature-flags rule (a mode-gated scanner
would be a dual code path). This collapses those inline literals into named,
single-source `SubstrateProfile` constants so Phase B becomes N constant edits.

**New:** `gateway/wiring/substrate-profiles.ts` — the `SubstrateProfile` type
(carries the security knobs: `skip_permissions` today; RESERVED shape for
`permission_mode` / `claude_config_dir` / `extra_env` / `sandbox`, none wired
yet) plus six named constants: `PROFILE_TOOLLESS_UTILITY` (memory lane:
cc-scribe/cc-reflection/cc-reflect — toolless one-shots), `PROFILE_WARM_CHAT`
(cc-agent), `PROFILE_PHASE_SPEC` (cc-llm), `PROFILE_UNTRUSTED_IMPORT`
(cc-synthesis — history import), `PROFILE_EPHEMERAL` (makeEphemeralSubstrate),
`PROFILE_WARM_FIRE` (cc-trident-fire). Every constant encodes TODAY's exact
value byte-for-byte (`{ skip_permissions: true }`). UNTRUSTED_IMPORT and
WARM_CHAT are DISTINCT constants even though identical today, because the
redesign diverges them (the untrusted-import grant tightens first).

**Factory:** `buildLlmCallSubstrate` now accepts `profile?: SubstrateProfile`.
A profile field WINS over the matching legacy per-call input
(`skip_permissions` / `claude_config_dir` / `extra_env`); an absent profile
field falls back to it (backward compat for tests/direct callers). The reserved
`permission_mode` / `sandbox` fields are shape-only and NOT applied (no
`ClaudeCodeSubstrateOptions` field yet — that is Phase B / D). Runtime logic of
the factory is otherwise untouched.

**Sites migrated (8):** `open/composer.ts:954` (cc-synthesis),
`open/wiring/memory.ts` ×3 (cc-scribe / cc-reflection / cc-reflect),
`open/wiring/substrates.ts` ×4 (cc-llm / cc-agent / makeEphemeralSubstrate /
makeWarmFireSubstrate) — each now passes `profile: PROFILE_*` instead of the
inline `skip_permissions: true`.

**Safety net:** `gateway/wiring/__tests__/substrate-profiles.test.ts` — asserts
(1) every profile equals `{ skip_permissions: true }` exactly, and (2) for each
of the 8 sites, the RESOLVED `ClaudeCodeSubstrateOptions` from the new `profile:`
form deep-equals the resolved options from the pre-refactor inline form. Any
change to a resolved value is a build BUG, caught here. Suite: `bun test
gateway/wiring/ open/wiring/ runtime/adapters/claude-code/` green (1198 pass, 0
fail, 3 pre-existing skips).

## 2026-07-20 — substrate hardening: env injection + config-file exposure

Three fixes found by an adversarial security review of the tool-security
redesign. All are LIVE weaknesses in today's code, independent of that redesign,
so they ship on their own.

**1. Interpreter-injection env vars were inherited by every child.** `mergeEnv`
(`runtime/adapters/claude-code/persistent/repl-session.ts`) starts from the
gateway's whole `process.env` and deleted ONLY what a composer overlay unset (the
three Anthropic auth vars, ISSUES #49). `NODE_OPTIONS`, `BUN_INSPECT`,
`LD_PRELOAD`, `LD_AUDIT`, `DYLD_INSERT_LIBRARIES` and friends appeared NOWHERE in
the file, so a gateway env carrying `NODE_OPTIONS=--require /path/evil.js` was
arbitrary code execution inside EVERY spawned Claude child. Requires the
gateway's own environment to be poisoned first — defense-in-depth, not remotely
reachable — but there is no legitimate reason to inherit any of them. Now
stripped unconditionally in `mergeEnv` itself, so a new substrate factory cannot
forget it.

**2. The MCP sink TOKEN was written world-readable.** `spawn.ts` wrote the
mcp-config with NO mode argument (process umask) into a shared `tmpdir()` path
with only 4 bytes of entropy — and `--mcp-config <path>` is on the `claude` argv,
so the path is visible in `ps`. Any same-uid process could read the token. Now: a
per-spawn `0700` directory, files at `0600`, and 16 bytes of path entropy.

**3. The per-session settings file was `0644`.** It carries the Stop-hook wiring
today and becomes the session's PERMISSION POLICY under the redesign; a
world-readable security policy would be a hole. Now `0600`.

**Test** (`__tests__/env-hardening.test.ts`): pins the injection-var strip with
and without an overlay, confirms the ISSUES #49 credential scrub still holds, and
confirms `PATH` survives (a naive allow-list would break `bun`, which launches
the Stop hook and both MCP servers). **Verified RED pre-fix** — 2 of 4 fail
without the change. Adapter suite: 596 tests, 0 fail.

NOT fixed here, tracked for the redesign: the MCP bridge's per-PROCESS sink token
and the missing session check before `/tool-call` dispatch, and the
`ensure-claude-trust.ts` lost-update race.

## 2026-07-20 — black screen STILL reachable after #408: guard the doc-fetch unmount race (#380)

**Bug (live, Ryan, same day as #408).** A single doc/history pane fetch 503 still
blanked the ENTIRE app. Console: `503` on `…/docs/file?path=…starting-plan.md`
and `?path=history.md`, then `Uncaught Error: Tried to unmount a fiber that is
already unmounted` (chat-react.js), then "An error occurred in one of your React
components" → the top-level boundary caught it and the whole screen went blank.

**Why #408 did NOT catch it.** #408 added `PaneErrorBoundary` around `DocumentsTab`
and `WorkBoardTab` in `ProjectShell` (necessary, and kept — it DOES wrap the tab).
But the "unmount a fiber that is already unmounted" invariant is thrown from React's
OWN commit/teardown phase, NOT from a child render — and an error boundary only
catches errors thrown during a child RENDER. So the pane boundary structurally
cannot catch this class. And there is no boundary above `ProjectShell` at the root
(`main.tsx` renders it bare), so nothing catches it: React does what it does for any
uncaught error and unmounts the WHOLE root → blank screen. (The owner console line
"the top-level boundary caught it" was React's default whole-tree teardown, not a
real app boundary.) #408 fixed the render-throw half and its test proved only that
half (it forced a render throw — it never reproduced the unmount race). The missing
half: `DocumentsTab`'s async doc-fetch continuations (`readFile`, `tree`,
`listComments`, save, and the comment/thread mutations) called `setState` even after
the pane unmounted. On a project switch mid-fetch, the 503 landed on a gone
component → setState-after-unmount → the invariant → blank app.

**Fix (`DocumentsTab.tsx`).** The only real fix is to stop the setState-at-the-
source (a boundary provably can't help here). Two guards:
- **`mountedRef`** — every async continuation bails (`if (!mountedRef.current) return`)
  once the pane unmounts, so no setState-after-unmount can fire the invariant.
- **`abortRef` (AbortController) — READS ONLY** — threaded into every docs READ (GET)
  via a `fetchImpl` wrapper and `abort()`-ed on unmount, so the in-flight 503 is
  actually CANCELLED rather than merely ignored. WRITES (PUT/POST — save, post/reply/
  resolve/escalate comment) are NEVER aborted: a mutation the user just fired must
  still reach the server even if they navigate away within the RTT (aborting it
  would silently drop the write). Writes rely on the `mountedRef` guard alone to
  skip setState-after-unmount. The lifecycle effect is declared BEFORE the fetching
  effects so the controller is fresh before any request fires, incl. StrictMode's
  mount→unmount→remount.
- The nested "refresh the open thread tree" `getThread` in the reply flow got a
  `.catch` — without it, the shared read-abort turned that re-fetch into an
  unhandled promise rejection in exactly the unmount path this change targets.
- The 503 file-open view now shows an inline error + a **"Try again"** retry button
  (`.cdoc-file-retry`) instead of a bare message.

**Test** (`__tests__/doc-pane-unmount-503.test.tsx`): (a)+(b) a 503 doc fetch
degrades to a per-pane error+retry while sibling chat + rail keep rendering and the
pane boundary does NOT trip; (c) unmounting mid-flight ABORTS the in-flight READ
(`init.signal.aborted === true`) and nothing throws past the pane; (d) DISCRIMINATING
mountedRef test — a comment-resolve WRITE held in flight past unmount does zero
post-unmount work (its `mountedRef`-guarded `.then` never fires the observable
`loadComments` refetch), and the write carried no abort signal (proving reads-only).
**Each test is mutation-verified RED**, not just green on the fix: (c) → RED when
the abort threading is removed; (d) → RED when the unmount cleanup that arms
`mountedRef` is removed (Argus round-1's exact mutation — previously left the suite
green); (d)'s reads-only assertion → RED when writes are also aborted.
**Verification depth (honest):** jsdom/happy-dom only, NO headless browser. React 19
silently no-ops setState-after-unmount in the `act()` harness (verified empirically:
0 throws / 0 console errors), so the exact fiber invariant is unreproducible here and
needs a real concurrent-browser commit — same limitation `pane-switch-no-crash.test.tsx`
documents. Because a bare setState-after-unmount is invisible in jsdom, test (d) pins
the guard through the one OBSERVABLE consequence (a suppressed downstream fetch), which
is what makes the `mountedRef` half mutation-detectable at all. chat-react suite: 540
pass / 0 fail.

## 2026-07-20 — black screen on project switch: per-pane error isolation

**Bug (live, Ryan).** Clicking to a different project sometimes blanked the
ENTIRE screen. Console showed the #354 signature ("Tried to unmount a fiber that
is already unmounted", "An error occurred in one of your React components"),
plus a 503 on a `docs/file` fetch and a WebSocket that closed before opening.

**Why it was not a #354 regression.** #354's own fix — the memoized assistant-ui
adapter in `useNeutronChat.ts` — is intact and `snapshot-stability.test.tsx`
still passes. A DIFFERENT trigger was reaching the same failure.

**The structural defect, which is independent of the trigger.** The client had
exactly ONE error boundary: `ChatErrorBoundary` at `ChatApp.tsx:1538`, wrapping
the entire surface. `DocumentsTab` (`ProjectShell.tsx:221`) and `WorkBoardTab`
both perform their OWN network I/O on project switch and sat inside it with no
isolation. So a single failed doc fetch took down chat, the rail, the work board
and the docs pane together — the black screen.

**Fix.** New `PaneErrorBoundary` — deliberately NOT a copy of
`ChatErrorBoundary`, which owns a whole-surface "Back to General" recovery; this
one stays visually minor because the point is that everything around it still
works. `DocumentsTab` and `WorkBoardTab` are now wrapped. A pane failure renders
a small inline error with a retry and its siblings keep rendering. The console
line now names the pane, so a bug report says WHICH pane died instead of "a
React component".

**Test** (`__tests__/pane-error-isolation.test.tsx`): pins the ISOLATION, not any
one trigger, so it holds whichever fetch fails — a throwing pane degrades locally
while its siblings survive. **Verified RED** by neutering the boundary's
`getDerivedStateFromError` (reproducing the pre-fix world where the throw escapes
to the app-level boundary): the siblings vanish and the test fails. chat-react
suite: 357 pass / 0 fail.

**NOT fixed here — the trigger.** The 503 came from the docs surface, where
`comments_unavailable` / `versioning_unavailable` / `binary_unavailable` all
return 503 for "optional subsystem not wired". The chat-react docs client handles
ONLY `comments_unavailable` (7 refs); the other two have ZERO handling, and
`versionStore` is not wired in `open/composer.ts`. That is a real follow-up, but
the isolation above is what stops any such failure blanking the app.

## 2026-07-19 — claim redirect is one-shot per OWNER (durable), not per page load

**Bug (live, Ryan's managed instance).** After claiming a personal URL the owner
was LOCKED OUT by an infinite loop: chat → the claim page ("Your personal URL is
already set") → "Open my workspace" → chat → claim, forever, on a healthy
instance.

**Root cause.** `on_session_open` (`open/wiring/app-ws.ts`) replays a one-shot
`onboarding_completed` frame on EVERY connect whose persisted phase is
`completed` when `NEUTRON_POST_ONBOARDING_CLAIM_URL` is set. The React client
navigates to the claim page on that frame, deduped by `claimRedirected` — a
field on the CONTROLLER INSTANCE, so it dedupes only within one page load. Every
reload built a fresh controller and re-armed it.

The pre-fix code justified the replay with a comment asserting the loop was
impossible because "once the owner claims they move to a host without the env".
That was FALSE: claiming renames `url_slug`, it does NOT change the tenant
process or its environment, so the SAME process — still carrying the claim URL —
serves the claimed host. Verified against the live process environment.

**Fix.** Gate the replay on `onboarding_handoff_emitted_at` (migration 0052 — a
column the schema has always carried and NOTHING ever wrote; built-but-not-wired,
the persona-gen class) and stamp it AFTER a successful send, so a throwing send
leaves it null and retries rather than burning the one shot. The signal is now
at-most-once for the OWNER across reloads, reconnects and restarts.

**Test** (`tests/integration/claim-redirect-once.open.test.ts`): boots a real
composer + production graph + app WebSocket and counts frames across TWO
successive connects, plus across a genuine process restart. **Verified to
reproduce the live loop pre-fix** (reconnect emits a second frame: expected 0,
received 1) and pass after. No unauthenticated HTTP probe could see this — the
status codes are identical either way; it only exists across a reload.

## 2026-07-18 — Favicon: the tab icon renders again (root cause = an invisible SVG, not a serving gap)

Ryan reported NO favicon on his tenant chat tab (`https://<slug>.<managed-host>/chat`),
"used to work fine", hard refresh no help. Four defects, one of which is the actual cause.

**ROOT CAUSE — the SVG was serving fine and rendering invisibly.** `GET /favicon.svg`
returned 200 with correct bytes the whole time, and `landing/chat-react.html:7-9` carried
the `<link rel="icon">` tags; the shell is served verbatim (`landing/server.ts:699-713`
version-injects only `src="/chat-react.js"`), and the Managed auth gate is decision-only
(`gateway/http/compose.ts:130-172`), so the markup provably reaches the browser. The
regression is `233e0c1b` (2026-07-03, the "atom favicon" in this same log at §2026-07-03):
it replaced an icon that had an OPAQUE `#0b0e14` tile + a solid `r=6/64` core with a
TRANSPARENT, stroke-only atom in the fixed light-theme accent `#007aff` at `stroke-width
1.6` on a `0 0 24 24` viewBox. In a 16px tab slot that stroke is `1.6 × 16/24 ≈ 1.07`
device px of mid-blue composited onto Chrome's near-black dark tab strip — present, but
imperceptible. Hence "it used to work fine", and hence a hard refresh changing nothing:
the icon was always loading. `landing/favicon.svg` now restores an opaque rounded tile,
lifts the accent to `#4da3ff` (same rail-header blue family, enough luminance over
`#0b0e14`), and moves to `0 0 32 32` @ `stroke-width 2.6` (≈1.3 device px) with a solid
`r=3.2` core. Verified by rasterising the shipped 16px entry over both a white and a
`#202124` backdrop.

**`/favicon.ico` now exists and is served.** There was no `.ico` anywhere in the repo, and
`/favicon.ico` was absent from `LANDING_ROUTE_MANIFEST` (`landing/routes.ts`), so on
Managed the gateway never routed the path to landing at all — the brand-asset allowlist
alone would not have been enough. Browsers request it at the origin unprompted and cache
the 404 negatively in a store a hard refresh does not clear. `landing/favicon.ico` is a
real 6-size (16→256) ICO generated from the SVG geometry by the committed
`scripts/gen-favicon-ico.py` (Pillow, dev-only — regenerate when the SVG changes); it is
declared FIRST in `chat-react.html` + `index.html` as the universal raster fallback, and
added to `site.webmanifest`.

**HEAD is answered on brand assets.** The handlers in `landing/server.ts` and
`landing/boot-impl.ts` were `req.method === 'GET'`-only, so `HEAD /favicon.svg` fell
through to the 404 tail for an asset that demonstrably exists on GET. Both now serve
`GET || HEAD` with identical headers and an empty HEAD body (RFC 9110).

**APEX — NOT FIXED HERE; it is an out-of-tree neutron-managed defect.** `GET
https://<managed-host>/favicon.svg` 404s with `{"error":"not found"}`, which is
`neutron-managed/src/index.ts:642` — the apex is served by the Managed control-plane
process (`<managed-host>` → `127.0.0.1:7780`, per
`neutron-managed/scripts/provision-hetzner.sh:451-473`), which has NO static-asset
allowlist at all. Open's `landing/boot-impl.ts` serves `signup.<managed-host>` (already
200 on `/favicon.svg`), not the apex, so no change in this repo can fix it. Filed as a
Managed follow-up: either give the control-plane router an asset allowlist, or repair the
shadowed `apex-marketing` `file_server` route. The `.ico` + HEAD additions to
`boot-impl.ts` do improve `signup.<managed-host>` and are kept.

Tests: `landing/__tests__/favicon-serving.test.ts` boots the REAL servers and asserts
responses, not route-table bookkeeping — `GET /favicon.ico` 200 + a valid ICO container
header (guards against "fixing" the 404 by aliasing SVG bytes at an `image/x-icon` path),
`HEAD` parity across all four brand assets, the served `/chat` body carrying the icon
links AND every declared href resolving 200, the SVG's 16px stroke/contrast budget, and
the apex-shaped `bootSignup` surface over GET+HEAD.
`landing/__tests__/routes-transition.test.ts` grows an append-only `ADDED_SINCE_C5` list
rather than rewriting its frozen pre-C5 snapshot, so the routing audit trail survives.

## 2026-07-19 — favicon: the SVG was invalid XML, so browsers rendered nothing

**Bug (live, on a hosted tenant, reproduced independently).** No favicon on
`<tenant-host>/chat`. Survived a hard refresh and a fresh
incognito tab, so it was not a cache artifact.

**Root cause.** `landing/favicon.svg` was NOT well-formed XML. Its explanatory
comment referenced the CSS custom property `--accent`, and an XML comment may
not contain a double-hyphen. `xmllint` verdict:

```
favicon.svg:4: parser error : Comment must not contain '--' (double-hyphen)
```

Browsers parse SVG strictly as XML, so the asset served **200 with the correct
`image/svg+xml` content-type and byte-correct contents** and then rendered as
NOTHING. Every signal short of actually rendering it looked healthy, which is
why route/allowlist/caching inspection kept coming back clean. Confirmed by
rendering the served bytes: pre-fix produces an XML parser-error page, post-fix
produces the atom mark.

**Fix.** Reworded the comment so it contains no `--`. Plus
`landing/__tests__/svg-assets-wellformed.test.ts`, which asserts every shipped
SVG has no `--` inside a comment — verified RED against the broken asset and
GREEN after. The class matters more than the instance: any future SVG with a
CSS-variable mention in a comment fails the same way, silently.

**Adjacent gaps found while diagnosing, NOT fixed here** (separate PR in flight):
`/favicon.ico` 404s and is absent from the route allowlist (browsers request it
by default and cache the 404 negatively), `HEAD /favicon.svg` 404s while GET
succeeds (the brand-asset handler is GET-only), and the apex host serves no
brand assets at all.

## 2026-07-18 — `stuck_agent` now means "a dispatched turn stopped progressing", not "a process is quiet"

**P1 user-visible defect.** Ryan saw a permanent stream of false
`⚠️ Supervisor alert: stuck_agent` messages in chat on a healthy install, getting
worse with every topic he used.

**Root cause — a category error.** `watchdog_alerts` rows flagged
`cc-agent-dev\0owner\0general\0…` (pid 98137) and `…\0owner\0buddhism\0…`
(pid 22009), `tool_name` `cc-repl`; 26 alerts on a fixed half-hourly cadence, one
per resident REPL. **Both processes were alive and healthy** — `ps` showed real
`claude --session-id … --model claude-opus-4-8` PTYs at 6h29m and 4h55m uptime.
They are the warm per-topic chat REPL sessions, idle only because Ryan was not
typing in those topics. The chain: `last_activity_at` is bumped ONLY from the PTY
`onData` handler (`spawn.ts:347`), so it answers "when did this process last EMIT
OUTPUT"; `ProcessRegistry.listStuck` was a pure age filter over that field; and
`StuckAgentDetector` read that age as "not progressing". For a request/response
REPL, silence is the normal resting state — a warm pooled session exists
precisely to sit idle between turns so the next message skips a cold start. The
detector was alerting on correct, healthy, by-design behaviour, forever.

(An earlier diagnosis blamed a long-running history import because the screenshot
timestamps fell in the import window. That was wrong; the import is irrelevant.)

**Fix — model outstanding work explicitly.**
- `ProcessRecord` gains `busy_since: number | null` + `busy_turn_id: string | null`.
- `LiveProcessHandle` gains `markTurnStarted(turnId)` / `markTurnSettled(turnId)`,
  following the existing identity-guarded `touch()` / `markCrashed()` /
  `unregister()` pattern — `markTurnStarted` guards on `pid`, `markTurnSettled` on
  `pid` **and** `turn_id`.
- `listStuck` filters on `busy_since !== null && busy_since < now - threshold`,
  measuring from TURN START. `busy_since === null` ⇒ never stuck.
- The pool driver (`pool.ts`) marks started when it assigns `session.activeTurn`
  and settles **in a `finally`**.

**Leak prevention (the crux — a latched marker would invert the bug into
permanent alerts).** Three independent covers: the dispatch-site `finally` runs on
every unwind (completion, return, throw, cancel, timeout); the turn-id guard stops
a superseded turn's late settle from clearing its successor; and process death
drops the record wholesale via the existing child-exit paths (`unregister` on
clean exit, `markCrashed` → crash queue on abnormal exit).

**Side benefit:** measuring from turn start catches a wedge the old filter
MISSED — a turn that keeps emitting output (spinner / retry loop) but never
completes had fresh `last_activity_at` throughout and never fired.

`crashed_agent` detection is untouched and fully intact. No feature flags, no dual
paths, threshold unchanged (15 min), no name/`tool_name` string special-casing.

Tests: regression reproducing Ryan's exact two-REPL situation (fails on `main` —
emits both false alerts with his real pids); outstanding-turn-past-threshold still
alerts; settled turn clears; superseded-turn late settle cannot clear; throwing
turn leaves no permanently-busy record; dying process leaves none either while its
crash stays reportable; chattering-but-never-completing turn now alerts.

`runtime/adapters/claude-code/persistent/__tests__/stuck-agent-turn-wiring.test.ts`
covers the DISPATCH SITE itself — `pool.ts` is the only production writer of
`busy_since`, and every other test seeds the registry by hand, so deleting the
wiring left the suite green while the detector went permanently dead in
production (the "built but never wired" pattern). It drives a real turn through
`createPersistentReplSubstrate` against a gated fake PTY host and asserts busy
mid-turn / clear after settle / clear after cancel. Mutation-verified both ways:
removing `markTurnStarted` or `markTurnSettled` fails it.

Incident dedup is keyed `(name, pid, turn_id)`, not `(name, pid)`. A warm REPL
serves many turns under one pid; without the turn in the key, a second wedged
turn would be suppressed forever by the first turn's still-open key whenever the
first settles and the next wedges between detector ticks.

**Boundaries.** `stuck_agent` is a narrow backstop, not broad protection: the
per-turn driver watchdog abandons on 90 s of PTY silence and caps turns at 45
min, so the band `stuck_agent` uniquely covers is a continuously-emitting turn
that never settles for 15-45 min. And because `markTurnStarted` fires only after
`getOrSpawnSession` + `waitForReplIdle`, a turn wedged in the pre-turn
spawn/handshake phase is not stuck-detectable — it is bounded by
`waitForReplIdle`'s own `maxMs` cap instead.

## 2026-07-18 — Test isolation: the process-global `react` module mock is gone

**Defect (test infrastructure only; no product surface change).** Three `app/`
test files installed their hook-dispatcher stub with
`mock.module('react', ...)` — `app/__tests__/docs-read-hooks.test.ts`,
`app/__tests__/docs-mutations-race.test.ts`,
`app/__tests__/diagnostics-pane-render.test.ts`. In bun that registration is
**global to the test process** and is NOT undone by `mock.restore()` (module
mocks are exempt). Once any one of those files ran, every later test in the
same process that rendered through `react-dom` received the stub instead of
real React. Signature: `TypeError: undefined is not an object (evaluating
'ReactSharedInternals.S')` thrown inside
`node_modules/react-dom/cjs/react-dom-client.development.js`. Measured blast
radius at `main` b1007876: ~92 failures. Minimal repro — the SAME file passes
or fails purely on ORDER:

```
bun test landing/chat-react/__tests__/work-board-tab.test.tsx                       → 17 pass / 0 fail
bun test app/__tests__/docs-read-hooks.test.ts <same file>                          → 17 FAIL
```

That is worse than 92 red lines: a real regression anywhere in the polluted
tail was indistinguishable from the noise.

**Fix — dependency injection, not a bigger mock.** New
`app/lib/hook-runtime.ts` exports `HookRuntime` (the six dispatcher hooks) and
`reactHooks`, the real React implementation. Every unit whose test needs a
substituted dispatcher now takes it explicitly, defaulting to real React:

- `useProjectScopedAsync(projectId, client, hooks = reactHooks)` — the shared
  race-guard primitive; it threads the runtime it is given.
- `useDocFile`, `useDocTree`, `useDocHistory`, `useDeepLinkAnchor`,
  `useDocMutations` — optional trailing `hooks: HookRuntime = reactHooks`,
  forwarded to `useProjectScopedAsync` so one injected runtime covers the
  whole hook subtree.
- `DiagnosticsPane` — optional `hooks?: HookRuntime` prop (its test invokes the
  component directly, so a prop is the seam that reaches it).

Production call sites are unchanged and pass nothing. The substitution is now
scoped to the individual call, so **no execution order can affect any test**.
The read-hooks and mutations suites also drop their `await import(...)` dance
for plain static imports — there is no longer a mock that must be registered
before the module graph links.

**What did NOT change:** no test was skipped, weakened or deleted. Every stub,
harness and assertion is byte-for-byte the same behaviour; the suites still
prove the same `isLatest`-before-`setState` race guards, argument fidelity and
component wiring. The one typing addition is a `LooseHook` alias in the two
driver tests, which reproduces EXACTLY the typing those drivers had while the
hooks were `await import`ed into an `any` (the fixtures are deliberately
partial); `tsc -p app/tsconfig.json` and the root `tsc` are both clean.

**Deliberately still module-mocked:** `mock.module('react-native', ...)` in
`diagnostics-pane-render.test.ts` and `docs-panes-render.test.ts`. react-native
is Flow-typed and cannot be parsed by bun at all, so there is no real module
for any test to load — the stub cannot displace a working implementation the
way the react stub did, and nothing outside `app/` imports it.

**Second, independent order-dependency fixed in the same pass.**
`gateway/__tests__/doc-link-production-composer.test.ts` interpolated the
EAGER `WEB_APP_BASE` constant (frozen at that file's module load) into its
expected URL, while the rewriter under test recomputes `webAppBase()` per call
by design (`wire-types/doc-links.ts:127-130`). Two sibling files set
`NEUTRON_WEB_APP_BASE` at THEIR module load and never restore it
(`runtime/__tests__/doc-links.test.ts:32`,
`runtime/__tests__/doc-links-parity.test.ts:21`), so expected and produced
disagreed purely on ORDER — the test passed alone and failed in the full run.
The assertion now resolves the base the same way the production code does, so
it pins the identical rewrite shape under ANY ambient env (verified passing
both with the var unset and with `NEUTRON_WEB_APP_BASE=https://polluted.example`).
The env leak in those two runtime files is left as-is and noted: nothing now
depends on it, and restoring it mid-run would itself race concurrent files.

**Also updated:** `app/__tests__/docs-hooks-invariants.test.ts` — two
source-text guardrails match the hook signatures by regex, so they were
retargeted at the new signatures. They still pin exactly what they pinned:
`useProjectScopedAsync`'s SCOPE parameters are still asserted to be exactly
`(projectId: string, client: unknown)` with the injected runtime explicitly
accounted for, and `useDocMutations` still acquires exactly ONE gate.

**Suite result** (single `bun test` at the repo root, clean tree):
before 10699 pass / 9 skip / 93 fail / 2 errors (exit 1) → after 10809 pass /
9 skip / 0 fail / 0 errors (exit 0). The skip count is IDENTICAL — nothing was
skipped to reach the number. The total ran RISES 10801 → 10818 across the same
963 files, because the two "errors" were whole-file evaluation failures
(`landing/chat-react/__tests__/html-doc.test.tsx` could not even evaluate
`require('react-dom/client')` under the stub), so those files' tests never ran
at all before.

[`app/lib/hook-runtime.ts`, `app/features/docs/use-project-scoped-async.ts`,
`app/features/docs/use-doc-file.ts`, `app/features/docs/use-doc-tree.ts`,
`app/features/docs/use-doc-history.ts`,
`app/features/docs/use-deep-link-anchor.ts`,
`app/features/docs/use-doc-mutations.ts`,
`app/features/admin/DiagnosticsPane.tsx`,
`app/__tests__/docs-read-hooks.test.ts`,
`app/__tests__/docs-mutations-race.test.ts`,
`app/__tests__/diagnostics-pane-render.test.ts`,
`app/__tests__/docs-hooks-invariants.test.ts`,
`gateway/__tests__/doc-link-production-composer.test.ts`]

## 2026-07-18 — Onboarding finalize: a progress signal, an orienting closing, concurrent openings

**Bug (live, Ryan's install).** `onboarding/openings/finalize.ts` awaited
`emitProjectOpenings(...)` — one LLM compose per project — for EVERY materialized
project before emitting the closing. With 9 projects the openings landed one at a
time over several minutes with zero explanation, and the one message that tells the
owner what to do next arrived dead last. Projects silently appeared in the rail with
no orientation. Ryan: "its unclear what im supposed to do next."

**Fix (messaging + ordering only; the completion gate is untouched).**
1. **STARTING message** — `ONBOARDING_STARTING_MESSAGE` ("Got it, setting up your
   projects now. One moment while I put everything together.") emitted into the
   owner's General topic through the SAME `deps.emitChatMessage` seam, BEFORE
   persona compose / materialization / the opening composes. Gated on the same
   `emitChatMessage !== undefined` condition as the closing AND on
   `resolveProjects(...).length > 0` (the exact list `materializeProjects` iterates)
   so it never fires when there is nothing to materialize. Its own stable
   `dedupe_key: 'onboarding_starting'` — a joined finalize shares the in-flight
   promise, a re-finalize of a completed row returns at the gate, and a
   deferred-CAS retry collapses on the composer's dedupe row.
2. **Closing copy** now names BOTH affordances: click into each project in the left
   rail, and ask general questions right here in the General chat.
   `ONBOARDING_CLOSING_MESSAGE_NO_PROJECTS` is unchanged (no rail claim, no rail).
3. **Openings run concurrently** through a bounded worker pool
   (`OPENING_COMPOSE_CONCURRENCY = 3`). The openings are mutually independent — each
   targets its own project topic and reads only its own on-disk docs — and the
   per-project try/catch (error isolation) is unchanged. Bounded rather than a bare
   `Promise.all` so a large import cannot fan N simultaneous substrate sessions.

**Also fixed: `persona_files_committed` was never persisted.** Verified live: the
persona files existed on disk (`persona/SOUL.md`, `USER.md`, `priority-map.md`)
while the column read 0. Root cause: NOTHING on the Path-1 finalize path ever wrote
it — `commitPersona` writes the files + invalidates the loader but persists nothing,
and the terminal CAS `UPDATE` set only `phase`/`completed_at`/`wow_fired`
(`onboarding/interview/sqlite-state-store.ts`), so the column sat at its schema
DEFAULT 0 (`migrations/0043_onboarding_state_wow_pushed_at.sql:53`). `commitPersona`
now returns whether it succeeded and the flag rides the SAME atomic terminal write
via a new optional `persona_files_committed` input on
`completeIfPhaseStateMatches` — monotonic (`MAX(persona_files_committed, ?)`), so a
later finalize whose persona compose failed can never clear a committed persona.

**Tests** — `gateway/wiring/__tests__/finalize-progress-messaging.test.ts` (6 tests,
real ProjectDb + real SqliteOnboardingStateStore + the real create-project seams;
asserts the emitted message stream): starting-first-and-once, closing-last naming
both affordances, joined/re-entered finalize never duplicating the starting
message, the zero-project path emitting no starting message and no rail claim,
`persona_files_committed` true after a successful finalize, and false when persona
compose failed.

## 2026-07-18 — Onboarding: the step guard becomes AUDIT-DRIVEN (fixes a live finalize deadlock)

**Bug (live, P0, Ryan's fresh install).** Onboarding hung forever after the
personality step and could never finalize. The real row in
`~/neutron/data/project.db`: `phase='work_interview_gap_fill'`,
`completed_at=NULL`, `persona_files_committed=0`, with a `phase_state` holding
`user_first_name=Ryan`, a settled import (`import_job_id`), 6 `primary_projects`
and `agent_personality='Yoda'` — but NO `non_work_interests` (his import analysed
to `topics:[]`, so nothing backfilled it).

`auditRequiredFields` correctly refused to finalize on `non_work_interests`
(`post-turn-extractor.ts` finalize gate). But `buildOnboardingStepGuardFragment`
(`onboarding/interview/onboarding-preamble.ts`) inspected only TWO hardcoded
fields — `import_decision` and `agent_personality` — and with both settled it
returned `null`. The live agent therefore received no forcing instruction for the
one field still blocking it, concluded onboarding was over, and went silent.
**The audit required a field the guard could never ask for.**

**Root defect (the general one, not the symptom).** The guard's coverage set was a
hardcoded SUBSET of the audit's required set. Any required field outside that
subset is an unaskable blocker, so adding required field #6 later would have
silently reintroduced the same deadlock.

**Fix — derive the guard from the audit.** `buildOnboardingStepGuardFragment` now
walks `auditRequiredFields(...).missing` (in the audit's own priority order) and
renders one copy block per missing field from `STEP_GUARD_COPY`, typed
`Record<RequiredField, StepGuardCopy>`. It returns `null` exactly when finalize
would fire — the guard and the gate can no longer disagree. Two presentation
categories:
- **`'buttons'`** (`import_decision`, `agent_personality`) — keep the existing
  `[[OPTIONS]]` hard-requirement and their exact locked option lists/wording, so
  the 2026-06-30 and 2026-07-18 fixes are not regressed.
- **`'free_text'`** (`user_first_name`, `primary_projects`, `non_work_interests`)
  — force the ASK in plain conversational form and EXPLICITLY forbid an
  `[[OPTIONS]]` block. The interests copy states outright that onboarding CANNOT
  finish until it is answered.

Conditionality is respected: `import_decision` renders only when `import_offered`
is true, so a box with no import substrate is never asked a question it cannot
honor.

**Deferred (not dropped) during a history import.** Making the guard audit-driven
newly put `primary_projects` / `non_work_interests` in its scope — the two
`PROJECT_DISCOVERY_FIELDS` the extractor deliberately refuses to persist while an
import is uploading/analyzing, and which `buildImportInFlightSteerFragment`
(joined into the SAME prompt at `open/composer.ts`) explicitly forbids asking
about. Forcing them mid-import would have handed the model contradictory
instructions and solicited answers that are then silently discarded (caught by
cross-model review). `StepGuardCopy` therefore carries
`deferred_during_import`, the guard takes an `import_in_flight` option, and the
composer now resolves `importInFlight` BEFORE building the guard so it can be
threaded in. Import-INDEPENDENT steps (`user_first_name`, `agent_personality`)
stay forced, so the interview keeps progressing during the upload; the deferred
steps resume the moment the import lands. Deferred, never dropped — the field is
still never unaskable, only asked at the right time.

**Anti-recurrence is structural, not a convention.** The `Record<RequiredField,
StepGuardCopy>` makes a new union member without guard copy a COMPILE-TIME error
— verified by temporarily adding a 6th field, which produced
`TS2741: Property 'future_field_six' is missing ... but required in type
'Record<RequiredField, StepGuardCopy>'` at `onboarding-preamble.ts`. A runtime
exhaustiveness test iterating the newly exported
`REQUIRED_FIELDS_IN_PRIORITY_ORDER` (`required-fields-audit.ts`) closes the loop
for copy that exists but never renders.

**Docs corrected.** The docblocks in `required-fields-audit.ts` and
`onboarding-preamble.ts` claimed finalize "triggers once personality is settled".
That was false and it masked this deadlock: personality is priority 5, but
`non_work_interests` is audited BEFORE it at priority 4, so a run can have
personality settled and still be blocked.

**Tests.** `onboarding/interview/__tests__/onboarding-preamble.test.ts` (33 pass)
gains the Ryan-state regression, the per-field exhaustiveness sweep, the
button-list non-regression and the conditionality/free-text-shape cases.
`tests/integration/onboarding-interests-deadlock.open.test.ts` is new and boots
the whole stack (real composer, real `onboardingContext` closure, real post-turn
extractor, real finalize gate + finalizer; the ONLY fake is the substrate, i.e.
the model): from Ryan's exact stuck state the guard forces the interests ask, the
owner — modelled faithfully, answering only what they were actually asked —
replies in free text, and onboarding REACHES `phase='completed'` with
`completed_at` stamped. Pre-fix both the regression and the E2E fail on `main`
(the E2E times out waiting for an ask that never comes — the deadlock reproduced
literally).

**Full suite:** `main` baseline 10665 pass / 9 skip / 104 fail / 2 errors;
this change 10690 pass / 9 skip / 92 fail / 2 errors (+25 pass, −12 fail, +13
tests). Not a clean suite: 56 of the 92 are the known-flaky local `happy-dom`
React-client tests, which is what the −12 swing reflects — no React code was
touched. No failure is attributable to this change (the branch failure list
contains none of the added or touched onboarding suites).

## 2026-07-18 — Onboarding: the welcome opener is guarded DURABLY, not per-process

**Bug (live, fresh install, screenshot-confirmed).** The onboarding opener
("…what should I call you?") was emitted TWICE into the owner's General topic.

**Root cause.** `on_session_open` (`open/wiring/app-ws.ts`) gated the auto-start
welcome seed on `seededOnboardingTopics`, an in-memory per-PROCESS `Set`. The
opener it guards is DURABLE: the live runner persists the composed reply as a
`button_prompts` row (`gateway/wiring/build-live-agent-turn.ts:1096`) BEFORE it
sends it (:1126). So the guard's lifetime was strictly shorter than the thing it
guarded — any new process (restart / redeploy / crash / the service bounce a
fresh install performs) began with an empty `Set`, re-seeded on top of the
persisted opener, and the client hydrated BOTH.

Two candidate causes were REFUTED by reading the code rather than assumed: there
is only ONE seed call site (`open/wiring/app-ws.ts:978`; the line-356 reference
was the `Set` declaration, not a second emitter), and the `outcome === 'failed'`
self-heal `delete(...)` could not double-emit — for a `seed_turn` both `'failed'`
returns (:1055, :1069) happen strictly BEFORE the reply is composed, persisted,
or sent, so a failed seed leaves no row and delivers no message. Concurrent
same-process connects were already safe (the `Set.add` was synchronous).

**Fix — replace the weak guard with the durable one already used next door.**
`hasBeenGreeted` reads `landing.buttonStore.latestTurnByTopic` for the General
topic — the SAME "does this topic already have a turn?" check
`ensureProjectOpeningOnEntry` uses for per-project openings. Because the opener
persists before it sends and a failed seed persists nothing, that one check is
simultaneously the de-dupe AND the self-heal, so the compensating
`seededOnboardingTopics.delete(...)` calls are DELETED with no replacement. The
in-memory structure is demoted to `seedInFlightByTopic`, a pure single-flight
latch: the durable read is itself an `await`, so the promise is registered
synchronously (nothing awaited between the `get` miss and the `set`) and a second
racing connect awaits the first instead of dispatching its own turn. Fail-CLOSED
on a store error — a missing greeting is recoverable on the next connect, a
duplicate one is this bug. No flag, no dual path.

**Test.** `tests/integration/onboarding-welcome-seed-once.open.test.ts` boots a
real composer + production graph + app WebSocket (only the substrate is faked)
and counts EMITTED openers — durable rows, live frames, and dispatched turns —
across a single connect, two rapid concurrent connects, and a reconnect after a
genuine process teardown against the same persisted store. Verified to fail on
the pre-fix code (2 openers after restart) and pass on the fix (1). A test that
asserted `Set` bookkeeping would have passed against the bug.

[`open/wiring/app-ws.ts`, `tests/integration/onboarding-welcome-seed-once.open.test.ts`,
`docs/SYSTEM-OVERVIEW.md`]

## 2026-07-18 — Onboarding: the history-import decision becomes a deterministic step

**Bug (live, fresh install).** The assistant asked "what should I call you?", the
owner replied only "Ryan", and the assistant answered "Got it, we'll skip the
import for now..." and moved on. The owner was never offered the import and never
chose to skip it. The DB agreed: `onboarding_state.phase='work_interview_gap_fill'`,
`phase_state_json={"user_first_name":"Ryan","signup_via":"web"}` — no import
decision captured anywhere. The offer existed ONLY as prose in
`onboarding/interview/onboarding-preamble.ts` (`buildOnboardingPreamble`), with
ZERO capture, so whether the step happened at all was LLM whim and the model
routinely narrated a decision the owner never made.

**Fix — extend the EXISTING per-turn guard; no new gate.** Onboarding stays
LLM-driven plus a deterministic per-turn guard (SPEC Decisions Log 2026-07-18
LOCKED); the phase machine is NOT the gate and is untouched here. This reuses the
mechanism built 2026-06-30 for the IDENTICAL prose-only failure on the personality
step ("a fresh-install run showed ZERO option buttons") — same call site, same code
path, one more audited step.

- `required-fields-audit.ts` — `import_decision` joins the Sam-locked required
  fields, slotted directly after `user_first_name` (where the preamble already
  places the ask: right after the name, before the work questions). It is
  CONDITIONAL on a new `options.import_offered`, which DEFAULTS TO FALSE, so every
  pre-existing caller (including the legacy engine) keeps its exact 4-field
  partition and a box with no import substrate can still finalize. An import that
  actually ran (`import_job_id` / `import_result` on `phase_state`) settles the
  field on its own — uploading an export IS the decision, so a mid-import owner is
  never re-asked.
- `onboarding-preamble.ts` — `buildOnboardingStepGuardFragment` is generalized
  past its single `agent_personality` check: while `import_decision` is missing it
  HARD-REQUIRES the ask as an `[[OPTIONS]]` block over the locked
  `IMPORT_DECISION_OPTIONS` menu (ChatGPT / Claude / neither), and explicitly
  forbids saying it is skipping the import, assuming no export exists, or reading
  an answer to a different question as a decision. The personality section is
  byte-identical (pinned by a test that diffs the two renderings).
- `button-backed-answer.ts` — the SAME turn-start capture (awaited before the
  guard reads `phase_state`, `gateway/wiring/build-live-agent-turn.ts`) now also
  settles `import_decision`, normalizing taps AND free text into
  `chatgpt|claude|neither`. Free text is first-class: "I have claude history",
  "skip", "I don't have a Claude export" all land. Ambiguity (e.g. "I have both")
  captures NOTHING so the guard simply re-asks — a false `neither` is precisely
  the bug — while `"no, my claude one"` stays `claude` rather than being swallowed
  by the decline matcher. The import and personality anchors are disjoint option
  menus, so the two steps can never cross-capture.
- `extracted-fields.ts` + `post-turn-extractor.ts` — `import_decision` gets a home
  on the existing background extractor as the fallback for an answer VOLUNTEERED
  with no button context (never inferred from silence). The extractor's finalize
  gate takes `import_offered` too, so it cannot finalize out from under a step the
  live guard is still forcing.
- `open/composer.ts` — threads `import_offered` (`importSubstrate !== null`, the
  same expression that already decides whether the offer renders and whether the
  upload affordance exists) into the step guard, BOTH finalize gates, and the
  extractor, so the guard and the gates can never disagree about scope.

No feature flags, no dual code paths, no second gate. The orphaned phase-machine
code (`engine.advance` / `ai_substrate_offered` / `LEGAL_TRANSITIONS`) is left
alone — its removal is a separate step gated on this being proven live.

**Tests exercise the LIVE path.** This bug class has recurred because tests mocked
past the real seam, so `tests/integration/onboarding-import-step-guard.open.test.ts`
boots the real composer + production graph + app WebSocket + ButtonStore and fakes
ONLY the substrate (the model). The import question's `[[OPTIONS]]` block travels
the real persistence path (stripped from `body`, durable in `options_json`) before
returning as the `prior_agent_options` the capture keys on. Covered: a name-only
turn carries the guard's import step and leaves `import_decision` unset; a tapped
option and a free-text answer each persist durably and stop the re-ask; a free-text
"skip" records `neither`; the personality step is unchanged on the same path. Unit
coverage added for the audit's conditional field, the guard fragment, and the
capture classifier.

## 2026-07-17 — Trident Ralph re-fire: multi-task builds build every task before merge (#362)

**Bug.** Trident v2 Ralph mode built only the FIRST task then merged. The inner
workflow (`trident/inner-workflow.mjs`) planned once, built `plan.topTask`, and
`log()`-ged `plan.remainingTasks` but never consumed it — it fell straight through
to review→merge. The outer harvest (`orchestrator.applyResult`) mapped inner
APPROVE → done+merge with no remaining-tasks check. The real plan→task→repeat
cycle existed only as DEAD code in `state-machine.ts` (`computeTransition`), which
the exec-model orchestrator no longer drives. Net effect: a multi-task,
spec-driven (`IMPLEMENTATION_PLAN.md`) Ralph build silently shipped INCOMPLETE
after task 1.

**Fix — re-fire, one fresh context per task (no flags, real behavior).**
- `inner-workflow.mjs`: in Ralph mode capture `plan.remainingTasks`. When `> 0`,
  build the ONE task, then return a TYPED intermediate result
  (`checkpoint='ralph-task-built'`, `remainingTasks>0`, verdict non-APPROVE)
  WITHOUT reviewing. Only the FINAL task (`remaining==0`) — and every non-Ralph
  run — runs the review→fix→merge path, so the WHOLE cumulative diff is reviewed
  exactly once before merge. `remainingTasks` is threaded through the terminal +
  failure results too (both `0`/no-re-fire).
- `inner-loop.ts`: `InnerResult` + `parseInnerResult` decode `remaining_tasks`
  (absent/garbled → null = no re-fire; legacy rows unchanged).
- `orchestrator.ts`: `applyResult` re-fires a FRESH inner iteration when
  `remaining_tasks>0` (`refireNextRalphTask`) — reset the sub-agent slot, preserve
  branch/PR + the `'ralph-task-built'` resume checkpoint (so the next fire
  re-enters the branch and re-plans the next task; only `'argus-approved'`
  short-circuits), bump `ralph_round`, cap at `max_ralph_rounds` (fail loudly, no
  infinite loop) — instead of merging. Each re-fire is a brand-new `Workflow`
  launch harvested by the outer loop (fresh context, no accumulation), reusing the
  existing durable `code_trident_runs` row + crash-recovery model.
- The re-fire reset is persisted OUT-OF-BAND in ONE atomic UPDATE via a new
  `persist_refire_reset` seam (`save`/`saveIfActive` deliberately never write the
  workflow-owned `inner_result` column). The single write bundles the
  `inner_result=null` clear WITH the sub-agent-slot release + the `ralph_round`
  bump, so a crash can never strand the row in the (inner_result=null, stale
  terminal sub-agent) state `step()` would reap as "terminal-but-garbled" — the
  crash-recovery guarantee holds (Codex cross-model review [P2]). The patch never
  writes `phase`, so it can't resurrect a concurrently force-terminated run;
  `saveIfActive` still owns the race-guarded phase commit. Wired from the store in
  `gateway/composition/build-core-modules.ts` and the test harness.

**Dead-code decision.** The `state-machine.ts` Ralph cycle (`computeTransition`
`ralph-plan`/`ralph-task` branches) is KEPT, not deleted: it remains the
`stubAdvanceDeps` restart-safe no-op fallback and the executable cross-repo parity
anchor for Vajra's `/trident` skill loop (`vajra-fixes.test.ts`), and offers
one-commit revertibility. The re-fire is implemented at the exec-model layer
(orchestrator), which is where the live loop actually runs; the now-stale module
comments in `orchestrator.ts` + `state-machine.ts` were corrected to say so, so no
reader mistakes the state machine for the live driver. (Flagged for the trident
architecture review — a human + Argus may prefer deletion.)

**Tests (real, multi-task).**
- `trident/inner-workflow-ralph-refire.test.ts` drives the REAL `.mjs` body:
  `remaining>0` builds one task + SKIPS review + emits the re-fire result;
  `remaining==0` reviews + approves.
- `trident/orchestrator.test.ts` drives store+tick+orchestrator+migrations
  end-to-end: a 3-task plan re-fires TWICE (fresh context each, resume-folded onto
  one branch/PR), merges exactly ONCE at `remaining==0`, bounds a non-converging
  planner at `max_ralph_rounds`, and never re-harvests a cleared row.
- Full `trident/` suite green (451 pass at commit time; +E2E).

## 2026-07-04 — K9: router-thinking-budget deleted (refactor unit K9)

**Decision: DELETE** `runtime/adapters/claude-code/router-thinking-budget.ts` (+ its
unit test) and correct the misleading comments in
`gateway/wiring/build-llm-call-substrate.ts` that claimed the router-hang
protection was live.

**Incident recap.** The 2026-06-05 router-hang root cause
(`docs/plans/router-call-hangs-rootcause-brief.md`, per the module's own header): the
onboarding classifier's `claude -p` spawn ran with Claude Code's default extended-thinking
budget enabled, so on ambiguous prompts Haiku 4.5 generated a multi-thousand-token
thinking block (cold ~40s / warm 20-36s) before the one-line JSON answer — read as a
"hang." The intended fix was to spawn the router substrate with `MAX_THINKING_TOKENS=0`.

**Why delete, not re-wire.** The module was orphaned — zero production importers (only
its own test imported it; the `runtime/adapters/claude-code/index.ts` barrel does not
re-export it). The wiring its header describes ("the router-dedicated
`buildLlmCallSubstrate` threads this as `extra_env` via `gateway/index.ts`") does NOT
exist: no non-test call site sets `extra_env` anywhere in the repo, so the helpers
(`resolveRouterThinkingBudget` / `routerThinkingEnvOverlay`) were never called on any
live path. The protection was therefore already absent, and the comments were the worst
state — asserting an active hang guard that wasn't. Deletion is the no-behavior-change
option that makes code and comments agree. Re-wiring was rejected because the only
consumer it would protect — the onboarding `llm-router` — is itself already dead code on
every live path and is being removed in the same refactor wave (unit K11:
`llm-router.ts` fires only inside dead `engine.advance`).

**What changed.** Removed the module + test. The `extra_env` field on
`BuildLlmCallSubstrateInput` is KEPT (it is the substrate's generic per-spawn env-overlay
seam, covered by its own substrate unit test); its JSDoc + the inline-apply comment were
rewritten to describe it as a generic knob with `MAX_THINKING_TOKENS=0` as an
illustrative example, noting no production caller sets it today. (This entry was
originally appended to the root `AS-BUILT.md` and carried forward here by K6, the
changelog consolidation.)

## 2026-07-03 — Trident build reliability: worktree isolation + self-healing merge + interpreted failures (#351/#352, no flags)

**Why.** Ryan re-ran two same-project builds on `tabs` (dagflow + kvwal) on
2026-07-03; kvwal FAILED at merge with `git checkout branch failed: error: you need
to resolve your current index first`. Root cause: ALL builds for a project shared
ONE checkout `Projects/<proj>/code` with `code_trident_runs.worktree` empty for every
run. A pre-#342 dagcore failure had hard-failed a rebase conflict WITHOUT
`git merge --abort`, leaving `.git/MERGE_HEAD` (timestamped 17:01) in that shared
checkout — so every LATER build's `mergeLocal` tripped over the poisoned index. The
#342 merge logic is correct, but its tests MOCK git (`RunHostCommand` stub), so the
shared-working-tree hazard was never exercised. Ryan-locked: "Builds need isolated
worktrees" + "when a build fails … interpret it, try to solve it, else describe in
simple terms what happened and what input is needed." NO feature flags; one code
path; leak-gate SILENT. Backend trident only (no chat-react UI touched).

**What shipped.**

- **FIX 1 (#351, P1) — real per-run git-worktree isolation.** `trident/merge.ts`
  `mergeLocal` now provisions a DEDICATED worktree per run
  (`<repo>/.trident-worktrees/<slug>-<id8>`, `runWorktreePath` — deterministic +
  distinct per run, so N concurrent same-project builds never share one) via
  `git worktree add --detach --force … <base>` (detached → no collision with base
  checked out in the shared repo). The whole rebase-onto-latest-base + #342 Forge
  conflict-resolution runs INSIDE that worktree, so a rebase that hard-fails can only
  dirty the throwaway worktree — never the shared checkout. The LAND onto base
  (`git checkout <base>` + `git merge --no-ff <branch>`, still serialized per
  `repo_path` by `withLocalMergeLock`) is the ONLY op touching the shared checkout and
  is conflict-free by construction (the branch already contains base). The worktree
  is torn down on EVERY terminal path (success OR a thrown escalation) via a
  `finally`; a lingering build worktree still holding the branch is freed first
  (`freeBranchFromWorktrees`, parses `git worktree list --porcelain`). The
  orchestrator (`applyResult`) records the path onto `code_trident_runs.worktree`
  (was ALWAYS empty) before the merge, so it's durable for cleanup even on failure.

- **FIX 2 (#351b, P1) — defensive stale-state auto-recovery.** Before touching the
  base repo, `mergeLocal` runs `recoverStaleGitState`: it aborts any lingering
  `MERGE_HEAD` / `rebase-merge` / `rebase-apply` (`git merge --abort` /
  `git rebase --abort`, whose exit code is an accurate "was-dirty" probe) and
  `git reset --hard`s to a clean base. One poisoned checkout can no longer strand
  every future build in that repo — the merge path is self-healing. (Deliberately no
  `git clean` — the shared checkout may hold a real project's untracked files.)

- **FIX 3 (#352, P2) — failed builds are INTERPRETED, never a raw error paste.**
  `trident/delivery.ts` `interpretFailure` (a deterministic classifier — reliable +
  unit-testable, no LLM in the hot path) maps a terminal `failure_reason` to a
  plain-language summary + the SPECIFIC input needed, applied to ALL failure classes
  (not just merge conflicts): `merge-conflict` surfaces the #342 question verbatim;
  `merge-mechanics` DISCARDS raw git stderr ("a git step failed while landing the
  branch"); `review-unresolved`, `hang`, `stale-state`, `infra`, `underspecified`
  each get a human sentence + a retry/review action. The recoverable classes are
  already auto-recovered upstream (stale state → FIX 2; content conflict → the #342
  Forge resolver → no failure message at all), so a run reaching the announce is
  genuinely unrecoverable. `composeTerminalDelivery`'s `failed` branch now renders
  `❌ <slug> — <summary>\n<task>\n<input needed>`.

- **Verified with REAL (non-mocked) git.** `trident/merge-realgit.test.ts` drives
  `mergeLocal` against actual temp repos via `spawnCapture` (the existing
  `merge.test.ts` mocks git — exactly why the bug shipped): (1) 3 concurrent
  same-project builds each in their OWN worktree all land + base repo CLEAN (no
  `MERGE_HEAD`, no stray worktrees, `git worktree list` == 1); (2) a `MERGE_HEAD`-
  poisoned base repo auto-heals + the build lands (never "resolve your current index
  first"); (3) an unrecoverable rebase conflict escalates a PLAIN question (no raw
  git stderr) AND leaves the shared checkout pristine (main unchanged, clean) so a
  LATER build still succeeds. Plus deterministic unit coverage for every
  `interpretFailure` class (no raw-stderr leak invariant). `tsc` clean (root +
  trident); trident (423) + work-board (73) + gateway/open (154) suites green.

- **Codex cross-model review [P1] fixed.** After `recoverStaleGitState` aborts a
  stale rebase/merge OF the feature branch, the shared checkout could be left still
  ON that branch (a legacy poison, or an `--abort` returning HEAD to it), so the
  merge worktree's `git checkout <branch>` would fail "already checked out at
  <shared repo>". `mergeLocal` now `git checkout <base>`s the shared checkout back to
  base right after recovery (before provisioning), and a real-git regression test
  reproduces the exact poison (shared checkout ON the branch mid-rebase → recovers +
  lands).

**Spec-conformance (5-line diff).**
- SPEC (Ryan-locked 2026-07-03): concurrent same-project builds run in ISOLATED git
  worktrees; the merge path defensively aborts stale merge/rebase state before
  proceeding; a failed build is interpreted + auto-recovered if possible, else
  explained in plain language with the specific input needed (never raw error paste).
- CURRENT (before): all builds shared ONE checkout `Projects/<proj>/code`
  (`worktree` empty); no stale-state cleanup so one old failure poisoned the repo
  (kvwal hit this); failures pasted raw git stderr to chat.
- GAP: all three.
- THIS PR: per-run worktree isolation (`mergeLocal` + `runWorktreePath`, recorded on
  the row) + stale-state auto-abort (`recoverStaleGitState`) + failure
  interpretation/plain-language (`interpretFailure`).
- OUT OF SCOPE (unchanged): the chat-react UI (batch-3/batch-4); the #342 merge LOGIC
  itself (kept — rebase-onto-base + Forge resolver + per-repo serialization).

## 2026-07-03 — UX batch-3: no-flicker project switch · work add-box above Done · clean amber attention dot · bottom-right timestamps (#343/#344/#345/#346, no flags)

**Why.** Four chat/work-board refinements from Ryan's live review 2026-07-03:
(1) clicking between projects "rebuilt the whole screen with lots of flickering";
(2) the work-board "Add something to do" box sat BELOW the Done disclosure instead
of at the bottom of the active items; (3) the attention-dot color read as an ugly
brown; (4) the per-message timestamp flipped side with the bubble (right on the
blue user bubble, left on the grey agent bubble). NO feature flags; one code path;
both light + dark preserved; leak-gate SILENT. Stayed clear of trident/build-
lifecycle (#190, already merged).

**What shipped.**

- **#343 — project switch keeps the chat surface MOUNTED (no teardown flicker).**
  `ChatApp.tsx` used to wrap the sole assistant-ui runtime host in `key={convId}`,
  so every project switch UNMOUNTED + REMOUNTED the entire thread + composer,
  flashed the empty state, and lost scroll/draft. Now each visited conversation
  gets its own persistent `MountedConversation` (`.car-conv`) with its own runtime;
  only the active one is un-`hidden`. A per-`convId` frozen-vm cache (`Map`, LRU-
  bounded by `MAX_MOUNTED_CONVERSATIONS`) feeds each surface ONLY its own
  conversation's messages — live when active, its last snapshot when not — so
  switching back to an open project is INSTANT (no refetch flash) and scroll +
  composer draft survive per project. Crucially this PRESERVES the SEV1 switch-race
  fix structurally: no runtime is ever emptied in place by a foreign switch (each
  surface only ever sees its own messages), so the `useClientLookup` index-out-of-
  bounds can't reoccur. The active surface, during its own re-hydration, keeps
  showing its cached snapshot until the live transcript lands (no empty-state flash
  and no shrink). Codex P2 (cross-model review): that snapshot fallback is bounded
  by a grace window (`HYDRATION_GRACE_MS`) — if the transcript is AUTHORITATIVELY
  empty (cleared/expired), after the window the stale snapshot is dropped and the
  surface REMOUNTS onto the empty vm (a remount via a per-conversation epoch key,
  never an in-place shrink), so a genuinely empty transcript can't be masked
  forever. The `chat-rail-stability` regression suite was rewritten to assert
  on the VISIBLE pane (`.car-conv:not([hidden])`) + the new preservation guarantee
  (same DOM node across a round-trip, cached messages instant on return), and still
  guards no-crash / no-boundary across rapid hops.

- **#344 — work "Add something to do" box moves to the bottom of the active items,
  ABOVE Done.** `WorkBoardTab.tsx` rendered the add box as a pinned bottom footer
  (`.cwb-foot`) BELOW the "Done · N" disclosure. It now renders IN-FLOW at the
  bottom of the active list and above Done — final order `[active items] → [＋ Add…]
  → [Done · N]` — in both the populated and empty-board states. `.cwb-foot` CSS
  removed; `.cwb-add` restyled for in-flow placement. (Web only — the mobile work
  board keeps its always-reachable pinned-footer add bar, a platform-appropriate
  pattern; see PR note.)

- **#345 — the attention dot is a clean amber, not brown.** The `--attention`
  token was `#9a6a00` (`chat-react.html`, the `data-theme="light"` block) which
  read as a muddy brown; it's now `#e0a020`, a clean golden amber that stays
  distinct from the build-blue (`--phase-build-fg`) and the failed-red
  (`--phase-failed-fg`). The dark value (`#ffd27d`, `:root`) was already a clean
  pale amber and is unchanged. (Note: the spec labelled the brown value "dark", but
  in the current file `:root` is the dark palette and `data-theme="light"` is light,
  so the brown `#9a6a00` was the LIGHT value — both themes now read clean amber,
  verified in-browser.)

- **#346 — per-message timestamp pinned BOTTOM-RIGHT for both roles.** `.car-time`
  was left-aligned by default and only right-aligned inside the user bubble, so the
  timestamp flipped side by role. It's now `text-align: right` for EVERY bubble
  (grey assistant AND blue user); the full-date hover `title` and the #338 day
  dividers are untouched.

**Verify.** `bunx tsc -p landing/chat-react/tsconfig.json` clean; 307 chat-react
tests pass (incl. the rewritten stability suite + a new work-board order test);
`leak-gate.sh --tree .` SILENT. Booted a QUIET local server and confirmed against
the real served/bundled assets: `--attention` = `#e0a020` (light) / `#ffd27d`
(dark), `.car-time` computes `text-align: right`, and the `.car-conv` mounted-
surface markup renders with rail + composer (no runtime crash from the refactor).

## 2026-07-03 — M1 redesign polish: atom favicon · inline delete confirm · Work pane inside the Chat view (full-width composer) · 2-line work rows (no flags)

**Why.** Four chat-UI refinements Ryan asked for (with screenshots) after the M1
redesign shipped: (1) the browser-tab favicon was a generic mark, not the ⚛ atom
in the rail header; (2) deleting a work item took over the whole screen with a
modal; (3) the Work slide-out pane bled onto Documents/Settings (it was mounted at
the shell level, outside the tab hierarchy) and the chat input bar stopped at the
chat column with the pane running beside it to the window bottom (a side-by-side
seam); (4) work rows were single-line with the title cut off ("Ship dagcore: T…").

**What shipped.**

- **Favicon = the ⚛ atom mark** (`landing/favicon.svg`). Reproduces the `AtomMark`
  geometry from `ChatApp.tsx` (center dot + 3 rotated orbit ellipses) in a FIXED
  accent hex (`#007aff`, the light-theme `--accent`) — a favicon can't read page
  CSS vars. The served `/favicon.svg` (`landing/boot.ts` + `landing/server.ts`
  static route) now matches the rail-header icon on the browser tab.

- **Work-item delete confirm is INLINE-in-row, not a modal** (`WorkBoardTab.tsx`,
  `chat-react.html`). Deleted the `.cwb-confirm-backdrop` / `aria-modal` full-screen
  dialog + its CSS; the ✕ now reveals a compact `.cwb-confirm-inline`
  `role="group"` strip WITHIN the item's own row (`InlineConfirm`): a "Remove?" /
  "Cancel build?" prompt + Cancel + a destructive Remove. No backdrop, no screen
  takeover — the board stays visible + interactive. Autofocuses Cancel, Escape
  cancels, focus returns to the ✕ on dismiss. The confirm STATE machine
  (`confirmDelete`, `requestRemove`, the #174 linked-run cancel) is unchanged —
  only the render moved modal → in-row. One `confirmDelete` still means one row
  confirms at a time. Applies to active AND done rows.

- **The Work pane lives INSIDE the Chat view, composer = full-width footer**
  (`ProjectShell.tsx`, `ChatApp.tsx`, `chat-react.html`). The desktop slide-out
  (`PlansPane`) moved OUT of the `ProjectShell` shell level (where it was a sibling
  of the whole tab band, so it bled onto every tab) and INTO `ChatApp`/`ChatSurface`.
  The Chat view's `.car-thread` is now a flex column: a growing `.car-chatstage`
  row (the message column `.car-chatmain` + the pane, which animates its own width)
  ABOVE a full-width `.car-composer` footer. So the chat input bar spans the whole
  content width with the pane LIFTED above it (no bottom seam), and the pane is
  scoped to the Chat tab — hidden with the Chat tabpanel on Documents/Settings,
  state preserved across a round-trip. The shell still owns the `showPane` gate +
  drops the `workboard` tab on desktop; the `.car-stage` grid + `car-stage-pane-open`
  modifier were retired for a plain flex box. `PlansPane` itself is unchanged.

- **Work rows are 2-line (title / tag+round), 1-line when queued** (`WorkBoardTab.tsx`
  web + `app/components/WorkBoardRow.tsx` mobile, `chat-react.html`). Each row stacks
  a `.cwb-row-line1` (dot + FULL title + hover actions) over a muted `.cwb-row-meta`
  (phase tag + `round N`), gated on `hasStatus` (`tag !== null`): a bare queued card
  is a single title line (no empty second line), a bound run shows "Building · round
  1" on line 2, and a done row carries "Merged · <date>" on line 2. Titles no longer
  truncate prematurely (tag/round left line 1).

**Verified.** `tsc` clean (chat-react + app); 297 chat-react unit tests pass
(inline-confirm assertions replace the modal ones; new 2-line/1-line-queued row
test; the desktop pane test asserts the pane lives inside the chat tabpanel and the
`.car-plans-col` open-class shrink). Local dogfood (fresh QUIET install, headless
agent-browser, ≥1024px, BOTH light + dark): tab favicon = the atom; ✕ → inline
Remove?/Cancel/Remove in-row (no backdrop), Escape cancels, focus returns; the
composer spans the full width along the bottom with the Work pane above it; the pane
is GONE on Admin and restored on returning to Chat; a queued item is 1-line with the
full title. `leak-gate.sh --tree .` SILENT.

## 2026-07-03 — General gets a Work surface (desktop slide-out + narrow tab), scoped to its owner_slug board (no flags)

**Why.** M1 follow-up closing the last item Ryan flagged directly ("there's no
Work tab in General … an oversight"). After the M1 redesign, desktop Work is a
right-edge slide-out pane (`PlansPane`, PR-4) and below 1024px it's a seated tab —
both mount only for a scope whose tab set carries a `workboard` descriptor.
General's tab set is Chat + Admin (the engine's global set is Admin-only), so
General had NO Work view — even though General-scoped work (builds kicked from the
General chat) lands on a real, backend-reachable board (the `owner_slug` scope key,
`work-board/store.ts`). So that work was invisible. This surfaces it.

**What shipped.**

- **General Work surface, one code path** (`landing/chat-react/ProjectShell.tsx`):
  the `if (isGeneral)` tab-set branch now injects the builtin `work_board`
  descriptor (`GENERAL_WORK_TAB`, `tabs-client.ts`) after Chat —
  `[CHAT_TAB, GENERAL_WORK_TAB, ...globalTabs]` — mirroring how the mobile shell
  injects its Work tab via `ensureWorkTab`. With the descriptor present, the
  EXISTING machinery lights up for General with zero new branch: on desktop
  (≥1024px) the `showPane` gate mounts the `PlansPane` slide-out (edge-handle +
  auto-open-on-kickoff / auto-close, per PR-4); below 1024px Work stays a seated
  tab. General keeps its Chat + Admin tabs — Work is ADDED, not swapped.

- **General board scoping (the `''` ↔ `'general'` reconciliation)**
  (`landing/chat-react/work-board-client.ts`): the web shell scopes General as the
  empty project id `''` EVERYWHERE — the rail's General row is `vm.projectId ===
  null`, and the live `work_board_changed` filter keys off `(framePid ?? '') ===
  projectId`, so General MUST stay `''` for its no-`project_id` snapshot to be
  applied (kickoff auto-open, live dot/tag walk). But the HTTP work-board surface
  keys General on the literal `'general'` id (`workBoardScopeKey(owner_slug,
  'general') → owner_slug`) and 400s on an empty path segment. So the new
  `workBoardPathSegment` helper maps `'' → 'general'` at the URL boundary ONLY
  (never the `//work-board` double-slash the ProjectShell Codex-P2 note flags);
  named ids pass through untouched. No scope-key semantics changed — `store.ts` is
  untouched.

- **Mobile:** unchanged. Mobile General is not yet a navigable scope (its rail has
  no synthetic General entry — `GENERAL_PROJECT_ID` is only used to *detect* a
  General row, never to *construct* one — and `app/lib/projects.ts` has no General),
  so there's no mobile Work-tab-for-General gap to close here without first building
  the whole General-on-mobile surface (out of scope). The existing `ensureWorkTab` +
  `workTabBadgeCount` machinery already applies to the `'general'` id the moment
  General becomes navigable on mobile. Noted in the PR + SYSTEM-OVERVIEW.

**Tests.** `work-board-client.test.ts` (`'' → 'general'` path mapping for
list/create/start, named-id pass-through, no double-slash); `tabs-client.test.ts`
(`GENERAL_WORK_TAB` shape); `project-shell.test.tsx` (narrow General = Chat + Work
+ Admin; desktop General mounts the pane, drops the Work tab, and its board query
targets `/api/app/projects/general/work-board`); `component.test.tsx` create-project
fetchImpls now serve the General board (the pane lists on mount under happy-dom's
desktop viewport). tsc clean; leak-gate SILENT.

**Files.** `landing/chat-react/ProjectShell.tsx`, `tabs-client.ts`,
`work-board-client.ts` + the four test files; `docs/SYSTEM-OVERVIEW.md` (the
"General's Work view" follow-up note flipped to CLOSED).

## 2026-07-03 — M1 UX redesign PR-6: Mobile project rail + seated tabs + Work-badge (LAST redesign PR, no flags)

**Why.** Ryan-signed-off M1 UX redesign (2026-07-02). PR-6 is the MOBILE
counterpart of PR-3's desktop rail/tabs (the Expo app under `app/`). Ryan
explicitly asked for the mobile project rail to show the emoji **and the project
name below it** (Telegram-folder-style) — overriding the prototype's emoji-only
icon rail. Depends on PR-1..5 (all merged). No feature flags — one code path.

**What shipped.**

- **Telegram-folder project rail** (`app/components/ProjectRail.tsx`, new) seated
  on the LEFT of the workspace (`app/app/projects/[id]/_layout.tsx` restructured to
  `[rail | (tabs + content)]` on the narrow/native path). Each entry: emoji +
  **name directly below** (weight bumps on unread, 1-line ellipsis) + a corner
  **work-activity dot** — `working` → pulsing `--work` @2.4s (reduced-motion-gated
  via `AccessibilityInfo`), `attention` → static `--attention`, `idle`/General →
  none. Active project highlighted; tap → `router.replace('/projects/<id>')`; a `+`
  jumps to the project list. Dot logic is the pure `railDotKind`
  (`app/lib/project-rail-view.ts`, unit-tested).

- **Seated tabs** (`app/components/ProjectTabBar.tsx` `NarrowTabBar`): top-rounded
  sheets on a `surface` band, active tab fused to the content sheet (mirrors PR-3
  desktop). Replaces the old underline/pill treatment — one path.

- **Work-tab live-run badge**: the registry emits no Work descriptor, so
  `ensureWorkTab` (`app/lib/project-tabs.ts`) injects a Work tab after Chat over
  BOTH the loading default and the fetched set (idempotent, one path), routed to
  the existing `workboard.tsx`. The tab bar renders a phase-build-tinted `.cap`
  badge for any tab with a positive count; the layout feeds the current project's
  `live_runs`.

- **Rail data (no re-derivation).** SET from `fetchProjects` (HTTP);
  `activity`/`live_runs` overlaid LIVE from the app-ws `projects_changed` frame via
  a new `app/lib/projects-rail-live.ts` subscriber (mirrors `work-board-live.ts`,
  injectable socket). The mobile HTTP `/api/app/projects` never carried these
  fields — the composer-fanned frame is the single source of truth (same as web).

- **Server (minimal):** `on_session_open` (`open/composer.ts`) now pushes the
  current projects snapshot straight to the just-connected topic, so a freshly-
  connected mobile rail seeds on open instead of waiting on the global diff-gate.

- **Theme:** added `work` (#66ccff) + `attention` (#ffd27d) tokens to
  `app/lib/theme.ts` (mirror of the web `--work`/`--attention`); theme lock-test
  updated.

**Tests.** `project-rail-view.test.ts`, `projects-rail-live.test.ts` (fake
socket), `project-tabs-work.test.ts` + theme lock-test — full app suite 693 pass.
App `tsc` clean, root `tsc` clean, leak-gate SILENT.

**Out of scope.** Desktop web (PR-1..5), docs drill-down (PR-5), a rail preview
line, any activity/live_runs derivation outside the composer.
## 2026-07-03 — TRIDENT parallel builds + build lifecycle (#342/#340/#339/#334/#337)

**Why.** Ryan's live test 2026-07-03 (SPEC.md Decisions Log, Ryan-locked). Vajra runs
3+ parallel trident builds in one project constantly; Open couldn't. Plus four
lifecycle gaps: a failed build vanished, a finished build never announced, a build
could run untracked, and an underspecified ▶ dumped raw guard text into the pane.
NO feature flags; one code path; leak-gate SILENT. Stayed clear of the pure chat-react
UI polish (#333/#335/#336/#338/#341 — a separate forge, landed as #189; this branch
rebased onto it, resolving the `chat-react.html` `.cwb-drag` overlap by keeping both
#341's grip styling and this PR's `.cwb-fail-reason`).

**FIX 1 (#342, P1) — 3+ concurrent same-project builds.** Each build already runs in
its own worktree and `mergeLocal` already serializes LOCAL merges per `repo_path`
(`withLocalMergeLock`). But inside the lock it did a plain `git merge --no-ff` that
THREW on any conflict — so a 2nd same-project build (branch cut from the pre-1st base)
died on a merge conflict (this killed `dagcore` after `walstore` merged). Now
`mergeLocal` (`trident/merge.ts`): resolves the base, **rebases the build's branch onto
the latest base** (`git checkout <branch>` + `git rebase <base>`), then `git checkout
<base>` + `git merge --no-ff` (a clean no-conflict merge since the branch now contains
base). On a rebase CONFLICT it dispatches a **bounded Forge resolver**
(`trident/conflict-resolver.ts`, `buildForgeConflictResolver` over the composer's
`makeEphemeralSubstrate('cc-trident-resolve')`): a single tool-less CC turn rooted in
the conflicted worktree that resolves + `git add`s the conflicts (the loop runs `git
rebase --continue`), keeping both intents where compatible; it reports `RESOLVED` or
`ESCALATE: <specific question>`. A genuinely ambiguous conflict (or a missing/timed-out
resolver) throws `TridentMergeConflictEscalation`, which `orchestrator.applyResult`
turns into a `failed` run whose `failure_reason` IS the specific question — so it rides
the terminal chat delivery (FIX 3) verbatim, never a raw "merge failed". Bounded: an
8-min per-turn timeout, escalate-on-uncertainty, `MAX_CONFLICT_ROUNDS=12`. Wiring:
`orchestrator.resolve_conflict` → `buildMergeCleanupDeps(run_host, { resolve_conflict })`;
threaded through `input.trident.resolve_conflict` (`misc-input.ts` →
`build-core-modules.ts` → `open/composer.ts`).

**FIX 2 (#340) — a failed build shows FAILED, keeps its link, no revert.** Added a
fourth Work Board lane `'failed'` (migration `0097`, widened CHECK via table rebuild).
`WorkBoardStore.detachRun('failed')` now sets `status='failed'` and KEEPS
`linked_run_id` (was: revert to `upcoming` + null the link, which showed a grey
never-started card and lost the failure). The client already renders a red dot +
failed tag off `run_progress.step_label==='failed'` (kept alive by the retained link);
this PR renames the tag copy to **"Failed"** and renders the `failure_reason` one-liner
(`.cwb-fail-reason` web / `failReason` mobile). Client status unions + parse guards
widened to `'failed'` (`work-board-client.ts` web+mobile — the mobile parser had been
DROPPING any unknown-status item), plus `AppWsWorkBoardItem` + `statusLabel`/`nextStatus`.

**FIX 3 (#339) — terminal builds announce in chat.** Root cause was two-fold: (a) a
board-dispatched run carried `chat_id=null` (the warm-REPL `ToolCallContext.topic_id`
is null by design), so `topicForRun` no-op'd; (b) even with a chat_id, Open's delivery
`ChannelRouter` has NO app_socket adapter registered, so `router.send` threw and was
swallowed. Fix: (a) `resolve_delivery(project_id)` on the dispatch tools + the ▶ route +
`/code` stamps the originating app-ws topic (`<appWsTopicId>[:<project_id>]`, `project_id`
is correctly populated on the tool ctx) onto the run's `chat_id`; (b) a composer-supplied
`delivery_sink` backed by the durable `AppWsAdapter.send` (persists + fans live) replaces
the bare router for on-terminal delivery. Copy is now slug-forward ("✅ `<slug>` — build
done, merged" / "❌ `<slug>` — build failed: `<reason>`").

**FIX 4 (#334) — every build creates a trackable card.** Strengthened
`BUILD_ROUTING_DOCTRINE` (`operating-doctrine.ts`): EVERY build — inline OR trident, any
project incl. General — MUST `work_board_add` a card FIRST (inline builds mark it
inline_active + done); an untracked build is invisible to the owner.

**FIX 5 (#337) — underspecified → ask in chat, not raw guard in the pane.** The ▶ HTTP
route previously mapped an `underspecified` rejection to a 409 whose raw guard message
the client painted into the `cwb-error` pane banner. Now the composer's start closure
posts a short clarifying question to the chat (`buildClarifyPoster`, via the app-ws
adapter) and `handleStart` returns 200 `{asked_in_chat:true}` — no raw text in the pane,
item left quietly pending. The agent-native path already returns the rejection to the
model (which the strengthened doctrine tells to ask in chat).

**Tests.** trident + work-board + composer green incl. a concurrent-merge test and a
3-build serialized rebase+resolve test (`trident/merge.test.ts`), conflict-resolver
marker parsing (`trident/conflict-resolver.test.ts`), orchestrator resolve-vs-escalate
(`trident/orchestrator.test.ts`), `detachRun('failed')` keeps-link + retry
(`work-board/store.test.ts`), delivery copy (`trident/delivery.test.ts`),
`resolve_delivery` threading (`trident/work-board-build-tool.test.ts`), doctrine
always-card + ask-in-chat (`operating-doctrine.test.ts`), and the ▶ underspecified→200
(`work-board-surface.test.ts`). `tsc` clean (root + trident + leaf); migrations snapshot
regenerated (`0097`); leak-gate SILENT; QUIET local boot verified (healthz ok, `0097`
applied).

## 2026-07-03 — UX BATCH-2: 5 chat/work-board polish fixes (#333/#335/#336/#338/#341)

**Why.** Five small UI defects from Ryan's live review 2026-07-03. All presentational /
run-progress; no feature flags; kept clear of trident/merge + build-dispatch (a
separate forge owns #334/#337/#339/#340/#342).

**Spec-conformance diff.** SPEC = rail dot pulses in work-blue; transient system pills
never persisted; Fixing shows round 2+; chat has timestamps+date-hover+day-dividers;
drag handle is grip-dots no-border. CURRENT (pre-PR) = rail dot used the separate
`--work` token; waking-up pill persisted→re-hydrated as a bubble on reload; Fixing
showed round 1; chat had no timestamps; drag handle was a bordered `.cwb-btn` box.
GAP = all five. THIS PR = all five. OUT = build-dispatch behavior + trident-parallel.

**What shipped.**
- **#335 rail activity dot (web + mobile).** The `working` rail dot now MATCHES the
  Work-list building dot exactly: the building blue (`--phase-build-fg` /
  `PHASE.build.fg`, not the separate `--work` token) with the shared `cwb-pulse`
  (opacity 1→.4→1, 2s, prefers-reduced-motion gated). `attention` stays a STATIC
  amber (`--attention`) reserved for a genuine stall/failed-not-done.
  (`landing/chat-react.html` `.car-rail-dot-work`; `app/components/ProjectRail.tsx`
  `ActivityDot`.)
- **#333 transient system pills are live-only.** The cold-start "⏳ Waking up…" ack
  now rides a first-class `system_notice: true` flag end-to-end
  (`AgentMessageOutbound` → `buildAppWsSendReply` adapter_options →
  `AppWsAdapter.send`): the adapter fans it out to the live socket but SKIPS the
  durable `chat_log` row (and the project `last_activity_at` stamp), so a
  reload/project-switch can't re-hydrate it as a stray chat bubble. The client
  already routed `system_notice` to the quiet pill.
- **#336 Fixing shows the fix-round.** `deriveRunProgress` derives the displayed
  `round` from the inner checkpoint (the outer `code_trident_runs.round` stays 1 for
  the whole in-process workflow — `checkpoint()` never bumps it): a
  `argus-request-changes` (fixing) step now floors the round at 2; `fix-round-N`
  carries N; a first build stays round 1. (`trident/run-progress.ts` only — no
  inner-workflow edit, to stay clear of the trident forge.)
- **#338 chat timestamps + date-on-hover + day dividers.** `RenderMessage` gains a
  real-wallclock `timestampMs` (durable rows only); a context-keyed meta index
  (`buildMetaIndex`) tags each bubble with a subtle trailing `HH:MM` time (full date
  on hover via `title`) and a centered "Today / Yesterday / Mon Jul 1" day divider
  above the first message of a new calendar day. (`landing/chat-react/controller.ts`,
  `ChatApp.tsx`, `.car-time`/`.car-day-divider` CSS.)
- **#341 drag handle is grip-dots.** The reorder handle drops the `.cwb-btn`
  bordered-box chrome — just the ⠿ grip glyph, muted (`--faint`→`--muted` on hover),
  grab/grabbing cursor — so it reads as a draggable grip, not a third action button
  next to ▶/✕. (`landing/chat-react/WorkBoardTab.tsx` + `.cwb-drag` CSS.)

**Verify.** tsc clean (root + chat-react + trident + app); 415+ chat-react/app-ws
suites green + new tests for the round derivation, the ephemeral-send no-persist path,
and the time/divider helpers; leak-gate SILENT. Both light+dark preserved;
prefers-reduced-motion gated.

## 2026-07-02 — M1 UX redesign PR-4: Work slide-out pane (edge-handle + auto-open/close, no flags)

**Why.** Ryan-signed-off M1 UX redesign (2026-07-02). PR-4 replaces the desktop
"Work" TAB with a right-edge **slide-out pane INSIDE the chat** — the authoritative
prototype (`neutron-redesign-proto.netlify.app`) behavior, with Ryan's sign-off
overrides winning over the design doc's toggle-chip proposal: **an edge-handle is
the only manual control (no toggle button / no X / no close chevron)**, and
**auto-open-on-kickoff / auto-close-when-all-done** is the primary behavior. Depends
on PR-1 (#180 activity/live-run), PR-2 (#181 Work-list rows), PR-3 (#182 rail +
seated tabs). No feature flags — one code path per viewport. Web
`landing/chat-react/` only (NOT docs [PR-5] or mobile rail + Work-badge [PR-6]).

**What shipped.**

- **Desktop (≥1024px): Work is a pane, not a tab** (`ProjectShell.tsx`). Via
  `useMediaQuery('(min-width:1024px)')`, the `workboard` descriptor is dropped from
  the seated tab bar and a new `PlansPane` is mounted instead. **Below 1024px Work
  stays a tab** (mobile Work badge is PR-6) — one implementation per viewport, no
  dual tab-and-pane path. When the Work tab is dropped, an active-tab clamp falls
  back to Chat (reuses the existing resolving-scope guard, now over `visibleTabs`).

- **`PlansPane.tsx` — chrome around the shipped `WorkBoardTab` body** (rows
  unchanged: dot + tag + round, collapsible Done, drag-reorder, ✕-confirm, ▶
  start/retry, add-at-bottom). The pane adds a quiet caps `WORK` header + a live
  count (`● N running` / `● N failed`, activity dot), the edge-handle, and the
  floating-panel container.

- **Edge-handle = the ONLY manual control** (`.car-plans-handle`, a real `<button>`
  with an aria-label "Show work"/"Hide work", Enter/Space operable). It rides the
  pane's left seam — at the window's right edge when closed (the way in), riding to
  the pane's left seam when open. NO toggle button, NO X, NO close chevron anywhere.

- **Auto-open / auto-close (`usePlansPaneController`).** Opens when a plan is kicked
  off (a board item gains a live non-terminal run → the `WorkBoardTab` `onSummary`
  roll-up's `running` rises); stays open while any run is live; keeps open on a
  **failed** run (attention); auto-closes ~5s after ALL runs are clear (running +
  failed both zero). A manual handle toggle pins + persists per-project
  (`localStorage`) until the next auto-kickoff. `WorkBoardTab` gains a pure
  `summarize()` export + an `onSummary` callback (fired on every board change).

- **Floating panel, not a wall** (`chat-react.html`). The chat STAGE below the tab
  band is a 2-column CSS grid (`.car-stage`) whose pane column animates
  `0 → --pane-width` (340px), so the chat column shrinks in lock-step (chat is never
  overlaid). The panel (`.car-plans`) floats flush to the right edge with ~16px
  top/bottom breathing room, rounded left corners (`14px 0 0 14px`), and a soft
  shadow; closed = translated off-screen + `visibility:hidden` (its controls leave
  the tab order). New tokens `--pane-width` + `--ease-out`
  (`cubic-bezier(0.32,0.72,0,1)`); motion gated by `prefers-reduced-motion`. Both
  light + dark palettes preserved.

- **Tests.** `plans-pane.test.tsx` (controller: kickoff-opens / settle-auto-closes
  / failed-stays-open / manual-pin-persists; `PlansPane`: edge-handle is the only
  control + toggles; live running item auto-opens end-to-end) +
  `project-shell.test.tsx` desktop test (Work tab absent at ≥1024px, handle mounted,
  clicking expands the stage grid). Verified locally at 1280×… both themes: no Work
  tab, floating pane below the band, chat shrinks, sticky survives a restart.

## 2026-07-02 — M1 UX redesign PR-3: rail 2-line rows + seated tabs + ⚛ branding (no flags)

**Why.** Ryan-signed-off M1 UX redesign (2026-07-02). PR-3 reskins the web chat
shell's left rail and tab band to the authoritative prototype
(`neutron-redesign-proto.netlify.app`): a Telegram-style 2-line project rail with
a work-activity dot + preview, an ⚛ Neutron branding header, and real seated tabs
with a workspace-identity seat. Consumes PR-1 (#180) rail fields
(`activity`/`preview`/`preview_from`/`last_activity_at`). No feature flags — one
code path, the old rail-row + underline-tab CSS deleted. Web `landing/chat-react/`
only (NOT the Work slide-out pane [PR-4], docs [PR-5], or mobile [PR-6]).

**What shipped.**

- **⚛ Neutron branding header** (`ChatApp.tsx` `TopicRail` + new `AtomMark`;
  `chat-react.html` `.car-rail-head`). The "PROJECTS" caps label is replaced by an
  inline-SVG atom (`--accent`, 3 rotated ellipses + center dot) + the "Neutron"
  wordmark (16px/700). The new-project `+` moves to the right of the header
  (`.car-rail-newp`) and toggles the inline create form; the old bottom
  "Create Project" button is deleted.

- **Telegram-style 2-line rail rows** (`RailItem`; `.car-rail-item` grid). Emoji
  "avatar" (40px plain glyph) + a corner **work-activity dot** (`railDotClass`:
  `working` → pulsing `--work` @2.4s, `attention` → static `--attention`, else
  none; General has no dot; `prefers-reduced-motion` disables the pulse). Line 1 =
  name (15px/590, 700 unread) + right-aligned timestamp (`formatRailTime` off
  `last_activity_at`: today → `14:32`, this week → `Mon`, older → `Jun 28`,
  tabular-nums). Line 2 = one-line ellipsised `preview` (muted, `--fg-2` unread;
  `You:` prefix when `preview_from==='user'`) + the unread badge. New tokens
  `--work`, `--attention`, `--fg-2`, `--faint` added to BOTH `chat-react.html`
  palettes (light + dark).

- **Narrow (<1200px) icon rail.** A JS `narrow` render branch (`useMediaQuery`,
  test-overridable via a `narrow` prop) collapses the rail to a 68px icon rail:
  avatar + corner dot + a small corner count badge (`.car-rail-count`), names in
  the row `title`. Supports PR-4's rail auto-collapse.

- **Seated tabs + workspace-identity seat** (`ProjectShell` `.car-topbar`/`TabBar`
  + new `WorkspaceSeat`; `chat-react.html` `.car-tab`/`.car-wsseat`). The band is a
  `--surface` strip whose ACTIVE tab lifts onto the content sheet (bg `--bg`, a
  border minus its bottom edge, `margin-bottom:-1px` fusing it to the page); the
  sliding `--accent` underline treatment is DELETED. A workspace seat (active
  scope's `emoji + name`; General → `💬 General`) sits left of the tabs — no
  activity dot (that lives on the rail, per Ryan's de-dup). Theme toggle kept.

- **Tests.** `component.test.tsx` (+ new `formatRailTime`/`railDotClass`/`railEmojiFor`
  pure tests, 2-line-row content, work/attention dots, `You:` prefix, narrow icon
  rail) and `project-shell.test.tsx` (workspace seat: General + project). tsc clean,
  leak-gate SILENT. Existing create-project tests updated for the header `+`.

## 2026-07-02 — M1 UX redesign PR-2: Work-list rows + chat message formats (no flags)

**Why.** Ryan-signed-off M1 UX redesign (2026-07-02). PR-2 reskins the Work-list
rows to a plain-language, non-technical-user bar (the "Alina" bar) and fixes the
chat message-format split. Depends on PR-1 (#180) `step_label` + the live tick
fan. No feature flags — one code path, the old glyph/arrow code deleted.

**What shipped.**

- **"Plan" → "Work"** user-facing tab label (`tabs/registry.ts`); internal
  `work_board_*` / `cwb-` / DB identifiers unchanged. Onboarding closing +
  preamble copy follow ("its Work, Documents, and Chat").

- **Work-list rows (web `landing/chat-react/WorkBoardTab.tsx` + mobile
  `app/components/WorkBoardRow.tsx`).** Each active row is now
  `[dot] title … [phase tag] [round] [hover actions]`, consuming PR-1's
  `step_label`:
  - **Leading dot** — faint-gray outline before a build starts; a colored
    PULSING dot while a bound run walks building→reviewing→fixing→merging (pulse
    in the tag's color, gated by `prefers-reduced-motion`); solid red on failure;
    solid green when done.
  - **Phase tag** — a small typographic capsule (Building / Reviewing / Fixing /
    Merging / Merged / "Didn't finish"), tinted bg + colored fg, no border, no
    emoji. New phase color tokens in both `chat-react.html` palettes (dark +
    light) and mobile `app/lib/theme.ts`.
  - Deleted the emoji-glyph status noise (📝🔨🔍✅⚠️🚫) + the `⑂`/`›` activity-glyph
    column + the elapsed-minutes timer. `round N` (muted) trails the tag.
  - **Drag-to-reorder** via a `⠿` grip (web: HTML5 DnD + arrow-key parity;
    mobile: pointer/accessibility reorder) replacing the ▲▼ arrows; persists
    `sort_order` via the existing reorder route.
  - **✕ delete asks to confirm first**; ▶ starts a not-started card, ↻ retries a
    failed one.
  - Completed items collapse under a **"Done · N"** disclosure (default closed,
    caret ▸/▾) and show a **"Merged · Jul 2"** datestamp.
  - The **add-something-to-do** affordance moved to the BOTTOM of the list.

- **Chat message formats (web).** Errors + command results stay ORDINARY agent
  chat bubbles (a "build failed" is a message, not a banner) — the Work-list ↻
  covers the "build failed → retry" case. A quiet centered **system-notification
  pill** (`.car-system-pill`) is now the ONLY thing in the system-message style,
  reserved for true notifications: the gateway's cold-start "Waking up…" ack
  renders as the pill (self-clearing when the real reply streams) instead of a
  bubble. (Mobile chat-format parity is a documented follow-up — see PR notes.)

## 2026-07-02 — trident/work-board correctness bundle (3 bugs a live parallel build test exposed)

**Why.** A live test dispatched two trident builds (taskdag + waldb) in parallel
for the same owner. Both built + committed fine, then three engine defects
surfaced: (1) waldb FAILED at merge with `untracked working tree files would be
overwritten: taskdag, dag.ts` — the OTHER build's files; (2) taskdag ended
`subagent_status='completed'` but its `phase` stuck at `forge-init` forever; and
(3) separately, every project's Plan tab showed the SAME list. One PR, no feature
flags, no migration.

**What shipped.**

- **Bug 1 — per-workspace merge serialization.** Two builds in the same project
  share ONE `code` workspace, so their local merges (`git checkout <base>` + `git
  merge --no-ff` in the one working tree) race — A's committed-but-unmerged files
  are untracked when B checks out base. `trident/merge.ts:mergeLocal` now runs
  under a per-`repo_path` promise-chain lock (`withLocalMergeLock`): the 2nd merge
  waits, then merges on a base that already has A's files TRACKED. Keyed on
  `repo_path` so different-project workspaces still merge in parallel; a failed
  predecessor never wedges the queue. PR-mode is untouched (it never merges in the
  shared tree). Verified against REAL git: two concurrent `cleanupAfterMerge` calls
  on one repo land BOTH branches on main with no untracked-overwrite.
- **Bug 2 — robust terminal harvest.** The inner workflow writes
  `subagent_status='completed'` in the same sqlite UPDATE that sets `inner_result`
  via `readfile()`. If that readfile yields null, the run is left `completed` with a
  null/garbled result: `parseInnerResult` returns null (harvest never fires) and the
  completed-write re-stamps `last_advanced_at` (hang watchdog DEFEATED) → stuck at
  `forge-init`. `trident/orchestrator.ts` now treats a terminal `subagent_status`
  with no parseable `inner_result` as a TERMINAL FAILURE (never merges — no verified
  result). Defense-in-depth: `writeTerminalResult` (`inner-workflow.mjs`) flips
  `subagent_status` to `completed` only inside a CASE guarded on the same
  `readfile()` being non-empty, so the columns can't disagree at the source.
- **Bug 3 — per-project Plan board.** The HTTP surface keyed every store call on
  the instance constant `resolved.project_slug`, so all projects collapsed onto one
  board. It now keys on `workBoardScopeKey(owner_slug, <url project_id>)` (new, in
  `work-board/store.ts`): the owner slug bounds the scope (single-owner box), the
  validated URL `project_id` selects the project (General → the bare owner slug,
  which also carries all pre-scoping legacy rows — no migration, no history
  stranded). A cross-scope `store.get` miss stays a 404. The dispatch ▶ path threads
  the same scope so a build resolves a per-project workspace + reconciles on the
  right key. The `work_board_changed` push tags each frame with the per-project
  `project_id` (`workBoardProjectIdForKey`); the app + web clients now apply a
  frame ONLY on an EXACT board match — an untagged frame is the General board
  (projectId `''`/null), NOT a broadcast (Codex P2 fix — else a General/agent
  write clobbered an open project's live view). Interaction:
  fixing #3 does NOT subsume #1 — two concurrent builds in the SAME project still
  share one workspace, so #1's lock is still required.

**Scope note.** The agent `work_board_*` tools + the per-turn injection still key on
the instance slug (hard-overridden in `mcp/server.ts`), so the chat agent and the
General Plan tab share the General board; per-project boards are human/HTTP + ▶
scoped. A deeper per-project agent context is a separate change (out of scope).

**Tests.** Deterministic coverage for all three GATES: merge mutex (serialize on
same `repo_path`, parallel on different, failed-first doesn't wedge) + a real-git
concurrent-merge check; harvest gate (completed+null → failed, completed+garbled →
failed, running+null NOT reaped); surface per-project isolation (A vs B distinct,
cross-scope 404, General→owner-slug legacy rows) + scope-key helpers + onChange
key-passing. `bunx tsc --noEmit` clean; trident + work-board suites green (442 +
84 targeted); leak-gate SILENT.

## 2026-07-02 — M1 Work Board ▶ play button + on-disk spec persistence

**Why.** Two coupled gaps from the live trident test: (1) a Plan card that was
added but never dispatched (or whose build failed) had no way to START/RETRY it
from the board — only auto-dispatch + the `#174` X-cancel existed; (2) a card
persisted ONLY its one-line `title` — the full context/ask lived in session
context and only landed on disk (in `code_trident_runs.task`) AFTER a build
started. So an `upcoming` card's spec did not survive a session reset, and a ▶
that survives a reset had nothing to build from. One PR, no feature flags, no
migration (the `design_doc_ref` column already existed, unused for docs).

**What shipped.**

- **Spec-doc persistence.** `work-board/spec-doc.ts` (pure): a triviality
  heuristic (`shouldPersistSpecDoc` — a short one-liner stays title-only;
  multi-line or ≥20-word specs persist), the `plans/<slug>.md` path, and the
  `neutron-docs:` deep-link ref build/parse + doc-link label. New
  `work-board/spec-doc-service.ts` (`WorkBoardSpecDocService`) is the ONE seam
  coupling the policy to the real `DocStore` + `WorkBoardStore`:
  `createCardWithOptionalSpec` writes the doc to `Projects/<id>/docs/plans/<slug>.md`
  and links the card; `resolveTaskForItem` reads it back as the build spec. An
  `ensureDocsDir` hook (composer → recursive mkdir of the project docs root)
  guarantees the write never silently degrades for a not-yet-materialized project
  scope. A doc-write failure degrades gracefully to a title-only card.
- **▶ start/retry.** `POST /api/app/projects/<id>/work-board/<item>/start` +
  the agent-native `work_board_start` tool, both routing through the SAME
  `dispatchBoardBoundBuild` chokepoint (required-item + ask-before-acting gate +
  `attachRun`), resolving the card's saved spec (doc, else title) as the run
  `task`. A live-run guard 409s a double-start; an underspecified card 409s with
  the clarify guidance; an LLM-less box 501s (dispatch unwired, mirroring
  `work_board_dispatch_build`). `work_board_add` gained a `spec` param; the HTTP
  create route gained a `spec` field — both route through the service.
- **UI.** Web `WorkBoardTab.tsx`: an always-visible ▶ on a startable card (START
  vs RETRY by label) + a tappable `📄 <name>` doc link that opens the Documents
  tab (threaded `onOpenDoc` from `ProjectShell`, reusing the `#148` doc-link nav);
  `cwb-btn-play` + `cwb-doc-link` CSS. Expo `WorkBoardRow.tsx` + `workboard.tsx`:
  the same ▶ + doc-link for parity. `work-board-client.ts` (web + app): a `start()`
  method + `docPathFromDesignRef`/`docLinkLabel` mirrors.
- **§1b unification (one canonical doc).** ▶ feeds the card's doc content to the
  run as its `task`, so the doc IS the spec the trident planning stage reads —
  verified live (the dispatched run's `task` was the doc's full body). There is
  no second user-facing plan doc.

**Spec-conformance delta (Ryan-locked path adjusted for the docs surface).**

- The spec's Ryan-locked folder was literally `Projects/<id>/plans/<slug>.md`.
  The `DocStore` confines every SERVED + tappable doc to `Projects/<id>/docs/`
  (`gateway/http/doc-store.ts` resolves the docs root there; only the fixed
  `STATUS.md` basename is surfaced from the project root). A doc at
  `Projects/<id>/plans/…` (a sibling of `docs/`) would NOT be served by the docs
  API nor appear in the Documents tab — breaking the hard requirement that the
  doc is "served by the existing docs store/API + shows in Documents +
  tappable". So the plans folder is nested UNDER `docs/`:
  `Projects/<id>/docs/plans/<slug>.md`. This honours the intent (user-visible
  project docs, a `plans/` folder, tappable) exactly; the only delta is the
  `docs/` prefix, which is what makes it visible at all.
- **§1b write-back deferred (noted, not built).** ▶ makes the card doc the
  READ source-of-truth for the build (`task` = doc content). The spec's further
  ask — the ralph planning stage writing its ELABORATED `IMPLEMENTATION_PLAN.md`
  BACK INTO the card doc — materially reshapes the ralph I/O: the ralph loop runs
  in an ephemeral git WORKTREE and writes `IMPLEMENTATION_PLAN.md` at the worktree
  root, while the card doc lives in `NEUTRON_HOME/Projects/<id>/docs/`; the
  detached inner Workflow has no `DocStore` handle, and ralph only engages for a
  governed repo (`SPEC.md` at the git root), not the common single-context build.
  Per the spec's own "STOP and note the delta rather than fork a second code
  path" instruction, the bidirectional write-back is left for a follow-up. No
  parallel user-facing plan doc is created; the worktree `IMPLEMENTATION_PLAN.md`
  is an existing build-internal artifact (not user-surfaced).
## 2026-07-02 — Trident: per-project git build workspace (brand-new projects are buildable)

**Why.** A trident build for a BRAND-NEW project (no code repo) died ~2 min in —
`worktree` never created, `forge:build` produced no transcript, workflow jumped to
cleanup. Root cause: the dispatch chokepoint wrote the owner HOME dir
(`resolveNeutronHome`, a non-repo) as EVERY run's `repo_path`, so the inner
workflow's `isolation:'worktree'` (`git worktree add`) failed at forge-init before
Forge ran. Only projects that already had a git repo built.

**What shipped.** New `trident/build-workspace.ts:ensureProjectBuildWorkspace`
resolves + git-inits (idempotent, `--initial-branch=main` + an `--allow-empty`
INITIAL COMMIT so `git worktree add` has a HEAD) a per-project
`<owner_home>/Projects/<project_slug>/code` workspace. `dispatchBoardBoundBuild`
(`trident/board-dispatch.ts`) now resolves this FIRST, runs merge-mode/ralph
detection against the RESOLVED workspace, and writes that per-project path onto the
run row's `repo_path` — replacing the old `repo_path = owner_home` assignment (one
code path, no flag). The three dispatch dep interfaces now document `repo_path` as
the owner HOME BASE with an injectable `resolveBuildRepo` test seam. A fresh local
project has no origin → merge mode `'local'` (branch + local merge, no PR); success
= a local BRANCH WITH COMMITS, not a PR#.

**Verified.** `tsc` clean (root + trident); 361 trident tests green;
`trident/build-workspace.test.ts` added (pure-probe + real-git + dispatch-level).
A no-LLM real-git e2e reproduced the original `fatal: not a git repository` failure
on the old path, then drove resolver → `detectMergeMode`=local/`detectBaseBranch`=main
→ `git worktree add` → multi-file branch with commits → real `mergeLocal` →
merged-local terminal state. The full autonomous-LLM `forge:build` leg (#176's
already-verified toolless fix) was not re-driven in this headless run; the git
workspace was the missing precondition and is now proven to satisfy `worktree add`.

## 2026-07-02 — M1 trident-UX hardening: live Plan progress, hang watchdog, X-cancels-run, confirm dialog

**Why.** A live trident test wedged SILENTLY and surfaced four gaps: (1) a
Plan item dispatched to a build showed only a fork `⑂` glyph — no phase, round,
or elapsed, so a running build looked identical to an idle one; (2) a workflow
`agent()` hung (a zero-token model hang) and NOTHING detected it — the run sat
`forge-init` for 30+ min with no error; (3) deleting a Plan card left its trident
run building headless (the `DELETE` never cancelled the run); (4) the X deleted
instantly, so a fat-finger could cancel an expensive running build. One PR, no
feature flags, no migration (all four derive from existing columns).

**What shipped.**

- **Live progress on Plan items (item 1).** New pure `trident/run-progress.ts`
  (`deriveRunProgress`) maps a linked `code_trident_runs` row → `{phase_label,
  round, elapsed_ms, stalled, pr, verdict, …}`. Critically the label is derived
  from `phase` + `inner_checkpoint`, NOT `phase` alone — in the Phase-2a EXEC
  model the outer `phase` stays `forge-init` for the whole inner workflow, so the
  live granularity lives in the checkpoint (`forge-done`→reviewing,
  `fix-round-N`→building round N, `argus-approved`→reviewing). Both the HTTP GET
  surface AND the `work_board_changed` push (`open/composer.ts`) attach
  `run_progress` per bound item; the wire type is `AppWsRunProgress`
  (`channels/adapters/app-ws/envelope.ts`). The web Plan tab
  (`landing/chat-react/WorkBoardTab.tsx`) renders a compact sub-label ("🔨 building
  · round 1 · 4m", "🔍 reviewing · round 2", "✅ merged · PR #7") and shows a
  "⚠️ stalled Nm" warning past `STALLED_WARN_MS` (10 min). Intermediate
  checkpoints don't mutate the board row (no push), so the tab quietly re-polls
  every 15s while any run is live + ticks elapsed off the timestamps.
- **Per-agent hang watchdog (item 2).** `trident/orchestrator.ts` gains a
  `NO_ADVANCE_HANG_MS` (25 min) fail-fast reap: a non-terminal run with an
  in-flight dispatch whose `last_advanced_at` hasn't moved is treated as a
  suspected agent hang → `failed` with a named reason, checked BEFORE orphan
  recovery so a wedged orphan is reaped (not redispatched). A healthy build
  re-stamps `last_advanced_at` on every checkpoint, so it never trips. (25 min,
  not 15 — the only long no-checkpoint window is a single Forge/fix `agent()`
  step, which a large build can legitimately hold 15–20 min; 25 clears that while
  still catching the 30+ min silent wedge far faster than the 2h ceiling. Codex
  review [P1].) The 2h
  `max_inflight_ms` ceiling stays as a defense-in-depth backstop. The reaped
  `failed` transition flows through the existing `on_terminal` hook → terminal
  notification + board reconcile (item back to `upcoming`, fork glyph dark). Only
  the OUTER detector ships — the deeper per-`agent()` inactivity guard isn't
  cleanly reachable from the Workflow `.mjs` without destabilizing #173's routing
  (there's no exposed token-activity stream to the script), so it's deferred.
- **X cancels the linked run (item 3).** `gateway/http/work-board-surface.ts`
  `DELETE` takes an optional `trident_runs` accessor; if the item names a
  non-terminal `linked_run_id` it stops the run (`phase='stopped'`, the existing
  `/code stop` path) BEFORE deleting the card, so a delete can't orphan a running
  build. The detached workflow keeps running to completion in the background but
  produces no effect (terminal runs are never harvested → never merged/delivered).
- **Confirm dialog before X (item 4).** The Plan tab shows a lightweight confirm
  dialog before any `DELETE` fires — "Cancel this build and remove it?" for a
  running/linked item, the lighter "Remove this item?" for an idle one.

**Managed-doc note.** `docs/SYSTEM-OVERVIEW.md` (a Managed doc the orchestrator
syncs on deploy) got a Work-Board section note covering the progress display,
hang watchdog, and X-cancel; flag for the deploy-time sync.

**Tests.** `trident/run-progress.test.ts` (phase/checkpoint→label, stall,
cross-project guard); `orchestrator.test.ts` hang-watchdog cases (in-flight +
stale-orphan reap); `work-board-surface.test.ts` GET-enriches + DELETE-cancels
(+ terminal/unbound no-cancel); `work-board-client.test.ts` `parseRunProgress`;
`work-board-tab.test.tsx` sub-label render, stalled/merged labels, confirm-copy,
and the delete round-trip updated to click through the confirm. tsc clean
(root + chat-react), full relevant suite green.

## 2026-07-02 — Fable-orchestrator model routing in trident's inner workflow

**Why.** Ryan-locked doctrine (SPEC § Fable-orchestrator, Decisions Log
2026-07-02): Fable 5 (max reasoning) is the ORCHESTRATOR — it does the high-value
thinking (planning, decomposition, verdict synthesis); Opus/Sonnet are
SUBORDINATE EXECUTORS carrying out Fable's specs. There is NO "escalate to Opus".
Before this change every `agent()` in `trident/inner-workflow.mjs` inherited the
launcher-default `opus` and the Ralph planner was FUSED into `forge:build`. No
feature flags — this is the default.

**What shipped.**

- **`FABLE_MODEL = 'claude-fable-5'`** added to `runtime/models.ts` (the single
  source of truth; env override `NEUTRON_FABLE_MODEL`). Verified routable
  2026-07-02 (P-F0 smoke: a workflow `agent({model:'claude-fable-5',
  effort:'max'})` returns cleanly; `workflowProgress.model === 'claude-fable-5'`).

- **Split the fused planner out** (`inner-workflow.mjs`). A dedicated
  `plan:fable` orchestrator `agent()` (Fable, effort `max`) now runs once per
  Ralph iteration: it diffs SPEC.md vs the code, regenerates the
  IMPLEMENTATION_PLAN.md body, picks the single top task, and emits a structured
  EXECUTION SPEC (target files + acceptance criterion + test plan) plus a
  `[mechanical]|[reasoning]` complexity tag (`PLAN_SCHEMA`). `forge:build` is now
  a pure EXECUTOR that implements that one task from the spec and persists the
  plan into its worktree (the planner is read-only — a workflow's agents have
  separate cwds, so a base-branch write would never reach the PR).

- **Per-role `label → {model, effort}` map** (`ROLE_MODEL` + `modelForTag` +
  `routeModel` + `withModel`) threaded into every `agent()` opts: `plan:fable` +
  `argus:synthesis` → Fable; `forge:build`/`forge:fix-round-N` → Sonnet for
  `[mechanical]` / Opus for `[reasoning]` (bias to Opus when the tag is
  missing/ambiguous — the unknown-label default is an Opus executor, never
  Fable); `argus:claude`/`argus:adversarial` → Opus; `argus:codex` → unchanged
  (codex runtime); `checkpoint:*`/`terminal-result`/`cleanup:worktree` → fast
  (Haiku). The model IDS are resolved from `runtime/models.ts` in the launcher
  (`buildWorkflowArgs`) and threaded via `args.models` — the CC Dynamic Workflow
  script has no module resolution, so it can't import the registry and must NOT
  hard-pin an id literal.

- **Observability.** Every spawn logs `trident.agent label=<x> model=<y>
  effort=<z>` (incl. `model=codex-runtime` for the codex peer) so a run is
  tally-able: "N agents, M on Fable, K on Opus, J on Sonnet, C on Codex".

- **Test guards rewritten** (`vajra-fixes.test.ts` FIX 8 + `inner-workflow.test.ts`
  ralph-note): the 2026-06-13 export-control guard (`src` must never contain
  "fable") is REVERSED — replaced by positive assertions of the intended routing
  (plan:fable + argus:synthesis → `MODELS.fable`; forge:* by tag; argus reviewers
  → `MODELS.opus`; unknown → Opus default) + a no-hard-pinned-literal guard
  (`claude-fable-5`/`claude-opus-4-8`/`claude-sonnet-4-6` absent from the .mjs).

**Verification.** P-F0 smoke (fable routes end-to-end) + a real-substrate routing
probe exercising the byte-identical routing map across all 9 roles; the
authoritative harness dispatch record (`workflowProgress[].model`) confirmed:
plan:fable→claude-fable-5, forge[mechanical]→claude-sonnet-4-6,
forge[reasoning]→claude-opus-4-8, argus:claude/adversarial→claude-opus-4-8,
argus:synthesis→claude-fable-5, checkpoint/terminal/cleanup→claude-haiku-4-5.
Tally: Fable×2, Opus×3, Sonnet×1, Haiku×3. tsc clean; 336 trident tests green.
A full end-to-end Forge/Argus build was NOT run from the fleet session (the
`Workflow` tool inherits the session cwd, so `isolation:'worktree'` would branch
neutron, not an external scratch repo); the outer loop exercises it on deploy.

**Note.** `docs/SYSTEM-OVERVIEW.md` in the Managed repo needs a model-routing
update for the trident section — cannot be edited from here; the orchestrator
syncs it on deploy. Auto-mode (#104) is OUT OF SCOPE (separate).

## 2026-07-01 — Documents tab renders `.html` docs as static styled HTML/CSS pages

**Why.** Ryan's M1 live test: saving/opening an `.html` doc errored with
`invalid_extension: path must end with .md or .markdown (got 'timer.html')`, and
even once accepted the Documents tab had no way to render it. Ryan's revised
(deliberately small) scope: render HTML/CSS statically; complex interactive JS
apps belong in a separate app launcher, NOT the doc viewer. No feature flags —
shipped as the default.

**What shipped.**

- **Docs store/API accepts `.html`/`.htm` end-to-end.** `gateway/http/doc-store.ts`
  gains `HTML_EXTENSIONS` + `DOC_EXTENSIONS` (= markdown ∪ html) + `isDocLeaf`, the
  single allowlist behind the `invalid_extension` gate. Both the tree walker
  (surfaces `.html` leaves) and `validateRelativePath({ requireMd })` (read/list/
  open/write) now use `isDocLeaf`; the error message is derived from the allowlist.
  The duplicate history/comments/diff gate in `gateway/http/app-docs-surface.ts`
  (`assertHistoryPath`) shares `isDocLeaf` so an opened `.html` doc can also load
  its history/comments. `MARKDOWN_EXTENSIONS`/`isMarkdownLeaf` are retained
  (markdown-specific callers unaffected); `doc-search/walk.ts` keeps its own
  markdown-only constant (HTML is not FTS-indexed as markdown — out of scope).
- **Documents renderer renders `.html` as a static styled page.** New
  `landing/chat-react/HtmlDoc.tsx`: `isHtmlDoc(path)` selects the branch and
  `sanitizeHtmlDoc(raw)` parses the doc via `DOMParser` and strips every
  script-execution vector — `<script>` (incl. SVG script),
  `<iframe>`/`<object>`/`<embed>`/`<base>`/`<meta>`/`<link>`/`<frame*>`/`<applet>`,
  all `on*` handler attributes, and `javascript:`/`vbscript:`/`data:text/html`
  URLs — while PRESERVING HTML structure, `<style>` blocks (head + body), and
  inline `style`. The sanitized document's **live `<documentElement>` nodes are
  adopted** into a **Shadow-DOM island** (not an `innerHTML` string — fragment
  parsing strips `<html>`/`<body>`, which would drop `body{…}`/`html{…}` CSS +
  body attributes; Codex P2), so document-level CSS renders correctly and the
  doc's styles stay scoped to their subtree. `importNode`/`appendChild` never
  run the (already-removed) scripts. `DocumentsTab`
  Rendered view branches on `isHtmlDoc(file.path)`; `.md` renders via the existing
  Markdown path unchanged, and Source/Edit still show/edit raw text of either.
  **Design note:** chose a `DOMParser` DOM-walk sanitizer over DOMPurify because
  DOMPurify's document-reconstruction path does not run faithfully under the
  happy-dom test env (verified: it kept `<script>` and dropped `<style>`), which
  would leave the security path untested; the DOM-walk is faithful in both the
  browser and CI. Threat model is trusted single-owner content.

**Tests.** `landing/chat-react/__tests__/html-doc.test.tsx` (sanitize keeps
structure+CSS, strips scripts/handlers/js-URLs incl. an obfuscated `java\tscript:`;
component mounts into a shadow root and no doc script executes) + `.html`/`.htm`
read/list/write round-trip and `.txt`-still-rejected in
`gateway/__tests__/app-docs-surface.test.ts`. tsc (root + gateway +
`landing/chat-react`) clean; leak-gate silent; fresh `NEUTRON_HOME=/tmp/wfi`
boot on :7874 serves the bundle with the `HtmlDoc` renderer and the docs routes
wired.
## 2026-07-02 — Chat typing dots persist for the WHOLE processing window (incl. background builds)

**Why.** Ryan live-test 2026-07-01: he asked the agent to build a meditation-timer
app. Chat showed the cold-start ack ("⏳ Waking up, one moment…") then NOTHING,
while the Plan tab flashed its active-work dot — so he had no signal the agent was
still working. The typing indicator vanished the instant the ack turn settled even
though the real (long/background) build kept running. No feature flags.

**Root cause.** The chat `TypingIndicator` (`landing/chat-react/ChatApp.tsx`) rendered
ONLY on `vm.awaitingFirstToken` (`= awaitingReply && no live stream`). `awaitingReply`
clears on the first token / `agent_message` / `agent_typing end` — i.e. when the ack
turn settles — so the dots disappeared while a dispatched build continued. The
build's progress WAS surfaced to the client (the `work_board_changed` frame that
drives the Plan-tab flashing dot) but that frame was handled out-of-band of the chat
view model, so the chat never reacted to it.

**What shipped.** The typing indicator now uses the standard animated dots (unchanged
appearance) and stays visible for the full processing window: `awaitingFirstToken`
**OR** `hasActiveWork`.

- **New `ChatViewModel.hasActiveWork`** (`landing/chat-react/controller.ts`) — true
  while the active project's Work Board has an `in_progress` item. Derived from a
  dedicated `activeWorkBoardItems` cache that ONLY frames pertaining to the active
  project update (matching `project_id`, or absent → "this project"); a sibling
  project's board on the per-user app-ws topic is ignored so it can't stop the active
  dots (Codex P2). `lastWorkBoard` stays the raw last-frame cache for `WorkBoardTab`
  replay; the active cache clears on project switch.
- **`work_board_changed` now also `publish()`es the chat vm** (was board-tab-only), so
  a build starting/finishing flips the dots on/off. Everything else about the board
  stays out-of-band of chat state.
- **The gate** (`ChatApp.tsx`) is now `vm.awaitingFirstToken || vm.hasActiveWork`.
- **No false-positive at load:** the server pushes `work_board_changed` only on a
  mutation, never on connect, so `lastWorkBoard` is null until work actually happens
  this session — a lingering item from a prior session can't spin the dots on open. A
  trivial quick turn (no board mutation) behaves exactly as before. Dots stop the
  moment the item flips to `done`.

**Tests.** `controller.test.ts` — `hasActiveWork` true on `in_progress`, clears on
`done`, ignores a foreign-project board (updated the "does NOT touch chat vm" test:
board frames now republish so `hasActiveWork` can update; chat MESSAGES stay
untouched). `component.test.tsx` — full render E2E: dots stay through a background
build after the ack `agent_message`, then stop when the board item completes.

**SYSTEM-OVERVIEW.md:** none (behavior fix reusing the existing `work_board_changed`
frame — no new surface or client subscription).

## 2026-07-02 — Connect Codex is a GLOBAL admin credential (was per-project) + project override

**Why.** #167 (Part B) put the Connect-Codex UI only in the per-PROJECT Settings
tab, calling `.connect(projectId, …)`, which made it read as a project-level
setting. But Codex is the **trident cross-model reviewer credential, and trident
runs across ANY project** — so it must be a **GLOBAL** setting in the General
admin UI, not per-project (Ryan, 2026-07-02: "this is not a project-level
setting… it should be a global setting, in the general admin UI. There can be a
project-level override if necessary"). No feature flags.

**What shipped.**

- **Global connect is now the PRIMARY surface.** A new account-wide route
  `GET/POST/DELETE /api/app/codex-auth` (`gateway/http/codex-credential-surface.ts`)
  connects Codex at `scope='global'`. The **General → Admin** tab
  (`landing/chat-react/IntegrationsTab.tsx`) renders a "Codex cross-model review"
  section — paste `~/.codex/auth.json`, connection status, disconnect — alongside
  the other global integrations. `codex-credential-client.ts` gained
  `statusGlobal()` / `connectGlobal()` / `disconnectGlobal()`.
- **Store defaults to GLOBAL.** `CodexCredentialService.connect()` now defaults to
  `scope='global'` (materializes to the owner CODEX_HOME `<owner_home>/.codex`);
  validation unchanged (subscription-only, metered `OPENAI_API_KEY` rejected).
- **Per-project OVERRIDE kept, for the edge case.** The per-project Settings
  section stays but is relabelled "Codex review — project override" (clearly
  optional; the primary connect lives in General → Admin). It POSTs the existing
  `/api/app/projects/<id>/codex-auth` route, which now stores `scope='project'`
  under the REAL project id and materializes to a nested
  `codexProjectHome()` = `<owner_home>/.codex/projects/<id>` dir.
- **Resolution honors project → global → unset.** New
  `CodexCredentialService.resolveActiveCodexHome(owner, project_id)` resolves the
  effective CODEX_HOME via the #149 store resolver (project override wins, else
  global, else `null`) with self-healing re-materialization. `status()` reports the
  resolving `scope`. The trident loop threads the GLOBAL CODEX_HOME (the
  trident-wide default); the `codex_connect`/`codex_status` agent tools stay
  global-scoped (the tool context carries only the owner boundary).

**Spec-conformance (5-line diff).** SPEC§ codex-review global cred / CURRENT #167
per-project only / GAP: not global, wrong default / THIS PR: global connect in
General admin + project-override + resolver project→global / OUT-OF-SCOPE: none.

**Files.** `trident/codex-auth.ts` (`codexProjectHome` helper),
`trident/codex-credential.ts` (scope-aware connect/status/disconnect +
`resolveActiveCodexHome`), `gateway/http/codex-credential-surface.ts` (global
route + project override), `gateway/http/compose.ts` (comment),
`open/composer.ts` (comment), `landing/chat-react/IntegrationsTab.tsx` (global
UI), `landing/chat-react/SettingsTab.tsx` (override relabel),
`landing/chat-react/codex-credential-client.ts` (global methods + `scope`). Tests:
service override/resolver, surface global+override routes, client global methods,
IntegrationsTab global-connect render. tsc clean (trident/root/chat-react),
leak-gate SILENT; live boot confirms both routes mounted + auth-gated.

**Verify.** Real-component integration tests exercise connect(global) →
materialize → `codex-review.sh` exit-0 CONNECTED; override stored under the
project home; `resolveActiveCodexHome` project→global→unset; override wins;
removing an override falls back to global; `ensureMaterialized` ignores overrides.
Live server (`NEUTRON_HOME=/tmp/wfcx PORT=7871 bun run open/server.ts`) boots
clean and both `/api/app/codex-auth` + `/api/app/projects/<id>/codex-auth` return
401 (mounted + auth-gated), not 404.

**Codex cross-model review — addressed.**
- **[P1] review resolves through the store resolver (not a static path).** The
  trident orchestrator gained `resolve_codex_home?: (run) => string | null`
  (preferred over the static `codex_home`); the composer wires it to
  `CodexCredentialService.resolveActiveCodexHome(run.project_slug)` so the inner
  review's CODEX_HOME is resolved per-run through the #149 resolver (project
  override → global → unset, self-healing) rather than a raw dir. **Known
  constraint:** trident runs are instance-scoped by `project_slug` (no per-project
  id on a run — see `trident/store.ts` `TridentRun`), so a run resolves the GLOBAL
  default; a per-project override cannot select a different cred *per trident run*
  until runs carry a project id (a larger, separate change). The override
  mechanism itself (store/resolver/status/UI) is fully implemented + tested.
- **[P2] a stale/expired project override is always removable.** `status()` now
  returns `override_present` (a project-scope row exists, even expired — the
  resolver skips expired rows so `scope` would report the global fallback). The
  Settings override section shows "Remove override" whenever `override_present`,
  so an expired override that masks itself behind the global default can still be
  cleaned up.
- **[P2] Settings reflects the EFFECTIVE status after save/remove.** Both
  `connectCodex` and `disconnectCodex` now re-fetch the per-project status after
  their write (the POST/DELETE replies omit `override_present` / the global
  fallback), so the "Remove override" affordance appears right after saving and a
  removed override immediately shows the global fallback (not a hard
  "not connected").

**DECISION FOR RYAN — per-project override does NOT reach a trident RUN (by
design of trident, not this PR).** Trident runs are **instance-scoped by
`project_slug`** (the owner boundary) and carry **no per-project credential id**
(`trident/store.ts` `TridentRun`; runs are created with `project_slug` = owner,
`slug` = task slug). So `resolveActiveCodexHome(run.project_slug)` resolves the
GLOBAL default, and a per-project codex override — whose only consumer is the
instance-scoped trident reviewer — cannot change which credential a given trident
run uses. The override is fully built + tested at the store/resolver/status/UI
layer (it honors project → global → unset wherever a real project id is supplied),
the Settings copy is explicit that the trident review currently uses the global
credential, and the override takes effect for trident once builds are
project-scoped (a separate change: thread the originating project id onto the run
+ resolve with it). Ryan asked for a project override "if necessary" — flagging
that for trident specifically it is a stored preference, not yet a per-run switch.
Codex cross-model review re-raised this as the remaining item; it is an
acknowledged trident-architecture constraint, not a defect in this diff.
## 2026-07-02 — SEV1 chat project-switch: fresh per-conversation assistant-ui runtime (seamless switch, no error card, no flicker)

**Why.** M1 top-priority (Ryan, frustrated): switching projects (or cold-loading
one) frequently tripped the #162 error boundary ("This conversation hit a snag /
Try again"), and "Try again" fixed it — a transient render race, not a real
failure. Ryan: "an annoying useless error message is just as bad as a black
screen. fix the underlying problem. This should be seamless." Same root also
caused the tab-bar / input-box flicker on switch. No feature flags. The #162
keyed error boundary was NOT the fix — it only *caught* the throw; the goal was
to eliminate the underlying race so it essentially never fires.

**Root cause (verified).** The assistant-ui message primitives resolve a part by
INDEX into the runtime's live message list (`@assistant-ui/react`
`useExternalStoreRuntime`; `useClientLookup` throws `Index N out of bounds
(length: 0)`). The runtime was a SINGLE stable instance created once at the root
(`main.tsx` `useNeutronChat` → `AssistantRuntimeProvider`). On a project switch,
`controller.setProject` (`landing/chat-react/controller.ts:439`) sets `this.msgs
= []` and publishes an EMPTY list; the ExternalStore adapter handed that emptied
list to the SAME retained runtime while a stale `MessagePart` from the outgoing
project still indexed a position into it → throw mid-render → #162 boundary
trips. #162's keyed *render subtree* remount reduced but did not eliminate the
one-frame race because the RUNTIME itself was never reset per conversation — the
shared runtime shrank in place with old subscribers still attached.

**What shipped.**

- **Per-conversation runtime (root-cause fix).** Split
  `landing/chat-react/useNeutronChat.ts` into `useNeutronChatVm` (vm mirror +
  controller lifecycle — stable across the session, keyed on the controller) and
  `useChatRuntime` (builds the `ExternalStoreRuntime` from the current vm). A new
  `ConversationRuntimeHost` in `ChatApp.tsx` calls `useChatRuntime` and is mounted
  with `key={convId}` (`conversationIdOf(projectId)`), so every conversation gets
  its OWN runtime. On a switch the outgoing runtime is discarded WHOLE — never
  shrunk in place — and the incoming one starts from the already-scoped (empty →
  hydrating) list, so no part ever indexes a stale position. The provider moved
  OFF the root (`main.tsx` now renders `ProjectShell` directly with a
  `useNeutronChatVm` vm) and DOWN to wrap only the chat surface (thread +
  composer), so the TabBar + project rail above it stay mounted.
- **Atomic transition.** A genuinely empty project renders assistant-ui's
  `ThreadPrimitive.Empty` ("Send a message to begin."), never an index into `[]`.
- **Tab-bar flicker fix.** `ProjectShell.tsx` tab-resolution effect no longer
  collapses `tabs` to `[CHAT_TAB]` on every switch before re-fetching (a visible
  two-step flicker). It reconciles IN PLACE: keep the current descriptors mounted
  until the new set resolves, mark the scope in-flight (`tabsScope = null`, which
  the doc-link resolver keys off), and swap in one step — the always-present Chat
  tab (stable key) never remounts. While the fetch is in flight the still-mounted
  descriptors belong to the OUTGOING scope, so every non-Chat tab is DISABLED and
  the active tab is clamped to Chat (Codex P2): a stale button can't be clicked to
  mount a wrong-scope `TabContent` (e.g. the old project's Core iframe) mid-switch.
- **Safety net kept.** The #162 `ChatErrorBoundary` stays as a last-resort catch
  (not removed), but now essentially never fires on a normal switch/load.

**Tests.** `landing/chat-react/__tests__/chat-rail-stability.test.tsx` extended:
the laden-General → empty-project switch now also asserts the boundary card
("This conversation hit a snag") is ABSENT — proving the RUNTIME RESET prevented
the throw, not the boundary catching it. Added a rapid-switch stress test
(General → alpha → beta → empty → General → … 8 hops) asserting no index throw,
no boundary, clean empty state, and no stale-content bleed. Harnesses mirror
production wiring (no external `AssistantRuntimeProvider`; `ChatApp` self-owns the
runtime). Full `landing/chat-react` suite: 231 pass / 0 fail; `tsc -p
landing/chat-react/tsconfig.json` clean; browser bundle + live iso server
(`/chat`, lazy `/chat-react.js`) build and serve cleanly.

## 2026-07-01 — trident-parity Part B: Connect Codex (subscription auth) + agent auto-invokes trident

**Why.** Part A (#165) wired the trident cross-model reviewer (`codex-review.sh`
reads a per-owner `CODEX_HOME/auth.json`) but nothing let the owner CONNECT that
credential, and the live agent still built everything inline (no `/code`
self-routing). SPEC.md Decisions Log 2026-07-01 "Codex cross-model review
REQUIRED". No feature flags.

**What shipped.**

- **M-2 — Connect Codex (subscription auth via the admin panel).**
  `trident/codex-auth.ts` validates a pasted `~/.codex/auth.json`: SUBSCRIPTION
  auth (`tokens.access_token` + `tokens.refresh_token`) is accepted + normalized;
  a metered `OPENAI_API_KEY` (auth_mode=apikey) or a bare `sk-…` paste is REJECTED
  (never the metered path). `trident/codex-credential.ts:CodexCredentialService`
  stores it encrypted in the #149 `project_credentials` store (service `codex`,
  global scope) and MATERIALIZES it to the per-owner CODEX_HOME
  (`resolveCodexHome({ owner_home })` = `<owner_home>/.codex/auth.json`, 0600) —
  the SAME path the trident loop threads into the inner workflow
  (`build-core-modules.ts` now reads `trident.codex_home` from the composer, so
  the loop + the store can never disagree; falls back to `NEUTRON_CODEX_HOME`).
  Status = connected / expired (access-token JWT `exp` past) / not_connected.
  Surfaces: admin-panel HTTP `gateway/http/codex-credential-surface.ts`
  (`/api/app/projects/<id>/codex-auth`), the SettingsTab "Codex cross-model
  review" section (`landing/chat-react/SettingsTab.tsx` +
  `codex-credential-client.ts`), and agent-native `codex_connect` / `codex_status`
  tools (`trident/codex-credential-tool.ts`). A boot-time `ensureMaterialized`
  self-heals the on-disk file from the stored credential.
- **M-K — the agent auto-invokes trident for complex builds.** A build-routing
  complexity heuristic in the operating-doctrine fragment
  (`gateway/wiring/operating-doctrine.ts:BUILD_ROUTING_DOCTRINE`,
  spliced every turn) + the `work_board_dispatch_build` tool description tell the
  live agent to self-route: SIMPLE → inline (Write/Edit); COMPLEX/multi-file/
  needs-review → `work_board_add` + `work_board_dispatch_build`, telling the owner
  why. The tool was already registered on the live agent's surface (verified by
  the prod-boot wiring test); no `/code` command, no feature flag.

**Tests.** `trident/codex-auth.test.ts`, `trident/codex-credential.test.ts` (incl.
connect → `codex-review.sh` sees exit-0 CONNECTED with a mock codex),
`trident/codex-credential-tool.test.ts`, `gateway/http/codex-credential-surface.test.ts`,
`landing/chat-react/__tests__/codex-credential-client.test.ts`, doctrine +
prod-boot-wiring assertions. tsc (root+trident+landing) clean, leak-gate silent.

## 2026-07-01 — SEV1 M1: gate projects on import completion + honest no-context projects + doc frontmatter strip

**Why.** Ryan's M1 live test hit four related onboarding defects (SPEC.md
Decisions Log 2026-07-01 "STOP M2" blockers a+b): (a) onboarding created projects
from thin chat answers WHILE the ChatGPT/Claude history import was still uploading
(e.g. at 31%), so projects were born from the wrong signal; (b) a no-context
project opened with a fabricated "here's where X stands ... active, P2" summary;
(c) its seeded `STATUS.md` even scheduled phantom "Deepen + analyze from imported
context" OVERNIGHT work (`autonomous_overnight_enabled:true`) for a project with
zero data; (d) the Documents tab rendered a doc's YAML frontmatter as a raw bold
blob. Single path, no feature flags (Ryan approved).

**What shipped.**

- **Import-gate on project creation (fix 1).** `probeInFlightImport`
  (`open/composer.ts`) now also detects an in-progress **chunked upload**
  (`upload_sessions.status='uploading'`, non-expired), not just a live
  `import_jobs` row — closing the window where a turn that settled the last
  required field mid-upload finalized BEFORE the import job existed. The post-turn
  extractor (`onboarding/interview/post-turn-extractor.ts`) drops the
  project-discovery fields (`primary_projects`, `non_work_interests`,
  `dropped_projects`) from its `phase_state` write while an import is in flight
  (import-independent `user_first_name`/`agent_personality` still land). A new
  per-turn `<import_in_flight>` preamble fragment
  (`onboarding/interview/onboarding-preamble.ts` `buildImportInFlightSteerFragment`)
  steers the live agent to skip project questions during the upload.
  `finalizeImportOnboardingIfReady` also blocks `import_upload_pending`.
- **Honest no-context opening (fix 2).** The materializer computes `has_context`
  (matched slices OR `hasRealProjectContext`); `emitProjectOpenings`
  (`gateway/wiring/build-onboarding-finalize.ts`) routes a no-context
  WORK project to `buildNoContextProjectOpening` ("I don't have any context on X
  yet - tell me a bit about it, and what do you want to work on first?") instead
  of the fabricated status. Projects WITH context (and thin hobbies, via the
  kickoff's engaging questions) are unchanged.
- **Minimal no-context STATUS.md (fix 3).** `renderMinimalStatusMd`
  (`onboarding/wow-moment/project-materializer.ts`) writes clean frontmatter
  (`one_liner:""`) + one line "Created during onboarding - no context yet." with
  NO overnight opt-in, NO `## Autonomous Overnight Work` section, NO seeded task,
  and NO `docs/overnight/seed-context.md`. Context-bearing projects keep the full
  STATUS + overnight machinery.
- **Documents frontmatter strip (fix 4).** `Markdown.tsx` gains
  `stripLeadingFrontmatter` + a `stripFrontmatter` prop the Documents viewer
  (`DocumentsTab.tsx`, rendered view) passes; the leading `---\n…\n---` fence is
  hidden from the rendered body. Chat + the Source view are untouched; a bare
  `---` rule is never stripped.

**Tests.** Extractor import-gate (suppress project fields while import in flight,
persist personality; gate off with no import); minimal-vs-full STATUS.md +
`has_context`; honest-vs-real opening routing in finalize; `buildNoContext
ProjectOpening` copy; `stripLeadingFrontmatter` (fence removed, body kept, bare
rule + no-frontmatter untouched, CRLF). tsc clean, leak-gate silent, server boots
clean on a fresh QUIET install (port 7869).
## 2026-07-01 — Chat turn timeout is ACTIVITY-BASED; freezes auto-retry + get a Retry button

**Why.** Ryan live-test 2026-07-01 (frustrated): a chat turn running a long-but-active
build hard-failed at a FIXED 180s wall clock **while the agent was still working**
(`turn_failed elapsed_ms=180009 err=persistent-repl: turn timeout`), then showed a
dead-end "your AI connection may need attention in settings" message — misdiagnosing
a slow turn as a credential problem. "If the agent is still working why arbitrarily
timeout at 180s? Be smarter — look for activity, if it's not frozen keep waiting."

**What shipped (no feature flags).**
- **Inactivity watchdog replaces the fixed per-turn wall clock.**
  `runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts` no longer
  arms `setTimeout(perTurnTimeoutMs)`; it runs an interval watchdog that abandons a
  turn ONLY after `turn_timeout_ms` with NO PTY activity. `session.lastDataAt`
  advances on every byte the `claude` child writes (spinner ticks, streamed tokens,
  tool output — the `onData` handler), so an actively-working turn keeps resetting
  the idle clock and runs as long as it needs; only a genuinely frozen turn trips.
  New `DEFAULT_TURN_INACTIVITY_MS` (90s) + `DEFAULT_TURN_ABSOLUTE_CEILING_MS` (45min
  hard backstop). The liveness keepalive pushes `status` but does NOT touch
  `lastDataAt`, so an alive-but-frozen child is still detected as frozen.
- **`AgentSpec.turn_timeout_ms` repurposed** from "wall-clock budget" to "inactivity
  window"; new additive `AgentSpec.turn_absolute_ceiling_ms` (`runtime/substrate.ts`).
  The composer (`gateway/wiring/build-live-agent-turn.ts`) sends a snappy
  90s idle window for warm turns and a larger 180s window for cold/onboarding turns;
  its own AbortController is now a pure 45min absolute-ceiling backstop that covers
  the cold-SPAWN phase (which runs before the substrate watchdog starts) — the cold
  path's generous window folded into the same scheme, `COLD_TURN_TIMEOUT_MS` deleted.
- **Auto-retry once + honest message + one-click Retry.** On a genuine freeze the
  composer auto-retries the turn once, silently (the substrate poisons+respawns the
  warm REPL, so the retry lands clean). If the retry also freezes, the user gets
  `TIMEOUT_BODY` ("took too long … tap Retry, or just send it again") + a persisted
  Retry button (`RETRY_TURN_VALUE`), `allow_freeform` open — NEVER the misleading
  credential text. A Retry tap re-runs on the last real user message for the topic
  (`lastUserText` in-process map; VALUE_BYTE_CAP is 37 bytes so the message can't
  ride the button value). `isFreezeTimeout` distinguishes a freeze from a real
  credential/connection fault, which keeps its own actionable `FAILURE_BODY`.

**Tests.** `persistent-repl-substrate.test.ts` — activity resets keep an active turn
alive past the idle window; a frozen turn trips at the idle window; the absolute
ceiling bounds a livelocked-but-active turn. `build-live-agent-turn-timeout-retry.test.ts`
— freeze → auto-retry (success → no bubble); retry-also-freezes → TIMEOUT_BODY + Retry
button, not the connection text; non-freeze fault → FAILURE_BODY, no retry; Retry tap
recovers + re-runs the last message; seed freeze stays silent.
`build-live-agent-turn-onboarding-scope-timeout.test.ts` — updated to the new
inactivity/ceiling spec fields.

**Files.** `runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts`,
`runtime/substrate.ts`, `gateway/wiring/build-live-agent-turn.ts`,
`docs/SYSTEM-OVERVIEW.md`, + the three test files above.

## 2026-07-01 — Notes / second-brain core: REMOVED entirely

**Why.** The `notes` core (`cores/free/notes`, `@neutronai/notes`) was a
second-brain port — a per-project `notes.db` sidecar + eight `notes_*` MCP tools +
the `/note` chat command. It is made redundant by the second-brain→GBrain
rip-replace: **GBrain is now the SOLE per-owner memory store.** The notes core
was silently broken until #158 wired its tools; Ryan directed "rip it out. we
dont need notes core" (SPEC.md Decisions Log 2026-07-01). No dual path, no flag,
no leftover.

**What shipped (clean deletion).**

- **Deleted the whole `cores/free/notes/` package** (source, tests, manifest,
  UI surfaces, the per-Core migration `0001_drawers_notes_kg.sql`) and the
  notes-only test `gateway/__tests__/notes-production-composer.test.ts`. Reverts
  the effect of #158.
- **Unwired from `gateway/cores/mount-open-cores.ts`:** the `@neutronai/notes`
  import (was `:75`), the `NotesStoreResolver` construction (was `:248-250`), the
  `notesResolver`/`notesDefaultProjectId` args into `buildCoresBackendFactories`
  (was `:289-290`), and `createNotesChatCommandFilter` from the
  `buildChainedChatCommandFilter([...])` chain (was `:332`). The `/note` chat
  command no longer exists.
- **`gateway/boot-helpers.ts`:** dropped the `notesResolver` + `notesDefaultProjectId`
  interface params + destructuring and the entire `notes:` backend factory from
  `buildCoresBackendFactories`.
- **Notes drawer-browser HTTP surface** (dead plumbing only the deleted test ever
  supplied): removed `NotesDrawerBrowserHandler` + `notesDrawerBrowser` from
  `gateway/http/compose.ts`, `notes_drawer_browser_surface` from
  `gateway/composition/input/cores-input.ts` + `gateway/composition.ts`.
- **Launcher seed:** dropped the 🧠 "Notes" tile from `DEFAULT_LAUNCHER_SEED` +
  `SLUG_DISPLAY_DEFAULTS` in `gateway/http/project-launcher-store.ts`; deleted the
  orphan placeholder route `app/app/projects/[id]/notes.tsx`.
- **Dependency:** removed `cores/free/notes` from root `package.json` workspaces
  and `@neutronai/notes` from `gateway/package.json`; regenerated `bun.lock`.
- **Tests:** decremented the discovered/installed core-count sets by 1 in
  `cores-composition.test.ts` (10→9 discovered / 8→7 installed incl. paid-staging;
  the neutron-open carve boots discovered=9 installed=6) and `cores-surface.test.ts`;
  swapped the notes fixtures in `cores-tool-dispatch.test.ts`,
  `launcher-production-composer.test.ts`, `app-tabs-surface.test.ts`,
  `app-launcher-surface.test.ts`, `project-launcher-seed.test.ts`,
  `tabs/__tests__/registry.test.ts`, and the `mount-open-cores` `/note` assertion
  to surviving cores (`reminders_core` / `calendar_core` / `tasks_core`).

**Migrations (safe).** The notes core's sole migration was a **per-Core** bundled
migration inside the package (applied to a per-Core namespace DB at install), NOT
a central `migrations/` entry — the central runner ledger (0001–0096) never
referenced it, so its snapshot/runner tests stay green. It is removed with the
package. On any already-deployed DB the old `notes.*` tables are harmless orphans
(nothing in the runtime reads them). No forward drop migration was added (cheapest,
safe — the task defaulted to leaving orphan tables).

**Verify.** `tsc --noEmit` clean; the four core/launcher composition suites pass
(29/29), the four surface/tab suites pass (55/55). Fresh QUIET install boot
(`NEUTRON_HOME=/tmp/wfnotesrm bun run open/server.ts`) logs **no `core=notes` line
at all** (gone from discovery, not install_ok/failed) and `project=dev
discovered=9 installed=6 failed=3` — discovered dropped by exactly 1; no `/note`
command registered; the GBrain memory path is unaffected.

## 2026-07-01 — Chat: fix one-line message bubble rendering ~2x tall

**Why.** Ryan flagged (twice) that a single-line chat message bubble — e.g. the
one-word user message "Ryan" — rendered at roughly double the height its text
needs, top/bottom heavy. #141 reduced `.car-bubble` vertical padding (8px→5px)
and `.car-md p` line-height (1.5→1.4) but did NOT fix it, proving padding was not
the (only) cause.

**Root cause.** The USER bubble renders its body as a bare `<p class="car-text">`
(`landing/chat-react/ChatApp.tsx` `TextPart`, role=user), but **no `.car-text`
CSS rule existed** anywhere in `landing/chat-react.html` — the only global reset
is `* { box-sizing: border-box }`. So that `<p>` inherited the UA default
`margin-block: 1em` (~16px top + 16px bottom), stacking on the 5px bubble padding
→ a one-line user bubble ~2x its text height. #141 only touched `.car-bubble` and
`.car-md p` (the AGENT path, whose paragraph margins are already zeroed by
`.car-md > :first-child/:last-child`), so it never reached the user `<p>` — which
is exactly why it missed Ryan's user-message evidence.

**What shipped.**

- **`landing/chat-react.html`.** New `.car-text { margin: 0; line-height: 1.4; }`
  rule — zeroes the inherited UA `<p>` margin and matches the agent paragraph
  line-height so a single-line user message hugs its text (bubble height = 5px +
  one line + 5px).
- **`landing/chat-react/message-adapter.ts`.** New `normalizeBody()` strips the
  stray leading newlines + all trailing whitespace from a message body in
  `toThreadMessage` (the single display seam for both bubble types). Both paths
  preserve newlines (`white-space: pre-line` on the user `<p>`, `pre-wrap` on
  `.car-bubble`), so a stray trailing `\n` on a one-line message would otherwise
  render as an extra empty line. Deliberately narrow (Codex P2): leading
  horizontal whitespace is PRESERVED so a Markdown agent message opening with an
  indented code block (`"    npm test"`) still renders as code; INTERNAL blank
  lines (real multi-line messages) are untouched.

**Tests.** `landing/chat-react/__tests__/message-adapter.test.ts` — trailing/
leading-newline strip on user + agent bodies, whitespace-only → empty, and a
`normalizeBody` unit block asserting internal blank lines survive. tsc (leaf
`landing/chat-react/tsconfig.json`) clean; leak-gate silent. Verified on a fresh
quiet boot: the served `/chat` HTML carries the new `.car-text` rule and the
lazily-bundled `chat-react.js` compiles the normalization in.

## 2026-07-01 — Notes Core: wire the four S1 tools (drawer/search/traverse) — ISSUE #330

**Why.** The `notes` manifest declares eight MCP tools, but the install pipeline
only ever invoked `buildTools` (the legacy four: `notes_write/recall/list/link`).
The four Notes-Core-S1 tools (`notes_create_drawer`, `notes_drawer_list`,
`notes_search`, `notes_traverse`) were fully implemented in `buildNotesMcpTools`
against a real per-project `NotesStore` backend — but the barrel never exported a
`buildExtraTools`, so on EVERY owner install those four fell through to
`not_implemented` stubs and boot logged `tool_registration_failed core=notes
code=manifest_tool_unimplemented` four times. NOT vestigial: the store, FTS
search, and KG traverse all exist and are tested; only the install-time wiring
was missing.

**What shipped.**

- **`cores/free/notes/src/mcp-tools.ts`.** New `buildExtraTools(deps)` — a thin
  factory over the existing `buildNotesMcpTools`, mirroring the Research/Calendar
  Core split. `NotesExtraToolDeps` = `{ manifest, project_slug, audit, resolver }`.
- **`cores/free/notes/index.ts`.** Barrel now exports `buildExtraTools` +
  `NotesExtraToolDeps` so `registerCoreTools` discovers the second factory.
- **`gateway/boot-helpers.ts`.** The `notes` backend factory now returns
  `{ backend, resolver }` (was `{ backend }` only). `normalizeBackend` returns the
  object verbatim because `backend` is present, so BOTH the legacy backend
  (consumed by `buildTools`) and the resolver (consumed by `buildExtraTools`) land
  in the one `deps` bundle both factories receive. The four S1 tools take an
  explicit `project_id` per call, so cross-project scope is impossible by
  construction.
- **`cores/free/notes/__tests__/mcp-tools.test.ts`** (new). Asserts
  `buildExtraTools` returns all four handlers, and exercises create_drawer →
  drawer_list, FTS search, KG traverse over a user tunnel, and per-project
  isolation.

**Verified.** Fresh QUIET owner boot (`NEUTRON_HOME=/tmp/wfnotes`): the four
`tool_registration_failed core=notes` lines are GONE; `install_ok core=notes`
stands with all eight tools dispatchable. `discovered=10 installed=7 failed=3` is
unchanged — notes was always `install_ok` (its legacy four registered fine); the
fix eliminates the four per-tool registration failures WITHIN that install. The
remaining `failed=3` are the expected OAuth-not-connected calendar/email/workspace
Cores. The benign `tasks_core tasks_pick_next extra_tool_name_collision` warning
is untouched (buildTools wins; harmless — Tasks intentionally registers that tool
in both factories). tsc clean (notes + gateway), notes suite 66→72 tests green.

## 2026-07-01 — Archived projects: reversible archive via Settings/chat + global Admin restore

**Why.** Projects had soft-delete only (`deleted_at`, migration 0053) — hidden
from every surface with no user-facing way back. The M2 cutover needs a
reversible "put this away for now": Ryan's 22 archived projects migrate as an
archive state that stays visible + restorable. This adds a first-class ARCHIVE
lifecycle distinct from delete (Ryan Q3, M2 Decisions Log).

**What shipped.**

- **Migration 0095 (`archived_at`).** A nullable ISO-8601 column on the STRICT
  `projects` table (plain `ALTER TABLE ADD COLUMN`, mirroring 0093/0094).
  `NULL` = active (in the rail); set = archived. Orthogonal to `deleted_at` —
  the rail + the archived list both additionally require `deleted_at IS NULL`, so
  a soft-delete always wins. `migrations/expected-schema.txt` regenerated;
  `runner.test.ts` asserts the column lands.
- **Store (`gateway/projects/sqlite-store.ts`).** `list()` (the rail) and
  `readRow()` (settings GET/PATCH) now filter `archived_at IS NULL` alongside
  `deleted_at`. New methods `archive` / `restore` (idempotent; a probe restricted
  to `deleted_at IS NULL` so a deleted project is never archived/restored) +
  `listArchived` (the Admin restorable list, newest-archived-first, emoji
  resolved). Mirrored on `InMemoryProjectSettingsStore`.
- **HTTP (`gateway/http/app-projects-surface.ts`).** `POST
  /api/app/projects/<id>/archive`, `POST .../restore`, and `GET
  /api/app/projects/archived` — all app-ws-bearer-gated. Archive/restore fan a
  `projects_changed` (via the existing `onRailFieldChanged`) so connected rails
  update live; unknown/deleted id → 404. The `/archived` route is an exact path,
  so it can never collide with a project whose id is literally "archived".
- **Settings tab (`landing/chat-react/SettingsTab.tsx`).** An "Archive project"
  action in the Project section with a two-step confirm; on success the project
  leaves the rail and the section shows the archived notice.
- **Admin tab (`landing/chat-react/IntegrationsTab.tsx`).** A new "Archived
  projects" section listing archived projects with a per-row **Restore** button
  (POSTs `/restore`, drops the row, rail picks it back up live).
- **Chat / agent-native (`cores/free/agent-settings`).** New `archive_project` /
  `restore_project` tools (capability-gated, Telegram-confirmed, topic closed on
  archive) so "archive this project" / "restore the Foo project" work in chat.
  `findLiveByName` + `list_projects` now exclude archived rows; a new
  `findArchivedByName` resolves the restore target. System-prompt fragment +
  manifest + TOOL_NAMES updated (nine → eleven tools).

**Tests.** Store archive/restore/listArchived + idempotency + soft-delete guard;
HTTP archive→hide→list-archived→restore round-trip + 404 + method guards; agent
tool archive/restore + list exclusion + honest-failure; React Settings archive
flow + Admin restore/empty-state; migration snapshot + column assertion.

## 2026-07-01 — Project rail redesign: per-project emoji, activity-reorder, unread badge

**Why.** The left project rail (`landing/chat-react` + the mobile `app/` project
list) was a flat list of plain text buttons in a fixed order with no signal of
which project had new activity. Ryan asked for a materially upgraded rail:
per-project emoji, most-recent-activity-first ordering (an active project pops to
the top), and a Telegram-style unread count badge — in BOTH the light + dark
themes from the #153 toggle, with NO feature flag.

**Framing.** ONE code path, theme-var-driven (no hardcoded colours), no flag.
Emoji + activity are real columns on the canonical `projects` table; unread is
computed HONESTLY from the existing chat-log read cursor (never a fabricated
badge).

**Schema (migrations 0093 + 0094).** Two nullable `TEXT` columns added to the
STRICT `projects` table via plain `ALTER TABLE ... ADD COLUMN` (mirrors 0088):
- `emoji` — the per-project rail glyph. NULL on legacy rows; the serve-time path
  resolves NULL to a deterministic default from the name, so the rail always
  shows a glyph. New rows persist a concrete default at create/materialize time.
- `last_activity_at` — ISO activity sort key; stamped at create (= created_at)
  and bumped to now on each message fan to the project's topic.
`migrations/runner.test.ts` applied-versions array + `expected-schema.txt`
snapshot regenerated.

**Default emoji (`gateway/projects/default-emoji.ts`, NEW).** Pure, deterministic
picker: a keyword table maps common project themes to a glyph (fitness→🏋️,
read→📚, code→💻, budget→💰, …); an un-keyworded name falls back to a stable
FNV-1a hash over a neutral palette. `resolveProjectEmoji(stored, name)` prefers an
explicit emoji, else the default. `normaliseEmojiInput` bounds + validates a
user-supplied emoji (short, non-ASCII). `GENERAL_EMOJI` (💬) for the General scope.

**Server.**
- `gateway/http/app-projects-surface.ts` — `ProjectSettings` gains `emoji`; the
  list rows gain `last_activity_at` + `unread_count` (new `ProjectListEntry`
  type); PATCH whitelist adds `emoji` with validation (`invalid_emoji`);
  `buildDefaultSettings` + the shared-item projection carry a default emoji.
- `gateway/projects/sqlite-store.ts` — `list()` orders by
  `COALESCE(last_activity_at, updated_at) DESC`, resolves emoji, and computes
  per-project `unread_count` = agent messages on the project topic
  (`app:<user>:<project>`) beyond the owner's highest READ receipt seq
  (`app_chat_messages` ⋈ `app_chat_receipts`; best-effort → 0). New
  `touchActivity(project_id)` stamps the activity key; emoji is written only when
  explicitly patched (so a name edit never freezes a resolved default).
- `open/composer.ts` — `readProjectRows()` (page bootstrap + `projects_changed`
  frame) now serializes `emoji` + `unread` + `last_activity_at`, ordered by
  activity; an agent reply on a PROJECT topic stamps `last_activity_at` and
  re-fans `projects_changed` so connected rails reorder + re-badge live.
- `channels/adapters/app-ws/envelope.ts` — `AppWsOutboundProjectsChanged` per-item
  shape extended with `emoji` / `unread` / `last_activity_at`.
- A settings PATCH that changes a RAIL-VISIBLE field (name or emoji) fans a fresh
  `projects_changed` via the surface's new `onRailFieldChanged` hook (bound to the
  composer's `emitProjectsChangedNow`), so the rail re-renders the glyph/label live
  with no reload — this also fixes the pre-existing "rename doesn't refresh the
  rail" staleness (Codex r1 P2).
- Materialize + create-project INSERTs (`onboarding/wow-moment/actions/
  03-project-shells.ts`, `gateway/wiring/project-create.ts`) stamp a
  default emoji + `last_activity_at`.

**Web client.** `config.ts` `ProjectTab` gains optional `emoji`/`unread`/
`last_activity_at`; `controller.ts` parses them off the frame (unread clamped ≥0).
`ChatApp.tsx` `TopicRail` redesigned: a shared `RailItem` (emoji "avatar" chip ·
label · unread pill); the ACTIVE project's badge is locally zeroed (you're viewing
it). `chat-react.html` rail CSS reworked — emoji chip, accent-lit active row,
bolder unread rows, count pill — entirely `var(--…)`-driven so it reskins with the
light/dark toggle. `SettingsTab.tsx` — the disabled emoji SEAM is now a real
editable control (PATCH `{ emoji }`, like the name rename).

**Mobile (`app/`).** Project list wired for parity: `ProjectListItem`/`Project`
carry `emoji` + `unread_count` + real `last_activity_ms` (parsed from
`last_activity_at`, replacing the fake now-stamp); `ProjectCard` renders the emoji
+ an unread badge; the list sorts most-recent-activity-first; the settings emoji
SEAM becomes an editable field (PATCH `{ emoji }`).

**Unread semantics.** Honest + best-effort. Unread only counts agent messages
beyond the read cursor; a caught-up project reads 0. The active project shows no
badge (viewing = read). No fake counts (the existing `chat-topics-surface`
no-fake-unread contract is untouched — this feature computes real values for the
rail only).

**Follow-up (noted, out of sprint scope).** Agent-native emoji edit — the
`agent-settings` Core exposes `rename_project` but not yet a `set_project_emoji`
tool. The HTTP PATCH surface + mobile client already accept `emoji`; adding a 10th
tool to that Core's manifest/capability-guard/test contract is deferred to a
follow-up so this sprint stays focused on the rail. Per-project unread on the
General scope is also not badged (onboarding lives there; low value).
## 2026-07-01 — Reminders: faithful cron cadence (Vajra parity)

**Why.** Neutron's reminder store only understood COARSE recurrence
(`weekly` / `monthly` / `occasional`, fixed +7d/+30d/+14d deltas). The M2
cutover must migrate ~66 real cron reminders (`0 9 * * *`, `0 9 7 2 *`,
`0 */6 * * *`, `0 14 1 1,4,7,10 *`, …) FAITHFULLY, which those coarse labels
cannot represent. This brings the store + tick loop to full 5-field cron
parity. The SMART / context-aware side (literal / smart-wrap / pattern-template
composition at fire time) was ALREADY at parity in `reminders/message-shape.ts`
+ `dispatcher.ts` — cron rows flow through that unchanged, so a migrated smart
reminder still composes a fresh context-aware message at fire.

**Framing — extend the ONE path, no flags, no dual system.** A reminder recurs
when EITHER cadence column is set; the tick loop's single `computeNextFire`
resolves the next instant from whichever is populated. No parallel scheduler,
no feature flag.

**What changed.**
- `cron/cron-standard.ts` (NEW) — standard 5-field crontab evaluator
  (`parseCron` / `isValidCron` / `nextCronFire`). Full grammar: `*`, single
  values, ranges, comma lists, and steps; month + weekday names; `0`/`7`
  both Sunday; Vixie day-of-month/day-of-week OR semantics. Wall-clock math is
  DST-correct and reuses `calendar.ts`'s `wallClockToEpoch` / `zonedParts`; a
  spring-forward gap time is skipped to the next valid instant. No `Date.now()`
  inside — the caller passes the reference instant (deterministic + testable).
  Kept SEPARATE from the systemd-`OnCalendar` parser (`calendar.ts`) because the
  two grammars differ in field order, wildcard spelling, and dom/dow combination
  (systemd ANDs; crontab ORs).
- `migrations/0093_reminders_recurrence_spec.sql` (NEW) — `ALTER TABLE reminders
  ADD COLUMN recurrence_spec TEXT` (nullable; forward-only; no CHECK — the
  write-side `isValidCron` gate is authoritative). Snapshot regenerated.
- `reminders/store.ts` — `Reminder.recurrence_spec`; `createRecurring` accepts a
  coarse `recurrence` label OR a `recurrence_spec` cron (exactly-one invariant
  enforced). New exported `isRecurring()` predicate; the claim/advance guards
  (`advanceRecurrence` / `revertRecurrenceAdvance`) now recognise a row as
  recurring when EITHER column is set.
- `reminders/tick.ts` — the two next-fire branches collapse into one
  `computeNextFire(reminder, now, tz)`: cron spec → DST-correct wall-clock
  instant strictly after now (via `@neutronai/cron`); coarse label → the
  existing fixed-delta (unchanged). New `time_zone` option (default host zone).
  A corrupt cron that can never compute fires once then retires so it can't
  wedge the tick loop.
- `cores/free/reminders/src/backend.ts` + `package.json` manifest —
  `reminders_create` accepts an optional `recurrence_spec` (validated via
  `isValidCron`; mutually exclusive with `recurrence`). `snooze` / `update`
  preserve a cron reminder's cadence (no silent degrade to one-shot). Existing
  coarse-label + one-shot callers unchanged (back-compat).

**Tests.** `cron/cron-standard.test.ts` (grammar, next-fire across daily /
hourly / weekday / monthly / annual / quarterly, Vixie OR, DST spring-forward +
fall-back + gap-skip); `reminders/tick.test.ts` (cron advances to the next
wall-clock occurrence, rolls to tomorrow when past, poison-cron retires);
`reminders/store.test.ts` (column round-trip + exactly-one invariant);
`cores/free/reminders/__tests__/tools.test.ts` (cron create, invalid-cron
reject, both-cadences reject, snooze/update cadence preservation). Full suite +
root `tsc` + leak-gate green.

## 2026-07-01 — Light/dark theme toggle for the web chat UI

**Why.** The web chat (`landing/chat-react`) shipped dark-only. Ryan asked for a
light/dark toggle: default to the OS setting, allow an explicit override, persist
the choice, and make LIGHT mode an iMessage-on-iPhone look.

**Framing — a user preference, NOT a feature flag.** ONE stylesheet, themed via
CSS variables. No `NEUTRON_*` env, no `?client=`-style branch, no dual code path.
The whole UI reskins by flipping a single `data-theme` attribute on the document
root.

**What changed.**
- `landing/chat-react/theme.ts` (NEW) — the pure, DOM-free source of truth for
  resolution + persistence. `ThemePreference = 'light' | 'dark' | 'system'`;
  `resolveTheme(pref, systemPrefersLight)` (explicit override wins; `system` /
  unrecognized follows `prefers-color-scheme`); `read/writeStoredPreference`
  (localStorage key `neutron-theme`, safe when storage throws);
  `cyclePreference` (system → light → dark); `applyResolvedTheme` (writes
  `data-theme`). Default preference is `system`.
- `landing/chat-react/useTheme.ts` (NEW) — the React binding: initializes from
  storage, resolves against the live system signal, writes `data-theme` on the
  root, persists on change, and subscribes to `prefers-color-scheme` ONLY while
  the preference is `system`.
- `landing/chat-react/ThemeToggle.tsx` (NEW) — the top-right control. A single
  pill button that cycles the preference; the glyph shows the RESOLVED theme
  (☀/☾) with an "Auto" marker while following the OS.
- `landing/chat-react/ProjectShell.tsx` — wraps the tab bar + toggle in a new
  `.car-topbar` flex row so the toggle is pinned top-right of the content pane
  (owns the whole UI's theme, so it lives at the shell root).
- `landing/chat-react.html` — (1) the `<style>` block is now FULLY
  variable-driven: the dark `:root` set gained semantic vars for every
  previously-hardcoded color (hover/active tints, code bg, banners, import
  status, overlays, on-accent text, error/warn/info/success), and a new
  `:root[data-theme="light"]` set overrides them with the iMessage light palette
  (`#ffffff` surface, `#007aff` user bubble, `#e9e9eb` agent bubble, `#1c1c1e`
  text, iOS separators) — audited so there are NO dark-only leftovers; (2) a
  pre-paint inline `<script>` reads `neutron-theme` + `prefers-color-scheme` and
  sets `data-theme` (+ the `theme-color` meta) BEFORE the stylesheet paints, so
  a light user never sees a dark flash; (3) `.car-topbar` + `.car-theme-toggle`
  styles.
- `landing/chat-react/__tests__/theme.test.ts` (NEW) — the theme-resolution unit
  test (system vs. explicit override vs. persisted; storage fallbacks; cycle
  order). `theme-toggle.test.tsx` (NEW) — happy-dom wiring test: the toggle
  mounts, reflects the initial preference, and clicking it flips `data-theme` +
  persists to localStorage; a persisted override wins over the OS on mount.

**Verification.** `bunx tsc -p landing/chat-react/tsconfig.json` clean; full
`landing/chat-react/__tests__` suite green (193 + 16 new); the browser bundle
(`bun build landing/chat-react/main.tsx`) builds with the theme code wired in;
`scripts/ci/leak-gate.sh` SILENT; visual check of both themes off the real
stylesheet (light = iMessage, dark unchanged, toggle top-right, no leftovers).

## 2026-07-01 — Auto-navigate to the personal-URL claim page at onboarding-end (Managed overlay)

**Why.** The Managed personal-URL claim flow (control-plane `GET/POST /claim` →
rename → 302 to the owner's personal chat URL; neutron-managed personal-URL claim
flow, merged + deployed) serves the claim page but nothing sent the owner there
when onboarding finished. This is the paired Open-side trigger: when onboarding
completes, send the browser to the configured claim URL.

**Framing — Managed-overlay CONFIG, not a feature flag.** ONE code path
(redirect-if-URL-present). On a Managed install the env
`NEUTRON_POST_ONBOARDING_CLAIM_URL` points at the control-plane `/claim`, so the
client redirects there; on Open self-host the env is absent, the client sees
`undefined`, and the redirect no-ops (onboarding completes normally). No on/off
boolean, no dual path.

**What changed (NO flags, NO dual paths).**
- `channels/adapters/app-ws/envelope.ts` — new outbound frame
  `AppWsOutboundOnboardingCompleted` (`type: 'onboarding_completed'`, payload-free
  signal) added to the `AppWsOutbound` union. The redirect *target* is NOT on the
  frame — it lives in the client bootstrap config (a Managed-overlay concern).
- `gateway/wiring/build-onboarding-finalize.ts` — new optional dep
  `emitOnboardingCompleted?(user_id)`, called at the terminal `completed`
  transition (step 5b, right after `emitProjectsChanged`, before the closing
  message so a slow opening compose can't delay the redirect). The finalizer's
  idempotency gate guarantees it fires **exactly once** per owner.
- `open/composer.ts` — (1) `fanOnboardingCompleted(user_id)` fans the frame to the
  base topic AND every live per-project topic (same topology as
  `fanProjectsChanged`) and is wired into `buildOnboardingFinalize`; (2)
  `claimBootstrapScript()` injects `window.__neutron_post_onboarding_claim_url`
  into the served `/chat` React shell **only when** the env is set (`<`-escaped),
  alongside the existing projects/onboarding bootstrap scripts; (3) **reconnect
  recovery** — `on_session_open`'s steady-state branch replays the
  `onboarding_completed` frame to the connecting topic for an already-completed
  owner when the claim URL is configured. Without this, a finalize that fires
  with no live socket (e.g. a background import-completion watcher finalizes
  while the tab is closed) would drop the only signal and the reconnect — seeing
  an already-`completed` row — would never re-emit it, losing the redirect
  (Codex P2). Gated on the env so it is a strict no-op on Open self-host; the
  client latch keeps it at-most-once and it stops once the owner claims (they
  move to a host without the env).
- `landing/chat-react/config.ts` — `BootstrapConfig.postOnboardingClaimUrl` +
  `WindowLike.__neutron_post_onboarding_claim_url`; `resolveBootstrapConfig` reads
  the injected global (non-empty string only; empty ⇒ treated as absent).
- `landing/chat-react/controller.ts` — new options `postOnboardingClaimUrl` +
  injectable `navigate` (defaults to `window.location.assign`). On the
  `onboarding_completed` frame, IF a claim URL is configured it navigates there
  (once — a `claimRedirected` latch guards a re-sent frame); else no-op.
- `landing/chat-react/main.tsx` — passes `config.postOnboardingClaimUrl` through
  (spread-only when present, so Open self-host stays undefined).

**Tests / evidence.**
- `landing/chat-react/__tests__/controller.test.ts` — redirect fires to the
  configured URL on `onboarding_completed` (Managed); no-op + session stays open
  when unset (Open self-host); at-most-once on a re-sent frame.
- `landing/chat-react/__tests__/config.test.ts` — `postOnboardingClaimUrl`
  undefined by default, read when injected, empty treated as absent.
- `gateway/wiring/__tests__/build-onboarding-finalize.test.ts` —
  `emitOnboardingCompleted` fires once at the terminal transition and is NOT
  re-emitted on an idempotent re-finalize.
- `open/__tests__/open-claim-redirect-bootstrap.test.ts` — the served `/chat`
  shell injects the claim script when the env is set and injects NOTHING when
  unset (no-regression), driven through the composed graph `fetch`.
- `open/__tests__/open-claim-redirect-reconnect.test.ts` — a live `/ws/app/chat`
  connect for a completed owner replays `onboarding_completed` when the claim URL
  is configured, and emits NOTHING when unset (Codex-P2 recovery).
- `tsc` clean (root + `landing/chat-react`); leak-gate SILENT.

## 2026-07-01 — DROP the agent-NAME step in onboarding (personality-only → SOUL.md)

**Why.** Neutron Open is an agent ORCHESTRATOR, not a named personal agent. Ryan:
*"we can remove the idea of selecting a name … in neutron open lets drop the name
entirely, just ask about personality to setup SOUL.md."* Onboarding used to force
a "name your assistant" step (step-5 preamble ask + a hard-required `agent_name`
field + a name-suggestion button block) that gated finalize.

**What changed (Path-1 live-session; NO flags, NO dual paths).**
- `onboarding/interview/required-fields-audit.ts` — `agent_name` removed from
  `RequiredField` / `PRIORITY` / `isFilled`. Now **4** required fields
  (`user_first_name`, `primary_projects` ≥3, `non_work_interests` ≥1,
  `agent_personality`); `next_to_collect` goes null — and finalize fires — once
  personality settles. `agent_name` is KEPT on the `RequiredFieldsState` shape
  (the legacy engine + its `llm-router` still amend it) but is never audited.
- `onboarding/interview/onboarding-preamble.ts` — deleted the step-5 "a name for
  you" ask + custom-name-acceptance copy; added an explicit "Do NOT ask them to
  name you" instruction. `buildOnboardingStepGuardFragment` lost its `needsName`
  half: personality is the ONLY button-driven required step; the guard returns
  null once it settles.
- `onboarding/interview/button-backed-answer.ts` — the deterministic capture now
  settles only `agent_personality` (name branch + name-only helpers removed).
- `onboarding/interview/post-turn-extractor.ts` — no longer solicits (LLM prompt)
  or persists `agent_name`.
- `open/composer.ts` — stopped building + wiring the `agentNameSuggester` into
  onboarding. **`agent-name-suggester.ts` MODULE stays in the tree** (Managed
  repurposes it later); the legacy engine's `agent_name_chosen` phase is untouched.

**Personality → SOUL.md verified intact.** `onboarding/persona-gen/soul.ts`
already renders SOUL.md from personality alone — `composeOpenerSentence` falls
back to "You are a personal agent." when no `agent_name` is present — so dropping
the name does not affect SOUL.md generation.

**Tests / evidence.** Updated `required-fields-audit.test.ts` (4-field contract +
explicit "missing agent_name never gates finalize"), `button-backed-answer.test.ts`
(personality-only; a name-suggestion block settles nothing), `onboarding-preamble.test.ts`
(guard never emits a NAME step; preamble never asks a name), `post-turn-extractor.test.ts`
(extractor never persists `agent_name`). Full `onboarding/` suite green
(1602 pass / 0 fail), `open/` suite green (125 pass / 0 fail), root `tsc --noEmit`
clean, leak-gate SILENT.

## 2026-06-30 — Create Project rail refresh reaches a project-scoped socket (not just General)

**Bug.** #132's "Create Project" fan emitted its `projects_changed` app-ws frame
only to the user-scoped General topic `app:<user>`. The served web client opens
ONE socket scoped to the project it is viewing (`app:<user>:<project>`), so
creating a project **from inside a project** never refreshed the left rail until
a page reload. Onboarding was unaffected because it runs on the General topic.

**Fix.** `open/composer.ts` adds `fanProjectsChanged(user_id, frame)` — fans the
rail-refresh frame to the base topic AND every live per-project topic for the
user (enumerated via `appWsRegistry.topics()` with the `app:<user>:` prefix).
Both `emitProjectsChangedNow` (the create-project HTTP endpoint + the
`create_project` agent tool, via the shared `createProjectAndRefresh`) and
`emitProjectsChangedIfChanged` (onboarding) route through it. Each web socket is
on exactly one topic so there is no double-delivery; the frame carries the full
`readProjectRows()` list (`deleted_at IS NULL`) so it always includes the new
project. No flags.

**Tests.** `open/__tests__/open-projects-changed-wiring.test.ts` adds an e2e test
that opens both a project-scoped socket and a General socket, drives the real
`POST /api/app/projects`, and asserts the new project reaches both live.
Confirmed red before the fix, green after; leak-gate silent; `tsc` clean.
## 2026-06-30 — Onboarding live-path: deterministic name/personality capture (no double-ask) + single closing

**P1 — two live-path bugs from Ryan's deployed-onboarding test.** Both fixed inside
Path-1 (no flags, live-session locked, honoring #129; no regression of the passing
gates — archetype buttons #139, custom-name accept #136, per-project openings
#136/#138/#139, bubble/tab/markdown #137/#141).

**BUG 1 — agent name (and personality) asked TWICE on a TAP.** Root cause:
`agent_name`/`agent_personality` were persisted ONLY by the fire-and-forget
post-turn LLM extractor (`post-turn-extractor.ts` — literally "agent_name — LLM
only"). So a TAPPED (or typed) choice left `phase_state` unset until that slow,
sometimes-timing-out extractor caught up, while the per-turn required-step guard
(`onboarding-preamble.ts:buildOnboardingStepGuardFragment` via
`required-fields-audit.ts`) re-injected the "STILL OPEN - NAME/PERSONALITY"
hard-require from the STALE pre-turn `phase_state` every turn — so the live agent
dutifully re-asked. **Fix:** a new PURE decider `button-backed-answer.ts:`
`captureButtonBackedRequiredField` (prior-question + phase_state + answer →
which field to settle), driven by a new `LiveAgentOnboardingSeam.captureRequiredAnswer`
seam that the live runner (`build-live-agent-turn.ts`) calls + AWAITS at
turn-START — BEFORE the step-guard grounding reads `phase_state`. It persists
`agent_name`/`agent_personality` deterministically at choice-time, so the audit
recomputes with the answer already settled and the step is never re-asked. It is
conservative: only fires off the prior agent question's DURABLE persisted options
(`ButtonStore.latestPromptByTopic` — live replies strip the `[[OPTIONS]]` block
out of `body` into `options_json`, so the body alone would never match; Codex r1
P1), anchors the personality step on the DEFINED archetype names actually
rendered (so an early import yes/no can't be mis-captured), declines escape hatches
("Something else"/"I'll choose my own"), and lets the LLM extractor stay the
fallback for free-text answers it declines. Typed custom names still settle.

**BUG 2 — duplicate closing message.** The live agent emitted its own wrap-up
("We're set, what first?") AND finalize emitted the deterministic
`ONBOARDING_CLOSING_MESSAGE` (`build-onboarding-finalize.ts`). **Fix:** when
`captureRequiredAnswer` settles the LAST required field it fires finalize
(idempotent, `finalizeImportOnboardingIfReady`) and returns `finalized: true`, and
the runner SUPPRESSES its own wrap-up turn (returns early, no substrate dispatch,
no `agent_message`) — so the single deterministic finalize closing (which already
names the LEFT RAIL) is the ONE closing. Defense-in-depth: the preamble now tells
the agent NOT to write its own closing (the system sends it) and forbids the exact
duplicate phrases. Nice-to-have: preamble asks the agent to avoid em dashes.

**Tests.** New `onboarding/interview/__tests__/button-backed-answer.test.ts` (15:
tap/typed name + personality settle without the extractor; escape hatch / bare
confirm / no-options-block / early yes/no / both-settled all decline); new
`gateway/wiring/__tests__/build-live-agent-turn-capture.test.ts` (5:
capture runs BEFORE the guard grounding; `finalized:true` suppresses dispatch +
`agent_message`; `finalized:false` runs normally; seed turn never captures;
settling answer still persisted as the user bubble); `onboarding-preamble.test.ts`
updated (agent told not to self-close + em-dash guidance). Full
`onboarding/interview` + `gateway/wiring` + chat-bridge live-agent
suites green (1373 pass / 0 fail). tsc clean; leak-gate SILENT.

**Touched:** `onboarding/interview/button-backed-answer.ts` (new pure decider),
`onboarding/interview/onboarding-preamble.ts` (export archetype names + no-self-
close/em-dash guidance), `gateway/wiring/build-live-agent-turn.ts`
(`captureRequiredAnswer` seam + turn-start call + wrap-up suppression),
`open/composer.ts` (seam impl: deterministic persist + finalize-on-complete).

## 2026-06-30 — Onboarding reliability: per-project opening recovery + empty-project loader + deterministic archetype step + larger cold budget

**P0 — four reliability gaps from a full fresh-install verify of #136+#138.** All
fixed inside Path-1 (no flags, live-session locked, honoring #129; no regression
of #136 custom-name/closing, #137 per-project-chat/Plan/markdown/tabs, #138
General-only onboarding + raised-timeout + welcome-reload-recovery).

**Issue 1 — per-project OPENING never landed (DB-confirmed 0 rows).** Finalize's
`emitProjectOpenings` logic was correct and unit-tested, yet the live box showed 6
projects with ZERO `app:<user>:<project>` `button_prompts` rows: the opening was a
fire-once side effect of finalize that can race the project-tab socket, be
swallowed, or be delayed under cold-turn load, and nothing regenerated it on entry
(reload recovered only the General welcome). **Fix:** made the opening a property
of ENTERING a materialized project. `open/composer.ts` `on_session_open` now, on
every steady-state connect to a materialized PROJECT topic with no message yet,
regenerates + persists the SAME deterministic opening
(`build-onboarding-handoff.ts:buildDeterministicProjectOpening` over the
materialized `STATUS.md`/`README.md`) via the idempotent `onboardingMsgHolder.emit`
(`dedupe_key: onboarding_opening:<project_id>`) — collapses onto finalize's row if
that already landed, never double-posts. Doubles as reload recovery for a
stuck/missing project opening (Issue 4b).

**Issue 2 — empty project chat showed a PERMANENT "Setting things up…" loader.**
`chat-react/ChatApp.tsx` gated the loader on the page-global
`config.onboardingActive` ALONE, so opening an empty project tab while onboarding
(or just after) painted the infinite onboarding loader forever. **Fix:** gate on
`config.onboardingActive && vm.projectId === null` — onboarding is General-only, so
a project topic resolves to the usable "Send a message to begin." empty state,
never the loader.

**Issue 3 — personality/archetype step was non-deterministic (skipped).** The
archetype + name steps lived only as soft preamble prose, and the preamble also
says "you do NOT need to collect these in order" — a fresh-install run showed ZERO
option buttons. **Fix:** new `onboarding-preamble.ts:buildOnboardingStepGuardFragment`
audits the durable `phase_state` and, while `agent_personality`/`agent_name` are
unset, HARD-REQUIRES the named-archetype / name `[[OPTIONS]]` block (never settle by
free text alone, never finalize without it). Injected EVERY onboarding turn via the
`LiveAgentOnboardingSeam.onboardingContext` seam (joined with the import-analysis
grounding), so the agent cannot drift past the personality step without rendering
the buttons — reliable, not LLM-whim, still inside Path-1.

**Issue 4 — cold turn still hard-erred + reload didn't recover project openings.**
(a) `COLD_TURN_TIMEOUT_MS` raised 360s → 600s (`build-live-agent-turn.ts`): #138's
360s still hard-failed a real onboarding turn at ~5.5min under load; 10 min leaves
comfortable headroom. (b) Reload recovery for project openings is the Issue-1
`on_session_open` regeneration above.

**Tests.** `onboarding-preamble.test.ts` (+4: step guard fires while unset, name
step after personality, null once both settled, both-missing); `chat-react`
`component.test.tsx` (+2: empty project topic shows no loader / General still does);
new `open/__tests__/open-project-opening-recovery.test.ts` (+2 integration: a
project-topic connect seeds the STATUS.md opening; no seed when the topic already
has a message); existing cold-turn budget test updated 360s → 600s. tsc clean
(root + chat-react leaf); leak-gate SILENT.

**Touched:** `open/composer.ts` (opening-recovery helper + `on_session_open`
steady-state branch + `onboardingContext` step-guard wiring),
`onboarding/interview/onboarding-preamble.ts` (step-guard fragment),
`landing/chat-react/ChatApp.tsx` (loader gate),
`gateway/wiring/build-live-agent-turn.ts` (600s budget).

## 2026-06-30 — REPL/live-agent model is ALWAYS the latest (never a hardcoded stale id)

**P0 onboarding hang fix.** A fresh Open box spawned the live-agent / onboarding
REPL with `--model claude-opus-4-7` (the hardcoded `BEST_MODEL` default in
`runtime/models.ts`). Once `opus-4-7` stopped serving, the model call hung → the
turn produced ZERO tokens → the persistent-REPL 180s per-turn timeout fired →
the user got the failure bubble / an indefinite "Setting things up…" loader.
Repro: a clean instance on the default hung 180s + failed; pinned to
`claude-opus-4-8` it delivered the welcome in ~32s.

**Root cause.** `runtime/models.ts` already exposes a dynamic accessor
`getBestModel()` (the model-update watchdog flips its override via
`setBestModelOverride` when a newer top-tier model ships), but the gateway-level
spawn/dispatch sites read the **frozen `BEST_MODEL` constant** instead — so the
watchdog's adopted id never reached new/cold spawns, and the stale literal rotted
into a hang the moment the pinned model was retired.

**Fix (no flags, no dual paths).**
- **Seed bump:** `BEST_MODEL` default `claude-opus-4-7` → `claude-opus-4-8` (the
  fresh-install, pre-first-watchdog-tick seed) + a doc note that this is a SEED,
  not the live value. Added the matching `claude-opus-4-8` row to
  `runtime/model-pricing.ts` (same Opus $5/$25 rates) so
  `resolvePricingFor(getBestModel())` doesn't throw at import-build.
- **Dynamic resolution at every live spawn/dispatch site**, resolved as late as
  feasible (per-turn / per-call, never captured when a runner is built once at
  boot): `open/composer.ts` `prewarmSubstrate` (the warm-pool spawn that heats
  the onboarding REPL — THE confirmed-bug site), `build-live-agent-turn.ts`
  (resolved inside the per-turn body), `build-llm-router.ts`,
  `build-project-opening-message.ts`, `build-project-doc-composer.ts`,
  `build-phase-spec-resolver.ts` (`buildAnthropicLlmCall` model now optional →
  `getBestModel()` per-call), `build-agent-watcher-llm-call.ts`,
  `gateway/cores/mount-open-cores.ts` (one-shot Core LLM + email model), the
  onboarding suggesters (`agent-name-suggester.ts`,
  `personality-character-suggester.ts`) + `post-turn-extractor.ts`,
  `onboarding/synthesis/synthesis-session.ts`,
  `onboarding/history-import/substrate-callers.ts` + `job-runner.ts`,
  `scribe/extract.ts`, `reflection/detector.ts`. `agent-dispatch/service.ts`
  `default_model` now accepts a `string | (() => string)` thunk, and the Open
  composer passes the `getBestModel` accessor so each dispatch resolves live.
  Trident keeps the dynamic `--model opus` CLI alias (already always-latest);
  reminders/research keep their intentional `FAST_MODEL`/`SONNET_MODEL` picks.
- After this change there are **no remaining runtime references to the frozen
  `BEST_MODEL` constant** outside `runtime/models.ts` (the seed) and
  `runtime/model-pricing.ts` (doc text) — verified by grep.

**Tests.** New `build-live-agent-turn-model-resolution.test.ts`: a runner built
WITHOUT an explicit model spawns `getBestModel()`; a `setBestModelOverride` flip
AFTER the runner is built reaches the NEXT turn on the SAME runner (proves
per-turn, not per-build, resolution); an explicit `input.model` still wins. New
`prewarmSubstrate` model-resolution test (in `onboarding-warm-conversational`):
the pre-warm spawn uses `getBestModel()` and tracks a watchdog flip. Updated the
`models.ts` default assertion (4.7→4.8), the watchdog-wiring oldModel/no-downgrade
assertions (assert against `BEST_MODEL` not a literal), and the import
substrate-caller default assertions. tsc clean (root + trident); leak-gate
SILENT; models/substrate/onboarding/cores/realmode-composer suites green.

**Codex cross-model review follow-up.** Making the import default dynamic meant
that, after the watchdog adopts a brand-new top-tier id with no pricing row yet,
`resolvePricingFor(getBestModel())` (eager, at `buildPass{1,2}SubstrateCaller`
construction) would throw and break onboarding/imports. Fixed by splitting the
resolver: an EXPLICIT operator `model_preference`/`fallback_model_preference`
keeps the strict loud-fail (typo protection), while the DYNAMIC always-latest
default degrades to a $0 estimate (`dollars_billed` is telemetry-only) with a
one-time warn — the import runs on the latest model regardless. Regression test
added (`buildPass1/Pass2SubstrateCaller` construct + run on an unpriced
watchdog-adopted model, billing $0).

**Codex review round 2 — per-call resolution.** The import callers + onboarding
suggesters + post-turn-extractor are constructed ONCE at gateway/composer boot,
so a builder-scope `getBestModel()` capture would pin the boot model and miss a
later watchdog flip. Moved the dynamic-default model (+ its pricing, for the
import callers) resolution INSIDE each returned closure (per-call), so a
post-boot adoption reaches the next import / suggestion / extraction. Explicit
operator model picks still resolve + price ONCE at build (loud-fail on typo).
Test added: a `setBestModelOverride` flip between two calls on the SAME import
caller reaches the second dispatch.

**Codex review round 3 — env-pin keeps strict pricing.** `getBestModel()` returns
`runtimeBestModel ?? BEST_MODEL`, so an operator's `NEUTRON_BEST_MODEL` pin
(surfaced as `BEST_MODEL`) was being silently billed at $0 when unpriced —
regressing the typo loud-fail. Now ONLY a watchdog-adopted override (model !==
`BEST_MODEL`) degrades; the env/default base keeps the strict `resolvePricingFor`
loud-fail.

**Codex review round 4 — model attribution / metadata (P3).** Two
non-dispatch sites that should NOT track the live accessor: (a)
`onboarding/history-import/job-runner.ts` stamps `synthesizer_model` for a
legacy/pre-S21 row that ALREADY completed — reverted to the stable `BEST_MODEL`
(attribution, not selection; a watchdog flip mustn't mislabel old results). (b)
The free-email `/email` chat-command filter's reported `model` was captured at
mount while `emailLlm` dispatches `getBestModel()` per call — the filter's
`model` option now accepts a thunk resolved per-call in `match`, so the reported
model stays aligned with the dispatch.

**Codex review round 5 — Email Core backend metadata (P3).** Same boot-capture
in the Email-Managed Core MCP-tool path: `buildTools` stamped a boot-time model
onto `email_triage` / `email_summarize` brief metadata while `llm` dispatched
`getBestModel()` per call. Threaded a `string | (() => string)` thunk through
`emailModel` (`mount-open-cores` → `boot-helpers` factory → `buildTools`),
resolved PER-CALL inside each tool handler, so the stamped model tracks a
watchdog flip. (Email Core is OAuth-gated / inert in default Open, but kept
consistent with the dispatch.)

NOTE: `open/__tests__/open-projects-changed-wiring.test.ts` (one live-refresh
timing test) fails on unmodified `origin/main` too — a pre-existing flake, not a
regression from this change.
## 2026-06-30 — Web-client rework: per-project chat + rail/tab layout + Plan rename + remove Tasks + markdown (P0)

The linchpin fix for the onboarding→project UX. Five linked changes, all in the
web client + tabs registry + the app-ws topic-binding seam. No feature flags.

**(1) Real per-project chat.** The `/ws/app/chat` surface previously bound EVERY
connection to the per-user topic `app:<user>` and treated `project_id` as a
cosmetic tag, so all projects shared one transcript and clicking a project showed
the same chat. Now a `platform=web` socket carrying a `project_id` binds the
PER-PROJECT topic `app:<user>:<project>` (`appWsProjectTopicId`,
`channels/adapters/app-ws/envelope.ts`); General omits `project_id` → bare
`app:<user>`. Persistence + seq + resume + fan-out key on the topic string
(independent transcripts, verified safe — the agent loop scopes off the
`project_id` field, not the topic), so each project has its own history. The
client `controller.setProject` RE-SCOPES: tears the socket down and stands up a
fresh one bound to the new topic, hydrating that topic's transcript from the
shared OPFS store (`main.tsx` `topicForProject`/`wsUrlFor`; `config.ts`). The
`turnTopicId` warm-session key was de-duped so the already-project-scoped web bind
isn't double-suffixed (`open/composer.ts`). **Gated on `platform === 'web'`** —
mobile keeps its single `app:<user>` socket + `project_id`-field model, unchanged.
Topic string is `app:<user>:<project>` (user-scoped, NOT `wow-shell-<id>`) so two
users opening the same project can never share a transcript — mirrors the proven
`landing/server.ts` `web:<user>:<project>` model. The 0→N `projects_changed`
auto-select was DROPPED: a mid-onboarding project appears in the rail but does NOT
yank the chat off General (which would drop still-arriving onboarding messages);
the user enters a project by tapping it. **Known behavior:** reminders/briefs still
fan to the bare `app:<user>` (General inbox) topic, so they surface in General, not
the per-project chats (durable rows always under `app:<user>`).

**(2) Persistent rail + tab layout.** `TopicRail` was nested INSIDE the Chat tab
body, so it vanished on other tabs, and the `TabBar` floated above everything only
in project views. Now `ProjectShell` is the app shell: a persistent `TopicRail`
left column + a content pane with the `TabBar` in BOTH General and project views.
**General** = Chat + Admin (global tabs); **project** = Chat / Plan / Documents
(NO Admin fold-in — the prior bug). `ChatApp` is now just the Chat-tab body
(`ChatSurface` + its bubble contexts); the create-project flow moved to the shell.

**(3) "Work Board" → "Plan"** user-facing label (`tabs/registry.ts`); internal
`work_board_*` tools / `cwb-` CSS / `work_board_changed` frame / DB table keep
their identifiers (no churny rename).

**(4) Tasks tab removed** from the engine (Ryan directive). The `tasks`
`BUILTIN_TABS` entry + `TasksTab.tsx` + `tasks-client.ts` + the `ProjectShell`
`target==='tasks'` branch + their tests were deleted; Tasks returns in WAVE 3 as a
Core-contributed webview tab via the existing `CoreTabContribution` path.

**(5) Markdown rendering.** Agent chat bodies (`ChatApp` `TextPart`, via
`useMessagePartText`) and the Documents viewer render sanitized GitHub-flavored
markdown through a shared `Markdown.tsx` (`react-markdown` + `remark-gfm` +
`rehype-sanitize`; links open `target=_blank rel=noopener`). User chat messages
stay plain. The Documents tab gains a Rendered↔Source toggle — Rendered is the
default; Source exposes the raw `<pre>` so comment anchors still map to RAW
character offsets. Deps added to `landing/package.json`; the lazy `Bun.build`
bundle stays ~0.91 MB.

Verification: root + chat-react-leaf + mobile `tsc` clean; chat-react 143 tests,
registry/app-tabs/app-ws-surface 46, app-ws adapter 107, composer/realmode 502 all
green; leak-gate SILENT. Files: `gateway/http/app-ws-surface.ts`,
`channels/adapters/app-ws/{envelope,adapter}.ts`, `open/composer.ts`,
`tabs/registry.ts`, `landing/chat-react/{ProjectShell,ChatApp,DocumentsTab,
controller,config,main,Markdown}.tsx?`, `landing/chat-react.html`,
`landing/package.json`.
## 2026-06-30 — Onboarding live-path: archetypes + option buttons + custom-name + closing + per-project openings

Five Path-1 onboarding content/flow regressions Ryan hit live-testing, all wired
INTO the live CC session (no phase-machine revival, no feature flags, one path).

**(1) Defined personality archetypes instead of improvised "flavors."**
`onboarding/interview/onboarding-preamble.ts` told the model to "offer a couple of
concrete flavors" at the personality step → it improvised a different trio every
run. It now injects the DEFINED named-character set
(`STATIC_PERSONALITY_CHARACTER_FALLBACK` from `personality-character-suggester.ts`
— Sherlock Holmes / Marcus Aurelius / Mr. Miyagi / Yoda / Atticus Finch) and tells
the agent to offer THOSE, presented as buttons (item 2).

**(2) Quick-select OPTION BUTTONS on choice steps.** The live onboarding turn
always emitted `options: []`, so the React client — which already renders an
`agent_message`'s `options[]` as tappable buttons and routes a tap back through
`on_button_choice` (`open/composer.ts`) as the next turn's `user_text = option.value`
— never received any. The preamble now instructs the agent to append a
`[[OPTIONS]] … [[/OPTIONS]]` block AFTER its prose question on genuine choice
steps; `build-live-agent-turn.ts:extractAgentOptions` parses the block out of the
collected reply ON ONBOARDING TURNS ONLY, strips it from the rendered body, and
emits the lines as buttons (letter-legend label + display body + a routing `value`
that is the line text itself, deduped + byte-capped to the 37-byte wire budget).
`allow_freeform` stays true (typing always works). Server-side structured-choice
detection — NOT a `--tools` surface change (the warm REPL's allow-list must stay
constant per the reuse guard).

**(3) Reliable custom-name capture.** The preamble now mandates accepting ANY name
the owner gives — typed OR tapped — verbatim, confirming and moving on, and NEVER
re-asking a name already given (the "Ferin got re-asked" regression). Name
suggestions are offered as `[[OPTIONS]]` per #2.

**(6) Closing handoff message.** `build-onboarding-finalize.ts` emitted NO closing
— the interview went silent after the last answer. It now takes an `emitChatMessage`
dep (wired in `open/composer.ts` to the SAME durable-history + live-fan path a
live-agent reply uses: a `button_prompts` row on `app:<user>[:<project>]` that the
topic `chat_history_surface` hydrates + a `buildAppWsSendReply` socket push) and,
AFTER `emitProjectsChanged`, emits a deterministic General closing pointing at the
populated left rail ("open one to find its Plan, Documents, and Chat" — uses "Plan",
not "Work Board"). Emitted from finalize (not just the preamble) so the projects
are guaranteed in the rail when it lands. The closing + each opening carry a stable
per-(topic, kind) `dedupe_key`; the composer keys the durable `button_prompts` row
on it AND suppresses the live re-send when the row already existed, so a
re-finalize from an overlapping recovery path never double-posts (Codex P2).

**(7) Per-project opening message.** Path-1 finalize materialized projects with
rich docs but seeded no opening chat message. `materializeProjects` now returns the
landed projects, and finalize composes each one's opening (summary + ONE next move)
via the SAME deterministic composer the legacy phase-machine handoff used
(`build-onboarding-handoff.ts:buildDeterministicProjectOpening`, reading the
materialized `STATUS.md`/`README.md` with the import signal as fallback), delivering
it into the project's app-ws topic `app:<user>:<project>` — the key the live-agent
reply path and the client's per-project chat read from. SIBLING-PR COORDINATION:
the concurrent web-client PR is making the client read per-project topics; the
opening lands on the project's canonical app-ws topic, reconciled at merge.

Tests: `extractAgentOptions` parsing + onboarding-vs-steady-state emission
(`build-live-agent-turn-options.test.ts`); finalize closing + per-project openings
+ no-seam-still-completes (`build-onboarding-finalize.test.ts`); preamble archetypes
/ options protocol / custom-name / rail+Plan wrap-up (`onboarding-preamble.test.ts`).
`tsc` clean; existing live-agent-turn / handoff / chat-bridge / production-composer
suites still green.

## 2026-06-30 — M1 onboarding/UI cleanup batch (3 minor verify-pass fixes)

Three minor, non-architectural polish fixes surfaced during the M1
browser-verification passes. No feature flags, no migration, no new endpoint.

**(a) Import "Reading through…" status bubble floated to the chat bottom.** The
`import_running` `status` prompt ("Reading through your export now: entities,
topics, recurring threads…") was fanned ephemerally via `emitOnboardingPrompt`,
so it carried no chat_log `seq` and `compareForDisplay` (seq-less sorts to the
tail) pinned it BELOW every later real-seq message — it stayed at the bottom even
after the import completed and the analysis + later turns arrived. This is the
same ordering seam #130 fixed for the analysis body. **Fix** (`open/composer.ts`):
new pure, unit-tested `resolveImportRunningStatusDelivery` — the FIRST plain
buttonless status bubble is persisted through the durable adapter (chat_log
`seq` → chronological order), and the engine cron's RE-EMITS
(`import_running_attempt_count > 1`) are suppressed so they don't stack duplicate
durable bubbles (the live `import_progress` banner already shows ongoing
progress). Failure / rate-limit / resume prompts (real buttons) stay ephemeral.

**(b) Locked-in project set could include a project never shown to the user.**
The presentation caps the proposal at `MAX_ANALYSIS_PROJECTS` (7), but Pass-2 /
synthesis only caps via a prompt instruction (NOT enforced in code). A >7
synthesis therefore stamped the FULL list into `phase_state.import_result` AND
merged all N names into `primary_projects`, so the per-turn `onboardingContext`
seam, persona-gen, and finalize all locked in projects 8+ the user never saw and
could not drop. **Fix**: `capProposedProjects` (single source of truth in
`phase-prompts.ts`, used by the presentation too) is applied at the engine STAMP
chokepoint (`advanceFromImportRunningOnComplete` caps both `import_result` and
the `primary_projects` merge), so everything downstream agrees with the displayed
slice. `build-onboarding-finalize.resolveProjects` caps the IMPORT contribution to
the displayed set as a finalize-layer guard but TRUSTS `primary_projects` verbatim
(only displayed names + explicit adds, since the engine merge is capped) — it does
not filter primary against the overflow, which would wrongly drop an explicit add
whose name collides with an unshown overflow proposal (fixed per Codex review).
The GAP1 "no-narrowing" invariant is preserved (finalize = displayed − dropped +
adds).

**(c) Create Project used the native `window.prompt()`.** Replaced the blocking,
unstyleable native dialog (which also blocks E2E/CDP automation) at
`landing/chat-react/ChatApp.tsx` with an INLINE name input in the rail
(`.car-rail-input`), mirroring the mobile `app/app/projects` pattern: Enter
submits, Esc cancels, an empty name shows an inline error, and a failed POST
renders inline (no `window.alert`). Same `POST /api/app/projects` + bearer +
`controller.setProject(newId)` navigate-in flow; CSS in `landing/chat-react.html`.

**Tests.** New unit tests for `resolveImportRunningStatusDelivery`
(`open/__tests__/open-import-analysis-delivery.test.ts`), `capProposedProjects` +
the finalize >7 reconciliation (`gap1-project-no-narrowing.test.ts` +
`build-onboarding-finalize.test.ts`), and the inline create-project flow incl.
Enter/Esc/empty-name (`landing/chat-react/__tests__/component.test.tsx`). tsc
clean; leak-gate SILENT.

## 2026-06-29 — M1 CRITICAL: open-mode history import wouldn't START (#130 regression) — upload right after the name now seeds the row + starts the job

**Symptom.** On a fresh Open install, the reworked onboarding (#130) offers
history import right after the name. The owner uploads their ChatGPT/Claude
export and the server returns `job_id: null`; the client shows "Couldn't start
the import — no import job started." The import never runs (`import_jobs` empty,
`in_flight_imports=0` forever) behind a false success.

**Root cause.** `InterviewEngine.notifyImportUpload`
(`onboarding/interview/engine.ts`) reads the onboarding_state row and short-
circuits with `noop_no_state` when it's absent — **before** the open-mode
import-start gate. The open-mode live-agent onboarding never calls
`engine.start()` (managed mode's row-seeding entry); the row is created
**lazily + asynchronously** by the fire-and-forget post-turn extractor
(`post-turn-extractor.ts`), a multi-second background LLM call that only upserts
once it extracts a field. #130 moved the import offer to right after the name —
**earlier than the background extractor can create the row** — so the upload
races ahead of the row and lands at `state === null`.

**Fix (no flags, tenant-silent).** In `notifyImportUpload`'s `state === null`
branch, when the upload is a SOLICITED open-mode Path-1 upload (the SAME signal
the non-null gate uses: `deploymentMode === 'open'` AND `importAffordanceOffered`,
the exact condition the live-agent seam renders the 📎 affordance under), seed
the onboarding_state row at the `work_interview_gap_fill` conversational marker —
stamping `signup_via` so the import-running cron's channel-context invariant holds
on disk — then start the import via the existing
`startImportAndAdvanceToRunning`. A STRAY upload (affordance not offered, e.g. no
synthesis substrate) and managed mode both still `noop_no_state`. The #130
offer-first / live-progress / ordering / curation-context handoff are untouched.

**Concurrency guard (Codex r1 P2).** Two layers. (1) `notifyImportUpload` is now
serialized per `(project_slug, user_id)` via an in-process promise-chain tail
(mirrors the post-turn extractor's `chains` map). Single-owner Open is one
process, so this fully eliminates the upload-vs-upload race: two truly-
simultaneous fresh-install uploads run one-at-a-time, so the second observes the
first's `import_running` row and takes the `alreadyHasImportJob` guard — no
duplicate job, no downgrade. (2) Before seeding, the no-state branch also re-reads
the row and, if it now exists (e.g. the post-turn extractor — which is NOT under
this tail — created it), re-enters the locked body so all non-null guards apply.
Covered by added tests: sequential double-submit; a get-hooked store simulating
the concurrent window; and two truly-simultaneous `Promise.all` uploads → exactly
one job.

**Test (forbidden-pattern fixed).** The passing acceptance test
`tests/integration/nd2-real-export-path1-import-runs.test.ts` SQL-SEEDED an
onboarding_state row before uploading — manufacturing the precondition the live
flow never creates, so it could never catch this. It now seeds NO row and drives
the real no-state upload (verified end-to-end with Ryan's real 3.6MB / 184-convo
Claude export → job started). Added two engine-level repros in
`onboarding/interview/__tests__/path1-solicited-upload-starts-job.test.ts`
(no-state solicited → seeds row + starts; no-state affordance-off / managed →
no-op, no row manufactured). Negative control: reverting the engine fix fails
exactly these no-state tests.
## 2026-06-29 — Create Project affordance (project rail + create-project capability + agent tool)

A skip-import owner had no user-initiated way to create a project (projects only
materialized at onboarding finalize; reaching one otherwise needed the ≥3-project
gap-fill quota). Added a Create Project affordance across all surfaces, all
reusing ONE project-creation code path.

- **Shared primitives (`gateway/wiring/project-create.ts`).** Extracted
  `ensureProjectRow` + `resolveBindTarget` (the `projects` row + cli wow-shell
  `topics` binding — idempotent, duplicate-safe, soft-delete-respecting) out of
  `build-onboarding-finalize.ts` into a shared module, plus `createProjectRow`
  (fast row-only half), `buildScaffoldMaterializer` + `materializeProjectScaffold`
  (on-disk docs + git + GBrain page). The finalizer now IMPORTS these — no second
  path. (Onboarding finalize tests unchanged + green.)
- **HTTP `POST /api/app/projects`** (`gateway/http/app-projects-surface.ts`,
  bearer-gated). `{ name }` → `{ project: { id, label }, created }` (201/200);
  optional `createProject` binding → `501 create_not_configured` where unwired.
- **Open wiring (`open/composer.ts`).** Mounts the whole app-projects surface
  (also gives mobile `fetchProjects` a real backend — previously unmounted in
  Open) + the `create_project` tool, both bound to one `createProjectAndRefresh`
  (row → fire-and-forget materialize → `emitProjectsChangedNow`, an unconditional
  `projects_changed` fan so a skip-import owner's first action refreshes the rail).
- **`create_project` agent tool** (`create-project-tool.ts`, registered in
  `build-core-modules.ts`; `auto` approval, `write:project_data`, non-hidden) —
  agent-native parity; `project_slug`/`speaker_user_id` server-injected.
- **Web rail** (`landing/chat-react/ChatApp.tsx` `TopicRail` + `chat-react.html`):
  `+ Create Project` pinned at the rail bottom (`margin-top:auto`), always visible;
  the rail now always mounts. Click → prompt → POST → `setProject` navigates in.
- **Mobile rail** (`app/app/projects/index.tsx` + `lib/projects.ts` `createProject`
  / `lib/projects-client.ts` `create`): bottom-pinned bar → inline name input →
  POST → `router.push('/projects/<id>')`.
- No migration (the `projects` table already exists, `0038`); Work Board tab is
  automatic per-project. tsc clean (root + chat-react + app); leak-gate SILENT.
  Tests: surface POST (`gateway/__tests__/app-projects-surface.test.ts`), shared
  primitives + tool (`gateway/wiring/__tests__/project-create.test.ts`),
  web rail click (`landing/chat-react/__tests__/component.test.tsx`), mobile client
  (`app/__tests__/projects-client.test.ts`).

## 2026-06-29 — M1: onboarding import flow rework — offered FIRST + live progress + curation handoff + ordering

This is one coherent import-onboarding rework (PR #130). Two further bugs were
folded in after the initial offer-first + progress pass:

**Bug 3 — analysis → curation handoff was BROKEN (the killer).** The import-
analysis result (proposed-projects list) reached the client but was NOT in the
live-agent's conversation context. So when the owner replied to curate ("drop
the Family Home project, keep the rest"), the agent had no record of proposing
anything and answered "this is our first conversation, I haven't proposed any
projects" — the import was visible but un-actionable.

- Root cause: the analysis "wow moment" is delivered OUT OF BAND (ephemeral
  app-ws `agent_message`, never in the warm REPL transcript), and the onboarding
  `systemPreamble` is a static string spliced ONLY on the cold first turn — so a
  warm session post-import had no grounding on what it proposed.
- Fix (1) — context threading: new optional seam method
  `LiveAgentOnboardingSeam.onboardingContext(user_id)` (`build-live-agent-turn.ts`)
  re-injected on EVERY onboarding turn (warm AND cold), mirroring the Work Board
  block. `open/composer.ts` implements it: reads durable `phase_state.import_result`
  + `primary_projects` and calls the new `buildImportAnalysisContextFragment`
  (`onboarding-preamble.ts`) → an `<import_analysis>` block listing the proposed
  projects (with rationale + which were dropped) and telling the agent it already
  presented them + how to handle keep/drop/edit/add.
- Fix (2) — drop propagation: the Path-1 post-turn extractor never implemented the
  `removed_projects` channel that `ExtractedFields` has documented since GAP1
  (2026-06-09) and the legacy engine honors. Ported it: `parseExtractedFields`
  parses `removed_projects`; the extraction prompt asks for explicit drops;
  `buildPhaseStatePatch` subtracts them from the merged `primary_projects` AND
  accumulates them under `phase_state.dropped_projects`. `build-onboarding-finalize.ts`
  `resolveProjects` excludes `dropped_projects` from BOTH union sources (the import
  side re-pulls `proposed_projects`, so the `primary_projects` subtraction alone
  wasn't enough). Mirrors the legacy engine's `(prior ∪ adds) MINUS removals`. So
  a dropped project is never materialized; persona-gen (reads `primary_projects`)
  agrees. The additive no-narrowing rule is intact for non-removal turns.

**Bug 4 — import-delivered messages mis-ordered.** New user messages rendered
ABOVE the import-delivered analysis instead of newest-at-bottom. The successful
`import_analysis_presented` body was fanned via the ephemeral `emitOnboardingPrompt`
(no chat_log `seq`), and chat-core's `compareForDisplay` pins seq-less messages to
the tail — so a later real-seq user message sorted above it (and it vanished on
resume). Fix: that specific buttonless "wow moment" now persists through the
durable app-ws adapter (`open/composer.ts` button-prompt router → `adapter.send`
→ chat_log → monotonic `seq`, replayable). Every OTHER onboarding prompt (failure
/ rate-limit / resume — real buttons) stays ephemeral. Safe from double-render:
`on_session_open` never re-sends the body and the watcher resolves the phase so
the reconnect re-emit won't re-fire it.

Tests added: `onboarding-preamble.test.ts` (context fragment — lists proposed,
marks dropped, case-insensitive); `post-turn-extractor-removed-projects.test.ts`
(parse + subtract + accumulate `dropped_projects`, additive when no removals);
`build-onboarding-finalize.test.ts` (a dropped project is not materialized even
from the import union). tsc clean; leak-gate SILENT; onboarding-interview (957),
realmode-composer (379), app-ws (107), Open import/boot suites all green.

---

## 2026-06-29 — M1: onboarding import offered FIRST + real live import progress

**Problem (two live-test bugs).** Ryan hit two issues on a fresh M1 install:
1. The ChatGPT/Claude history import was **not offered early/explicitly**. After
   the #126 fix removed a premature always-on hint, the offer swung too far the
   other way — the agent only mentioned import after probing the user's work, so
   it felt buried. The intent (and the onboarding-experience spec) is: offer the
   import as the EXPLICIT first step right after the name, so the rest of the
   interview is informed by the analysis.
2. There was **no real import-progress indicator**. A large import (~8 min for
   173 conversations) showed only a one-shot "Export received — reading through
   your history now." line and then looked dead for minutes.

**Root cause.**
- Bug 1: Path-1 (Open) onboarding is prompt-driven — the engine runs only the
  import subsystem, so onboarding ordering lives entirely in the `<onboarding>`
  preamble (`onboarding/interview/onboarding-preamble.ts`). The import block sat
  after all five learning goals + was gated "after you have their name AND a
  sense of their work", biasing the model to defer it past the work-interview.
- Bug 2: the engine's `import-running-cron` already emits an `import_progress`
  event every ~5s and `buildRoutedSendImportProgress` already routes `app:<user>`
  topics to a composer holder — but that holder's `.send` was a documented NO-OP
  (`open/composer.ts`), so every progress frame was dropped. The React client
  (`controller.ts`) already consumed `import_progress` and rendered a spinner +
  per-pass line (`ChatApp.tsx` `ImportStatus`); only the server-side app-ws emit
  was missing.

**Fix (no flags, Option A in-chat for Bug 1).**
- `onboarding/interview/onboarding-preamble.ts` — moved the import-offer block to
  between goal #1 (name) and goal #2 (work) and reworded it to an EXPLICIT,
  prominent ask made RIGHT AFTER the name and BEFORE the work questions (mentions
  the drag-and-drop/📎 affordance + that it runs in the background with live
  progress; "only ask this once"). No new phase/modal — a pure preamble
  reposition. The managed-mode phase machine already routes import right after
  name, so it was untouched.
- `channels/adapters/app-ws/envelope.ts` — new `AppWsOutboundImportProgress`
  envelope (`{v,type:'import_progress',job_id,status,pass,pct,chunks_total_known,
  body?,ts}`) added to the `AppWsOutbound` union; mirrors `agent_typing` /
  `work_board_changed` (ephemeral, UI-only, not persisted, never replayed).
- `open/composer.ts` — filled the no-op `appWsImportProgressRouter.send` to fan
  the new frame via `appWsRegistry.send(app:<user>, env)` (best-effort; terminal
  frames clear the client spinner defensively, the analysis body still lands via
  the button-prompt path). Engine, cron, routing, and client render were already
  built.
- Tests: `onboarding/interview/__tests__/onboarding-preamble.test.ts` (pins the
  import offer present + positioned name→import→work, absent when not offered,
  asked once); `channels/adapters/app-ws/__tests__/import-progress.test.ts`
  (envelope is a union member, body optional, fans through `registry.send`).
- Docs: `docs/SYSTEM-OVERVIEW.md` updated (onboarding import-offer-first note +
  app-ws frame `#7 live import progress`).

**Why it's safe.** Additive: a server-only union member (the Expo subset union +
parity test are untouched and still green). The #126 fixes (import RESULT renders,
centered column, no reactions) are unaffected — the analysis body still lands via
the existing path; this only un-drops the intermediate progress frames. tsc clean
(root + chat-react leaf); app-ws (107) + onboarding-interview (912) suites green.

## 2026-06-29 — M1: stale-client-store auto-reset on server reinstall

**Problem.** A fresh Neutron Open server reinstall showed a STALE chat: the web
client's offline local store (`@neutronai/chat-core` OPFS snapshot, origin-scoped
`neutron-chat-core.json`) — and the mobile op-sqlite store (`neutron-chat.db`) —
survive a server uninstall+reinstall behind the same origin/device. The server's
per-topic `seq` counter restarts at 1 on a fresh install, but the client resumed
forward from its OLD high local cursor (`resume after_seq=<high>`), so the
server's `replayAfter` returned nothing and the dead server's transcript
rendered forever. `session_ready.last_seen_seq` already carried the server's
high-water seq but NO client code read it.

**Fix (seq-regression reset detection, no flags).**
- `chat-core/types.ts` — new `parseSessionReadyMaxSeq(frame)`: extracts
  `last_seen_seq` from a `session_ready` frame, `null` when absent/malformed.
- `chat-core/sync-engine.ts` — new `SyncEngine.reconcileServerReset(topic, serverMaxSeq)`:
  when the server's reported seq is a known number **strictly lower** than a
  **non-zero** local cursor, the server regressed (was wiped/reinstalled) →
  `store.clear(topic)` so the following `resume` re-syncs from `after_seq=0`.
  Conservative: no-op when seq is absent (`null`), when server seq ≥ local
  cursor (normal reconnect/cold-open/first-connect), or when the local cursor
  is 0 (nothing cached).
- `chat-core/web-session.ts` + `app/lib/chat-core/mobile-session.ts` — both
  `session_ready` handlers call `reconcileServerReset(frame)` BEFORE
  `resumeAndFlush()`, and emit a UI change on a real reset so the stale messages
  drop immediately (before the replay lands). The detection lives in the SHARED
  `SyncEngine`, so web (OPFS) and mobile (op-sqlite) both benefit.
- `app/lib/ws-envelope.ts` — added `last_seen_seq?` to `AppWsOutboundSessionReady`
  for type parity with the server envelope (`channels/adapters/app-ws/envelope.ts`).

**Server change (Codex P1a).** `gateway/http/app-ws-surface.ts` now ALWAYS sends
`session_ready.last_seen_seq` when a durable log is wired, **including 0**.
Previously it omitted the field on 0, so a freshly reinstalled server whose log
was still empty at connect time (the welcome messages persist AFTER
`session_ready`) sent no signal → the stale client never reset on its first
post-reinstall load. A present `0` is now an affirmative "this server has nothing
for the topic" signal; the field stays ABSENT only when there is no durable log
at all (where `null` → never clear, protecting the only copy). `open/composer.ts`
wires the durable `AppChatStore` chat_log, so Open always reports the real value.

**No-data-loss on reset (Codex P1b + P2).** Added a `Store.clearAckedTranscript(topic)`
primitive (InMemory + OPFS + Sqlite) that drops only the ACKED (server-sequenced)
transcript in a SINGLE atomic store operation, preserving un-acked local sends
(status `queued`/`sent`, no server seq). `reconcileServerReset` calls it instead
of a read-clear-reinsert cycle, so a send that races the reset can't be lost in a
snapshot→clear window (it's either an already-kept non-acked row or arrives
after). The preserved sends are re-driven against the fresh server by the
following resume/flush (idempotent on `client_msg_id`).

**Not changed.** No new local-store namespace keyed on a server instance id (the
frame exposes no per-install id today; the seq-regression heuristic is the
pragmatic detector per the bug note).

**Tests.** `chat-core/__tests__/session-ready.test.ts` (parser edge cases),
`chat-core/__tests__/sync-engine.test.ts` (reconcile: clears on regression;
no-op on ≥, null, cursor-0, un-sequenced optimistic sends),
`chat-core/__tests__/web-session.test.ts` + `app/__tests__/chat-core-mobile-session.test.ts`
(end-to-end: stale transcript cleared + `resume after_seq=0` + fresh replay
renders clean; normal reconnect preserves; absent `last_seen_seq` never wipes).

---

## Hobby projects + one-time agentic per-project kickoff (2026-07-01)

**Problem.** Two gaps in what onboarding produces on a fresh install: (1) the
interview asks about outside-work interests/hobbies but those answers materialized
NOTHING (only work/primary projects became real projects); (2) each materialized
project's opening was a static one-liner ("want me to X?") with no real agentic
work — no drafted doc, no deadline offer.

**PART A — hobbies materialize as projects.** Hobby answers land in
`phase_state.non_work_interests` (`{name, cadence_hint?}`, written by the
post-turn extractor) and `import_result.inferred_interests` (`{name, basis?}`) —
fields `resolveProjects` in `build-onboarding-finalize.ts` never read, so hobbies
reached persona-gen (USER/SOUL.md) but never a `projects` row / on-disk
`Projects/<id>/` repo. Added `collectInterestProjects` as a THIRD union source
(after import-proposed + interview-named work projects), mapping each interest to
`CapturedProject{name, rationale?, is_interest:true}` (rationale carried from an
import interest's `basis`). The existing `seen`/`dropped` dedup makes the superset
safe: a work project of the same name wins the slug dedup; a curation-dropped
hobby is excluded. The materializer is source-agnostic (identical repo + doc set
for hobby and work); `is_interest` only steers the kickoff. Added `is_interest?`
to `CapturedProject` (`onboarding/wow-moment/action-types.ts`).

**PART B — one-time agentic kickoff.** `emitProjectOpenings` now first asks a
`ProjectKickoff` (`gateway/wiring/build-project-kickoff.ts`) for a
richer opening, behind a HARD data-sufficiency gate ("better nothing than a bad
job"). Best-fit action per project:
- `draft-doc` (rich work): compose a real starting plan via the new
  `build-project-kickoff-composer.ts` (same CC-substrate discipline as
  `build-project-doc-composer.ts` — `getBestModel`, AbortController budget,
  throw-on-empty), write it create-if-missing under `Projects/<id>/docs/starting-plan.md`,
  present a tappable `[Starting plan](docs:/<id>/starting-plan.md)` marker, and
  re-index the project page to GBrain recall via `buildProjectPageIndexer`.
- `deadline-offer` (work with a real upcoming `import_result.proposed_tasks`
  deadline related to the project by name/topic, within a 60-day window): name the
  deadline(s) and OFFER a reminder — never auto-created; the live agent's
  `reminders_create` handles an accept.
- `interest-research` (rich hobby): light starting-notes doc, same write+link+index.
- `interest-questions` (thin hobby): deterministic engaging questions (a hobby's
  meaty opening, never a bad artifact).
- `null` (thin work): fall back to the deterministic `buildDeterministicProjectOpening`.

**One-time, no recurring machinery.** The kickoff runs inside finalize's single
per-project opening pass and emits under the SAME `onboarding_opening:<project_id>`
durable dedupe key as the deterministic opening, so it fills the ONE opening slot
and the on-connect recovery (`open/composer.ts:ensureProjectOpeningOnEntry`)
collapses onto it — no double-post. NO cadence / cooldown / on-enter refresh /
setting. Any doc-compose failure degrades to `null` (work) or engaging questions
(hobby), never a half-baked doc. The full wow `ActionRunner`/dispatcher is NOT
reused (it is a batch button-prompt path with a channel adapter + cron the
one-time plain-emit finalize has no surface for); the kickoff reuses its
trigger/gate CONTRACT plus `ProjectDocComposer`, `runtime/doc-links.ts`, and the
project-page indexer. `MaterializedProject` now threads `is_interest` + the
materializer's `MaterializeOutcome` (previously discarded) so the gate can read
`slice_chunk_count`/`summary_written`.

**Wiring.** `open/composer.ts` builds `projectKickoff` from the onboarding
Anthropic client (kickoff composer) + `buildProjectPageIndexer` (GBrain syncHook)
and passes it into `buildOnboardingFinalize` (optional dep; omitted on the LLM-less
path).

**Tests.** `gateway/wiring/__tests__/build-project-kickoff.test.ts`
(gate picks meaty-vs-prompt; draft-doc writes + presents a valid `docs:/` marker +
indexes; create-if-missing never clobbers; deadline offer names only related
upcoming deadlines and is offer-only; overdue/far-future excluded; thin hobby →
questions; rich hobby → research doc; compose failure degrades correctly).
`build-onboarding-finalize.test.ts` (hobby materialization from
`non_work_interests` + `inferred_interests`; hobby/work same-name dedup; dropped
hobby excluded; kickoff body emitted under the single opening dedupe slot with the
deterministic fallback for declined projects).

---

## M1 UX REDESIGN — backend data contracts (PR-1, 2026-07-02)

First redesign PR: the two design-independent backend contracts the redesigned
Work pane + project rail consume. NO feature flag, one code path, NO visual
change (PR-2+ build the UI on top of these).

### A. Per-run inner-step (`step_label`) + a live push that retires the 15 s poll

**Problem.** The outer `code_trident_runs.phase` sits at `forge-init` the WHOLE
inner build, and NOTHING pushed the inner workflow's checkpoint advances — the
web Work Board fell back to a 15 s poll (`WorkBoardTab.tsx`) to notice
building→reviewing→fixing, so a live build "looked frozen".

**`step_label` derivation (`trident/run-progress.ts`).** New exported
`deriveStepLabel(phase, inner_checkpoint)` + a `step_label: RunStepLabel` field on
`RunProgress` (`building|reviewing|fixing|merging|done|failed`). It REUSES the
`inner_checkpoint` the inner workflow already re-stamps at each phase boundary
(`checkpoint()` in `inner-workflow.mjs`); because checkpoints are END-of-phase
markers, each maps to the phase the run is CURRENTLY in — `forge-done`→reviewing,
`argus-request-changes`→fixing, `fix-round-N`→reviewing, `argus-approved`→merging,
terminal phases win. No new DB column (the spec's sanctioned "reuse the existing
RunProgress shape" path). Mirrored client-side in `work-board-client.ts` with a
`stepLabelFromPhase` fallback for a legacy/absent wire value.

**The live fan (`trident/tick.ts`).** New `TridentTransitionHook` +
`on_transition` option on `TridentTickLoop`. The loop re-loads every non-terminal
run each tick and, when a run's progress signature
(`phase|inner_checkpoint|round|pr|last_advanced_at`) differs from what it last saw
(a checkpoint advance, a launch, or a terminal transition), fires `on_transition`.
This is the ONLY place that can fan on the inner workflow's behalf — the workflow
runs detached and can only `sqlite3`-write, never reach the app-ws registry. The
fan is best-effort (own try/catch), signature-deduped (quiet when idle), and drops
a run's signature once terminal (no unbounded map growth). Plumbed
composer→`misc-input.ts` (`on_run_transition`)→`build-core-modules.ts`
(→`on_transition`).

**Composer wiring (`open/composer.ts`).** The `work_board_changed` fan is
extracted to a named `fanWorkBoardChanged(scopeKey)` shared by the store's
`onChange` AND the run-transition hook. `on_run_transition(run)` fans
`fanWorkBoardChanged(run.project_slug)` (a board-bound run's `project_slug` IS its
item's board scope key) + `emitProjectsChangedIfChanged`. `WorkBoardTab.tsx`'s
15 s poll is retained as a FALLBACK only (dropped-frame resilience + the
elapsed/stall clock).

### B. Per-project rail fields (`activity` / `preview` / `preview_from` / `live_runs`)

`readProjectRows` (`open/composer.ts`) — feeding both the `projects_changed` frame
and the page bootstrap — now derives four per-project fields:

- **`activity`** (`idle`/`working`/`attention`) — `working` = a live chat turn
  (tracked at the `agent_typing` start/end seam via `activeChatProjects`) ∪ any
  board item bound to a live non-terminal run ∪ any `inline_active` item;
  `attention` (WINS over working) = any not-done item whose bound run is `failed` ∪
  any live run stalled past the display threshold.
- **`preview` / `preview_from`** — the project's last chat message
  (`app_chat_messages`), markdown-stripped + server-truncated to ~90 chars, plus
  the sender (`user`/`agent`) for a `You: ` prefix.
- **`live_runs`** — count of the project's live bound runs (Work-tab badge / pane
  toggle count).

The precedence + truncation are a PURE, unit-tested module (`open/project-rail.ts`:
`deriveProjectActivity`, `truncatePreview`, `stripMarkdownForPreview`). The chat
turn also fans `projects_changed` at the typing seam (diff-gated). Frame type
extended in `channels/adapters/app-ws/envelope.ts`; client parses the fields in
`controller.ts` into the `ProjectTab` type (`config.ts`), all optional on the wire
for back-compat.

**Tests.** `trident/run-progress.test.ts` (step_label for every checkpoint + the
full building→reviewing→fixing→reviewing→merging→done arc); `trident/tick.test.ts`
(on_transition fires on first-observation + each checkpoint advance + terminal,
never on a no-op; a throwing fan never aborts the tick); `open/project-rail.test.ts`
(activity precedence incl. attention-wins; preview markdown-strip + truncation).
`tsc` clean (root + `trident` + `landing/chat-react` leaf); leak-gate SILENT.

**Cross-model review fixes (Codex, 2 × P2).** (1) *Stalled runs now fan a rail
refresh* — `progressSignature` (`trident/tick.ts`) includes a `stalled` boolean
(off an injectable clock vs `STALLED_WARN_MS`), so the ONE moment a live run ages
past the display-stall threshold flips the signature and fires `on_transition`
(→ rail `attention`); it flips at most once per stall, so no per-tick churn. (2)
*Failed builds stay surfaced as attention* — a failed run is auto-detached from
its item on terminal reconcile, so the bound-item check alone was fleeting;
`readProjectRailExtras` now also reads `TridentRunStore.latestByProjectScope` — if
the scope's most-recent run is `failed` and the project still has a not-done item,
`attention` persists until a fresh run supersedes it. Tests added for both (tick
stall-crossing fan; `store.latestByProjectScope` scoping).

---

## Work-Board project-scope fix — agent tools + trident builds scope to the ACTIVE project (P0)

**Symptom (reproduced on the box 2026-07-02).** Chatting inside a NAMED project
(e.g. "Tabs"), the agent created Work items + kicked trident builds, but BOTH the
`work_board_items` rows AND the `code_trident_runs` rows came out under the
owner/instance slug (the General bucket) instead of the project — so they were
invisible in the project's Work tab and mis-filed onto General. Every agent-started
work item / build from a named project landed on General.

**Trace (the ACTUAL path the builds took).** The two candidate items were AGENT-
created, so the path is the agent-native MCP tool path — NOT the `/code` filter
(which is defined in `gateway/boot-helpers.ts` but **never constructed** in Open —
not a live path) and NOT the HTTP ▶ route (`gateway/http/work-board-surface.ts`,
which already derives `scope = workBoardScopeKey(resolved.project_slug, <URL
project_id>)` correctly). The drop point, step by step:

1. Agent calls `work_board_add` / `work_board_dispatch_build` over the native-MCP
   bridge → the spawned `claude`'s tools-bridge POSTs `/tool-call` to the warm-REPL
   sink (`persistent-repl-substrate.ts`).
2. The sink dispatched `replToolBridge.dispatch({tool_name, args, call_id})` with **no
   active project** — the warm REPL is topic-agnostic (documented Codex r1 [P2]: it
   binds `topic_id:null`), so there was no per-turn project on the call.
3. `McpServer.dispatch` → `currentTopicContextOrSystem(call_id, this.project_slug)`:
   no bound `TopicContext` ⇒ system shape with `project_slug = this.project_slug` (the
   **instance slug**).
4. The `work_board_*` handlers (`work-board/agent-tool.ts`) + the trident build tools
   (`trident/work-board-build-tool.ts`) passed that `ctx.project_slug` straight to the
   store / `dispatchBoardBoundBuild`. Via `workBoardScopeKey(owner_slug, /* empty */)`
   → `owner_slug` = the **General board**. ⇐ **exact drop point.**

**Fix — thread the active project end-to-end.** The warm conversational REPL is keyed
per-project (`poolKeyFor` folds `metering_context.project_id`), so a session serves
exactly one project scope for its lifetime:

- `ReplSession.projectId` is stamped from `options.project_id` at spawn; the
  `/tool-call` sink looks the session up by `session_id` (the tools-bridge already
  POSTs it) and threads `project_id` into `replToolBridge.dispatch({… project_id})`.
- `ReplToolBridge.dispatch` + `McpServer.dispatch` gained an optional `project_id`;
  `currentTopicContextOrSystem` returns it (preferring a bound `TopicContext`'s own
  `project_id` on the `resolveBound` path). New field
  `ToolCallContext.project_id` (the ACTIVE project; NULL = General/system).
- `work_board_*` (`work-board/agent-tool.ts`) and `work_board_dispatch_build` /
  `work_board_start` (`trident/work-board-build-tool.ts`) now resolve their scope via
  `workBoardScopeKey(ctx.project_slug, ctx.project_id)`, threaded to every store call,
  the board `get`/`attachRun`, `resolve_task`, and the created `code_trident_runs` row.
- The per-turn **injected** `<work_board>` block is scoped the same way
  (`build-live-agent-turn.ts` passes `turn.project_id`; composer `workBoardSnapshot`
  wraps `workBoardScopeKey`), so the board the agent re-grounds on == the board its
  writes land on. (`availableServicesSnapshot` already did this; the work board didn't.)

General (no active project / `'general'`) still scope-keys to the owner slug — the
"pre-existing rows map to General" behaviour (`work-board/store.ts:120-153`) is
preserved. One code path, no feature flags.

**Spec-conformance.** SPEC (#179): every project has its own board keyed by scope-key;
agent + build writes scope to the active project. CURRENT (before): agent
`work_board_*` + build-dispatch tools fell back to the instance/General slug. GAP:
active `project_id` not threaded into the agent tools + run creation. THIS PR: threads
it via the per-project session scope so named-project work scopes correctly; injected
board matches. OUT: General's Work *view* (UI tab, see below); redesign geometry.

**General's Work view — deferred (stated per spec).** General IS a first-class board
bucket (`owner_slug`) and the HTTP surface serves it, but the web tab-set builder
(`landing/chat-react/ProjectShell.tsx`, `if (isGeneral)` at ~L325) excludes the Work
tab for General. That file is owned by the parallel redesign PR that turns the desktop
Work tab into a slide-out; adding a General Work tab here would collide with it and be
immediately obsoleted. Deferred to that PR with an actionable note (drop the
`isGeneral` Work exclusion so General gets the same Work surface). No backend blocker —
General's board is already reachable.

**Tests.** `work-board/agent-tool.test.ts` (add/list/update/complete scope to the
active project; General regression guard; cross-scope write is a no-op).
`trident/work-board-build-tool.test.ts` (a build in project "acme" scope-keys the run
`project_slug` + board `get`/`attachRun` + `resolve_task` to acme; General → owner
slug). `mcp/server.test.ts` (dispatch binds bound-context `project_id`; threads the
caller `project_id` with no bound context; null otherwise). `tool-bridge.test.ts` (a
`/tool-call` from a session spawned under project "acme" threads `project_id:'acme'`
into dispatch; an unknown session → null). `tsc` clean (root + `trident`); leak-gate
SILENT.

**Cross-model review fix (Codex, 1 × P2).** *`dispatch_agent` now scopes to the
active project too.* The agent-native `dispatch_agent` tool is also board-bound, but
its `DispatchService` looked the `board_item_id` up (+ `attachRun`/`clearRun`) under
the service's own owner `project_slug` — so after this PR moved `work_board_add` onto
the active project, an agent that created/listed an item in project X and then
`dispatch_agent`'d against it would 404 as `unknown_board_item`. Threaded a
`DispatchRequest.board_scope` (defaults to the owner slug) through
`dispatch → launch → report`; the tool sets it to
`workBoardScopeKey(ctx.project_slug, ctx.project_id)`. Tests: `agent-dispatch/
service.test.ts` (board get/attach/clear all key on the threaded scope; default =
owner slug), `agent-dispatch/surface.test.ts` (the tool builds the req with the
active-project `board_scope`). The dormant `/dispatch` *chat command* is not wired in
Open (like `/code`); it keeps the owner-slug default, unchanged.

## UX Batch-4 (#347/#348/#349/#350) — mobile/web-mobile chat-react polish (2026-07-03)

Four fixes from Ryan's live dogfood, all in the responsive web chat-react client
(no feature flags, one code path, both light+dark + desktop preserved).

**#347 — the cold-start "Waking up…" pill duplicated + persisted as a timestamped
bubble.** The pill is a single-slot `systemNotice` rendered as a centered
ephemeral pill *outside* the message list, so duplicates/bubbles came from two
races, now closed on three sides:
1. `landing/chat-react/controller.ts` — a `replyStartedThisTurn` latch (set on the
   first stream token AND on a durable agent reply, reset on each `send()`). Once
   a real reply has started, a LATE cold-start ack frame is DROPPED instead of
   re-arming the pill below the answer.
2. `controller.ts` `computeVm` — durable rows whose body matches `isColdStartAck`
   are filtered out of the bubble list entirely, so a legacy/leaked persisted ack
   can never hydrate as a timestamped/avatar agent bubble (the sync engine
   persists a durable `agent_message` even though `onFrame` also shows it as a
   pill — that double-render was the bug).
3. `gateway/wiring/build-llm-call-substrate.ts` + `build-live-agent-turn.ts`
   — `collectTokensToString` takes an optional `onFirstToken` callback; the live
   turn passes `clearAckTimer` so the delayed cold-start ack is cancelled the
   moment the first reply token streams (not only at turn-settle).
Tests: `controller.test.ts` (late-ack dropped + fresh turn re-opens the pill;
durable ack never a bubble); substrate suite green.

**#350 — mobile tab-bar overhaul.** `landing/chat-react/ProjectShell.tsx` +
`chat-react.html`:
- Mobile (`<1024px`, the complement of the JS `min-width:1024px` desktop gate)
  stacks `.car-topbar` into a column: the workspace title on its own line, the
  tab band on the row below. Desktop keeps the single row.
- The cycling `<ThemeToggle/>` was removed from the top bar on ALL viewports; a
  labeled 3-way `ThemeControl` (System/Light/Dark segmented radiogroup, new export
  in `ThemeToggle.tsx`) now lives in General → Admin → **Appearance**
  (`IntegrationsTab.tsx`).
- Overflowing tabs collapse into a right-aligned "⋯" menu instead of
  `overflow-x: auto` scrolling. New `tab-overflow.tsx`: pure `computeVisibleCount`
  (unit-tested), a `useTabOverflow` measurement hook (hidden mirror row +
  `ResizeObserver`), and an accessible `OverflowMenu` (button `aria-haspopup`/
  `aria-expanded`; `role=menu`/`menuitem`; Esc + outside-click close; focus the
  first item on open, return focus on close; Arrow/Home/End navigation).
Tests: `tab-overflow.test.ts`. Browser-verified at 390×844: title stacked, no
viewport h-scroll (`.car-app { overflow:hidden }` clips the mirror), ⋯ lists the
overflow tabs, theme control flips `data-theme` + persists.

**#348 — mobile Work tab pulses blue while a build runs.** `.car-tab-workpulse`
(new keyframe, `--phase-build-*` tokens, reduced-motion → static tint) is applied
to the `workboard` tab button only when `!isDesktop && summarize(items).running>0`.

**#349 — mobile "job starting" top drawer.** New `work-activity.tsx`:
`useWorkActivity` subscribes once to the active scope's `onWorkBoardChanged`,
seeds silently on the first frame, and announces a RISING running count as
`justStarted`; `JobStartDrawer` (mounted first child of `.car-app`, mobile-only)
slides down (`--ease-out`, reduced-motion → no slide), auto-retracts after ~3s,
and swipe-up / ✕ dismisses. Tests: `work-activity.test.tsx` (itemRunning; seed vs
announce; per-project filter; drawer render/auto-close/✕). Browser-verified visual.

**#375 — K10: public root `SPEC.md` + Ralph governed mode (world-class refactor
window CLOSED).** The refactor window (`docs/plans/2026-07-02-world-class-refactor-plan.md`)
is complete. K10 introduces the public master `SPEC.md` (governance preamble,
Architecture §2.1-2.8, § Phases → Steps, immutable Decisions Log), removes it from
leak-gate `FORBIDDEN_EXACT` (inverting the RT1 tripwire), repoints the 11
`TODO(K10)` comments, and lifts the window's `resolveRalph=false` override so
`detectRalphMode` governs trident builds whose workspace is a checkout of this
tree (NOT arbitrary user-project `/code`, which build in a fresh SPEC-less
`Projects/<slug>/code` workspace). **Window tail shipped this session:** the
perfect-recall lane (RB1 #361 memory-index / RB2 #363 reflection re-splice / RB3
#369 reflect-cron / RB4 #366 temporal-invalidation, RC1-3 Nexus), the naming lane
(N1 #362 OwnerHandle brand, N2/N3 #367 `internal_handle`→`owner_handle`, N4
#370/#372 `project_slug`→`owner_slug` instance-sense, N5 #368 dir-hygiene, N6 #371
ChannelKind data-migration, N7 #364 ghost-refs, N8 #365 codename glossary), plus
F5/F6/F8/O2-O8/S1-3/X5/X6/W2/W3a and Managed M4/M5/M6. **Owner-adjudicated
decisions:** MG-3 = KEEP (OSS-split composer seam, INVARIANTS #96); N3-credential =
DEFERRED (no live renaming owners → the credential-loss incident can't fire;
INVARIANTS #107). Frozen boundaries (`project_slug` in SQL columns / JWT+healthz
wire keys / `ResolvedAuth` types / published Cores SDK / project-sense work-board)
are intentional, documented.

**#377–#392 — post-window audit punch-list + closeout.** A fresh-eyes audit certified
the window production-solid; its punch-list was fixed: **#377** fail-closed owner-bearer
gate on BOTH upload handlers (single-shot + chunked) for wide binds (a hole in the
S1/S2 fail-closed guarantee — unauthenticated ZIP write on `0.0.0.0`); **#378** wired
`readOwnerTimezone` into the nudge cron (ISSUES #40 read side); **#387** a discriminating
sender-registry propagate regression (INVARIANTS #36/#70; the old test was
non-discriminating); **#388** repointed the 15 importers of the one-release `core-sdk`
shim to `@neutronai/cores-sdk/manifest` + deleted the shim package (52→51 tsconfigs);
**#391** docs reconciliation (plan §17 + STATUS ledgers → git ground truth,
window-CLOSED banner, SPEC §2.2 completed, stale SYSTEM-OVERVIEW/INVARIANTS/AGENTS
pointers + dangling §N citations fixed); **#392** owner-timezone WRITE path closing
ISSUES #40 end-to-end — web + mobile detect the IANA zone (`Intl…timeZone`) and thread
it on every app-ws connect (initial + project-switch + reconnect); the server sanitizes
(trim/64-cap/IANA-validate), gates the persist on the OWNER identity (`user_id ===
OWNER_USER_ID` — a shared-project guest cannot rewrite the owner's zone), and writes via
`writeOwnerTimezone` only on change. Deferred (tracked as GitHub issues #379–#389): the
dead-code cleanup (two careful attempts each hit a dead-but-INTENTIONALLY-RETAINED
landmine — `max-oauth-multi-sub` is Managed-consumed, the wow-moment cluster is reserved
for a queued plan — so an aggressive sweep is contraindicated here) + the known
engineering follow-ups (RA2/F8/P6/O5/F6/Core-scheduler) + W3 transcript unification. A
second fresh-eyes certification audit followed this closeout.

## 2026-07-21 — Executor-mode reminders Task 7: bundled generic read-only example rituals (WIRED + SERVED)

Shipped the first two ENGINE ritual defs so a fresh Neutron install has working
read-only ritual examples out of the box — the ritual plumbing (tasks 2-6, merged
`63fe4119`) went live with ZERO registered defs; this closes that gap while staying
UNAPPROVED (task 8 owns the owner's approval act).

- **Templates** — `reminders/rituals/morning-brief.md` + `reminders/rituals/evening-wrap.md`:
  GENERIC, instance-agnostic read-only prompts that Glob `Projects/*/STATUS.md` from
  the instance root, read them (+ any docs they point at), and post a short digest.
  They are the ENGINE default — NOT Ryan's Vajra ritual content (that is OWNER data
  via import). No `~/vajra`/`gog`/`gh`/`entities`/Telegram/Bash references (static
  half of the ported-prompt silent-no-op guard).
- **`reminders/bundled-rituals.ts`** — `BUNDLED_RITUAL_DEFS` (frozen; exactly
  `morning-brief` + `evening-wrap`, each `scope:'instance'`, `tool_surface:['Read',
  'Glob','Grep']`, `egress:'none'`, `silent:false` — zero intersection with
  `GATED_WRITE_TOOLS`, so the fire-time gate never trips); `BUNDLED_RITUAL_TEMPLATES_DIR`
  + `bundledTemplatePathFor(id)` (module-dir resolved, the `prompt-path.ts` pattern);
  `seedBundledRituals({rituals_dir,log?})` — COPY-IF-ABSENT into `<owner_home>/rituals/`
  (an owner-edited / imported file is NEVER clobbered — from first seed on it is owner
  data), NEVER throws (mkdir + each copy try/catch → log + continue; a failed seed
  surfaces later as a durable `missing_prompt` fire-time skip); `registerBundledRituals(
  registry)` (makes defs KNOWN — does NOT approve them).
- **`open/composer.ts` `ritual_executor_factory`** (was ~:1885) — the closure now
  builds the registry rooted at `<owner_home>/rituals`, `seedBundledRituals(...)`,
  `registerBundledRituals(registry)`, and passes that registry to
  `createRitualExecutor`. So a fresh boot SEEDS + REGISTERS both rituals — WIRED. They
  fire only after the owner's task-8 approval; an unapproved fire lands a durable
  `code_ritual_runs` 'skipped'/'unapproved' row (proven below).
- **Tests** — `reminders/bundled-rituals.test.ts` (11 fast units): def shape incl. the
  no-Bash `GATED_WRITE_TOOLS` pin; template grounding + no-Vajra-isms; seed
  copy-if-absent / idempotency / never-clobber; register→2 frozen defs; the
  UNAPPROVED-by-default fire through the REAL `ApprovalManager` (zero approval rows →
  'skipped'/'unapproved', turn called 0×, nothing spawned); the approved spec-shape pin
  (turn once, tools/prompt-bytes/cwd/timeout/model exact). `reminders/bundled-rituals.e2e.test.ts`
  (`NEUTRON_PTY_E2E=1`-gated, mirrors `dev-channel-pty-bind.e2e.test.ts`): each SHIPPED
  template, run with the real ritual base prompt + read-only surface against a planted
  fixture instance, produces output citing fixture markers (RELAY-4471 / CERT-ROTATE-9 /
  HARBOR-812) — the LLM-behaviour half of the silent-no-op guard. Ran green on this box
  (`claude` 2.1.215, both rituals, ~46s).
- Suites: `bun test reminders/` 327 pass / 2 skip (the gated e2e); wiring guards
  (`build-core-modules-ritual-executor.test.ts`, `open-composition-fields-characterization.test.ts`)
  green; `tsc -p reminders` + `tsc -p open` clean; eslint + dependency-cruiser clean.
- OUT OF SCOPE (later RALPH tasks): scheduling/approval UX (task 8), memory-tier work
  (task 9), SYSTEM-OVERVIEW ritual-executor section (task 10), any writing/Bash ritual
  (stays gated on the OS-sandbox sprint).

## 2026-07-22 — Dogfood fix #429 task 3: drop the manual Build/Research picker; server auto-classifies task_type

Removed the web Work Board add-item Build/Research dropdown and moved the build-vs-research
decision to a single server-side auto-classifier applied on create when the caller omits
`task_type`. Web-only UI change — mobile (`app/app/projects/[id]/workboard.tsx`) already sent
`{ title }` only and carries no dropdown, so it needed no change.

- **New `work-board/task-type-classifier.ts`** — the ONE server-side classification module.
  Exports `classifyWorkBoardTaskType({ title, llm: LlmCallFn | null, timeout_ms? })
  → Promise<WorkBoardTaskType>` (TOTAL — never rejects), `keywordTaskTypeFallback(title)`
  (deterministic: research verbs / interrogative openers → `research`, else `build`),
  `CLASSIFY_SYSTEM_PROMPT`, and `DEFAULT_TASK_TYPE_CLASSIFY_TIMEOUT_MS` (2.5s). LLM-primary:
  a one-word FAST_MODEL classify races a timeout; a `null` llm / timeout / junk / both-or-
  neither / reject all degrade to the keyword fallback. No hardcoded model id — `LlmCallFn`
  carries no model, so the composer injects FAST_MODEL. `work-board/package.json` gains
  `@neutronai/contracts` (bottom dep-cruiser band — legal from work-board's services band).
- **`gateway/http/work-board-surface.ts`** — `WorkBoardSurfaceOptions` gains an optional
  `classify_task_type(title) => Promise<WorkBoardTaskType>`. `handleCreate` classifies ONLY
  when the request omits `task_type`, BEFORE the create_card / store.create branch, so both
  the on-disk-spec path and the plain create persist the classified value. An explicit
  `task_type` from any caller short-circuits (never re-classified); a defensive catch falls to
  the store default ('build') if a wired classifier ever throws. Absent seam → today's
  store-default behavior (the #379 back-compat test is unchanged).
- **`open/composer.ts`** — builds `workBoardClassifyLlm` via
  `buildAnthropicLlmCall({ substrate: llmCallSubstrate, model: FAST_MODEL })` (null on an
  LLM-less box → keyword-only) and wires `classify_task_type` into `createWorkBoardSurface`
  unconditionally (it degrades internally).
- **`landing/chat-react/WorkBoardTab.tsx`** — deleted the `<select className="cwb-add-kind">`,
  the `newTaskType` state + reset, the `WorkBoardTaskType` import, and the create's `task_type`
  arg + deps entry. The add-form is now a plain input + Add; a create omits `task_type`. ▶
  startBuild/startResearch routing (reads the item's stored `task_type`) is untouched.
- **Tests** — new `work-board/task-type-classifier.test.ts`; extended
  `gateway/http/work-board-surface.test.ts` (classify-on-omit across both branches, explicit-
  wins, reject→default, create_card path) and `landing/chat-react/__tests__/work-board-tab.test.tsx`
  (no picker in the add-form; create body omits `task_type`). `bun test work-board` 230 pass,
  `bun test gateway/http/work-board-surface` 38 pass, landing tab+client 37 pass; `tsc` clean
  for work-board / open / gateway / landing; eslint + the new depcruise edge clean. NO FEATURE FLAGS.

## 2026-07-22 — Dogfood fix #429 task 7: research_deep now actually researches — SONNET_MODEL default + parse-failure retry + tools_available grounding gate

**Symptom (verified live).** A `research_deep` task died with an empty brief: the dispatched
sub-agent ran ~31s, made ZERO tool calls, and returned non-JSON prose, so `extractJson` threw
'no JSON object found' and the task failed with no recovery. Two root causes: (1) the sub-agent
defaulted to a hardcoded Haiku literal (`sub-agent.ts` `DEFAULT_SUB_AGENT_MODEL`) and `deep()`
passed no `model`, so Haiku was live in production despite a comment claiming FAST_MODEL was
passed explicitly (false); (2) `deep()` was single-attempt — unlike `start()`'s 2-attempt
parse-error-fed-back loop — so one malformed response discarded the whole research budget.

**Three-part fix (NO FEATURE FLAGS).**
- **Model.** `DEFAULT_SUB_AGENT_MODEL` is now `SONNET_MODEL` (env-overridable via
  `NEUTRON_SONNET_MODEL`), imported from `@neutronai/runtime/models.ts`. Deep research needs
  real reasoning + sustained tool-use discipline. The second hardcoded Haiku literal in
  `research-orchestrator.ts`'s error-path run metadata (was `input.tools !== undefined ?
  'unknown' : 'claude-haiku-...'`) now records `DEFAULT_SUB_AGENT_MODEL` — recording Haiku after
  the switch would be a lie. No `claude-*` literal remains anywhere in `cores/free/research/src`.
- **Retry.** `deep()` is now a 2-attempt loop mirroring `start()`. `bumpAttempt` moved inside
  the loop. A parse / schema / zero-tool failure on attempt 0 feeds specific feedback
  (`buildParseRetryFeedback` / `buildSchemaRetryFeedback` / `ZERO_TOOL_FEEDBACK`) into the
  sub-agent's user prompt behind a new `RETRY_FEEDBACK_MARKER` (`[RETRY - PREVIOUS ATTEMPT
  REJECTED]`, appended AFTER the query so canned-dispatcher `includes(query)` matching keeps
  working; system prompt stays keyed on the original query so the engineering-rider heuristic
  is stable) and retries once. The same failure on attempt 1 is terminal ('parse error on
  retry: …' / 'schema error on retry: …' / 'sub-agent made zero tool calls on retry - ungrounded
  brief rejected'). Dispatch-level errors (concurrency / timeout / transport) still fail
  immediately, NOT retried. Claims-insert + sources-cited assertion stay single-shot (explicit
  non-goal). One `research_sub_agent_runs` row is recorded per attempt.
- **Grounding gate + production-safety seam.** New dispatcher-reported `tools_available` flag
  (`RuntimeSubAgentDispatchResult.tools_available?`, surfaced on `ResearchSubAgentResult`). The
  zero-tool grounding gate rejects a brief made with zero tool calls ONLY when the dispatcher
  reported `tools_available === true`. The v1 production dispatcher
  (`buildRuntimeResearchSubAgentDispatcher`) makes a single tool-less Messages-API call and now
  explicitly reports `tools_available: false`, so the gate is INERT in production and cannot
  brick a real deep run. It arms automatically when the real agentic tool loop ships —
  **plan task 10** (tool-call passthrough) is the follow-up that flips it to `true`.

**De-Haiku.** User-visible strings no longer claim Haiku: `chat-commands.ts` (deep-complete +
kickoff messages), `package.json` `research_deep` tool description ('research sub-agent harness
(SONNET_MODEL default)'), and doc headers across `sub-agent-prompt.ts` / `index.ts` /
`manifest.ts` / `substrate-runtime.ts` / `README.md` / `AGENTS.md`. The two remaining Haiku
mentions (`substrate-runtime.ts` `default_model` doc + `backend.ts` synthesis-fallback doc)
describe FAST_MODEL fallbacks that stay true.

**Files.** `cores/free/research/src/sub-agent.ts`, `.../research-orchestrator.ts`,
`.../substrate-runtime.ts`, `.../chat-commands.ts`, `.../sub-agent-prompt.ts`, `.../manifest.ts`,
`cores/free/research/index.ts`, `cores/free/research/package.json`, `README.md`, `AGENTS.md`.
**Tests.** `__tests__/orchestrator.test.ts` gains a deep-path retry+grounding suite (T1
reproduce-then-fix the live incident; T2 both-non-JSON fail; T3 schema-retry; T4 zero-tool retry;
T5 zero-tool both fail; T6 production-shape do-not-brick guard; T7 concurrency metadata records
`DEFAULT_SUB_AGENT_MODEL`; T8 grounded happy-path single dispatch); `__tests__/sub-agent.test.ts`
gains T9 (default === SONNET_MODEL), T10 (retry_feedback threading), T11 (tools_available
passthrough). `bun test cores/free/research` 193 pass / 2 skip; `tsc -p
cores/free/research/tsconfig.json` clean; `gateway` research-core production-composer +
cores-tool-dispatch guards 23 pass; eslint clean.

---

## 2026-07-22 — task 9 — work-board: generic terminal status transitions clear inline_active

**Root cause (verified live in tenant DB).** A work-board item reaching a terminal status
(`done`/`failed`) via the GENERIC `update()`/`complete()` path left `inline_active=1` — the
completion ack reached Telegram but the card stayed in "inline active" state. The specialized
`attachRun()`/`detachRun()` methods already cleared `inline_active=0` as part of their
run-binding transitions, but the generic path only wrote `inline_active` when the caller's patch
explicitly included it; `complete()` is `update({ status:'done' })` with no `inline_active` key.

**Fix (`work-board/store.ts` `update()`).** Added a `terminalTransition` boolean (computed
inside the transaction callback, after the `current === null` guard, so it safely reads
`current.status`). On any REAL status transition to `'done'` or `'failed'`: (a) suppress the
caller's explicit `patch.inline_active` push (avoids a duplicate SET column) and (b) push
`inline_active = 0` unconditionally. Non-terminal transitions and no-status patches preserve
today's behavior byte-identical. No data backfill for already-corrupt rows (out of scope).
`attachRun`/`detachRun` are NOT consolidated — they have legitimately different run-binding
semantics (Ryan-pinned design).

**Tests (`work-board/store.test.ts`, 4 new reproduce-then-fix tests).** T1 `generic complete()
clears inline_active` (the live bug path — create, set inline_active=true, complete(), assert
status='done' + completed_at not null + inline_active=false both returned AND persisted); T2
`generic update to failed clears inline_active`; T3 `terminal clear wins over explicit
inline_active:true in the same patch`; T4 `non-terminal status transition preserves
inline_active`. All 264 work-board tests pass; `tsc -p work-board` clean; consumer tests (38
gateway/http/work-board-surface + 19 work-board/agent-tool) still pass.

---

## 2026-07-22 — Argus r2 BLOCKER fix — onboarding/interview: patchPhaseState (CAS update-if-present) replaces upsert in live personality suggester

**Root cause (Argus r2 blocker).** `live-personality-suggestions.ts` used
`stateStore.upsert({..., preservePhaseAndTimer:true})` to persist memo picks from the
background personality suggester. While `preservePhaseAndTimer` correctly preserved the live
row's phase and timer when the row existed, it did NOT protect against the race where the row
was admin-reset (deleted) between the background task's re-read and the upsert write: the
absent-row branch of `upsert()` fell into the INSERT path, recreating the row with stale
`phase`/`last_advanced_at` from the stale pre-read snapshot — effectively undoing the admin
reset.

**Fix.** Added `patchPhaseState(owner_slug, user_id, patch)` to the `OnboardingStateStore`
interface (`onboarding/interview/state-store.ts`) with update-if-present / CAS semantics:
always preserves `phase` and `last_advanced_at`; returns **null** and skips the write entirely
when the row is absent (never inserts). Implemented in both `InMemoryOnboardingStateStore`
(atomic in-map update) and `SqliteOnboardingStateStore` (transactional SELECT then conditional
UPDATE, returning null on miss). `live-personality-suggestions.ts` now calls `patchPhaseState`
directly (with the four memo-patch keys), and `LivePersonalityStateStore` now uses
`Pick<OnboardingStateStore, 'get' | 'patchPhaseState'>`. Stale comment about the re-INSERT
fallback replaced with accurate CAS documentation.

**Tests.** Updated `live-personality-suggestions.test.ts` fakeStore to implement
`patchPhaseState` (update-if-present, null on absent row). Converted existing assertions from
tracking `upserts[]` to `patches[]` (patch object now passed directly, no `phase`/`advanced_at`
wrapper). Added new reproduce-then-fix test: "row deleted (admin reset) between re-read and
write → no insert, no throw (CAS skip)" — simulates the race via `setOnGet` (get sees live row)
+ `row=null` (patchPhaseState sees absent row): asserts `patches.length===1` (write attempted)
and `current()===null` (row NOT resurrected). Updated partial-store constructions in
`path1-solicited-upload-starts-job.test.ts` and `build-onboarding-finalize.test.ts` (7 inline
`OnboardingStateStore` objects) to wire `patchPhaseState` through to the real store. 968
onboarding tests + 3761 gateway+onboarding tests pass; `tsc -p onboarding/gateway/open` clean.

## M2 P0 parity — input modalities task 1: attachment→agent threading + PDF documents (2026-07-21)

Scope: `IMPLEMENTATION_PLAN.md` task 1. Attachments (including images) never reached
the agent — `open/wiring/app-ws.ts` read `adapter_metadata.attachments` and dropped
them (its own comment admitted the deeper wiring was a follow-up); `gateway/wiring/
build-live-agent-turn.ts` had zero attachment handling. This builds the threading AND
adds PDF as an accepted chat-upload type. **Images are fixed as a side effect** — they
now reach the agent for the first time.

- **`gateway/http/app-upload-surface.ts`** — `IMAGE_MIME_WHITELIST` → `CHAT_UPLOAD_MIME_WHITELIST`
  (+`application/pdf`; SVG still excluded); `EXT_FROM_MIME` (+`pdf`), `URL_PATH_RE`
  (`…(png|jpg|gif|webp|pdf)`), `mimeFromExt` (+`pdf`). All existing hardening
  (Content-Length pre-check, 10 MiB cap, declared-vs-sniffed cross-check,
  content-addressed storage, per-user GET auth) untouched. NEW exported
  `resolveChatAttachmentLocalPath(owner_home, url)` — pure, syscall-free URL→local-path
  map using the SAME `URL_PATH_RE` (relative OR absolute URL; null for non-matching).
- **`gateway/http/chat-sender-registry.ts`** — `LiveAgentTurnRequest` gains
  `attachments?: ReadonlyArray<string>` (prompt-only; never mutates `user_text`).
- **`gateway/wiring/build-live-agent-turn.ts`** — `BuildLiveAgentTurnInput` gains
  `resolveAttachment?`; new exported `buildAttachmentsFragment(...)` formats a
  `<user_attachments>` block of resolved absolute paths + MIME + a "Read them" line;
  injected on the WARM splice (before the user message) AND the COLD
  `composeFirstTurnPrompt` (before the user message). Unresolvable URL → skipped + warn.
- **`open/wiring/app-ws.ts`** — sanitizes `adapter_metadata.attachments` to non-empty
  strings and passes `attachments` into the `appWsChatTurn({...})` call.
- **`open/composer.ts`** — threads `resolveAttachment: (url) => resolveChatAttachmentLocalPath(owner_home, url)`
  into `buildLiveAgentTurn`.
- **Clients** — web: `uploads.ts` `ACCEPTED_IMAGE_TYPES` → `ACCEPTED_ATTACHMENT_TYPES`
  (+pdf); `ChatApp.tsx` file-input `accept` (+`application/pdf,.pdf`), aria-label
  "Attach file…", `AttachmentImage` non-image → downloadable file chip;
  `message-adapter.ts` routes every attachment through the authed renderer
  (`isImageAttachmentUrl` decides img vs chip). Expo: `app/lib/upload-client.ts`
  `mimeToExt` (+pdf, exported for test).
- **Tests** — `gateway/__tests__/app-upload-surface.test.ts` (PDF accept/spoof/serve+ETag
  + `resolveChatAttachmentLocalPath` units); `gateway/wiring/__tests__/build-live-agent-turn-attachments.test.ts`
  (NEW: cold+warm embed the resolved path, `user_text` unpolluted, unresolvable skipped,
  no-attachments/no-resolver → no block); `gateway/__tests__/m2-chat-upload-attach-production-composer.test.ts`
  (PDF variant threads onto `adapter_metadata.attachments`); web `uploads.test.ts` /
  `message-adapter.test.ts` updated; `app/__tests__/upload-client.test.ts` `mimeToExt` unit.
- Suites: scoped gateway + wiring + open + client tests green; `tsc -p tsconfig.json` clean.
- OUT OF SCOPE (later tasks): voice-note transcription (task 2), `/status` + `/reset`
  chat commands (task 3), office formats beyond PDF, SVG, the import-ZIP path.

### Round-2 hardening (Argus review, 2026-07-21)

- **`landing/chat-react/ChatApp.tsx` — `attachmentBasename` no longer throws on a
  poisoned URL.** It runs during render for every non-image chip; a malformed
  percent-escape (`report%ZZ.pdf`) made `decodeURIComponent` throw `URIError`,
  tripping `ChatErrorBoundary` and blanking the whole chat view — and, since the
  URL persists in history, it recurred on every reload. Now `try/catch` falls back
  to the raw segment. Exported + unit-tested (`__tests__/attachment-basename.test.ts`).
- **`gateway/http/app-upload-surface.ts` — `resolveChatAttachmentLocalPath` hardened.**
  `URL_PATH_RE`'s user_id class matched a dot-only segment (`.` / `..`); now rejected
  outright (`/^\.+$/`) rather than relying on the hex64-filename bound. Added an
  `existsSync` gate so a resolvable-but-missing blob path is never injected into the
  agent prompt. New units cover both.
- **`gateway/wiring/build-live-agent-turn.ts` — Retry re-injects the ORIGINAL
  attachments.** A freeze-timeout Retry (`RETRY_TURN_VALUE`) recovered only
  `lastUserText`, silently dropping the doc/image. New `lastAttachments` map recorded
  alongside `lastUserText`; the recovered turn re-binds `attachments` too. Tests (f)/(g)
  in `build-live-agent-turn-attachments.test.ts` prove the retried prompt re-embeds the
  path (and injects no block when the original had none).

### Round-3 hardening (Argus review round-2, 2026-07-21)

- **BLOCKER — mobile PDFs no longer paint as broken images.** The Expo bubble
  routed EVERY attachment URL through `AuthedAttachmentImage` (a pure RN `<Image>`),
  so a PDF (newly uploadable on mobile in M2) rendered as a broken thumbnail with no
  open affordance — unlike the web file chip. Now `AuthedAttachmentImage` branches on
  `isImageAttachmentUrl(url)`: a non-image renders as `AuthedAttachmentFile`, a
  tappable `📎 <basename>` chip that opens the document (non-authed URLs open
  directly; our bearer-authed `/api/app/upload/…` URLs are fetched WITH the bearer
  then opened — RN-web via an object URL in a new tab, native via a base64 data URL
  handed to `WebBrowser`). Two new plain-TS helpers in `app/lib/attachment-url.ts`
  (`isImageAttachmentUrl`, `attachmentBasename`, both unit-tested, mirroring the web
  client's) drive the branch. This is the mobile analogue of the web file chip; it
  also settles the app side of the "non-image routed as image content-part" semantic
  (the web `message-adapter` note) — the renderer, not the content-part type, decides.
- **`gateway/http/app-upload-surface.ts` — served blobs pin their type.** The GET 200
  now sets `X-Content-Type-Options: nosniff` + `Content-Disposition: inline` so a
  browser never MIME-sniffs a served document into an executable content-type
  (defense-in-depth atop the existing bearer + user-id match; matters now that PDFs
  are served inline). Asserted in the PDF-serve test.
- **`open/wiring/app-ws.ts` — inbound attachment list is deduped + bounded.** New
  exported `sanitizeInboundAttachments(raw)` keeps only non-empty strings, DEDUPS, and
  CAPS at `MAX_INBOUND_ATTACHMENTS` (16) — each survivor drives a downstream
  `existsSync` + `<user_attachments>` prompt line, so a buggy/hostile client can't
  fan out unboundedly. Replaces the inline filter at the receiver; unit-tested.
- **`app/components/ChatSyncSurface.tsx` — native picker mirrors the server whitelist.**
  `DocumentPicker.getDocumentAsync` moved from `type: '*/*'` to the images+PDF+ZIP
  whitelist so the OS picker greys out unsupported files up front instead of letting a
  pick sail through to a raw 415.
- **Real-resolver integration test** (`build-live-agent-turn-attachments-real-resolver.test.ts`):
  seeds a real blob on disk, resolves its URL with the SHIPPED
  `resolveChatAttachmentLocalPath`, and asserts `buildAttachmentsFragment` embeds the
  on-disk path + MIME (and drops a missing blob) — closing the "stub-only resolver"
  coverage gap through the production seam.
- Suites: `app/__tests__/attachment-authed-source.test.ts`, `gateway/__tests__/app-upload-surface.test.ts`,
  `gateway/wiring/__tests__/build-live-agent-turn-attachments-real-resolver.test.ts`,
  `open/__tests__/open-wiring-app-ws.test.ts` green; `tsc` clean (root + `app/`).
- NOT changed (documented-acceptable, single-owner posture): `resolveChatAttachmentLocalPath`
  cross-`user_id` read (one owner; contained by `existsSync` + per-tenant process
  isolation) and the web `message-adapter` routing non-images as `type:'image'` content
  parts (assistant-ui exposes only text|image parts here; the renderer branches on the
  URL, so it is correct in practice).

### CI-green hotfix (PR #428, task 2) — de-pollute process-global react/react-native test mocks

- The canonical `test` job went RED across `a235eea3..141d2c1c` (3 consecutive runs). The
  two new app test files (`app/__tests__/authed-attachment-image-hooks.test.tsx`,
  `app/__tests__/authed-attachment-file-open.test.tsx`) registered process-global NARROW
  `mock.module` payloads for `react` / `react/jsx-runtime` / `react/jsx-dev-runtime` /
  `react-native`. Bun module mocks are process-global and survive across files, so in the
  shared-process CI chunk (`scripts/run-tests.sh`, 75-file chunks) they poisoned later
  files — `SyntaxError: Export named 'useReducer' not found` (docs-mutations-race) and
  `Export named 'Linking' not found` (docs-panes-render), plus `forwardRef is not a
  function` from react-textarea-autosize in the landing suites.
- FIRST ATTEMPT (superset + delegate-to-real react mock) fixed the SyntaxErrors but HUNG
  the CI `test` job (>90 min, never completing). Root cause: a `mock.module('react', …)`
  is process-global in bun and silently replaces `import * as RealReact from 'react'` in
  EVERY later file of the same chunk — including `docs-mutations-race` /
  `diagnostics-pane-render`, which deliberately use REAL react via an injected HookRuntime.
  Even a faithful superset defeats their design and deadlocked chunk 0 (agent-dispatch +
  app files together). Every other test file in the repo AVOIDS mocking react for exactly
  this reason (the "process-global" warnings in `docs-mutations-race.test.ts:52` etc.).
- FINAL FIX (test hygiene only — zero production or assertion changes): ELIMINATE the
  `react` / `react/jsx-runtime` / `react/jsx-dev-runtime` module mocks entirely from both
  files; use REAL react + real jsx. Only `react-native` stays a module mock (bun can't
  parse its Flow source) — kept as a SUPERSET (`Linking` / `useWindowDimensions` /
  `ScrollView` / `TextInput` / `ActivityIndicator` / `Modal`) so it never collides with the
  sibling docs suites' react-native mocks — plus the `expo-*` stubs (so the real expo
  modules never drag unparseable react-native internals into the process).
  `AuthedAttachmentImage` is a hook-free dispatcher, so it runs directly against real react
  (a regression re-adding a hook throws "Invalid hook call" and fails the test loudly).
  `AuthedAttachmentFile` calls `useState`, so `pressChip` installs a minimal hook
  dispatcher on react's current-dispatcher slot
  (`__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H`) around the
  SYNCHRONOUS component call only, then restores it — scoped to this file, no module mock,
  no cross-file pollution.
- Verified locally with gbrain on PATH: the exact CI chunk 0 (7 agent-dispatch + 68 app
  files, the set that hung) now runs 861 pass / 0 fail and EXITS in <1s; both target suites
  green (image 4/0, file 5/0); the 12 branch-changed files in ONE bun process 125/0;
  `bash scripts/ci/typecheck-all.sh` exit 0 (51 tsconfigs).

### Round-2 findings fix (Argus review round-1 on PR #428, 2026-07-22)

- **BLOCKER — native non-authed `data:`/`file:`/`content:` attachments no longer open
  silently-fail.** The file-chip `open()` handler's `bearer === undefined` branch
  (`app/components/AuthedAttachmentImage.tsx`) handed the raw URI straight to
  `WebBrowser.openBrowserAsync` on native — but SFSafariViewController / Chrome Custom
  Tabs reject a non-http(s) INITIAL url, so a `file://`/`content://` (optimistic /
  failed-send local doc bubble — `attachment-url.ts:141-149`) or `data:` URI opened to
  nothing, contradicting the file's own r2-BLOCKER invariant. Fixed with a new
  `openNonAuthedNative(uri, name)` helper: an `http(s)` URL still opens in the in-app
  browser; a `data:` URL is materialized to a cache file (`materializeDataUrlToCache`)
  and a local `file:`/`content:` URL is shared as-is — both routed through
  `Sharing.shareAsync` (the same OS-share path the AUTHED native branch already uses),
  with the rare `!isAvailableAsync()` emulator fallback. Web behavior unchanged (still
  navigates the synchronously-opened tab). Four new regression tests in
  `app/__tests__/authed-attachment-file-open.test.tsx` assert: local `file://` shared
  as-is (never WebBrowser), `data:` materialized-then-shared (never a data: URL to
  WebBrowser), and `http(s)` still opens in WebBrowser.
- **Test hygiene (findings 2 + 3, no production change).** The two attachment test files'
  `react-native` superset mocks now also export `FlatList` / `KeyboardAvoidingView` /
  `TouchableOpacity` (per the sibling-superset convention, so they can never collide with
  a docs-suite RN mock in a shared CI chunk). Removed the vacuous `const useStateCalls = 0;
  expect(...).toBe(0)` always-pass counters from `authed-attachment-image-hooks.test.tsx`;
  the real guard was always the element-TYPE assertions plus the real-react "Invalid hook
  call" throw — the flip test now asserts the exact image/file type sequence across the
  recycle instead of a tautology.
- Verified: both target suites 12/0; the full `app/__tests__/` dir in ONE bun process
  872/0 (the CI-pollution scenario, clean); `tsc --noEmit -p app/tsconfig.json` exit 0.

## M2 P0 parity — input modalities task 3 (partial): `/status` chat command (2026-07-22)

Scope: `IMPLEMENTATION_PLAN.md` task 3, the `/status` half of the narrow Neutron
chat commands (`/status` + `/reset`; NOT the Vajra topic-lifecycle vocabulary).
`/reset` is intentionally NOT shipped this iteration — see the mechanism finding
below.

- **`/status` — deterministic instance snapshot.** New `buildStatusChatCommandFilter`
  (`gateway/boot-chat-command-filters.ts`, re-exported through the
  `gateway/boot-helpers.ts` / `composer-contract.ts` barrel) implements the
  `ChatCommandFilter` contract. `/status` (exact-command word boundary — `/statusfoo`
  falls through to the LLM, K8 grammar precedent) replies with a formatted snapshot:
  active project, current model (`getBestModel()`), pending-reminder count, active
  work-board items, active Trident builds. Pure READ — no mutation, no LLM dispatch.
- **Wiring — one command path, both surfaces.** Chained in `open/composer.ts` into the
  SAME `buildChainedChatCommandFilter([...])` the web onboarding chat AND the app-ws
  chat share (appended after the cores chain + skill-forge). The snapshot is an
  injected thunk; because the source stores (projects reader / reminder store /
  work-board / Trident run store) are constructed LATER in the composer closure, the
  reader is threaded through a `late<T>` two-phase holder (`statusSnapshotHolder`) and
  BOUND right after `workBoardStore` exists. Each source read is best-effort (degrades
  to 0 rather than bricking the command). Filter stays store-free → unit-testable.
- **Tests.** `gateway/__tests__/status-command-wiring.test.ts` (9/0): reply TEXT carries
  every snapshot field value (behavior, not a `toHaveBeenCalled` gap-test); `project_id`
  threaded / omitted correctly; leading-whitespace + trailing-arg tolerance; `/statusfoo`
  + `/statuses` fall through and NEVER run the snapshot thunk; chain-composition proof
  that `/status` is reached after earlier filters disclaim (the real composer shape).
- **`/reset` DEFERRED — verified spec/mechanism mismatch.** The plan named
  `respawnSupervisedSession` as the `/reset` actuation for "fresh agent context; durable
  chat history stays". VERIFIED against the code this is WRONG:
  `runtime/adapters/claude-code/persistent/session-respawn.ts:24` — "respawn ALWAYS
  resumes — never a fresh spawn"; `respawnSupervisedSession` (`supervision.ts:59`) →
  `respawnReplSession(..., true)` → `planRespawn` `--resume`s the SAME transcript,
  PRESERVING context. It cannot deliver a context reset. Shipping `/reset` on that
  primitive would be a no-op-that-looks-like-it-works (banned pattern). The correct
  primitive is the `/clear` PTY reset (`CONTEXT_RESET_COMMAND`, `pool.ts:380`, already
  used for the import warm-session per-turn reset) or a fresh (non-resume) respawn; plus
  a credential-identity-agnostic way to target the live session key (the pool key folds
  `cred.id`, unknown to the filter). Re-scoped in `IMPLEMENTATION_PLAN.md` for a
  follow-up iteration on the corrected mechanism.
- Verified: `bunx tsc --noEmit` exit 0; `gateway/__tests__/status-command-wiring.test.ts`
  9/0.

## M2 P0 parity — input modalities task 5: voice notes (audio upload + Whisper ASR) (2026-07-22)

Scope: `IMPLEMENTATION_PLAN.md` task 5. Audio voice notes (MP3/M4A/WAV) upload on
the SAME chat surface as images + PDF, transcribed at upload-complete by a new
OpenAI-compatible Whisper client, with the transcript injected into the dispatched
prompt AND appended to the scribe text (voice → text → gbrain parity). NO FEATURE
FLAGS — transcription is gated only by `OPENAI_API_KEY` presence (credential config).

- **Whisper client.** New `gateway/transcription/openai-transcription.ts` —
  `createOpenAiTranscriptionClient` POSTs multipart `{base}/v1/audio/transcriptions`
  (default base `https://api.openai.com`, model `whisper-1`, injectable `fetch_impl` +
  `timeout_ms`). Typed `TranscribeResult` with an error taxonomy
  (`http_error`/`network_error`/`timeout`/`bad_response`); NEVER throws, no logging
  inside the client, no retries (v1). `audioFilenameFor` maps the canonical MIME to a
  Whisper-recognized filename extension (`voice.mp3`/`voice.m4a`/`voice.wav`).
- **Upload surface.** `gateway/http/app-upload-surface.ts` — widened
  `CHAT_UPLOAD_MIME_WHITELIST` / `EXT_FROM_MIME` / `URL_PATH_RE` ext-group /
  `mimeFromExt` to audio (`.txt` DELIBERATELY excluded from the GET ext-group so the
  transcript sidecar is never servable). New optional `transcribeAudio` seam;
  handleUpload transcribes an audio blob and writes a content-addressed `<hash>.txt`
  sidecar (atomic tmp+rename, idempotent — sidecar-exists ⇒ the API is NOT re-called;
  ASR failure NEVER fails the upload). `resolveChatAttachmentLocalPath` widened to
  return `transcript` for audio (sidecar read; null when absent), field omitted for
  non-audio.
- **Turn injection.** `gateway/wiring/build-live-agent-turn.ts` `buildAttachmentsFragment`
  embeds an audio attachment's transcript inline (capped 4000 chars with a truncation
  marker); keyless/failed ASR → the graceful "transcription unavailable — set
  OPENAI_API_KEY" note. Splice sites + `turn.user_text` untouched.
- **Scribe threading.** `open/wiring/app-ws.ts` — new `attachmentTranscript` deps seam;
  the receiver appends resolved transcripts to the `scribeOnUserTurn` text only
  (`user_text` stays unmutated). Composer wires it over `resolveChatAttachmentLocalPath`;
  `open/composer.ts` builds the `transcribeAudio` seam from `OPENAI_API_KEY` (keyless ⇒
  no seam, audio still uploads without a transcript).
- **Clients.** Web accept attr + `ACCEPTED_ATTACHMENT_TYPES` (+ alias forms) + 🎵 chip
  (`message-adapter.ts` `isAudioAttachmentUrl`); native Expo picker mime array +
  `mimeToExt` audio cases + 🎵 chip (`attachment-url.ts` predicate).
- Verified: `bunx tsc --noEmit` exit 0. Tests:
  `gateway/transcription/__tests__/openai-transcription.test.ts` 7/0;
  `gateway/__tests__/app-upload-surface.test.ts` 30/0 (incl. artifact-on-disk sidecar +
  idempotency call-count + keyless-no-sidecar + `.txt`-unreachable);
  `gateway/wiring/__tests__/build-live-agent-turn-attachments.test.ts` 11/0;
  `open/__tests__/open-wiring-app-ws.test.ts` 20/0 (scribe transcript threading);
  `app/__tests__/upload-client.test.ts` 12/0;
  `landing/chat-react/__tests__/message-adapter.test.ts` 12/0.
