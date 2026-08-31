# IMPLEMENTATION_PLAN — web chat: paste an image to attach it (Plan card 0093af45)

Scope: `landing/chat-react/` ONLY — the React SPA served at `/chat`. NOT `app/` (Expo mobile; mobile paste is not this card). Spec: this Plan card's doc. Branch: `trident/web-paste-an-image-straight-into-ch`, based on 6422ef36. Feature commit 8e21b3e15429cf5ea80200a2ea3b2f6952155166, plus the review-round fix commits recorded below (round 2 corrected the interception rules; round 3 added the paste-target gate) — the checklist entries below describe the state at the commit each names, and the later Round sections supersede them.

State of the world, re-verified against the committed branch tip 2026-08-31 (planner ran the suites in a clean scratch checkout of 8e21b3e1):

- [x] `handleFiles` funnel in `ChatSurface` (`landing/chat-react/ChatApp.tsx`) — splits export ZIPs to the history-import endpoint vs everything else to `draft.addFiles`, with the clear no-affordance ZIP error. Pre-existing.
- [x] Surface-wide drag-and-drop and the paperclip picker routed into `handleFiles`. Pre-existing; unchanged by this card.
- [x] Attachment limits + error surfaces (`uploads.ts` pre-flight: 10 MiB cap + MIME allow-list → chip `error` state via `useAttachmentDraft`). Pre-existing; paste inherits them by riding the funnel.
- [x] Paste-to-attach implementation (8e21b3e1, corrected in round 2): document-level `paste` listener owned by `ChatSurface` (React `onPaste` on `<main>` provably cannot see a focus-on-body paste), gated on `mainRef.current.closest('[hidden]') === null` so kept-alive hidden surfaces sharing the one draft do not multi-attach; clipboard IMAGE files collected via `items` with a `files` fallback and routed into the EXISTING `handleFiles` funnel; anything that is not `image/*` (text, HTML, a copied `.pptx`, a copied `.zip`) is left entirely alone; `preventDefault()` fires only for an image paste carrying NO `text/*` flavour at all, so an image + `text/html` caption still inserts its text; blank and generic `image.png` clipboard names get synthesized stable `pasted-N.<ext>` names (structured MIME suffixes dropped: `image/svg+xml` -> `.svg`); multiple images in one paste all attach; `addAttachmentOnPaste={false}` pinned on `ComposerPrimitive.Input` (prop confirmed present in installed @assistant-ui/react 0.14.23, and `false` short-circuits its handler entirely) so the library's currently-inert paste path can never become a second attachment route.
- [x] Component tests `landing/chat-react/__tests__/paste-attach.test.tsx` (8 tests): real `paste` ClipboardEvents asserting observable draft state — blank-name synthesis, a second blank paste getting a DIFFERENT name, two generic `image.png` files in one paste rendering distinct labels, a real filename passing through, `image/svg+xml` -> `.svg`; the plain-text case asserting draft UNCHANGED and `defaultPrevented === false`, proved non-vacuous by attaching an image on the same mount right after; text+image for both `text/plain` and `text/html`; the image-only case asserting `defaultPrevented === true`; a paste dispatched ON the composer input attaching exactly once (req 1); a non-image `.pptx`/`.zip` paste asserting no chip, no import banner and no `preventDefault`; a `files`-only clipboard shape exercising the fallback branch; the hidden-surface gate.
- [x] Planner-side verification of tip 8e21b3e1 (2026-08-31, clean scratch checkout, bun 1.3.13): `bun test landing/chat-react/__tests__/paste-attach.test.tsx` → 4 pass / 0 fail; `bun test` attachments.test.tsx component.test.tsx uploads.test.ts stable-mount.test.tsx attachment-basename.test.ts → 49 pass / 0 fail; `bun test` activity-inspector-panel chat-rail-stability pane-error-isolation pane-switch-no-crash project-shell render-isolation switch-render-cost → 56 pass / 0 fail; `bun x tsc -p landing/chat-react/tsconfig.json` → clean; `bun x eslint` on ChatApp.tsx + paste-attach.test.tsx → clean; purity → the leak gate passes on the commit (message + diff).
- [x] T-final (close-out): in the branch worktree, re-run the verification battery, append a "Verification receipts" section to `.trident/plans/trident/web-paste-an-image-straight-into-ch.md`, and land ONE docs-only commit on top of 8e21b3e1 (never amend/rebase it; that docs-only commit 534460cf left `landing/chat-react/ChatApp.tsx` and `landing/chat-react/__tests__/paste-attach.test.tsx` byte-identical to 8e21b3e1 — the review rounds after it deliberately changed both).

Non-goals (explicitly out of this card): anything under `app/`; widening the paperclip `accept` list; any change to drag-and-drop or picker behavior; a parallel attachment path; unconditional `preventDefault` on paste; staging a `.trident/as-built/` entry (feature branches do not carry one — folding is pipeline-side).

## Verification receipts (2026-08-31, close-out on tip 8e21b3e1)

- `bun test landing/chat-react/__tests__/paste-attach.test.tsx` — 4 pass / 0 fail
- neighbor suites (attachments, component, uploads, stable-mount, attachment-basename) — 49 pass / 0 fail
- ChatApp-mounting suites (activity-inspector-panel, chat-rail-stability, pane-error-isolation, pane-switch-no-crash, project-shell, render-isolation, switch-render-cost) — 56 pass / 0 fail
- `bun x tsc -p landing/chat-react/tsconfig.json` — clean
- `bun x eslint landing/chat-react/ChatApp.tsx landing/chat-react/__tests__/paste-attach.test.tsx` — clean
- purity: `bash scripts/ci/leak-gate.sh --tree .` passes on the branch tree and on its commit messages

