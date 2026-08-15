/**
 * @neutronai/open — the app-ws topic a FIRED reminder is delivered into.
 *
 * The dispatcher hands the composer the reminder's stored destination
 * (`ReminderTopicResolver` in `reminders/dispatcher.ts`): the reminder row's
 * `topic_id`, else a `[ROUTING]` header, else `null`. That value is
 * ENGINE-shaped and comes in four flavours, all of which land here:
 *
 *   - `null` / blank                — an instance-level (General) reminder.
 *   - `<project_id>` raw            — the Reminders Core stores the raw
 *                                     `project_id` as `topic_id`
 *                                     (`cores/free/reminders/src/backend.ts:425,451,462`),
 *                                     which is what `reminders_create` produces.
 *   - `app-project:<project_id>`    — what `app-reminders-surface` stamps.
 *   - `web:<user>[:<project_id>]`   — the legacy web-chat destination.
 *
 * The surface key is `app:<user>` (General) or `app:<user>:<project>` (a
 * project chat) — `wire-types/topic-id.ts`, the same derivation the client
 * binds and hydrates on (`gateway/http/app-ws-surface.ts` `resolveChannelTopicId`).
 * This is the bridge between the two.
 *
 * THE FALLBACK IS LOAD-BEARING (the #105 lesson): a destination naming no
 * EXISTING project resolves to General, never to a suffixed topic derived from
 * it. A durable row written under a topic no client ever binds or replays is a
 * message that vanishes — live and on reload. So a project id is only honoured
 * when it is present in `listProjectIds()`.
 *
 * Extracted from `open/composer.ts` so the routing table is unit-testable
 * without booting a composition.
 */

import { appWsTopicId, appWsProjectTopicId } from '@neutronai/wire-types'

/**
 * Why a fire that named a destination was nonetheless routed to General.
 *
 * EVERY downgrade is reported. The defect this module exists to fix was a
 * SILENT reroute — 24 fires landed in the wrong topic for a night with nothing
 * in any log to point at — so a resolver that quietly falls back is the same
 * failure wearing new code. `unknown_project` is the deliberate #105 fallback
 * (a destination naming nothing the client binds); the other three are wrong
 * enough to want an operator's eye.
 */
export type ReminderTopicDowngradeReason =
  /** The destination named a project no `listProjectIds()` row matches. */
  | 'unknown_project'
  /** The destination was scoped to a DIFFERENT user than this box's owner. */
  | 'foreign_user'
  /** A prefixed destination (`app-project:` / `web:<user>:`) with an empty tail. */
  | 'malformed_destination'
  /** `listProjectIds()` threw — we cannot tell a real project from a ghost. */
  | 'project_list_unavailable'

export interface ReminderTopicDowngrade {
  /** The destination as the dispatcher handed it over (trimmed). */
  explicit_topic: string
  reason: ReminderTopicDowngradeReason
  /** The project id we tried to honour, when one could be parsed out. */
  candidate: string | null
  /** The `listProjectIds()` failure, for `project_list_unavailable` only. */
  error?: string
}

export interface BuildAppWsReminderTopicResolverInput {
  owner_user_id: string
  /** Live project-id lister. MUST be dereferenced per call, never snapshotted —
   *  a project created after boot must route scoped on its next fire.
   *  MAY THROW: a DB read failure is reported as `project_list_unavailable`, not
   *  swallowed into "no projects exist" (which would reroute EVERY project
   *  reminder to General — the exact silent misrouting this card removes). */
  listProjectIds: () => ReadonlyArray<string>
  /** Called on every downgrade to General. Wired to the composer's logger; MUST
   *  NOT throw (the resolver guards it anyway — see below). */
  onDowngrade?: (event: ReminderTopicDowngrade) => void
}

/**
 * Build the `explicit_topic → app-ws topic` resolver the composer injects into
 * the reminder dispatcher. `null` (every ritual approval, executor post and
 * brief) resolves to the owner's General topic.
 *
 * TOTAL BY CONSTRUCTION: this NEVER throws. `topicFor` runs before compose/post
 * in `reminders/dispatcher.ts`, whose `accepted === false` contract treats a
 * throw as "the post did not happen" — so the tick loop would revert the claim
 * and re-fire the same reminder every tick, forever. A lister or reporter that
 * throws is caught, reported, and degraded to General.
 */
