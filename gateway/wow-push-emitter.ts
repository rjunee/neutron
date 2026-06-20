/**
 * @neutronai/gateway/wow-push-emitter (2026-05-22 push-deeplink-wow sprint;
 * ISSUE #39 per-user scope fix 2026-05-23).
 *
 * The wow-moment push trigger. Reads device push tokens via
 * `DevicePushTokenStore.listByUser(project_slug, user_id)` and dispatches
 * a single Expo Push API batch via `PushDispatcher.pushUser` with a 🚀
 * title + `kind: 'wow_fired'` payload — only THIS user's devices
 * receive the push, never the rest of the instance's users (group
 * projects per master-plan §5.1).
 *
 * Fail-closed on missing user_id: when `user_id` is null or an empty
 * string (the regression shape — a future caller dropping the field),
 * the emitter logs a structured warning and SKIPS the push entirely
 * rather than falling through to instance-wide `pushAll`. Reason: the
 * fallback fan-out preserves the privacy leak this sprint is fixing.
 * Codex r1 P2 on PR #291 flagged the original fail-open + warn shape;
 * we let it ride after re-reading the brief because in practice every
 * caller threads user_id post-this-sprint, so the only path that hits
 * the fallback IS a regression. Better to skip + warn than leak +
 * warn — the missing notification is a loud user-visible bug a human
 * reports; a leaky push arrives BEFORE anyone reads logs.
 *
 * Called once per (instance, user) from the engine's
 * `dispatchWowAndAdvance` branch — gated on
 * `onboarding_state.wow_pushed_at === null` so a crash-resume of the
 * `wow_fired` phase never re-fires the push.
 *
 * Surface contract (Argus r1 BLOCKER fix, 2026-05-22 round 2):
 *
 *   emitWowPush({project_slug, topic_id, push_dispatcher, store, projects_store})
 *
 * The engine threads only `(project_slug, user_id, topic_id)`. The
 * production composer (`gateway/index.ts`) closes over the per-instance
 * `PushDispatcher`, `DevicePushTokenStore`, AND the canonical
 * `ProjectSettingsStore` so the emitter can resolve the deep-link
 * `project_id` here — the engine no longer assumes the WS topic_id
 * encodes a project_id, which it does not for `web:<user_id>` /
 * `app:<user_id>` shapes (the chat-bridge production path).
 *
 * `project_id` resolution rules — `resolveWowPushProjectId`:
 *   1. If `topic_id` starts with `app-project:<X>` (the only shape
 *      that LITERALLY encodes a project_id — emitted by the
 *      app-reminders surface, see
 *      `gateway/http/app-reminders-surface.ts:appProjectTopicId`),
 *      strip the prefix and use `X`.
 *   2. Else, look up the instance's projects via
 *      `projects_store.list(project_slug)`. If any row's `id` matches
 *      `DEFAULT_WOW_PROJECT_ID` (`'neutron'`), prefer that — the wow
 *      target is the canonical neutron-project chat surface and the
 *      seed-time `nowIso()` ordering in `seedDefaults` makes northwind
 *      (the last-seeded row) the `updated_at DESC` winner of `list[0]`
 *      for fresh instances. Fixed at Argus r2 round 3, 2026-05-23 — see
 *      gateway/__tests__/wow-push-emitter.test.ts REGRESSION (fresh
 *      instance production seed order) for the trap shape.
 *   3. Else, fall through to `list[0]` (most-recently-updated — the
 *      right answer for an instance whose neutron project was deleted or
 *      who only operates a single non-neutron project).
 *   4. Fall back to `DEFAULT_WOW_PROJECT_ID = 'neutron'` if the
 *      lookup throws OR returns zero rows.
 *
 * Tests inject a recorder closure directly, bypassing this module
 * entirely.
 *
 * Why pre-check `store.listByOwner`: the dispatcher's `pushAll`
 * already short-circuits on an empty `messages[]`, so the empty-check
 * here is observable behaviour (a structured "no devices, skip" log
 * line) rather than a correctness gate. The brief calls it out
 * explicitly under "fires once, idempotent, skips when token store
 * empty" in the test plan; surfacing the skip in the emitter keeps
 * the gateway logs grep-able when a user reached wow_fired without
 * registering a push token (web-only signup today).
 *
 * Failure semantics: `pushAll` swallows ExpoPushError / network
 * failures internally (see PushDispatcher.dispatch) so this module
 * never throws on a downstream push outage. The engine wraps the
 * emitter call in try/catch as a belt-and-braces measure — a
 * malformed payload should not be able to wedge the wow_fired
 * transition.
 */

