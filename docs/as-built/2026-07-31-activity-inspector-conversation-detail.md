## 2026-07-31 — the Activity Inspector shows the CONVERSATION, not telemetry about it

The panel shipped 2026-07-29 (`2026-07-29-activity-inspector.md`) answered "hung or working?" correctly and was kept. What it could not do was tell you what actually happened. Ryan, reading it on the phone:

> "Inspector is good but can we see the actual detailed messages like would be shown in Claude Code session instead of these terse tool calls or whatever they are?"

and, sharpening it:

> "I like seeing tool calls, but they should be human readable names. And interleaves with the actual messages the model is outputting not just the si[ze]"

So: keep the tool rows, fix their names, and put the model's own words on the same timeline. The unit of the view becomes a **turn transcript**, not an event log.

### What was actually wrong — measured on the device, not inferred

`uiautomator dump` against the running app, drawer open. The panel's right edge is at x=320. Three separate defects, all visible in one dump:

| Observed | Rows | Diagnosis |
|---|---|---|
| a 52-char label starting `mcp__` with x2 **=320** | 3 | clipped flush against the panel edge — running off |
| a 27-char label starting `mcp__` with x2 **=320** | 2 | same, one namespace shorter |
| text matching `^\d+ chars$` | 2 | the reply rendered as its own LENGTH |

The 52-char rows are the ones that mattered most, and they were the most misleading thing on the screen.

### The finding: two of the three were NEVER CAPTURED, one was captured and thrown away

This is the part a rendering-only pass would have got wrong.

**Assistant text — captured, then reduced to a number.** `activity-inspector.ts` mapped `token` to ``detail: `${(ev.text ?? '').length} chars` ``. The text was right there in the event and was replaced by its length. The original rationale ("the reply already renders in chat") does not survive contact with the surface: the inspector is read while a turn is IN FLIGHT, when chat has rendered nothing yet, and on a WEDGED session, where chat will never render it at all. Rendering fix.

**Tool results — never captured at all.** The hook's `HookInput` declared only `session_id` / `tool_name` / `tool_input`, and its POST body carried only `{session_id, phase, tool_name, detail}`. CC's `PostToolUse` payload carries `tool_response` (as `todo-sync.ts` already documented) and the hook never read the field. That is why a finished `tasks_list` row could not say one word about what it returned. **Source change.**

**Tool arguments — captured, but only one field.** `summarizeToolInput` picked the first of `file_path|path|command|pattern|query|url|description|prompt` and returned `''` for anything else, deliberately, because unknown args "are frequently large and occasionally sensitive". Large is what the cap is for; sensitive is not a reason to blank the row, because the only destination is the OWNER's own authenticated panel rendering his own session — the same content chat already shows him. The blank had a real cost, and it produced the single most confusing row on the screen (below). Now falls back to a compact `key=value` render.

### The unreadable row was the assistant's entire message

`mcp__neutron-<32 hex>__reply` is not a tool name, it is a transport address. `spawn.ts` names the dev-channel MCP server `neutron-${randomBytes(16).toString('hex')}` — a value that is DIFFERENT on every spawn and means nothing to anyone — and `dev-channel-impl.ts` registers `reply` on it with a single `text` argument holding "your COMPLETE response for this turn".

So the mystery row in the screenshot was the agent's whole message, and the previous build discarded its content twice over: `text` was absent from the pick list, so the row carried no detail at all, and the label was the raw address, clipped mid-id with the one informative token (`reply`) at the far end where the truncation ate it.

Two consequences:

1. **`humanizeToolName`** parses `mcp__<server>__<tool>` → the TOOL becomes the label, the server is demoted to a dim `source` qualifier (kept, not discarded — a same-named tool from another server must stay distinguishable), and the random incarnation is stripped so the qualifier is stable across spawns. Matched as `-[0-9a-f]{8,}$`, which covers both the current 16-byte form and the pre-2026-07-20 4-byte one. Anything that does not parse passes through UNCHANGED: showing an odd name truthfully beats inventing a pretty wrong one. Note that `mcp__neutron__memory_search` was never "already readable" — it is the identical form, merely short enough to fit — so one rule fixes both.
2. **The `reply` call IS the interleave.** The agent's words arrive at the hook at the exact instant it produces them, so a `reply` call now becomes an ASSISTANT MESSAGE row (`kind: 'token'`), peer to the tool rows on one chronological list. No merging of two streams was needed — the ordering was always correct in the ring; only the content was missing.

### The duplicate that interleaving creates, and why it is collapsed on ADJACENCY

