/**
 * @neutronai/app — usage-meter client + the hook that keeps it current.
 *
 * RN twin of `landing/chat-react/usage-client.ts`. Same endpoint, same decode,
 * same rule: anything other than a well-formed available payload resolves to
 * "unknown", never to zero. The app is routinely pointed at a server the owner
 * controls and may not have updated, so a 404 on this route is an expected
 * answer rather than an error worth surfacing.
 *
 * The hook refreshes on a timer AND on foreground. Foregrounding matters more
 * than the timer here: a phone that has been in a pocket for two hours has a
 * reading two hours stale, and the first thing the owner does after unlocking is
 * look at the screen.
 */

import { useEffect, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { GatewayHttpClient, type GatewayHttpClientOptions } from '@neutronai/client-core';

import { appStateBecameActive } from './app-state-refetch';

/** Mirrors `@neutronai/contracts/credential-usage.ts`. */
export type UsageUnavailableReason =
  | 'no_credential'
  | 'not_measured_yet'
  | 'unsupported_credential'
  | 'probe_failed';

export type UsagePayload =
  | {
      available: true;
      session: number;
      weekly: number;
      session_reset_at?: number;
      weekly_reset_at?: number;
      measured_at: number;
    }
  | { available: false; reason: UsageUnavailableReason };

/** What the meter shows when the server could not be asked or did not answer in
 *  a shape we recognise: the plain divider. */
export const USAGE_UNKNOWN: UsagePayload = { available: false, reason: 'probe_failed' };

/** Matched to the server's own measurement interval; polling faster only
 *  re-serves an unchanged value. */
export const USAGE_POLL_MS = 60_000;

export function decodeUsage(raw: unknown): UsagePayload {
  if (typeof raw !== 'object' || raw === null) return USAGE_UNKNOWN;
  const rec = raw as Record<string, unknown>;
  if (rec['available'] !== true) {
    const reason = rec['reason'];
    return typeof reason === 'string'
      ? { available: false, reason: reason as UsageUnavailableReason }
      : USAGE_UNKNOWN;
  }
  const session = rec['session'];
  const weekly = rec['weekly'];
  const measured_at = rec['measured_at'];
  if (typeof session !== 'number' || typeof weekly !== 'number' || typeof measured_at !== 'number') {
    return USAGE_UNKNOWN;
  }
  return { available: true, session, weekly, measured_at };
}

export class UsageClient extends GatewayHttpClient {
  constructor(opts: GatewayHttpClientOptions) {
    super(opts);
  }

  /** Never rejects — every failure is the same display state. */
  async fetchUsage(): Promise<UsagePayload> {
    try {
      const raw = await this.req<unknown>('/api/app/usage');
      return decodeUsage(raw);
    } catch {
      return USAGE_UNKNOWN;
    }
  }
}

export interface UseCredentialUsageOptions {
  /** The owner's own server, resolved at runtime — never a baked-in host. Empty
   *  while the app is unconfigured, which keeps the hook idle. */
  base_url: string;
  /** App-ws bearer. While it is absent the hook stays idle and reports unknown. */
  token: string | null;
  /** Injected in tests so a fake client can drive the hook with no network. */
  client?: Pick<UsageClient, 'fetchUsage'>;
}

/**
 * The live usage reading for the meter. Idle (and unknown) until there is both a
 * server and a token, so a device sitting on the connect screen never issues an
 * unauthenticated request.
 */
export function useCredentialUsage(opts: UseCredentialUsageOptions): UsagePayload {
  const { base_url, token, client } = opts;
  const [usage, setUsage] = useState<UsagePayload>(USAGE_UNKNOWN);

  useEffect(() => {
    if (token === null || token.length === 0 || base_url.length === 0) {
      setUsage(USAGE_UNKNOWN);
      return;
    }
    const source: Pick<UsageClient, 'fetchUsage'> =
      client ?? new UsageClient({ base_url, token });
    let cancelled = false;
    const pull = (): void => {
      void source.fetchUsage().then((next) => {
        if (!cancelled) setUsage(next);
      });
    };
    pull();
    const handle = setInterval(pull, USAGE_POLL_MS);
    let previous: AppStateStatus = AppState.currentState;
    const sub = AppState.addEventListener('change', (next) => {
      if (appStateBecameActive(previous, next)) pull();
      previous = next;
    });
    return () => {
      cancelled = true;
      clearInterval(handle);
      sub.remove();
    };
  }, [base_url, token, client]);

  return usage;
}
