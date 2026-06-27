# P1b consolidate — ONE chat endpoint (onboarding unified) + web admin panel + Playwright gate

Branch: `fix/wire-open-app-surfaces` (PR #84). NO feature flags. ONE code path. All-in-Open.

## Architecture (verified by recon, file:line)

- Onboarding `InterviewEngine` keys state on `(project_slug, user_id)` — transport-agnostic.
  State table `onboarding_state`; phase machine in `onboarding/interview/phase.ts`. Terminal =
  `completed` | `failed`.
- Engine emits prompts via a single injected `sendButtonPrompt: SendButtonPromptFn`
  (`engine-internals.ts:1292`), built by `buildRoutedSendButtonPrompt({ webRegistry })`
  (`chat-bridge.ts:641`) which routes by `topic_id` prefix: `web:` → web registry, `tg:` → telegram.
- App-ws wire envelope `AppWsOutboundAgentMessage` (`channels/adapters/app-ws/envelope.ts:196`) is
  ALREADY a superset: `options[]`, `prompt_id`, `allow_freeform`, `kind`, `upload_affordance`.
  `adapter.outgoingToEnvelope` (`adapter.ts:695`) already maps `inline_choices`→`options` and
  `adapter_options.{prompt_id,kind,allow_freeform,upload_affordance}`.
- App-ws inbound decoder (`envelope.ts:379`) only accepts `user_message` today.
- React client (`landing/chat-react/`) connects to `/ws/app/chat` and renders NO buttons;
  `chat-core` `normalizeInbound` strips the option metadata. Expo app (`app/lib/button-primitives.tsx`,
  `app/components/MessageItem.tsx`) is a working reference impl.
- `/ws/chat` (legacy onboarding/vanilla socket) lives in `landing/server.ts:1315-1729`, driven by
  `chat-bridge` (`startSession`/`handleInbound`/`resumeCookieSession`). `buildLandingStack` builds the
  engine + stores and is reused by Open — KEEP it; only delete the WS transport + vanilla client.

## Plan

### A. Server: drive onboarding over `/ws/app/chat` (one engine, one path)
1. `channels/adapters/app-ws/envelope.ts`: add `AppWsInboundButtonChoice`
   `{ v:1, type:'button_choice', prompt_id, choice_value, freeform_text? }` + `decodeAppWsButtonChoice`
   (separate decoder, like resume/receipt). Bound lengths.
2. `chat-bridge.ts buildRoutedSendButtonPrompt`: accept optional `appWsRouter: { send?: SendButtonPromptFn }`
   holder; route `app:` prefix → `appWsRouter.send`. Same for `buildRoutedSendImportProgress`
   (import-progress reroute) so onboarding import progress reaches the app-ws socket.
3. `build-landing-stack.ts` (+ buildOnboardingStack): thread optional `appWsButtonPromptRouter` +
   `appWsImportProgressRouter` holders into the engine's senders.
4. `gateway/http/app-ws-surface.ts createAppWsSurface`: add optional
   `onSessionOpen?(ctx)` (fired after session_ready) and `onButtonChoice?(ctx)` hooks; decode
   `button_choice` in the message handler and dispatch to `onButtonChoice`.
5. `open/composer.ts`:
   - Fill `appWsButtonHolder.send` = translate `ButtonPrompt` → `OutgoingMessage`(inline_choices +
     adapter_options) → `adapter.send` (so the full envelope with options reaches the client).
   - `onSessionOpen`: if `stateStore.get(project_slug, user_id)` non-terminal → `engine.start({ topic_id: app:<user>, signup_via:'web', ... })`.
   - inbound `user_message`: if onboarding non-terminal → `engine.advance({ freeform_text })`; else `appWsChatTurn` (existing).
   - `onButtonChoice`: if onboarding → `engine.advance({ choice })`; else resolve to text → `appWsChatTurn`.
   - Fix `sendReply` to carry options/prompt_id/allow_freeform for steady-state live-agent buttons (parity).

### B. Client: render onboarding buttons + upload affordance (chat-react + chat-core)
1. `chat-core/types.ts`: add `options/prompt_id/allow_freeform/kind/upload_affordance` to
   `InboundChatMessage` + `ChatMessage`; preserve in `normalizeInbound`.
2. `controller.ts`: add same to `RenderMessage`; copy in `computeVm`; add `onChoose(value, prompt_id)`
   that sends a `button_choice` frame + marks chosen.
3. `WebChatSession`/ws-client: `sendButtonChoice(prompt_id, choice_value)`.
4. `ChatApp.tsx`: `ButtonOptionRow` (mirror `app/lib/button-primitives.tsx`) rendered under agent body.
5. `useAttachmentDraft`/composer: honour `upload_affordance` (ZIP import phases).

### C. Web admin panel (independent)
`integrations-client.ts` + `IntegrationsTab.tsx` over GET `/api/cores/integrations` +
POST/DELETE `/api/cores/api-keys/<label>`. Register an `admin` builtin tab (ProjectShell dispatcher +
server tab registry). Route: Admin tab in the project tab bar.

### D. Delete `/ws/chat`
Remove the `/ws/chat` upgrade + WS handlers in `landing/server.ts`; drop the landing WS from the
compose multiplex; remove the vanilla `chat.ts`/`boot.ts` client + `chat-react.html` flagged dual path;
keep `buildLandingStack` (engine/stores/HTTP). Update/delete ~25 referencing files + tests.
grep must prove `/ws/chat` gone.

### E. Playwright real-browser E2E
Headless Chromium vs `http://127.0.0.1:7800`: mint start token → load `/chat` → fresh onboarding via
clicking real buttons → steady-state reply renders → Documents tab shows a doc → Admin tab shows
integrations. Run vs `~/neutron/core` on this branch (checkout, `launchctl kickstart -k`, run, restore main).
Commit as a regression guard (CI-skippable without a live server).

### F. Tests/docs/review/PR
`tests/open-contract.test.ts`, AS-BUILT.md, SYSTEM-OVERVIEW.md. Full suite. PR #84 push →
`/ce:review` + `codex-review.sh main` → POST `/forge/delivered`.