import type { PushDispatcher } from './push/dispatcher.ts'
import type { DevicePushTokenStore } from './push/store.ts'
import type { ProjectSettings } from './http/app-projects-surface.ts'

/**
 * Narrow projection of `ProjectSettingsStore.list` so the emitter
 * does not depend on the rest of the projects-store surface (only
 * the listing shape it actually needs to pick a first row).
 */
export interface WowPushProjectsStore {
  list(project_slug: string): Promise<ReadonlyArray<Pick<ProjectSettings, 'id'>>>
}

export interface EmitWowPushInput {
  /**
   * The dispatched instance identity (frozen `internal_handle` when
   * threaded through `dispatchWowAndAdvance` — same convention the
   * dispatcher itself uses to avoid orphaning rows across a slug
   * rename mid-`wow_fired`).
   */
  project_slug: string
  /**
   * ISSUE #39 (2026-05-23) — user identity for per-user push fan-out.
   * When set, the emitter calls `push_dispatcher.pushUser(project_slug,
   * user_id, ...)` so only THIS user's registered devices receive the
   * wow_fired push. In a multi-user instance (group projects per
   * master-plan §5.1) this prevents user B from seeing user A's
   * onboarding completion push.
   *
   * When `null` or empty (the regression shape — a future caller
   * dropping the field), the emitter logs a structured warning and
   * SKIPS the push entirely. Falling through to instance-wide `pushAll`
   * would re-create the privacy leak this sprint is fixing — see the
   * module header for the full reasoning (Codex r1 P2 on PR #291).
   * Production composer threads the engine's
   * `WowPushEmitterInput.user_id` through here on every call; the
   * fail-closed branch is a defensive guard for regressions.
   */
  user_id: string | null
  /**
   * Raw onboarding `topic_id` forwarded from the engine. Resolved
   * to the deep-link `project_id` inside this module via
   * `resolveWowPushProjectId`. See module header for the rules.
   */
  topic_id: string
  /**
   * High-level dispatcher constructed once per gateway and shared
   * across the reminder fan-out + this emitter.
   */
  push_dispatcher: PushDispatcher
  /**
   * Device-token store. Read here for the early-skip log; the
   * dispatcher's `pushUser` / `pushAll` reads it again to build the
   * `ExpoPushMessage[]` batch.
   */
  store: DevicePushTokenStore
  /**
   * Canonical projects-store. Used as the project_id resolution
   * fallback when `topic_id` does NOT carry the literal
   * `app-project:<X>` encoding (i.e. the chat-bridge production path,
   * where `topic_id = 'web:<user_id>'`).
   */
  projects_store: WowPushProjectsStore
}

/**
 * Pinned copy — kept here as exported constants so the test suite can
 * assert the wire shape without re-quoting the strings inline.
 */
export const WOW_PUSH_TITLE = '🚀 Your first task is done!'
export const WOW_PUSH_BODY = 'Tap to see what your agent built.'

/**
 * Fallback deep-link `project_id` for instances whose canonical
 * projects-store enumeration is empty (or throws) AND whose engine
 * `topic_id` is a non-`app-project:` shape (chat-bridge). Matches the
 * canonical seed `gateway/index.ts` materializes at boot
 * (`seedDefaults([neutron, acme, northwind])`), so a fresh
 * onboarding-only user lands on a real `/projects/neutron/chat`
 * route rather than a 404.
 */
export const DEFAULT_WOW_PROJECT_ID = 'neutron'

const APP_PROJECT_TOPIC_PREFIX = 'app-project:'