Wiring the `reply` call as an assistant row surfaces the same message twice: once from the hook, and once from the substrate's end-of-turn `token` — because `onReply` is precisely what pushes that token (`repl-session.ts`, "the 1:1 bridge: one reply → one token"). Same string, microseconds apart, and a transcript that prints the owner's message twice looks broken.

Collapsed in `record` on the only shape the artifact can take: an assistant row landing immediately after an assistant row with identical content. Deliberately **not** a time window — the two arrivals are not reliably close (a slow sink POST lags) and adjacency is the precise property. Two genuinely repeated assistant messages in one turn would be separated by whatever prompted the second, so this cannot swallow real content; there is a test for exactly that. A collapsed duplicate also burns no `seq` and re-fans no frame.

The `reply` tool's `post` phase is dropped outright — it returns a bare ack, and "finished replying" is noise beside the reply itself.

### Nothing runs off the right edge any more

The overflow was the same *symptom* in both clients — a label that would not shrink — but **the operative property differs per engine, and conflating them would mislead the next person to debug this.**

- **Web (CSS)**: `.car-actin-l { flex: 0 0 auto }` — explicitly no shrink. Replaced with a `.car-actin-c` content column at `flex: 1 1 auto; min-width: 0`, holding every text node. Here `min-width: 0` is load-bearing: CSS's default `min-width: auto` gives a flex item a min-content floor, so without the override it refuses to narrow below its longest unbroken word — and a 52-character id is one unbroken word.
- **Mobile (Yoga)**: Yoga does **not** implement the CSS min-content floor, so `minWidth` was never the problem there. What was: Yoga defaults `flexShrink` to **0** where CSS defaults it to 1, so a `Text` with no explicit shrink simply will not narrow. The fix is `flex: 1` on the new `rowContent` column (which sets `flexShrink: 1` as well as claiming the remaining width) plus `flexShrink: 1` on the label; time+glyph moved into a fixed `rowGutter`. `minWidth: 0` is kept for parity with the web twin, not because Yoga needs it.

Same fix shape, two different reasons. Both engines now wrap instead of overflowing.

Long values truncate-with-expand rather than being cut: a row whose `body` says more than its `detail` is tappable/clickable, and the default collapsed state still shows real content (8 lines of prose, 2 lines of detail). `BODY_MAX` is 2 000 chars — the ring holds 200 rows per scope, so this is what bounds the buffer at ~400 KB/scope worst case and caps the WS frame fanned to every client. That is the honest price of content over counts.

Assistant rows are rendered in the PROPORTIONAL face with a left rule; tool rows stay monospace. That contrast is what makes the model's own words findable at a glance in the stream.

### Privacy

This feature renders the owner's private conversation in a PUBLIC repo, so every fixture here is synthesised: `a-command`, `a_tool`, `a-server`, `a synthesised assistant sentence`. No real message text, arguments, results, project names or ids appear in any test, fixture or commit. The device evidence above is reported as measurements (lengths, x-coordinates, row counts, `^\d+ chars$` matches) precisely so the finding could be recorded without the content that produced it.

### Tests

`open/activity-inspector.test.ts` 40 (was 24) — `humanizeToolName` incl. incarnation-stripping and unparseable pass-through; reply-as-assistant; the dropped post-ack; the adjacency dedupe and its three negative cases; body/detail newline handling; `BODY_MAX`. `activity-tap-hook.test.ts` 30 — `tool_response` forwarding, the reply `text` argument, `renderToolArgs`/`renderToolResult` across the five result shapes incl. unknown-shape fallthrough. `activity-inspector-panel.test.tsx` 21 — prose rendering with no `chars` anywhere, human label + demoted source, expand/collapse, no affordance when body would repeat detail, and one chronological list. Plus wire-parse coverage on both clients.

**Two assertions were rewritten rather than deleted, with the reason recorded inline**, because both encoded the contract this change inverts: `detail: '5000 chars'` (the size-not-content bug) and `summarizeToolInput → ''` for unknown args.

`bunx tsc --noEmit` clean on the root and on `app/`.

### Honest gaps

- **`thinking` rows remain unreachable.** The persistent-REPL adapter emits no `thinking` event, so the intermediate reasoning a real Claude Code transcript shows between tool calls is not on the wire at all. What interleaves today is tool calls + the agent's user-visible messages. Closing that needs an adapter change, not a panel change.
- **One assistant message per turn on the shipped path.** `reply` is called exactly once per turn by contract, so the transcript reads tools-then-message rather than alternating prose. Multi-part streamed replies would render in order for free if the adapter ever sends them.
- Device AFTER-evidence limits are recorded in the PR rather than here, since they concern the verification run and not the built artifact.
