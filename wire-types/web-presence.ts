/**
 * @neutronai/wire-types — the web-presence CADENCE, owned in ONE place.
 *
 * Web presence is a two-sided contract: a browser tab repeats "the owner is
 * looking at me" on a timer, and the gateway believes that claim only for a
 * bounded window after it last heard it. The two numbers are therefore ONE
 * number — a refresh interval and the window it has to fit inside — and the
 * whole feature turns into its own worst failure the moment they drift apart:
 * a TTL shorter than the refresh means the owner's phone buzzes while he reads
 * the message on screen (noisy, obvious, harmless), and a client that stops
 * refreshing against a server that never expires means his phone NEVER buzzes
 * again (silent, invisible, and the reason this file exists rather than two
 * constants with a comment between them).
 *
 * So the TTL is DERIVED from the refresh rather than written down beside it.
 * Three intervals of tolerance: a foregrounded tab may miss two refreshes to a
 * hiccup or a slow event loop and still be believed, while a browser that dies
 * without a close frame is forgotten within a minute and the owner starts
 * getting notified again on his phone.
 *
 * This is the `GENERAL_RAIL_ID` lesson applied before it bites: two hand-kept
 * copies of a shared number in `wire-types`' sibling `topic-id.ts` produced the
 * `~general` / `#general` / `general` confusion of ISSUES #410/#411, and the
 * answer there was one definition above both sides. Same here.
 */

import type { AppWsInboundPresence } from './app-ws-envelope.ts'

/**
 * How often a FOREGROUNDED web client re-declares its presence (ms).
 *
 * MIRRORED (not imported) by `chat-core`'s `DEFAULT_PRESENCE_REFRESH_MS`, which
 * documents why and is pinned equal to this by
 * `chat-core/__tests__/web-presence-reporting.test.ts`.
 *
 * DELIBERATELY NOT THE HEARTBEAT. `chat-core/ws-client.ts`'s ping is
 * IDLE-driven — every inbound frame reschedules it, so a socket carrying a
 * streaming agent reply never pings at all. Presence riding on it would go
 * stale exactly while the owner watches an answer arrive, which is the single
 * moment this feature exists to cover. This timer is unconditional.
 */
export const WEB_PRESENCE_REFRESH_MS = 20_000

/**
 * How long the gateway believes a `foreground` declaration (ms).
 *
 * DERIVED, never typed as a literal — see the module docblock. Three refresh
 * intervals: two may be lost before the owner's phone starts buzzing again.
 */
export const WEB_PRESENCE_TTL_MS = WEB_PRESENCE_REFRESH_MS * 3

/**
 * Build the presence frame.
 *
 * NOT used by the web client, and that is deliberate: `chat-core/web-session.ts`
 * writes the literal itself under a TYPE-ONLY annotation of
 * {@link AppWsInboundPresence}, because a RUNTIME import of this package from
 * `chat-core` intermittently breaks the `/chat-react.js` browser bundle (the
 * measurement is recorded on `DEFAULT_PRESENCE_REFRESH_MS` in that file). The
 * compiler still enforces one shape across both sides; only the runtime edge is
 * avoided. This builder is for the server side and for tests.
 */
export function webPresenceFrame(state: 'foreground' | 'background'): AppWsInboundPresence {
  return { v: 1, type: 'presence', state }
}
