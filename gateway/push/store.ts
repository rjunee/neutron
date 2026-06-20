/**
 * @neutronai/gateway/push — device push token store.
 *
 * P5.6 — persists Expo push tokens registered by the Expo client at
 * login/foreground time. The reminder-fired hook reads tokens for the
 * fired reminder's instance and POSTs them as a single batch to the
 * Expo Push API via `ExpoPushClient`.
 *
 * Backed by migration `0033_device_push_tokens.sql`. Idempotent
 * register-on-conflict is the v1 contract: re-registering the same
 * `(project_slug, device_token)` swaps the `user_id` and updates the
 * `updated_at` timestamp so a sign-out / sign-in dance on the same
 * device cannot leave stale rows pointing at the wrong user.
 *
 * Per SPEC.md § Phases→Steps (P5.6) and
 * docs/engineering-plan.md § B.P5.
 */

import type { ProjectDb } from '../../persistence/index.ts'

/**
 * Platforms recognised by the Expo Push API. Mirrors the CHECK
 * constraint in `0033_device_push_tokens.sql` as trimmed by migration
 * `0042_drop_web_push_platform.sql` (2026-05-22 — web push removed; no
 * customer ask, dead code path. A real W3C-Push-API/VAPID/service-worker
 * implementation is a fresh sprint and will re-add its own enum value
 * via its own migration when it lands).
 */
export type DevicePushPlatform = 'ios' | 'android'

export const ALL_DEVICE_PUSH_PLATFORMS: ReadonlyArray<DevicePushPlatform> = [
  'ios',
  'android',
]

export function isDevicePushPlatform(value: unknown): value is DevicePushPlatform {
  return value === 'ios' || value === 'android'
}

export interface DevicePushToken {
  id: string
  project_slug: string
  user_id: string
  device_token: string
  platform: DevicePushPlatform
  registered_at: string
  updated_at: string
}

export interface RegisterDeviceTokenInput {
  project_slug: string
  user_id: string
  device_token: string
  platform: DevicePushPlatform
  /** Optional caller-supplied id; UUID generated if absent. */
  id?: string
}

interface DevicePushTokenRow {
  id: string
  project_slug: string
  user_id: string
  device_token: string
  platform: DevicePushPlatform
  registered_at: string
  updated_at: string
}

const COLS =
  'id, project_slug, user_id, device_token, platform, registered_at, updated_at'

export class DevicePushTokenStore {
  constructor(private readonly db: ProjectDb) {}

  /**
   * Register (or refresh) a device token. Idempotent on
   * `(project_slug, device_token)`: a second register for the same pair
   * UPDATEs the row's `user_id` (in case the device changed hands) and
   * stamps a fresh `updated_at`, but does NOT mint a new id.
   *
   * Returns the resulting row (post-insert or post-update).
   */
  async register(input: RegisterDeviceTokenInput): Promise<DevicePushToken> {
    const now = new Date().toISOString()
    const newId = input.id ?? crypto.randomUUID()
    // ON CONFLICT updates user_id + updated_at + platform but keeps the
    // original id + registered_at. The platform refresh handles the
    // (rare) case where the OS re-issues the same opaque token with a
    // different platform tag — we trust the new claim.
    await this.db.run(
      `INSERT INTO device_push_tokens
         (id, project_slug, user_id, device_token, platform, registered_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_slug, device_token) DO UPDATE
         SET user_id = excluded.user_id,
             platform = excluded.platform,
             updated_at = excluded.updated_at`,
      [
        newId,
        input.project_slug,
        input.user_id,
        input.device_token,
        input.platform,
        now,
        now,
      ],
    )
    const row = this.getByDeviceToken(input.project_slug, input.device_token)
    // The INSERT-OR-UPDATE we just ran guarantees a row exists for
    // (project_slug, device_token). A null here means the DB lost a row
    // mid-flight — surface loudly rather than masking it.
    if (row === null) {
      throw new Error(
        `device_push_tokens insert raced: no row for project=${input.project_slug} token=<redacted>`,
      )
    }
    return row
  }

  /**
   * Unregister a device token scoped to an instance. Returns true if a row
   * was removed. Used by sign-out and by the Expo client when the user
   * revokes notification permission.
   */
  async unregister(project_slug: string, device_token: string): Promise<boolean> {
    const before = this.getByDeviceToken(project_slug, device_token)
    if (before === null) return false
    await this.db.run(
      `DELETE FROM device_push_tokens WHERE project_slug = ? AND device_token = ?`,
      [project_slug, device_token],
    )
    return true
  }

  /**
   * Look up a single token by `(project_slug, device_token)`. Used by
   * register/unregister to confirm row existence + by tests to assert
   * the post-mutation row shape.
   */
  getByDeviceToken(project_slug: string, device_token: string): DevicePushToken | null {
    const row = this.db
      .prepare<DevicePushTokenRow, [string, string]>(
        `SELECT ${COLS}
           FROM device_push_tokens
          WHERE project_slug = ? AND device_token = ?`,
      )
      .get(project_slug, device_token)
    return row === null ? null : rowToToken(row)
  }

  /**
   * Snapshot of every token registered for an instance. The reminder-fired
   * hook fans out across this set since v1 reminders are project-scoped
   * (no per-user routing yet). Sorted by `updated_at DESC` so the
   * freshest devices land first — useful when the Expo Push API caps
   * us at 100 messages per request and the gateway needs to pick the
   * most-recent batch.
   */
  listByOwner(project_slug: string): DevicePushToken[] {
    return this.db
      .prepare<DevicePushTokenRow, [string]>(
        `SELECT ${COLS}
           FROM device_push_tokens
          WHERE project_slug = ?
          ORDER BY updated_at DESC`,
      )
      .all(project_slug)
      .map(rowToToken)
  }

  /**
   * Snapshot of tokens registered for a single user within an instance.
   * Group-project routing (M3) reads through here
   * when the future per-user fan-out lands; v1 reminders use
   * `listByOwner` since project-scoped reminders today are
   * project-scoped to a solo-owner deployment.
   */
  listByUser(project_slug: string, user_id: string): DevicePushToken[] {
    return this.db
      .prepare<DevicePushTokenRow, [string, string]>(
        `SELECT ${COLS}
           FROM device_push_tokens
          WHERE project_slug = ? AND user_id = ?
          ORDER BY updated_at DESC`,
      )
      .all(project_slug, user_id)
      .map(rowToToken)
  }
}

function rowToToken(row: DevicePushTokenRow): DevicePushToken {
  return {
    id: row.id,
    project_slug: row.project_slug,
    user_id: row.user_id,
    device_token: row.device_token,
    platform: row.platform,
    registered_at: row.registered_at,
    updated_at: row.updated_at,
  }
}
