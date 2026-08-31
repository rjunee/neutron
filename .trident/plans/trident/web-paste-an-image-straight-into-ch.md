# IMPLEMENTATION_PLAN — web chat: paste an image to attach it (Plan card 0093af45)

Scope: `landing/chat-react/` ONLY — the React SPA served at `/chat`. NOT `app/` (Expo mobile; mobile paste is not this card). Spec: this Plan card's doc. Branch: `trident/web-paste-an-image-straight-into-ch`, one commit ahead of origin/main (base 6422ef36): feature commit 8e21b3e15429cf5ea80200a2ea3b2f6952155166.

State of the world, re-verified against the committed branch tip 2026-08-31 (planner ran the suites in a clean scratch checkout of 8e21b3e1):

- [x] `handleFiles` funnel in `ChatSurface` (`landing/chat-react/ChatApp.tsx`) — splits export ZIPs to the history-import endpoint vs everything else to `draft.addFiles`, with the clear no-affordance ZIP error. Pre-existing.
- [x] Surface-wide drag-and-drop and the paperclip picker routed into `handleFiles`. Pre-existing; unchanged by this card.
- [x] Attachment limits + error surfaces (`uploads.ts` pre-flight: 10 MiB cap + MIME allow-list → chip `error` state via `useAttachmentDraft`). Pre-existing; paste inherits them by riding the funnel.
- [x] Paste-to-attach implementation (commit 8e21b3e1): document-level `paste` listener owned by `ChatSurface` (React `onPaste` on `<main>` provably cannot see a focus-on-body paste), gated on `mainRef.current.closest('[hidden]') === null` so kept-alive hidden surfaces sharing the one draft do not multi-attach; clipboard `File`s collected via `items` with a `files` fallback and routed into the EXISTING `handleFiles` funnel; text-only paste returns WITHOUT `preventDefault()`; text+image paste attaches the image and lets the text insert (no `preventDefault`); only an image-only paste is defaulted away; blank clipboard filenames get synthesized stable `pasted-N.png` names (duplicates stay distinct — the draft keys items by generated id); multiple images in one paste all attach; `addAttachmentOnPaste={false}` pinned on `ComposerPrimitive.Input` (prop confirmed present in installed @assistant-ui/react 0.14.23, and `false` short-circuits its handler entirely) so the library's currently-inert paste path can never become a second attachment route.
- [x] Component tests `landing/chat-react/__tests__/paste-attach.test.tsx` (4 tests): real `paste` ClipboardEvents dispatched on `document.body` (the focus-on-page case) asserting observable draft state — blank-name synthesis + no-collision across consecutive pastes and within one two-file paste; the plain-text case asserting draft UNCHANGED and `defaultPrevented === false`, proved non-vacuous by attaching an image on the same mount right after; the text+image case; the hidden-surface gate.
- [x] Planner-side verification of tip 8e21b3e1 (2026-08-31, clean scratch checkout, bun 1.3.13): `bun test landing/chat-react/__tests__/paste-attach.test.tsx` → 4 pass / 0 fail; `bun test` attachments.test.tsx component.test.tsx uploads.test.ts stable-mount.test.tsx attachment-basename.test.ts → 49 pass / 0 fail; `bun test` activity-inspector-panel chat-rail-stability pane-error-isolation pane-switch-no-crash project-shell render-isolation switch-render-cost → 56 pass / 0 fail; `bun x tsc -p landing/chat-react/tsconfig.json` → clean; `bun x eslint` on ChatApp.tsx + paste-attach.test.tsx → clean; purity → zero tenant paths in the commit (message + diff).
- [x] T-final (close-out): in the branch worktree, re-run the verification battery, append a "Verification receipts" section to `.trident/plans/trident/web-paste-an-image-straight-into-ch.md`, and land ONE docs-only commit on top of 8e21b3e1 (never amend/rebase it; `landing/chat-react/ChatApp.tsx` and `landing/chat-react/__tests__/paste-attach.test.tsx` stay byte-identical to 8e21b3e1), then push.

Non-goals (explicitly out of this card): anything under `app/`; widening the paperclip `accept` list; any change to drag-and-drop or picker behavior; a parallel attachment path; unconditional `preventDefault` on paste; staging a `.trident/as-built/` entry (feature branches do not carry one — folding is pipeline-side).

## Verification receipts (2026-08-31, close-out on tip 8e21b3e1)

- `bun test landing/chat-react/__tests__/paste-attach.test.tsx` — 4 pass / 0 fail
- neighbor suites (attachments, component, uploads, stable-mount, attachment-basename) — 49 pass / 0 fail
- ChatApp-mounting suites (activity-inspector-panel, chat-rail-stability, pane-error-isolation, pane-switch-no-crash, project-shell, render-isolation, switch-render-cost) — 56 pass / 0 fail
- `bun x tsc -p landing/chat-react/tsconfig.json` — clean
- `bun x eslint landing/chat-react/ChatApp.tsx landing/chat-react/__tests__/paste-attach.test.tsx` — clean
- purity: `git show 8e21b3e1` and the close-out commit contain zero tenant filesystem paths
