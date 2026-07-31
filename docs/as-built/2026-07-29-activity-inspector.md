## 2026-07-29 — the Activity Inspector: the tmux replacement, behind the dot that lied

> **Superseded in part by `2026-07-31-activity-inspector-conversation-detail.md`.** The
> two-clocks design, the two taps and the dot-as-entry-point below all stand. What
> changed the next day is the CONTENT of a row: `token` no longer renders as a
> character count, tool labels are humanised rather than raw `mcp__…` transport ids,
> the hook now reads `tool_response`, and the `reply` tool call renders as the
> assistant's message interleaved with the tool rows. Where this entry describes row
> content (notably the `token`-is-summarised note under the mapping section and the
> `summarizeToolInput` "returns EMPTY for unknown args" note), read the newer entry.

SPEC § WAVE 3.5's M2-blocking step. The owner could not tell whether a project's agent session was working or hung; in Vajra the escape hatch was attaching to tmux, and Neutron's server-side sessions offered no equivalent whatsoever. Clicking the existing per-project activity dot now opens a panel streaming the raw substrate + tool events for that scope in realtime, on both web and mobile. Live-only: ~200 rows in memory per scope, no persistence, no schema, no retention policy, no scrollback.

Three things about the brief turned out to be wrong in the code, and two of them changed the build materially.

**1. `drainWithHeartbeat` is not the chat seam.** It lives in `onboarding/synthesis/synthesis-session.ts:673` and serves onboarding synthesis only. The real per-turn drain is `drainToOutcome` (`runtime/substrate-text.ts:168`), reached from `build-live-agent-turn.ts:1395` via `collectTokensToString` → `drainToText`. That is where every chat event was being discarded — the informational kinds fall off the bottom of the if-chain — so that is where the tee went (`DrainOptions.onEvent`).

**2. The event kinds are `tool_call` and `tool_result_ack`.** There is no `tool_use` and no `tool_result` in `runtime/events.ts:75-96`.

**3. The one that mattered: the event stream carries almost NOTHING, so teeing it alone would have shipped a panel that cannot answer the question.** The persistent-REPL adapter's 1:1 bridge (`repl-session.ts:281-289`) pushes exactly ONE `token` holding the whole finished reply, then `completion`. It emits **no `thinking`, no `tool_call`, no `tool_result_ack`** for the agent's native tools — `grep "kind: 'token'"` across the adapter returns that single line. So the stream yields: keepalive/notice `status` events, one token, completion, error. That is enough for "is the process alive?" and nothing else. It could never say WHAT the agent is doing, which is the whole of what the owner reads off tmux.

So there are **two taps**, not one. The second is a `Pre`/`PostToolUse` hook (`hooks/activity-tap.ts`, sibling of the shipped `todo-sync.ts`) POSTing to a new `/activity` route on the loopback sink, dispatched through a late-bound `setReplActivityTap` the composer wires — the same three-part pattern as the tool bridge and the todo reconciler, because the hook runs in a different process and shares no memory with the gateway. Both phases with an unscoped matcher: `pre` gives "started Bash: bun test", `post` gives "finished Bash", and **a `pre` with no matching `post` for minutes IS the hang signal** that neither a single-phase tap nor a liveness pulse can express. Gated on `enableToolBridge`, so the disposable Trident build REPLs and the untrusted history-import REPL never report onto the owner's panel. `summarizeToolInput` picks the field that identifies the call (path → command → pattern → query → url → description → prompt) and returns EMPTY for unknown args rather than dumping JSON, which is frequently large and occasionally sensitive.

### The two clocks — why a naive build would have rebuilt ISSUES #386

`pool.ts:551-568` runs a **synthetic** liveness keepalive: `{kind:'status', message:'working'}` every ~10 s for as long as the `claude` child is alive, *including while it is livelocked or parked on a wedged menu*. It exists to stop the synthesis drain false-wedging a silently-reading pass, and it is byte-identical to a real status notice. So "events are still arriving" does not mean "work is happening", and an inspector that measured liveness from `last_event_at` would report a permanently-stalled session as working forever — which is precisely #386, the dot that pulsed for days on a project where nothing ran, rebuilt in the very panel meant to verify it.

