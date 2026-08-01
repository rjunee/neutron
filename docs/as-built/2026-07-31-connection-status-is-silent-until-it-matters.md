## 2026-07-31 — the chat surface stopped narrating the socket

Branch `fix/quiet-connection-status`. `app/components/ConnectionNotice.tsx` (new),
`app/components/ChatSyncSurface.tsx`,
`app/__tests__/connection-notice-quiet.test.tsx` (new).

**What was on screen.** `ChatSyncSurface` carried a `StatusStrip` that mapped the
`ConnStatus` machine straight to text: `'Connecting…'`, `'Reconnecting…'`,
`'Disconnected'`, `'Sending N…'`. Opening a project mounts a fresh chat surface,
which attaches a session and drives `idle → connecting → open`, so the word
"Connecting…" appeared on **every project switch** — several times a minute. The
owner's verdict: *"I don't want to see the word 'connecting…' every time I switch
projects… Otherwise just assume we are connected. Users don't need to see this."*
Reconnecting a socket is routine mechanics; rendering it as a status turns a
normal event into something that reads as a fault.

**Two different facts were hiding behind one label.** "A socket is negotiating" is
plumbing and is now gone with no replacement. "Your message is not going
anywhere" is real information and still reaches the owner, by three routes, none
of which is the old label:

- the per-bubble delivery glyph — 🕓 queued → ✓ sent → ✓✓ delivered, and ⚠️ with a
  retry affordance once the ack times out (`lib/chat-core/chat-render-model.ts`
  `deliveryState`). This is the iMessage-shaped, per-message channel and it is
  untouched; it is why the thread-level `'Sending N…'` band could go — that band
  duplicated the tick and flashed a layout shift on every single send;
- `sendError`, instant and unthrottled — a send that could not even be queued
  locally produces no bubble at all, so the strip remains its only channel;
- the new offline line, once the outage is no longer plausibly a blip.

**The threshold is derived, not chosen by feel.** `OFFLINE_NOTICE_AFTER_MS` is
**15 000 ms**, matching `ChatWsClient`'s default `maxBackoffMs`
(`chat-core/ws-client.ts`). Backoff runs 500 → 1000 → 2000 → 4000 → 8000 ms, which
is 15 500 ms of delay spent across five failed attempts before the ceiling is
reached — so when the notice fires, the reconnect machine has stopped believing in
a fast recovery too. A healthy reconnect (project switch, foreground resume,
wifi→cellular handoff) lands on the first or second round, inside ~2 s, so a
routine switch misses this by roughly an order of magnitude. Erring long is
deliberate: a false "Offline" is the exact anxiety being removed, and a late-by-
ten-seconds true one costs nothing while the 🕓/⚠️ glyphs carry per-send truth
throughout.

**It cannot latch, and it cannot be defeated by flapping.** The deadline effect
keys on the BOOLEAN health (`open`/`idle` vs the rest), never on the raw status
string. A dead connection cycles `connecting → reconnecting → closed →
reconnecting`, and a timer keyed on the status would be torn down and re-armed on
every transition — never firing, so a permanent outage would report nothing at
all. Health only flips when the connection genuinely returns, which is also the
only moment the notice may clear; the pure decision re-checks health ahead of the
elapsed flag so a stale `true` cannot survive one render.

**Placement is the existing pattern**, not a new one: the same hairline-separated
caption band above the transcript that the old strip used. The change is that it
is now rare. Copy is `Offline`, or `Offline — N message(s) waiting to send` when
sends are stacked up behind the outage.

**Also in this PR (drive-by, one line):** the composer placeholder is now the
constant `'Message'` — after the rebase over #40 that prop is passed where the
surface publishes the composer into the shell's full-width dock
(`useComposerDock`), not where the composer used to sit. It used to swap to `'Or type a response…'` whenever an agent
prompt allowed freeform — the same sentence already removed from the hint line
above the composer, so the complaint stayed on screen in the ghost text. "You may
type instead of tapping" belongs in the prompt that offers the buttons; a
placeholder that mutates under the cursor reads as a glitch.

**Proof.** `app/__tests__/connection-notice-quiet.test.tsx`, 13 assertions, real
timers (the component takes an `offlineAfterMs` seam so the suite need not sit
through a real 15 s outage; nothing here passes because a clock was mocked).
Mutation-tested — each of these makes the suite red:

| mutation | tests that fail |
|---|---|
| indicator deleted (never speaks) | 5 |
| deadline keyed on the raw status (flapping re-arms forever) | 1 — the flapping guard |
| healthy short-circuit removed (the notice latches past recovery) | 1 |
| old behaviour restored (`'Connecting…'` on connect) | 4 |

**JS-only, therefore OTA-shippable**: two `.tsx` files plus a test, no native
module, no new dependency, no `app.config`/`eas.json`/manifest change — it ships
over `expo-updates` without a store build.
