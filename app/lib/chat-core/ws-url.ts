/**
 * @neutronai/app — pure native app-ws URL builder + IANA timezone detection
 * (ISSUES #40). Extracted from `use-mobile-chat.ts` so the timezone-capture path
 * is unit-testable WITHOUT pulling `react-native` / `expo-*` into the bun test
 * runtime (the hook module imports those at its top).
 */

/** http(s):// base → ws(s):// (mirrors `app/lib/config.ts` `httpToWs`, inlined
 *  here so this module stays free of the expo-constants-importing config). */
function httpToWs(base_url: string): string {
  if (base_url.startsWith('http://')) return 'ws://' + base_url.slice('http://'.length);
  if (base_url.startsWith('https://')) return 'wss://' + base_url.slice('https://'.length);
  return base_url;
}

/**
 * ISSUES #40 — detect the device's IANA timezone
 * (`Intl.DateTimeFormat().resolvedOptions().timeZone`; Hermes/RN exposes the same
 * API). Returns `null` on ANY gap — `Intl` throwing, or resolving an empty /
 * missing zone — so the connect path omits `tz` and the gateway keeps its
 * default. The `resolve` seam defaults to the real `Intl` call and is injectable
 * for deterministic tests (a throwing / empty resolver).
 */
export function detectClientTimezone(
  resolve: () => string | undefined = () =>
    new Intl.DateTimeFormat().resolvedOptions().timeZone,
): string | null {
  try {
    const tz = resolve();
    return typeof tz === 'string' && tz.length > 0 ? tz : null;
  } catch {
    return null;
  }
}

/** Build the native chat WS URL for this user + project. The `device_id` is
 *  carried so the gateway attributes this device's read receipts (Track B
 *  Phase 4); the same id is handed to the session for read-tick self-exclusion.
 *  The owner's IANA `tz` rides the same query string (ISSUES #40) so the gateway
 *  persists it for the daily nudge — omitted when detection yields `null`. */
export function buildWsUrl(
  baseUrl: string,
  token: string,
  projectId: string,
  deviceId: string,
  timeZone: string | null = detectClientTimezone(),
): string {
  const wsBase = httpToWs(baseUrl).replace(/\/+$/, '');
  const params = new URLSearchParams();
  params.set('token', token);
  if (projectId.length > 0) params.set('project_id', projectId);
  params.set('platform', 'native');
  params.set('device_id', deviceId);
  if (timeZone !== null && timeZone.length > 0) params.set('tz', timeZone);
  return `${wsBase}/ws/app/chat?${params.toString()}`;
}
