## Issue 936 — theme-aware web scrollbars

### What changed

The web shell now defines a visible scrollbar thumb for the default dark palette at `landing/chat-react.html:145` and overrides it for the light palette at `landing/chat-react.html:237`. A universal rule emits the standard `scrollbar-width` and `scrollbar-color` properties at `landing/chat-react.html:240`, while the WebKit pseudo-elements set an 8px vertical and horizontal size plus themed thumb and track colors at `landing/chat-react.html:245`.

The universal rule reaches the existing project rail at `landing/chat-react.html:968`, transcript at `landing/chat-react.html:1242`, document viewer at `landing/chat-react.html:666`, and task list at `landing/chat-react.html:791`. Those surfaces retain their existing `overflow` declarations, so this change styles their affordances without introducing a second scrolling path.

Focused source coverage in `landing/__tests__/chat-scrollbars.test.ts:13` pins the standard declarations, the Chromium/Safari declarations, the absence of a hidden WebKit scrollbar, and both theme thumb values.

### Decisions

The rule targets every element, rather than repeating the declaration on a hand-maintained selector list. Existing horizontal scroll regions such as markdown tables at `landing/chat-react.html:660` therefore receive the same styling as the four issue-named vertical regions. Theme variables are the existing styling vocabulary: the default palette supplies the dark value at `landing/chat-react.html:145`, and the existing light-theme override supplies the light value at `landing/chat-react.html:237`.

No new runtime outcome, error, verdict, or state was added. The invariant is maintained continuously by the universal CSS rule at `landing/chat-react.html:240`, independent of any individual pane implementation.

### Mutation evidence

| Guard | Parse-valid mutation | Red result | Restored result |
|---|---|---|---|
| Standard scrollbar rule | `scrollbar-width: thin` → `auto` at `landing/chat-react.html:242` | `uses thin theme-aware standard scrollbars on every scroll region` failed | focused file: 3 pass, 0 fail |
| Chromium/Safari width | `width: 8px` → `0` at `landing/chat-react.html:245` | `emits visible Chromium and Safari scrollbar rules` failed | focused file: 3 pass, 0 fail |
| Light-theme visibility | `#a8a8ad` → `transparent` at `landing/chat-react.html:237` | `defines a visible thumb for both dark and light themes` failed | focused file: 3 pass, 0 fail |

### Validation

`bun test landing/__tests__/chat-scrollbars.test.ts` passed 3 tests and 9 assertions. `git diff --check` passed. `bash scripts/ci/typecheck-all.sh` passed both touched scopes, `landing/chat-react/tsconfig.json` and `landing/tsconfig.json`, but the overall 51-project matrix was red because the unchanged `app/tsconfig.json` could not resolve the `@types` type library; `git diff --quiet origin/main -- app` returned 0.

### Deliberately not done

No scrollbar was hidden, no overflow behavior was changed, and no feature switch or parallel implementation was added. No product decision changed, so `SPEC.md` was not edited. A Linux/Chromium visual check was attempted but could not start because the browser helper's installation directory was read-only; the platform-independent emitted-CSS checks at `landing/__tests__/chat-scrollbars.test.ts:13` are the completed verification.
