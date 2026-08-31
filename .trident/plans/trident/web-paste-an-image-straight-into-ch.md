# IMPLEMENTATION_PLAN — web chat: paste an image to attach it (Plan card 0093af45)

Scope: `landing/chat-react/` ONLY — the React SPA served at `/chat`. NOT `app/` (Expo mobile; mobile paste is not this card). Spec: this Plan card's doc. Base: main @ 187a9209.

State of the world, verified against the code 2026-08-31:

- [x] `handleFiles` funnel in `ChatSurface` (`landing/chat-react/ChatApp.tsx` ~1733) — splits export ZIPs to the history-import endpoint vs everything else to `draft.addFiles`, with the clear no-affordance ZIP error. Already built.
- [x] Surface-wide drag-and-drop routed into `handleFiles` (`onDrop` ~1789, `dragProps` ~1801). Already built.
- [x] Paperclip picker routed into `handleFiles` (`<Composer … onFiles={handleFiles}>` ~1918). Already built.
- [x] Attachment limits + error surfaces (`uploads.ts` pre-flight: 10 MiB cap + MIME allow-list → chip `error` state via `useAttachmentDraft`). Already built; paste inherits them for free by riding the funnel.
- [x] **Paste-to-attach (THIS iteration)**: a document-level `paste` listener owned by `ChatSurface`, gated to the visible surface, routing clipboard `File`s into the existing `handleFiles` funnel. Plain-text paste untouched (no `preventDefault`, no interference); a text+image paste attaches the image AND lets the text insert; blank clipboard filenames get synthesized stable names; multiple images in one paste all attach; `addAttachmentOnPaste={false}` pinned on `ComposerPrimitive.Input` so assistant-ui's built-in (currently inert) paste path can never become a second attachment path. Component tests in `landing/chat-react/__tests__/paste-attach.test.tsx` asserting observable draft state, including the non-vacuous plain-text-untouched test.

Non-goals (explicitly out of this card): anything under `app/`; widening the paperclip `accept` list; any change to drag-and-drop or picker behavior; a parallel attachment path; unconditional `preventDefault` on paste.
