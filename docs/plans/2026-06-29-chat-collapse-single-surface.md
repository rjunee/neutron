# Chat collapse → ONE Telegram-grade native surface

**Date:** 2026-06-29 · **Branch:** `forge/chat-collapse` · **Base:** main `eee0229`

## Directive
Collapse the Expo app's TWO chat surfaces into ONE best-in-class, Telegram-grade
surface. Keep `ChatSyncSurface` (durable chat-core transport: offline send,
gap-free resume, reactions/edits/receipts/typing, instant cold-open). Bring it to
FULL parity with the legacy `chat.tsx`, make it the single Chat tab, and DELETE the
legacy path entirely. No dual path, no feature flags, no half-measures.

## Audit result — the two surfaces are complementary halves
- **`chat.tsx` (legacy)** owns: the composer (InputComposer: 📎 picker, paste, web
  file-input, hint, char-counter, Cmd-Enter), the upload pipeline (upload-client +
  upload-gate + UploadModal), web drag-drop (DropZoneOverlay), upload-affordance
  gating, and rich agent-message rendering (markdown, attachments/images, citations,
  doc-refs, option buttons / image-gallery, retry, deep-link nav). Transport =
  legacy `AppWsClient` + `chat-state` reducer (NO durable store).
- **`ChatSyncSurface` (keeper)** owns: durable chat-core transport (op-sqlite /
  InMemory fallback on web), FlashList v2, optimistic/offline send, delivery ladder,
  read receipts, reactions, edits/deletes, typing, gap-fill resume. Composer is
  text-only; agent messages render as PLAIN TEXT (no markdown/attachments/options).

Collapse = port chat.tsx's input/upload/render half INTO ChatSyncSurface, then delete
the legacy transport stack.

## Critical data-model gap
chat-core's `ChatMessage` already models `options/prompt_id/allow_freeform/kind/
upload_affordance` and `normalizeInbound` parses them — BUT `SqliteChatStore` has no
columns for them, so on native they are dropped before render (option buttons don't
survive even live). `citations/image_urls/doc_refs/deep_link` aren't in the model at
all. The server envelope (`ws-envelope.ts`) already carries all of these — no server
change needed; we extend the client durable model to preserve + render them.

## Plan

### Phase A — chat-core durable model (carry + persist agent metadata)
1. `chat-core/types.ts`: add to `ChatMessage` + `InboundChatMessage`: `image_urls`,
   `citations` (`{title,url}[]`), `doc_refs` (`{label,url,project_id,path}[]`),
   `deep_link`. Add `parseCitations`/`parseDocRefs` + extend `normalizeInbound`.
2. `chat-core/store.ts` `mergeMessage`/`pickAgentMeta`: include the new immutable
   fields (incoming-wins, additive — same contract as `options`).
3. `app/lib/chat-core/sqlite-store.ts`: add columns + idempotent `ensureColumn`
   migrations + `write` + `rowToMessage` for `options, prompt_id, allow_freeform,
   kind, upload_affordance, image_urls, citations, doc_refs, deep_link` (JSON TEXT).
4. `chat-core/stores/opfs-store.ts`: mirror the same columns (shared Store contract).
5. Tests: extend sqlite-store + render-model + mobile-session round-trip coverage.

### Phase B — session: chooseOption
6. `MobileChatSession.chooseOption(prompt_id, choice_value, freeform?)` → sends
   `{v:1,type:'button_choice',...}`. Expose via `useMobileChat`.

### Phase C — surface render + composer parity (ChatSyncSurface)
7. ChatRow agent render: `RenderMarkdown` body, `AuthedAttachmentImage` for
   `attachments`+`image_urls`, `CitationChipRow`, doc-ref buttons, `ButtonOptionRow`/
   `ImageGalleryRow` for options, retry affordance — preserving reactions/edits/
   receipts/delivery ticks already present.
8. Deep-link nav: a chat-core-typed `dispatchUnseenDeepLinks` fired from rows.
9. Composer: reuse `InputComposer` + extracted `useUploadState` + `UploadModal` +
   `DropZoneOverlay` + web drag-drop + `useLatestUploadAffordance` gating; support
   `prefill`/`autosend` launcher params.

### Phase D — route + tab collapse + deletions
10. Rewrite `chat.tsx` as the single thin route rendering the collapsed surface.
11. Delete `chat-sync.tsx`; drop `'chat-sync'` from `NON_TAB_SUBROUTES`.
12. DELETE legacy: `MessageItem`, `ConnectionBanner`, `chat-state`, `chat-streaming`,
    `ws-client` (legacy), `chat-deep-link-navigator`, `chat-deep-link-dispatch` (+ tests).

### Phase E — verify
13. `tsc` (leaf tsconfigs) + `bun test` (app + chat-core) + `scripts/ci/leak-gate.sh`
    SILENT + fresh isolated instance e2e (send/receive real turn, ZIP, image,
    attachment render, offline+reconnect, reaction+edit, typing) + grep proves no
    dangling import of deleted modules. Update SYSTEM-OVERVIEW.md + AS_BUILT + STATUS.

## Known parity note
Legacy `ConnectionBanner` had an `auth_failed` → sign-out affordance; chat-core
`ConnStatus` has no `auth_failed`. The collapsed `StatusStrip` shows "Disconnected"
on auth failure. Flagged, not silently dropped.