The keepalive push now carries an additive `keepalive?: boolean` (`runtime/events.ts`, exactly the shape `code` on `error` established; nothing in the tree reads `status.message === 'working'`, so this is behaviour-neutral). Every scope keeps `last_event_at` (any event ⇒ the PROCESS is alive) and `last_real_activity_at` (keepalives excluded ⇒ WORK happened). `deriveInspectorState` reads both:

- `idle` — no turn in flight. Checked FIRST, because a resting scope's clocks are stale by definition and reading them as a wedge would make every idle project scream.
- `working`, `wedged` (breathing, no real activity for 90 s), `dead` (no events at all for 30 s). `dead` before `wedged`: no signal is worse news than no progress.

`turnStarted` records a NON-synthetic `turn_start` row, and that is what floors the wedge window — a turn whose only subsequent traffic is keepalives is still detectable as stalled, with no extra bookkeeping.

An earlier draft carried a separate `turn_started_at` field for that floor. Mutation testing proved it could not change any outcome (the `turn_start` row already moves `last_real_activity_at` to the same instant), so it is DELETED rather than left as untested complexity. Same call on its `turns_in_flight === 0` re-stamp guard and its 1→0 clear: both reddened zero tests because both were unobservable.

### Wired + served, proven against the real composer

`open/__tests__/activity-inspector-served.test.ts` boots the REAL Open composer and drives the whole chain unmocked: hook-shaped POST → sink `/activity` → the composer's registered tap → the in-memory ring → `GET /api/app/projects/<id>/activity`. Nothing in the middle is stubbed, so the test fails if the composer stops constructing the inspector, stops registering the tap, or stops handing the surface to the graph. `open/__tests__/open-composition-fields-characterization.test.ts` (also a real composer boot) gained `app_activity_surface` to its exact-keys list — that key's presence is the done-means-served evidence. The route reaches the ladder through the `appActivity` slot in `gateway/http/route-slots.ts`, and both `route-slots-transition.test.ts` ratchet lists were extended per the documented "adding a surface" step.

The snapshot endpoint is load-bearing, not a convenience: a wedged session emits nothing, so a purely-live panel would open BLANK on exactly the session the owner is worried about and could not say how long ago the last event was.

### The dot is the entry point, and it is now always there

Ryan-locked: no new icon. But `railDotClass` (web) / `railDotKind` (mobile) returned `null` for an idle scope **and** for General — so the affordance would have vanished exactly when the owner wants it, and the acceptance ("the dot stays clickable when IDLE — an idle session must be distinguishable from a wedged one") would have been unmeetable. Both are now TOTAL: idle renders a quiet hollow ring. General gets a dot too — it is a real chat scope with its own warm session — while still never showing ATTENTION (no bound runs), which degrades to idle. Four existing assertions encoded the old `null` contract and were rewritten with the reason recorded inline; none were weakened to make something pass.

Web: a `role="button"` span inside the row's existing `<button>` (a nested `<button>` would be invalid HTML) with `stopPropagation` + keyboard handling, so a dot tap inspects and does not also navigate. Mobile: a nested `Pressable` with `hitSlop` (the dot's corner offset moved from the dot onto that wrapper, same rendered geometry). Both clients subscribe BEFORE fetching, so no row is lost in the gap, and dedupe on `seq`, which is what makes that overlap safe; both age their clocks forward against the client clock every second, because a frozen "12s ago" is the same lie as a frozen dot.

Mobile carries a third hazard: General has **three** spellings (rail id `'~general'`, chat scope `''`, server scope key `'general'`). `activityScopeKey` accepts all of them so a caller that forgets `railIdToScope` cannot silently inspect a project literally named `~general`.

### Mutation results — 30 mutants, 30 killed

