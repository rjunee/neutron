## 2026-07-29 — Two on-device mobile defects: bubbles capped twice, and the shell chrome unmounting on every project switch

Both reported by Ryan from the phone the same night. Both root causes were correctly identified before the code was read; both were confirmed against source, and one was **worse than diagnosed**.

### Defect 1 — "arbitrarily narrow, should fill the screen"

`app/components/ChatSyncSurface.tsx` had TWO percentage `maxWidth` declarations in one ancestor chain: `bubbleColumn: { maxWidth: '82%' }` (`:894`) wrapping `bubble: { maxWidth: '82%' }` (`:822`). **Yoga multiplies them.** `calculateAvailableInnerDimension` clamps a node's `availableInnerWidth` by its own resolved `maxWidth` (`app/node_modules/react-native/ReactCommon/yoga/yoga/algorithm/CalculateLayout.cpp:519-527`) and that clamped value is passed down as the child's `ownerWidth` for percentage resolution (`:1397-1404`, then `:595-598`). Effective cap: 0.82 × 0.82 = **67%** of a row that `listContent`'s `paddingHorizontal: SPACING.md` had already narrowed — about 200pt on a 393pt phone, which is the ~5-words-per-line Ryan saw.

The file contained its own proof, unnoticed: the streaming bubble (`:522`) and `TypingIndicator` (`:750`) rendered `styles.bubble` **without** `bubbleColumn`, so they got the full 82% and were visibly WIDER than the settled bubble a streaming row turns into. Two caps that each looked correct in isolation.

**Fix.** One cap, owned by `app/lib/chat-bubble-metrics.ts`, applied to `bubbleColumn` only; the streaming bubble and typing indicator now route through that column like every other row.

**Why 90%, deliberately.** The usual iMessage/Telegram cap (~78%) is a fraction of the FULL screen. This app is not that shape: `ProjectRail` is a **permanent** 72pt column (`components/ProjectRail.tsx` `RAIL_WIDTH`), so a percentage here applies to what is left:

```
iPhone 15 (393pt):  393 - 72 rail - 24 gutters = 297pt row
iMessage's ~78% of 393pt                       = 307pt
```

The row is **narrower than the bubble cap we would be imitating**, so scaling it down again is the wrong move — 82% applied even ONCE is the wrong number for this surface. What has to survive is the speaker asymmetry: a user bubble must visibly not reach the left edge and an agent bubble must visibly not reach the right, or both sides read as full-width blocks. That needs a reliably visible gutter, not a small percentage. 90% leaves ~30pt (≈ `SPACING.xxl`) on a 393pt phone and ~22pt on a 320pt iPhone SE, while giving the bubble 267pt instead of 200pt.

### Defect 2 — "switching projects flickers and feels laggy"

Confirmed, and the diagnosis understated it. `app/app/projects/[id]/_layout.tsx:327-334` gated the WHOLE shell on the settings fetch, returning only a centred `ActivityIndicator` — tearing down the rail, the header and the tab bar and rebuilding all three on every rail tap. Not slow rendering: a full teardown/rebuild per switch.

**Three distinct failures, not one.** Tracing the states rather than trusting the reported mechanism found that `projectStateReducer` `LOAD_START` **preserves** `project` (`app/lib/project-state-reducer.ts:61-62`, deliberate so a `refresh()` does not blank the UI) and the provider is reused across `project_id` changes. So the spinner branch was only ONE of the paths:

1. **project A → project B**: `fetchedProject` is still A and non-null, so the shell rendered B's workspace under **A's name, A's members, A's Invite eligibility** until the fetch landed. No spinner — wrong data.
2. **General → a real project**: the provider had already collected a 404 for `getSettings('general')`, so `project` was null and `loading` was false on the switch render — the gate fell straight through to **`ProjectNotFoundFallback`**. A visible "Project not found" flash on a project that exists.
3. **A slow/cold fetch**: the diagnosed bare-spinner teardown.

A fourth, independent flicker source: `SlotFader` keyed its 1.0 → 0.4 → 1.0 opacity dip on the route leaf, and a rail tap travels `/projects/<id>` → (`index.tsx` last-tab redirect) → `/projects/<id>/chat`, so a switch changed the leaf twice and fired **two** dips.

