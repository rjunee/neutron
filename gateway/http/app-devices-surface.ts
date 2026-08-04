/**
 * @neutronai/gateway/http — Expo-app device push-token surface (P5.6).
 *
 * Per SPEC.md § Phases→Steps (P5.6 — "native push
 * via Expo Push (APNs + FCM); Telegram remains a sibling channel") and
 * docs/engineering-plan.md § B.P5. Exposes two routes:
 *
 *   * `POST /api/app/devices/register`
 *       body: `{ device_token: string, platform: 'ios'|'android' }`
 *   * `POST /api/app/devices/unregister`
 *       body: `{ device_token: string }`
 *
 * Auth shares the app-ws / launcher / tasks / reminders surface
 * contract (`AppWsAuthResolver` Bearer token). The handler returns
 * `null` for non-owned paths so unrelated `/api/app/...` routes fall
 * through to the downstream chain in `gateway/http/compose.ts`.
 *
 * The store is the per-instance `DevicePushTokenStore`
 * (`gateway/push/store.ts`) — same per-instance SQLite handle the
 * reminders engine writes to. Register is idempotent on
 * `(project_slug, device_token)`; the store's ON CONFLICT clause
 * swaps `user_id` + `updated_at` if the device changed hands.
 *
 * OBSERVABILITY (ISSUES #487) — EVERY request that reaches this surface
 * emits EXACTLY ONE structured line through `@neutronai/logger`, whatever
 * the outcome: 401, 405, 400, 500 or 200. That is the whole point of the
 * change. `device_push_tokens` was found holding zero rows on a live
 * instance, and because neither this surface nor `push/store.ts` logged
 * anything, "the app never called register" and "the app called and was
 * rejected" produced byte-identical evidence: nothing at all. A silent
 * failure here is invisible by construction, and it stayed invisible
 * until a reminder fired with nowhere to send.
 *
 * NEVER LOG THE TOKEN. A device token is a credential — anyone holding it
 * can push to the owner's phone. Lines carry `token_fp`, the first 12 hex
 * chars of its SHA-256, which is enough to correlate a register with the
 * unregister or the Expo prune that later removes it, and useless to an
 * attacker. `__tests__/app-devices-surface.test.ts` asserts the raw value
 * never appears in a rendered line.
 */

import { createHash } from 'node:crypto'

import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import { createLogger, type LogFields } from '@neutronai/logger'
import {
  type DevicePushPlatform,
  type DevicePushToken,
  type DevicePushTokenStore,
  isDevicePushPlatform,
} from '../push/store.ts'
import { jsonResponse, readJsonBody, resolveBearer, type ResolvedAuth } from './surface-kit.ts'

const moduleLog = createLogger('app-devices')

const REGISTER_PATH = '/api/app/devices/register'
const UNREGISTER_PATH = '/api/app/devices/unregister'

/**
 * Cap the device_token length. Expo's `ExponentPushToken[<id>]` strings
 * are ~40-60 chars; FCM and APNs raw tokens are ~64-200 bytes. 512 is
 * a comfortable upper bound that rejects malformed payloads without
 * cutting off real tokens.
 */
export const MAX_DEVICE_TOKEN_LEN = 512

/**
 * The three leveled emitters this surface uses. Structurally a subset of
 * `@neutronai/logger`'s `Logger`, so production passes nothing and gets the
 * module logger, while a test passes `createLogger('app-devices', { sink })`
 * and reads the REAL rendered lines (not a mock's argument list) — which is
 * what makes the "the token is never in the output" assertion meaningful.
 */
export interface AppDevicesLogger {
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  error(event: string, fields?: LogFields): void
}

export interface AppDevicesSurfaceOptions {
  store: DevicePushTokenStore
  auth: AppWsAuthResolver
  /** Defaults to the module logger; tests inject a capturing sink. */
  logger?: AppDevicesLogger
}

export interface AppDevicesSurface {
  handler: (req: Request) => Promise<Response | null>
}

/**
 * SHA-256 of the token, first 12 hex chars. Correlates two lines about the
 * same device without ever putting the credential itself in a log, a
 * journal, or a support paste. 48 bits of digest is far past collision
 * risk for the handful of devices one owner registers, and preimage
 * recovery of a ~40-char opaque token from 12 hex chars is not a thing.
 */
function tokenFingerprint(device_token: string): string {
  return createHash('sha256').update(device_token).digest('hex').slice(0, 12)
}

/**
 * Best-effort fingerprint of whatever the body claimed, for the REJECTION
 * lines. A rejected body may carry no token at all (or a non-string), in
 * which case there is nothing to fingerprint and the field is omitted
 * rather than rendered as a lie.
 */
function claimedTokenFingerprint(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const v = (body as Record<string, unknown>)['device_token']
  if (typeof v !== 'string' || v.length === 0) return undefined
  return tokenFingerprint(v)
}

export function createAppDevicesSurface(
  opts: AppDevicesSurfaceOptions,
): AppDevicesSurface {
  const { store, auth } = opts
  const log: AppDevicesLogger = opts.logger ?? moduleLog
  return {
    handler: async (req) => {
      const url = new URL(req.url)
      const pathname = url.pathname
      const isRegister = pathname === REGISTER_PATH
      const isUnregister = pathname === UNREGISTER_PATH
      if (!isRegister && !isUnregister) return null

      const route = isRegister ? 'register' : 'unregister'
      const method = req.method
      if (method !== 'POST') {
        log.warn('device_request_rejected', { route, reason: 'method_not_allowed', method })
        return jsonResponse(405, {
          ok: false,
          code: 'method_not_allowed',
          message: `expected POST for ${pathname} but got ${method}`,
        })
      }

      const resolved = await resolveBearer(req, auth)
      if ('code' in resolved) {
        // The single most likely explanation for an empty token table that
        // is NOT "the app never called": the app called with a bearer the
        // instance rejects (expired, minted by a different host, wiped
        // session). Without this line that case looks like silence.
        log.warn('device_request_unauthorized', { route, reason: resolved.code })
        return jsonResponse(401, { ok: false, code: resolved.code, message: resolved.message })
      }

      if (isRegister) {
        return await handleRegister(req, store, resolved, log)
      }
      return await handleUnregister(req, store, resolved, log)
    },
  }
}

