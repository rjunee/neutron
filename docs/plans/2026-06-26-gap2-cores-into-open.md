# Parity Gap #2 — Compose the free Cores into the Open boot path

**Date:** 2026-06-26
**Branch:** `forge/gap2-cores-into-open`
**Parity source:** `docs/research/vajra-neutron-feature-parity-scan-2026-06-25.md` §5 gap #2 (line 97, 180) + the gap-#6 forge's repo-wide chat-command-filter finding.

## SPEC-CONFORMANCE DIFF (the deliverable)

### SPEC / parity says
The free Cores (Calendar / Email / Google-Workspace + Research) work in the Open
single-owner daily-driver — composed into `open/composer.ts` as **backend +
chat-command filter + MCP tools**, sharing ONE backend per Core (agent-native
parity), Google ones optional-until-credentialed, Open still boots with zero creds.

### CURRENT (cited, read this run)
- `open/composer.ts:1052-1122` — the composer's returned `CompositionInput` sets
  scribe / reflection / doc-search / reminders / trident / agent-dispatch, but
  **never sets the `cores` field** → `buildCoreModules` (`gateway/composition/build-core-modules.ts:535`)
  skips the cores module → `installBundledCores` never runs in Open → **no Core
  MCP tools register**. Confirmed: grep of `open/composer.ts` for `cores:` /
  `buildCoresBackendFactories` / `installBundledCores` = empty.
- `gateway/boot-helpers.ts:753` `buildCoresBackendFactories` and `:527`
  `buildChainedChatCommandFilter` + `:702` `buildCalendarChatCommandFilter` +
  `:563` `buildRemindersChatCommandFilter` are EXPORTED but only **re-exported**
  by `gateway/index.ts:38-44` — the only real call sites live in the carved-out
  `neutron-managed` repo (`composeProductionGraph` is Managed). In `neutron-open`
  they are dead.
- `gateway/realmode-composer/build-landing-stack.ts:86-721` (`BuildLandingStackInput`)
  has **no `chatCommandFilter` param**, and `gateway/http/chat-bridge.ts` (the Open
  web-chat path) has **no pre-dispatch slash-command interception** — grep for
  `chat_command_filter`/`ChatCommandFilter` in both = empty. The `chat_command_filter`
  seam exists ONLY on the Expo `createAppWsSurface` (`gateway/http/app-ws-surface.ts:149,658-666`),
  which the Open composer does not mount. So `/cal`, `/email`, `/research`, `/remind`
  typed into the Open web chat fall straight through to the LLM — **never routed to
  a Core**.

### GAP
1. The un-composed Core backends (Calendar / Email / Google-Workspace / Research)
   — `composition.cores` is unset in Open.
2. The chat-command-filter chain is not wired into the Open web-chat path at all
   (repo-wide: every free Core declares a `ChatCommandFilter` but nothing chains
   them into `buildLandingStack`/`chat-bridge`).

### THIS BUILD
- **Add a `chatCommandFilter` seam to the Open web-chat path** (mirrors the Expo
  app-ws surface): `buildWebChatBridge` gains an optional `chatCommandFilter`;
  `buildLandingStack` threads it; the chat-bridge calls `.match()` at the top of
  the `user_message` handler and short-circuits to an `agent_message` reply when a
  Core claims the command. This is the general fix (chain ALL bundled free-Core
  filters), not one-off.
- **Compose the Cores into Open** via a new `mountOpenCores(...)` helper
  (`gateway/cores/mount-open-cores.ts`) that REUSES the Managed mechanism:
  `buildCoresBackendFactories(...)` for the backend map (→ `composition.cores.backends`
  → `installBundledCores` registers each Core's MCP tools) AND the same Core
  chat-command filters chained via `buildChainedChatCommandFilter([...])`, sharing
  one backend per Core (the pre-built `calendarClient` seam + one
  `EmailProjectCacheResolver` + the Research `project_backend`).
- **Optional-until-credentialed:** a Google OAuth `OAuthTokenManager` over a
  per-instance `SecretsStore`. When `NEUTRON_CORES_GOOGLE_CLIENT_ID` is absent the
  `googleOAuthAccessToken` accessor is `null` / `emailOAuthTokens` is `undefined` →
  the factories + filters use the in-memory Calendar/Gmail/Workspace clients →
  `/cal`/`/email` dispatch against an empty calendar/inbox (graceful "nothing yet",
  never a hard error). With a connected grant the same wiring goes live with zero
  further changes.

### OUT OF SCOPE
- The Managed `/api/cores` admin HTTP surfaces (OAuth-connect UI) — they need the
  bearer-token `AppWsAuthResolver` + identity-host config and are a separate
  surface concern. Optional-cred graceful behavior + the "with OAuth → live" path
  are fully met (and tested) without the connect UI; noted as follow-up.
- Building NEW Cores; paid Cores; Managed provisioning.

## INVARIANTS HELD
- No feature flags; Open boots with zero creds (per-Core install is fail-soft —
  `gateway/cores/install-bundled.ts:167-247` try/catch per Core).
- Reuse the Managed mechanism (`buildCoresBackendFactories` /
  `buildChainedChatCommandFilter`) — no parallel Open-only Core system.
- Agent-native parity: the MCP tools and the chat-command filter share ONE backend
  instance per Core.

## TEST PLAN
- `gateway/cores/__tests__/mount-open-cores.test.ts` — the helper builds a backend
  map containing `calendar_core`/`email_managed_core`/`google_workspace_core`, and
  a chained filter where `/cal` and `/email` and `/remind` each return non-null
  (routed) while plain prose returns null (falls through to the agent).
- Optional-cred: with no OAuth the helper builds (in-memory clients), the filter
  still routes `/cal` to an empty-calendar reply, and nothing throws; with an
  injected OAuth access-token accessor the calendar backend is the Google client.
- `gateway/http/chat-bridge` test — a `/cal` user_message short-circuits to an
  `agent_message` and does NOT reach the live-agent / engine path.
- `open/composer` test — a built Open composition exposes `cores` with a backend
  map and a landing stack wired with the chained filter.