**Fix — the invariant.** The rail, header and tab bar are persistent chrome and are mounted for the whole life of the layout; only the content pane has a loading state. `ProjectShell` now returns UI from exactly ONE place.

- `app/lib/project-shell-content.ts` — the content-pane decision as a pure function (`ready` / `loading` / `not_found`). **The error, not `loading`, decides `not_found`**: on the render where the route flips, the fetch effect has not run yet, so `loading` is still false while `project` is already null — precisely the gap that produced failure 2. `LOAD_FAIL` always attaches an error and `toStateError` never returns null, so a genuinely absent project still reaches the not-found pane; it cannot hang on a spinner, because the caller only gets here with a signed-in user and a non-empty scope id, which is exactly when `fetchSettings` runs rather than returning early. General short-circuits to `ready` **first**, before any other rule, so a stale error can never 404 the one scope that cannot 404.
- `scopedProjectState` (`project-state-reducer.ts`), applied in `project-state.tsx` against a `loadedScope` marker stamped in the same tick as each result — kills failures 1 and 2 at the source. Data whose scope is not the requested one reads as "nothing known yet, fetch in flight". **Not** solved by keying the provider on `project_id`: that remounts its whole subtree, which is the exact teardown being fixed.
- The loading spinner and the not-found pane render INSIDE the chrome, so a missing project leaves the rail available to tap out of the dead end rather than replacing the screen. `ProjectNotFoundFallback` moved from `styles.container` to a new `contentFill` so it fills whichever region it is placed in.
- `SlotFader` takes a `scopeId` and re-baselines without animating when it changes. The dip is for tab switches within a project.
- While the doc is in flight the header names the project from the already-loaded rail list (`scopeName`); `''` is the last resort, never a fabricated placeholder (ISSUES #393). The Invite pill is suppressed until the doc loads — `canInviteToProject` reads `billing_mode` + `members` and there is no honest answer without them.

### Failing-before + mutation results

Both suites were run against the pre-fix tree, and every guard was individually neutralised. Numbers are `fail` counts for the named test file.

| | |
|---|---|
| `origin/main` `ChatSyncSurface.tsx` vs the bubble suite | **3 fail** |
| `origin/main` `_layout.tsx` vs the shell suite | **4 fail** |
| M1 re-add nested `maxWidth:'82%'` to `styles.bubble` | 2 |
| M2 shrink the cap back to 82% | 3 |
| M3 pull `TypingIndicator` out of the capped column | 1 |
| M4 break the left/right speaker asymmetry | 1 |
| M5 drift `RAIL_WIDTH_PT` from the rail's real width | 3 |
| M6 reintroduce the early spinner return (the original bug) | 1 |
| M7 call an unfetched scope `not_found` instead of `loading` | 2 |
| M8 drop the General special-case | 1 |
| M9 neutralise the cross-scope staleness guard | 3 |
| M10 key the fade on the route leaf again | 1 |
| M11 stop calling the resolver (exists ≠ wired) | 1 |

No guard reddens zero tests.

**Part of each suite is deliberately STRUCTURAL, reading the component's source.** Both bugs are wrong SHAPES, not wrong values, and this suite has no RN mount harness (`project-card-interactivity.test.ts`). A value assertion cannot catch someone re-adding a second `maxWidth` — the constant would still be 90% and the arithmetic still right — and a snapshot cannot catch the early return, because the broken build's snapshot is a perfectly valid spinner. So the guards are: exactly one percentage `maxWidth` in the chat surface with `bubbleWrap` and `bubbleColumn` occurring in equal numbers, and exactly one UI-returning `return` in `ProjectShell` with the chrome inside it. Same reasoning as `app/lib/entry-route.ts`: hoist the decision somewhere assertable, then pin the wiring.

### ALSO INVESTIGATED, NOT FIXED — the duplicate "took too long" bubble

Ryan's screenshot showed the same timeout bubble twice, each with its own Retry. **Verdict: two genuinely separate turn failures, so per the brief this is reported, not fixed.** Ruled out by tracing:

- **Duplicate render — impossible.** `rowKey()` is `m:<message_id>` (`app/lib/chat-core/chat-render-model.ts:137-142`) used directly as `keyExtractor` (`ChatSyncSurface.tsx:416`); streaming buffers are suppressed once persisted (`:128`).
- **Duplicate insert — ruled out.** `upsert` resolves by `messageIdentity()` and deletes the old identity row on change (`app/lib/chat-core/sqlite-store.ts:200-227`); agent messages resolve via indexed `getByMessageId` (`chat-core/sync-engine.ts:250-260`); replayed rows carry the stored `message_id` (`channels/adapters/app-ws/adapter.ts:216-217`) so a resume merges rather than duplicates.
- **Double fan-out — none found.** One `adapter.send` per reply (`open/composer.ts:3624`), one `chat_log.append` + one registry send (`adapter.ts:215`, `:246`), one frame per device entry (`session-registry.ts:124-133`).
- **One emit site, once per turn.** `TIMEOUT_BODY` ships only from `sendTimeoutRetry` (`gateway/wiring/build-live-agent-turn.ts:2063`), called once at `:1502` inside the terminal-failure block; the retry loop emits after the loop (`:1411`, `:1471`) so both freezes collapse into one bubble, and the substrate watchdog is settle-guarded (`runtime/adapters/claude-code/persistent/pool.ts:583`).

Two visible bubbles therefore require two server `message_id`s, i.e. two runner invocations. **The unguarded trigger is the Retry tap itself**, and two gaps make a second failure look like a duplicate of the first:

1. `sendTimeoutRetry` builds its prompt with **no `idempotency` key** (`build-live-agent-turn.ts:2069-2075`), unlike `open/wiring/app-ws.ts:470-487` which passes one and gates the live send on `was_new`. With no key, `ButtonStore.emit` unconditionally inserts a new row with a new `prompt_id` (`channels/button-store.ts:157-159`), so N freeze-terminal turns produce N bubbles by construction. `REPLY_ROW_TTL_MS` is 10 years (`:125`), so the Retry buttons never expire.
2. `on_button_choice` decodes `prompt_id` and **discards it** (`open/wiring/app-ws.ts:1210-1228`) — no resolve, no `was_new`, and by design no user row is written (`gateway/http/app-ws-surface.ts:897-899`), so a tap leaves nothing visible between the two error bubbles. The typed path IS hardened (`app-ws-surface.ts:972`, `:1156`, `gateway/__tests__/app-ws-no-double-dispatch.test.ts`); `button_choice` is absent from that suite. The only guard against a re-tap is the session-scoped `chosenByPrompt` `useState` (`ChatSyncSurface.tsx:163-167`), whose own comment assumes the server marks the prompt answered — false for this bubble, so any remount restores a live Retry.

Cheap fixes exist (an idempotency key on the timeout prompt; resolving `prompt_id` in `on_button_choice`; tightening `build-live-agent-turn-timeout-retry.test.ts:150` from `sent.find` to a length assertion), but they are gateway-side turn-lifecycle changes outside this PR's surface and the seed choice needs care — a per-question seed keeps the row alive for the life of the question, which is intended but wants a deliberate hash of the recovered `lastUserText`.

**Undetermined from code alone:** which trigger fired in Ryan's session. Settling it needs the gateway logs for that topic — `retry_tap` (`build-live-agent-turn.ts:923`) is decisive, with `turn_failed` (`:1462`) and `turn_auto_retry` (`:1472`) counts and the `chat_log` `seq` ordering.

### Not covered

- **Not verified on a device.** Typecheck, lint and the two suites are green; the bar Ryan set is a real install, and only he can close that.
- The rail-tap → `/projects/<id>` → async last-tab read → `/projects/<id>/chat` hop remains. It is now honest (a spinner scoped to the content pane, chrome intact) rather than removed; collapsing it would mean resolving the last tab synchronously, which AsyncStorage cannot do.
- The duplicate-error bubble is untouched, per the brief.
- No change to `app/assets/images/*`, `app/app.json`, or `app/app/projects/[id]/chat.tsx` (concurrent work). `components/ProjectRail.tsx` is **read but not modified** — `RAIL_WIDTH_PT` is mirrored in `chat-bubble-metrics.ts` with a source-drift guard rather than importing from the rail, which would have pulled `react-native` into the width arithmetic.
