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
 */

import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import {
  type DevicePushPlatform,
  type DevicePushTokenStore,
  isDevicePushPlatform,
} from '../push/store.ts'
import { jsonResponse, readJsonBody, resolveBearer, type ResolvedAuth } from './surface-kit.ts'

const REGISTER_PATH = '/api/app/devices/register'
const UNREGISTER_PATH = '/api/app/devices/unregister'

/**
 * Cap the device_token length. Expo's `ExponentPushToken[<id>]` strings
 * are ~40-60 chars; FCM and APNs raw tokens are ~64-200 bytes. 512 is
 * a comfortable upper bound that rejects malformed payloads without
 * cutting off real tokens.
 */
export const MAX_DEVICE_TOKEN_LEN = 512

export interface AppDevicesSurfaceOptions {
  store: DevicePushTokenStore
  auth: AppWsAuthResolver
}

export interface AppDevicesSurface {
  handler: (req: Request) => Promise<Response | null>
}

export function createAppDevicesSurface(
  opts: AppDevicesSurfaceOptions,
): AppDevicesSurface {
  const { store, auth } = opts
  return {
    handler: async (req) => {
      const url = new URL(req.url)
      const pathname = url.pathname
      const isRegister = pathname === REGISTER_PATH
      const isUnregister = pathname === UNREGISTER_PATH
      if (!isRegister && !isUnregister) return null

      const method = req.method
      if (method !== 'POST') {
        return jsonResponse(405, {
          ok: false,
          code: 'method_not_allowed',
          message: `expected POST for ${pathname} but got ${method}`,
        })
      }

      const resolved = await resolveBearer(req, auth)
      if ('code' in resolved) {
        return jsonResponse(401, { ok: false, code: resolved.code, message: resolved.message })
      }

      if (isRegister) {
        return await handleRegister(req, store, resolved)
      }
      return await handleUnregister(req, store, resolved)
    },
  }
}

async function handleRegister(
  req: Request,
  store: DevicePushTokenStore,
  resolved: ResolvedAuth,
): Promise<Response> {
  const body = await readJsonBody(req)
  if (body === null) {
    return jsonResponse(400, {
      ok: false,
      code: 'malformed_json',
      message: 'expected { device_token: string, platform: "ios"|"android" }',
    })
  }
  const device_token = readDeviceToken(body)
  if (device_token === null) {
    return jsonResponse(400, {
      ok: false,
      code: 'missing_device_token',
      message: `expected device_token: non-empty string up to ${MAX_DEVICE_TOKEN_LEN} chars`,
    })
  }
  const platform = readPlatform(body)
  if (platform === null) {
    return jsonResponse(400, {
      ok: false,
      code: 'invalid_platform',
      message: 'expected platform: "ios" | "android"',
    })
  }
  const row = await store.register({
    project_slug: resolved.project_slug,
    user_id: resolved.user_id,
    device_token,
    platform,
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
): Promise<Response> {
  const body = await readJsonBody(req)
  if (body === null) {
    return jsonResponse(400, {
      ok: false,
      code: 'malformed_json',
      message: 'expected { device_token: string }',
    })
  }
  const device_token = readDeviceToken(body)
  if (device_token === null) {
    return jsonResponse(400, {
      ok: false,
      code: 'missing_device_token',
      message: `expected device_token: non-empty string up to ${MAX_DEVICE_TOKEN_LEN} chars`,
    })
  }
  const removed = await store.unregister(resolved.project_slug, device_token)
  if (!removed) {
    return jsonResponse(404, {
      ok: false,
      code: 'device_not_found',
      message: 'no device with that token for this project',
    })
  }
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