| # | Mutation | Reds |
|---|---|---|
| G1 | `record` advances the real-activity clock for a synthetic row | 3 |
| G2 | wedge measured from `last_event_at` instead of `last_real_activity_at` | 5 |
| G3 | drop the `idle`-first check | 1 |
| G4 | drop the `dead` check (wedge would win) | 2 |
| G5 | remove the ring cap (unbounded buffer) | 2 |
| G6 | `turnStarted` records its row as synthetic | 3 |
| G7 | `turnFinished` loses its `> 0` floor | 1 |
| G8 | `pool.ts` keepalive push loses `keepalive: true` | 2 |
| G9 | remove the drain tee (events discarded again) | 3 |
| G10 | drain tee throw not swallowed | 1 |
| G11 | runner stops passing the tee to the drain | 3 |
| G12 | runner drops `turn_finished` (in-flight leak ⇒ permanent wedge) | 2 |
| G13 | runner tee throws not swallowed | 1 |
| G14 | `build-settings` REPLACES the TodoWrite `PostToolUse` group | 1 |
| G15 | web `railDotClass` returns null for idle again | 1 |
| G16 | web dot loses `stopPropagation` (tap also navigates) | 1 |
| G17 | web `liveAge` stops excluding keepalives | 1 |
| G18 | web `liveAge` freezes instead of ageing forward | 1 |
| G19 | web `mergeActivityRow` loses seq dedupe | 1 |
| G20 | panel loses the sibling-scope filter | 1 |
| G21 | panel fetches BEFORE subscribing | 1 |
| G22 | mobile stops normalising `'~general'` | 2 |
| G23 | mobile live decoder loses its scope filter | 1 |
| G24 | mobile `liveAge` stops excluding keepalives | 1 |
| G25 | mobile `railDotKind` returns null for idle again | 4 |
| G26 | surface loses its bearer gate | 1 |
| G27 | surface loses its read-only 405 | 1 |
| G28 | sink downgrades the no-tap 503 to 200 | 2 |
| G29 | sink turns a recorder throw into an HTTP 500 at the agent | 1 |
| G30 | sink drops phase validation | 1 |

G8 initially killed ZERO. The `pool.ts` keepalive marker is the linchpin of the whole design — drop it and every keepalive counts as work, so wedges become undetectable, silently, because nothing else reads the flag — but exercising it behaviourally means spawning a real `claude` REPL and waiting out a ~10 s interval. Rather than leave the highest-consequence guard untested, it gained a narrow source-level gate (`keepalive-marker-gate.test.ts`, in the spirit of the repo's existing "no `claude -p` in the live path" grep gate) which also pins that the INJECT-time status is NOT marked (that one is real progress) and that exactly one push in the pool is marked at all.

### Tests

New: 24 (`open/activity-inspector.test.ts`), 5 (drain tee), 11 (hook I/O), 6 (build-settings wiring), 7 (sink route), 3 (keepalive gate), 6 (live-agent-turn tee), 5 (served e2e), 20 (web client), 16 (web panel + dot), 18 (mobile client) = **121 new**. Existing files touched and green: `component.test.tsx` 19, `project-rail-view.test.ts` 9, `route-slots-transition.test.ts` 61, `open-composition-fields-characterization.test.ts` 1, plus `o8-drain-to-text-equivalence` 19, `o3-substrate-error-codes` 13, `persistent-repl-substrate` 18, `build-settings` 12, `todo-sync-hook` 5, `synthesis-session` 23, `build-llm-call-substrate` 32, `open-route-matrix` 54, `controller` 51, `project-shell` 9, `chat-rail-stability` 5, `ws-envelope-parity` 8, `general-rail-scope` 10, `mobile-rail-ux` 6, `projects-rail-live` 10. `bunx tsc --noEmit` clean on both the root and `app/` projects.

### Honest gaps

- **No live browser/device walk.** Everything above is test-level and composer-level: a real composer serves the route and the whole tap chain runs unmocked, but nobody has watched the panel tick in a browser against a real `claude` REPL. The first real dispatch is its live confirmation.
- **`thinking` / `tool_call` / `tool_result_ack` rows are mapped but unreachable on the shipped CC path**, since that adapter never emits them. They cost nothing and light up for any adapter that does; today the tool rows all come from the hook.
- **Trident build REPLs are not inspectable.** They are the longest-running sessions and arguably want this most, but they are disposable and not bound to a rail dot, so they are out of scope here.