async function handleRegister(
  req: Request,
  store: DevicePushTokenStore,
  resolved: ResolvedAuth,
  log: AppDevicesLogger,
): Promise<Response> {
  const body = await readJsonBody(req)
  if (body === null) {
    log.warn('device_register_rejected', {
      project_slug: resolved.project_slug,
      user_id: resolved.user_id,
      reason: 'malformed_json',
    })
    return jsonResponse(400, {
      ok: false,
      code: 'malformed_json',
      message: 'expected { device_token: string, platform: "ios"|"android" }',
    })
  }
  const device_token = readDeviceToken(body)
  if (device_token === null) {
    log.warn('device_register_rejected', {
      project_slug: resolved.project_slug,
      user_id: resolved.user_id,
      reason: 'missing_device_token',
      token_fp: claimedTokenFingerprint(body),
    })
    return jsonResponse(400, {
      ok: false,
      code: 'missing_device_token',
      message: `expected device_token: non-empty string up to ${MAX_DEVICE_TOKEN_LEN} chars`,
    })
  }
  const platform = readPlatform(body)
  if (platform === null) {
    log.warn('device_register_rejected', {
      project_slug: resolved.project_slug,
      user_id: resolved.user_id,
      reason: 'invalid_platform',
      token_fp: tokenFingerprint(device_token),
    })
    return jsonResponse(400, {
      ok: false,
      code: 'invalid_platform',
      message: 'expected platform: "ios" | "android"',
    })
  }
  let row: DevicePushToken
  try {
    row = await store.register({
      project_slug: resolved.project_slug,
      user_id: resolved.user_id,
      device_token,
      platform,
    })
  } catch (err) {
    // Previously this threw straight out of the handler, so a store failure
    // reached the client as whatever the composer does with an exception and
    // reached the operator as nothing. A push that never arrives has to be
    // explainable from the logs alone.
    log.error('device_register_failed', {
      project_slug: resolved.project_slug,
      user_id: resolved.user_id,
      platform,
      token_fp: tokenFingerprint(device_token),
      message: err instanceof Error ? err.message : String(err),
    })
    return jsonResponse(500, {
      ok: false,
      code: 'register_failed',
      message: 'could not persist the device token',
    })
  }
  log.info('device_registered', {
    project_slug: row.project_slug,
    user_id: row.user_id,
    platform: row.platform,
    token_fp: tokenFingerprint(device_token),
    // The store's ON CONFLICT keeps the original `registered_at` and stamps a
    // fresh `updated_at`, so equality means this INSERT created the row.
    // Distinguishes "a device just appeared" from "the same phone signed in
    // again" without a second query.
    first_registration: row.registered_at === row.updated_at,
  })
  return jsonResponse(200, {
    ok: true,
    device: {
      id: row.id,
      project_slug: row.project_slug,
      user_id: row.user_id,
      platform: row.platform,
      registered_at: row.registered_at,
      updated_at: row.updated_at,
    },
  })
}

async function handleUnregister(
  req: Request,
  store: DevicePushTokenStore,
  resolved: ResolvedAuth,
  log: AppDevicesLogger,
): Promise<Response> {
  const body = await readJsonBody(req)
  if (body === null) {
    log.warn('device_unregister_rejected', {
      project_slug: resolved.project_slug,
      user_id: resolved.user_id,
      reason: 'malformed_json',
    })
    return jsonResponse(400, {
      ok: false,
      code: 'malformed_json',
      message: 'expected { device_token: string }',
    })
  }
  const device_token = readDeviceToken(body)
  if (device_token === null) {
    log.warn('device_unregister_rejected', {
      project_slug: resolved.project_slug,
      user_id: resolved.user_id,
      reason: 'missing_device_token',
      token_fp: claimedTokenFingerprint(body),
    })
    return jsonResponse(400, {
      ok: false,
      code: 'missing_device_token',
      message: `expected device_token: non-empty string up to ${MAX_DEVICE_TOKEN_LEN} chars`,
    })
  }
  const removed = await store.unregister(resolved.project_slug, device_token)
  if (!removed) {
    log.warn('device_unregister_rejected', {
      project_slug: resolved.project_slug,
      user_id: resolved.user_id,
      reason: 'device_not_found',
      token_fp: tokenFingerprint(device_token),
    })
    return jsonResponse(404, {
      ok: false,
      code: 'device_not_found',
      message: 'no device with that token for this project',
    })
  }
  // An unregister is how the table goes back to empty. Logging it is what
  // makes "who emptied it, and when" answerable after the fact.
  log.info('device_unregistered', {
    project_slug: resolved.project_slug,
    user_id: resolved.user_id,
    token_fp: tokenFingerprint(device_token),
  })
  return jsonResponse(200, { ok: true })
}

function readDeviceToken(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const v = (body as Record<string, unknown>)['device_token']
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_DEVICE_TOKEN_LEN) return null
  return trimmed
}

function readPlatform(body: unknown): DevicePushPlatform | null {
  if (typeof body !== 'object' || body === null) return null
  const v = (body as Record<string, unknown>)['platform']
  if (!isDevicePushPlatform(v)) return null
  return v
}