export function buildAppWsReminderTopicResolver(
  input: BuildAppWsReminderTopicResolverInput,
): (explicit_topic: string | null) => string {
  const { owner_user_id, listProjectIds, onDowngrade } = input
  const general = appWsTopicId(owner_user_id)
  return (explicit_topic: string | null): string => {
    if (explicit_topic === null || explicit_topic.trim().length === 0) return general
    const topic = explicit_topic.trim()
    const downgrade = (
      reason: ReminderTopicDowngradeReason,
      candidate: string | null,
      error?: string,
    ): string => {
      if (onDowngrade !== undefined) {
        const event: ReminderTopicDowngrade = { explicit_topic: topic, reason, candidate }
        if (error !== undefined) event.error = error
        try {
          onDowngrade(event)
        } catch {
          // A reporting failure must never become a delivery failure.
        }
      }
      return general
    }
    // Deref the live project list AT MOST ONCE per resolution (per-fire, so a
    // project created after boot routes scoped on its next fire). `'unavailable'`
    // is a THIRD state, distinct from "the list is empty": it must be reported,
    // not silently collapsed into "this project does not exist".
    let known: ReadonlyArray<string> | 'unavailable' | null = null
    let listError = ''
    const isKnownProject = (id: string): boolean | 'unavailable' => {
      if (id.length === 0) return false
      if (known === null) {
        try {
          known = listProjectIds()
        } catch (err) {
          known = 'unavailable'
          listError = err instanceof Error ? err.message : String(err)
        }
      }
      if (known === 'unavailable') return 'unavailable'
      return known.includes(id)
    }
    /** `candidate` → the project topic, or a REPORTED downgrade to General. */
    const routeToProject = (candidate: string): string => {
      if (candidate.length === 0) return downgrade('malformed_destination', null)
      const verdict = isKnownProject(candidate)
      if (verdict === 'unavailable') {
        return downgrade('project_list_unavailable', candidate, listError)
      }
      if (!verdict) return downgrade('unknown_project', candidate)
      return appWsProjectTopicId(owner_user_id, candidate)
    }

    // Already surface-shaped. Accept only what THIS owner's client binds: the
    // bare topic, or a project topic naming an existing project.
    if (topic.startsWith('app:')) {
      const rest = topic.slice('app:'.length)
      const sep = rest.indexOf(':')
      if (sep < 0) return rest === owner_user_id ? topic : downgrade('foreign_user', null)
      const user = rest.slice(0, sep)
      const project = rest.slice(sep + 1)
      if (user !== owner_user_id) return downgrade('foreign_user', project.length > 0 ? project : null)
      return routeToProject(project)
    }

    // Engine shapes → a candidate project id.
    if (topic.startsWith('app-project:')) {
      return routeToProject(topic.slice('app-project:'.length))
    }
    if (topic.startsWith('web:')) {
      // `web:<user>` (General) → no project; `web:<user>:<project>` → project.
      // Mirrors `deriveReminderProjectId` (`reminders/dispatcher.ts`): the first
      // `:` after the prefix splits the user from the project.
      //
      // THE USER SEGMENT IS VALIDATED, exactly as the `app:` branch above does
      // (Argus round 1, confirmed x2: this branch used to compute the candidate
      // and never look at the user, so `web:someoneelse:neutron-open` resolved to
      // `app:owner:neutron-open` — a foreign-scoped legacy destination silently
      // acquiring the owner's project topic).
      const sep = topic.indexOf(':', 'web:'.length)
      const user = sep < 0 ? topic.slice('web:'.length) : topic.slice('web:'.length, sep)
      const project = sep < 0 ? '' : topic.slice(sep + 1)
      if (user !== owner_user_id) {
        return downgrade('foreign_user', project.length > 0 ? project : null)
      }
      // `web:<owner>` with no project segment IS the legacy General destination —
      // not a downgrade, the designed answer.
      if (sep < 0) return general
      return routeToProject(project)
    }
    // Raw engine destination = the project id itself (Reminders Core path, and
    // the production-dominant shape: 94 of 97 live rows at the time of the fix).
    return routeToProject(topic)
  }
}