## Round 2 — Argus findings closed (2026-08-31)

- BLOCKER `purity`: the leak gate tripped on this plan doc's own prose (two lines using the multi-instance vocabulary), not on any code. Reworded; `bash scripts/ci/leak-gate.sh --tree .` now reports zero findings.
- BLOCKER `test`: that CI job is the aggregator over typecheck/lint/purity/layering/shard, so it was red *because* purity was red.
- MAJOR (interception): `clipboardFiles` took every `kind === 'file'` item with no MIME filter, so a stray Cmd-V of a `.pptx` produced a failed chip and a `.zip` produced the "No history import is in progress" banner. Now `clipboardImages`, filtered to `image/*` on both the `items` and `files` paths.
- MAJOR (mixed pastes cancelled): the predicate was `types.includes('text/plain')`, so an image + `text/html` caption was `preventDefault()`ed and the caption silently dropped. Now `clipboardHasText` = any `text/*` flavour.
- MINOR (comment inverted): the rationale block claimed the opposite of the predicate. Rewritten to say what the code does, and the `[hidden]`-attribute gate is now recorded as a decision rather than left to look accidental.
- MINOR (req 1 untested) and MAJOR (mutation survival): eight tests now, and each production behaviour is pinned by one that reds when it is mutated (see the mutation-probe receipts below).
- NIT (compound MIME): `image/svg+xml` synthesized `pasted-N.svgxml`; now `.svg`.
- NIT (render-body ref): `handleFilesRef.current = handleFiles` moved out of the render body into an effect.
- NIT (duplicate display name): the engines' generic `image.png` is now synthesized too, so two pasted screenshots render two distinguishable chips.

### Round-2 receipts

- `bun test landing/chat-react/__tests__/paste-attach.test.tsx` — 8 pass / 0 fail
- `bun x tsc -p landing/chat-react/tsconfig.json` — clean; `bun x eslint` on both changed files — clean
- `bash scripts/ci/leak-gate.sh --tree .` — 0 findings (Tier-1 PII cannot run locally, as designed)
- Mutation probes, each applied to `ChatApp.tsx` alone and each turning the suite RED (baseline 8/8 green): drop the `image/*` filter (7/1); delete the `preventDefault()` (6/2); freeze the synthesized name to a constant (7/1); narrow the text predicate back to `text/plain` (7/1); disable the `files` fallback (7/1); stop synthesizing over `image.png` (7/1); drop the `[hidden]` gate (7/1); drop the `+xml` suffix strip (7/1); never register the listener (0/8).

## Round 3 — Argus findings closed (2026-08-31)

- BLOCKER (paste target never scoped): the document-level listener saw pastes aimed at EVERY editor on the page, so an image pasted into the rail's project-name input (`.car-rail-input`) or the in-place message editor (`.car-edit-input`) was `preventDefault()`ed out of that field, stolen into the chat draft and uploaded immediately. `isForeignEditorPaste(e.target)` now bails whenever the paste lands inside an editable element that is not the composer input (`.car-input`); a paste with no editable ancestor — `<body>`, the thread, the document — is still ours, which is the focus-on-page case req 2 exists for. An event another handler already cancelled (`e.defaultPrevented`) is left alone for the same reason.
- MAJOR (mixed paste asserted only on the event): a text+image paste dispatched ON the composer input now asserts the image attached, the event was NOT cancelled, and the composer's own value was not written by us. (A synthetic paste performs no default insertion under happy-dom, so real caption insertion is only assertable in a browser-level test; not cancelling + not writing is the whole app-side contract.)
- MINOR (`image/*` comment over-claimed): the comment now states plainly that an `image/*` subtype outside the upload allow-list (bmp/tiff/heic/svg+xml) is still collected and still produces the same failed chip a dropped one produces, and that a paste of an image plus a PDF takes only the image — both deliberate, both consistent with the card's paste-an-image scope.
- NIT (`dt.items` dereferenced before the `files` fallback): `items` and `files` lengths are now read as `?.length ?? 0`, so an engine that leaves either undefined falls through instead of throwing inside a document listener.
- NIT (hidden-surface gate tested on a harness wrapper): a new test mounts the real `ProjectShell`, asserts `<main>` really does sit under a `.car-tabpanel`, and hides THAT element.
- NIT (stale plan prose): the "one commit ahead" and "byte-identical to 8e21b3e1" lines above are corrected/scoped.
- KNOWN AND KEPT: `withPasteName` still rewrites a file genuinely named `image.png` to `pasted-N.png`. That is card req 5's display half — every engine uses that same literal for a pasted screenshot, and the alternative is two indistinguishable chips. A real file carrying any other name passes through untouched.

### Round-3 receipts

- `bun test landing/chat-react/__tests__/paste-attach.test.tsx` — 13 pass / 0 fail
- neighbours (component, project-shell, attachments, attachment-basename, uploads) + the paste suite — 71 pass / 0 fail
- `bun x tsc -p landing/chat-react/tsconfig.json` — clean; `bun x eslint` on both changed files — clean
- Mutation probe for the new gate: deleting the `isForeignEditorPaste` bail alone turns the suite RED (the rail-input and in-surface-editor tests fail directly).
