/**
 * @neutronai/app — device push-token registration client (P5.6).
 *
 * Thin fetch wrapper around the gateway's
 * `/api/app/devices/(register|unregister)` surface. Mirrors the
 * Reminders / Tasks client shape: pass the bearer token at
 * construction time, return the post-mutation response.
 *
 * The expo-notifications integration in `push.ts` calls
 * `registerToken` once on login (and again on app foreground when the
 * Expo token rotates) and `unregisterToken` from the sign-out flow.
 *
 * Per SPEC.md § Phases→Steps / P5.6 and
 * docs/engineering-plan.md § B.P5.
 */

// 2026-05-22 — web platform removed (migration 0042, no customer ask).
// `isPushSupported()` in push.ts already gates on Platform.OS so a web
// client never reaches `registerToken`; this type now matches the
// gateway's trimmed CHECK enum so a future caller can't pass 'web'
// without TS catching it.
export type DevicePlatform = 'ios' | 'android';

export interface DeviceRegistration {
  id: string;
  project_slug: string;
  user_id: string;
  platform: DevicePlatform;
  registered_at: string;
  updated_at: string;
}

export interface DevicesClientOptions {
  base_url: string;
  token: string;
}

interface RegisterResponse {
  ok: boolean;
  device: DeviceRegistration;
}

interface UnregisterResponse {
  ok: boolean;
}

export class DevicesClient {
  private readonly base_url: string;
  private readonly token: string;

  constructor(opts: DevicesClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '');
    this.token = opts.token;
  }

  /**
   * Register (or refresh) an Expo push token on the gateway. Idempotent
   * on `(project_slug, device_token)`: re-registering the same token
   * just refreshes `updated_at` server-side.
   */
  async registerToken(
    device_token: string,
    platform: DevicePlatform,
  ): Promise<DeviceRegistration> {
    const res = await this.req<RegisterResponse>('/api/app/devices/register', {
      method: 'POST',
      body: { device_token, platform },
    });
    return res.device;
  }

  /**
   * Remove a previously-registered token. The gateway returns 404 if
   * the token is unknown for this instance; we surface that as a
   * `device_not_found` error code via `DevicesClientError`.
   */
  async unregisterToken(device_token: string): Promise<void> {
    await this.req<UnregisterResponse>('/api/app/devices/unregister', {
      method: 'POST',
      body: { device_token },
    });
  }

  private async req<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const method = init.method ?? 'GET';
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
    };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    const res = await fetch(`${this.base_url}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // fall through
    }
    if (!res.ok) {
      const code = (json as { code?: string } | null)?.code ?? 'request_failed';
      const message =
        (json as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
      throw new DevicesClientError(code, message, res.status);
    }
    return json as T;
  }
}

export class DevicesClientError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(`${code}: ${message}`);
    this.name = 'DevicesClientError';
    this.code = code;
    this.status = status;
  }
}
