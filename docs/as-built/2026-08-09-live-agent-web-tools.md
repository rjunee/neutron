# The chat agent can search the web (2026-08-09)

Reported as *"Kaizen ritual said it can't do web search."* It couldn't — and
neither could ordinary chat. `LIVE_AGENT_TOOL_NAMES` in
`gateway/wiring/build-live-agent-turn.ts` had never contained `WebSearch` or
`WebFetch`, and that array is the only thing that decides.

## Why it was invisible

A missing built-in produces **no error**. The agent simply reports it has no such
tool, in prose, inside an answer that otherwise looks complete. The kaizen run that
surfaced this ended with *"No WebSearch tool is available in this session, so the
outside-idea section is omitted rather than faked"* — which is the correct
behaviour for an agent and the reason nothing upstream ever noticed.

## The part that mattered more than the missing feature

A ritual declaring a web tool must be approved for `egress: 'web'` through a
SEPARATE grant whose prompt says the ritual "may reach the public internet". The
owner granted that for `kaizen`. **The tool was never present, so the grant could
never do anything.**

A ritual composes on the owner's warm chat session and cannot apply its own
`tool_surface` — the reuse guard would evict and respawn the session
(`reminders/ritual-fire.ts` module header). So the declaration bounded what could be
APPROVED, not what could run, in both directions: the ritual could reach Bash it
never declared, and could not reach the WebSearch it did.

An approval prompt that overstates what is being granted costs more than a missing
feature. It spends the credibility the entire gate depends on.

## The guard

`gateway/wiring/__tests__/ritual-declared-surface-is-real.test.ts` asserts every
bundled ritual's declared built-ins are a SUBSET of the live surface, and that a
ritual promising web access runs somewhere web tools exist.

This is the same shape as the push-kind drift in `wire-types/push-kind.ts`:
`reminders/rituals.ts` validated a declaration internally, `build-live-agent-turn.ts`
owned the surface actually spawned, both suites were green, and their UNION was
broken. The test is the join, and it lives in `gateway` because that is the one
package legitimately declaring both. Removing `WebSearch` again fails two of its
five assertions.

It is explicitly NOT a containment check — a ritual can always reach more than it
declared. It pins the direction that silently under-delivers: never less.

## Surface change

Adding to `LIVE_AGENT_TOOL_NAMES` is safe because it stays a CONSTANT surface, just
a larger one; the reuse guard refuses a VARYING surface. The first turn after deploy
respawns the warm child once, as any deploy does.