export async function emitWowPush(input: EmitWowPushInput): Promise<void> {
  // ISSUE #39 (2026-05-23) — per-user fan-out routing. Fail CLOSED on
  // missing user_id rather than fall back to instance-wide `pushAll`:
  //   * Codex r1 P2 on PR #291 flagged that the original brief's
  //     "fall back to pushAll" recovery preserved the same multi-user
  //     privacy leak the sprint is fixing — a future caller dropping
  //     user_id (the only realistic regression vector) would still
  //     fan out to every device on the instance, defeating the fix.
  //   * Every actual caller (production composer at
  //     gateway/index.ts:wowPushEmitterRef + every test fixture in
  //     this PR) threads user_id, so the fallback path has no real
  //     traffic. Skipping the push entirely keeps prod behaviour
  //     identical AND makes regression-via-missing-user_id loud
  //     rather than silently-leaky: the warn lands in journald (grep
  //     target `no user_id on emit input`) and no push leaves the
  //     gateway. A missing wow notification is a noticeable user-
  //     facing regression a real human will report; a leaky push to
  //     another user is silent and arrives BEFORE anyone reads logs.
  // Hoist user_id into a `string`-typed local so the rest of the
  // function reads as a normal happy-path; the narrow lives at the
  // type level, not in repeated `as string` casts.
  const user_id: string | null = input.user_id
  if (user_id === null || user_id.length === 0) {
    console.warn(
      `[wow-push] no user_id on emit input — skipping push to avoid project-wide fan-out (project=${input.project_slug}). This is the ISSUE #39 fail-closed guard; a real caller is expected to thread user_id.`,
    )
    return
  }
  // Early-skip when no devices registered for this user. The
  // dispatcher's pushUser would no-op on an empty messages[] too, but
  // surfacing the skip here keeps gateway logs grep-able.
  const tokens = input.store.listByUser(input.project_slug, user_id)
  if (tokens.length === 0) return
  const project_id = await resolveWowPushProjectId(input)
  await input.push_dispatcher.pushUser(input.project_slug, user_id, {
    title: WOW_PUSH_TITLE,
    body: WOW_PUSH_BODY,
    data: {
      kind: 'wow_fired',
      project_id,
    },
  })
}

/**
 * Resolve the deep-link `project_id` for a wow-push given the engine's
 * raw `topic_id` + the per-instance projects-store. See module header
 * for the full rule set. Exported so the bun-test suite can assert
 * the resolution behaviour against synthesized topic_id shapes
 * without booting the full emit path.
 */
export async function resolveWowPushProjectId(input: {
  project_slug: string
  topic_id: string
  projects_store: WowPushProjectsStore
}): Promise<string> {
  if (input.topic_id.startsWith(APP_PROJECT_TOPIC_PREFIX)) {
    const stripped = input.topic_id.slice(APP_PROJECT_TOPIC_PREFIX.length)
    if (stripped.length > 0) return stripped
  }
  try {
    const projects = await input.projects_store.list(input.project_slug)
    if (projects.length > 0) {
      // Prefer the canonical wow target (`neutron`) when present in the
      // instance's projects list. The seed-time `nowIso()` per-row writes
      // in `seedDefaults` make the LAST-seeded row (`northwind`) the
      // `updated_at DESC` winner of `list[0]` on a fresh instance — so
      // `list[0]` alone routes the wow push to `/projects/northwind/chat`
      // contradicting the documented neutron-chat target. Argus r2
      // round 3 fix, 2026-05-23.
      const canonical = projects.find(
        (p) => p !== undefined && p.id === DEFAULT_WOW_PROJECT_ID,
      )
      if (canonical !== undefined && canonical.id.length > 0) return canonical.id
      const first = projects[0]
      if (first !== undefined && first.id.length > 0) return first.id
    }
  } catch (err) {
    console.warn(
      `[wow-push] projects_store.list failed for project=${input.project_slug}: ${
        err instanceof Error ? err.message : String(err)
      } — falling back to ${DEFAULT_WOW_PROJECT_ID}`,
    )
  }
  return DEFAULT_WOW_PROJECT_ID
}
