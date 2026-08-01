/**
 * @neutronai/gateway/http — external system-notice surface.
 *
 *   `POST /api/app/system-notice`  →  one durable system message in the owner's chat.
 *
 * WHY THIS EXISTS. `deliver` (`./deliver.ts:2`) is "the ONE out-of-turn
 * delivery seam", and every producer that reaches it is IN-PROCESS: the
 * substrate notice sink (`./substrate-notice-sink.ts:134`), the recovered-reply
 * store (`./recovered-reply-store.ts:236`), the reminder/brief/ritual wiring in
 * `open/composer.ts:2070`. Nothing exposed it over HTTP. So an out-of-band
 * operator — a control plane, a monitoring job, a self-hoster's cron, anything
 * holding a valid instance-scoped bearer — had NO way to put a sentence in front
 * of the owner. It could restart the box; it could not tell him why. This route
 * is that missing seam and nothing more: it authenticates, validates, and calls
 * `deliver`. It builds no delivery mechanism of its own.
 *
 * IT IS DELIBERATELY CONTENTLESS. The route knows how to post a notice; it knows
 * NOTHING about what any caller might want to announce. There is no `reason`
 * enum, no event taxonomy, no per-source formatting. The caller supplies the
 * finished sentence and this surface delivers it verbatim. Any vocabulary that
 * belongs to one deployment's operational concerns belongs in that deployment,
 * not in the engine every self-hoster runs.
 *
 * DURABILITY IS `'inert'`, NOT `'none'` — and the difference is the whole point.
 * `'none'` is the transient live-only pill the substrate sink uses: it writes no
 * row, so a client that is not connected at that instant never learns the notice
 * happened. An out-of-band announcement is precisely the case where the owner is
 * NOT looking — that is why something else had to tell him. A live-only bubble
 * would be gone by the time he opened the app, which is the one moment it needed
 * to exist. `'inert'` persists an already-resolved agent history turn
 * (`ButtonStore.persistInertAgentTurn`, speaker `__system__`), so the notice is
 * in the transcript whenever he next hydrates, and it never becomes the topic's
 * active prompt that his next message attaches to.
 *
 * IT IS A SYSTEM MESSAGE, NOT THE OWNER SPEAKING. It deliberately does NOT route
 * through `POST /api/app/chat/send`, which persists a `role: 'user'` turn and
 * dispatches an agent turn from it. That would fabricate words the owner never
 * said AND spend a model turn to announce something that needs no reasoning. The
 * inert-agent-turn shape is the codebase's existing grammar for "the system is
 * telling you something", and this route uses it unchanged.
 *
 * AUTH IS THE EXISTING BEARER, WITH NOTHING ADDED. The route resolves
 * `Authorization: Bearer <token>` through the SAME `AppWsAuthResolver`
 * (`channels/adapters/app-ws/auth.ts`) every other `/api/app/*` surface uses. In
 * the production `jwks` mode that means: RS256 signature against the identity
 * service's published keys, unexpired, a non-empty `sub`, and a `slug` claim
 * constant-time-equal to THIS instance's slug (`auth.ts:219-232`) — an
 * account-scoped bearer with no `slug` is refused outright. That last check is
 * the authorization: a token minted for another instance cannot post here. This
 * matters more on this route than on a read surface, because a caller who
 * reaches it writes a durable message into the owner's transcript that renders
 * as the system speaking; unauthenticated, it would be a message-injection hole.
 * No shared secret, no new token type, no second credential path.
 */

import { MAX_USER_MESSAGE_LEN } from '@neutronai/channels/adapters/app-ws/envelope.ts'
import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import type { Deliver } from './deliver.ts'
import { jsonError, jsonOk, readJsonBody, resolveBearer } from './surface-kit.ts'

/** The one path this surface owns. */
const PATH_SYSTEM_NOTICE = '/api/app/system-notice'

export interface SystemNoticeSurfaceOptions {
  /**
   * The ONE out-of-turn delivery seam (`./deliver.ts`). Injected, never
   * constructed here — this surface adds a caller to the existing seam, it does
   * not become a second one.
   */
  deliver: Deliver
  /**
   * The owner's chat topic — the bare `app:<owner>` the live client binds AND
   * hydrates. Resolved once at composition (`appWsTopicId(OWNER_USER_ID)`); the
   * caller cannot choose a topic, so this route can never be aimed at anything
   * but the owner's own chat.
   */
  owner_topic_id: string
  /** Shared bearer resolver — the same instance every `/api/app/*` surface uses. */
  auth: AppWsAuthResolver
}

export interface SystemNoticeSurface {
  /** Disclaims with `null` on any path but its own, per the RouteSlot contract. */
  handler: (req: Request) => Promise<Response | null>
}

export function createSystemNoticeSurface(
  opts: SystemNoticeSurfaceOptions,
): SystemNoticeSurface {
  const { deliver, owner_topic_id, auth } = opts
  return {
    handler: async (req) => {
      const url = new URL(req.url)
      if (url.pathname !== PATH_SYSTEM_NOTICE) return null
      if (req.method !== 'POST') {
        return jsonError(405, 'method_not_allowed', 'system-notice accepts POST only')
      }

      // AUTH FIRST — before parsing a body, before touching the delivery seam.
      // An unauthenticated caller learns nothing about this instance beyond the
      // fact that the route exists.
      const resolved = await resolveBearer(req, auth)
      if ('code' in resolved) {
        return jsonError(401, resolved.code, resolved.message)
      }

      const parsed = await readJsonBody(req)
      if (parsed === null || typeof parsed !== 'object') {
        return jsonError(400, 'invalid_body', 'expected a JSON object body')
      }
      const raw = (parsed as { body?: unknown }).body
      if (typeof raw !== 'string' || raw.trim().length === 0) {
        return jsonError(400, 'missing_body', 'body must be a non-empty string')
      }
      if (raw.length > MAX_USER_MESSAGE_LEN) {
        // Same cap the chat transport enforces on a user message
        // (`channels/adapters/app-ws/envelope.ts:304`), so a notice can never be
        // a shape the transcript cannot carry.
        return jsonError(413, 'body_too_long', `body exceeds ${MAX_USER_MESSAGE_LEN} chars`)
      }

      // `durability: 'inert'` SURFACES a durable-persist throw (deliver.ts) —
      // that is the contract we want: a notice with no durable row has failed at
      // the only thing it was for, so report it rather than answering 200 for a
      // message the owner will never see. `delivered_live` reflects the real
      // fan-out and is informational: false simply means no socket was open,
      // which the durable row already covers.
      try {
        const result = await deliver(owner_topic_id, { body: raw, durability: 'inert' })
        return jsonOk({
          prompt_id: result.prompt_id,
          delivered_live: result.delivered_live,
        })
      } catch (err) {
        return jsonError(
          503,
          'delivery_failed',
          err instanceof Error ? err.message : String(err),
        )
      }
    },
  }
}
