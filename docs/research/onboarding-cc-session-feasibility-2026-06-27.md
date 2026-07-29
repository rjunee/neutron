# Onboarding → CC-session rearchitecture: feasibility map (2026-06-27)

Forge recon for the "rearchitect onboarding to run as a Claude Code session" brief
(BUG 0) plus the six React chat regressions (BUG 1,2,3,4,5,7).

## TL;DR

- **BUG 0's literal mechanism ("persist structured onboarding data via a TOOL the
  session calls" / "trigger import via a TOOL") is BLOCKED on unbuilt infra.** A
  live CC session today can only call **built-in** CC tools (Read/Glob/Grep). There
  is no transport by which a spawned CC REPL subprocess can invoke a custom
  server-side tool handler.
- The six React regressions (BUG 1,2,3,4,5,7) are **fully unblocked** and are the
  bulk of the dogfooding pain. Shipping those verified first.

## Evidence — custom tools cannot reach the live CC session

| Claim | File:line |
|---|---|
| CC adapter takes only `t.name` from `spec.tools` | `runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts:1483` |
| `--tools` is a built-in allow-list (names joined) | `runtime/adapters/claude-code/persistent/build-repl-argv.ts:83-86` |
| Live agent tool surface is `['Read','Glob','Grep']`; write-tools + Cores MCP **deferred** until the external MCP transport exists | `gateway/realmode-composer/build-live-agent-turn.ts:84-94` |
| Spawned REPL `--mcp-config` wires only the dev-channel MCP server | `runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts:1452-1472` |
| Gateway ToolRegistry MCP server is in-process-only; stdio/socket transport deferred to "P1 S5+" | `mcp/server.ts:1-11` |

→ A `save_onboarding_profile` / `trigger_import` tool **executed by our code** is not
invokable from the onboarding CC session without first building the per-instance
external MCP transport (a substantial infra prerequisite the repo explicitly defers).

## Onboarding turn routing today (the dual path to collapse)

- `open/composer.ts:1373` `isOnboardingActive()` — no state row OR phase not in
  {completed,failed} → onboarding engine; else live agent.
- Inbound text: `open/composer.ts:1522-1525` → `advanceOnboardingText` → `engine.advance`.
- Button choice: `open/composer.ts:1589-1618` → `advanceOnboardingChoice` / live agent.
- Session open: `open/composer.ts:1576-1585` → `engine.start()` re-emits the active prompt.
- Freeform classify (the 6s-timeout culprit): `engine.ts:2796` → `llm-router.ts`
  (`buildLlmRouter().route`), Haiku 6000ms (`llm-timeouts.ts:286`). Timeout fallbacks:
  pick-only "tap one of the buttons" (`llm-router.ts:1330`); low-confidence
  "did you mean…" (`llm-router.ts:1286`); freeform-allowed advances with `__freeform__`
  (`llm-router.ts:1342`).
- Conversational flag `NEUTRON_ONBOARDING_CONVERSATIONAL`: default-ON
  (`runtime/onboarding-conversational-flag.ts:55-57`); the router is "the single
  freeform/extraction engine" — removing it requires replacing its extraction role.

## Steady-state live CC session (what onboarding should become)

- `gateway/realmode-composer/build-live-agent-turn.ts` — warm persistent CC REPL,
  per-(instance,topic) keyed via `metering_context.project_id`; system prompt sent on
  the FIRST turn only (`composeFirstTurnPrompt`), `assembleSystemPrompt(...)`.
- Fire-and-forget post-turn hook that runs OUR code and never gates the reply:
  `build-live-agent-turn.ts:470-489` (`reflection.onTurnComplete`). This is the seam
  that can replace the router's extraction role WITHOUT reintroducing turn-gating.

## Recommended BUG 0 approach (no new infra)

Route onboarding turns through the **same** `appWsChatTurn` (live CC session), inject
an onboarding-checklist system-prompt fragment while required fields are missing, and
replace the per-turn router-LLM with a **fire-and-forget post-turn extractor** (reuse
`onboarding/interview/extract-agent-name.ts` / `extracted-fields.ts`) that persists
name/persona to the existing `OnboardingStateStore` without ever blocking the reply.
Auto-fire the first turn on connect (BUG 1). Trigger import via the existing
`POST /api/upload/<source>` endpoint (`gateway/upload/import-upload-handler.ts:224`),
not a tool. Mark onboarding complete when required fields are collected → seamless
steady-state. This kills the 6s-timeout "didn't quite catch that" symptom (no per-turn
classify call) and removes the flag + router from the live path (no dual path).

The literal "tool the session calls" spec is the alternative; it requires building the
external MCP write-tool transport first (out of scope for a single PR).

## History-import backend (BUG 4 — already exists)

- `POST /api/upload/<source>` (`source` ∈ {chatgpt,claude}) →
  `gateway/upload/import-upload-handler.ts:224` `handleImportUpload`: ZIP magic-byte
  check, writes `<owner_home>/imports/<source>.zip`, `engine.notifyImportUpload(...)`.
- Parsers: `onboarding/history-import/chatgpt-export.ts:81`,
  `claude-export.ts:52`; runner start `engine-import-routing.ts:2147`.
- Reference image-upload surface: `gateway/http/app-upload-surface.ts:167`
  `POST /api/app/upload`. Client wires to the import route, not the image route.
</content>
</invoke>
